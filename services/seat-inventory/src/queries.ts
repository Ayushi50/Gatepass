import type { Pool } from 'pg';

/** The state names the seat map UI uses (design/seats.html). `sold` is shown as `taken`. */
export type SeatMapState = 'available' | 'held' | 'taken';

export interface SeatView {
  id: string;
  row: string;
  number: number;
  tier: string;
  /** Major currency units (e.g. rupees), as the UI expects. */
  price: number;
  state: SeatMapState;
}

const UI_STATE: Record<string, SeatMapState> = {
  available: 'available',
  held: 'held',
  sold: 'taken',
};

export async function getSeats(pool: Pool, eventId: string): Promise<SeatView[]> {
  const { rows } = await pool.query<{
    seat_id: string;
    row_label: string;
    number: number;
    tier: string;
    price_minor: string;
    state: string;
  }>(
    `SELECT seat_id, row_label, number, tier, price_minor, state
       FROM seats WHERE event_id = $1 ORDER BY row_label, number`,
    [eventId],
  );
  return rows.map((r) => ({
    id: r.seat_id,
    row: r.row_label,
    number: r.number,
    tier: r.tier,
    price: Number(r.price_minor) / 100,
    state: UI_STATE[r.state] ?? 'taken',
  }));
}

export interface Availability {
  eventId: string;
  total: number;
  available: number;
}

export async function getAvailability(pool: Pool, eventIds: string[]): Promise<Availability[]> {
  if (eventIds.length === 0) return [];
  const { rows } = await pool.query<{ event_id: string; total: string; available: string }>(
    `SELECT event_id, count(*) AS total, count(*) FILTER (WHERE state = 'available') AS available
       FROM seats WHERE event_id = ANY($1) GROUP BY event_id`,
    [eventIds],
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    total: Number(r.total),
    available: Number(r.available),
  }));
}
