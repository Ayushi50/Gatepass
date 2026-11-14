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

  /**
   * Starts the Kafka bridge. Every gateway instance uses its own consumer group, so every
   * instance sees every event and can serve its own browsers. Only new events matter here
   * (initial state comes from the REST call), so it starts at the end of the topics.
   */
  startKafkaBridge(kafka: Kafka, dlq: DeadLetterPublisher): KafkaEventConsumer {
    const consumer = new KafkaEventConsumer({
      kafka,
      groupId: `gateway-seat-stream-${uuidv4()}`,
      topics: SEAT_TOPICS,
      fromBeginning: false,
      dlq,
      handle: async (env) => {
        for (const u of toSeatUpdates(env)) this.publish(u);
      },
    });
    void consumer.start();
    return consumer;
  }
}
