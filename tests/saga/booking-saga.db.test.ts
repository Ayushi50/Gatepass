import { join } from 'node:path';
import type { Pool } from 'pg';
import { createEvent, buildSeatMap } from '@gatepass/catalog';
import {
  approveRefund,
  createBooking,
  getBooking,
  bookingHandler,
  CONSUMED_TOPICS as BOOKING_TOPICS,
} from '@gatepass/booking';
import {
  CONSUMED_TOPICS as INVENTORY_TOPICS,
  getSeats,
  seatInventoryHandler,
  sweepExpiredHolds,
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
import {
  QrKeyRing,
  checkIn,
  listTickets,
  requestRefund,
  ticketHandler,
  CONSUMED_TOPICS as TICKET_TOPICS,
} from '@gatepass/ticket';
import {
  notificationHandler,
  CONSUMED_TOPICS as NOTIFICATION_TOPICS,
} from '@gatepass/notification';
import {
  analyticsHandler,
  getActivity,
  getRefunds,
  getSummary,
  CONSUMED_TOPICS as ANALYTICS_TOPICS,
} from '@gatepass/analytics';
import { migrate } from '@gatepass/db';
import { decodeEnvelope, type EventEnvelope } from '@gatepass/events';
import {
  createMessageHandler,
  replayRecords,
  type DeadLetterPublisher,
  type DlqRecord,
} from '@gatepass/messaging';
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
const SERVICES = [
  'catalog',
  'inventory',
  'booking',
  'payment',
  'ticket',
  'notification',
  'analytics',
] as const;
const keys = new QrKeyRing('k1:' + 's'.repeat(40));
type Service = (typeof SERVICES)[number];

class Dlq implements DeadLetterPublisher {
  messages: {
    topic: string;
    key: string | null;
    value: Uint8Array | null;
    headers: Record<string, string>;
  }[] = [];
  async publish(
    topic: string,
    message: { key: string | null; value: Uint8Array | null; headers: Record<string, string> },
  ) {
    this.messages.push({ topic, ...message });
  }
  /** What the replay CLI would read from this DLQ topic. */
  records(topic: string): DlqRecord[] {
    return this.messages
      .filter((m) => m.topic === topic)
      .map((m, i) => ({
        topic,
        partition: 0,
        offset: String(i),
        key: m.key,
        value: m.value,
        headers: m.headers,
      }));
  }
}

let server: TestPostgres;
let dbs: Record<Service, TestDatabase>;
let broker: InMemoryBroker;
let relays: OutboxRelay[];
let dlq: Dlq;
let provider: FakeProvider;
let failNext: { 'seats.held': number; 'payment.succeeded': number; 'booking.confirmed': number };

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
    ticket: await server.createDatabase(60),
    notification: await server.createDatabase(),
    analytics: await server.createDatabase(),
  };
  await migrate(pool('catalog'), join(root, 'catalog', 'migrations'));
  await migrate(pool('inventory'), join(root, 'seat-inventory', 'migrations'));
  await migrate(pool('booking'), join(root, 'booking', 'migrations'));
  await migrate(pool('payment'), join(root, 'payment', 'migrations'));
  await migrate(pool('ticket'), join(root, 'ticket', 'migrations'));
  await migrate(pool('notification'), join(root, 'notification', 'migrations'));
  await migrate(pool('analytics'), join(root, 'analytics', 'migrations'));
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
  await pool('ticket').query('TRUNCATE tickets, event_seats, events CASCADE');
  await pool('notification').query('TRUNCATE notifications RESTART IDENTITY');
  await pool('analytics').query('TRUNCATE activity, seat_status, events CASCADE');

  dlq = new Dlq();
  broker = new InMemoryBroker();
  provider = new FakeProvider({ webhookSecret: 'whsec_saga_test_secret' });
  failNext = { 'seats.held': 0, 'payment.succeeded': 0, 'booking.confirmed': 0 };
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
  const payment = paymentHandler(pool('payment'), provider);
  broker.subscribe(
    PAYMENT_TOPICS,
    createMessageHandler({ groupId: 'payment', handle: (e) => payment(e), dlq, retry: FAST }),
  );

  const ticket = ticketHandler(pool('ticket'), keys);
  broker.subscribe(
    TICKET_TOPICS,
    createMessageHandler({
      groupId: 'ticket',
      dlq,
      retry: FAST,
      handle: async (e) => {
        if (e.eventType === 'booking.confirmed' && failNext['booking.confirmed'] > 0) {
          failNext['booking.confirmed']--;
          throw new Error('simulated crash while issuing tickets');
        }
        await ticket(e);
      },
    }),
  );
  const notification = notificationHandler(pool('notification'), () => {});
  broker.subscribe(
    NOTIFICATION_TOPICS,
    createMessageHandler({
      groupId: 'notification',
      handle: (e) => notification(e),
      dlq,
      retry: FAST,
    }),
  );
  const analytics = analyticsHandler(pool('analytics'));
  broker.subscribe(
    ANALYTICS_TOPICS,
    createMessageHandler({ groupId: 'analytics', handle: (e) => analytics(e), dlq, retry: FAST }),
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
    expect(dlq.messages.map((m) => m.topic)).toEqual(['booking.dlq']);
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

// ---------------------------------------------------------------------------------------------
// Phase 3: tickets, notifications, analytics and check-in
// ---------------------------------------------------------------------------------------------

const notificationRows = async () =>
  (
    await pool('notification').query(
      'SELECT channel, user_id, template FROM notifications ORDER BY id',
    )
  ).rows;
const ticketRows = async () =>
  (await pool('ticket').query('SELECT seat_id, status FROM tickets ORDER BY seat_id')).rows;

/** Runs a booking all the way: held, paid, webhook succeeded, everything settled. */
async function completedBooking(seatIds: string[], userId = 'u1') {
  const b = await heldBooking(seatIds, userId);
  const paid = await payBooking(b.id);
  await sendWebhook(paid.paymentId, 'succeeded');
  await settle();
  return b;
}

describe('FULL HAPPY PATH, END TO END', () => {
  it('event -> hold -> pay -> sale -> confirmed -> tickets -> notifications -> dashboard -> check-in', async () => {
    const b = await completedBooking(['A1', 'A2']);

    // booking and seats
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(await seatStates()).toMatchObject({ A1: 'taken', A2: 'taken', A3: 'available' });

    // the whole chain happened exactly once, in causal order, under ONE correlation id
    const chain = [
      'booking.requested',
      'seats.held',
      'payment.succeeded',
      'seats.sold',
      'booking.confirmed',
      'ticket.issued',
    ];
    const events = chain.map((type) => {
      const found = published(type);
      expect(found).toHaveLength(1);
      expect(found[0]!.correlationId).toBe(b.id);
      return found[0]!;
    });
    // payment.succeeded is caused by the provider's webhook (outside the event stream), so the
    // causal chain of events starts there: each later event names the one that triggered it
    expect(events[2]!.causationId).toBe('');
    for (let i = 3; i < events.length; i++)
      expect(events[i]!.causationId).toBe(events[i - 1]!.eventId);
    const order = broker.published.map((m) => m.topic).filter((t) => chain.includes(t));
    expect(order).toEqual(chain);

    // tickets: one signed ticket per seat, shown to their owner only
    expect(await ticketRows()).toEqual([
      { seat_id: 'A1', status: 'valid' },
      { seat_id: 'A2', status: 'valid' },
    ]);
    const mine = await listTickets(pool('ticket'), keys, 'u1');
    expect(mine.map((t) => [t.row + t.seat, t.tier, t.eventTitle])).toEqual([
      ['A1', 'Front', 'Show'],
      ['A2', 'Front', 'Show'],
    ]);
    expect(await listTickets(pool('ticket'), keys, 'someone-else')).toEqual([]);

    // notifications: an email and an SMS for the tickets
    expect(await notificationRows()).toEqual([
      { channel: 'email', user_id: 'u1', template: 'tickets-ready' },
      { channel: 'sms', user_id: 'u1', template: 'tickets-ready' },
    ]);

    // organizer dashboard: counts and live feed, scoped to the organizer
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({
      sold: 2,
      held: 0,
      total: 6,
      left: 4,
      tiers: [{ name: 'Front', sold: 2, total: 6 }],
    });
    const feed = await getActivity(pool('analytics'), 'show', 'o');
    expect(feed.map((f) => f.type)).toEqual(
      expect.arrayContaining([
        'seats.held',
        'payment.succeeded',
        'seats.sold',
        'booking.confirmed',
        'ticket.issued',
      ]),
    );
    expect(feed.find((f) => f.type === 'seats.sold')!.text).toBe('Row A · seats 1, 2');
    await expect(getSummary(pool('analytics'), 'show', 'another-organizer')).rejects.toThrow(
      'not your event',
    );

    // check-in: the QR works once at the door
    const [first, second] = mine;
    expect(await checkIn(pool('ticket'), keys, first!.qrToken, 'staff-1')).toEqual({
      status: 'valid',
      row: 'A',
      seat: '1',
      tier: 'Front',
    });
    expect(await checkIn(pool('ticket'), keys, first!.qrToken, 'staff-2')).toMatchObject({
      status: 'used',
    });
    expect(await checkIn(pool('ticket'), keys, second!.qrToken, 'staff-2')).toMatchObject({
      status: 'valid',
    });

    expect(provider.charges.size).toBe(1);
    expect(dlq.messages).toHaveLength(0);
  });

  it('two gates scanning the same QR at the same moment: exactly one is admitted', async () => {
    await completedBooking(['A3']);
    const [t] = await listTickets(pool('ticket'), keys, 'u1');
    const scans = await Promise.all(
      Array.from({ length: 30 }, (_, i) => checkIn(pool('ticket'), keys, t!.qrToken, `gate-${i}`)),
    );
    expect(scans.filter((s) => s.status === 'valid')).toHaveLength(1);
    expect(scans.filter((s) => s.status === 'used')).toHaveLength(29);
  });

  it('every event delivered twice: still one ticket per seat, one email, one SMS, one feed line each', async () => {
    broker.deliveries = 2;
    const b = await completedBooking(['A1', 'A2']);
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(await ticketRows()).toHaveLength(2);
    expect(published('ticket.issued')).toHaveLength(1);
    expect(await notificationRows()).toHaveLength(2);
    const feed = await getActivity(pool('analytics'), 'show', 'o', 100);
    for (const type of ['seats.sold', 'ticket.issued', 'booking.confirmed']) {
      expect(feed.filter((f) => f.type === type)).toHaveLength(1);
    }
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({ sold: 2, held: 0 });
    expect(dlq.messages).toHaveLength(0);
  });

  it('a crash while issuing tickets is retried: the buyer still gets exactly one ticket per seat', async () => {
    failNext['booking.confirmed'] = 2;
    const b = await completedBooking(['A4']);
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(await ticketRows()).toEqual([{ seat_id: 'A4', status: 'valid' }]);
    expect(published('ticket.issued')).toHaveLength(1);
    expect(dlq.messages).toHaveLength(0);
  });

  it('a broker outage after the sale loses no ticket: they are issued once the broker is back', async () => {
    const b = await heldBooking(['A5']);
    const paid = await payBooking(b.id);
    await sendWebhook(paid.paymentId, 'succeeded');
    await settle(); // sold + confirmed
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    broker.down = true;
    await settle(3);
    broker.down = false;
    await settle();
    expect(await ticketRows()).toEqual([{ seat_id: 'A5', status: 'valid' }]);
  });
});

describe('failure path reaches notifications and the dashboard', () => {
  it('a declined payment emails the buyer, shows red on the feed and gives the seats back in the counts', async () => {
    const b = await heldBooking(['A1', 'A2']);
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({ held: 2, left: 4 });

    const paid = await payBooking(b.id, { token: FAKE_TOKENS.declined });
    await sendWebhook(paid.paymentId, 'failed', { reason: 'insufficient_funds' });
    await settle();

    expect(await bookingState(b.id)).toBe('CANCELLED');
    expect(await ticketRows()).toEqual([]); // no ticket for a booking that was never paid
    expect(await notificationRows()).toEqual([
      { channel: 'email', user_id: 'u1', template: 'payment-failed' },
    ]);
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({
      sold: 0,
      held: 0,
      left: 6,
    });
    const feed = await getActivity(pool('analytics'), 'show', 'o');
    expect(feed.find((f) => f.type === 'payment.failed')).toMatchObject({
      failed: true,
      text: 'Payment failed · insufficient_funds',
    });
    expect(dlq.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 4: hold expiry, the expiry-vs-payment race, refunds, dead-letter replay
// ---------------------------------------------------------------------------------------------

const HOLD_TTL = 600_000;
const GRACE = 60_000;
/** Sweeps as if enough time has passed for every hold (and its grace window) to be over. */
const expireAllHolds = () =>
  sweepExpiredHolds(pool('inventory'), {
    now: () => Date.now() + HOLD_TTL + GRACE + 1000,
    graceMs: GRACE,
  });
const refundRows = async () =>
  (
    await pool('payment').query(
      'SELECT id, state, amount_minor, automatic FROM refunds ORDER BY id',
    )
  ).rows;

describe('HOLD EXPIRY', () => {
  it('an abandoned hold is released: seats back on sale, booking cancelled, payment refused, dashboard updated', async () => {
    const b = await heldBooking(['A1', 'A2']);
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({ held: 2, left: 4 });

    expect(await expireAllHolds()).toBe(1);
    await settle();

    expect(await getBooking(pool('booking'), b.id)).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'hold_expired',
    });
    expect(await seatStates()).toMatchObject({ A1: 'available', A2: 'available' });
    const chain = ['seats.held', 'hold.expired', 'seats.released', 'booking.cancelled'];
    expect(broker.published.map((m) => m.topic).filter((t) => chain.includes(t))).toEqual(chain);
    expect(published('seats.released')[0]!.causationId).toBe(published('hold.expired')[0]!.eventId);
    expect(published('booking.cancelled')[0]!.causationId).toBe(
      published('seats.released')[0]!.eventId,
    );

    await expect(payBooking(b.id)).rejects.toMatchObject({ code: 'booking_closed' });
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({ held: 0, left: 6 });
    const feed = await getActivity(pool('analytics'), 'show', 'o');
    expect(feed.filter((f) => f.text.endsWith('returned to sale'))).toHaveLength(1); // not said twice

    const other = await heldBooking(['A1', 'A2'], 'bob'); // and someone else can have them
    expect(await bookingState(other.id)).toBe('HELD');
    expect(dlq.messages).toHaveLength(0);
  });

  it('a hold that has not expired is left alone, and so is a paid booking', async () => {
    const live = await heldBooking(['A1']);
    const paid = await completedBooking(['A2']);
    expect(await sweepExpiredHolds(pool('inventory'), { graceMs: GRACE })).toBe(0);
    await settle();
    expect(await bookingState(live.id)).toBe('HELD');
    expect(await bookingState(paid.id)).toBe('CONFIRMED');
    await expireAllHolds();
    await settle();
    expect(await bookingState(live.id)).toBe('CANCELLED');
    expect(await bookingState(paid.id)).toBe('CONFIRMED'); // sold seats are never swept
    expect(await seatStates()).toMatchObject({ A1: 'available', A2: 'taken' });
  });
});

describe('EXPIRY VS PAYMENT RACE, END TO END', () => {
  it('paid in time (before the hold is swept): the sale stands and the sweep finds nothing', async () => {
    const b = await heldBooking(['A1']);
    const paid = await payBooking(b.id);
    await sendWebhook(paid.paymentId, 'succeeded');
    await settle();
    expect(await expireAllHolds()).toBe(0);
    await settle();
    expect(await bookingState(b.id)).toBe('CONFIRMED');
    expect(await seatStates()).toMatchObject({ A1: 'taken' });
    expect(await refundRows()).toEqual([]);
    expect(await ticketRows()).toEqual([{ seat_id: 'A1', status: 'valid' }]);
  });

  it('paid too late (the hold was swept first): the buyer is refunded automatically, no ticket, no double sale', async () => {
    const b = await heldBooking(['A1', 'A2']);
    const paid = await payBooking(b.id); // the payment is in flight at the provider...
    await expireAllHolds(); // ...when the hold is released
    await settle();
    expect(await bookingState(b.id)).toBe('CANCELLED');

    await sendWebhook(paid.paymentId, 'succeeded'); // ...and only then does the provider confirm it
    await settle();

    expect(await bookingState(b.id)).toBe('CANCELLED'); // the booking is not resurrected
    expect(await seatStates()).toMatchObject({ A1: 'available', A2: 'available' });
    expect(await ticketRows()).toEqual([]);
    expect(published('seats.sold')).toHaveLength(0);
    expect(published('seats.sale_failed')).toHaveLength(1);

    // the money comes back: one charge, one automatic refund of all of it, then notified
    expect(provider.charges.size).toBe(1);
    expect(provider.refunds.size).toBe(1);
    expect(await refundRows()).toEqual([
      { id: `auto-${paid.paymentId}`, state: 'COMPLETED', amount_minor: '200000', automatic: true },
    ]);
    const done = published('refund.completed');
    expect(done).toHaveLength(1);
    if (done[0]!.payload.case !== 'refundCompleted') throw new Error('wrong payload');
    expect(done[0]!.payload.value).toMatchObject({
      automatic: true,
      amountMinor: 200000n,
      ticketId: '',
    });
    expect((await notificationRows()).map((n) => n.template)).toContain('refund-automatic');
    expect(dlq.messages).toHaveLength(0);
  });

  it('the same race with every event delivered twice still refunds exactly once', async () => {
    broker.deliveries = 2;
    const b = await heldBooking(['A3']);
    const paid = await payBooking(b.id);
    await expireAllHolds();
    await settle();
    await sendWebhook(paid.paymentId, 'succeeded');
    await settle();
    expect(provider.refunds.size).toBe(1);
    expect(published('refund.completed')).toHaveLength(1);
    expect(await seatStates()).toMatchObject({ A3: 'available' });
  });
});

describe('REFUNDS (reverse saga)', () => {
  it('request -> organizer approval -> refund -> ticket void -> seat back on sale, other ticket untouched', async () => {
    const b = await completedBooking(['A1', 'A2']);
    const [t1, t2] = await listTickets(pool('ticket'), keys, 'u1');
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({
      sold: 2,
      refundRequests: 0,
    });

    // 1. the buyer asks: the ticket is locked at once
    const req = await requestRefund(pool('ticket'), t1!.id, 'u1');
    await settle();
    expect(await checkIn(pool('ticket'), keys, t1!.qrToken, 'gate')).toEqual({ status: 'invalid' }); // cannot be used any more
    expect(
      (await listTickets(pool('ticket'), keys, 'u1')).find((t) => t.id === t1!.id)!.status,
    ).toBe('refund_requested');

    // the organizer sees it
    const open = await getRefunds(pool('analytics'), 'show', 'o');
    expect(open).toEqual([
      {
        id: req.refundId,
        bookingId: b.id,
        userId: 'u1',
        seatId: 'A1',
        amountMinor: 100000,
        currency: 'INR',
        state: 'requested',
      },
    ]);
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({ refundRequests: 1 });
    expect(provider.refunds.size).toBe(0); // nothing is paid back before approval

    // 2. only the organizer of THIS show can approve
    await expect(approveRefund(pool('booking'), req.refundId, 'someone-else')).rejects.toThrow(
      'not your event',
    );
    expect(provider.refunds.size).toBe(0);
    expect(await approveRefund(pool('booking'), req.refundId, 'o')).toEqual({
      refundId: req.refundId,
      state: 'APPROVED',
    });
    await approveRefund(pool('booking'), req.refundId, 'o'); // a double click
    await settle();

    // 3. the money moves once; 4. the ticket is void; 5. the seat is for sale again
    expect(provider.refunds.size).toBe(1);
    expect(await refundRows()).toEqual([
      { id: req.refundId, state: 'COMPLETED', amount_minor: '100000', automatic: false },
    ]);
    expect(published('refund.approved')).toHaveLength(1);
    expect(published('refund.completed')).toHaveLength(1);
    expect(published('ticket.voided')).toHaveLength(1);
    expect(
      (await pool('ticket').query('SELECT seat_id, status FROM tickets ORDER BY seat_id')).rows,
    ).toEqual([
      { seat_id: 'A1', status: 'void' },
      { seat_id: 'A2', status: 'valid' },
    ]);
    expect(await seatStates()).toMatchObject({ A1: 'available', A2: 'taken' });
    const released = published('seats.released');
    expect(released).toHaveLength(1);
    if (released[0]!.payload.case !== 'seatsReleased') throw new Error('wrong payload');
    expect(released[0]!.payload.value).toMatchObject({ seatIds: ['A1'], reason: 'refunded' });

    // everything downstream knows: dashboard, notification, door, booking
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({
      sold: 1,
      left: 5,
      refundRequests: 0,
    });
    expect((await getRefunds(pool('analytics'), 'show', 'o'))[0]!.state).toBe('completed');
    expect((await notificationRows()).map((n) => n.template)).toContain('refund-completed');
    expect(await checkIn(pool('ticket'), keys, t1!.qrToken, 'gate')).toEqual({ status: 'invalid' });
    expect(await checkIn(pool('ticket'), keys, t2!.qrToken, 'gate')).toMatchObject({
      status: 'valid',
    });
    expect(await bookingState(b.id)).toBe('CONFIRMED'); // a partial refund does not cancel the booking
    expect((await pool('booking').query('SELECT state FROM refunds')).rows).toEqual([
      { state: 'COMPLETED' },
    ]);

    // the freed seat can be bought again
    const again = await heldBooking(['A1'], 'bob');
    expect(await bookingState(again.id)).toBe('HELD');
    expect(dlq.messages).toHaveLength(0);
  });

  it('every event delivered twice: still one refund, one void, one release', async () => {
    broker.deliveries = 2;
    await completedBooking(['A1']);
    const [t] = await listTickets(pool('ticket'), keys, 'u1');
    const req = await requestRefund(pool('ticket'), t!.id, 'u1');
    await settle();
    await approveRefund(pool('booking'), req.refundId, 'o');
    await settle();
    expect(provider.refunds.size).toBe(1);
    expect(published('refund.completed')).toHaveLength(1);
    expect(published('ticket.voided')).toHaveLength(1);
    expect(published('seats.released')).toHaveLength(1);
    expect(await refundRows()).toHaveLength(1);
  });

  it('with an asynchronous provider the refund waits for its webhook, then finishes the same way', async () => {
    provider.refundMode = 'async';
    await completedBooking(['A1']);
    const [t] = await listTickets(pool('ticket'), keys, 'u1');
    const req = await requestRefund(pool('ticket'), t!.id, 'u1');
    await settle();
    await approveRefund(pool('booking'), req.refundId, 'o');
    await settle();
    expect(await refundRows()).toEqual([
      { id: req.refundId, state: 'PENDING', amount_minor: '100000', automatic: false },
    ]);
    expect(await seatStates()).toMatchObject({ A1: 'taken' }); // not returned until the money is

    const hook = provider.buildRefundWebhook(req.refundId);
    await handleWebhook(payDeps(), Buffer.from(hook.body), hook.headers);
    await handleWebhook(payDeps(), Buffer.from(hook.body), hook.headers); // provider retries
    await settle();
    expect(await seatStates()).toMatchObject({ A1: 'available' });
    expect(published('refund.completed')).toHaveLength(1);
    expect((await pool('ticket').query('SELECT status FROM tickets')).rows).toEqual([
      { status: 'void' },
    ]);
  });

  it('a ticket cannot be refunded after it was used, and a used refund request cannot be scanned', async () => {
    await completedBooking(['A1', 'A2']);
    const [t1, t2] = await listTickets(pool('ticket'), keys, 'u1');
    await checkIn(pool('ticket'), keys, t1!.qrToken, 'gate');
    await expect(requestRefund(pool('ticket'), t1!.id, 'u1')).rejects.toMatchObject({
      code: 'used',
    });
    await requestRefund(pool('ticket'), t2!.id, 'u1');
    expect(await checkIn(pool('ticket'), keys, t2!.qrToken, 'gate')).toEqual({ status: 'invalid' });
    expect(provider.refunds.size).toBe(0);
  });

  it('refunds can never add up to more than was paid', async () => {
    await completedBooking(['A1', 'A2']);
    const tickets = await listTickets(pool('ticket'), keys, 'u1');
    for (const t of tickets) {
      const req = await requestRefund(pool('ticket'), t.id, 'u1');
      await settle();
      await approveRefund(pool('booking'), req.refundId, 'o');
      await settle();
    }
    expect(provider.refunds.size).toBe(2);
    const total = await pool('payment').query('SELECT sum(amount_minor) AS t FROM refunds');
    expect(Number(total.rows[0].t)).toBe(200000); // exactly what was paid
    expect(await seatStates()).toMatchObject({ A1: 'available', A2: 'available' });
  });
});

describe('DEAD-LETTER REPLAY', () => {
  it('a poisoned message waits in the DLQ; after the fix, replaying it completes the saga, and replaying again changes nothing', async () => {
    failNext['seats.held'] = 99; // booking cannot process seats.held: a bug, say
    const b = await request(['A5']);
    await settle();
    expect(await bookingState(b.id)).toBe('REQUESTED');
    const dead = dlq.records('booking.dlq');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.headers).toMatchObject({
      'x-dlq-original-topic': 'seats.held',
      'x-dlq-consumer': 'booking',
    });

    failNext['seats.held'] = 0; // the fix is deployed

    // a dry run changes nothing
    const dry = await replayRecords(
      dead,
      async (m) => broker.publishBatch([{ ...m, key: m.key ?? '' }]),
      { dryRun: true },
    );
    expect(dry.replayed).toHaveLength(1);
    await settle();
    expect(await bookingState(b.id)).toBe('REQUESTED');

    // the real replay
    const publish = async (m: {
      topic: string;
      key: string | null;
      value: Uint8Array;
      headers: Record<string, string>;
    }) => broker.publishBatch([{ ...m, key: m.key ?? '' }]);
    const report = await replayRecords(dead, publish);
    expect(report.replayed).toHaveLength(1);
    await settle();
    expect(await bookingState(b.id)).toBe('HELD');

    // the replay also reached every other consumer of seats.held (payment, analytics): all ignored it
    const payables = await pool('payment').query('SELECT count(*) FROM payables');
    expect(payables.rows[0].count).toBe('1');
    expect(await getSummary(pool('analytics'), 'show', 'o')).toMatchObject({ held: 1 });
    expect(published('seats.held')).toHaveLength(2); // original + replay on the wire
    expect(await transitionsOf(b.id)).toEqual(['>REQUESTED', 'REQUESTED>HELD']); // but applied once

    // replaying the same dead letters again is harmless
    await replayRecords(dead, publish);
    await settle();
    expect(await bookingState(b.id)).toBe('HELD');
    expect(await transitionsOf(b.id)).toEqual(['>REQUESTED', 'REQUESTED>HELD']);
    expect(
      (await getActivity(pool('analytics'), 'show', 'o')).filter((f) => f.type === 'seats.held'),
    ).toHaveLength(1);
  });
});
