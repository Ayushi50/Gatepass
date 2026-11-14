import { bookingCode } from './booking-code';
import type { EventEnvelope } from './gen/gatepass/events/v1/events_pb';

/** One line of the organizer's live feed (design/organizer.html). */
export interface ActivityItem {
  eventId: string;
  bookingId: string;
  type: string;
  text: string;
  /** Drawn in the "danger" colour. */
  failed: boolean;
  at: string; // ISO, server time of the event
}

/** "B8","B9","C3" -> "Row B · seats 8, 9; Row C · seat 3" */
export function describeSeats(seatIds: readonly string[]): string {
  const rows = new Map<string, number[]>();
  for (const id of seatIds) {
    const row = id.charAt(0);
    const list = rows.get(row) ?? [];
    list.push(Number(id.slice(1)));
    rows.set(row, list);
  }
  return [...rows]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([row, nums]) => {
      nums.sort((a, b) => a - b);
      return `Row ${row} · ${nums.length === 1 ? 'seat' : 'seats'} ${nums.join(', ')}`;
    })
    .join('; ');
}

export function formatMoney(amountMinor: bigint | number, currency: string): string {
  const major = Number(amountMinor) / 100;
  const text = major.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return currency === 'INR' ? `₹${text}` : `${currency} ${text}`;
}

/**
 * Turns a broker event into a feed line, or null if it is not worth showing (or cannot be
 * attributed to a show). Shared by analytics (stored feed) and the gateway (live stream), so
 * both always say the same thing.
 */
export function describeActivity(env: EventEnvelope): ActivityItem | null {
  const at = new Date(Number(env.occurredAtMs)).toISOString();
  const item = (
    eventId: string,
    bookingId: string,
    text: string,
    failed = false,
  ): ActivityItem | null =>
    eventId ? { eventId, bookingId, type: env.eventType, text, failed, at } : null;

  const p = env.payload;
  switch (p.case) {
    case 'seatsHeld':
      return item(p.value.eventId, p.value.bookingId, `${describeSeats(p.value.seatIds)} held`);
    case 'seatsSold':
      return item(p.value.eventId, p.value.bookingId, describeSeats(p.value.seatIds));
    case 'seatsReleased':
      return item(
        p.value.eventId,
        p.value.bookingId,
        `${describeSeats(p.value.seatIds)} returned to sale`,
      );
    case 'holdExpired':
      return item(
        p.value.eventId,
        p.value.bookingId,
        `${describeSeats(p.value.seatIds)} returned to sale`,
      );
    case 'seatsHoldFailed':
      return item(
        p.value.eventId,
        p.value.bookingId,
        `${describeSeats(p.value.seatIds)} unavailable`,
        true,
      );
    case 'paymentSucceeded':
      return item(
        p.value.eventId,
        p.value.bookingId,
        `Payment received · ${bookingCode(p.value.bookingId)} · ${formatMoney(p.value.amountMinor, p.value.currency)}`,
      );
    case 'paymentFailed':
      return item(
        p.value.eventId,
        p.value.bookingId,
        `Payment failed · ${p.value.reason || 'declined'}`,
        true,
      );
    case 'bookingConfirmed':
      return item(
        p.value.eventId,
        p.value.bookingId,
        `Booking ${bookingCode(p.value.bookingId)} confirmed`,
      );
    case 'bookingCancelled':
      return item(
        p.value.eventId,
        p.value.bookingId,
        `Booking ${bookingCode(p.value.bookingId)} cancelled · ${p.value.reason}`,
        true,
      );
    case 'ticketIssued': {
      const n = p.value.tickets.length;
      return item(
        p.value.eventId,
        p.value.bookingId,
        `Booking ${bookingCode(p.value.bookingId)} · ${n} ${n === 1 ? 'ticket' : 'tickets'}`,
      );
    }
    case 'ticketVoided':
      return item(
        p.value.eventId,
        p.value.bookingId,
        `Ticket ${p.value.seatId} voided · ${p.value.reason}`,
      );
    default:
      // event.published, booking.requested: not feed material. refund.*: carry no event id yet.
      return null;
  }
}
