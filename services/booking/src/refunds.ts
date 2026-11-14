import type { Pool } from 'pg';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, processOnce, withTransaction } from '@gatepass/outbox';
import { ForbiddenError, NotFoundError, PRODUCER } from './bookings';

/**
 * The refund saga's states. REQUESTED -> APPROVED -> COMPLETED, never backwards. The state lives
 * in the `refunds` table, so the saga resumes after a crash.
 */
export type RefundState = 'REQUESTED' | 'APPROVED' | 'COMPLETED';

export const REFUND_TRANSITIONS: Readonly<Record<RefundState, readonly RefundState[]>> = {
  REQUESTED: ['APPROVED'],
  APPROVED: ['COMPLETED'],
  COMPLETED: [],
};

const CONSUMER_GROUP = 'booking';

/** refund.requested -> remember it, waiting for the organizer. */
export async function onRefundRequested(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'refundRequested') return;
  const r = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await tx.query(
      `INSERT INTO refunds (id, booking_id, ticket_id, event_id, seat_id, user_id, organizer_id,
                            amount_minor, currency, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'REQUESTED') ON CONFLICT DO NOTHING`,
      [
        r.refundId,
        r.bookingId,
        r.ticketId,
        r.eventId,
        r.seatId,
        r.userId,
        r.organizerId,
        r.amountMinor,
        r.currency,
      ],
    );
  });
}

/** refund.completed -> APPROVED becomes COMPLETED. An automatic refund has no saga row. */
export async function onRefundCompleted(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'refundCompleted') return;
  const r = env.payload.value;
  if (!r.ticketId) return;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await tx.query(
      `UPDATE refunds SET state = 'COMPLETED', updated_at = now()
        WHERE id = $1 AND state = 'APPROVED'`,
      [r.refundId],
    );
  });
}

/**
 * The organizer approves a refund. Only the event's organizer may, and only once: the first call
 * moves REQUESTED -> APPROVED and publishes refund.approved in the same transaction; a repeat just
 * reports the current state (so a double click cannot refund twice).
 */
export async function approveRefund(
  pool: Pool,
  refundId: string,
  organizerId: string,
): Promise<{ refundId: string; state: RefundState }> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      booking_id: string;
      ticket_id: string;
      event_id: string;
      seat_id: string;
      user_id: string;
      organizer_id: string;
      amount_minor: string;
      currency: string;
      state: RefundState;
    }>('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
    const r = rows[0];
    if (!r) throw new NotFoundError(`refund ${refundId} not found`);
    if (r.organizer_id !== organizerId) throw new ForbiddenError('not your event');
    if (r.state !== 'REQUESTED') return { refundId, state: r.state };

    await tx.query(
      `UPDATE refunds SET state = 'APPROVED', approved_by = $2, updated_at = now() WHERE id = $1`,
      [refundId, organizerId],
    );
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'refund.approved',
        correlationId: r.booking_id,
        producer: PRODUCER,
        payload: {
          refundId,
          bookingId: r.booking_id,
          ticketId: r.ticket_id,
          eventId: r.event_id,
          seatId: r.seat_id,
          userId: r.user_id,
          amountMinor: BigInt(r.amount_minor),
          currency: r.currency,
        },
      }),
      r.booking_id,
    );
    return { refundId, state: 'APPROVED' as const };
  });
}
