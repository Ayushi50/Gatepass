import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate } from '@gatepass/db';
import { buildEnvelope, decodeEnvelope } from '@gatepass/events';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import { getAvailability, getSeats, holdSeats, onBookingRequested, onEventPublished } from '../src';

jest.setTimeout(300_000);

let server: TestPostgres;
let db: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase(50);
  pool = db.pool;
  await migrate(pool, join(__dirname, '..', 'migrations'));
});
afterAll(async () => {
  await db.close();
  await server.stop();
});

/** A square seat map: rows A.. with `perRow` seats; 100 seats = 10 rows x 10. */
const publishEvent = async (eventId: string, rows: number, perRow: number) => {
  const seats = [];
  for (let r = 0; r < rows; r++) {
    const row = String.fromCharCode(65 + r);
    for (let n = 1; n <= perRow; n++) {
      seats.push({ seatId: `${row}${n}`, row, number: n, tier: 'Mid', priceMinor: 180000n });
    }
  }
  await onEventPublished(
    pool,
    buildEnvelope({
      eventType: 'event.published',
      correlationId: eventId,
      producer: 'catalog',
      payload: {
        eventId,
        organizerId: 'o',
        title: 'T',
        category: 'Music',
        venue: 'V',
        currency: 'INR',
        seats,
      },
    }),
  );
  return seats.map((s) => s.seatId);
};

const requested = (bookingId: string, eventId: string, seatIds: string[]) =>
  buildEnvelope({
    eventType: 'booking.requested',
    correlationId: bookingId,
    producer: 'booking',
    payload: { bookingId, eventId, userId: 'u', seatIds },
  });

const outboxEvents = async (type: string, eventId: string) => {
  const { rows } = await pool.query(
    'SELECT payload FROM outbox WHERE event_type = $1 AND aggregate_id = $2 ORDER BY id',
    [type, eventId],
  );
  return rows.map((r) => decodeEnvelope(r.payload));
};

describe('event.published handler', () => {
  it('creates all seats as available, once, even if delivered twice', async () => {
    const ev = buildEnvelope({
      eventType: 'event.published',
      correlationId: 'ev-dup',
      producer: 'catalog',
      payload: {
        eventId: 'ev-dup',
        organizerId: 'o',
        title: 'T',
        category: 'Music',
        venue: 'V',
        currency: 'INR',
        seats: [
          { seatId: 'A1', row: 'A', number: 1, tier: 'Front', priceMinor: 240000n },
          { seatId: 'A2', row: 'A', number: 2, tier: 'Front', priceMinor: 240000n },
        ],
      },
    });
    await onEventPublished(pool, ev);
    await onEventPublished(pool, ev);
    expect(await getSeats(pool, 'ev-dup')).toEqual([
      { id: 'A1', row: 'A', number: 1, tier: 'Front', price: 2400, state: 'available' },
      { id: 'A2', row: 'A', number: 2, tier: 'Front', price: 2400, state: 'available' },
    ]);
    expect(await getAvailability(pool, ['ev-dup'])).toEqual([
      { eventId: 'ev-dup', total: 2, available: 2 },
    ]);
  });
});

