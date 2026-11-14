import type { EventPublisher, OutboundMessage } from '@gatepass/outbox';
import type { HandleOutcome, IncomingMessage } from '@gatepass/messaging';

type Subscriber = (message: IncomingMessage) => Promise<HandleOutcome | void>;

/**
 * An in-process stand-in for Kafka for saga tests. It is an EventPublisher (so the real
 * OutboxRelay writes to it) and delivers to subscribers that use the real message pipeline
 * (decode, retry, DLQ). Nothing is simulated except the network.
 */
export class InMemoryBroker implements EventPublisher {
  readonly published: OutboundMessage[] = [];
  private readonly subscribers: { topics: Set<string>; handle: Subscriber }[] = [];
  private offset = 0;
  /** Messages are delivered this many times each (use 2 to test duplicate delivery). */
  deliveries = 1;
  down = false;
  private delivered = 0;

  subscribe(topics: string[], handle: Subscriber): void {
    this.subscribers.push({ topics: new Set(topics), handle });
  }

  async publishBatch(messages: OutboundMessage[]): Promise<void> {
    if (this.down) throw new Error('broker unavailable');
    this.published.push(...messages);
  }

  /** Delivers everything published but not yet delivered, in order. Returns the count delivered. */
  async deliverPending(): Promise<number> {
    let count = 0;
    while (this.delivered < this.published.length) {
      const m = this.published[this.delivered++]!;
      for (const sub of this.subscribers) {
        if (!sub.topics.has(m.topic)) continue;
        for (let i = 0; i < this.deliveries; i++) {
          await sub.handle({
            topic: m.topic,
            partition: 0,
            offset: String(this.offset++),
            key: m.key,
            value: m.value,
            headers: m.headers,
          });
        }
      }
      count++;
    }
    return count;
  }
}
