import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { buildEnvelope } from '@gatepass/events';
import { appendToOutbox, withTransaction, type Queryable } from '@gatepass/outbox';
import { metrics } from '@gatepass/telemetry';
import {
  PAYMENT_METHODS,
  ProviderRejectedError,
  ProviderUnavailableError,
  type PaymentMethod,
  type PaymentProvider,
} from './providers/provider';
import { handleRefundWebhook } from './refunds';
import type { PaymentState } from './state';

export const PRODUCER = 'payment';

export class PaymentValidationError extends Error {}
/** The same Idempotency-Key was reused with a different request. */
export class IdempotencyConflictError extends Error {}
export class PayableNotFoundError extends Error {}
export type ConflictCode = 'booking_closed' | 'hold_expired' | 'payment_in_progress';
export class PaymentConflictError extends Error {
  constructor(
    public readonly code: ConflictCode,
    message: string,
  ) {
    super(message);
  }
}
export { ProviderUnavailableError };

export interface PaymentDeps {
  pool: Pool;
  provider: PaymentProvider;
}

export interface StartPaymentInput {
  bookingId: string;
  userId: string;
  method: string;
  token: string;
  idempotencyKey: string;
}

export interface PaymentResult {
  paymentId: string;
  status: Lowercase<PaymentState>;
}

interface PaymentRow {
  id: string;
  booking_id: string;
  request_fingerprint: string;
  user_id: string;
  amount_minor: string;
  currency: string;
  method: PaymentMethod;
  state: PaymentState;
  provider_ref: string | null;
  created_at: Date;
}

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

const result = (id: string, state: PaymentState): PaymentResult => ({
  paymentId: id,
  status: state.toLowerCase() as Lowercase<PaymentState>,
});

function validate(input: StartPaymentInput): void {
  if (!input.bookingId) throw new PaymentValidationError('bookingId is required');
  if (!input.userId) throw new PaymentValidationError('userId is required');
  if (!PAYMENT_METHODS.includes(input.method as PaymentMethod)) {
    throw new PaymentValidationError(`method must be one of ${PAYMENT_METHODS.join(', ')}`);
  }
  if (typeof input.token !== 'string' || !input.token || input.token.length > 256) {
    throw new PaymentValidationError('token is required');
  }
  if (typeof input.idempotencyKey !== 'string' || !KEY_PATTERN.test(input.idempotencyKey)) {
    throw new PaymentValidationError(
      'Idempotency-Key must be 8-128 characters: letters, digits, _ . : -',
    );
  }
}

const fingerprint = (i: StartPaymentInput): string =>
  createHash('sha256')
    .update(JSON.stringify([i.bookingId, i.userId, i.method, i.token]))
    .digest('hex');

/**
 * Starts (or replays) a payment.
 *
 *  - Same Idempotency-Key + same request  -> the original payment, no second charge.
 *  - Same key, different request          -> IdempotencyConflictError (422).
 *  - New key while a payment is live      -> PaymentConflictError payment_in_progress (409).
 *  - Booking closed / hold expired        -> PaymentConflictError (409).
 *
 * The payment row is committed BEFORE the provider is called, so a crash or timeout leaves a
 * CREATED row that the client's retry (same key) picks up and completes; the provider is
 * always called with the payment id as its own idempotency key.
 */
