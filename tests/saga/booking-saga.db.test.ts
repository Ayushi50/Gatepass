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

class Dlq implements DeadLetterPublisher {
  messages: { topic: string }[] = [];
  async publish(topic: string) {
    this.messages.push({ topic });
  }
}

let server: TestPostgres;
let dbs: Record<'catalog' | 'inventory' | 'booking', TestDatabase>;
let broker: InMemoryBroker;
let relays: OutboxRelay[];
let dlq: Dlq;
let failNextSeatsHeld = 0;

const pool = (n: keyof typeof dbs): Pool => dbs[n].pool;

/** Moves events along until the whole system is quiet: relays publish, the broker delivers. */
async function settle(maxRounds = 50): Promise<void> {
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
  };
  await migrate(pool('catalog'), join(root, 'catalog', 'migrations'));
  await migrate(pool('inventory'), join(root, 'seat-inventory', 'migrations'));
  await migrate(pool('booking'), join(root, 'booking', 'migrations'));
});

afterAll(async () => {
  await Promise.all(Object.values(dbs).map((d) => d.close()));
  await server.stop();
});

beforeEach(async () => {
  for (const n of ['catalog', 'inventory', 'booking'] as const) {
    await pool(n).query('TRUNCATE outbox, inbox RESTART IDENTITY');
  }
  await pool('inventory').query('TRUNCATE seats');
  await pool('booking').query('TRUNCATE booking_transitions, bookings');
  await pool('catalog').query('TRUNCATE seat_defs, event_tiers, events CASCADE');

  dlq = new Dlq();
  broker = new InMemoryBroker();
  failNextSeatsHeld = 0;
  relays = (['catalog', 'inventory', 'booking'] as const).map(
    (n) => new OutboxRelay({ pool: pool(n), publisher: broker, lockName: n }),
  );

  const inventory = seatInventoryHandler(pool('inventory'), { holdTtlMs: 600_000 });
  broker.subscribe(
    INVENTORY_TOPICS,
    createMessageHandler({
      groupId: 'seat-inventory',
      handle: (e) => inventory(e),
      dlq,
      retry: FAST,
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
        if (e.eventType === 'seats.held' && failNextSeatsHeld > 0) {
          failNextSeatsHeld--;
          throw new Error('simulated crash while handling seats.held');
        }
        await booking(e);
      },
    }),
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
    // about ten minutes ahead of "now", computed by the server
    const ahead = Date.parse(after.holdExpiresAt!) - Date.now();
    expect(ahead).toBeGreaterThan(590_000);
    expect(ahead).toBeLessThanOrEqual(600_000);

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
    expect(seats.find((s) => s.id === 'A3')!.state).toBe('available'); // nothing half-held

    const cancelled = published('booking.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.correlationId).toBe(second.id);
    const failed = published('seats.hold_failed')[0]!;
    expect(cancelled[0]!.causationId).toBe(failed.eventId);
  });
});

describe('at-least-once delivery', () => {
  it('delivering every event twice changes nothing', async () => {
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
    const transitions = await pool('booking').query(
      'SELECT count(*) FROM booking_transitions WHERE booking_id=$1',
      [ok.id],
    );
    expect(transitions.rows[0].count).toBe('2'); // ->REQUESTED, REQUESTED>HELD
  });
});

describe('resumable saga', () => {
  it('a consumer failing mid-saga is retried and the booking still reaches HELD', async () => {
    failNextSeatsHeld = 2; // fails twice, third attempt succeeds (within FAST.maxAttempts)
    const b = await request(['A4']);
    await settle();
    expect((await getBooking(pool('booking'), b.id)).state).toBe('HELD');
    expect(dlq.messages).toHaveLength(0);
  });

  it('a message that keeps failing is dead-lettered, and the booking stays REQUESTED, not lost', async () => {
    failNextSeatsHeld = 99;
    const b = await request(['A5']);
    await settle();
    expect((await getBooking(pool('booking'), b.id)).state).toBe('REQUESTED');
    expect(dlq.messages).toEqual([{ topic: 'booking.dlq' }]);
  });

  it('a broker outage loses nothing: events wait in the outbox and the saga completes after', async () => {
    broker.down = true;
    const b = await request(['A6']);
    await settle(3); // relays try, broker refuses
    expect((await getBooking(pool('booking'), b.id)).state).toBe('REQUESTED');
    const pending = await pool('booking').query(
      'SELECT count(*) FROM outbox WHERE published_at IS NULL',
    );
    expect(Number(pending.rows[0].count)).toBeGreaterThan(0);

    broker.down = false;
    await settle();
    expect((await getBooking(pool('booking'), b.id)).state).toBe('HELD');
  });
});
