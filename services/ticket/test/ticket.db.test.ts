import 'reflect-metadata';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Pool } from 'pg';
import { migrate } from '@gatepass/db';
import { bookingCode, buildEnvelope, decodeEnvelope } from '@gatepass/events';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import {
  QrKeyRing,
  checkIn,
  listTickets,
  onBookingConfirmed,
  onEventPublished,
  ticketsForBooking,
} from '../src';
import { TicketModule } from '../src/http/ticket.module';

jest.setTimeout(180_000);

const keys = new QrKeyRing('k1:' + 'a'.repeat(40));
let server: TestPostgres;
let db: TestDatabase;
let pool: Pool;
let app: INestApplication;
let seq = 0;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase(60);
  pool = db.pool;
  await migrate(pool, join(__dirname, '..', 'migrations'));
  const mod = await Test.createTestingModule({
    imports: [TicketModule.forDeps(pool, keys)],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
  await onEventPublished(
    pool,
    buildEnvelope({
      eventType: 'event.published',
      correlationId: 'neon-nights',
      producer: 'catalog',
      payload: {
        eventId: 'neon-nights',
        organizerId: 'o',
        title: 'Neon Nights Live',
        category: 'Music',
        venue: 'Open Air Arena',
        startsAtMs: BigInt(Date.parse('2026-12-06T14:00:00Z')),
        currency: 'INR',
        seats: ['A', 'B', 'C'].flatMap((row) =>
          Array.from({ length: 14 }, (_, i) => ({
            seatId: `${row}${i + 1}`,
            row,
            number: i + 1,
            tier: row === 'A' ? 'Front' : 'Mid',
            priceMinor: 100000n,
          })),
        ),
      },
    }),
  );
});
afterAll(async () => {
  await app?.close();
  await db.close();
  await server.stop();
});

const confirmed = (
  bookingId: string,
  seatIds: string[],
  userId = 'alice',
  eventId = 'neon-nights',
) =>
  buildEnvelope({
    eventType: 'booking.confirmed',
    correlationId: bookingId,
    producer: 'booking',
    payload: { bookingId, eventId, userId, seatIds, amountMinor: 360000n, currency: 'INR' },
  });

/** Confirms a booking and returns the QR tokens that were issued. */
async function issue(seatIds: string[], userId = 'alice') {
  const bookingId = `bk-${++seq}`;
  await onBookingConfirmed(pool, keys, confirmed(bookingId, seatIds, userId));
  const out = await pool.query(
    "SELECT payload FROM outbox WHERE aggregate_id = $1 AND event_type = 'ticket.issued'",
    [bookingId],
  );
  const ev = decodeEnvelope(out.rows[0].payload);
  if (ev.payload.case !== 'ticketIssued') throw new Error('wrong payload');
  return { bookingId, tickets: ev.payload.value.tickets, envelope: ev };
}

describe('issuing tickets', () => {
  it('issues one signed ticket per seat and publishes ticket.issued in the same transaction', async () => {
    const { bookingId, tickets, envelope } = await issue(['C6', 'C7']);
    expect(tickets.map((t) => t.seatId)).toEqual(['C6', 'C7']);
    expect(tickets.every((t) => keys.verify(t.qrToken).ticketId === t.ticketId)).toBe(true);
    expect(envelope.correlationId).toBe(bookingId);
    expect(envelope.producer).toBe('ticket');

    const mine = await listTickets(pool, keys, 'alice');
    const these = mine.filter((t) => t.bookingId === bookingId);
    expect(these).toHaveLength(2);
    expect(these[0]).toMatchObject({
      code: `${bookingCode(bookingId)}-C6`,
      eventTitle: 'Neon Nights Live',
      venue: 'Open Air Arena',
      row: 'C',
      seat: '6',
      tier: 'Mid',
      status: 'valid',
      startsAt: '2026-12-06T14:00:00.000Z',
    });
    expect(these[0]!.qrToken.startsWith('GP1.')).toBe(true);
    expect(await ticketsForBooking(pool, bookingId)).toEqual({ issued: true, count: 2 });
  });

  it('is idempotent: a duplicate booking.confirmed makes no extra tickets or events', async () => {
    const bookingId = `bk-${++seq}`;
    const ev = confirmed(bookingId, ['B1']);
    await onBookingConfirmed(pool, keys, ev);
    await onBookingConfirmed(pool, keys, ev); // same delivery twice
    await onBookingConfirmed(pool, keys, confirmed(bookingId, ['B1'])); // a re-sent confirmation, new event id
    expect((await ticketsForBooking(pool, bookingId)).count).toBe(1);
    const out = await pool.query(
      "SELECT 1 FROM outbox WHERE aggregate_id=$1 AND event_type='ticket.issued'",
      [bookingId],
    );
    expect(out.rowCount).toBe(2); // the re-sent one re-announces the SAME ticket, never a second ticket
    const ids = await pool.query('SELECT id FROM tickets WHERE booking_id=$1', [bookingId]);
    expect(ids.rowCount).toBe(1);
  });

  it('refuses to guess: an unknown seat or show throws so it is retried and dead-lettered', async () => {
    await expect(onBookingConfirmed(pool, keys, confirmed('bk-x1', ['Z99']))).rejects.toThrow(
      /unknown event or seat/,
    );
    await expect(
      onBookingConfirmed(pool, keys, confirmed('bk-x2', ['A1'], 'a', 'no-such-show')),
    ).rejects.toThrow();
    expect((await ticketsForBooking(pool, 'bk-x1')).issued).toBe(false);
  });

  it("lists only the caller's tickets", async () => {
    const { bookingId } = await issue(['A5'], 'carol');
    expect((await listTickets(pool, keys, 'carol')).map((t) => t.bookingId)).toEqual([bookingId]);
    expect(await listTickets(pool, keys, 'nobody')).toEqual([]);
  });
});

