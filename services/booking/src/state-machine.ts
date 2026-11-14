/**
 * The booking saga as an explicit state machine. The current state lives in the `bookings`
 * table (persisted, so the saga resumes after a crash) and every change is recorded in
 * `booking_transitions`. Later phases add states (PAID, CONFIRMED, REFUNDED, ...) here.
 */
export type BookingState = 'REQUESTED' | 'HELD' | 'CANCELLED';

export const TRANSITIONS: Readonly<Record<BookingState, readonly BookingState[]>> = {
  REQUESTED: ['HELD', 'CANCELLED'],
  HELD: [],
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
