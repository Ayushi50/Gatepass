import { join } from 'node:path';
import type { Pool } from 'pg';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import {
  bookingHandler,
  createBooking,
  CONSUMED_TOPICS as BOOKING_TOPICS,
} from '@gatepass/booking';
import { migrate } from '@gatepass/db';
import { buildEnvelope } from '@gatepass/events';
import { createMessageHandler, type DeadLetterPublisher } from '@gatepass/messaging';
import { OutboxRelay } from '@gatepass/outbox';
import {
  CONSUMED_TOPICS as PAYMENT_TOPICS,
  FAKE_TOKENS,
  FakeProvider,
  handleWebhook,
  paymentHandler,
  startPayment,
} from '@gatepass/payment';
import {
  CONSUMED_TOPICS as INVENTORY_TOPICS,
  onEventPublished,
  seatInventoryHandler,
  sweepExpiredHolds,
} from '@gatepass/seat-inventory';
import { initTelemetry, inSpan, metricsText, registry } from '@gatepass/telemetry';
import {
  InMemoryBroker,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from '@gatepass/testing';

jest.setTimeout(180_000);

const exporter = new InMemorySpanExporter();
const services = ['inventory', 'booking', 'payment'] as const;
const root = join(__dirname, '..', '..', 'services');
const FAST = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

let server: TestPostgres;
let dbs: Record<(typeof services)[number], TestDatabase>;
let broker: InMemoryBroker;
let relays: OutboxRelay[];
let provider: FakeProvider;
let deadLettered = 0;
let failSeatsHeld = false;
const dlq: DeadLetterPublisher = { publish: async () => void deadLettered++ };
const pool = (s: (typeof services)[number]): Pool => dbs[s].pool;

/** The current value of one labelled sample of a metric (0 if it has not been touched). */
async function sample(
  name: string,
  labels: Record<string, string> = {},
  suffix = '',
): Promise<number> {
  const m = registry.getSingleMetric(name);
  if (!m) return 0;
  const { values } = await m.get();
  return values
    .filter(
      (v) =>
        ((v as { metricName?: string }).metricName ?? name) === name + suffix &&
        Object.entries(labels).every(([k, x]) => v.labels[k] === x),
    )
    .reduce((n, v) => n + v.value, 0);
}

async function settle(rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    let progress = 0;
    for (const r of relays) progress += await r.pollOnce().catch(() => 0);
    progress += await broker.deliverPending();
    if (progress === 0) return;
  }
  throw new Error('did not settle');
}

beforeAll(async () => {
  initTelemetry('tests', { exporter });
  server = await startTestPostgres();
  dbs = {} as typeof dbs;
  for (const s of services) dbs[s] = await server.createDatabase();
  await migrate(pool('inventory'), join(root, 'seat-inventory', 'migrations'));
  await migrate(pool('booking'), join(root, 'booking', 'migrations'));
  await migrate(pool('payment'), join(root, 'payment', 'migrations'));
});
afterAll(async () => {
  await Promise.all(Object.values(dbs ?? {}).map((d) => d.close()));
  await server?.stop();
});

beforeEach(async () => {
  for (const s of services) await pool(s).query('TRUNCATE outbox, inbox RESTART IDENTITY');
  await pool('inventory').query('TRUNCATE seats');
  await pool('booking').query('TRUNCATE booking_transitions, refunds, bookings CASCADE');
  await pool('payment').query('TRUNCATE webhook_events, refunds, payments, payables CASCADE');
  exporter.reset();
  registry.resetMetrics();
  deadLettered = 0;
  failSeatsHeld = false;
  broker = new InMemoryBroker();
  provider = new FakeProvider({ webhookSecret: 'whsec_telemetry_test_secret' });
  relays = services.map((s) => new OutboxRelay({ pool: pool(s), publisher: broker, lockName: s }));

  const inv = seatInventoryHandler(pool('inventory'));
  broker.subscribe(
    INVENTORY_TOPICS,
    createMessageHandler({ groupId: 'seat-inventory', handle: (e) => inv(e), dlq, retry: FAST }),
  );
  const bk = bookingHandler(pool('booking'));
  broker.subscribe(
    BOOKING_TOPICS,
    createMessageHandler({
      groupId: 'booking',
      dlq,
      retry: FAST,
      handle: async (e) => {
        if (failSeatsHeld && e.eventType === 'seats.held') throw new Error('boom');
        await bk(e);
      },
    }),
  );
  const pay = paymentHandler(pool('payment'), provider);
  broker.subscribe(
    PAYMENT_TOPICS,
    createMessageHandler({ groupId: 'payment', handle: (e) => pay(e), dlq, retry: FAST }),
  );

  await onEventPublished(
    pool('inventory'),
    buildEnvelope({
      eventType: 'event.published',
      correlationId: 'show',
      producer: 'catalog',
      payload: {
        eventId: 'show',
        organizerId: 'o',
        title: 'T',
        category: 'M',
        venue: 'V',
        currency: 'INR',
        seats: ['A1', 'A2', 'A3', 'A4'].map((id, i) => ({
          seatId: id,
          row: 'A',
          number: i + 1,
          tier: 'F',
          priceMinor: 100000n,
        })),
      },
    }),
  );
  registry.resetMetrics();
});

