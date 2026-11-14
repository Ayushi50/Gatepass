import { Injectable } from '@nestjs/common';
import { Subject, filter, type Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import type { EventEnvelope } from '@gatepass/events';
import { KafkaEventConsumer, type DeadLetterPublisher } from '@gatepass/messaging';
import type { Kafka } from 'kafkajs';

/** What the seat map UI needs (design/seats.html): `{seatId, state}`. */
export interface SeatUpdate {
  eventId: string;
  seatId: string;
  state: 'available' | 'held' | 'taken';
}

export const SEAT_TOPICS = ['seats.held', 'seats.released', 'seats.sold', 'hold.expired'];

/** Pure mapping from a broker event to seat-map updates. Unrelated events yield nothing. */
export function toSeatUpdates(env: EventEnvelope): SeatUpdate[] {
  const p = env.payload;
  switch (p.case) {
    case 'seatsHeld':
      return p.value.seatIds.map((seatId) => ({ eventId: p.value.eventId, seatId, state: 'held' }));
    case 'seatsReleased':
      return p.value.seatIds.map((seatId) => ({
        eventId: p.value.eventId,
        seatId,
        state: 'available',
      }));
    case 'holdExpired':
      return p.value.seatIds.map((seatId) => ({
        eventId: p.value.eventId,
        seatId,
        state: 'available',
      }));
    case 'seatsSold':
      return p.value.seatIds.map((seatId) => ({
        eventId: p.value.eventId,
        seatId,
        state: 'taken',
      }));
    default:
      return [];
  }
}

/** In-process fan-out from Kafka to every connected browser. */
@Injectable()
export class SeatStreamHub {
  private readonly updates = new Subject<SeatUpdate>();

  publish(update: SeatUpdate): void {
    this.updates.next(update);
  }

  stream(eventId: string): Observable<SeatUpdate> {
    return this.updates.pipe(filter((u) => u.eventId === eventId));
  }

  /** Number of live subscribers (for tests and metrics). */
  get observers(): number {
    return this.updates.observers.length;
  }

  mapAll(env: EventEnvelope): SeatUpdate[] {
    return toSeatUpdates(env);
  }

  complete(): void {
    this.updates.complete();
  }
}

/** One step of a booking, as the status page needs it. */
export interface BookingUpdate {
  bookingId: string;
  type:
    | 'seats.held'
    | 'seats.sold'
    | 'seats.released'
    | 'payment.succeeded'
    | 'payment.failed'
    | 'booking.confirmed'
    | 'booking.cancelled';
  reason?: string;
  at: string; // ISO, server time of the event
}

export const BOOKING_TOPICS = [
  'seats.held',
  'seats.sold',
  'seats.released',
  'payment.succeeded',
  'payment.failed',
  'booking.confirmed',
  'booking.cancelled',
];

/** Pure mapping from a broker event to a booking status update; null if it is not one. */
export function toBookingUpdate(env: EventEnvelope): BookingUpdate | null {
  const at = new Date(Number(env.occurredAtMs)).toISOString();
  const p = env.payload;
  switch (p.case) {
    case 'seatsHeld':
      return { bookingId: p.value.bookingId, type: 'seats.held', at };
    case 'seatsSold':
      return { bookingId: p.value.bookingId, type: 'seats.sold', at };
    case 'seatsReleased':
      return { bookingId: p.value.bookingId, type: 'seats.released', reason: p.value.reason, at };
    case 'paymentSucceeded':
      return { bookingId: p.value.bookingId, type: 'payment.succeeded', at };
    case 'paymentFailed':
      return { bookingId: p.value.bookingId, type: 'payment.failed', reason: p.value.reason, at };
    case 'bookingConfirmed':
      return { bookingId: p.value.bookingId, type: 'booking.confirmed', at };
    case 'bookingCancelled':
      return {
        bookingId: p.value.bookingId,
        type: 'booking.cancelled',
        reason: p.value.reason,
        at,
      };
    default:
      return null;
  }
}

/** In-process fan-out of booking progress to the browsers watching a booking. */
@Injectable()
export class BookingStreamHub {
  private readonly updates = new Subject<BookingUpdate>();

  publish(update: BookingUpdate): void {
    this.updates.next(update);
  }

  stream(bookingId: string): Observable<BookingUpdate> {
    return this.updates.pipe(filter((u) => u.bookingId === bookingId));
  }

  get observers(): number {
    return this.updates.observers.length;
  }
}

/**
 * The Kafka -> SSE bridge. ONE consumer feeds both hubs. Every gateway instance uses its own
 * consumer group, so every instance sees every event and can serve its own browsers. Only new
 * events matter (initial state comes from REST), so it starts at the end of the topics.
 */
export function startStreamBridge(
  kafka: Kafka,
  dlq: DeadLetterPublisher,
  seats: SeatStreamHub,
  bookings: BookingStreamHub,
): KafkaEventConsumer {
  const consumer = new KafkaEventConsumer({
    kafka,
    groupId: `gateway-streams-${uuidv4()}`,
    topics: [...new Set([...SEAT_TOPICS, ...BOOKING_TOPICS])],
    fromBeginning: false,
    dlq,
    handle: async (env) => {
      for (const u of toSeatUpdates(env)) seats.publish(u);
      const b = toBookingUpdate(env);
      if (b) bookings.publish(b);
    },
  });
  void consumer.start();
  return consumer;
}
