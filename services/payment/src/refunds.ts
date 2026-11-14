import type { Pool } from 'pg';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, withTransaction, type Queryable } from '@gatepass/outbox';
import type { PaymentDeps } from './payments';
import type { RefundWebhook } from './providers/provider';

const PRODUCER = 'payment';

/** Not retryable by the caller until fixed: the message is retried, then dead-lettered, then replayed. */
export class RefundError extends Error {}

export interface RefundOrder {
  /** Our refund id; the provider-side idempotency key. */
  id: string;
  bookingId: string;
  eventId: string;
  ticketId: string;
  seatId: string;
  userId: string;
  amountMinor: number;
  currency: string;
  automatic: boolean;
  /** The event that caused this refund, for the causation chain. */
  causationId: string;
}

interface PaymentRow {
  id: string;
  amount_minor: string;
  currency: string;
  provider_ref: string | null;
  provider_payment_id: string | null;
}

interface RefundRow {
  id: string;
  payment_id: string;
  booking_id: string;
  event_id: string;
  ticket_id: string;
  seat_id: string;
  user_id: string;
  amount_minor: string;
  currency: string;
  automatic: boolean;
  state: 'PENDING' | 'COMPLETED';
}

export type RefundOutcome = 'completed' | 'pending' | 'already';

/** The booking's successful payment, locked so concurrent refunds cannot over-refund it. */
async function lockPayment(tx: Queryable, bookingId: string): Promise<PaymentRow> {
  const { rows } = await tx.query<PaymentRow>(
    `SELECT id, amount_minor, currency, provider_ref, provider_payment_id
       FROM payments WHERE booking_id = $1 AND state = 'SUCCEEDED' FOR UPDATE`,
    [bookingId],
  );
  if (!rows[0]) throw new RefundError(`booking ${bookingId} has no successful payment to refund`);
  return rows[0];
}

/** Marks a PENDING refund COMPLETED and publishes refund.completed, atomically. Returns true if it changed. */
async function completeRefund(
  tx: Queryable,
  refundId: string,
  providerRefundRef: string | undefined,
  causationId: string,
): Promise<boolean> {
  const done = await tx.query<RefundRow>(
    `UPDATE refunds
        SET state = 'COMPLETED', provider_refund_ref = COALESCE($2, provider_refund_ref), updated_at = now()
      WHERE id = $1 AND state = 'PENDING' RETURNING *`,
    [refundId, providerRefundRef ?? null],
  );
  const r = done.rows[0];
  if (!r) return false;
  await appendToOutbox(
    tx,
    buildEnvelope({
      eventType: 'refund.completed',
      correlationId: r.booking_id,
      causationId: causationId || undefined,
      producer: PRODUCER,
      payload: {
        refundId: r.id,
        bookingId: r.booking_id,
        paymentId: r.payment_id,
        amountMinor: BigInt(r.amount_minor),
        currency: r.currency,
        eventId: r.event_id,
        ticketId: r.ticket_id,
        seatId: r.seat_id,
        userId: r.user_id,
        automatic: r.automatic,
      },
    }),
    r.booking_id,
  );
  return true;
}

/**
 * Refunds (part of) a booking's payment. Safe to call again and from many places at once:
 *  - the refund row (keyed by refund id) is created once;
 *  - the provider is called with the refund id as its idempotency key;
 *  - `refund.completed` is published only by whoever flips PENDING -> COMPLETED;
 *  - the total refunded can never exceed what was paid (checked under a lock on the payment).
 * A pending provider refund (async mode) is completed later by its webhook.
 */
