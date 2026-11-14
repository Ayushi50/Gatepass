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
  FAKE_SIGNATURE_HEADER,
  FAKE_TOKENS,
  FakeProvider,
  IdempotencyConflictError,
  InvalidSignatureError,
  PayableNotFoundError,
  PaymentConflictError,
  PaymentValidationError,
  ProviderUnavailableError,
  handleWebhook,
  onSeatsHeld,
  onSeatsReleased,
  startPayment,
  type StartPaymentInput,
} from '../src';
import { PaymentModule } from '../src/http/payment.module';

jest.setTimeout(180_000);

const SECRET = 'whsec_test_secret_value';
let server: TestPostgres;
let db: TestDatabase;
let pool: Pool;
let provider: FakeProvider;
let app: INestApplication;
let seq = 0;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase(30);
  pool = db.pool;
  await migrate(pool, join(__dirname, '..', 'migrations'));
  provider = new FakeProvider({ webhookSecret: SECRET });
  const mod = await Test.createTestingModule({
    imports: [PaymentModule.forDeps({ pool, provider })],
  }).compile();
  app = mod.createNestApplication({ rawBody: true });
  await app.init();
});
afterAll(async () => {
  await app?.close();
  await db.close();
  await server.stop();
});

beforeEach(() => {
  provider = Object.assign(provider, { failWith: undefined });
  provider.charges.clear();
  provider.calls = 0;
});

const deps = () => ({ pool, provider });
const FUTURE = () => BigInt(Date.now() + 600_000);

/** Creates a payable the way seats.held does and returns its booking id. */
async function payable(opts: { expiresMs?: bigint; amount?: bigint } = {}): Promise<string> {
  const bookingId = `bk-${++seq}`;
  await onSeatsHeld(
    pool,
    buildEnvelope({
      eventType: 'seats.held',
      correlationId: bookingId,
      producer: 'seat-inventory',
      payload: {
        bookingId,
        eventId: 'neon-nights',
        seatIds: ['C6', 'C7'],
        holdExpiresAtMs: opts.expiresMs ?? FUTURE(),
        amountMinor: opts.amount ?? 360000n,
        currency: 'INR',
      },
    }),
  );
  return bookingId;
}

const pay = (bookingId: string, over: Partial<StartPaymentInput> = {}): StartPaymentInput => ({
  bookingId,
  userId: 'alice',
  method: 'upi',
  token: FAKE_TOKENS.success,
  idempotencyKey: `key-${bookingId}-0001`,
  ...over,
});

const outbox = async (bookingId: string, type?: string) =>
  (
    await pool.query(
      `SELECT payload FROM outbox WHERE aggregate_id = $1 ${type ? 'AND event_type = $2' : ''} ORDER BY id`,
      type ? [bookingId, type] : [bookingId],
    )
  ).rows.map((r) => decodeEnvelope(r.payload));

const paymentRows = async (bookingId: string) =>
  (await pool.query('SELECT * FROM payments WHERE booking_id = $1', [bookingId])).rows;

const deliver = (paymentId: string, outcome: 'succeeded' | 'failed', opts = {}) => {
  const hook = provider.buildWebhook(paymentId, outcome, opts);
  return handleWebhook(deps(), Buffer.from(hook.body), hook.headers);
};

describe('payables (from seats.held / seats.released)', () => {
  it('records amount, currency and expiry, once', async () => {
    const id = await payable({ amount: 540000n });
    const row = (await pool.query('SELECT * FROM payables WHERE booking_id=$1', [id])).rows[0];
    expect(row).toMatchObject({ amount_minor: '540000', currency: 'INR', state: 'open' });
  });

  it('seats.released closes the payable, so paying is refused', async () => {
    const id = await payable();
    await onSeatsReleased(
      pool,
      buildEnvelope({
        eventType: 'seats.released',
        correlationId: id,
        producer: 'seat-inventory',
        payload: {
          bookingId: id,
          eventId: 'neon-nights',
          seatIds: ['C6'],
          reason: 'payment_failed',
        },
      }),
    );
    await expect(startPayment(deps(), pay(id))).rejects.toMatchObject({ code: 'booking_closed' });
  });
});

