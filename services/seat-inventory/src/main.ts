import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createPool, migrate, requireEnv } from '@gatepass/db';
import { KafkaEventConsumer, KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import { OutboxRelay } from '@gatepass/outbox';
import { HoldSweeper } from './expiry';
import { CONSUMED_TOPICS, CONSUMER_GROUP, seatInventoryHandler } from './handlers';
import { InventoryModule } from './http/inventory.module';

async function main(): Promise<void> {
  const pool = createPool(requireEnv('DATABASE_URL'), 20);
  await migrate(pool, join(__dirname, '..', 'migrations'));

  const kafka = createKafka(requireEnv('KAFKA_BROKERS').split(','), 'seat-inventory');
  const publisher = new KafkaEventPublisher(kafka);
  const relay = new OutboxRelay({
    pool,
    publisher,
    lockName: 'seat-inventory-relay',
    onError: (e) => console.error('[seat-inventory] outbox relay:', (e as Error).message),
  });
  relay.start();

  new HoldSweeper(pool, {
    intervalMs: Number(process.env.HOLD_SWEEP_INTERVAL_MS ?? 1000),
    graceMs: Number(process.env.HOLD_GRACE_MS ?? 60_000),
    onError: (e) => console.error('[seat-inventory] hold sweeper:', (e as Error).message),
  }).start();

  const handle = seatInventoryHandler(pool, {
    holdTtlMs: process.env.HOLD_TTL_MS ? Number(process.env.HOLD_TTL_MS) : undefined,
  });
  const consumer = new KafkaEventConsumer({
    kafka,
    groupId: CONSUMER_GROUP,
    topics: CONSUMED_TOPICS,
    dlq: publisher,
    handle: (env) => handle(env),
  });
  await consumer.start();

  const app = await NestFactory.create(InventoryModule.forPool(pool));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3002));
  console.log(`[seat-inventory] listening on ${process.env.PORT ?? 3002}`);
}

void main();
