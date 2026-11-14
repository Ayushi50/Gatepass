import { buildEnvelope } from '@gatepass/events';
import { salesStatus, toBookingUpdate, toSeatUpdates } from '../src';

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

describe('toBookingUpdate', () => {
  const at = (env: ReturnType<typeof buildEnvelope>) =>
    new Date(Number(env.occurredAtMs)).toISOString();

  it('maps each step the status page lights up, with the reason where there is one', () => {
    const cases = [
      buildEnvelope({
        eventType: 'seats.held',
        correlationId: 'b1',
        producer: 's',
        payload: { bookingId: 'b1', eventId: 'ev', seatIds: ['A1'], holdExpiresAtMs: 1n },
      }),
      buildEnvelope({
        eventType: 'payment.succeeded',
        correlationId: 'b1',
        producer: 'p',
        payload: {
          bookingId: 'b1',
          paymentId: 'p1',
          amountMinor: 1n,
          currency: 'INR',
          providerRef: 'r',
        },
      }),
      buildEnvelope({
        eventType: 'payment.failed',
        correlationId: 'b1',
        producer: 'p',
        payload: { bookingId: 'b1', paymentId: 'p1', reason: 'declined' },
      }),
      buildEnvelope({
        eventType: 'seats.released',
        correlationId: 'b1',
        producer: 's',
        payload: { bookingId: 'b1', eventId: 'ev', seatIds: ['A1'], reason: 'payment_failed' },
      }),
      buildEnvelope({
        eventType: 'seats.sold',
        correlationId: 'b1',
        producer: 's',
        payload: { bookingId: 'b1', eventId: 'ev', seatIds: ['A1'] },
      }),
      buildEnvelope({
        eventType: 'booking.confirmed',
        correlationId: 'b1',
        producer: 'b',
        payload: {
          bookingId: 'b1',
          eventId: 'ev',
          userId: 'u',
          seatIds: ['A1'],
          amountMinor: 1n,
          currency: 'INR',
        },
      }),
      buildEnvelope({
        eventType: 'booking.cancelled',
        correlationId: 'b1',
        producer: 'b',
        payload: { bookingId: 'b1', eventId: 'ev', reason: 'payment_failed' },
      }),
      buildEnvelope({
        eventType: 'ticket.issued',
        correlationId: 'b1',
        producer: 't',
        payload: { bookingId: 'b1', eventId: 'ev', userId: 'u', tickets: [] },
      }),
    ];
    expect(cases.map((e) => toBookingUpdate(e))).toEqual([
      { bookingId: 'b1', type: 'seats.held', at: at(cases[0]!) },
      { bookingId: 'b1', type: 'payment.succeeded', at: at(cases[1]!) },
      { bookingId: 'b1', type: 'payment.failed', reason: 'declined', at: at(cases[2]!) },
      { bookingId: 'b1', type: 'seats.released', reason: 'payment_failed', at: at(cases[3]!) },
      { bookingId: 'b1', type: 'seats.sold', at: at(cases[4]!) },
      { bookingId: 'b1', type: 'booking.confirmed', at: at(cases[5]!) },
      { bookingId: 'b1', type: 'booking.cancelled', reason: 'payment_failed', at: at(cases[6]!) },
      { bookingId: 'b1', type: 'ticket.issued', at: at(cases[7]!) },
    ]);
  });

  it("ignores events that are not part of a booking's progress", () => {
    const e = buildEnvelope({
      eventType: 'booking.requested',
      correlationId: 'b1',
      producer: 'b',
      payload: { bookingId: 'b1', eventId: 'ev', userId: 'u', seatIds: ['A1'] },
    });
    expect(toBookingUpdate(e)).toBeNull();
  });
});
