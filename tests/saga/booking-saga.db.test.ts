import { join } from 'node:path';
import type { Pool } from 'pg';
import { createEvent, buildSeatMap } from '@gatepass/catalog';
import {
  createBooking,
  getBooking,
  bookingHandler,
  CONSUMED_TOPICS as BOOKING_TOPICS,
} from '@gatepass/booking';
import {
  CONSUMED_TOPICS as INVENTORY_TOPICS,
  getSeats,
  seatInventoryHandler,
} from '@gatepass/seat-inventory';
import {
  CONSUMED_TOPICS as PAYMENT_TOPICS,
  FAKE_TOKENS,
  FakeProvider,
  handleWebhook,
  paymentHandler,
  startPayment,
  type PaymentDeps,
} from '@gatepass/payment';
import { migrate } from '@gatepass/db';
import { decodeEnvelope, type EventEnvelope } from '@gatepass/events';
import { createMessageHandler, type DeadLetterPublisher } from '@gatepass/messaging';
import { OutboxRelay } from '@gatepass/outbox';
import {
  InMemoryBroker,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from '@gatepass/testing';

jest.setTimeout(300_000);

const root = join(__dirname, '..', '..', 'services');
const FAST = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 };
const SERVICES = ['catalog', 'inventory', 'booking', 'payment'] as const;
type Service = (typeof SERVICES)[number];

class Dlq implements DeadLetterPublisher {
  messages: { topic: string }[] = [];
  async publish(topic: string) {
    this.messages.push({ topic });
  }
}

let server: TestPostgres;
let dbs: Record<Service, TestDatabase>;
let broker: InMemoryBroker;
let relays: OutboxRelay[];
let dlq: Dlq;
let provider: FakeProvider;
let failNext: { 'seats.held': number; 'payment.succeeded': number };

const pool = (n: Service): Pool => dbs[n].pool;
const payDeps = (): PaymentDeps => ({ pool: pool('payment'), provider });

/** Moves events along until the whole system is quiet: relays publish, the broker delivers. */
async function settle(maxRounds = 80): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    let progress = 0;
    for (const r of relays) {
      try {
        progress += await r.pollOnce();
      } catch {
        // broker down: events stay in the outbox, retried on the next round
      }
    }
    progress += await broker.deliverPending();
    if (progress === 0) return;
  }
  throw new Error('system did not settle');
}

beforeAll(async () => {
  server = await startTestPostgres();
  dbs = {
    catalog: await server.createDatabase(),
    inventory: await server.createDatabase(10),
    booking: await server.createDatabase(),
    payment: await server.createDatabase(20),
  };
  await migrate(pool('catalog'), join(root, 'catalog', 'migrations'));
  await migrate(pool('inventory'), join(root, 'seat-inventory', 'migrations'));
  await migrate(pool('booking'), join(root, 'booking', 'migrations'));
  await migrate(pool('payment'), join(root, 'payment', 'migrations'));
});

afterAll(async () => {
  await Promise.all(Object.values(dbs).map((d) => d.close()));
  await server.stop();
});

