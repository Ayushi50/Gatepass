import type { Pool } from 'pg';
import type { Queryable } from '@gatepass/outbox';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, processOnce } from '@gatepass/outbox';
import { metrics } from '@gatepass/telemetry';
import { PRODUCER, getBooking, transitionBooking } from './bookings';
import { onRefundCompleted, onRefundRequested } from './refunds';

export const CONSUMER_GROUP = 'booking';
export const CONSUMED_TOPICS = [
  'seats.held',
  'seats.hold_failed',
  'payment.succeeded',
  'seats.sold',
  'seats.released',
  'refund.requested',
  'refund.completed',
];

/**
 * Events from different topics arrive in no fixed order (a message can be dead-lettered and
 * replayed hours later). So every handler here applies its fact whenever it arrives, and the
 * state machine makes the result the same in ANY order: facts that end a booking (sold, released)
 * win over facts that only advance it (held, paid), and a late fact never undoes an earlier one.
 */

/** Fills in what seats.held knows, whatever state the booking is in (it may have raced ahead). */
async function fillHold(
  tx: Queryable,
  bookingId: string,
  holdExpiresAt: Date,
  amountMinor: number,
  currency: string,
): Promise<void> {
  await tx.query(
    `UPDATE bookings
        SET hold_expires_at = COALESCE(hold_expires_at, $2),
            amount_minor = COALESCE(amount_minor, $3),
            currency = COALESCE(NULLIF(currency, ''), $4),
            updated_at = now()
      WHERE id = $1`,
    [bookingId, holdExpiresAt, amountMinor, currency],
  );
}

/** seats.held -> REQUESTED becomes HELD, remembering the server-computed hold expiry. */
export async function onSeatsHeld(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsHeld') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const holdExpiresAt = new Date(Number(p.holdExpiresAtMs));
    await transitionBooking(tx, p.bookingId, 'HELD', {
      causeEventId: env.eventId,
      holdExpiresAt,
      amountMinor: Number(p.amountMinor),
      currency: p.currency,
    });
    // If the booking had already moved past REQUESTED (this event came late), the transition above
    // is ignored; still record the hold details.
    await fillHold(tx, p.bookingId, holdExpiresAt, Number(p.amountMinor), p.currency);
  });
}

/** seats.hold_failed -> REQUESTED becomes CANCELLED and booking.cancelled is published. */
export async function onSeatsHoldFailed(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsHoldFailed') return;
  const p = env.payload.value;
  let applied = false;
  const result = await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const outcome = await transitionBooking(tx, p.bookingId, 'CANCELLED', {
      causeEventId: env.eventId,
      cancelReason: 'hold_failed',
      onlyFrom: ['REQUESTED'], // a hold failure says nothing about a booking that already holds seats
    });
    if (outcome !== 'applied') return; // nothing changed, so nothing to announce
    applied = true;
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
  if (result === 'processed' && applied) metrics.bookingsCancelled().inc({ reason: 'hold_failed' });
}

/** payment.succeeded -> HELD becomes PAID. Late or repeated ones are ignored by the state machine. */
export async function onPaymentSucceeded(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'paymentSucceeded') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await transitionBooking(tx, p.bookingId, 'PAID', {
      causeEventId: env.eventId,
      amountMinor: Number(p.amountMinor),
      currency: p.currency,
    });
  });
}

/** seats.sold -> CONFIRMED (from PAID, or straight from HELD if it overtook payment.succeeded). */
export async function onSeatsSold(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsSold') return;
  const p = env.payload.value;
  let applied = false;
  const result = await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const outcome = await transitionBooking(tx, p.bookingId, 'CONFIRMED', {
      causeEventId: env.eventId,
      amountMinor: Number(p.amountMinor),
      currency: p.currency,
    });
    if (outcome !== 'applied') return;
    applied = true;
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
          amountMinor: BigInt(b.amountMinor ?? Number(p.amountMinor)),
          currency: b.currency || p.currency,
        },
      }),
      b.id,
    );
  });
  // counted after the commit, and only when this delivery really changed the booking
  if (result === 'processed' && applied) metrics.bookingsConfirmed().inc();
}

/** seats.released -> HELD becomes CANCELLED (payment failed; later also hold expired). */
export async function onSeatsReleased(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'seatsReleased') return;
  const p = env.payload.value;
  let applied = false;
  const result = await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    // A release only cancels a PAID booking when the hold expired: then the seats were never sold
    // (a sale locks the seats a sweep needs, so both cannot happen) and the payment is refunded.
    // Any other release says nothing about a booking that is already paid.
    const outcome = await transitionBooking(tx, p.bookingId, 'CANCELLED', {
      causeEventId: env.eventId,
      cancelReason: p.reason,
      onlyFrom: p.reason === 'hold_expired' ? ['REQUESTED', 'HELD', 'PAID'] : ['REQUESTED', 'HELD'],
    });
    if (outcome !== 'applied') return;
    applied = true;
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
  // counted after the commit, and only when this delivery really changed the booking
  if (result === 'processed' && applied) metrics.bookingsCancelled().inc({ reason: p.reason });
}

/** The dispatcher used by both the Kafka consumer and in-process tests. */
export function bookingHandler(pool: Pool) {
  return async (env: EventEnvelope): Promise<void> => {
    if (env.eventType === 'seats.held') return onSeatsHeld(pool, env);
    if (env.eventType === 'seats.hold_failed') return onSeatsHoldFailed(pool, env);
    if (env.eventType === 'payment.succeeded') return onPaymentSucceeded(pool, env);
    if (env.eventType === 'seats.sold') return onSeatsSold(pool, env);
    if (env.eventType === 'seats.released') return onSeatsReleased(pool, env);
    if (env.eventType === 'refund.requested') return onRefundRequested(pool, env);
    if (env.eventType === 'refund.completed') return onRefundCompleted(pool, env);
  };
}
