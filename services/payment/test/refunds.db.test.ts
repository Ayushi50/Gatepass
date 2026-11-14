import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate } from '@gatepass/db';
import { buildEnvelope, decodeEnvelope, type EventEnvelope } from '@gatepass/events';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import {
  FAKE_TOKENS,
  FakeProvider,
  ProviderUnavailableError,
  RefundError,
  handleWebhook,
  onRefundApproved,
  onSeatsHeld,
  onSeatsSaleFailed,
  paymentHandler,
  startPayment,
  type PaymentDeps,
} from '../src';

jest.setTimeout(180_000);

let server: TestPostgres;
let db: TestDatabase;
let pool: Pool;
let provider: FakeProvider;
let seq = 0;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase(30);
  pool = db.pool;
  await migrate(pool, join(__dirname, '..', 'migrations'));
});
afterAll(async () => {
  await db.close();
  await server.stop();
});
beforeEach(() => {
  provider = new FakeProvider({ webhookSecret: 'whsec_refund_test_secret' });
});

const deps = (): PaymentDeps => ({ pool, provider });

/** A booking that has been paid for (2 seats, 2,000 + 1,500 rupees = 3,500). */
async function paidBooking(
  amountMinor = 350000n,
): Promise<{ bookingId: string; paymentId: string }> {
  const bookingId = `rf-bk-${++seq}`;
  await onSeatsHeld(
    pool,
    buildEnvelope({
      eventType: 'seats.held',
      correlationId: bookingId,
      producer: 'seat-inventory',
      payload: {
        bookingId,
        eventId: 'show',
        seatIds: ['A1', 'A2'],
        holdExpiresAtMs: BigInt(Date.now() + 600_000),
        amountMinor,
        currency: 'INR',
      },
    }),
  );
  const { paymentId } = await startPayment(deps(), {
    bookingId,
    userId: 'alice',
    method: 'upi',
    token: FAKE_TOKENS.success,
    idempotencyKey: `idem-${bookingId}-0001`,
  });
  const hook = provider.buildWebhook(paymentId, 'succeeded');
  await handleWebhook(deps(), Buffer.from(hook.body), hook.headers);
  return { bookingId, paymentId };
}

const approved = (bookingId: string, refundId: string, seatId: string, amountMinor: bigint) =>
  buildEnvelope({
    eventType: 'refund.approved',
    correlationId: bookingId,
    producer: 'booking',
    payload: {
      refundId,
      bookingId,
      ticketId: `t-${seatId}`,
      eventId: 'show',
      seatId,
      userId: 'alice',
      amountMinor,
      currency: 'INR',
    },
  });

const events = async (bookingId: string, type: string): Promise<EventEnvelope[]> =>
  (
    await pool.query(
      'SELECT payload FROM outbox WHERE aggregate_id=$1 AND event_type=$2 ORDER BY id',
      [bookingId, type],
    )
  ).rows.map((r) => decodeEnvelope(r.payload));
const refundRows = async (bookingId: string) =>
  (
    await pool.query(
      'SELECT id, state, amount_minor, automatic FROM refunds WHERE booking_id=$1 ORDER BY id',
      [bookingId],
    )
  ).rows;

