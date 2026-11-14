import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate } from '@gatepass/db';
import { buildEnvelope, decodeEnvelope, type EventEnvelope } from '@gatepass/events';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import {
  getSeats,
  onBookingRequested,
  onEventPublished,
  onPaymentSucceeded,
  onRefundCompleted,
  sweepExpiredHolds,
} from '../src';

jest.setTimeout(300_000);

let server: TestPostgres;
let db: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase(40);
  pool = db.pool;
  await migrate(pool, join(__dirname, '..', 'migrations'));
});
beforeEach(async () => {
  await pool.query('TRUNCATE outbox, inbox RESTART IDENTITY');
  await pool.query('TRUNCATE seats');
});
afterAll(async () => {
  await db.close();
  await server.stop();
});

const T0 = 1_800_000_000_000;
const TTL = 600_000;
const GRACE = 60_000;

async function publishEvent(eventId: string, rows: number, perRow: number): Promise<string[]> {
  const seats = [];
  for (let r = 0; r < rows; r++) {
    const row = String.fromCharCode(65 + r);
    for (let n = 1; n <= perRow; n++) {
      seats.push({ seatId: `${row}${n}`, row, number: n, tier: 'Mid', priceMinor: 100000n });
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
        category: 'M',
        venue: 'V',
        currency: 'INR',
        seats,
      },
    }),
  );
  return seats.map((s) => s.seatId);
}

/** A held booking whose hold expires at T0 + TTL. */
async function hold(eventId: string, bookingId: string, seatIds: string[]) {
  await onBookingRequested(
    pool,
    buildEnvelope({
      eventType: 'booking.requested',
      correlationId: bookingId,
      producer: 'booking',
      payload: { bookingId, eventId, userId: 'u', seatIds },
    }),
    { holdTtlMs: TTL, now: () => T0 },
  );
}

const paymentSucceeded = (bookingId: string, eventId: string) =>
  buildEnvelope({
    eventType: 'payment.succeeded',
    correlationId: bookingId,
    producer: 'payment',
    payload: {
      bookingId,
      paymentId: `pay-${bookingId}`,
      amountMinor: 100000n,
      currency: 'INR',
      providerRef: 'r',
      eventId,
    },
  });

const events = async (bookingId: string): Promise<EventEnvelope[]> =>
  (
    await pool.query('SELECT payload FROM outbox WHERE correlation_id = $1 ORDER BY id', [
      bookingId,
    ])
  ).rows.map((r) => decodeEnvelope(r.payload));
const typesOf = async (bookingId: string) => (await events(bookingId)).map((e) => e.eventType);
const stateOf = async (eventId: string, seatId: string) =>
  (await getSeats(pool, eventId)).find((s) => s.id === seatId)!.state;

const sweepAt = (offsetMs: number) =>
  sweepExpiredHolds(pool, { now: () => T0 + TTL + offsetMs, graceMs: GRACE });

