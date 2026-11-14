import type { Queryable } from '@gatepass/outbox';

export interface HoldRequest {
  bookingId: string;
  eventId: string;
  seatIds: string[];
}

export type HoldResult =
  | { ok: true; amountMinor: number; currency: string }
  | {
      ok: false;
      reason: 'invalid_request' | 'unknown_seat' | 'seat_unavailable';
      seatIds: string[];
    };

/**
 * Holds ALL requested seats for the booking, or NONE. Must be called inside a transaction.
 *
 * Seats are locked in a fixed order (ORDER BY seat_id) so two overlapping requests cannot
 * deadlock. FOR UPDATE SKIP LOCKED means a seat another request is working on counts as
 * unavailable immediately, so the caller fails fast instead of queueing behind a lock.
 * Under READ COMMITTED the `state = 'available'` filter is re-checked after the lock is
 * acquired, so a seat that was just held by a committed transaction is not returned.
 *
 * Consequence (accepted): if the request that holds a lock later rolls back, a request that
 * skipped that seat has already failed. The buyer simply retries.
 */
export async function holdSeats(
  tx: Queryable,
  req: HoldRequest,
  holdExpiresAt: Date,
): Promise<HoldResult> {
  const unique = new Set(req.seatIds);
  if (req.seatIds.length === 0 || unique.size !== req.seatIds.length) {
    return { ok: false, reason: 'invalid_request', seatIds: req.seatIds };
  }

  const locked = await tx.query<{ seat_id: string }>(
    `SELECT seat_id FROM seats
      WHERE event_id = $1 AND seat_id = ANY($2) AND state = 'available'
      ORDER BY seat_id
        FOR UPDATE SKIP LOCKED`,
    [req.eventId, req.seatIds],
  );

  if (locked.rowCount === req.seatIds.length) {
    const held = await tx.query<{ price_minor: string; currency: string }>(
      `UPDATE seats
          SET state = 'held', booking_id = $3, hold_expires_at = $4,
              version = version + 1, updated_at = now()
        WHERE event_id = $1 AND seat_id = ANY($2)
    RETURNING price_minor, currency`,
      [req.eventId, req.seatIds, req.bookingId, holdExpiresAt],
    );
    return {
      ok: true,
      amountMinor: held.rows.reduce((sum, r) => sum + Number(r.price_minor), 0),
      currency: held.rows[0]!.currency,
    };
  }

  const got = new Set(locked.rows.map((r) => r.seat_id));
  const missing = req.seatIds.filter((id) => !got.has(id));
  const existing = await tx.query<{ seat_id: string }>(
    'SELECT seat_id FROM seats WHERE event_id = $1 AND seat_id = ANY($2)',
    [req.eventId, missing],
  );
  const known = new Set(existing.rows.map((r) => r.seat_id));
  const unknown = missing.filter((id) => !known.has(id));
  return unknown.length > 0
    ? { ok: false, reason: 'unknown_seat', seatIds: unknown }
    : { ok: false, reason: 'seat_unavailable', seatIds: missing };
}
