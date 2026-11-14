import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  bookingHandler,
  CONSUMED_TOPICS as BOOKING_TOPICS,
  approveRefund,
  createBooking,
} from '@gatepass/booking';
import { buildSeatMap, createEvent } from '@gatepass/catalog';
import { migrate } from '@gatepass/db';
import { CONSUMED_TOPICS as ANALYTICS_TOPICS, analyticsHandler } from '@gatepass/analytics';
import {
  createMessageHandler,
  replayRecords,
  type DeadLetterPublisher,
  type DlqRecord,
} from '@gatepass/messaging';
import {
  CONSUMED_TOPICS as NOTIFICATION_TOPICS,
  notificationHandler,
} from '@gatepass/notification';
import { OutboxRelay, type EventPublisher } from '@gatepass/outbox';
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
  seatInventoryHandler,
  sweepExpiredHolds,
} from '@gatepass/seat-inventory';
import {
  CONSUMED_TOPICS as TICKET_TOPICS,
  QrKeyRing,
  checkIn,
  listTickets,
  requestRefund,
  ticketHandler,
} from '@gatepass/ticket';
import {
  InMemoryBroker,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from '@gatepass/testing';
import { checkInvariants, type SystemPools } from './src/invariants';
import { chance, mulberry32, pick } from './src/rng';

jest.setTimeout(600_000);

/**
 * CHAOS. A whole booking system (all services, real databases, the real outbox relays and consumer
 * pipeline, an in-memory broker) is driven by random users while being abused:
 *
 *   - a handler "crashes" before it did anything, or AFTER it committed (so the message is redelivered)
 *   - a relay "crashes" after the broker accepted a batch but before it marked it sent
 *   - the broker goes down; every message is sometimes delivered twice
 *   - webhooks arrive duplicated, late, and out of order; holds expire while payments are in flight
 *   - messages that keep failing are dead-lettered
 *
 * Then the abuse stops, the dead letters are replayed (the "service came back"), everything settles,
 * and checkInvariants() demands a perfectly consistent world: no double sale, every booking final,
 * every ticket matches a seat, and the money adds up to the cent. Seeds make a failure replayable:
 *   CHAOS_SEEDS=7 pnpm exec jest tests/chaos
 */

const services = [
  'catalog',
  'inventory',
  'booking',
  'payment',
  'ticket',
  'notification',
  'analytics',
] as const;
type Service = (typeof services)[number];
const root = join(__dirname, '..', '..', 'services');
const FAST = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };
const PRICE = 100_000; // 1,000 rupees a seat
const SEATS = 12; // few seats, many buyers: constant contention
const HOLD_TTL = 600_000;
const GRACE = 60_000;
const keys = new QrKeyRing('k1:' + 'c'.repeat(40));

let server: TestPostgres;
let dbs: Record<Service, TestDatabase>;
const pool = (s: Service): Pool => dbs[s].pool;

beforeAll(async () => {
  server = await startTestPostgres();
  dbs = {} as Record<Service, TestDatabase>;
  for (const s of services)
    dbs[s] = await server.createDatabase(s === 'inventory' || s === 'ticket' ? 30 : 10);
  const dirs: Record<Service, string> = {
    catalog: 'catalog',
    inventory: 'seat-inventory',
    booking: 'booking',
    payment: 'payment',
    ticket: 'ticket',
    notification: 'notification',
    analytics: 'analytics',
  };
  for (const s of services) await migrate(pool(s), join(root, dirs[s], 'migrations'));
});
afterAll(async () => {
  await Promise.all(Object.values(dbs ?? {}).map((d) => d.close()));
  await server?.stop();
});

class Dlq implements DeadLetterPublisher {
  records: DlqRecord[] = [];
  async publish(
    topic: string,
    m: { key: string | null; value: Uint8Array | null; headers: Record<string, string> },
  ) {
    this.records.push({ topic, partition: 0, offset: String(this.records.length), ...m });
  }
}