beforeEach(async () => {
  for (const n of SERVICES) await pool(n).query('TRUNCATE outbox, inbox RESTART IDENTITY');
  await pool('inventory').query('TRUNCATE seats');
  await pool('booking').query('TRUNCATE booking_transitions, bookings');
  await pool('catalog').query('TRUNCATE seat_defs, event_tiers, events CASCADE');
  await pool('payment').query('TRUNCATE webhook_events, payments, payables CASCADE');

  dlq = new Dlq();
  broker = new InMemoryBroker();
  provider = new FakeProvider({ webhookSecret: 'whsec_saga_test_secret' });
  failNext = { 'seats.held': 0, 'payment.succeeded': 0 };
  relays = SERVICES.map((n) => new OutboxRelay({ pool: pool(n), publisher: broker, lockName: n }));

  const inventory = seatInventoryHandler(pool('inventory'), { holdTtlMs: 600_000 });
  broker.subscribe(
    INVENTORY_TOPICS,
    createMessageHandler({
      groupId: 'seat-inventory',
      dlq,
      retry: FAST,
      handle: async (e) => {
        if (e.eventType === 'payment.succeeded' && failNext['payment.succeeded'] > 0) {
          failNext['payment.succeeded']--;
          throw new Error('simulated crash while selling seats');
        }
        await inventory(e);
      },
    }),
  );
  const booking = bookingHandler(pool('booking'));
  broker.subscribe(
    BOOKING_TOPICS,
    createMessageHandler({
      groupId: 'booking',
      dlq,
      retry: FAST,
      handle: async (e) => {
        if (e.eventType === 'seats.held' && failNext['seats.held'] > 0) {
          failNext['seats.held']--;
          throw new Error('simulated crash while handling seats.held');
        }
        await booking(e);
      },
    }),
  );
  const payment = paymentHandler(pool('payment'));
  broker.subscribe(
    PAYMENT_TOPICS,
    createMessageHandler({ groupId: 'payment', handle: (e) => payment(e), dlq, retry: FAST }),
  );

  await createEvent(pool('catalog'), {
    id: 'show',
    organizerId: 'o',
    title: 'Show',
    category: 'Music',
    venue: 'Hall',
    startsAt: new Date('2026-12-06T14:00:00Z'),
    seats: buildSeatMap([{ label: 'A', tier: 'Front', priceMinor: 100_000 }], 6),
  });
  await settle();
});

const published = (type: string): EventEnvelope[] =>
  broker.published.filter((m) => m.topic === type).map((m) => decodeEnvelope(m.value));

const request = (seatIds: string[], userId = 'u1') =>
  createBooking(pool('booking'), { eventId: 'show', userId, seatIds });

const bookingState = async (id: string) => (await getBooking(pool('booking'), id)).state;
const seatStates = async () =>
  Object.fromEntries((await getSeats(pool('inventory'), 'show')).map((s) => [s.id, s.state]));

/** A held booking, ready to be paid. */
async function heldBooking(seatIds: string[], userId = 'u1') {
  const b = await request(seatIds, userId);
  await settle();
  expect(await bookingState(b.id)).toBe('HELD');
  return b;
}

const payBooking = (bookingId: string, over: { token?: string; key?: string } = {}) =>
  startPayment(payDeps(), {
    bookingId,
    userId: 'u1',
    method: 'upi',
    token: over.token ?? FAKE_TOKENS.success,
    idempotencyKey: over.key ?? `idem-${bookingId}-1`,
  });

const sendWebhook = (paymentId: string, outcome: 'succeeded' | 'failed', opts = {}) => {
  const hook = provider.buildWebhook(paymentId, outcome, opts);
  return handleWebhook(payDeps(), Buffer.from(hook.body), hook.headers);
};

const transitionsOf = async (id: string) =>
  (
    await pool('booking').query(
      'SELECT from_state, to_state FROM booking_transitions WHERE booking_id=$1 ORDER BY id',
      [id],
    )
  ).rows.map((r) => `${r.from_state ?? ''}>${r.to_state}`);

describe('event publication feeds seat-inventory', () => {
  it('turns event.published into seats that the seat map can show', async () => {
    const seats = await getSeats(pool('inventory'), 'show');
    expect(seats).toHaveLength(6);
    expect(seats.every((s) => s.state === 'available')).toBe(true);
  });
});