export async function startPayment(
  deps: PaymentDeps,
  input: StartPaymentInput,
  now: () => Date = () => new Date(),
  attempt = 0,
): Promise<PaymentResult> {
  validate(input);
  const fp = fingerprint(input);

  let payment: PaymentRow;
  try {
    payment = await withTransaction(deps.pool, async (tx) => {
      const existing = await tx.query<PaymentRow>(
        'SELECT * FROM payments WHERE booking_id = $1 AND idempotency_key = $2',
        [input.bookingId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_fingerprint !== fp) {
          throw new IdempotencyConflictError(
            'Idempotency-Key was already used for a different request',
          );
        }
        return existing.rows[0];
      }

      const payable = await tx.query<{
        event_id: string;
        amount_minor: string;
        currency: string;
        hold_expires_at: Date;
        state: string;
      }>('SELECT * FROM payables WHERE booking_id = $1 FOR SHARE', [input.bookingId]);
      const p = payable.rows[0];
      if (!p) throw new PayableNotFoundError(`nothing to pay for booking ${input.bookingId}`);
      if (p.state !== 'open')
        throw new PaymentConflictError('booking_closed', 'booking is no longer payable');
      if (p.hold_expires_at.getTime() <= now().getTime()) {
        throw new PaymentConflictError('hold_expired', 'the seat hold has expired');
      }

      const id = uuidv7();
      const inserted = await tx.query<PaymentRow>(
        `INSERT INTO payments
           (id, booking_id, idempotency_key, request_fingerprint, user_id, method,
            amount_minor, currency, state, provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREATED',$9)
         RETURNING *`,
        [
          id,
          input.bookingId,
          input.idempotencyKey,
          fp,
          input.userId,
          input.method,
          p.amount_minor,
          p.currency,
          deps.provider.name,
        ],
      );
      return inserted.rows[0]!;
    });
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'payments_idempotency' && attempt < 2) {
      return startPayment(deps, input, now, attempt + 1); // lost a race with the same request: replay it
    }
    if (e.code === '23505' && e.constraint === 'one_live_payment_per_booking') {
      throw new PaymentConflictError('payment_in_progress', 'this booking already has a payment');
    }
    throw err;
  }

  if (payment.state !== 'CREATED') return result(payment.id, payment.state);
  return submitToProvider(deps, payment, input);
}

async function submitToProvider(
  deps: PaymentDeps,
  payment: PaymentRow,
  input: StartPaymentInput,
): Promise<PaymentResult> {
  let providerRef: string;
  try {
    ({ providerRef } = await deps.provider.createCharge({
      paymentId: payment.id,
      bookingId: payment.booking_id,
      amountMinor: Number(payment.amount_minor),
      currency: payment.currency,
      method: payment.method,
      token: input.token,
      idempotencyKey: payment.id,
    }));
  } catch (err) {
    if (err instanceof ProviderRejectedError) {
      const after: (() => void)[] = [];
      await withTransaction(deps.pool, async (tx) => {
        const locked = await lockPayment(tx, payment.id);
        if (locked) await applyOutcome(tx, locked, 'failed', { reason: err.message }, after);
      });
      after.forEach((f) => f());
      return result(payment.id, 'FAILED');
    }
    // unreachable or errored: the payment stays CREATED so a retry with the same key resumes it
    throw err instanceof ProviderUnavailableError
      ? err
      : new ProviderUnavailableError(`payment provider error: ${(err as Error).message}`);
  }

  const advanced = await deps.pool.query<{ state: PaymentState }>(
    `UPDATE payments SET state = 'PROCESSING', provider_ref = $2, updated_at = now()
      WHERE id = $1 AND state = 'CREATED' RETURNING state`,
    [payment.id, providerRef],
  );
  if (advanced.rows[0]) return result(payment.id, 'PROCESSING');
  // a webhook already settled it while we were storing the reference
  const current = await deps.pool.query<{ state: PaymentState }>(
    'SELECT state FROM payments WHERE id = $1',
    [payment.id],
  );
  return result(payment.id, current.rows[0]!.state);
}

async function lockPayment(tx: Queryable, id: string): Promise<PaymentRow | undefined> {
  const { rows } = await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [
    id,
  ]);
  return rows[0];
}

export type OutcomeResult = 'applied' | 'already' | 'conflict';

/**
 * Moves a locked payment to its final state and publishes the matching event, atomically.
 * Final states never change: a repeat is `already`, an opposite outcome is `conflict`.
 */
