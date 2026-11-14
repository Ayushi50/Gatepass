import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { requireEnv } from '@gatepass/db';
import { KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import { HttpBookingClient, HttpCatalogClient, HttpInventoryClient } from './clients/clients';
import { GatewayModule } from './gateway.module';
import { SeatStreamHub } from './seat-stream/seat-stream';

async function main(): Promise<void> {
  const secret = requireEnv('JWT_SECRET');
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

  const hub = new SeatStreamHub();
  const kafka = createKafka(requireEnv('KAFKA_BROKERS').split(','), 'gateway');
  hub.startKafkaBridge(kafka, new KafkaEventPublisher(kafka));

  const app = await NestFactory.create(
    GatewayModule.forRoot({
      catalog: new HttpCatalogClient(requireEnv('CATALOG_URL')),
      inventory: new HttpInventoryClient(requireEnv('SEAT_INVENTORY_URL')),
      bookings: new HttpBookingClient(requireEnv('BOOKING_URL')),
      hub,
      jwtSecret: secret,
    }),
  );
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
  console.log(`[gateway] listening on ${process.env.PORT ?? 3000}`);
}

void main();