describe('happy hold', () => {
  it('booking.requested -> seats.held -> booking HELD, one correlation id throughout', async () => {
    const b = await request(['A1', 'A2']);
    await settle();

    const after = await getBooking(pool('booking'), b.id);
    expect(after.state).toBe('HELD');
    const heldEvent = published('seats.held')[0]!;
    if (heldEvent.payload.case !== 'seatsHeld') throw new Error('wrong payload');
    expect(after.holdExpiresAt).toBe(
      new Date(Number(heldEvent.payload.value.holdExpiresAtMs)).toISOString(),
    );
    const ahead = Date.parse(after.holdExpiresAt!) - Date.now();
    expect(ahead).toBeGreaterThan(590_000);
    expect(ahead).toBeLessThanOrEqual(600_000);
    expect(after).toMatchObject({ amountMinor: 200_000, currency: 'INR' });

    const seats = await getSeats(pool('inventory'), 'show');
    expect(seats.filter((s) => s.state === 'held').map((s) => s.id)).toEqual(['A1', 'A2']);

    for (const e of [published('booking.requested')[0]!, heldEvent])
      expect(e.correlationId).toBe(b.id);
    expect(heldEvent.causationId).toBe(published('booking.requested')[0]!.eventId);
    expect(dlq.messages).toHaveLength(0);
  });
});

describe('hold failure cancels the booking', () => {
  it('second buyer for the same seat is CANCELLED and the first keeps the seat', async () => {
    const first = await request(['A1', 'A2'], 'alice');
    await settle();
    const second = await request(['A2', 'A3'], 'bob');
    await settle();

    expect((await getBooking(pool('booking'), first.id)).state).toBe('HELD');
    expect(await getBooking(pool('booking'), second.id)).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'hold_failed',
    });
    const seats = await getSeats(pool('inventory'), 'show');
    expect(seats.filter((s) => s.state === 'held').map((s) => s.id)).toEqual(['A1', 'A2']);
    expect(seats.find((s) => s.id === 'A3')!.state).toBe('available');

    const cancelled = published('booking.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.correlationId).toBe(second.id);
    expect(cancelled[0]!.causationId).toBe(published('seats.hold_failed')[0]!.eventId);
  });
});

describe('payment happy path', () => {
  it('HELD -> pay -> webhook -> seats sold -> CONFIRMED, one correlation id for the whole saga', async () => {
    const b = await heldBooking(['A1', 'A2']);
    const paid = await payBooking(b.id);
    expect(paid.status).toBe('processing');
    await settle();
    expect(await bookingState(b.id)).toBe('HELD'); // nothing moves until the provider confirms

    expect(await sendWebhook(paid.paymentId, 'succeeded')).toBe('applied');
    await settle();

    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(await seatStates()).toMatchObject({ A1: 'taken', A2: 'taken', A3: 'available' });
    expect(await transitionsOf(b.id)).toEqual([
      '>REQUESTED',
      'REQUESTED>HELD',
      'HELD>PAID',
      'PAID>CONFIRMED',
    ]);

    const chain = [
      'booking.requested',
      'seats.held',
      'payment.succeeded',
      'seats.sold',
      'booking.confirmed',
    ];
    for (const type of chain) {
      const events = published(type);
      expect(events).toHaveLength(1);
      expect(events[0]!.correlationId).toBe(b.id);
    }
    expect(published('seats.sold')[0]!.causationId).toBe(
      published('payment.succeeded')[0]!.eventId,
    );
    expect(published('booking.confirmed')[0]!.causationId).toBe(
      published('seats.sold')[0]!.eventId,
    );
    expect(provider.charges.size).toBe(1);
    expect(dlq.messages).toHaveLength(0);
  });
});

