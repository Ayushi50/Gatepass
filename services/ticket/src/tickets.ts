import type { Pool } from 'pg';
import { InvalidQrTokenError, type QrKeyRing } from './qr-token';

export interface TicketView {
  id: string;
  code: string;
  bookingId: string;
  eventId: string;
  eventTitle: string;
  startsAt: string;
  venue: string;
  row: string;
  seat: string;
  tier: string;
  qrToken: string;
  status: 'valid' | 'used';
}

/** The user's tickets, newest first. Only that user's: the id comes from the verified token. */
export async function listTickets(
  pool: Pool,
  keys: QrKeyRing,
  userId: string,
): Promise<TicketView[]> {
  const { rows } = await pool.query<{
    id: string;
    code: string;
    booking_id: string;
    event_id: string;
    title: string;
    starts_at: Date;
    venue: string;
    row_label: string;
    number: number;
    tier: string;
    status: 'valid' | 'used';
  }>(
    `SELECT t.id, t.code, t.booking_id, t.event_id, e.title, e.starts_at, e.venue,
            t.row_label, t.number, t.tier, t.status
       FROM tickets t JOIN events e ON e.event_id = t.event_id
      WHERE t.user_id = $1
      ORDER BY t.created_at DESC, t.row_label, t.number`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    bookingId: r.booking_id,
    eventId: r.event_id,
    eventTitle: r.title,
    startsAt: r.starts_at.toISOString(),
    venue: r.venue,
    row: r.row_label,
    seat: String(r.number),
    tier: r.tier,
    qrToken: keys.sign(r.id, r.event_id),
    status: r.status,
  }));
}

/** Have tickets been issued for this booking? (drives the status page's third light) */
export async function ticketsForBooking(
  pool: Pool,
  bookingId: string,
): Promise<{ issued: boolean; count: number }> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*) FROM tickets WHERE booking_id = $1',
    [bookingId],
  );
  const count = Number(rows[0]!.count);
  return { issued: count > 0, count };
}

export type CheckInResult =
  | { status: 'valid'; row: string; seat: string; tier: string }
  | { status: 'used'; usedAt: string }
  | { status: 'invalid' };

/**
 * Admits a ticket at most once, however many gates scan it at the same time.
 *
 * The decision is ONE conditional UPDATE (`... WHERE status = 'valid'`). Postgres serialises
 * concurrent updates of the same row, so exactly one scan matches and gets `valid`; every
 * other scan matches nothing and is told `used`. There is no read-then-write gap to race in.
 */
export async function checkIn(
  pool: Pool,
  keys: QrKeyRing,
  qrToken: string,
  staffId: string,
): Promise<CheckInResult> {
  let claims: { ticketId: string; eventId: string };
  try {
    claims = keys.verify(qrToken);
  } catch (err) {
    if (err instanceof InvalidQrTokenError) return { status: 'invalid' };
    throw err;
  }

  const admitted = await pool.query<{ row_label: string; number: number; tier: string }>(
    `UPDATE tickets
        SET status = 'used', used_at = now(), used_by = $3
      WHERE id = $1 AND event_id = $2 AND status = 'valid'
  RETURNING row_label, number, tier`,
    [claims.ticketId, claims.eventId, staffId],
  );
  const row = admitted.rows[0];
  if (row) return { status: 'valid', row: row.row_label, seat: String(row.number), tier: row.tier };

  const existing = await pool.query<{ status: string; used_at: Date | null }>(
    'SELECT status, used_at FROM tickets WHERE id = $1 AND event_id = $2',
    [claims.ticketId, claims.eventId],
  );
  const t = existing.rows[0];
  if (t?.status === 'used' && t.used_at) return { status: 'used', usedAt: t.used_at.toISOString() };
  return { status: 'invalid' };
}