async function runOnce(seed: number): Promise<{
  violations: string[];
  stats: Record<string, number>;
  recheck: () => Promise<string[]>;
}> {
  const rand = mulberry32(seed);
  for (const s of services) await pool(s).query('TRUNCATE outbox, inbox RESTART IDENTITY');
  await pool('inventory').query('TRUNCATE seats');
  await pool('booking').query('TRUNCATE booking_transitions, refunds, bookings CASCADE');
  await pool('catalog').query('TRUNCATE seat_defs, event_tiers, events CASCADE');
  await pool('payment').query('TRUNCATE webhook_events, refunds, payments, payables CASCADE');
  await pool('ticket').query('TRUNCATE tickets, event_seats, events CASCADE');
  await pool('notification').query('TRUNCATE notifications RESTART IDENTITY');
  await pool('analytics').query('TRUNCATE activity, refunds, seat_status, events CASCADE');

  // ---- the system ----
  let clock = Date.now();
  const faults = {
    on: true,
    handlerBefore: 0.18,
    handlerAfter: 0.18,
    relayAfterPublish: 0.15,
    brokerDown: 0.08,
  };
  const broker = new InMemoryBroker();
  const dlq = new Dlq();
  const provider = new FakeProvider({ webhookSecret: 'whsec_chaos_secret_value' });
  const deps = { pool: pool('payment'), provider };

  const flakyPublisher: EventPublisher = {
    publishBatch: async (m) => {
      await broker.publishBatch(m);
      if (faults.on && chance(rand, faults.relayAfterPublish))
        throw new Error('relay crashed after publishing');
    },
  };
  const relays = services.map(
    (s) => new OutboxRelay({ pool: pool(s), publisher: flakyPublisher, lockName: s }),
  );

  const chaotic =
    (h: (e: import('@gatepass/events').EventEnvelope) => Promise<void>) =>
    async (e: import('@gatepass/events').EventEnvelope) => {
      if (faults.on && chance(rand, faults.handlerBefore))
        throw new Error('crashed before handling');
      await h(e);
      if (faults.on && chance(rand, faults.handlerAfter))
        throw new Error('crashed after committing');
    };
  const subscribe = (
    group: string,
    topics: string[],
    h: (e: import('@gatepass/events').EventEnvelope) => Promise<void>,
  ) =>
    broker.subscribe(
      topics,
      createMessageHandler({ groupId: group, handle: chaotic(h), dlq, retry: FAST }),
    );

  subscribe(
    'seat-inventory',
    INVENTORY_TOPICS,
    seatInventoryHandler(pool('inventory'), { holdTtlMs: HOLD_TTL, now: () => clock }),
  );
  subscribe('booking', BOOKING_TOPICS, bookingHandler(pool('booking')));
  subscribe('payment', PAYMENT_TOPICS, paymentHandler(pool('payment'), provider));
  subscribe('ticket', TICKET_TOPICS, ticketHandler(pool('ticket'), keys));
  subscribe(
    'notification',
    NOTIFICATION_TOPICS,
    notificationHandler(pool('notification'), () => {}),
  );
  subscribe('analytics', ANALYTICS_TOPICS, analyticsHandler(pool('analytics')));

  await createEvent(pool('catalog'), {
    id: 'show',
    organizerId: 'org',
    title: 'Show',
    category: 'Music',
    venue: 'Hall',
    startsAt: new Date(clock + 86_400_000),
    seats: buildSeatMap([{ label: 'A', tier: 'Front', priceMinor: PRICE }], SEATS),
  });

  // ---- helpers ----
  const pump = async (rounds: number) => {
    for (let i = 0; i < rounds; i++) {
      for (const r of relays) await r.pollOnce().catch(() => {});
      await broker.deliverPending();
    }
  };
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      let progress = 0;
      for (const r of relays) progress += await r.pollOnce().catch(() => 0);
      progress += await broker.deliverPending();
      if (progress === 0) return;
    }
    throw new Error('system never settled');
  };
  const sweep = (advanceMs = 0) => {
    clock += advanceMs;
    return sweepExpiredHolds(pool('inventory'), { now: () => clock, graceMs: GRACE });
  };

  const captured = new Set<string>(); // payments the provider really took money for
  const outcomeOf = new Map<string, 'succeeded' | 'failed'>(); // what the provider will report
  const paymentIds: string[] = [];
  const stats = {
    bookings: 0,
    paid: 0,
    failedPay: 0,
    refunds: 0,
    expiries: 0,
    duplicates: 0,
    dlq: 0,
  };

  const sendWebhook = async (
    paymentId: string,
    outcome: 'succeeded' | 'failed',
    eventId?: string,
  ) => {
    const hook = provider.buildWebhook(paymentId, outcome, { eventId });
    await handleWebhook(deps, Buffer.from(hook.body), hook.headers).catch(() => {});
  };

  // ---- the random workload ----
  const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  const seatNames = Array.from({ length: SEATS }, (_, i) => `A${i + 1}`);
  const steps = 70;
  for (let step = 0; step < steps; step++) {
    broker.down = faults.on && chance(rand, faults.brokerDown);
    broker.deliveries = faults.on && chance(rand, 0.2) ? 2 : 1;
    const action = rand();

    if (action < 0.3) {
      // a buyer asks for 1-3 seats (heavy overlap)
      const want = 1 + Math.floor(rand() * 3);
      const seatIds = [...new Set(Array.from({ length: want }, () => pick(rand, seatNames)))];
      await createBooking(pool('booking'), {
        eventId: 'show',
        userId: pick(rand, users),
        seatIds,
      }).catch(() => {});
      stats.bookings++;
    } else if (action < 0.55) {
      // someone with a held booking pays (or tries to)
      const held = (
        await pool('booking').query("SELECT id, user_id FROM bookings WHERE state = 'HELD'")
      ).rows;
      if (held.length) {
        const b = pick(rand, held);
        const token = pick(rand, [
          FAKE_TOKENS.success,
          FAKE_TOKENS.success,
          FAKE_TOKENS.success,
          FAKE_TOKENS.declined,
          FAKE_TOKENS.rejected,
        ]);
        const r = await startPayment(
          deps,
          {
            bookingId: b.id,
            userId: b.user_id,
            method: 'upi',
            token,
            idempotencyKey: `idem-${b.id}-${step}-0001`,
          },
          () => new Date(clock),
        ).catch(() => undefined);
        if (r) {
          paymentIds.push(r.paymentId);
          const outcome = FakeProvider.outcomeFor(token);
          outcomeOf.set(r.paymentId, token === FAKE_TOKENS.rejected ? 'failed' : outcome);
          if (r.status === 'failed') stats.failedPay++;
          else stats.paid++;
        }
        if (r && chance(rand, 0.3))
          await startPayment(
            deps,
            {
              bookingId: b.id,
              userId: b.user_id,
              method: 'upi',
              token,
              idempotencyKey: `idem-${b.id}-${step}-0001`,
            },
            () => new Date(clock),
          ).catch(() => {}); // a double click
      }
    } else if (action < 0.7) {
      // the provider reports on a payment (maybe twice, maybe late, maybe a stray contradiction)
      const pending = [...outcomeOf].filter(([id]) => paymentIds.includes(id));
      if (pending.length) {
        const [id, outcome] = pick(rand, pending);
        if (outcome === 'succeeded') captured.add(id);
        const eventId = `evt-${id}-${outcome}`;
        await sendWebhook(id, outcome, eventId);
        if (chance(rand, 0.4)) {
          await sendWebhook(id, outcome, eventId); // exact duplicate
          stats.duplicates++;
        }
        if (outcome === 'succeeded' && chance(rand, 0.15))
          await sendWebhook(id, 'failed', `evt-${id}-stray`);
      }
    } else if (action < 0.8) {
      // time passes, and holds expire, possibly while a payment is still in flight
      stats.expiries += await sweep(pick(rand, [30_000, 200_000, HOLD_TTL + GRACE + 1000]));
    } else if (action < 0.88) {
      // a buyer asks for a refund of one of their tickets; the organizer sometimes approves
      const confirmed = (
        await pool('booking').query("SELECT user_id FROM bookings WHERE state = 'CONFIRMED'")
      ).rows;
      if (confirmed.length) {
        const user = pick(rand, confirmed).user_id as string;
        const mine = (await listTickets(pool('ticket'), keys, user)).filter(
          (t) => t.status === 'valid',
        );
        if (mine.length) {
          await requestRefund(pool('ticket'), pick(rand, mine).id, user)
            .then(() => stats.refunds++)
            .catch(() => {});
        }
      }
    } else if (action < 0.93) {
      const open = (await pool('booking').query("SELECT id FROM refunds WHERE state = 'REQUESTED'"))
        .rows;
      if (open.length)
        await approveRefund(pool('booking'), pick(rand, open).id, 'org').catch(() => {});
    } else if (action < 0.96) {
      // a door scan of any ticket
      const any = (await pool('ticket').query('SELECT user_id FROM tickets LIMIT 20')).rows;
      if (any.length) {
        const t = pick(rand, await listTickets(pool('ticket'), keys, pick(rand, any).user_id));
        if (t) await checkIn(pool('ticket'), keys, t.qrToken, 'gate').catch(() => {});
      }
    }
    await pump(1 + Math.floor(rand() * 3)); // some progress between actions, never "until quiet"
  }

  // ---- the abuse stops; services come back; dead letters are replayed ----
  faults.on = false;
  broker.down = false;
  broker.deliveries = 1;
  await settle();
  stats.dlq = dlq.records.length;
  const replayOnce = async () => {
    const records = dlq.records.splice(0);
    await replayRecords(records, async (m) => broker.publishBatch([{ ...m, key: m.key ?? '' }]));
    await settle();
  };
  await replayOnce();
  expect(dlq.records).toHaveLength(0); // with the faults gone, nothing fails again

  // the provider reports every payment it still owes us a report on, then the clock runs out for every hold
  for (const [id, outcome] of outcomeOf) {
    if (outcome === 'succeeded') captured.add(id);
    await sendWebhook(id, outcome, `evt-${id}-${outcome}`);
  }
  await settle();
  await sweep(HOLD_TTL + GRACE + 1000);
  await settle();
  // a payment that lost its race to the sweep is refunded on the way, which can finish more work
  await sweep(HOLD_TTL + GRACE + 1000);
  await settle();
  // anything the organizer left open is approved so the refund saga also reaches its end
  for (const r of (await pool('booking').query("SELECT id FROM refunds WHERE state = 'REQUESTED'"))
    .rows) {
    await approveRefund(pool('booking'), r.id, 'org');
  }
  await settle();

  const pools: SystemPools = {
    inventory: pool('inventory'),
    booking: pool('booking'),
    payment: pool('payment'),
    ticket: pool('ticket'),
    analytics: pool('analytics'),
    outboxes: services.map(pool),
  };
  const recheck = () =>
    checkInvariants(pools, {
      eventId: 'show',
      organizerId: 'org',
      seatPriceMinor: PRICE,
      totalSeats: SEATS,
      captured,
    });
  return { violations: await recheck(), stats, recheck };
}

