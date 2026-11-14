import type { Pool } from 'pg';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, processOnce, type Queryable } from '@gatepass/outbox';
import { metrics } from '@gatepass/telemetry';
import { holdSeats } from './hold';

export const PRODUCER = 'seat-inventory';
export const CONSUMER_GROUP = 'seat-inventory';
export const CONSUMED_TOPICS = [
  'event.published',
  'booking.requested',
  'payment.succeeded',
  'payment.failed',
  'refund.completed',
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

  let held: 'ok' | string = 'ok';
  const done = await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
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
    held = result.ok ? 'ok' : result.reason;
    // keyed by event so all seat changes of one event stay ordered on one partition
    await appendToOutbox(tx, outgoing, p.eventId);
  });
  // counted after the commit, and once per booking however often the request is delivered
  if (done === 'processed') {
    if (held === 'ok') metrics.holdsCreated().inc();
    else metrics.holdsFailed().inc({ reason: held });
  }
}

/** Locks a booking's held seats in a fixed order (so a sale, a release and a sweep cannot deadlock). */
async function lockHeldSeats(
  tx: Queryable,
  bookingId: string,
): Promise<{ event_id: string; seat_id: string; price_minor: string; currency: string }[]> {
  const { rows } = await tx.query<{
    event_id: string;
    seat_id: string;
    price_minor: string;
    currency: string;
  }>(
    `SELECT event_id, seat_id, price_minor, currency FROM seats
      WHERE booking_id = $1 AND state = 'held' ORDER BY seat_id FOR UPDATE`,
    [bookingId],
  );
  return rows;
}

/**
 * payment.succeeded -> the booking's held seats become sold, and seats.sold is published.
 *
 * If the booking no longer holds its seats, the hold was released before the payment landed
 * (the expiry-vs-payment race). The sale cannot happen, so seats.sale_failed is published and
 * the payment service refunds the buyer. Either way the outcome is decided by who locked the
 * seat rows first, so a booking is never both sold and released.
 */
export async function onPaymentSucceeded(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'paymentSucceeded') return;
  const payment = env.payload.value;
  const bookingId = payment.bookingId;
  let saleFailed = false;
  const done = await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const locked = await lockHeldSeats(tx, bookingId);
    if (locked.length > 0) {
      await tx.query(
        `UPDATE seats
            SET state = 'sold', hold_expires_at = NULL, version = version + 1, updated_at = now()
          WHERE booking_id = $1 AND state = 'held'`,
        [bookingId],
      );
      const eventId = locked[0]!.event_id;
      await appendToOutbox(
        tx,
        buildEnvelope({
          eventType: 'seats.sold',
          correlationId: env.correlationId,
          causationId: env.eventId,
          producer: PRODUCER,
          payload: {
            bookingId,
            eventId,
            seatIds: locked.map((r) => r.seat_id),
            amountMinor: BigInt(locked.reduce((n, r) => n + Number(r.price_minor), 0)),
            currency: locked[0]!.currency,
          },
        }),
        eventId,
      );
      return;
    }

    const already = await tx.query(
      "SELECT 1 FROM seats WHERE booking_id = $1 AND state = 'sold' LIMIT 1",
      [bookingId],
    );
    if (already.rowCount) return; // already sold to this booking

    saleFailed = true;
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'seats.sale_failed',
        correlationId: env.correlationId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: { bookingId, eventId: payment.eventId, seatIds: [], reason: 'hold_released' },
      }),
      payment.eventId || bookingId,
    );
  });
  if (done === 'processed' && saleFailed) metrics.salesFailed().inc();
}

/**
 * payment.failed -> the booking's HELD seats go back on sale and seats.released is published.
 * Sold seats are never touched, so a stray failure cannot un-sell a confirmed booking.
 */
export async function onPaymentFailed(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'paymentFailed') return;
  const bookingId = env.payload.value.bookingId;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const locked = await lockHeldSeats(tx, bookingId);
    if (locked.length === 0) return; // nothing held: already released or already sold
    await tx.query(
      `UPDATE seats
          SET state = 'available', booking_id = NULL, hold_expires_at = NULL,
              version = version + 1, updated_at = now()
        WHERE booking_id = $1 AND state = 'held'`,
      [bookingId],
    );
    const eventId = locked[0]!.event_id;
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'seats.released',
        correlationId: env.correlationId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: {
          bookingId,
          eventId,
          seatIds: locked.map((r) => r.seat_id),
          reason: 'payment_failed',
        },
      }),
      eventId,
    );
  });
}

/**
 * refund.completed -> the refunded ticket's seat goes back on sale. An automatic refund names no
 * seat (nothing was ever sold), so it changes nothing here.
 */
export async function onRefundCompleted(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'refundCompleted') return;
  const r = env.payload.value;
  if (!r.seatId || !r.eventId) return;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const freed = await tx.query(
      `UPDATE seats
          SET state = 'available', booking_id = NULL, hold_expires_at = NULL,
              version = version + 1, updated_at = now()
        WHERE event_id = $1 AND seat_id = $2 AND booking_id = $3 AND state = 'sold'`,
      [r.eventId, r.seatId, r.bookingId],
    );
    if (freed.rowCount === 0) return; // not sold to this booking (already returned)
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'seats.released',
        correlationId: env.correlationId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: {
          bookingId: r.bookingId,
          eventId: r.eventId,
          seatIds: [r.seatId],
          reason: 'refunded',
        },
      }),
      r.eventId,
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
    if (env.eventType === 'refund.completed') return onRefundCompleted(pool, env);
  };
}
