import {
  IllegalTransitionError,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
  type BookingState,
} from '../src';

describe('booking state machine', () => {
  it('allows REQUESTED -> HELD and REQUESTED -> CANCELLED', () => {
    expect(canTransition('REQUESTED', 'HELD')).toBe(true);
    expect(canTransition('REQUESTED', 'CANCELLED')).toBe(true);
  });

  it('allows the payment path HELD -> PAID -> CONFIRMED, and HELD -> CONFIRMED when seats.sold overtakes', () => {
    expect(canTransition('HELD', 'PAID')).toBe(true);
    expect(canTransition('PAID', 'CONFIRMED')).toBe(true);
    expect(canTransition('HELD', 'CONFIRMED')).toBe(true);
  });

  it('allows HELD -> CANCELLED (payment failed) but never cancels a paid or confirmed booking', () => {
    expect(canTransition('HELD', 'CANCELLED')).toBe(true);
    expect(canTransition('PAID', 'CANCELLED')).toBe(false);
    expect(canTransition('CONFIRMED', 'CANCELLED')).toBe(false);
  });

  it('treats CONFIRMED and CANCELLED as terminal', () => {
    expect(isTerminal('CONFIRMED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('HELD')).toBe(false);
    expect(isTerminal('PAID')).toBe(false);
  });

  it('rejects every other move, including self-transitions and un-cancelling', () => {
    const states = Object.keys(TRANSITIONS) as BookingState[];
    const legal = new Set([
      'REQUESTED>HELD',
      'REQUESTED>CANCELLED',
      'HELD>PAID',
      'HELD>CONFIRMED',
      'HELD>CANCELLED',
      'PAID>CONFIRMED',
    ]);
    for (const from of states) {
      for (const to of states) {
        expect(canTransition(from, to)).toBe(legal.has(`${from}>${to}`));
      }
    }
    expect(() => assertTransition('CANCELLED', 'HELD')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('HELD', 'REQUESTED')).toThrow(/HELD -> REQUESTED/);
  });
});
