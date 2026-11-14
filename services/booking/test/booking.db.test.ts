import 'reflect-metadata';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Pool } from 'pg';
import { migrate } from '@gatepass/db';
import { buildEnvelope, decodeEnvelope } from '@gatepass/events';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createBooking,
  getBooking,
  approveRefund,
  onPaymentSucceeded,
  onRefundCompleted,
  onRefundRequested,
  onSeatsHeld,
  onSeatsHoldFailed,
  onSeatsReleased,
  onSeatsSold,
} from '../src';
import { BookingModule } from '../src/http/booking.module';

jest.setTimeout(120_000);

let server: TestPostgres;
let db: TestDatabase;
let pool: Pool;
let app: INestApplication;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase();
  pool = db.pool;
  await migrate(pool, join(__dirname, '..', 'migrations'));
  const mod = await Test.createTestingModule({ imports: [BookingModule.forPool(pool)] }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app?.close();
  await db.close();
  await server.stop();
});

const newBooking = (seatIds = ['C6', 'C7']) =>
  createBooking(pool, { eventId: 'neon-nights', userId: 'u1', seatIds });

const held = (bookingId: string, expiresMs = 1_700_000_600_000n) =>
  buildEnvelope({
    eventType: 'seats.held',
    correlationId: bookingId,
    producer: 'seat-inventory',
    payload: {
      bookingId,
      eventId: 'neon-nights',
      seatIds: ['C6', 'C7'],
      holdExpiresAtMs: expiresMs,
    },
  });

const holdFailed = (bookingId: string) =>
  buildEnvelope({
    eventType: 'seats.hold_failed',
    correlationId: bookingId,
    producer: 'seat-inventory',
    payload: { bookingId, eventId: 'neon-nights', seatIds: ['C6'], reason: 'seat_unavailable' },
  });

const transitions = async (id: string) =>
  (
    await pool.query(
      'SELECT from_state, to_state FROM booking_transitions WHERE booking_id=$1 ORDER BY id',
      [id],
    )
  ).rows.map((r) => `${r.from_state ?? '-'}>${r.to_state}`);

const outboxOf = async (id: string, type: string) =>
  (
    await pool.query('SELECT payload FROM outbox WHERE aggregate_id=$1 AND event_type=$2', [
      id,
      type,
    ])
  ).rows.map((r) => decodeEnvelope(r.payload));

