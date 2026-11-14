import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { buildEnvelope } from '@gatepass/events';
import { appendToOutbox, withTransaction } from '@gatepass/outbox';
import { metrics } from '@gatepass/telemetry';
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
  status: TicketStatus;
}

export type TicketStatus = 'valid' | 'used' | 'refund_requested' | 'void';

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
    status: TicketStatus;
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
  const result = await admit(pool, keys, qrToken, staffId);
  metrics.checkIns().inc({ result: result.status });
  return result;
}

async function admit(
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

export class TicketNotFoundError extends Error {}
export class RefundNotAllowedError extends Error {
  constructor(
    public readonly code: 'used' | 'refund_already_requested' | 'void' | 'no_price',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The owner asks for a refund of one ticket. In ONE transaction the ticket is locked
 * (`valid -> refund_requested`) and refund.requested is published, so the ticket can no longer be
 * scanned and the request cannot be lost. The lock is a conditional UPDATE, the same kind of
 * statement as check-in, so a refund request racing a door scan has exactly one winner.
 */
export async function requestRefund(
  pool: Pool,
  ticketId: string,
  userId: string,
): Promise<{ refundId: string; status: 'refund_requested' }> {
  return withTransaction(pool, async (tx) => {
    const refundId = uuidv7();
    const locked = await tx.query<{
      booking_id: string;
      event_id: string;
      seat_id: string;
    }>(
      `UPDATE tickets SET status = 'refund_requested', refund_id = $3
        WHERE id = $1 AND user_id = $2 AND status = 'valid'
    RETURNING booking_id, event_id, seat_id`,
      [ticketId, userId, refundId],
    );
    const t = locked.rows[0];
    if (!t) {
      const why = await tx.query<{ status: TicketStatus }>(
        'SELECT status FROM tickets WHERE id = $1 AND user_id = $2',
        [ticketId, userId],
      );
      const status = why.rows[0]?.status;
      if (!status) throw new TicketNotFoundError('ticket not found');
      if (status === 'used')
        throw new RefundNotAllowedError('used', 'a ticket that was used cannot be refunded');
      if (status === 'void')
        throw new RefundNotAllowedError('void', 'this ticket was already refunded');
      throw new RefundNotAllowedError('refund_already_requested', 'a refund was already requested');
    }

    const info = await tx.query<{ organizer_id: string; currency: string; price_minor: string }>(
      `SELECT e.organizer_id, e.currency, s.price_minor
         FROM events e JOIN event_seats s ON s.event_id = e.event_id AND s.seat_id = $2
        WHERE e.event_id = $1`,
      [t.event_id, t.seat_id],
    );
    const i = info.rows[0];
    if (!i || Number(i.price_minor) <= 0) {
      throw new RefundNotAllowedError('no_price', 'the price of this ticket is unknown'); // rolls the lock back
    }

    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'refund.requested',
        correlationId: t.booking_id,
        producer: 'ticket',
        payload: {
          refundId,
          bookingId: t.booking_id,
          ticketId,
          userId,
          amountMinor: BigInt(i.price_minor),
          currency: i.currency,
          reason: '',
          eventId: t.event_id,
          seatId: t.seat_id,
          organizerId: i.organizer_id,
        },
      }),
      t.booking_id,
    );
    return { refundId, status: 'refund_requested' as const };
  });
}
