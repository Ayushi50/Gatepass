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

  it('treats HELD and CANCELLED as terminal in this phase', () => {
    expect(isTerminal('HELD')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('REQUESTED')).toBe(false);
  });

  it('rejects every other move, including self-transitions and un-cancelling', () => {
    const states = Object.keys(TRANSITIONS) as BookingState[];
    const legal = new Set(['REQUESTED>HELD', 'REQUESTED>CANCELLED']);
    for (const from of states) {
      for (const to of states) {
        expect(canTransition(from, to)).toBe(legal.has(`${from}>${to}`));
      }
    }
    expect(() => assertTransition('CANCELLED', 'HELD')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('HELD', 'REQUESTED')).toThrow(/HELD -> REQUESTED/);
  });
});
