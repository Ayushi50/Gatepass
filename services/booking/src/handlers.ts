import type { Pool } from 'pg';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, processOnce } from '@gatepass/outbox';
import { PRODUCER, transitionBooking } from './bookings';

export const CONSUMER_GROUP = 'booking';
export const CONSUMED_TOPICS = ['seats.held', 'seats.hold_failed'];

/** seats.held -> REQUESTED becomes HELD, remembering the server-computed hold expiry. */
export async function onSeatsHeld(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsHeld') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await transitionBooking(tx, p.bookingId, 'HELD', {
      causeEventId: env.eventId,
      holdExpiresAt: new Date(Number(p.holdExpiresAtMs)),
    });
  });
}

/** seats.hold_failed -> REQUESTED becomes CANCELLED and booking.cancelled is published. */
export async function onSeatsHoldFailed(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsHoldFailed') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const outcome = await transitionBooking(tx, p.bookingId, 'CANCELLED', {
      causeEventId: env.eventId,
      cancelReason: 'hold_failed',
    });
    if (outcome !== 'applied') return; // nothing changed, so nothing to announce
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'booking.cancelled',
        correlationId: p.bookingId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: { bookingId: p.bookingId, eventId: p.eventId, reason: 'hold_failed' },
      }),
      p.bookingId,
    );
  });
}

/** The dispatcher used by both the Kafka consumer and in-process tests. */
export function bookingHandler(pool: Pool) {
  return async (env: EventEnvelope): Promise<void> => {
    if (env.eventType === 'seats.held') return onSeatsHeld(pool, env);
    if (env.eventType === 'seats.hold_failed') return onSeatsHoldFailed(pool, env);
  };
}
