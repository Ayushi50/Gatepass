import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Redis } from 'ioredis';
import { requireEnv } from '@gatepass/db';
import { KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import {
  HttpBookingClient,
  HttpAnalyticsClient,
  HttpCatalogClient,
  HttpInventoryClient,
  HttpPaymentClient,
  HttpTicketClient,
} from './clients/clients';
import { GatewayModule } from './gateway.module';
import { WaitingRoom, WaitingRoomAdmitter } from './waiting-room/waiting-room';
import {
  ActivityStreamHub,
  BookingStreamHub,
  SeatStreamHub,
  startStreamBridge,
} from './seat-stream/seat-stream';

async function main(): Promise<void> {
  const secret = requireEnv('JWT_SECRET');
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

  const hub = new SeatStreamHub();
  const kafka = createKafka(requireEnv('KAFKA_BROKERS').split(','), 'gateway');
  const bookingHub = new BookingStreamHub();
  const activityHub = new ActivityStreamHub();
  startStreamBridge(kafka, new KafkaEventPublisher(kafka), hub, bookingHub, activityHub);

  const redis = new Redis(requireEnv('REDIS_URL'));
  const waitingRoom = new WaitingRoom(redis, {
    admitPerSecond: Number(process.env.WAITING_ROOM_ADMIT_PER_SECOND ?? 5),
    admissionTtlSeconds: Number(process.env.WAITING_ROOM_ADMISSION_TTL_SECONDS ?? 300),
  });
  new WaitingRoomAdmitter(waitingRoom, {
    onError: (e) => console.error('[gateway] waiting room admitter:', (e as Error).message),
  }).start();

  const app = await NestFactory.create(
    GatewayModule.forRoot({
      catalog: new HttpCatalogClient(requireEnv('CATALOG_URL')),
      inventory: new HttpInventoryClient(requireEnv('SEAT_INVENTORY_URL')),
      bookings: new HttpBookingClient(requireEnv('BOOKING_URL')),
      payments: new HttpPaymentClient(requireEnv('PAYMENT_URL')),
      tickets: new HttpTicketClient(requireEnv('TICKET_URL')),
      analytics: new HttpAnalyticsClient(requireEnv('ANALYTICS_URL')),
      hub,
      bookingHub,
      activityHub,
      waitingRoom,
      jwtSecret: secret,
    }),
  );
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
  console.log(`[gateway] listening on ${process.env.PORT ?? 3000}`);
}

void main();