describe('DUPLICATE WEBHOOK DOES NOT DOUBLE CHARGE', () => {
  it('the same webhook delivered repeatedly, and every broker event delivered twice, changes nothing after the first', async () => {
    broker.deliveries = 2; // at-least-once: every event arrives twice
    const b = await heldBooking(['A1']);
    const paid = await payBooking(b.id);

    const hook = provider.buildWebhook(paid.paymentId, 'succeeded', { eventId: 'evt_same' });
    const raw = Buffer.from(hook.body);
    const results = [
      await handleWebhook(payDeps(), raw, hook.headers),
      await handleWebhook(payDeps(), raw, hook.headers), // provider retry, identical
      await handleWebhook(payDeps(), raw, hook.headers),
    ];
    expect(results).toEqual(['applied', 'duplicate', 'duplicate']);
    // a differently-numbered delivery that repeats the same outcome is also harmless
    expect(await sendWebhook(paid.paymentId, 'succeeded')).toBe('already');
    await settle();

    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(provider.charges.size).toBe(1); // ONE charge at the provider
    const payments = await pool('payment').query('SELECT state FROM payments');
    expect(payments.rows).toEqual([{ state: 'SUCCEEDED' }]); // ONE payment
    expect(published('payment.succeeded')).toHaveLength(1);
    expect(published('seats.sold')).toHaveLength(1);
    expect(published('booking.confirmed')).toHaveLength(1);
    expect(await transitionsOf(b.id)).toEqual([
      '>REQUESTED',
      'REQUESTED>HELD',
      'HELD>PAID',
      'PAID>CONFIRMED',
    ]);
    expect(dlq.messages).toHaveLength(0);
  });

  it('a double-clicked Pay (same Idempotency-Key, concurrent) charges once', async () => {
    const b = await heldBooking(['A1']);
    const results = await Promise.all(Array.from({ length: 8 }, () => payBooking(b.id)));
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(provider.charges.size).toBe(1);
    await sendWebhook(results[0]!.paymentId, 'succeeded');
    await settle();
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(published('payment.succeeded')).toHaveLength(1);
  });

  it('a late "failed" after success cannot undo a confirmed booking', async () => {
    const b = await heldBooking(['A1']);
    const paid = await payBooking(b.id);
    await sendWebhook(paid.paymentId, 'succeeded');
    await settle();
    expect(await sendWebhook(paid.paymentId, 'failed')).toBe('conflict');
    await settle();
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(await seatStates()).toMatchObject({ A1: 'taken' });
    expect(published('payment.failed')).toHaveLength(0);
    expect(published('seats.released')).toHaveLength(0);
  });
});

describe('PAYMENT FAILURE RELEASES SEATS AND CANCELS THE BOOKING', () => {
  it('declined payment: payment.failed -> seats.released -> booking CANCELLED, seats bookable again', async () => {
    const b = await heldBooking(['A1', 'A2'], 'alice');
    const paid = await payBooking(b.id, { token: FAKE_TOKENS.declined });
    expect(await sendWebhook(paid.paymentId, 'failed', { reason: 'insufficient_funds' })).toBe(
      'applied',
    );
    await settle();

    expect(await getBooking(pool('booking'), b.id)).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'payment_failed',
    });
    expect(await seatStates()).toMatchObject({ A1: 'available', A2: 'available' });
    expect(await transitionsOf(b.id)).toEqual(['>REQUESTED', 'REQUESTED>HELD', 'HELD>CANCELLED']);

    const failed = published('payment.failed')[0]!;
    const released = published('seats.released')[0]!;
    const cancelled = published('booking.cancelled')[0]!;
    expect([failed.correlationId, released.correlationId, cancelled.correlationId]).toEqual([
      b.id,
      b.id,
      b.id,
    ]);
    expect(released.causationId).toBe(failed.eventId);
    expect(cancelled.causationId).toBe(released.eventId);
    if (cancelled.payload.case !== 'bookingCancelled') throw new Error('wrong payload');
    expect(cancelled.payload.value.reason).toBe('payment_failed');
    expect(published('payment.succeeded')).toHaveLength(0);
    expect(published('seats.sold')).toHaveLength(0);

    // the seats are on sale again: another buyer gets them
    const other = await heldBooking(['A1', 'A2'], 'bob');
    expect(await seatStates()).toMatchObject({ A1: 'held', A2: 'held' });
    expect(await bookingState(other.id)).toBe('HELD');
    // and the cancelled booking can no longer be paid
    await expect(payBooking(b.id, { key: 'idem-retry-after-failure' })).rejects.toMatchObject({
      code: 'booking_closed',
    });
    expect(dlq.messages).toHaveLength(0);
  });

  it('a provider that refuses the charge outright takes the same path', async () => {
    const b = await heldBooking(['A3']);
    const r = await payBooking(b.id, { token: FAKE_TOKENS.rejected });
    expect(r.status).toBe('failed');
    await settle();
    expect(await bookingState(b.id)).toBe('CANCELLED');
    expect(await seatStates()).toMatchObject({ A3: 'available' });
    expect(provider.charges.size).toBe(0); // no money moved
  });

  it('a duplicate failure webhook releases once', async () => {
    broker.deliveries = 2;
    const b = await heldBooking(['A4']);
    const paid = await payBooking(b.id, { token: FAKE_TOKENS.declined });
    const hook = provider.buildWebhook(paid.paymentId, 'failed', { eventId: 'evt_fail' });
    const raw = Buffer.from(hook.body);
    await handleWebhook(payDeps(), raw, hook.headers);
    await handleWebhook(payDeps(), raw, hook.headers);
    await settle();
    expect(published('payment.failed')).toHaveLength(1);
    expect(published('seats.released')).toHaveLength(1);
    expect(published('booking.cancelled')).toHaveLength(1);
    expect(await bookingState(b.id)).toBe('CANCELLED');
  });
});

