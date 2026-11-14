import 'reflect-metadata';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { migrate } from '@gatepass/db';
import { decodeEnvelope } from '@gatepass/events';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import {
  ConflictError,
  DEMO_EVENTS,
  ValidationError,
  buildSeatMap,
  createEvent,
  getEvent,
  listEvents,
} from '../src';
import { CatalogModule } from '../src/http/catalog.module';

jest.setTimeout(120_000);

let server: TestPostgres;
let db: TestDatabase;
let app: INestApplication;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase();
  await migrate(db.pool, join(__dirname, '..', 'migrations'));
  const mod = await Test.createTestingModule({
    imports: [CatalogModule.forPool(db.pool)],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app?.close();
  await db.close();
  await server.stop();
});

const small = (id: string) => ({
  id,
  organizerId: 'o1',
  title: 'Small Show',
  category: 'Music',
  venue: 'Hall',
  startsAt: new Date('2026-12-01T18:00:00Z'),
  seats: buildSeatMap(
    [
      { label: 'A', tier: 'Front', priceMinor: 100_00 },
      { label: 'B', tier: 'Back', priceMinor: 50_00 },
    ],
    3,
  ),
});

describe('seat map', () => {
  it('builds ids, rows and tiers', () => {
    const seats = small('x').seats;
    expect(seats).toHaveLength(6);
    expect(seats[0]).toMatchObject({ seatId: 'A1', row: 'A', number: 1, tier: 'Front' });
    expect(seats[5]).toMatchObject({ seatId: 'B3', tier: 'Back', priceMinor: 5000 });
  });
});

describe('createEvent', () => {
  it('stores the event and publishes event.published with the full seat map, atomically', async () => {
    await createEvent(db.pool, small('small-1'));

    const ev = await getEvent(db.pool, 'small-1');
    expect(ev).toMatchObject({ id: 'small-1', minPriceMinor: 5000, currency: 'INR' });
    expect(ev.tiers).toEqual([
      { name: 'Front', priceMinor: 10000, seatCount: 3 },
      { name: 'Back', priceMinor: 5000, seatCount: 3 },
    ]);

    const out = await db.pool.query(
      "SELECT payload, aggregate_id FROM outbox WHERE event_type = 'event.published'",
    );
    expect(out.rowCount).toBe(1);
    const env = decodeEnvelope(out.rows[0].payload);
    expect(env.correlationId).toBe('small-1');
    expect(env.producer).toBe('catalog');
    if (env.payload.case !== 'eventPublished') throw new Error('wrong payload');
    expect(env.payload.value.seats).toHaveLength(6);
    expect(env.payload.value.seats[0]).toMatchObject({ seatId: 'A1', tier: 'Front' });
  });

  it('rejects a duplicate id and leaves no partial data or event behind', async () => {
    await createEvent(db.pool, small('dup'));
    await expect(createEvent(db.pool, small('dup'))).rejects.toBeInstanceOf(ConflictError);
    const seats = await db.pool.query("SELECT 1 FROM seat_defs WHERE event_id = 'dup'");
    expect(seats.rowCount).toBe(6);
    const out = await db.pool.query(
      "SELECT 1 FROM outbox WHERE aggregate_id = 'dup' AND event_type = 'event.published'",
    );
    expect(out.rowCount).toBe(1);
  });

  it('rejects an event with no seats or no title', async () => {
    await expect(createEvent(db.pool, { ...small('e1'), seats: [] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createEvent(db.pool, { ...small('e2'), title: ' ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('demo events (design/events.html)', () => {
  it('has the five shows with an A-F, 14-per-row layout and three tiers', () => {
    expect(DEMO_EVENTS.map((e) => e.title)).toEqual([
      'Neon Nights Live',
      'The Laugh Lab',
      'Campus Fest Finale',
      'Jazz on the Roof',
      'Midnight Market',
    ]);
    for (const e of DEMO_EVENTS) {
      expect(e.seats).toHaveLength(6 * 14);
      expect([...new Set(e.seats.map((s) => s.tier))]).toEqual(['Front', 'Mid', 'Back']);
    }
    const neon = DEMO_EVENTS[0]!;
    expect(neon.seats.find((s) => s.seatId === 'C6')).toMatchObject({
      tier: 'Mid',
      priceMinor: 180000,
    });
  });

  it('publishes all five and lists them in date order with "from" prices', async () => {
    for (const e of DEMO_EVENTS) await createEvent(db.pool, e);
    const list = (await listEvents(db.pool)).filter((e) => DEMO_EVENTS.some((d) => d.id === e.id));
    expect(list.map((e) => e.id)).toEqual([
      'neon-nights',
      'laugh-lab',
      'campus-fest',
      'jazz-roof',
      'midnight-market',
    ]);
    expect(list.map((e) => e.minPriceMinor / 100)).toEqual([1200, 600, 499, 900, 350]);
  });
});

describe('HTTP', () => {
  it('GET /events returns summaries', async () => {
    const res = await request(app.getHttpServer()).get('/events').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        title: expect.any(String),
        tiers: expect.any(Array),
      }),
    );
  });
  it('GET /events/:id returns one, 404 for unknown', async () => {
    await request(app.getHttpServer()).get('/events/neon-nights').expect(200);
    await request(app.getHttpServer()).get('/events/nope').expect(404);
  });
});