describe('the invariant checker is not vacuous: it catches real corruption', () => {
  it('flags a double sale, a lost ticket, a phantom refund and missing money in an otherwise healthy run', async () => {
    // pick a run that ended with something to corrupt (a sold seat, a ticket, a payment)
    let run: Awaited<ReturnType<typeof runOnce>> | undefined;
    let sold: { seat_id: string; booking_id: string } | undefined;
    for (let seed = 1; seed <= 20 && !sold; seed++) {
      run = await runOnce(seed);
      sold = (
        await pool('inventory').query(
          "SELECT seat_id, booking_id FROM seats WHERE state = 'sold' LIMIT 1",
        )
      ).rows[0];
    }
    if (!sold || !run) throw new Error('no seed in 1..20 ended with a sold seat');
    const { violations, recheck } = run;
    expect(violations).toEqual([]);

    // 1. a seat sold to a booking that does not exist
    await pool('inventory').query("UPDATE seats SET booking_id = 'ghost' WHERE seat_id = $1", [
      sold.seat_id,
    ]);
    expect((await recheck()).join('\n')).toMatch(/sold to an unknown booking ghost/);
    await pool('inventory').query('UPDATE seats SET booking_id = $2 WHERE seat_id = $1', [
      sold.seat_id,
      sold.booking_id,
    ]);
    expect(await recheck()).toEqual([]);

    // 2. a lost ticket
    const ticket = (await pool('ticket').query('SELECT id FROM tickets LIMIT 1')).rows[0];
    await pool('ticket').query('DELETE FROM tickets WHERE id = $1', [ticket.id]);
    expect((await recheck()).join('\n')).toMatch(/tickets for \d+ seats/);

    // 3. money that does not add up (a payment with no matching sale)
    const pay = (
      await pool('payment').query("SELECT id FROM payments WHERE state = 'SUCCEEDED' LIMIT 1")
    ).rows[0];
    await pool('payment').query(
      'UPDATE payments SET amount_minor = amount_minor + 100 WHERE id = $1',
      [pay.id],
    );
    expect((await recheck()).join('\n')).toMatch(/money: paid/);
    await pool('payment').query(
      'UPDATE payments SET amount_minor = amount_minor - 100 WHERE id = $1',
      [pay.id],
    );

    // 4. a booking stuck half-way
    await pool('booking').query(
      "UPDATE bookings SET state = 'HELD' WHERE id = (SELECT id FROM bookings LIMIT 1)",
    );
    expect((await recheck()).join('\n')).toMatch(/stuck in HELD/);

    // 5. an event nobody sent
    await pool('inventory').query(
      "INSERT INTO outbox (event_id, event_type, aggregate_id, correlation_id, version, payload) VALUES (gen_random_uuid(), 'seats.held', 'x', 'x', 1, '\\x00')",
    );
    expect((await recheck()).join('\n')).toMatch(/unpublished events/);
  });
});

const seedCount = Number(process.env.CHAOS_SEEDS ?? 8);
const seeds = process.env.CHAOS_SEED
  ? [Number(process.env.CHAOS_SEED)]
  : Array.from({ length: seedCount }, (_, i) => i + 1);

describe('CHAOS: crashes, duplicates, outages, late and reordered webhooks, expiry races', () => {
  for (const seed of seeds) {
    it(`seed ${seed}: ends fully consistent`, async () => {
      const { violations, stats } = await runOnce(seed);
      console.log(`seed ${seed}: ${JSON.stringify(stats)}`);
      expect({ seed, violations }).toEqual({ seed, violations: [] });
    });
  }
});
