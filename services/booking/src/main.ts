import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createPool, migrate, requireEnv } from '@gatepass/db';
import { KafkaEventConsumer, KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import { OutboxRelay } from '@gatepass/outbox';
import { CONSUMED_TOPICS, CONSUMER_GROUP, bookingHandler } from './handlers';
import { BookingModule } from './http/booking.module';

async function main(): Promise<void> {
  const pool = createPool(requireEnv('DATABASE_URL'));
  await migrate(pool, join(__dirname, '..', 'migrations'));

  const kafka = createKafka(requireEnv('KAFKA_BROKERS').split(','), 'booking');
  const publisher = new KafkaEventPublisher(kafka);
  const relay = new OutboxRelay({
    pool,
    publisher,
    lockName: 'booking-relay',
    onError: (e) => console.error('[booking] outbox relay:', (e as Error).message),
  });
  relay.start();

  const handle = bookingHandler(pool);
  const consumer = new KafkaEventConsumer({
    kafka,
    groupId: CONSUMER_GROUP,
    topics: CONSUMED_TOPICS,
    dlq: publisher,
    handle: (env) => handle(env),
  });
  await consumer.start();

  const app = await NestFactory.create(BookingModule.forPool(pool));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3003));
  console.log(`[booking] listening on ${process.env.PORT ?? 3003}`);
}

void main();