export async function startRefund(deps: PaymentDeps, order: RefundOrder): Promise<RefundOutcome> {
  if (order.amountMinor <= 0) throw new RefundError('refund amount must be positive');

  const payment = await withTransaction(deps.pool, async (tx) => {
    const p = await lockPayment(tx, order.bookingId);
    const existing = await tx.query<{ state: string }>('SELECT state FROM refunds WHERE id = $1', [
      order.id,
    ]);
    if (existing.rows[0]) return existing.rows[0].state === 'COMPLETED' ? null : p;

    const sum = await tx.query<{ total: string }>(
      'SELECT COALESCE(sum(amount_minor), 0) AS total FROM refunds WHERE payment_id = $1',
      [p.id],
    );
    if (Number(sum.rows[0]!.total) + order.amountMinor > Number(p.amount_minor)) {
      throw new RefundError(`refund ${order.id} would exceed the amount paid`);
    }
    await tx.query(
      `INSERT INTO refunds (id, payment_id, booking_id, event_id, ticket_id, seat_id, user_id,
                            amount_minor, currency, automatic, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING')`,
      [
        order.id,
        p.id,
        order.bookingId,
        order.eventId,
        order.ticketId,
        order.seatId,
        order.userId,
        order.amountMinor,
        order.currency || p.currency,
        order.automatic,
      ],
    );
    return p;
  });
  if (!payment) return 'already';

  // Outside any transaction: never hold a database lock while talking to the provider.
  const result = await deps.provider.refund({
    refundId: order.id,
    paymentId: payment.id,
    providerPaymentId: payment.provider_payment_id ?? payment.provider_ref ?? '',
    amountMinor: order.amountMinor,
    currency: order.currency || payment.currency,
  });
  if (result.status === 'pending') return 'pending';

  const changed = await withTransaction(deps.pool, (tx) =>
    completeRefund(tx, order.id, result.providerRefundRef, order.causationId),
  );
  return changed ? 'completed' : 'already';
}

/** refund.approved -> pay it back. */
export async function onRefundApproved(deps: PaymentDeps, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'refundApproved') return;
  const r = env.payload.value;
  await startRefund(deps, {
    id: r.refundId,
    bookingId: r.bookingId,
    eventId: r.eventId,
    ticketId: r.ticketId,
    seatId: r.seatId,
    userId: r.userId,
    amountMinor: Number(r.amountMinor),
    currency: r.currency,
    automatic: false,
    causationId: env.eventId,
  });
}

/** seats.sale_failed -> the buyer paid for seats we could not sell; give all of it back. */
export async function onSeatsSaleFailed(deps: PaymentDeps, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsSaleFailed') return;
  const f = env.payload.value;
  const { rows } = await deps.pool.query<{
    id: string;
    amount_minor: string;
    currency: string;
    user_id: string;
  }>(
    "SELECT id, amount_minor, currency, user_id FROM payments WHERE booking_id = $1 AND state = 'SUCCEEDED'",
    [f.bookingId],
  );
  const p = rows[0];
  if (!p)
    throw new RefundError(`seats.sale_failed for booking ${f.bookingId} but no successful payment`);
  await startRefund(deps, {
    id: `auto-${p.id}`,
    bookingId: f.bookingId,
    eventId: f.eventId,
    ticketId: '',
    seatId: '',
    userId: p.user_id,
    amountMinor: Number(p.amount_minor),
    currency: p.currency,
    automatic: true,
    causationId: env.eventId,
  });
}

/** A pending refund was processed by the provider. Recorded once, completed once. */
export async function handleRefundWebhook(
  deps: PaymentDeps,
  event: RefundWebhook,
): Promise<'applied' | 'duplicate' | 'already' | 'unmatched'> {
  return withTransaction(deps.pool, async (tx) => {
    const recorded = await tx.query(
      `INSERT INTO webhook_events (provider, provider_event_id, payment_id, outcome)
       VALUES ($1,$2,NULL,'refund_processed') ON CONFLICT DO NOTHING`,
      [deps.provider.name, event.providerEventId],
    );
    if (recorded.rowCount === 0) return 'duplicate';
    const finish = async (r: 'applied' | 'already' | 'unmatched') => {
      await tx.query(
        'UPDATE webhook_events SET result = $3 WHERE provider = $1 AND provider_event_id = $2',
        [deps.provider.name, event.providerEventId, r],
      );
      return r;
    };
    const found = await tx.query('SELECT 1 FROM refunds WHERE id = $1 FOR UPDATE', [
      event.refundId,
    ]);
    if (found.rowCount === 0) return finish('unmatched');
    return finish(
      (await completeRefund(tx, event.refundId, event.providerRefundRef, ''))
        ? 'applied'
        : 'already',
    );
  });
}

export type { Pool };