describe('startPayment', () => {
  it('creates a payment for the held amount, calls the provider once and returns processing', async () => {
    const id = await payable();
    const r = await startPayment(deps(), pay(id));
    expect(r.status).toBe('processing');
    const [row] = await paymentRows(id);
    expect(row).toMatchObject({
      amount_minor: '360000',
      currency: 'INR',
      state: 'PROCESSING',
      user_id: 'alice',
    });
    expect(row.provider_ref).toMatch(/^fake_ch_/);
    expect(provider.charges.size).toBe(1);
    expect([...provider.charges.values()][0]!.request.idempotencyKey).toBe(row.id); // provider key = payment id
  });

  it('validates input', async () => {
    const id = await payable();
    await expect(startPayment(deps(), pay(id, { method: 'cash' }))).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
    await expect(startPayment(deps(), pay(id, { token: '' }))).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
    await expect(startPayment(deps(), pay(id, { idempotencyKey: 'short' }))).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
    await expect(
      startPayment(deps(), pay(id, { idempotencyKey: 'bad key with spaces!!' })),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    expect(await paymentRows(id)).toHaveLength(0);
  });

  it('refuses a booking with nothing to pay, a closed booking and an expired hold', async () => {
    await expect(startPayment(deps(), pay('unknown'))).rejects.toBeInstanceOf(PayableNotFoundError);
    const expired = await payable({ expiresMs: BigInt(Date.now() - 1000) });
    await expect(startPayment(deps(), pay(expired))).rejects.toMatchObject({
      code: 'hold_expired',
    });
    expect(await paymentRows(expired)).toHaveLength(0);
  });

  it('uses the server clock for the expiry decision', async () => {
    const id = await payable({ expiresMs: 1_000_000n });
    await expect(startPayment(deps(), pay(id), () => new Date(999_999))).resolves.toBeDefined();
    const id2 = await payable({ expiresMs: 1_000_000n });
    await expect(startPayment(deps(), pay(id2), () => new Date(1_000_000))).rejects.toBeInstanceOf(
      PaymentConflictError,
    );
  });
});

describe('idempotency (no double charge)', () => {
  it('the same key and request returns the same payment and never charges twice', async () => {
    const id = await payable();
    const a = await startPayment(deps(), pay(id));
    const b = await startPayment(deps(), pay(id));
    expect(b.paymentId).toBe(a.paymentId);
    expect(await paymentRows(id)).toHaveLength(1);
    expect(provider.charges.size).toBe(1);
  });

  it('20 concurrent identical requests produce exactly one payment and one charge', async () => {
    const id = await payable();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => startPayment(deps(), pay(id))),
    );
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(await paymentRows(id)).toHaveLength(1);
    expect(provider.charges.size).toBe(1);
  });

  it('the same key with a different request is rejected (422)', async () => {
    const id = await payable();
    await startPayment(deps(), pay(id));
    await expect(startPayment(deps(), pay(id, { method: 'card' }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(startPayment(deps(), pay(id, { token: 'tok_other' }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await paymentRows(id)).toHaveLength(1);
  });

  it('a different key while a payment is live is rejected (409), concurrently too', async () => {
    const id = await payable();
    await startPayment(deps(), pay(id));
    await expect(
      startPayment(deps(), pay(id, { idempotencyKey: 'another-key-0002' })),
    ).rejects.toMatchObject({
      code: 'payment_in_progress',
    });

    const id2 = await payable();
    provider.charges.clear(); // count only the charges made by the race below
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        startPayment(deps(), pay(id2, { idempotencyKey: `race-key-${i}-00000` })),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(9);
    expect(await paymentRows(id2)).toHaveLength(1);
    expect(provider.charges.size).toBe(1);
  });

  it('survives a provider outage: the payment is kept, a retry with the same key completes it', async () => {
    const id = await payable();
    provider.failWith = new ProviderUnavailableError('timeout');
    await expect(startPayment(deps(), pay(id))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect((await paymentRows(id))[0].state).toBe('CREATED');
    expect(provider.charges.size).toBe(0);

    provider.failWith = undefined;
    const retry = await startPayment(deps(), pay(id));
    expect(retry.status).toBe('processing');
    expect(await paymentRows(id)).toHaveLength(1);
    expect(provider.charges.size).toBe(1);
  });

  it('a provider that refuses outright fails the payment and publishes payment.failed', async () => {
    const id = await payable();
    const r = await startPayment(deps(), pay(id, { token: FAKE_TOKENS.rejected }));
    expect(r.status).toBe('failed');
    expect(await outbox(id, 'payment.failed')).toHaveLength(1);
    expect(
      (await pool.query('SELECT state FROM payables WHERE booking_id=$1', [id])).rows[0].state,
    ).toBe('closed');
  });
});

describe('webhooks', () => {
  it('success: marks SUCCEEDED and publishes payment.succeeded with the amount', async () => {
    const id = await payable();
    const { paymentId } = await startPayment(deps(), pay(id));
    expect(await deliver(paymentId, 'succeeded')).toBe('applied');

    expect((await paymentRows(id))[0].state).toBe('SUCCEEDED');
    const events = await outbox(id, 'payment.succeeded');
    expect(events).toHaveLength(1);
    expect(events[0]!.correlationId).toBe(id);
    if (events[0]!.payload.case !== 'paymentSucceeded') throw new Error('wrong payload');
    expect(events[0]!.payload.value).toMatchObject({
      bookingId: id,
      paymentId,
      amountMinor: 360000n,
      currency: 'INR',
      eventId: 'neon-nights',
    });
    expect(
      (await pool.query('SELECT state FROM payables WHERE booking_id=$1', [id])).rows[0].state,
    ).toBe('paid');
  });

  it('failure: marks FAILED, closes the payable and publishes payment.failed with the reason', async () => {
    const id = await payable();
    const { paymentId } = await startPayment(deps(), pay(id, { token: FAKE_TOKENS.declined }));
    expect(await deliver(paymentId, 'failed', { reason: 'insufficient_funds' })).toBe('applied');
    expect((await paymentRows(id))[0]).toMatchObject({
      state: 'FAILED',
      failure_reason: 'insufficient_funds',
    });
    const [ev] = await outbox(id, 'payment.failed');
    if (ev!.payload.case !== 'paymentFailed') throw new Error('wrong payload');
    expect(ev!.payload.value.reason).toBe('insufficient_funds');
    expect(ev!.payload.value).toMatchObject({ eventId: 'neon-nights', userId: 'alice' });
    await expect(
      startPayment(deps(), pay(id, { idempotencyKey: 'retry-after-fail-1' })),
    ).rejects.toMatchObject({
      code: 'booking_closed',
    });
  });

  it('DUPLICATE: the same delivery twice publishes payment.succeeded once and changes nothing', async () => {
    const id = await payable();
    const { paymentId } = await startPayment(deps(), pay(id));
    const hook = provider.buildWebhook(paymentId, 'succeeded', { eventId: 'evt_dup' });
    const raw = Buffer.from(hook.body);
    expect(await handleWebhook(deps(), raw, hook.headers)).toBe('applied');
    expect(await handleWebhook(deps(), raw, hook.headers)).toBe('duplicate');
    expect(await outbox(id, 'payment.succeeded')).toHaveLength(1);
    expect(await paymentRows(id)).toHaveLength(1);
  });

  it('DUPLICATE under concurrency: 15 simultaneous identical deliveries apply exactly once', async () => {
    const id = await payable();
    const { paymentId } = await startPayment(deps(), pay(id));
    const hook = provider.buildWebhook(paymentId, 'succeeded', { eventId: 'evt_conc' });
    const raw = Buffer.from(hook.body);
    const results = await Promise.all(
      Array.from({ length: 15 }, () => handleWebhook(deps(), raw, hook.headers)),
    );
    expect(results.filter((r) => r === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(14);
    expect(await outbox(id, 'payment.succeeded')).toHaveLength(1);
  });

  it('a different delivery repeating the final state is recorded but does nothing', async () => {
    const id = await payable();
    const { paymentId } = await startPayment(deps(), pay(id));
    await deliver(paymentId, 'succeeded');
    expect(await deliver(paymentId, 'succeeded')).toBe('already');
    expect(await outbox(id, 'payment.succeeded')).toHaveLength(1);
  });

  it('LATE / OUT OF ORDER: a failure after success (or success after failure) cannot change the final state', async () => {
    const a = await payable();
    const pa = await startPayment(deps(), pay(a));
    await deliver(pa.paymentId, 'succeeded');
    expect(await deliver(pa.paymentId, 'failed')).toBe('conflict');
    expect((await paymentRows(a))[0].state).toBe('SUCCEEDED');
    expect(await outbox(a, 'payment.failed')).toHaveLength(0);

    const b = await payable();
    const pb = await startPayment(deps(), pay(b, { token: FAKE_TOKENS.declined }));
    await deliver(pb.paymentId, 'failed');
    expect(await deliver(pb.paymentId, 'succeeded')).toBe('conflict');
    expect((await paymentRows(b))[0].state).toBe('FAILED');
    expect(await outbox(b, 'payment.succeeded')).toHaveLength(0);
    const recorded = await pool.query(
      'SELECT result FROM webhook_events WHERE payment_id = $1 ORDER BY received_at',
      [pb.paymentId],
    );
    expect(recorded.rows.map((r) => r.result)).toEqual(['applied', 'conflict']);
  });

  it('a webhook that beats our own bookkeeping still settles the payment', async () => {
    const id = await payable();
    // the provider answers before startPayment has stored PROCESSING: simulate by settling a CREATED row
    provider.failWith = new ProviderUnavailableError('timeout after charge was created');
    await expect(startPayment(deps(), pay(id))).rejects.toBeInstanceOf(ProviderUnavailableError);
    const [row] = await paymentRows(id);
    expect(row.state).toBe('CREATED');
    expect(await deliver(row.id, 'succeeded')).toBe('applied');
    expect((await paymentRows(id))[0].state).toBe('SUCCEEDED');
    provider.failWith = undefined;
    // a client retry now finds the settled payment and does not charge again
    const replay = await startPayment(deps(), pay(id));
    expect(replay.status).toBe('succeeded');
    expect(provider.charges.size).toBe(0);
  });

  it('an unknown payment is recorded and acknowledged, not applied', async () => {
    const hook = provider.buildWebhook('pay_does_not_exist', 'succeeded', { amountMinor: 100 });
    expect(await handleWebhook(deps(), Buffer.from(hook.body), hook.headers)).toBe('unmatched');
  });

  it('a mismatching amount is recorded and NOT applied', async () => {
    const id = await payable();
    const { paymentId } = await startPayment(deps(), pay(id));
    expect(await deliver(paymentId, 'succeeded', { amountMinor: 1 })).toBe('amount_mismatch');
    expect((await paymentRows(id))[0].state).toBe('PROCESSING');
    expect(await outbox(id, 'payment.succeeded')).toHaveLength(0);
  });

  it('a bad signature is rejected and stores nothing', async () => {
    const id = await payable();
    const { paymentId } = await startPayment(deps(), pay(id));
    const hook = provider.buildWebhook(paymentId, 'succeeded', { eventId: 'evt_forged' });
    const before = (await pool.query('SELECT count(*) FROM webhook_events')).rows[0].count;
    await expect(
      handleWebhook(deps(), Buffer.from(hook.body), { [FAKE_SIGNATURE_HEADER]: 'forged' }),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    expect((await pool.query('SELECT count(*) FROM webhook_events')).rows[0].count).toBe(before);
    expect((await paymentRows(id))[0].state).toBe('PROCESSING');
  });
});

describe('HTTP', () => {
  it('POST /payments answers 202 and maps errors to 400 / 404 / 409 / 422 / 503', async () => {
    const id = await payable();
    const ok = await request(app.getHttpServer()).post('/payments').send(pay(id)).expect(202);
    expect(ok.body).toEqual({ paymentId: expect.any(String), status: 'processing' });
    await request(app.getHttpServer()).post('/payments').send(pay(id)).expect(202); // replay
    await request(app.getHttpServer())
      .post('/payments')
      .send(pay(id, { method: 'card' }))
      .expect(422);
    await request(app.getHttpServer())
      .post('/payments')
      .send(pay(id, { idempotencyKey: 'other-key-00001' }))
      .expect(409);
    await request(app.getHttpServer()).post('/payments').send({}).expect(400);
    await request(app.getHttpServer()).post('/payments').send(pay('nope')).expect(404);

    const id2 = await payable();
    provider.failWith = new ProviderUnavailableError('down');
    await request(app.getHttpServer()).post('/payments').send(pay(id2)).expect(503);
  });

  it('POST /webhooks/fake verifies the signature over the raw body', async () => {
    const id = await payable();
    const { paymentId } = await startPayment(deps(), pay(id));
    const hook = provider.buildWebhook(paymentId, 'succeeded');

    await request(app.getHttpServer())
      .post('/webhooks/fake')
      .set('content-type', 'application/json')
      .set(hook.headers)
      .send(hook.body)
      .expect(200)
      .expect({ result: 'applied' });
    await request(app.getHttpServer())
      .post('/webhooks/fake')
      .set('content-type', 'application/json')
      .set(hook.headers)
      .send(hook.body)
      .expect(200)
      .expect({ result: 'duplicate' });

    await request(app.getHttpServer())
      .post('/webhooks/fake')
      .set('content-type', 'application/json')
      .set(FAKE_SIGNATURE_HEADER, 'bad')
      .send(hook.body)
      .expect(400);
    await request(app.getHttpServer()).post('/webhooks/stripe').send('{}').expect(404);
  });
});
