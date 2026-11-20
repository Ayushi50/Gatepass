import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createPool, migrate, requireEnv } from '@gatepass/db';
import { KafkaEventConsumer, KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import { OutboxRelay } from '@gatepass/outbox';
import { CONSUMED_TOPICS, CONSUMER_GROUP, ticketHandler } from './handlers';
import { TicketModule } from './http/ticket.module';
import { QrKeyRing } from './qr-token';
import {
  collectProcessMetrics,
  initTelemetry,
  mountInternalAuth,
  mountTelemetry,
} from '@gatepass/telemetry';

async function main(): Promise<void> {
  initTelemetry('ticket'); // tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set
  collectProcessMetrics();
  const keys = new QrKeyRing(requireEnv('TICKET_SIGNING_KEYS'));
  const pool = createPool(requireEnv('DATABASE_URL'), 20);
  await migrate(pool, join(__dirname, '..', 'migrations'));

  const kafka = createKafka(requireEnv('KAFKA_BROKERS').split(','), 'ticket');
  const publisher = new KafkaEventPublisher(kafka);
  new OutboxRelay({
    pool,
    publisher,
    lockName: 'ticket-relay',
    onError: (e) => console.error('[ticket] outbox relay:', (e as Error).message),
  }).start();

  const handle = ticketHandler(pool, keys);
  await new KafkaEventConsumer({
    kafka,
    groupId: CONSUMER_GROUP,
    topics: CONSUMED_TOPICS,
    dlq: publisher,
    handle: (env) => handle(env),
  }).start();

  const app = await NestFactory.create(TicketModule.forDeps(pool, keys));
  mountTelemetry(app, 'ticket');
  mountInternalAuth(app);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3005));
  console.log(`[ticket] listening on ${process.env.PORT ?? 3005}`);
}

void main();
