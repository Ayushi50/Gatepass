import { buildEnvelope } from '@gatepass/events';
import { salesStatus, toSeatUpdates } from '../src';

const env = (eventType: 'seats.held' | 'seats.released' | 'seats.sold' | 'hold.expired') =>
  buildEnvelope({
    eventType,
    correlationId: 'b1',
    producer: 'seat-inventory',
    payload:
      eventType === 'seats.held'
        ? { bookingId: 'b1', eventId: 'ev', seatIds: ['A1', 'A2'], holdExpiresAtMs: 1n }
        : { bookingId: 'b1', eventId: 'ev', seatIds: ['A1', 'A2'] },
  });

describe('toSeatUpdates', () => {
  it('maps broker events to the seat-map states the UI draws', () => {
    expect(toSeatUpdates(env('seats.held'))).toEqual([
      { eventId: 'ev', seatId: 'A1', state: 'held' },
      { eventId: 'ev', seatId: 'A2', state: 'held' },
    ]);
    expect(toSeatUpdates(env('seats.released')).map((u) => u.state)).toEqual([
      'available',
      'available',
    ]);
    expect(toSeatUpdates(env('hold.expired')).map((u) => u.state)).toEqual([
      'available',
      'available',
    ]);
    expect(toSeatUpdates(env('seats.sold')).map((u) => u.state)).toEqual(['taken', 'taken']);
  });

  it('ignores events that do not change a seat', () => {
    const cancelled = buildEnvelope({
      eventType: 'booking.cancelled',
      correlationId: 'b1',
      producer: 'booking',
      payload: { bookingId: 'b1', eventId: 'ev', reason: 'hold_failed' },
    });
    expect(toSeatUpdates(cancelled)).toEqual([]);
  });
});

describe('salesStatus', () => {
  it('derives the status shown on the show list', () => {
    expect(salesStatus(84, 84)).toBe('available');
    expect(salesStatus(84, 40)).toBe('available');
    expect(salesStatus(84, 33)).toBe('selling_fast'); // <= 40% left
    expect(salesStatus(84, 1)).toBe('selling_fast');
    expect(salesStatus(84, 0)).toBe('sold_out');
    expect(salesStatus(0, 0)).toBe('unavailable');
  });
});