describe('createBooking', () => {
  it('stores the booking as REQUESTED and publishes booking.requested in one transaction', async () => {
    const b = await newBooking();
    expect(b).toMatchObject({
      state: 'REQUESTED',
      holdExpiresAt: null,
      seatIds: ['C6', 'C7'],
      userId: 'u1',
    });
    expect(await transitions(b.id)).toEqual(['->REQUESTED']);
    const [ev] = await outboxOf(b.id, 'booking.requested');
    expect(ev!.correlationId).toBe(b.id);
    if (ev!.payload.case !== 'bookingRequested') throw new Error('wrong payload');
    expect(ev!.payload.value).toMatchObject({
      bookingId: b.id,
      eventId: 'neon-nights',
      seatIds: ['C6', 'C7'],
    });
  });

  it('includes server time so the client never relies on its own clock', async () => {
    const fixed = new Date('2026-12-06T10:00:00Z');
    const b = await createBooking(
      pool,
      { eventId: 'e', userId: 'u', seatIds: ['A1'] },
      () => fixed,
    );
    expect(b.serverTime).toBe(fixed.toISOString());
  });

  it.each([
    ['no seats', []],
    ['more than six', ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']],
    ['duplicates', ['A1', 'A1']],
    ['blank id', ['A1', '']],
  ])('rejects %s and writes nothing', async (_name, seatIds) => {
    const before = (await pool.query('SELECT count(*) FROM bookings')).rows[0].count;
    await expect(
      createBooking(pool, { eventId: 'e', userId: 'u', seatIds }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await pool.query('SELECT count(*) FROM bookings')).rows[0].count).toBe(before);
  });

  it('allows exactly six seats', async () => {
    const b = await newBooking(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    expect(b.seatIds).toHaveLength(6);
  });

  it('getBooking throws NotFoundError for an unknown id', async () => {
    await expect(getBooking(pool, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('seats.held', () => {
  it('moves REQUESTED -> HELD and stores the server-computed expiry', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, held(b.id));
    const after = await getBooking(pool, b.id);
    expect(after.state).toBe('HELD');
    expect(after.holdExpiresAt).toBe(new Date(1_700_000_600_000).toISOString());
    expect(await transitions(b.id)).toEqual(['->REQUESTED', 'REQUESTED>HELD']);
  });

  it('is idempotent for a duplicate delivery', async () => {
    const b = await newBooking();
    const ev = held(b.id);
    await onSeatsHeld(pool, ev);
    await onSeatsHeld(pool, ev);
    expect((await transitions(b.id)).filter((t) => t === 'REQUESTED>HELD')).toHaveLength(1);
  });

  it('fails (so it is retried then dead-lettered) for a booking that does not exist', async () => {
    await expect(onSeatsHeld(pool, held('ghost'))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('seats.hold_failed', () => {
  it('cancels the booking and publishes booking.cancelled caused by the failure', async () => {
    const b = await newBooking();
    const failure = holdFailed(b.id);
    await onSeatsHoldFailed(pool, failure);

    const after = await getBooking(pool, b.id);
    expect(after).toMatchObject({ state: 'CANCELLED', cancelReason: 'hold_failed' });
    const [cancelled] = await outboxOf(b.id, 'booking.cancelled');
    expect(cancelled!.causationId).toBe(failure.eventId);
    expect(cancelled!.correlationId).toBe(b.id);
    if (cancelled!.payload.case !== 'bookingCancelled') throw new Error('wrong payload');
    expect(cancelled!.payload.value.reason).toBe('hold_failed');
  });

  it('publishes booking.cancelled once, even if delivered twice', async () => {
    const b = await newBooking();
    const failure = holdFailed(b.id);
    await onSeatsHoldFailed(pool, failure);
    await onSeatsHoldFailed(pool, failure);
    expect(await outboxOf(b.id, 'booking.cancelled')).toHaveLength(1);
  });

  it('a late hold_failed does not undo a HELD booking (out of order)', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, held(b.id));
    await onSeatsHoldFailed(pool, holdFailed(b.id));
    expect((await getBooking(pool, b.id)).state).toBe('HELD');
    expect(await outboxOf(b.id, 'booking.cancelled')).toHaveLength(0);
  });

  it('a late seats.held does not resurrect a CANCELLED booking', async () => {
    const b = await newBooking();
    await onSeatsHoldFailed(pool, holdFailed(b.id));
    await onSeatsHeld(pool, held(b.id));
    expect((await getBooking(pool, b.id)).state).toBe('CANCELLED');
  });
});

describe('HTTP', () => {
  it('POST /bookings creates, GET /bookings/:id reads with holdExpiresAt and serverTime', async () => {
    const created = await request(app.getHttpServer())
      .post('/bookings')
      .send({ eventId: 'neon-nights', userId: 'u9', seatIds: ['C6'] })
      .expect(201);
    expect(created.body).toMatchObject({ state: 'REQUESTED', userId: 'u9' });
    await onSeatsHeld(pool, held(created.body.id));

    const got = await request(app.getHttpServer()).get(`/bookings/${created.body.id}`).expect(200);
    expect(got.body.state).toBe('HELD');
    expect(got.body.holdExpiresAt).toBe(new Date(1_700_000_600_000).toISOString());
    expect(typeof got.body.serverTime).toBe('string');
  });

  it('POST /bookings answers 400 for invalid input and GET answers 404 for unknown ids', async () => {
    await request(app.getHttpServer())
      .post('/bookings')
      .send({ eventId: 'e', userId: 'u', seatIds: [] })
      .expect(400);
    await request(app.getHttpServer()).post('/bookings').send({}).expect(400);
    await request(app.getHttpServer()).get('/bookings/unknown').expect(404);
  });
});

const heldWithAmount = (bookingId: string) =>
  buildEnvelope({
    eventType: 'seats.held',
    correlationId: bookingId,
    producer: 'seat-inventory',
    payload: {
      bookingId,
      eventId: 'neon-nights',
      seatIds: ['C6', 'C7'],
      holdExpiresAtMs: 1_700_000_600_000n,
      amountMinor: 360000n,
      currency: 'INR',
    },
  });

const paid = (bookingId: string) =>
  buildEnvelope({
    eventType: 'payment.succeeded',
    correlationId: bookingId,
    producer: 'payment',
    payload: {
      bookingId,
      paymentId: 'pay-1',
      amountMinor: 360000n,
      currency: 'INR',
      providerRef: 'p',
    },
  });

const sold = (bookingId: string) =>
  buildEnvelope({
    eventType: 'seats.sold',
    correlationId: bookingId,
    producer: 'seat-inventory',
    payload: { bookingId, eventId: 'neon-nights', seatIds: ['C6', 'C7'] },
  });

const released = (bookingId: string, reason = 'payment_failed') =>
  buildEnvelope({
    eventType: 'seats.released',
    correlationId: bookingId,
    producer: 'seat-inventory',
    payload: { bookingId, eventId: 'neon-nights', seatIds: ['C6', 'C7'], reason },
  });

describe('payment path', () => {
  it('stores the amount from seats.held', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, heldWithAmount(b.id));
    expect(await getBooking(pool, b.id)).toMatchObject({ amountMinor: 360000, currency: 'INR' });
  });

  it('HELD -> PAID -> CONFIRMED, publishing booking.confirmed once with the amount', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, heldWithAmount(b.id));
    await onPaymentSucceeded(pool, paid(b.id));
    expect((await getBooking(pool, b.id)).state).toBe('PAID');

    const soldEvent = sold(b.id);
    await onSeatsSold(pool, soldEvent);
    await onSeatsSold(pool, soldEvent); // duplicate
    expect((await getBooking(pool, b.id)).state).toBe('CONFIRMED');
    expect(await transitions(b.id)).toEqual([
      '->REQUESTED',
      'REQUESTED>HELD',
      'HELD>PAID',
      'PAID>CONFIRMED',
    ]);
    const confirmed = await outboxOf(b.id, 'booking.confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.causationId).toBe(soldEvent.eventId);
    if (confirmed[0]!.payload.case !== 'bookingConfirmed') throw new Error('wrong payload');
    expect(confirmed[0]!.payload.value).toMatchObject({
      bookingId: b.id,
      userId: 'u1',
      seatIds: ['C6', 'C7'],
      amountMinor: 360000n,
      currency: 'INR',
    });
  });

  it('seats.sold overtaking payment.succeeded still confirms, and the late payment event is ignored', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, heldWithAmount(b.id));
    await onSeatsSold(pool, sold(b.id));
    await onPaymentSucceeded(pool, paid(b.id));
    expect((await getBooking(pool, b.id)).state).toBe('CONFIRMED');
    expect(await outboxOf(b.id, 'booking.confirmed')).toHaveLength(1);
  });

  it('seats.released cancels a HELD booking with the release reason and publishes booking.cancelled', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, heldWithAmount(b.id));
    const rel = released(b.id);
    await onSeatsReleased(pool, rel);
    await onSeatsReleased(pool, rel);
    expect(await getBooking(pool, b.id)).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'payment_failed',
    });
    const cancelled = await outboxOf(b.id, 'booking.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.causationId).toBe(rel.eventId);
    if (cancelled[0]!.payload.case !== 'bookingCancelled') throw new Error('wrong payload');
    expect(cancelled[0]!.payload.value.reason).toBe('payment_failed');
  });

  it('never cancels a booking that is already paid or confirmed', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, heldWithAmount(b.id));
    await onPaymentSucceeded(pool, paid(b.id));
    await onSeatsReleased(pool, released(b.id));
    expect((await getBooking(pool, b.id)).state).toBe('PAID');
    expect(await outboxOf(b.id, 'booking.cancelled')).toHaveLength(0);
  });

  it('an EXPIRED hold cancels even a booking that already saw payment.succeeded (the payment will be refunded)', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, heldWithAmount(b.id));
    await onPaymentSucceeded(pool, paid(b.id)); // payment.succeeded overtook the release
    expect((await getBooking(pool, b.id)).state).toBe('PAID');
    await onSeatsReleased(pool, released(b.id, 'hold_expired'));
    expect(await getBooking(pool, b.id)).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'hold_expired',
    });
    expect(await outboxOf(b.id, 'booking.cancelled')).toHaveLength(1);
    expect(await outboxOf(b.id, 'booking.confirmed')).toHaveLength(0);
  });

  it('but an expired-hold release never un-confirms a confirmed booking', async () => {
    const b = await newBooking();
    await onSeatsHeld(pool, heldWithAmount(b.id));
    await onPaymentSucceeded(pool, paid(b.id));
    await onSeatsSold(pool, sold(b.id));
    await onSeatsReleased(pool, released(b.id, 'hold_expired'));
    expect((await getBooking(pool, b.id)).state).toBe('CONFIRMED');
  });

  it('a payment for a booking that does not exist fails loudly', async () => {
    await expect(onPaymentSucceeded(pool, paid('ghost'))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('refund saga', () => {
  const requestedRefund = (
    bookingId: string,
    refundId: string,
    ticketId: string,
    organizerId = 'org-1',
  ) =>
    buildEnvelope({
      eventType: 'refund.requested',
      correlationId: bookingId,
      producer: 'ticket',
      payload: {
        refundId,
        bookingId,
        ticketId,
        userId: 'u1',
        amountMinor: 180000n,
        currency: 'INR',
        reason: '',
        eventId: 'neon-nights',
        seatId: 'C6',
        organizerId,
      },
    });
  const completedRefund = (bookingId: string, refundId: string, ticketId: string) =>
    buildEnvelope({
      eventType: 'refund.completed',
      correlationId: bookingId,
      producer: 'payment',
      payload: {
        refundId,
        bookingId,
        paymentId: 'p',
        amountMinor: 180000n,
        currency: 'INR',
        eventId: 'neon-nights',
        ticketId,
        seatId: 'C6',
        userId: 'u1',
        automatic: false,
      },
    });
  const stateOf = async (refundId: string) =>
    (await pool.query('SELECT state FROM refunds WHERE id=$1', [refundId])).rows[0]?.state;

  it('records a request as REQUESTED, once, even if delivered twice', async () => {
    const ev = requestedRefund('bk-r1', 'rf-1', 't-1');
    await onRefundRequested(pool, ev);
    await onRefundRequested(pool, ev);
    expect(await stateOf('rf-1')).toBe('REQUESTED');
    expect((await pool.query("SELECT count(*) FROM refunds WHERE id='rf-1'")).rows[0].count).toBe(
      '1',
    );
  });

  it("only the event's organizer can approve; unknown refunds are 404", async () => {
    await onRefundRequested(pool, requestedRefund('bk-r2', 'rf-2', 't-2', 'org-1'));
    await expect(approveRefund(pool, 'rf-2', 'org-2')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveRefund(pool, 'nope', 'org-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(await stateOf('rf-2')).toBe('REQUESTED');
    expect(await outboxOf('bk-r2', 'refund.approved')).toHaveLength(0);
  });

  it('approval moves REQUESTED -> APPROVED and publishes refund.approved with everything payment needs', async () => {
    await onRefundRequested(pool, requestedRefund('bk-r3', 'rf-3', 't-3'));
    expect(await approveRefund(pool, 'rf-3', 'org-1')).toEqual({
      refundId: 'rf-3',
      state: 'APPROVED',
    });
    expect(await stateOf('rf-3')).toBe('APPROVED');
    const [ev] = await outboxOf('bk-r3', 'refund.approved');
    expect(ev!.correlationId).toBe('bk-r3');
    if (ev!.payload.case !== 'refundApproved') throw new Error('wrong payload');
    expect(ev!.payload.value).toMatchObject({
      refundId: 'rf-3',
      ticketId: 't-3',
      eventId: 'neon-nights',
      seatId: 'C6',
      userId: 'u1',
      amountMinor: 180000n,
      currency: 'INR',
    });
  });

  it('approving twice, or 10 times at once, publishes refund.approved exactly once', async () => {
    await onRefundRequested(pool, requestedRefund('bk-r4', 'rf-4', 't-4'));
    await approveRefund(pool, 'rf-4', 'org-1');
    expect(await approveRefund(pool, 'rf-4', 'org-1')).toEqual({
      refundId: 'rf-4',
      state: 'APPROVED',
    });
    await onRefundRequested(pool, requestedRefund('bk-r5', 'rf-5', 't-5'));
    await Promise.all(Array.from({ length: 10 }, () => approveRefund(pool, 'rf-5', 'org-1')));
    expect(await outboxOf('bk-r4', 'refund.approved')).toHaveLength(1);
    expect(await outboxOf('bk-r5', 'refund.approved')).toHaveLength(1);
  });

  it('refund.completed finishes an approved refund; a completed refund can never go back', async () => {
    await onRefundRequested(pool, requestedRefund('bk-r6', 'rf-6', 't-6'));
    await approveRefund(pool, 'rf-6', 'org-1');
    const done = completedRefund('bk-r6', 'rf-6', 't-6');
    await onRefundCompleted(pool, done);
    await onRefundCompleted(pool, done);
    expect(await stateOf('rf-6')).toBe('COMPLETED');
    expect(await approveRefund(pool, 'rf-6', 'org-1')).toEqual({
      refundId: 'rf-6',
      state: 'COMPLETED',
    });
    expect(await outboxOf('bk-r6', 'refund.approved')).toHaveLength(1);
  });

  it('a completion that skipped approval, and an automatic refund, change nothing', async () => {
    await onRefundRequested(pool, requestedRefund('bk-r7', 'rf-7', 't-7'));
    await onRefundCompleted(pool, completedRefund('bk-r7', 'rf-7', 't-7'));
    expect(await stateOf('rf-7')).toBe('REQUESTED');
    await onRefundCompleted(pool, completedRefund('bk-r7', 'auto-p', '')); // automatic: no ticket
  });

  it('a ticket can be refunded only once (second request for the same ticket is ignored)', async () => {
    await onRefundRequested(pool, requestedRefund('bk-r8', 'rf-8a', 't-8'));
    await onRefundRequested(pool, requestedRefund('bk-r8', 'rf-8b', 't-8'));
    expect(await stateOf('rf-8a')).toBe('REQUESTED');
    expect(await stateOf('rf-8b')).toBeUndefined();
  });

  it('HTTP: POST /refunds/:id/approve answers 200, 400, 403, 404', async () => {
    await onRefundRequested(pool, requestedRefund('bk-r9', 'rf-9', 't-9', 'org-1'));
    await request(app.getHttpServer()).post('/refunds/rf-9/approve').send({}).expect(400);
    await request(app.getHttpServer())
      .post('/refunds/rf-9/approve')
      .send({ organizerId: 'org-2' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/refunds/nope/approve')
      .send({ organizerId: 'org-1' })
      .expect(404);
    const ok = await request(app.getHttpServer())
      .post('/refunds/rf-9/approve')
      .send({ organizerId: 'org-1' })
      .expect(200);
    expect(ok.body).toEqual({ refundId: 'rf-9', state: 'APPROVED' });
  });
});

describe('ARRIVAL ORDER DOES NOT MATTER (events from different topics, dead-letter replays)', () => {
  const heldAmount = (id: string) => heldWithAmount(id);
  const soldWithAmount = (id: string) =>
    buildEnvelope({
      eventType: 'seats.sold',
      correlationId: id,
      producer: 'seat-inventory',
      payload: {
        bookingId: id,
        eventId: 'neon-nights',
        seatIds: ['C6', 'C7'],
        amountMinor: 360000n,
        currency: 'INR',
      },
    });

  const endState = async (id: string) => (await getBooking(pool, id)).state;

  it('seats.sold before seats.held still ends CONFIRMED, and the late seats.held only fills in the hold', async () => {
    const b = await newBooking();
    await onSeatsSold(pool, soldWithAmount(b.id));
    expect(await endState(b.id)).toBe('CONFIRMED');
    await onSeatsHeld(pool, heldAmount(b.id)); // arrives last
    const after = await getBooking(pool, b.id);
    expect(after.state).toBe('CONFIRMED');
    expect(after.holdExpiresAt).toBe(new Date(1_700_000_600_000).toISOString());
    const confirmed = await outboxOf(b.id, 'booking.confirmed');
    expect(confirmed).toHaveLength(1);
    if (confirmed[0]!.payload.case !== 'bookingConfirmed') throw new Error('wrong payload');
    expect(confirmed[0]!.payload.value).toMatchObject({ amountMinor: 360000n, currency: 'INR' });
  });

  it('seats.released (hold expired) before seats.held still ends CANCELLED and is not resurrected', async () => {
    const b = await newBooking();
    await onSeatsReleased(pool, released(b.id, 'hold_expired'));
    expect(await endState(b.id)).toBe('CANCELLED');
    await onSeatsHeld(pool, heldAmount(b.id));
    expect(await endState(b.id)).toBe('CANCELLED');
    expect(await outboxOf(b.id, 'booking.cancelled')).toHaveLength(1);
  });

  it('payment.succeeded before seats.held records the payment, and seats.sold then confirms', async () => {
    const b = await newBooking();
    await onPaymentSucceeded(pool, paid(b.id));
    expect(await endState(b.id)).toBe('PAID');
    await onSeatsHeld(pool, heldAmount(b.id));
    expect(await endState(b.id)).toBe('PAID');
    await onSeatsSold(pool, soldWithAmount(b.id));
    expect(await endState(b.id)).toBe('CONFIRMED');
  });

  it('every ordering of {held, paid, sold} ends CONFIRMED, exactly one booking.confirmed', async () => {
    const orders = [
      ['held', 'paid', 'sold'],
      ['held', 'sold', 'paid'],
      ['paid', 'held', 'sold'],
      ['paid', 'sold', 'held'],
      ['sold', 'held', 'paid'],
      ['sold', 'paid', 'held'],
    ] as const;
    for (const order of orders) {
      const b = await newBooking();
      for (const step of order) {
        if (step === 'held') await onSeatsHeld(pool, heldAmount(b.id));
        if (step === 'paid') await onPaymentSucceeded(pool, paid(b.id));
        if (step === 'sold') await onSeatsSold(pool, soldWithAmount(b.id));
      }
      expect({ order, state: await endState(b.id) }).toEqual({ order, state: 'CONFIRMED' });
      expect(await outboxOf(b.id, 'booking.confirmed')).toHaveLength(1);
      expect(await outboxOf(b.id, 'booking.cancelled')).toHaveLength(0);
    }
  });

  it('every ordering of {held, paid, released(expired)} ends CANCELLED, never confirmed', async () => {
    const orders = [
      ['held', 'paid', 'rel'],
      ['held', 'rel', 'paid'],
      ['paid', 'held', 'rel'],
      ['paid', 'rel', 'held'],
      ['rel', 'held', 'paid'],
      ['rel', 'paid', 'held'],
    ] as const;
    for (const order of orders) {
      const b = await newBooking();
      for (const step of order) {
        if (step === 'held') await onSeatsHeld(pool, heldAmount(b.id));
        if (step === 'paid') await onPaymentSucceeded(pool, paid(b.id));
        if (step === 'rel') await onSeatsReleased(pool, released(b.id, 'hold_expired'));
      }
      expect({ order, state: await endState(b.id) }).toEqual({ order, state: 'CANCELLED' });
      expect(await outboxOf(b.id, 'booking.cancelled')).toHaveLength(1);
      expect(await outboxOf(b.id, 'booking.confirmed')).toHaveLength(0);
    }
  });

  it('a payment_failed release cancels a booking even if seats.held was not seen yet', async () => {
    const b = await newBooking();
    await onSeatsReleased(pool, released(b.id, 'payment_failed'));
    expect(await endState(b.id)).toBe('CANCELLED');
  });
});
