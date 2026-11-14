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
  TicketNotFoundError,
  onBookingConfirmed,
  onEventPublished,
  onRefundCompleted,
  requestRefund,
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

describe('refund request (locks the ticket, publishes refund.requested)', () => {
  const refundEvents = async (bookingId: string) =>
    (
      await pool.query(
        "SELECT payload FROM outbox WHERE aggregate_id=$1 AND event_type='refund.requested'",
        [bookingId],
      )
    ).rows.map((r) => decodeEnvelope(r.payload));
  const statusOf = async (id: string) =>
    (await pool.query('SELECT status FROM tickets WHERE id=$1', [id])).rows[0].status;

  it('locks a valid ticket and publishes refund.requested with the price, seat and organizer', async () => {
    const { bookingId, tickets } = await issue(['A1'], 'rita');
    const out = await requestRefund(pool, tickets[0]!.ticketId, 'rita');
    expect(out.status).toBe('refund_requested');
    expect(await statusOf(tickets[0]!.ticketId)).toBe('refund_requested');

    const [ev] = await refundEvents(bookingId);
    expect(ev!.correlationId).toBe(bookingId);
    if (ev!.payload.case !== 'refundRequested') throw new Error('wrong payload');
    expect(ev!.payload.value).toMatchObject({
      refundId: out.refundId,
      bookingId,
      ticketId: tickets[0]!.ticketId,
      userId: 'rita',
      amountMinor: 100000n,
      currency: 'INR',
      eventId: 'neon-nights',
      seatId: 'A1',
      organizerId: 'o',
    });
    expect(
      (await listTickets(pool, keys, 'rita')).find((t) => t.id === tickets[0]!.ticketId)!.status,
    ).toBe('refund_requested');
  });

  it('only the owner can ask (404 otherwise), and unknown tickets are 404', async () => {
    const { tickets } = await issue(['A2'], 'owner');
    await expect(requestRefund(pool, tickets[0]!.ticketId, 'thief')).rejects.toBeInstanceOf(
      TicketNotFoundError,
    );
    await expect(requestRefund(pool, 'nope', 'owner')).rejects.toBeInstanceOf(TicketNotFoundError);
    expect(await statusOf(tickets[0]!.ticketId)).toBe('valid');
  });

  it('a used ticket cannot be refunded; a second request is refused and publishes nothing more', async () => {
    const used = await issue(['A3'], 'u1');
    await checkIn(pool, keys, used.tickets[0]!.qrToken, 'gate');
    await expect(requestRefund(pool, used.tickets[0]!.ticketId, 'u1')).rejects.toMatchObject({
      code: 'used',
    });

    const dup = await issue(['A4'], 'u2');
    await requestRefund(pool, dup.tickets[0]!.ticketId, 'u2');
    await expect(requestRefund(pool, dup.tickets[0]!.ticketId, 'u2')).rejects.toMatchObject({
      code: 'refund_already_requested',
    });
    expect(await refundEvents(dup.bookingId)).toHaveLength(1);
  });

  it('concurrent requests for one ticket publish exactly one refund.requested', async () => {
    const { bookingId, tickets } = await issue(['A5'], 'u3');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => requestRefund(pool, tickets[0]!.ticketId, 'u3')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await refundEvents(bookingId)).toHaveLength(1);
  });

  it('REFUND vs DOOR: a request racing a scan has exactly one winner, 60 times over', async () => {
    let admitted = 0;
    let locked = 0;
    for (let i = 0; i < 60; i++) {
      const { tickets } = await issue(['B1'], 'racer');
      const [scan, refund] = await Promise.allSettled([
        checkIn(pool, keys, tickets[0]!.qrToken, 'gate'),
        requestRefund(pool, tickets[0]!.ticketId, 'racer'),
      ]);
      const scanned = scan.status === 'fulfilled' && scan.value.status === 'valid';
      const refunded = refund.status === 'fulfilled';
      expect(scanned !== refunded).toBe(true); // exactly one of the two succeeded
      expect(await statusOf(tickets[0]!.ticketId)).toBe(scanned ? 'used' : 'refund_requested');
      if (scanned) admitted++;
      else locked++;
    }
    console.log(
      `refund-vs-door outcomes over 60 runs: admitted=${admitted} refund-locked=${locked}`,
    );
    expect(admitted + locked).toBe(60);
  });

  it('a ticket with a refund pending cannot be scanned at the door', async () => {
    const { tickets } = await issue(['C3'], 'u4');
    await requestRefund(pool, tickets[0]!.ticketId, 'u4');
    expect(await checkIn(pool, keys, tickets[0]!.qrToken, 'gate')).toEqual({ status: 'invalid' });
  });
});