describe('hold expiry sweeper', () => {
  it('releases an expired hold, announcing hold.expired then seats.released, in one step', async () => {
    await publishEvent('ev-x1', 1, 4);
    await hold('ev-x1', 'bk-1', ['A1', 'A2']);
    expect(await sweepAt(GRACE + 1)).toBe(1);

    expect(await stateOf('ev-x1', 'A1')).toBe('available');
    const row = await pool.query(
      "SELECT booking_id, hold_expires_at FROM seats WHERE event_id='ev-x1' AND seat_id='A1'",
    );
    expect(row.rows[0]).toEqual({ booking_id: null, hold_expires_at: null });

    const [held, expired, released] = await events('bk-1');
    expect(held!.eventType).toBe('seats.held');
    expect(expired!.eventType).toBe('hold.expired');
    expect(released!.eventType).toBe('seats.released');
    expect(released!.causationId).toBe(expired!.eventId);
    if (released!.payload.case !== 'seatsReleased') throw new Error('wrong payload');
    expect(released!.payload.value).toMatchObject({
      bookingId: 'bk-1',
      seatIds: ['A1', 'A2'],
      reason: 'hold_expired',
    });
  });

  it('does nothing before the hold plus grace has passed, and never touches live holds or sold seats', async () => {
    await publishEvent('ev-x2', 1, 4);
    await hold('ev-x2', 'bk-live', ['A1']);
    await hold('ev-x2', 'bk-sold', ['A2']);
    await onPaymentSucceeded(pool, paymentSucceeded('bk-sold', 'ev-x2'));

    expect(await sweepAt(-1)).toBe(0); // before expiry
    expect(await sweepAt(0)).toBe(0); // expired for the buyer, but inside the grace window
    expect(await sweepAt(GRACE - 1)).toBe(0); // one millisecond short of the grace window
    expect(await stateOf('ev-x2', 'A1')).toBe('held');
    expect(await sweepAt(GRACE)).toBe(1); // released once the grace has fully elapsed
    expect(await stateOf('ev-x2', 'A1')).toBe('available');
    expect(await stateOf('ev-x2', 'A2')).toBe('taken'); // sold seats are never swept
    expect(await typesOf('bk-sold')).not.toContain('hold.expired');
  });

  it('is idempotent: a second sweep finds nothing and publishes nothing', async () => {
    await publishEvent('ev-x3', 1, 2);
    await hold('ev-x3', 'bk-1', ['A1']);
    expect(await sweepAt(GRACE + 1)).toBe(1);
    expect(await sweepAt(GRACE + 1)).toBe(0);
    expect((await typesOf('bk-1')).filter((t) => t === 'hold.expired')).toHaveLength(1);
  });

  it('several sweepers at once release a booking exactly once', async () => {
    await publishEvent('ev-x4', 1, 6);
    await hold('ev-x4', 'bk-1', ['A1', 'A2', 'A3']);
    const counts = await Promise.all(Array.from({ length: 8 }, () => sweepAt(GRACE + 1)));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await typesOf('bk-1')).filter((t) => t === 'hold.expired')).toHaveLength(1);
    expect((await typesOf('bk-1')).filter((t) => t === 'seats.released')).toHaveLength(1);
  });

  it('released seats can be held by someone else', async () => {
    await publishEvent('ev-x5', 1, 2);
    await hold('ev-x5', 'bk-1', ['A1']);
    await sweepAt(GRACE + 1);
    await hold('ev-x5', 'bk-2', ['A1']);
    expect(await stateOf('ev-x5', 'A1')).toBe('held');
    expect(await typesOf('bk-2')).toContain('seats.held');
  });

  it('respects the per-sweep limit and finishes the rest next time', async () => {
    await publishEvent('ev-x6', 1, 6);
    for (const [i, s] of ['A1', 'A2', 'A3'].entries()) await hold('ev-x6', `bk-lim-${i}`, [s]);
    const first = await sweepExpiredHolds(pool, {
      now: () => T0 + TTL + GRACE + 1,
      graceMs: GRACE,
      limit: 2,
    });
    expect(first).toBe(2);
    expect(await sweepAt(GRACE + 1)).toBe(1);
  });
});

