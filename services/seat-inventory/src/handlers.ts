import type { Pool } from 'pg';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, processOnce } from '@gatepass/outbox';
import { holdSeats } from './hold';

export const PRODUCER = 'seat-inventory';
export const CONSUMER_GROUP = 'seat-inventory';
export const CONSUMED_TOPICS = ['event.published', 'booking.requested'];
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
      `INSERT INTO seats (event_id, seat_id, row_label, number, tier, price_minor)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::bigint[])
       ON CONFLICT (event_id, seat_id) DO NOTHING`,
      [
        p.eventId,
        p.seats.map((s) => s.seatId),
        p.seats.map((s) => s.row),
        p.seats.map((s) => s.number),
        p.seats.map((s) => s.tier),
        p.seats.map((s) => s.priceMinor),
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

/** The dispatcher used by both the Kafka consumer and in-process tests. */
export function seatInventoryHandler(pool: Pool, opts: HandlerOptions = {}) {
  return async (env: EventEnvelope): Promise<void> => {
    if (env.eventType === 'event.published') return onEventPublished(pool, env);
    if (env.eventType === 'booking.requested') return onBookingRequested(pool, env, opts);
  };
}