async function applyOutcome(
  tx: Queryable,
  p: PaymentRow,
  outcome: 'succeeded' | 'failed',
  info: { providerRef?: string; providerPaymentId?: string; reason?: string },
  /** Runs after the surrounding transaction COMMITS (metrics must not count a rolled-back change). */
  afterCommit?: (() => void)[],
): Promise<OutcomeResult> {
  const target: PaymentState = outcome === 'succeeded' ? 'SUCCEEDED' : 'FAILED';
  if (p.state === target) return 'already';
  if (p.state === 'SUCCEEDED' || p.state === 'FAILED') return 'conflict';

  await tx.query(
    `UPDATE payments
        SET state = $2, provider_ref = COALESCE($3, provider_ref), failure_reason = $4, updated_at = now()
      WHERE id = $1`,
    [
      p.id,
      target,
      info.providerRef ?? null,
      outcome === 'failed' ? (info.reason ?? 'failed') : null,
    ],
  );
  const payable = await tx.query<{ event_id: string }>(
    'UPDATE payables SET state = $2, updated_at = now() WHERE booking_id = $1 RETURNING event_id',
    [p.booking_id, outcome === 'succeeded' ? 'paid' : 'closed'],
  );
  const eventId = payable.rows[0]?.event_id ?? '';

  const envelope =
    outcome === 'succeeded'
      ? buildEnvelope({
          eventType: 'payment.succeeded',
          correlationId: p.booking_id,
          producer: PRODUCER,
          payload: {
            bookingId: p.booking_id,
            paymentId: p.id,
            amountMinor: BigInt(p.amount_minor),
            currency: p.currency,
            providerRef: info.providerRef ?? p.provider_ref ?? '',
            eventId,
          },
        })
      : buildEnvelope({
          eventType: 'payment.failed',
          correlationId: p.booking_id,
          producer: PRODUCER,
          payload: {
            bookingId: p.booking_id,
            paymentId: p.id,
            reason: info.reason ?? 'failed',
            eventId,
            userId: p.user_id,
          },
        });
  await appendToOutbox(tx, envelope, p.booking_id);
  afterCommit?.push(() => {
    metrics.paymentsFinished().inc({ outcome });
    metrics.paymentDuration().observe({ outcome }, (Date.now() - p.created_at.getTime()) / 1000);
  });
  return 'applied';
}

export type WebhookResult =
  | 'applied' // changed the payment and published an event
  | 'duplicate' // this exact delivery was already processed
  | 'already' // a different delivery that repeats the payment's final state
  | 'conflict' // contradicts the payment's final state; recorded, not applied
  | 'amount_mismatch' // provider amount differs from ours; recorded, not applied
  | 'unmatched' // no such payment; recorded
  | 'ignored'; // authentic but not a payment event

/**
 * Handles a provider webhook. Throws InvalidSignatureError (nothing stored) if it is not
 * authentic. Duplicate, late and out-of-order deliveries are all safe: every accepted delivery
 * is recorded once, and a payment's final state can never be changed by a later message.
 */
export async function handleWebhook(
  deps: PaymentDeps,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
): Promise<WebhookResult> {
  const event = deps.provider.verifyWebhook(rawBody, headers);
  if (!event) return 'ignored';
  if (event.kind === 'refund') return handleRefundWebhook(deps, event);

  const after: (() => void)[] = [];
  const outcome = await withTransaction(deps.pool, async (tx) => {
    const recorded = await tx.query(
      `INSERT INTO webhook_events (provider, provider_event_id, payment_id, outcome)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [deps.provider.name, event.providerEventId, event.paymentId, event.outcome],
    );
    if (recorded.rowCount === 0) return 'duplicate';

    const finish = async (r: WebhookResult): Promise<WebhookResult> => {
      await tx.query(
        'UPDATE webhook_events SET result = $3 WHERE provider = $1 AND provider_event_id = $2',
        [deps.provider.name, event.providerEventId, r],
      );
      return r;
    };

    const payment = await lockPayment(tx, event.paymentId);
    if (!payment) return finish('unmatched');
    if (event.amountMinor !== undefined && event.amountMinor !== Number(payment.amount_minor)) {
      return finish('amount_mismatch');
    }
    return finish(
      await applyOutcome(
        tx,
        payment,
        event.outcome,
        {
          providerRef: event.providerRef,
          providerPaymentId: event.providerPaymentId,
          reason: event.reason,
        },
        after,
      ),
    );
  });
  after.forEach((f) => f());
  return outcome;
}