describe('check-in', () => {
  it('admits a valid ticket once, then reports it used with the time', async () => {
    const { tickets } = await issue(['A1']);
    const token = tickets[0]!.qrToken;
    expect(await checkIn(pool, keys, token, 'staff-1')).toEqual({
      status: 'valid',
      row: 'A',
      seat: '1',
      tier: 'Front',
    });
    const second = await checkIn(pool, keys, token, 'staff-2');
    expect(second.status).toBe('used');
    if (second.status !== 'used') throw new Error('unreachable');
    expect(Date.now() - Date.parse(second.usedAt)).toBeLessThan(10_000);
    const row = await pool.query('SELECT status, used_by FROM tickets WHERE id=$1', [
      tickets[0]!.ticketId,
    ]);
    expect(row.rows[0]).toEqual({ status: 'used', used_by: 'staff-1' }); // the FIRST scan won
    expect(
      (await listTickets(pool, keys, 'alice')).find((t) => t.id === tickets[0]!.ticketId)!.status,
    ).toBe('used');
  });

  it('TWO GATES AT ONCE: 50 simultaneous scans admit exactly one', async () => {
    const { tickets } = await issue(['B2']);
    const token = tickets[0]!.qrToken;
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => checkIn(pool, keys, token, `gate-${i}`)),
    );
    expect(results.filter((r) => r.status === 'valid')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'used')).toHaveLength(49);
    const row = await pool.query('SELECT used_by FROM tickets WHERE id=$1', [tickets[0]!.ticketId]);
    const winnerIndex = results.findIndex((r) => r.status === 'valid');
    expect(row.rows[0].used_by).toBe(`gate-${winnerIndex}`); // the recorded gate is the one that was admitted
  });

  it('scans of different tickets are independent', async () => {
    const { tickets } = await issue(['B3', 'B4', 'B5']);
    const results = await Promise.all(tickets.map((t) => checkIn(pool, keys, t.qrToken, 'gate')));
    expect(results.every((r) => r.status === 'valid')).toBe(true);
  });

  it('rejects forged, truncated, foreign and unknown tokens as invalid, and admits nobody', async () => {
    const { tickets } = await issue(['B6']);
    const real = tickets[0]!;
    const forged = new QrKeyRing('k1:' + 'z'.repeat(40)).sign(real.ticketId, 'neon-nights');
    const wrongEvent = keys.sign(real.ticketId, 'some-other-show');
    const unknown = keys.sign('no-such-ticket', 'neon-nights');
    for (const bad of [forged, wrongEvent, unknown, real.qrToken.slice(0, -4), 'garbage', '']) {
      expect(await checkIn(pool, keys, bad, 'gate')).toEqual({ status: 'invalid' });
    }
    expect(
      (await pool.query('SELECT status FROM tickets WHERE id=$1', [real.ticketId])).rows[0].status,
    ).toBe('valid');
    expect(await checkIn(pool, keys, real.qrToken, 'gate')).toMatchObject({ status: 'valid' });
  });
});

describe('HTTP', () => {
  it("GET /tickets needs a userId and returns that user's tickets with QR tokens", async () => {
    const { bookingId } = await issue(['C1'], 'dave');
    await request(app.getHttpServer()).get('/tickets').expect(400);
    const res = await request(app.getHttpServer())
      .get('/tickets')
      .query({ userId: 'dave' })
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      bookingId,
      status: 'valid',
      qrToken: expect.stringMatching(/^GP1\./),
    });
    const lights = await request(app.getHttpServer())
      .get(`/bookings/${bookingId}/tickets`)
      .expect(200);
    expect(lights.body).toEqual({ issued: true, count: 1 });
    expect(
      (await request(app.getHttpServer()).get('/bookings/none/tickets').expect(200)).body,
    ).toEqual({ issued: false, count: 0 });
  });

  it('POST /checkin answers 200 valid, 409 used, 404 invalid, 400 for a bad request', async () => {
    const { tickets } = await issue(['C2']);
    const token = tickets[0]!.qrToken;
    const ok = await request(app.getHttpServer())
      .post('/checkin')
      .send({ qrToken: token, staffId: 's1' })
      .expect(200);
    expect(ok.body).toEqual({ status: 'valid', row: 'C', seat: '2', tier: 'Mid' });
    const used = await request(app.getHttpServer())
      .post('/checkin')
      .send({ qrToken: token, staffId: 's2' })
      .expect(409);
    expect(used.body).toMatchObject({ status: 'used', usedAt: expect.any(String) });
    const bad = await request(app.getHttpServer())
      .post('/checkin')
      .send({ qrToken: 'nope', staffId: 's1' })
      .expect(404);
    expect(bad.body).toMatchObject({ status: 'invalid' });
    await request(app.getHttpServer()).post('/checkin').send({ staffId: 's1' }).expect(400);
  });
});
