import { buildEnvelope, encodeEnvelope, type EventEnvelope } from '@gatepass/events';
import { OutboxRelay, appendToOutbox, applyOutboxMigrations } from '@gatepass/outbox';
import {
  createTestDatabase,
  startTestBroker,
  type TestBroker,
  type TestDatabase,
} from '@gatepass/testing';
import { KafkaEventConsumer, KafkaEventPublisher, createKafka } from '../src';

// Requires Docker (Testcontainers): Redpanda + Postgres.
jest.setTimeout(240_000);

let broker: TestBroker;
let db: TestDatabase;
let publisher: KafkaEventPublisher;

const fast = { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 };

const held = (bookingId: string) =>
  buildEnvelope({
    eventType: 'seats.held',
    payload: { bookingId, eventId: 'e-1', seatIds: ['A1'], holdExpiresAtMs: 1n },
    correlationId: bookingId,
    producer: 'seat-inventory',
  });

async function waitFor(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  broker = await startTestBroker();
  db = await createTestDatabase();
  await applyOutboxMigrations(db.pool);
  publisher = new KafkaEventPublisher(createKafka(broker.brokers, 'it-publisher'));
  await publisher.connect();
});

afterAll(async () => {
  await publisher?.disconnect();
  await db?.close();
  await broker?.stop();
});

describe('outbox -> Kafka -> consumer', () => {
  it('delivers an outbox event with envelope, key and headers intact', async () => {
    const received: EventEnvelope[] = [];
    const consumer = new KafkaEventConsumer({
      kafka: createKafka(broker.brokers, 'it-consumer'),
      groupId: 'it-happy',
      topics: ['seats.held'],
      dlq: publisher,
      retry: fast,
      handle: async (env) => {
        received.push(env);
      },
    });
    await consumer.start();

    const ev = held('b-1');
    await appendToOutbox(db.pool, ev, 'b-1');
    const relay = new OutboxRelay({ pool: db.pool, publisher });
    expect(await relay.pollOnce()).toBe(1);

    await waitFor(() => received.length === 1);
    expect(received[0]!.eventId).toBe(ev.eventId);
    expect(received[0]!.correlationId).toBe('b-1');
    await consumer.stop();
  });
});

describe('dead-letter queue', () => {
  it('moves a poison message to <group>.dlq after retries, and keeps consuming', async () => {
    const handled: string[] = [];
    const consumer = new KafkaEventConsumer({
      kafka: createKafka(broker.brokers, 'it-consumer-2'),
      groupId: 'it-poison',
      topics: ['seats.sold'],
      dlq: publisher,
      retry: fast,
      handle: async (env) => {
        if (env.correlationId === 'bad') throw new Error('cannot process');
        handled.push(env.correlationId);
      },
    });
    await consumer.start();

    const dlqMessages: { headers: Record<string, string> }[] = [];
    const dlqConsumer = new KafkaEventConsumer({
      kafka: createKafka(broker.brokers, 'it-dlq-reader'),
      groupId: 'it-dlq-reader',
      topics: ['it-poison.dlq'],
      dlq: publisher,
      retry: fast,
      handle: async (_env, msg) => {
        dlqMessages.push({ headers: msg.headers });
      },
    });
    await dlqConsumer.start();

    const sold = (id: string) =>
      encodeEnvelope(
        buildEnvelope({
          eventType: 'seats.sold',
          payload: { bookingId: id, eventId: 'e-1', seatIds: ['A1'] },
          correlationId: id,
          producer: 'seat-inventory',
        }),
      );
    for (const id of ['bad', 'good']) {
      await publisher.publish('seats.sold', { key: id, value: sold(id), headers: {} });
    }

    await waitFor(() => handled.includes('good') && dlqMessages.length === 1);
    expect(dlqMessages[0]!.headers['x-dlq-consumer']).toBe('it-poison');
    expect(dlqMessages[0]!.headers['x-dlq-original-topic']).toBe('seats.sold');
    await consumer.stop();
    await dlqConsumer.stop();
  });
});
