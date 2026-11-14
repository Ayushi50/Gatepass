import type { Pool } from 'pg';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, processOnce } from '@gatepass/outbox';
import { holdSeats } from './hold';

export const PRODUCER = 'seat-inventory';
export const CONSUMER_GROUP = 'seat-inventory';
export const CONSUMED_TOPICS = [
  'event.published',
  'booking.requested',
  'payment.succeeded',
  'payment.failed',
];
export const DEFAULT_HOLD_TTL_MS = 10 * 60 * 1000;

export interface HandlerOptions {
  holdTtlMs?: number;
  /** Injectable clock (epoch ms). Hold expiry is always computed on the server. */
  now?: () => number;
}

/** event.published -> create the event's seats (all available). */
export async function onEventPublished(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'eventPublished') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await tx.query(
      `INSERT INTO seats (event_id, seat_id, row_label, number, tier, price_minor, currency)
       SELECT $1, u.a, u.b, u.c, u.d, u.e, $7
         FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::bigint[]) AS u(a, b, c, d, e)
       ON CONFLICT (event_id, seat_id) DO NOTHING`,
      [
        p.eventId,
        p.seats.map((s) => s.seatId),
        p.seats.map((s) => s.row),
        p.seats.map((s) => s.number),
        p.seats.map((s) => s.tier),
        p.seats.map((s) => s.priceMinor),
        p.currency || 'INR',
      ],
    );
  });
}

/** booking.requested -> hold all seats or none, emit seats.held or seats.hold_failed. */
export async function onBookingRequested(
  pool: Pool,
  env: EventEnvelope,
  opts: HandlerOptions = {},
): Promise<void> {
  if (env.payload.case !== 'bookingRequested') return;
  const p = env.payload.value;
  const now = opts.now ?? Date.now;
  const holdExpiresAtMs = now() + (opts.holdTtlMs ?? DEFAULT_HOLD_TTL_MS);

  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const result = await holdSeats(
      tx,
      { bookingId: p.bookingId, eventId: p.eventId, seatIds: p.seatIds },
      new Date(holdExpiresAtMs),
    );
    const outgoing = result.ok
      ? buildEnvelope({
          eventType: 'seats.held',
          correlationId: env.correlationId,
          causationId: env.eventId,
          producer: PRODUCER,
          payload: {
            bookingId: p.bookingId,
            eventId: p.eventId,
            seatIds: p.seatIds,
            holdExpiresAtMs: BigInt(holdExpiresAtMs),
            amountMinor: BigInt(result.amountMinor),
            currency: result.currency,
          },
        })
      : buildEnvelope({
          eventType: 'seats.hold_failed',
          correlationId: env.correlationId,
          causationId: env.eventId,
          producer: PRODUCER,
          payload: {
            bookingId: p.bookingId,
            eventId: p.eventId,
            seatIds: result.seatIds,
            reason: result.reason,
          },
        });
    // keyed by event so all seat changes of one event stay ordered on one partition
    await appendToOutbox(tx, outgoing, p.eventId);
  });
}

/**
 * payment.succeeded -> the booking's held seats become sold, and seats.sold is published.
 * Only seats still HELD by this booking can be sold. If none are (and none were already sold
 * to it), the payment has nowhere to go; that must be loud, so this throws and the message is
 * retried and then dead-lettered. (Phase 4 decides what to do when a payment outlives its hold.)
 */
export async function onPaymentSucceeded(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'paymentSucceeded') return;
  const bookingId = env.payload.value.bookingId;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const sold = await tx.query<{ event_id: string; seat_id: string }>(
      `UPDATE seats
          SET state = 'sold', hold_expires_at = NULL, version = version + 1, updated_at = now()
        WHERE booking_id = $1 AND state = 'held'
    RETURNING event_id, seat_id`,
      [bookingId],
    );
    if (sold.rowCount === 0) {
      const already = await tx.query(
        "SELECT 1 FROM seats WHERE booking_id = $1 AND state = 'sold'",
        [bookingId],
      );
      if (already.rowCount) return; // already sold to this booking
      throw new Error(`payment.succeeded for booking ${bookingId} but it holds no seats`);
    }
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'seats.sold',
        correlationId: env.correlationId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: {
          bookingId,
          eventId: sold.rows[0]!.event_id,
          seatIds: sold.rows.map((r) => r.seat_id).sort(),
        },
      }),
      sold.rows[0]!.event_id,
    );
  });
}

/**
 * payment.failed -> the booking's HELD seats go back on sale and seats.released is published.
 * Sold seats are never touched, so a stray failure cannot un-sell a confirmed booking.
 */
export async function onPaymentFailed(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'paymentFailed') return;
  const bookingId = env.payload.value.bookingId;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const released = await tx.query<{ event_id: string; seat_id: string }>(
      `UPDATE seats
          SET state = 'available', booking_id = NULL, hold_expires_at = NULL,
              version = version + 1, updated_at = now()
        WHERE booking_id = $1 AND state = 'held'
    RETURNING event_id, seat_id`,
      [bookingId],
    );
    if (released.rowCount === 0) return; // nothing held: already released or already sold
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'seats.released',
        correlationId: env.correlationId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: {
          bookingId,
          eventId: released.rows[0]!.event_id,
          seatIds: released.rows.map((r) => r.seat_id).sort(),
          reason: 'payment_failed',
        },
      }),
      released.rows[0]!.event_id,
    );
  });
}

/** The dispatcher used by both the Kafka consumer and in-process tests. */
export function seatInventoryHandler(pool: Pool, opts: HandlerOptions = {}) {
  return async (env: EventEnvelope): Promise<void> => {
    if (env.eventType === 'event.published') return onEventPublished(pool, env);
    if (env.eventType === 'booking.requested') return onBookingRequested(pool, env, opts);
    if (env.eventType === 'payment.succeeded') return onPaymentSucceeded(pool, env);
    if (env.eventType === 'payment.failed') return onPaymentFailed(pool, env);
  };
}
