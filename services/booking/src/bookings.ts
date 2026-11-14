import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { buildEnvelope } from '@gatepass/events';
import { appendToOutbox, withTransaction, type Queryable } from '@gatepass/outbox';
import { assertTransition, canTransition, type BookingState } from './state-machine';

export const PRODUCER = 'booking';
export const MAX_SEATS_PER_BOOKING = 6;

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export interface Booking {
  id: string;
  eventId: string;
  userId: string;
  seatIds: string[];
  state: BookingState;
  /** Set when seats are held. Server time (ISO); the browser must not use its own clock. */
  holdExpiresAt: string | null;
  cancelReason: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** Server time when this response was produced, so a client can correct for clock skew. */
  serverTime: string;
}

export interface CreateBookingInput {
  eventId: string;
  userId: string;
  seatIds: string[];
}

export async function createBooking(
  pool: Pool,
  input: CreateBookingInput,
  now: () => Date = () => new Date(),
): Promise<Booking> {
  if (!input.eventId) throw new ValidationError('eventId is required');
  if (!input.userId) throw new ValidationError('userId is required');
  const seats = input.seatIds;
  if (
    !Array.isArray(seats) ||
    seats.length === 0 ||
    seats.some((s) => !s || typeof s !== 'string')
  ) {
    throw new ValidationError('seatIds must be a non-empty list of seat ids');
  }
  if (seats.length > MAX_SEATS_PER_BOOKING) {
    throw new ValidationError(`at most ${MAX_SEATS_PER_BOOKING} seats per booking`);
  }
  if (new Set(seats).size !== seats.length) throw new ValidationError('seatIds must be distinct');

  const id = uuidv7();
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO bookings (id, event_id, user_id, seat_ids, state) VALUES ($1,$2,$3,$4,'REQUESTED')`,
      [id, input.eventId, input.userId, seats],
    );
    await tx.query(
      `INSERT INTO booking_transitions (booking_id, from_state, to_state) VALUES ($1, NULL, 'REQUESTED')`,
      [id],
    );
    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'booking.requested',
        correlationId: id,
        producer: PRODUCER,
        payload: { bookingId: id, eventId: input.eventId, userId: input.userId, seatIds: seats },
      }),
      id,
    );
  });
  return getBooking(pool, id, now);
}

export async function getBooking(
  db: Queryable,
  id: string,
  now: () => Date = () => new Date(),
): Promise<Booking> {
  const { rows } = await db.query<{
    id: string;
    event_id: string;
    user_id: string;
    seat_ids: string[];
    state: BookingState;
    hold_expires_at: Date | null;
    cancel_reason: string | null;
    amount_minor: string | null;
    currency: string | null;
  }>(
    `SELECT id, event_id, user_id, seat_ids, state, hold_expires_at, cancel_reason,
            amount_minor, currency
       FROM bookings WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError(`booking ${id} not found`);
  return {
    id: r.id,
    eventId: r.event_id,
    userId: r.user_id,
    seatIds: r.seat_ids,
    state: r.state,
    holdExpiresAt: r.hold_expires_at ? r.hold_expires_at.toISOString() : null,
    cancelReason: r.cancel_reason,
    amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
    currency: r.currency,
    serverTime: now().toISOString(),
  };
}

export type TransitionOutcome = 'applied' | 'already' | 'ignored';

/**
 * Moves a booking to `to` inside the caller's transaction, under a row lock, and records it.
 *  - applied: state changed
 *  - already: booking is already in `to` (safe duplicate)
 *  - ignored: the move is not legal from the current state (late or out-of-order event)
 * Throws NotFoundError if the booking does not exist.
 */
export async function transitionBooking(
  tx: Queryable,
  bookingId: string,
  to: BookingState,
  opts: {
    causeEventId: string;
    holdExpiresAt?: Date;
    cancelReason?: string;
    amountMinor?: number;
    currency?: string;
    /** Only apply from these states; any other current state is `ignored`. */
    onlyFrom?: BookingState[];
  },
): Promise<TransitionOutcome> {
  const { rows } = await tx.query<{ state: BookingState }>(
    'SELECT state FROM bookings WHERE id = $1 FOR UPDATE',
    [bookingId],
  );
  const current = rows[0]?.state;
  if (!current) throw new NotFoundError(`booking ${bookingId} not found`);
  if (current === to) return 'already';
  if (opts.onlyFrom && !opts.onlyFrom.includes(current)) return 'ignored';
  if (!canTransition(current, to)) return 'ignored';
  assertTransition(current, to);

  await tx.query(
    `UPDATE bookings
        SET state = $2, hold_expires_at = COALESCE($3, hold_expires_at),
            cancel_reason = COALESCE($4, cancel_reason),
            amount_minor = COALESCE($5, amount_minor), currency = COALESCE($6, currency),
            version = version + 1, updated_at = now()
      WHERE id = $1`,
    [
      bookingId,
      to,
      opts.holdExpiresAt ?? null,
      opts.cancelReason ?? null,
      opts.amountMinor ?? null,
      opts.currency ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO booking_transitions (booking_id, from_state, to_state, cause_event_id)
     VALUES ($1,$2,$3,$4)`,
    [bookingId, current, to, opts.causeEventId],
  );
  return 'applied';
}