describe('at-least-once delivery', () => {
  it('delivering every hold event twice changes nothing', async () => {
    broker.deliveries = 2;
    const ok = await request(['A1']);
    const clash = await request(['A1']);
    await settle();

    expect((await getBooking(pool('booking'), ok.id)).state).toBe('HELD');
    expect((await getBooking(pool('booking'), clash.id)).state).toBe('CANCELLED');
    expect(published('seats.held')).toHaveLength(1);
    expect(published('seats.hold_failed')).toHaveLength(1);
    expect(published('booking.cancelled')).toHaveLength(1);
    const held = await pool('inventory').query("SELECT count(*) FROM seats WHERE state='held'");
    expect(held.rows[0].count).toBe('1');
  });
});

describe('resumable saga', () => {
  it('a consumer failing mid-saga is retried and the booking still reaches HELD', async () => {
    failNext['seats.held'] = 2;
    const b = await request(['A4']);
    await settle();
    expect(await bookingState(b.id)).toBe('HELD');
    expect(dlq.messages).toHaveLength(0);
  });

  it('seat-inventory failing while selling is retried; the customer is charged once and ends CONFIRMED', async () => {
    const b = await heldBooking(['A1']);
    const paid = await payBooking(b.id);
    failNext['payment.succeeded'] = 2;
    await sendWebhook(paid.paymentId, 'succeeded');
    await settle();
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(await seatStates()).toMatchObject({ A1: 'taken' });
    expect(provider.charges.size).toBe(1);
    expect(dlq.messages).toHaveLength(0);
  });

  it('a message that keeps failing is dead-lettered, and the booking stays REQUESTED, not lost', async () => {
    failNext['seats.held'] = 99;
    const b = await request(['A5']);
    await settle();
    expect(await bookingState(b.id)).toBe('REQUESTED');
    expect(dlq.messages).toEqual([{ topic: 'booking.dlq' }]);
  });

  it('a broker outage between payment and sale loses nothing: the sale completes after recovery', async () => {
    const b = await heldBooking(['A1']);
    const paid = await payBooking(b.id);
    broker.down = true;
    await sendWebhook(paid.paymentId, 'succeeded'); // payment committed locally
    await settle(3);
    expect(await bookingState(b.id)).toBe('HELD');
    const pending = await pool('payment').query(
      'SELECT count(*) FROM outbox WHERE published_at IS NULL',
    );
    expect(Number(pending.rows[0].count)).toBeGreaterThan(0);

    broker.down = false;
    await settle();
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(provider.charges.size).toBe(1);
  });

  it('a broker outage at the start loses nothing', async () => {
    broker.down = true;
    const b = await request(['A6']);
    await settle(3);
    expect(await bookingState(b.id)).toBe('REQUESTED');
    broker.down = false;
    await settle();
    expect(await bookingState(b.id)).toBe('HELD');
  });
});
