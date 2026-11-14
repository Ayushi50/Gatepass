import { join } from 'node:path';
import { createPool, migrate, requireEnv } from '@gatepass/db';
import { KafkaEventConsumer, KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import { CONSUMED_TOPICS, CONSUMER_GROUP, notificationHandler } from './handlers';
import { collectProcessMetrics, initTelemetry, startMetricsServer } from '@gatepass/telemetry';

/** A consumer-only worker: no HTTP, no outbox. Failed messages go to `notification.dlq`. */
async function main(): Promise<void> {
  initTelemetry('notification');
  collectProcessMetrics();
  startMetricsServer(Number(process.env.METRICS_PORT ?? 3006));
  const pool = createPool(requireEnv('DATABASE_URL'));
  await migrate(pool, join(__dirname, '..', 'migrations'));

  const kafka = createKafka(requireEnv('KAFKA_BROKERS').split(','), 'notification');
  const handle = notificationHandler(pool);
  await new KafkaEventConsumer({
    kafka,
    groupId: CONSUMER_GROUP,
    topics: CONSUMED_TOPICS,
    dlq: new KafkaEventPublisher(kafka),
    handle: (env) => handle(env),
  }).start();
  console.log('[notification] consuming', CONSUMED_TOPICS.join(', '));
}

void main();