describe('refund.completed voids the ticket', () => {
  const completed = (bookingId: string, ticketId: string, seatId: string, automatic = false) =>
    buildEnvelope({
      eventType: 'refund.completed',
      correlationId: bookingId,
      producer: 'payment',
      payload: {
        refundId: `r-${ticketId}`,
        bookingId,
        paymentId: 'p',
        amountMinor: 100000n,
        currency: 'INR',
        eventId: 'neon-nights',
        ticketId: automatic ? '' : ticketId,
        seatId: automatic ? '' : seatId,
        userId: 'x',
        automatic,
      },
    });
  const voidedEvents = async (bookingId: string) =>
    (
      await pool.query(
        "SELECT payload FROM outbox WHERE aggregate_id=$1 AND event_type='ticket.voided'",
        [bookingId],
      )
    ).rows.map((r) => decodeEnvelope(r.payload));

  it('voids it permanently, announces ticket.voided once, and the QR is dead', async () => {
    const { bookingId, tickets } = await issue(['C4'], 'v1');
    await requestRefund(pool, tickets[0]!.ticketId, 'v1');
    const ev = completed(bookingId, tickets[0]!.ticketId, 'C4');
    await onRefundCompleted(pool, ev);
    await onRefundCompleted(pool, ev); // duplicate delivery

    expect(
      (await pool.query('SELECT status FROM tickets WHERE id=$1', [tickets[0]!.ticketId])).rows[0]
        .status,
    ).toBe('void');
    const voided = await voidedEvents(bookingId);
    expect(voided).toHaveLength(1);
    expect(voided[0]!.causationId).toBe(ev.eventId);
    if (voided[0]!.payload.case !== 'ticketVoided') throw new Error('wrong payload');
    expect(voided[0]!.payload.value).toMatchObject({
      ticketId: tickets[0]!.ticketId,
      seatId: 'C4',
      reason: 'refunded',
    });
    expect(await checkIn(pool, keys, tickets[0]!.qrToken, 'gate')).toEqual({ status: 'invalid' });
    await expect(requestRefund(pool, tickets[0]!.ticketId, 'v1')).rejects.toMatchObject({
      code: 'void',
    });
  });

  it('voids only the refunded ticket of a booking; the other stays valid', async () => {
    const { bookingId, tickets } = await issue(['C5', 'C6'], 'v2');
    await requestRefund(pool, tickets[0]!.ticketId, 'v2');
    await onRefundCompleted(pool, completed(bookingId, tickets[0]!.ticketId, 'C5'));
    expect(await checkIn(pool, keys, tickets[1]!.qrToken, 'gate')).toMatchObject({
      status: 'valid',
    });
  });

  it('an automatic refund (no ticket) or an unrequested ticket changes nothing', async () => {
    const { bookingId, tickets } = await issue(['C7'], 'v3');
    await onRefundCompleted(pool, completed(bookingId, '', '', true));
    await onRefundCompleted(pool, completed(bookingId, tickets[0]!.ticketId, 'C7')); // never requested
    expect(
      (await pool.query('SELECT status FROM tickets WHERE id=$1', [tickets[0]!.ticketId])).rows[0]
        .status,
    ).toBe('valid');
    expect(await voidedEvents(bookingId)).toHaveLength(0);
  });
});

describe('HTTP refund', () => {
  it('POST /tickets/:id/refund answers 202, 404 for a stranger, 409 for a repeat, 400 without a user', async () => {
    const { tickets } = await issue(['C8'], 'h1');
    const id = tickets[0]!.ticketId;
    await request(app.getHttpServer()).post(`/tickets/${id}/refund`).send({}).expect(400);
    await request(app.getHttpServer())
      .post(`/tickets/${id}/refund`)
      .send({ userId: 'stranger' })
      .expect(404);
    const ok = await request(app.getHttpServer())
      .post(`/tickets/${id}/refund`)
      .send({ userId: 'h1' })
      .expect(202);
    expect(ok.body).toEqual({ refundId: expect.any(String), status: 'refund_requested' });
    const again = await request(app.getHttpServer())
      .post(`/tickets/${id}/refund`)
      .send({ userId: 'h1' })
      .expect(409);
    expect(again.body).toMatchObject({ code: 'refund_already_requested' });
  });
});
