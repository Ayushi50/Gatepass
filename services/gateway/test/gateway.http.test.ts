import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  DownstreamError,
  GatewayModule,
  SeatStreamHub,
  signToken,
  type BookingClient,
  type BookingView,
  type CatalogClient,
  type InventoryClient,
} from '../src';

const SECRET = 'a-test-secret-that-is-long-enough-123';
const token = (role: 'attendee' | 'organizer' | 'door-staff', sub = 'alice') =>
  `Bearer ${signToken({ sub, role }, SECRET)}`;

const booking = (over: Partial<BookingView> = {}): BookingView => ({
  id: 'bk-1',
  eventId: 'neon-nights',
  userId: 'alice',
  seatIds: ['C6', 'C7'],
  state: 'HELD',
  holdExpiresAt: '2026-12-06T10:10:00.000Z',
  cancelReason: null,
  serverTime: '2026-12-06T10:00:00.000Z',
  ...over,
});

const ev = (id: string, title: string, minPriceMinor: number) => ({
  id,
  title,
  category: 'Music',
  venue: 'Hall',
  startsAt: '2026-12-06T14:00:00.000Z',
  currency: 'INR',
  minPriceMinor,
  tiers: [],
});

let app: INestApplication;
let hub: SeatStreamHub;
const createCalls: unknown[] = [];

const catalog: CatalogClient = {
  listEvents: async () => [
    ev('neon-nights', 'Neon Nights Live', 120000),
    ev('jazz-roof', 'Jazz on the Roof', 90000),
    ev('laugh-lab', 'The Laugh Lab', 60000),
  ],
};
const inventory: InventoryClient = {
  getAvailability: async () => [
    { eventId: 'neon-nights', total: 84, available: 30 },
    { eventId: 'jazz-roof', total: 84, available: 0 },
    { eventId: 'laugh-lab', total: 84, available: 84 },
  ],
  getSeats: async (id) => {
    if (id === 'missing') throw new DownstreamError(404, 'no seats for event missing');
    return [{ id: 'A1', row: 'A', number: 1, tier: 'Front', price: 2400, state: 'available' }];
  },
};
const bookings: BookingClient = {
  create: async (input) => {
    createCalls.push(input);
    if (!input.seatIds?.length)
      throw new DownstreamError(400, 'seatIds must be a non-empty list of seat ids');
    return booking({ userId: input.userId });
  },
  get: async (id) => {
    if (id === 'theirs') return booking({ userId: 'someone-else' });
    if (id === 'down') throw new DownstreamError(503, 'unreachable');
    if (id !== 'bk-1') throw new DownstreamError(404, 'not found');
    return booking();
  },
};

beforeAll(async () => {
  hub = new SeatStreamHub();
  const mod = await Test.createTestingModule({
    imports: [
      GatewayModule.forRoot({
        catalog,
        inventory,
        bookings,
        hub,
        jwtSecret: SECRET,
        heartbeatMs: 60_000,
      }),
    ],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app.close();
});

describe('GET /api/events', () => {
  it('lists the shows with live status and a major-unit "from" price', async () => {
    const res = await request(app.getHttpServer()).get('/api/events').expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: 'neon-nights',
        title: 'Neon Nights Live',
        minPrice: 1200,
        status: 'selling_fast',
        availability: { total: 84, available: 30 },
      }),
      expect.objectContaining({ id: 'jazz-roof', minPrice: 900, status: 'sold_out' }),
      expect.objectContaining({ id: 'laugh-lab', minPrice: 600, status: 'available' }),
    ]);
  });
});

describe('GET /api/events/:id/seats', () => {
  it('returns the seat map in the shape the UI expects', async () => {
    const res = await request(app.getHttpServer()).get('/api/events/neon-nights/seats').expect(200);
    expect(res.body[0]).toEqual({
      id: 'A1',
      row: 'A',
      number: 1,
      tier: 'Front',
      price: 2400,
      state: 'available',
    });
  });
  it('maps an unknown event to 404', async () => {
    await request(app.getHttpServer()).get('/api/events/missing/seats').expect(404);
  });
});

describe('POST /api/bookings', () => {
  it('requires a token', async () => {
    await request(app.getHttpServer())
      .post('/api/bookings')
      .send({ eventId: 'e', seatIds: ['A1'] })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', 'Bearer garbage')
      .send({})
      .expect(401);
  });

  it('is for attendees only', async () => {
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', token('door-staff'))
      .send({ eventId: 'e', seatIds: ['A1'] })
      .expect(403);
  });

  it('takes the user from the token, ignoring any userId in the body', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', token('attendee', 'alice'))
      .send({ eventId: 'neon-nights', seatIds: ['C6', 'C7'], userId: 'mallory' })
      .expect(201);
    expect(createCalls.at(-1)).toEqual({
      eventId: 'neon-nights',
      seatIds: ['C6', 'C7'],
      userId: 'alice',
    });
    expect(res.body).toMatchObject({ id: 'bk-1', userId: 'alice' });
  });

  it('passes validation errors through as 400', async () => {
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', token('attendee'))
      .send({ eventId: 'e', seatIds: [] })
      .expect(400);
  });
});

describe('GET /api/bookings/:id', () => {
  it('returns holdExpiresAt and serverTime to the owner', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/bookings/bk-1')
      .set('Authorization', token('attendee', 'alice'))
      .expect(200);
    expect(res.body).toMatchObject({
      state: 'HELD',
      holdExpiresAt: '2026-12-06T10:10:00.000Z',
      serverTime: '2026-12-06T10:00:00.000Z',
    });
  });
  it("hides other people's bookings (403), unknown ids (404) and reports outages (503)", async () => {
    const auth = token('attendee', 'alice');
    await request(app.getHttpServer())
      .get('/api/bookings/theirs')
      .set('Authorization', auth)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/bookings/unknown')
      .set('Authorization', auth)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/bookings/down')
      .set('Authorization', auth)
      .expect(503);
    await request(app.getHttpServer()).get('/api/bookings/bk-1').expect(401);
  });
});

describe('SSE /api/events/:id/seats/stream', () => {
  it("pushes only that event's seat changes to the browser as they happen", async () => {
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events/neon-nights/seats/stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!received.includes(needle)) {
        if (Date.now() > deadline)
          throw new Error(`timeout waiting for ${needle}; got ${received}`);
        const { value } = await reader.read();
        received += decoder.decode(value);
      }
    };

    while (hub.observers === 0) await new Promise((r) => setTimeout(r, 10)); // subscribed
    hub.publish({ eventId: 'other-show', seatId: 'Z9', state: 'held' }); // must not appear
    hub.publish({ eventId: 'neon-nights', seatId: 'C6', state: 'held' });
    hub.publish({ eventId: 'neon-nights', seatId: 'C6', state: 'taken' });

    await readUntil('"state":"taken"');
    expect(received).toContain('data: {"seatId":"C6","state":"held"}');
    expect(received).toContain('data: {"seatId":"C6","state":"taken"}');
    expect(received).not.toContain('Z9');
    controller.abort();
  });
});
