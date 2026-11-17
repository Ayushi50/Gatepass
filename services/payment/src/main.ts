import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createPool, migrate, requireEnv } from '@gatepass/db';
import { KafkaEventConsumer, KafkaEventPublisher, createKafka } from '@gatepass/messaging';
import { OutboxRelay } from '@gatepass/outbox';
import { CONSUMED_TOPICS, CONSUMER_GROUP, paymentHandler } from './handlers';
import { PaymentModule } from './http/payment.module';
import { FAKE_SIGNATURE_HEADER, FakeProvider } from './providers/fake-provider';
import type { PaymentProvider } from './providers/provider';
import { RazorpayTestProvider } from './providers/razorpay-provider';
import { StripeTestProvider } from './providers/stripe-provider';
import {
  collectProcessMetrics,
  initTelemetry,
  metrics,
  mountTelemetry,
  startAtZero,
} from '@gatepass/telemetry';

function buildProvider(port: number): PaymentProvider {
  const kind = requireEnv('PAYMENT_PROVIDER');
  if (kind === 'razorpay') {
    return new RazorpayTestProvider({
      keyId: requireEnv('RAZORPAY_KEY_ID'),
      keySecret: requireEnv('RAZORPAY_KEY_SECRET'),
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? randomBytes(32).toString('hex'), // unset: nothing can pass the signature check
    });
  }
  if (kind === 'stripe') {
    return new StripeTestProvider({
      secretKey: requireEnv('STRIPE_SECRET_KEY'),
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? randomBytes(32).toString('hex'), // unset: nothing can pass the signature check,
    });
  }
  if (kind === 'fake') {
    const delay = Number(process.env.FAKE_AUTO_WEBHOOK_MS ?? 0);
    return new FakeProvider({
      webhookSecret: requireEnv('FAKE_WEBHOOK_SECRET'),
      autoWebhook:
        delay > 0
          ? {
              delayMs: delay,
              deliver: async (body, headers) => {
                await fetch(`http://127.0.0.1:${port}/webhooks/fake`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    [FAKE_SIGNATURE_HEADER]: headers[FAKE_SIGNATURE_HEADER]!,
                  },
                  body,
                });
              },
            }
          : undefined,
    });
  }
  throw new Error(`PAYMENT_PROVIDER must be "fake", "razorpay" or "stripe", got "${kind}"`);
}

async function main(): Promise<void> {
  initTelemetry('payment'); // tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set
  collectProcessMetrics();
  startAtZero(
    metrics.paymentsFinished(),
    ['succeeded', 'failed'].map((outcome) => ({ outcome })),
  );
  for (const outcome of ['succeeded', 'failed']) metrics.paymentDuration().zero({ outcome });
  startAtZero(
    metrics.refundsCompleted(),
    ['automatic', 'approved'].map((kind) => ({ kind })),
  );
  const port = Number(process.env.PORT ?? 3004);
  const pool = createPool(requireEnv('DATABASE_URL'));
  await migrate(pool, join(__dirname, '..', 'migrations'));
  const provider = buildProvider(port);

  const kafka = createKafka(requireEnv('KAFKA_BROKERS').split(','), 'payment');
  const publisher = new KafkaEventPublisher(kafka);
  new OutboxRelay({
    pool,
    publisher,
    lockName: 'payment-relay',
    onError: (e) => console.error('[payment] outbox relay:', (e as Error).message),
  }).start();

  const handle = paymentHandler(pool, provider);
  await new KafkaEventConsumer({
    kafka,
    groupId: CONSUMER_GROUP,
    topics: CONSUMED_TOPICS,
    dlq: publisher,
    handle: (env) => handle(env),
  }).start();

  const app = await NestFactory.create(PaymentModule.forDeps({ pool, provider }), {
    rawBody: true,
  });
  mountTelemetry(app, 'payment');
  app.enableShutdownHooks();
  await app.listen(port);
  console.log(`[payment] listening on ${port} (provider: ${provider.name})`);
}

void main();