describe('refund.approved -> refund.completed', () => {
  it('pays the ticket price back once and publishes refund.completed with everything consumers need', async () => {
    const { bookingId, paymentId } = await paidBooking();
    const ev = approved(bookingId, 'refund-1', 'A1', 200000n);
    await onRefundApproved(deps(), ev);

    expect(provider.refunds.size).toBe(1);
    expect(await refundRows(bookingId)).toEqual([
      { id: 'refund-1', state: 'COMPLETED', amount_minor: '200000', automatic: false },
    ]);
    const [done] = await events(bookingId, 'refund.completed');
    expect(done!.causationId).toBe(ev.eventId);
    expect(done!.correlationId).toBe(bookingId);
    if (done!.payload.case !== 'refundCompleted') throw new Error('wrong payload');
    expect(done!.payload.value).toMatchObject({
      refundId: 'refund-1',
      bookingId,
      paymentId,
      amountMinor: 200000n,
      currency: 'INR',
      eventId: 'show',
      ticketId: 't-A1',
      seatId: 'A1',
      userId: 'alice',
      automatic: false,
    });
  });

  it('DUPLICATE approvals (same event, re-sent event, 10 at once) refund exactly once', async () => {
    const { bookingId } = await paidBooking();
    const ev = approved(bookingId, 'refund-dup', 'A1', 100000n);
    await onRefundApproved(deps(), ev);
    await onRefundApproved(deps(), ev);
    await onRefundApproved(deps(), approved(bookingId, 'refund-dup', 'A1', 100000n)); // new event id, same refund
    await Promise.all(
      Array.from({ length: 10 }, () =>
        onRefundApproved(deps(), approved(bookingId, 'refund-dup', 'A1', 100000n)),
      ),
    );
    expect(provider.refunds.size).toBe(1); // ONE refund at the provider
    expect(await refundRows(bookingId)).toHaveLength(1);
    expect(await events(bookingId, 'refund.completed')).toHaveLength(1);
  });

  it('refunds two tickets of one booking separately, and never more than was paid', async () => {
    const { bookingId } = await paidBooking(350000n);
    await onRefundApproved(deps(), approved(bookingId, 'r-a1', 'A1', 200000n));
    await onRefundApproved(deps(), approved(bookingId, 'r-a2', 'A2', 150000n));
    expect(provider.refunds.size).toBe(2);
    await expect(
      onRefundApproved(deps(), approved(bookingId, 'r-extra', 'A3', 1n)),
    ).rejects.toBeInstanceOf(RefundError);
    expect(provider.refunds.size).toBe(2);
    expect(await refundRows(bookingId)).toHaveLength(2);
  });

  it('concurrent refunds cannot together exceed the payment', async () => {
    const { bookingId } = await paidBooking(300000n);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        onRefundApproved(deps(), approved(bookingId, `r-race-${i}`, `S${i}`, 100000n)),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3); // 3 x 1,000 = the 3,000 paid
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    const total = await pool.query(
      'SELECT sum(amount_minor) AS t FROM refunds WHERE booking_id=$1',
      [bookingId],
    );
    expect(Number(total.rows[0].t)).toBe(300000);
  });

  it('rejects refunding a booking that was never paid', async () => {
    await expect(
      onRefundApproved(deps(), approved('never-paid', 'r-x', 'A1', 100000n)),
    ).rejects.toBeInstanceOf(RefundError);
  });

  it('a provider outage leaves the refund pending; a retry completes it without a second refund', async () => {
    const { bookingId } = await paidBooking();
    provider.failWith = new ProviderUnavailableError('timeout');
    await expect(
      onRefundApproved(deps(), approved(bookingId, 'r-out', 'A1', 100000n)),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect((await refundRows(bookingId))[0]!.state).toBe('PENDING');
    expect(await events(bookingId, 'refund.completed')).toHaveLength(0);

    provider.failWith = undefined;
    await onRefundApproved(deps(), approved(bookingId, 'r-out', 'A1', 100000n));
    expect(provider.refunds.size).toBe(1);
    expect((await refundRows(bookingId))[0]!.state).toBe('COMPLETED');
    expect(await events(bookingId, 'refund.completed')).toHaveLength(1);
  });

  it('ASYNC provider: stays pending until the signed webhook; the webhook completes it once', async () => {
    provider.refundMode = 'async';
    const { bookingId } = await paidBooking();
    await onRefundApproved(deps(), approved(bookingId, 'r-async', 'A1', 100000n));
    expect((await refundRows(bookingId))[0]!.state).toBe('PENDING');
    expect(await events(bookingId, 'refund.completed')).toHaveLength(0);

    const hook = provider.buildRefundWebhook('r-async', { eventId: 'evt_rf_1' });
    const raw = Buffer.from(hook.body);
    expect(await handleWebhook(deps(), raw, hook.headers)).toBe('applied');
    expect(await handleWebhook(deps(), raw, hook.headers)).toBe('duplicate');
    const again = provider.buildRefundWebhook('r-async'); // provider re-sends under a new id
    expect(await handleWebhook(deps(), Buffer.from(again.body), again.headers)).toBe('already');
    expect(await events(bookingId, 'refund.completed')).toHaveLength(1);
    // a re-delivered approval while pending/complete does not refund again
    await onRefundApproved(deps(), approved(bookingId, 'r-async', 'A1', 100000n));
    expect(provider.refunds.size).toBe(1);
  });

  it('a refund webhook for an unknown refund is recorded and acknowledged; a forged one is rejected', async () => {
    const stray = provider.buildRefundWebhook('no-such-refund');
    expect(await handleWebhook(deps(), Buffer.from(stray.body), stray.headers)).toBe('unmatched');
    await expect(
      handleWebhook(deps(), Buffer.from(stray.body), { 'x-fake-signature': 'forged' }),
    ).rejects.toThrow();
  });
});

describe('automatic refund (seats.sale_failed)', () => {
  const saleFailed = (bookingId: string) =>
    buildEnvelope({
      eventType: 'seats.sale_failed',
      correlationId: bookingId,
      producer: 'seat-inventory',
      payload: { bookingId, eventId: 'show', seatIds: [], reason: 'hold_released' },
    });

  it('refunds the whole payment, marked automatic with no ticket, once', async () => {
    const { bookingId, paymentId } = await paidBooking(350000n);
    const ev = saleFailed(bookingId);
    await onSeatsSaleFailed(deps(), ev);
    await onSeatsSaleFailed(deps(), ev);
    await onSeatsSaleFailed(deps(), saleFailed(bookingId));

    expect(provider.refunds.size).toBe(1);
    expect(await refundRows(bookingId)).toEqual([
      { id: `auto-${paymentId}`, state: 'COMPLETED', amount_minor: '350000', automatic: true },
    ]);
    const done = await events(bookingId, 'refund.completed');
    expect(done).toHaveLength(1);
    if (done[0]!.payload.case !== 'refundCompleted') throw new Error('wrong payload');
    expect(done[0]!.payload.value).toMatchObject({
      automatic: true,
      ticketId: '',
      seatId: '',
      userId: 'alice',
      amountMinor: 350000n,
      eventId: 'show',
    });
  });

  it('with no successful payment it fails loudly instead of inventing a refund', async () => {
    await expect(onSeatsSaleFailed(deps(), saleFailed('no-payment'))).rejects.toBeInstanceOf(
      RefundError,
    );
  });

  it('is routed by the payment handler together with refund.approved', async () => {
    const { bookingId } = await paidBooking();
    const handle = paymentHandler(pool, provider);
    await handle(saleFailed(bookingId));
    expect(provider.refunds.size).toBe(1);
    const { bookingId: b2 } = await paidBooking();
    await handle(approved(b2, 'r-routed', 'A1', 100000n));
    expect(provider.refunds.size).toBe(2);
  });
});
