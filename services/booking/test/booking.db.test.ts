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
  NotFoundError,
  ValidationError,
  createBooking,
  getBooking,
  onSeatsHeld,
  onSeatsHoldFailed,
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