const spans = () => exporter.getFinishedSpans();
const consume = (topic: string) => spans().filter((s) => s.name === `consume ${topic}`);
const book = (seatIds: string[], user = 'u1') =>
  inSpan('POST /api/bookings', {}, () =>
    createBooking(pool('booking'), { eventId: 'show', userId: user, seatIds }),
  );
const payFor = async (bookingId: string, token: string = FAKE_TOKENS.success) =>
  startPayment(
    { pool: pool('payment'), provider },
    { bookingId, userId: 'u1', method: 'upi', token, idempotencyKey: `idem-${bookingId}-0001` },
  );
const hook = async (paymentId: string, outcome: 'succeeded' | 'failed') => {
  const h = provider.buildWebhook(paymentId, outcome);
  await handleWebhook({ pool: pool('payment'), provider }, Buffer.from(h.body), h.headers);
};

describe('ONE BOOKING = ONE TRACE, across services', () => {
  it('the request, the seat service and the booking service share a trace, each a child of the one before', async () => {
    const b = await book(['A1', 'A2']);
    await settle();

    const root = spans().find((s) => s.name === 'POST /api/bookings')!;
    const [heldReq] = consume('booking.requested');
    const [heldEvt] = consume('seats.held');
    expect(heldReq).toBeDefined();
    expect(heldEvt).toBeDefined();
    const trace = root.spanContext().traceId;
    expect(heldReq!.spanContext().traceId).toBe(trace);
    expect(heldEvt!.spanContext().traceId).toBe(trace);
    // booking.requested was written inside the request, so its consumer is the request's child;
    // seats.held was written inside THAT consumer, so its consumers are that consumer's children
    expect(heldReq!.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(heldEvt!.parentSpanContext?.spanId).toBe(heldReq!.spanContext().spanId);
    // and every consumer of seats.held (booking AND payment) is in the same trace
    expect(
      consume('seats.held')
        .map((s) => s.attributes['messaging.consumer_group'])
        .sort(),
    ).toEqual(['booking', 'payment']);
    for (const s of consume('seats.held')) expect(s.spanContext().traceId).toBe(trace);
    expect(heldEvt!.attributes['gatepass.correlation_id']).toBe(b.id); // findable by booking id
    expect(heldEvt!.attributes['messaging.destination']).toBe('seats.held');
  });

  it('the trace survives a broker outage: the context sits in the outbox row until the relay can publish', async () => {
    broker.down = true;
    await book(['A3']);
    await settle(3); // relays fail; the event waits in the outbox
    const stored = await pool('booking').query(
      "SELECT headers FROM outbox WHERE event_type = 'booking.requested'",
    );
    expect(stored.rows[0].headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    broker.down = false;
    await settle();
    const root = spans().find((s) => s.name === 'POST /api/bookings')!;
    expect(consume('booking.requested')[0]!.spanContext().traceId).toBe(root.spanContext().traceId);
  });

  it('a failing consumer marks its span failed and the dead letter is counted', async () => {
    failSeatsHeld = true;
    await book(['A4']);
    await settle();
    const bad = consume('seats.held').find(
      (s) => s.attributes['messaging.consumer_group'] === 'booking',
    )!;
    expect(bad.attributes['gatepass.outcome']).toBe('dead-lettered');
    expect(deadLettered).toBe(1);
    expect(await sample('gatepass_dead_letters_total', { consumer: 'booking' })).toBe(1);
    expect(await sample('gatepass_consumer_retries_total', { consumer: 'booking' })).toBe(2); // 3 attempts
  });
});

describe('METRICS count each thing once, however messages arrive', () => {
  it('a booking that is confirmed counts once as requested, held and confirmed, with a payment time', async () => {
    const b = await book(['A1', 'A2']);
    await settle();
    const paid = await payFor(b.id);
    await hook(paid.paymentId, 'succeeded');
    await settle();

    expect(await sample('gatepass_bookings_requested_total')).toBe(1);
    expect(await sample('gatepass_holds_created_total')).toBe(1);
    expect(await sample('gatepass_bookings_confirmed_total')).toBe(1);
    expect(await sample('gatepass_bookings_cancelled_total')).toBe(0);
    expect(await sample('gatepass_payments_total', { outcome: 'succeeded' })).toBe(1);
    expect(
      await sample('gatepass_payment_duration_seconds', { outcome: 'succeeded' }, '_count'),
    ).toBe(1);
    expect(
      await sample('gatepass_payment_duration_seconds', { outcome: 'succeeded' }, '_sum'),
    ).toBeGreaterThan(0);
  });

  it('EVERY MESSAGE DELIVERED TWICE changes no counter, and the duplicates are counted', async () => {
    broker.deliveries = 2;
    const b = await book(['A1']);
    await settle();
    const paid = await payFor(b.id);
    const h = provider.buildWebhook(paid.paymentId, 'succeeded', { eventId: 'evt-dup' });
    for (let i = 0; i < 3; i++)
      await handleWebhook({ pool: pool('payment'), provider }, Buffer.from(h.body), h.headers);
    await settle();

    expect(await sample('gatepass_bookings_requested_total')).toBe(1);
    expect(await sample('gatepass_holds_created_total')).toBe(1);
    expect(await sample('gatepass_bookings_confirmed_total')).toBe(1);
    expect(await sample('gatepass_payments_total', { outcome: 'succeeded' })).toBe(1);
    expect(
      await sample('gatepass_payment_duration_seconds', { outcome: 'succeeded' }, '_count'),
    ).toBe(1);
    expect(await sample('gatepass_consumer_duplicates_ignored_total')).toBeGreaterThan(0);
  });

  it('a refused hold and a failed payment are counted by reason', async () => {
    await book(['A1']);
    await settle();
    await book(['A1'], 'u2'); // same seat: refused
    await settle();
    expect(await sample('gatepass_holds_created_total')).toBe(1);
    expect(await sample('gatepass_holds_failed_total', { reason: 'seat_unavailable' })).toBe(1);
    expect(await sample('gatepass_bookings_cancelled_total', { reason: 'hold_failed' })).toBe(1);

    const b = await book(['A2'], 'u3');
    await settle();
    const paid = await payFor(b.id, FAKE_TOKENS.declined);
    await hook(paid.paymentId, 'failed');
    await settle();
    expect(await sample('gatepass_payments_total', { outcome: 'failed' })).toBe(1);
    expect(await sample('gatepass_bookings_cancelled_total', { reason: 'payment_failed' })).toBe(1);
  });

  it('an expired hold counts as expired, once, and the booking as cancelled for that reason', async () => {
    await book(['A3']);
    await settle();
    const later = () => Date.now() + 700_000;
    expect(await sweepExpiredHolds(pool('inventory'), { now: later, graceMs: 60_000 })).toBe(1);
    await sweepExpiredHolds(pool('inventory'), { now: later, graceMs: 60_000 }); // nothing left
    await settle();
    expect(await sample('gatepass_holds_expired_total')).toBe(1);
    expect(await sample('gatepass_bookings_cancelled_total', { reason: 'hold_expired' })).toBe(1);
  });

  it('a rolled-back booking is not counted', async () => {
    await expect(
      createBooking(pool('booking'), { eventId: 'show', userId: 'u', seatIds: [] }),
    ).rejects.toThrow();
    expect(await sample('gatepass_bookings_requested_total')).toBe(0);
  });

  it('the unsent-events gauge shows a stuck relay and drains when it recovers', async () => {
    broker.down = true;
    await book(['A4']);
    await settle(3);
    expect(await metricsText()).toMatch(/gatepass_outbox_pending\{relay="booking"\} [1-9]/);
    broker.down = false;
    await settle();
    expect(await metricsText()).toMatch(/gatepass_outbox_pending\{relay="booking"\} 0/);
  });
});
