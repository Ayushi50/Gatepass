import type { Pool } from 'pg';
import type { ActivityItem } from '@gatepass/events';

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}

export interface TierSummary {
  name: string;
  sold: number;
  total: number;
}

export interface Summary {
  eventId: string;
  title: string;
  startsAt: string;
  /** The organizer.html tiles: "Sold 842 of 1,200", "Held right now", "Seats left". */
  sold: number;
  total: number;
  held: number;
  left: number;
  tiers: TierSummary[];
}

/** Loads the event and refuses anyone but its organizer (no peeking at other people's sales). */
async function authorize(pool: Pool, eventId: string, organizerId: string) {
  const { rows } = await pool.query<{
    organizer_id: string;
    title: string;
    starts_at: Date;
    total_seats: number;
  }>('SELECT organizer_id, title, starts_at, total_seats FROM events WHERE event_id = $1', [
    eventId,
  ]);
  const ev = rows[0];
  if (!ev) throw new NotFoundError(`event ${eventId} not found`);
  if (ev.organizer_id !== organizerId) throw new ForbiddenError('not your event');
  return ev;
}

export async function getSummary(
  pool: Pool,
  eventId: string,
  organizerId: string,
): Promise<Summary> {
  const ev = await authorize(pool, eventId, organizerId);
  const { rows } = await pool.query<{ tier: string; sold: string; held: string; total: string }>(
    `SELECT tier,
            count(*) FILTER (WHERE state = 'sold') AS sold,
            count(*) FILTER (WHERE state = 'held') AS held,
            count(*) AS total
       FROM seat_status
      WHERE event_id = $1 AND tier IS NOT NULL
      GROUP BY tier ORDER BY min(seat_id)`,
    [eventId],
  );
  const sold = rows.reduce((n, r) => n + Number(r.sold), 0);
  const held = rows.reduce((n, r) => n + Number(r.held), 0);
  return {
    eventId,
    title: ev.title,
    startsAt: ev.starts_at.toISOString(),
    sold,
    total: ev.total_seats,
    held,
    left: ev.total_seats - sold - held,
    tiers: rows.map((r) => ({ name: r.tier, sold: Number(r.sold), total: Number(r.total) })),
  };
}

/** Newest first. */
export async function getActivity(
  pool: Pool,
  eventId: string,
  organizerId: string,
  limit = 20,
): Promise<ActivityItem[]> {
  await authorize(pool, eventId, organizerId);
  const { rows } = await pool.query<{
    source_event_id: string;
    event_id: string;
    booking_id: string;
    type: string;
    text: string;
    failed: boolean;
    occurred_at: Date;
  }>(
    `SELECT source_event_id, event_id, booking_id, type, text, failed, occurred_at FROM activity
      WHERE event_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
    [eventId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map((r) => ({
    id: r.source_event_id,
    eventId: r.event_id,
    bookingId: r.booking_id,
    type: r.type,
    text: r.text,
    failed: r.failed,
    at: r.occurred_at.toISOString(),
  }));
}