describe('EXPIRY VS PAYMENT RACE', () => {
  it('payment first: the sale stands, and a later sweep finds nothing to release', async () => {
    await publishEvent('ev-r1', 1, 3);
    await hold('ev-r1', 'bk-1', ['A1']);
    await onPaymentSucceeded(pool, paymentSucceeded('bk-1', 'ev-r1'));
    expect(await sweepAt(GRACE + 1)).toBe(0);
    expect(await stateOf('ev-r1', 'A1')).toBe('taken');
    const types = await typesOf('bk-1');
    expect(types).toContain('seats.sold');
    expect(types).not.toContain('hold.expired');
    expect(types).not.toContain('seats.sale_failed');
  });

  it('sweep first: the payment finds no hold, reports seats.sale_failed, and sells nothing', async () => {
    await publishEvent('ev-r2', 1, 3);
    await hold('ev-r2', 'bk-1', ['A1']);
    await sweepAt(GRACE + 1);
    const pay = paymentSucceeded('bk-1', 'ev-r2');
    await onPaymentSucceeded(pool, pay);

    expect(await stateOf('ev-r2', 'A1')).toBe('available');
    const types = await typesOf('bk-1');
    expect(types).not.toContain('seats.sold');
    const [failed] = (await events('bk-1')).filter((e) => e.eventType === 'seats.sale_failed');
    expect(failed!.causationId).toBe(pay.eventId);
    if (failed!.payload.case !== 'seatsSaleFailed') throw new Error('wrong payload');
    expect(failed!.payload.value).toMatchObject({
      bookingId: 'bk-1',
      eventId: 'ev-r2',
      reason: 'hold_released',
    });
  });

  it('a duplicate payment.succeeded after a failed sale does not report twice', async () => {
    await publishEvent('ev-r3', 1, 3);
    await hold('ev-r3', 'bk-1', ['A1']);
    await sweepAt(GRACE + 1);
    const pay = paymentSucceeded('bk-1', 'ev-r3');
    await onPaymentSucceeded(pool, pay);
    await onPaymentSucceeded(pool, pay);
    expect((await typesOf('bk-1')).filter((t) => t === 'seats.sale_failed')).toHaveLength(1);
  });

  it('150 randomised interleavings: every booking ends sold XOR (released and told to refund), never both, never neither', async () => {
    const seatIds = await publishEvent('ev-race', 15, 10);
    const outcomes = { sold: 0, refunded: 0 };
    for (let i = 0; i < 150; i++) {
      const bookingId = `race-${i}`;
      const seat = seatIds[i]!;
      await hold('ev-race', bookingId, [seat]);
      const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6)));
      await Promise.all([
        jitter().then(() => onPaymentSucceeded(pool, paymentSucceeded(bookingId, 'ev-race'))),
        jitter().then(() => sweepAt(GRACE + 1)),
      ]);
      // let any sweep that lost the race to another iteration's sweep finish
      await sweepAt(GRACE + 1);

      const types = await typesOf(bookingId);
      const sold = types.includes('seats.sold');
      const released = types.includes('seats.released');
      const sale_failed = types.includes('seats.sale_failed');
      const seatState = await stateOf('ev-race', seat);

      if (sold) {
        outcomes.sold++;
        expect([released, sale_failed, seatState]).toEqual([false, false, 'taken']);
        expect(types.filter((t) => t === 'seats.sold')).toHaveLength(1);
      } else {
        outcomes.refunded++;
        expect([released, sale_failed, seatState]).toEqual([true, true, 'available']);
        expect(types.filter((t) => t === 'seats.sale_failed')).toHaveLength(1);
        expect(types.filter((t) => t === 'seats.released')).toHaveLength(1);
      }
    }
    expect(outcomes.sold + outcomes.refunded).toBe(150);
    // surfaced for the test log: shows the race was really exercised both ways
    console.log(`race outcomes over 150 runs: ${JSON.stringify(outcomes)}`);
  });
});

describe('refund.completed returns the seat to sale', () => {
  const refunded = (bookingId: string, eventId: string, seatId: string, automatic = false) =>
    buildEnvelope({
      eventType: 'refund.completed',
      correlationId: bookingId,
      producer: 'payment',
      payload: {
        refundId: `r-${bookingId}-${seatId}`,
        bookingId,
        paymentId: 'p',
        amountMinor: 100000n,
        currency: 'INR',
        eventId,
        ticketId: automatic ? '' : 't',
        seatId: automatic ? '' : seatId,
        userId: 'u',
        automatic,
      },
    });

  it('moves the one refunded seat from sold to available and announces it, once', async () => {
    await publishEvent('ev-f1', 1, 4);
    await hold('ev-f1', 'bk-1', ['A1', 'A2']);
    await onPaymentSucceeded(pool, paymentSucceeded('bk-1', 'ev-f1'));
    const ev = refunded('bk-1', 'ev-f1', 'A1');
    await onRefundCompleted(pool, ev);
    await onRefundCompleted(pool, ev); // duplicate
    expect(await stateOf('ev-f1', 'A1')).toBe('available');
    expect(await stateOf('ev-f1', 'A2')).toBe('taken'); // the other ticket is untouched
    const released = (await events('bk-1')).filter((e) => e.eventType === 'seats.released');
    expect(released).toHaveLength(1);
    if (released[0]!.payload.case !== 'seatsReleased') throw new Error('wrong payload');
    expect(released[0]!.payload.value).toMatchObject({ seatIds: ['A1'], reason: 'refunded' });
    await hold('ev-f1', 'bk-2', ['A1']); // and it can be bought again
    expect(await stateOf('ev-f1', 'A1')).toBe('held');
  });

  it('an automatic refund changes no seat', async () => {
    await publishEvent('ev-f2', 1, 2);
    await hold('ev-f2', 'bk-1', ['A1']);
    await onRefundCompleted(pool, refunded('bk-1', 'ev-f2', 'A1', true));
    expect(await stateOf('ev-f2', 'A1')).toBe('held');
  });

  it('a refund naming a seat that is not sold to that booking changes nothing', async () => {
    await publishEvent('ev-f3', 1, 2);
    await hold('ev-f3', 'bk-1', ['A1']);
    await onRefundCompleted(pool, refunded('bk-other', 'ev-f3', 'A1'));
    expect(await stateOf('ev-f3', 'A1')).toBe('held');
  });
});
