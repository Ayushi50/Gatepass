import type { Pool } from 'pg';
import type { EventEnvelope } from '@gatepass/events';
import { processOnce } from '@gatepass/outbox';

export const CONSUMER_GROUP = 'payment';
export const CONSUMED_TOPICS = ['seats.held', 'seats.released'];

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
    await tx.query(
      `UPDATE payables SET state = 'closed', updated_at = now()
        WHERE booking_id = $1 AND state = 'open'`,
      [p.bookingId],
    );
  });
}

export function paymentHandler(pool: Pool) {
  return async (env: EventEnvelope): Promise<void> => {
    if (env.eventType === 'seats.held') return onSeatsHeld(pool, env);
    if (env.eventType === 'seats.released') return onSeatsReleased(pool, env);
  };
}
