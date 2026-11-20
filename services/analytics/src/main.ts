import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createPool, migrate, requireEnv } from '@gatepass/db';
import { KafkaEventConsumer, KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import { CONSUMED_TOPICS, CONSUMER_GROUP, analyticsHandler } from './handlers';
import { AnalyticsModule } from './http/analytics.module';
import {
  collectProcessMetrics,
  initTelemetry,
  mountInternalAuth,
  mountTelemetry,
} from '@gatepass/telemetry';

async function main(): Promise<void> {
  initTelemetry('analytics'); // tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set
  collectProcessMetrics();
  const pool = createPool(requireEnv('DATABASE_URL'), 20);
  await migrate(pool, join(__dirname, '..', 'migrations'));

  const kafka = createKafka(requireEnv('KAFKA_BROKERS').split(','), 'analytics');
  const handle = analyticsHandler(pool);
  await new KafkaEventConsumer({
    kafka,
    groupId: CONSUMER_GROUP,
    topics: CONSUMED_TOPICS,
    dlq: new KafkaEventPublisher(kafka),
    handle: (env) => handle(env),
  }).start();

  const app = await NestFactory.create(AnalyticsModule.forPool(pool));
  mountTelemetry(app, 'analytics');
  mountInternalAuth(app);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3007));
  console.log(`[analytics] listening on ${process.env.PORT ?? 3007}`);
}

void main();
