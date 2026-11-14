import {
  bookingCode,
  buildEnvelope,
  describeActivity,
  describeSeats,
  formatMoney,
  ticketCode,
} from '../src';

const env = (eventType: never, payload: object) =>
  buildEnvelope({ eventType, correlationId: 'bk-1', producer: 'x', payload } as never);

describe('bookingCode', () => {
  it('is stable, human-friendly and unambiguous', () => {
    expect(bookingCode('bk-1')).toBe(bookingCode('bk-1'));
    expect(bookingCode('bk-1')).toMatch(/^GP-[2-9A-HJ-NP-Z]{4}$/);
    expect(bookingCode('bk-1')).not.toBe(bookingCode('bk-2'));
    expect(ticketCode('bk-1', 'C6')).toBe(`${bookingCode('bk-1')}-C6`);
  });
});

describe('describeSeats / formatMoney', () => {
  it('groups by row and pluralises, like the design feed', () => {
    expect(describeSeats(['B8', 'B9'])).toBe('Row B · seats 8, 9');
    expect(describeSeats(['D2'])).toBe('Row D · seat 2');
    expect(describeSeats(['C3', 'B10', 'B2'])).toBe('Row B · seats 2, 10; Row C · seat 3');
  });
  it('formats rupees Indian style', () => {
    expect(formatMoney(240000n, 'INR')).toBe('₹2,400');
    expect(formatMoney(123456700, 'INR')).toBe('₹12,34,567');
    expect(formatMoney(1050, 'USD')).toBe('USD 10.5');
  });
});

describe('describeActivity', () => {
  it('describes the events the organizer feed shows', () => {
    const sold = describeActivity(
      env('seats.sold' as never, { bookingId: 'bk-1', eventId: 'ev', seatIds: ['B8', 'B9'] }),
    )!;
    expect(sold).toMatchObject({
      eventId: 'ev',
      bookingId: 'bk-1',
      type: 'seats.sold',
      text: 'Row B · seats 8, 9',
      failed: false,
    });
    expect(sold.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(
      describeActivity(
        env('payment.failed' as never, {
          bookingId: 'bk-1',
          paymentId: 'p',
          reason: 'card declined',
          eventId: 'ev',
          userId: 'u',
        }),
      ),
    ).toMatchObject({
      text: 'Payment failed · card declined',
      failed: true,
    });
    expect(
      describeActivity(
        env('ticket.issued' as never, {
          bookingId: 'bk-1',
          eventId: 'ev',
          userId: 'u',
          tickets: [{ ticketId: 't1' }, { ticketId: 't2' }],
        }),
      )!.text,
    ).toBe(`Booking ${bookingCode('bk-1')} · 2 tickets`);
    expect(
      describeActivity(
        env('hold.expired' as never, { bookingId: 'bk-1', eventId: 'ev', seatIds: ['D2'] }),
      )!.text,
    ).toBe('Row D · seat 2 returned to sale');
    expect(
      describeActivity(
        env('payment.succeeded' as never, {
          bookingId: 'bk-1',
          paymentId: 'p',
          amountMinor: 360000n,
          currency: 'INR',
          providerRef: 'r',
          eventId: 'ev',
        }),
      )!.text,
    ).toBe(`Payment received · ${bookingCode('bk-1')} · ₹3,600`);
  });

  it('describes refunds, and says nothing twice about an expiry', () => {
    expect(
      describeActivity(
        env('refund.requested' as never, {
          refundId: 'r',
          bookingId: 'bk-1',
          ticketId: 't',
          userId: 'u',
          amountMinor: 180000n,
          currency: 'INR',
          reason: '',
          eventId: 'ev',
          seatId: 'C6',
          organizerId: 'o',
        }),
      )!.text,
    ).toBe('Refund requested · Row C · seat 6');
    expect(
      describeActivity(
        env('refund.completed' as never, {
          refundId: 'r',
          bookingId: 'bk-1',
          paymentId: 'p',
          amountMinor: 240000n,
          currency: 'INR',
          eventId: 'ev',
          ticketId: 't',
          seatId: 'C6',
          userId: 'u',
          automatic: false,
        }),
      )!.text,
    ).toBe(`Booking ${bookingCode('bk-1')} · ₹2,400`);
    expect(
      describeActivity(
        env('seats.sale_failed' as never, {
          bookingId: 'bk-1',
          eventId: 'ev',
          seatIds: ['A1'],
          reason: 'hold_released',
        }),
      ),
    ).toMatchObject({ failed: true });
    expect(
      describeActivity(
        env('seats.released' as never, {
          bookingId: 'bk-1',
          eventId: 'ev',
          seatIds: ['A1'],
          reason: 'hold_expired',
        }),
      ),
    ).toBeNull();
    expect(
      describeActivity(
        env('seats.released' as never, {
          bookingId: 'bk-1',
          eventId: 'ev',
          seatIds: ['A1'],
          reason: 'refunded',
        }),
      )!.text,
    ).toBe('Row A · seat 1 returned to sale');
    expect(
      describeActivity(
        env('refund.approved' as never, {
          refundId: 'r',
          bookingId: 'bk-1',
          ticketId: 't',
          eventId: 'ev',
          seatId: 'A1',
          userId: 'u',
          amountMinor: 1n,
          currency: 'INR',
        }),
      ),
    ).toBeNull();
  });

  it('skips events that are not feed material or cannot be attributed to a show', () => {
    expect(
      describeActivity(
        env('booking.requested' as never, {
          bookingId: 'bk-1',
          eventId: 'ev',
          userId: 'u',
          seatIds: ['A1'],
        }),
      ),
    ).toBeNull();
    // a payment event without an event id (older producer) cannot be placed on a show's feed
    expect(
      describeActivity(
        env('payment.failed' as never, { bookingId: 'bk-1', paymentId: 'p', reason: 'x' }),
      ),
    ).toBeNull();
  });
});
