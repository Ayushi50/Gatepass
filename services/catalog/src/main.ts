import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createPool, migrate, requireEnv } from '@gatepass/db';
import { KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import { OutboxRelay } from '@gatepass/outbox';
import { CatalogModule } from './http/catalog.module';
import { collectProcessMetrics, initTelemetry, mountTelemetry } from '@gatepass/telemetry';

async function main(): Promise<void> {
  initTelemetry('catalog'); // tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set
  collectProcessMetrics();
  const pool = createPool(requireEnv('DATABASE_URL'));
  await migrate(pool, join(__dirname, '..', 'migrations'));

  const publisher = new KafkaEventPublisher(
    createKafka(requireEnv('KAFKA_BROKERS').split(','), 'catalog'),
  );
  const relay = new OutboxRelay({
    pool,
    publisher,
    lockName: 'catalog-relay',
    onError: (e) => console.error('[catalog] outbox relay:', (e as Error).message),
  });
  relay.start();

  const app = await NestFactory.create(CatalogModule.forPool(pool));
  mountTelemetry(app, 'catalog');
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
  console.log(`[catalog] listening on ${process.env.PORT ?? 3001}`);
}

void main();
