/**
 * The booking saga as an explicit state machine. The current state lives in the `bookings`
 * table (persisted, so the saga resumes after a crash) and every change is recorded in
 * `booking_transitions`. Later phases add states (REFUNDED, ...) here.
 */
export type BookingState = 'REQUESTED' | 'HELD' | 'PAID' | 'CONFIRMED' | 'CANCELLED';

export const TRANSITIONS: Readonly<Record<BookingState, readonly BookingState[]>> = {
  // REQUESTED -> PAID / CONFIRMED exist because events from different topics have no common order:
  // after a dead-letter replay, or just a slow consumer, payment.succeeded or seats.sold can be seen
  // before seats.held. The handlers apply each fact whenever it arrives (see handlers.ts).
  REQUESTED: ['HELD', 'PAID', 'CONFIRMED', 'CANCELLED'],
  // HELD -> CONFIRMED exists because seats.sold (a different topic) can overtake payment.succeeded
  HELD: ['PAID', 'CONFIRMED', 'CANCELLED'],
  // PAID -> CANCELLED exists for ONE case: the hold was released (expired) before the sale happened,
  // so the payment is refunded instead. See onSeatsReleased for the guard.
  PAID: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: BookingState,
    public readonly to: BookingState,
  ) {
    super(`illegal booking transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export const canTransition = (from: BookingState, to: BookingState): boolean =>
  TRANSITIONS[from].includes(to);

export function assertTransition(from: BookingState, to: BookingState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export const isTerminal = (state: BookingState): boolean => TRANSITIONS[state].length === 0;
