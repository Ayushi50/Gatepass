import type { Pool } from 'pg';
import type { EventEnvelope } from '@gatepass/events';
import { processOnce } from '@gatepass/outbox';
import type { PaymentProvider } from './providers/provider';
import { onRefundApproved, onSeatsSaleFailed } from './refunds';

export const CONSUMER_GROUP = 'payment';
export const CONSUMED_TOPICS = [
  'seats.held',
  'seats.released',
  'refund.approved',
  'seats.sale_failed',
];

/** seats.held -> the booking can now be paid, for this amount, until the hold expires. */
export async function onSeatsHeld(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsHeld') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await tx.query(
      `INSERT INTO payables (booking_id, event_id, amount_minor, currency, hold_expires_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (booking_id) DO NOTHING`,
      [p.bookingId, p.eventId, p.amountMinor, p.currency, new Date(Number(p.holdExpiresAtMs))],
    );
  });
}

/** seats.released -> the booking can no longer be paid. */
export async function onSeatsReleased(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsReleased') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    // Closes the payable, or, if seats.held has not been seen yet (it can arrive later), leaves a
    // closed one behind so that late seats.held cannot make the booking payable again.
    await tx.query(
      `INSERT INTO payables (booking_id, event_id, amount_minor, currency, hold_expires_at, state)
       VALUES ($1, $2, 0, '', now(), 'closed')
       ON CONFLICT (booking_id) DO UPDATE SET state = 'closed', updated_at = now()
         WHERE payables.state = 'open'`,
      [p.bookingId, p.eventId],
    );
  });
}

export function paymentHandler(pool: Pool, provider: PaymentProvider) {
  const deps = { pool, provider };
  return async (env: EventEnvelope): Promise<void> => {
    if (env.eventType === 'seats.held') return onSeatsHeld(pool, env);
    if (env.eventType === 'seats.released') return onSeatsReleased(pool, env);
    if (env.eventType === 'refund.approved') return onRefundApproved(deps, env);
    if (env.eventType === 'seats.sale_failed') return onSeatsSaleFailed(deps, env);
  };
}
