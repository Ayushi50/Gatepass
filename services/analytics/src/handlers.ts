import type { Pool } from 'pg';
import { EVENT_TYPES, describeActivity, type EventEnvelope } from '@gatepass/events';
import { processOnce, type Queryable } from '@gatepass/outbox';

export const CONSUMER_GROUP = 'analytics';
/** Analytics consumes every event type. */
export const CONSUMED_TOPICS: string[] = [...EVENT_TYPES];

type SeatState = 'available' | 'held' | 'sold';

/** Which seat events change a seat, and to what. */
function seatChange(
  env: EventEnvelope,
): { eventId: string; seatIds: string[]; state: SeatState } | null {
  const p = env.payload;
  switch (p.case) {
    case 'seatsHeld':
      return { eventId: p.value.eventId, seatIds: p.value.seatIds, state: 'held' };
    case 'seatsSold':
      return { eventId: p.value.eventId, seatIds: p.value.seatIds, state: 'sold' };
    case 'seatsReleased':
      return { eventId: p.value.eventId, seatIds: p.value.seatIds, state: 'available' };
    case 'holdExpired':
      return { eventId: p.value.eventId, seatIds: p.value.seatIds, state: 'available' };
    default:
      return null;
  }
}

async function applyEventPublished(tx: Queryable, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'eventPublished') return;
  const p = env.payload.value;
  await tx.query(
    `INSERT INTO events (event_id, organizer_id, title, starts_at, total_seats)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING`,
    [p.eventId, p.organizerId, p.title, new Date(Number(p.startsAtMs)), p.seats.length],
  );
  // Fill in the tier. Never touch `state`: a seat event may already have arrived.
  await tx.query(
    `INSERT INTO seat_status (event_id, seat_id, tier)
     SELECT $1, u.a, u.b FROM unnest($2::text[], $3::text[]) AS u(a, b)
     ON CONFLICT (event_id, seat_id) DO UPDATE SET tier = EXCLUDED.tier`,
    [p.eventId, p.seats.map((s) => s.seatId), p.seats.map((s) => s.tier)],
  );
}

async function applySeatChange(tx: Queryable, env: EventEnvelope): Promise<void> {
  const change = seatChange(env);
  if (!change) return;
  // Upsert, but only if this event is not older than what we already know about the seat.
  await tx.query(
    `INSERT INTO seat_status (event_id, seat_id, state, last_event_ms)
     SELECT $1, u.a, $3, $4 FROM unnest($2::text[]) AS u(a)
     ON CONFLICT (event_id, seat_id) DO UPDATE
        SET state = EXCLUDED.state, last_event_ms = EXCLUDED.last_event_ms
      WHERE seat_status.last_event_ms <= EXCLUDED.last_event_ms`,
    [change.eventId, change.seatIds, change.state, env.occurredAtMs],
  );
}

/** refund.requested / approved / completed -> the organizer's refund list. Automatic refunds have no ticket. */
async function applyRefund(tx: Queryable, env: EventEnvelope): Promise<void> {
  const p = env.payload;
  let r: {
    refundId: string;
    eventId: string;
    bookingId: string;
    ticketId: string;
    seatId: string;
    userId: string;
    amountMinor: bigint;
    currency: string;
  };
  let rank: number;
  switch (p.case) {
    case 'refundRequested':
      r = p.value;
      rank = 1;
      break;
    case 'refundApproved':
      r = p.value;
      rank = 2;
      break;
    case 'refundCompleted':
      r = p.value;
      rank = 3;
      break;
    default:
      return;
  }
  if (!r.ticketId || !r.eventId) return;
  await tx.query(
    `INSERT INTO refunds (refund_id, event_id, booking_id, ticket_id, seat_id, user_id, amount_minor, currency, rank)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (refund_id) DO UPDATE SET
       rank = GREATEST(refunds.rank, EXCLUDED.rank),
       seat_id = COALESCE(NULLIF(refunds.seat_id, ''), EXCLUDED.seat_id),
       user_id = COALESCE(NULLIF(refunds.user_id, ''), EXCLUDED.user_id),
       amount_minor = CASE WHEN refunds.amount_minor = 0 THEN EXCLUDED.amount_minor ELSE refunds.amount_minor END,
       currency = COALESCE(NULLIF(refunds.currency, ''), EXCLUDED.currency)`,
    [
      r.refundId,
      r.eventId,
      r.bookingId,
      r.ticketId,
      r.seatId,
      r.userId,
      r.amountMinor,
      r.currency,
      rank,
    ],
  );
}

async function applyActivity(tx: Queryable, env: EventEnvelope): Promise<void> {
  const a = describeActivity(env);
  if (!a) return;
  await tx.query(
    `INSERT INTO activity (source_event_id, event_id, booking_id, type, text, failed, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_event_id) DO NOTHING`,
    [env.eventId, a.eventId, a.bookingId, a.type, a.text, a.failed, a.at],
  );
}

/** Folds one event into the read model, once (inbox). Safe for duplicates and any order. */
export async function onEvent(pool: Pool, env: EventEnvelope): Promise<void> {
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await applyEventPublished(tx, env);
    await applySeatChange(tx, env);
    await applyRefund(tx, env);
    await applyActivity(tx, env);
  });
}

export function analyticsHandler(pool: Pool) {
  return (env: EventEnvelope): Promise<void> => onEvent(pool, env);
}
