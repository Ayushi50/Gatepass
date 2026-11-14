import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import type { EventPublisher, OutboundMessage } from '@gatepass/outbox';
import { LagMonitor, type AdminLike } from './lag';
import {
  createMessageHandler,
  type DeadLetterPublisher,
  type MessageHandlerOptions,
} from './handler';

export function createKafka(brokers: string[], clientId: string): Kafka {
  return new Kafka({ clientId, brokers, logLevel: logLevel.WARN });
}

const toHeaders = (headers: Record<string, string>) => headers;

/** Publishes to Kafka with an idempotent producer and acks=all. Used by the outbox relay. */
export class KafkaEventPublisher implements EventPublisher, DeadLetterPublisher {
  private readonly producer: Producer;
  private connected = false;

  constructor(kafka: Kafka) {
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
    this.connected = false;
  }

  async publishBatch(messages: OutboundMessage[]): Promise<void> {
    await this.connect();
    // kafkajs keeps per-partition order within one send; group by topic preserving relative order.
    const byTopic = new Map<string, OutboundMessage[]>();
    for (const m of messages) {
      const list = byTopic.get(m.topic) ?? [];
      list.push(m);
      byTopic.set(m.topic, list);
    }
    await this.producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic].map(([topic, list]) => ({
        topic,
        messages: list.map((m) => ({
          key: m.key,
          value: Buffer.from(m.value),
          headers: toHeaders(m.headers),
        })),
      })),
    });
  }

  async publish(
    topic: string,
    message: { key: string | null; value: Uint8Array | null; headers: Record<string, string> },
  ): Promise<void> {
    await this.connect();
    await this.producer.send({
      topic,
      acks: -1,
      messages: [
        {
          key: message.key,
          value: message.value ? Buffer.from(message.value) : null,
          headers: toHeaders(message.headers),
        },
      ],
    });
  }
}

/**
 * Consumer-group timing. A process killed without warning (kill -9, a crash, a node loss) is only
 * noticed when its session times out, and until then its partitions are not served by anyone, so a
 * shorter session means faster recovery (at the price of more rebalances on a slow network).
 * Defaults are kafkajs's; override with KAFKA_SESSION_TIMEOUT_MS / KAFKA_HEARTBEAT_INTERVAL_MS /
 * KAFKA_REBALANCE_TIMEOUT_MS.
 */
export function consumerTimingFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const n = (v: string | undefined) => (v ? Number(v) : undefined);
  return {
    sessionTimeout: n(env.KAFKA_SESSION_TIMEOUT_MS),
    heartbeatInterval: n(env.KAFKA_HEARTBEAT_INTERVAL_MS),
    rebalanceTimeout: n(env.KAFKA_REBALANCE_TIMEOUT_MS),
  };
}

export interface KafkaConsumerOptions extends Omit<MessageHandlerOptions, 'dlq'> {
  kafka: Kafka;
  topics: string[];
  dlq: DeadLetterPublisher;
  /** Start from the beginning when the group has no committed offset. Default true. */
  fromBeginning?: boolean;
}

/** A consumer group: decode, retry with backoff, dead-letter on exhaustion. */
export class KafkaEventConsumer {
  private readonly consumer: Consumer;

  constructor(private readonly opts: KafkaConsumerOptions) {
    const timing = consumerTimingFromEnv();
    this.consumer = opts.kafka.consumer({
      groupId: opts.groupId,
      ...(timing.sessionTimeout ? { sessionTimeout: timing.sessionTimeout } : {}),
      ...(timing.heartbeatInterval ? { heartbeatInterval: timing.heartbeatInterval } : {}),
      ...(timing.rebalanceTimeout ? { rebalanceTimeout: timing.rebalanceTimeout } : {}),
    });
  }

  private lag: LagMonitor | undefined;

  async start(): Promise<void> {
    const handle = createMessageHandler(this.opts);
    await this.consumer.connect();
    for (const topic of this.opts.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: this.opts.fromBeginning ?? true });
    }
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await handle({
          topic,
          partition,
          offset: message.offset,
          key: message.key ? message.key.toString() : null,
          value: message.value,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([k, v]) => [k, v ? v.toString() : '']),
          ),
        });
      },
    });

    // Report this group's lag and dead-letter depth. (The gateway's per-instance stream groups are
    // throwaway, so they are skipped: a series per instance would never stop growing.)
    if (!this.opts.groupId.startsWith('gateway-streams-')) {
      const admin = this.opts.kafka.admin();
      await admin.connect();
      this.lag = new LagMonitor(admin as unknown as AdminLike, this.opts.groupId, this.opts.topics);
      this.lag.start();
    }
  }

  async stop(): Promise<void> {
    this.lag?.stop();
    await this.consumer.disconnect();
  }
}
