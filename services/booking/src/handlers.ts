import type { Pool } from 'pg';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, processOnce } from '@gatepass/outbox';
import { PRODUCER, getBooking, transitionBooking } from './bookings';

export const CONSUMER_GROUP = 'booking';
export const CONSUMED_TOPICS = [
  'seats.held',
  'seats.hold_failed',
  'payment.succeeded',
  'seats.sold',
  'seats.released',
];

/** seats.held -> REQUESTED becomes HELD, remembering the server-computed hold expiry. */
export async function onSeatsHeld(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsHeld') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await transitionBooking(tx, p.bookingId, 'HELD', {
      causeEventId: env.eventId,
      holdExpiresAt: new Date(Number(p.holdExpiresAtMs)),
      amountMinor: Number(p.amountMinor),
      currency: p.currency,
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
      onlyFrom: ['REQUESTED'], // a hold failure says nothing about a booking that already holds seats
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

/** payment.succeeded -> HELD becomes PAID. Late or repeated ones are ignored by the state machine. */
export async function onPaymentSucceeded(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'paymentSucceeded') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await transitionBooking(tx, p.bookingId, 'PAID', { causeEventId: env.eventId });
  });
}

/** seats.sold -> CONFIRMED (from PAID, or straight from HELD if it overtook payment.succeeded). */
export async function onSeatsSold(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsSold') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const outcome = await transitionBooking(tx, p.bookingId, 'CONFIRMED', {
      causeEventId: env.eventId,
    });
    if (outcome !== 'applied') return;
    const b = await getBooking(tx, p.bookingId);
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'booking.confirmed',
        correlationId: p.bookingId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: {
          bookingId: b.id,
          eventId: b.eventId,
          userId: b.userId,
          seatIds: b.seatIds,
          amountMinor: BigInt(b.amountMinor ?? 0),
          currency: b.currency ?? '',
        },
      }),
      b.id,
    );
  });
}

/** seats.released -> HELD becomes CANCELLED (payment failed; later also hold expired). */
export async function onSeatsReleased(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsReleased') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const outcome = await transitionBooking(tx, p.bookingId, 'CANCELLED', {
      causeEventId: env.eventId,
      cancelReason: p.reason,
    });
    if (outcome !== 'applied') return;
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'booking.cancelled',
        correlationId: p.bookingId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: { bookingId: p.bookingId, eventId: p.eventId, reason: p.reason },
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
    if (env.eventType === 'payment.succeeded') return onPaymentSucceeded(pool, env);
    if (env.eventType === 'seats.sold') return onSeatsSold(pool, env);
    if (env.eventType === 'seats.released') return onSeatsReleased(pool, env);
  };
}