describe('holdSeats (all or none)', () => {
  it('holds every requested seat', async () => {
    await publishEvent('ev-a', 2, 5);
    const exp = new Date(Date.now() + 600_000);
    const r = await holdSeats(
      pool,
      { bookingId: 'b1', eventId: 'ev-a', seatIds: ['A1', 'A2'] },
      exp,
    );
    expect(r).toEqual({ ok: true });
    const seats = await getSeats(pool, 'ev-a');
    expect(seats.filter((s) => s.state === 'held').map((s) => s.id)).toEqual(['A1', 'A2']);
    const row = await pool.query(
      "SELECT booking_id, hold_expires_at FROM seats WHERE seat_id='A1' AND event_id='ev-a'",
    );
    expect(row.rows[0].booking_id).toBe('b1');
    expect(row.rows[0].hold_expires_at.getTime()).toBe(exp.getTime());
  });

  it('holds nothing when one seat is already held', async () => {
    await publishEvent('ev-b', 1, 5);
    await holdSeats(pool, { bookingId: 'b1', eventId: 'ev-b', seatIds: ['A3'] }, new Date());
    const r = await holdSeats(
      pool,
      { bookingId: 'b2', eventId: 'ev-b', seatIds: ['A2', 'A3', 'A4'] },
      new Date(),
    );
    expect(r).toEqual({ ok: false, reason: 'seat_unavailable', seatIds: ['A3'] });
    const seats = await getSeats(pool, 'ev-b');
    expect(seats.filter((s) => s.state === 'held').map((s) => s.id)).toEqual(['A3']);
  });

  it('reports unknown seats and invalid requests', async () => {
    await publishEvent('ev-c', 1, 3);
    expect(
      await holdSeats(pool, { bookingId: 'b', eventId: 'ev-c', seatIds: ['A1', 'Z9'] }, new Date()),
    ).toEqual({
      ok: false,
      reason: 'unknown_seat',
      seatIds: ['Z9'],
    });
    expect(
      await holdSeats(pool, { bookingId: 'b', eventId: 'ev-c', seatIds: ['A1', 'A1'] }, new Date()),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
    expect(
      await holdSeats(pool, { bookingId: 'b', eventId: 'ev-c', seatIds: [] }, new Date()),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
    expect((await getSeats(pool, 'ev-c')).every((s) => s.state === 'available')).toBe(true);
  });

  it('the database itself refuses a seat that is held without an owner', async () => {
    await publishEvent('ev-d', 1, 1);
    await expect(
      pool.query("UPDATE seats SET state='held' WHERE event_id='ev-d' AND seat_id='A1'"),
    ).rejects.toThrow(/seat_owner_matches_state/);
  });
});

describe('booking.requested handler', () => {
  it('emits seats.held with a server-computed expiry, correlated and caused by the request', async () => {
    await publishEvent('ev-e', 1, 4);
    const req = requested('bk-1', 'ev-e', ['A1', 'A2']);
    await onBookingRequested(pool, req, { holdTtlMs: 600_000, now: () => 1_000_000 });

    const [held] = await outboxEvents('seats.held', 'ev-e');
    expect(held!.correlationId).toBe('bk-1');
    expect(held!.causationId).toBe(req.eventId);
    if (held!.payload.case !== 'seatsHeld') throw new Error('wrong payload');
    expect(held!.payload.value.holdExpiresAtMs).toBe(1_600_000n);
    expect(held!.payload.value.seatIds).toEqual(['A1', 'A2']);
  });

  it('emits seats.hold_failed (and holds nothing) when a seat is taken', async () => {
    await publishEvent('ev-f', 1, 4);
    await onBookingRequested(pool, requested('bk-1', 'ev-f', ['A1']));
    await onBookingRequested(pool, requested('bk-2', 'ev-f', ['A1', 'A2']));

    const failed = await outboxEvents('seats.hold_failed', 'ev-f');
    expect(failed).toHaveLength(1);
    if (failed[0]!.payload.case !== 'seatsHoldFailed') throw new Error('wrong payload');
    expect(failed[0]!.payload.value).toMatchObject({
      bookingId: 'bk-2',
      seatIds: ['A1'],
      reason: 'seat_unavailable',
    });
    expect((await getSeats(pool, 'ev-f')).filter((s) => s.state === 'held')).toHaveLength(1);
  });

  it('handles a duplicate delivery once', async () => {
    await publishEvent('ev-g', 1, 2);
    const req = requested('bk-1', 'ev-g', ['A1']);
    await onBookingRequested(pool, req);
    await onBookingRequested(pool, req);
    expect(await outboxEvents('seats.held', 'ev-g')).toHaveLength(1);
    expect(await outboxEvents('seats.hold_failed', 'ev-g')).toHaveLength(0);
  });
});

describe('NO DOUBLE BOOKING under concurrency', () => {
  it('1,000 concurrent buyers, 100 seats: exactly 100 succeed', async () => {
    const eventId = 'ev-rush';
    const seatIds = await publishEvent(eventId, 10, 10);
    expect(seatIds).toHaveLength(100);

    // buyer i wants seat (i mod 100): 10 buyers contend for every seat
    const buyers = Array.from({ length: 1000 }, (_, i) => ({
      bookingId: `rush-${i}`,
      seat: seatIds[i % 100]!,
    }));
    await Promise.all(
      buyers.map((b) => onBookingRequested(pool, requested(b.bookingId, eventId, [b.seat]))),
    );

    const held = await outboxEvents('seats.held', eventId);
    const failed = await outboxEvents('seats.hold_failed', eventId);
    expect(held).toHaveLength(100);
    expect(failed).toHaveLength(900);

    // every seat is held, each by exactly one booking, and the winner matches the event
    const rows = await pool.query(
      "SELECT seat_id, booking_id FROM seats WHERE event_id = $1 AND state = 'held'",
      [eventId],
    );
    expect(rows.rowCount).toBe(100);
    expect(new Set(rows.rows.map((r) => r.seat_id)).size).toBe(100);
    expect(new Set(rows.rows.map((r) => r.booking_id)).size).toBe(100);
    const winners = new Map(
      held.map((e) => {
        if (e.payload.case !== 'seatsHeld') throw new Error('wrong payload');
        return [e.payload.value.seatIds[0]!, e.payload.value.bookingId] as const;
      }),
    );
    for (const r of rows.rows) expect(winners.get(r.seat_id)).toBe(r.booking_id);
    expect(await getAvailability(pool, [eventId])).toEqual([{ eventId, total: 100, available: 0 }]);
  });

  it('overlapping multi-seat requests never double-hold or half-hold', async () => {
    const eventId = 'ev-pairs';
    const seatIds = await publishEvent(eventId, 10, 10);

    // 400 buyers each want 2 neighbouring seats; pairs overlap heavily (seeded, repeatable)
    let seed = 42;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const buyers = Array.from({ length: 400 }, (_, i) => {
      const k = rand(99);
      return { bookingId: `pair-${i}`, seats: [seatIds[k]!, seatIds[k + 1]!] };
    });
    await Promise.all(
      buyers.map((b) => onBookingRequested(pool, requested(b.bookingId, eventId, b.seats))),
    );

    const held = await outboxEvents('seats.held', eventId);
    const failed = await outboxEvents('seats.hold_failed', eventId);
    expect(held.length + failed.length).toBe(400);
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThanOrEqual(50); // 100 seats / 2 per booking

    const rows = await pool.query(
      "SELECT seat_id, booking_id FROM seats WHERE event_id = $1 AND state = 'held'",
      [eventId],
    );
    // no seat has two owners (PK), and held seats == 2 per successful booking: nothing half-held
    expect(rows.rowCount).toBe(held.length * 2);
    const perBooking = new Map<string, number>();
    for (const r of rows.rows)
      perBooking.set(r.booking_id, (perBooking.get(r.booking_id) ?? 0) + 1);
    expect([...perBooking.values()].every((c) => c === 2)).toBe(true);
    expect(perBooking.size).toBe(held.length);
    // a failed buyer holds nothing
    for (const e of failed) {
      if (e.payload.case !== 'seatsHoldFailed') throw new Error('wrong payload');
      expect(perBooking.has(e.payload.value.bookingId)).toBe(false);
    }
  });
});
