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
import type { PaymentsConfig } from './http/payments-config.controller';
import { RateLimiter, rateLimitMiddleware } from './rate-limit/rate-limit';
import { WaitingRoom, WaitingRoomAdmitter } from './waiting-room/waiting-room';
import {
  ActivityStreamHub,
  BookingStreamHub,
  SeatStreamHub,
  startStreamBridge,
} from './seat-stream/seat-stream';
import {
  collectProcessMetrics,
  collectedGauge,
  initTelemetry,
  mountTelemetry,
} from '@gatepass/telemetry';

async function main(): Promise<void> {
  initTelemetry('gateway'); // tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set
  collectProcessMetrics();
  const secret = requireEnv('JWT_SECRET');
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

  const devLogin = process.env.ENABLE_DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production';
  if (devLogin)
    console.warn(
      '[gateway] DEMO SIGN-IN IS ON (ENABLE_DEV_LOGIN=true): anyone can get a token. Never use this in production.',
    );

  const list = (v?: string) =>
    (v ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  const google = process.env.GOOGLE_CLIENT_ID
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
        redirectUri: requireEnv('GOOGLE_REDIRECT_URI'),
        organizerEmails: list(process.env.ORGANIZER_EMAILS),
        doorStaffEmails: list(process.env.DOOR_STAFF_EMAILS),
      }
    : undefined;
  if (google) console.log('[gateway] Google sign-in is on');

  const paymentsConfig: PaymentsConfig =
    process.env.PAYMENT_PROVIDER === 'stripe'
      ? { provider: 'stripe', publishableKey: requireEnv('STRIPE_PUBLISHABLE_KEY') }
      : { provider: 'fake' };
  if (paymentsConfig.provider === 'stripe' && !paymentsConfig.publishableKey.startsWith('pk_test_'))
    throw new Error('STRIPE_PUBLISHABLE_KEY must be a test key (pk_test_...)');

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

  collectedGauge(
    'gatepass_waiting_room_queue_length',
    'People waiting, per show.',
    ['event'],
    async (g) => {
      g.reset();
      for (const event of await waitingRoom.activeEvents())
        g.set({ event }, await waitingRoom.queueLength(event));
    },
  );

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
      devLogin,
      google,
      paymentsConfig,
    }),
  );
  mountTelemetry(app, 'gateway');
  app.use(
    rateLimitMiddleware(
      new RateLimiter(redis, {
        onError: (e) => console.error('[gateway] rate limiter:', (e as Error).message),
      }),
      {
        perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 300),
        signInsPerMinute: Number(process.env.RATE_LIMIT_SIGNINS_PER_MINUTE ?? 20),
      },
    ),
  );
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
  console.log(`[gateway] listening on ${process.env.PORT ?? 3000}`);
}

void main();
