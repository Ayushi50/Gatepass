import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
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
      jwtSecret: secret,
    }),
  );
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
  console.log(`[gateway] listening on ${process.env.PORT ?? 3000}`);
}

void main();
