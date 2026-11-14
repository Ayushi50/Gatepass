import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ActivityStreamHub,
  BookingStreamHub,
  DownstreamError,
  GatewayModule,
  SeatStreamHub,
  signToken,
  type BookingClient,
  type BookingView,
  type CatalogClient,
  type InventoryClient,
  type AnalyticsClient,
  type PaymentClient,
  type TicketClient,
  WaitingRoom,
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
  waitingRoom: false,
  minPriceMinor,
  tiers: [],
});

let app: INestApplication;
let hub: SeatStreamHub;
let bookingHub: BookingStreamHub;
let activityHub: ActivityStreamHub;
const scans: unknown[] = [];
let ticketsIssued = false;
const createCalls: unknown[] = [];
const payCalls: unknown[] = [];

const catalog: CatalogClient = {
  getEvent: async (id) => ({ ...ev(id, id, 100000) }),
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
  approveRefund: async (refundId) => ({ refundId, state: 'APPROVED' }),
  create: async (input) => {
    createCalls.push(input);
    if (!input.seatIds?.length)
      throw new DownstreamError(400, 'seatIds must be a non-empty list of seat ids');
    return booking({ userId: input.userId });
  },
  get: async (id) => {
    if (id === 'theirs') return booking({ userId: 'someone-else' });
    if (id === 'confirmed') return booking({ id: 'confirmed', state: 'CONFIRMED' });
    if (id === 'down') throw new DownstreamError(503, 'unreachable');
    if (id !== 'bk-1') throw new DownstreamError(404, 'not found');
    return booking();
  },
};

const payments: PaymentClient = {
  pay: async (input) => {
    payCalls.push(input);
    if (input.method === 'cash')
      throw new DownstreamError(400, 'method must be one of upi, card, netbanking');
    if (input.idempotencyKey === 'conflict-key-0001')
      throw new DownstreamError(409, 'this booking already has a payment');
    if (input.idempotencyKey === 'reused-key-00001')
      throw new DownstreamError(422, 'Idempotency-Key was already used for a different request');
    return { paymentId: 'pay-1', status: 'processing' };
  },
};

/** Reads an SSE response until `needle` appears, then returns everything read so far. */
async function readSse(res: Response, needle: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const deadline = Date.now() + 5000;
  while (!received.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${needle}; got ${received}`);
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
  }
  reader.releaseLock();
  return received;
}

const ticketRow = (id: string, status: 'valid' | 'used' = 'valid') => ({
  id,
  code: `GP-7QX2-${id}`,
  bookingId: 'bk-1',
  eventId: 'neon-nights',
  eventTitle: 'Neon Nights Live',
  startsAt: '2026-12-06T14:00:00.000Z',
  venue: 'Open Air Arena',
  row: 'C',
  seat: '6',
  tier: 'Mid',
  qrToken: `GP1.${id}.sig`,
  status,
});
const tickets: TicketClient = {
  requestRefund: async () => ({ refundId: 'rf-1', status: 'refund_requested' }),
  list: async (userId) => (userId === 'alice' ? [ticketRow('C6'), ticketRow('C7')] : []),
  forBooking: async () => ({ issued: ticketsIssued, count: ticketsIssued ? 2 : 0 }),
  checkIn: async (qrToken, staffId) => {
    scans.push({ qrToken, staffId });
    if (qrToken === 'GP1.good.sig')
      return { httpStatus: 200, body: { status: 'valid', row: 'C', seat: '6', tier: 'Mid' } };
    if (qrToken === 'GP1.used.sig')
      return { httpStatus: 409, body: { status: 'used', usedAt: '2026-12-06T13:00:00.000Z' } };
    if (qrToken === 'GP1.boom.sig') throw new DownstreamError(503, 'unreachable');
    return { httpStatus: 404, body: { status: 'invalid' } };
  },
};
const feedItem = (id: string, text: string) => ({
  id,
  eventId: 'neon-nights',
  bookingId: 'bk-1',
  type: 'seats.sold',
  text,
  failed: false,
  at: '2026-12-06T10:00:00.000Z',
});
const analytics: AnalyticsClient = {
  refunds: async () => [],
  summary: async (eventId, organizerId) => {
    if (eventId === 'unknown') throw new DownstreamError(404, 'event unknown not found');
    if (organizerId !== 'org-1') throw new DownstreamError(403, 'not your event');
    return {
      eventId,
      title: 'Neon Nights Live',
      startsAt: '2026-12-06T14:00:00.000Z',
      sold: 842,
      total: 1200,
      held: 36,
      left: 322,
      refundRequests: 5,
      tiers: [{ name: 'Front', sold: 288, total: 300 }],
    };
  },
  activity: async (eventId, organizerId) => {
    if (organizerId !== 'org-1') throw new DownstreamError(403, 'not your event');
    return [
      feedItem('e2', 'Row B · seats 8, 9'),
      feedItem('e1', 'Row D · seat 2 returned to sale'),
    ];
  },
};

beforeAll(async () => {
  hub = new SeatStreamHub();
  bookingHub = new BookingStreamHub();
  activityHub = new ActivityStreamHub();
  const mod = await Test.createTestingModule({
    imports: [
      GatewayModule.forRoot({
        catalog,
        inventory,
        bookings,
        payments,
        tickets,
        analytics,
        hub,
        bookingHub,
        activityHub,
        waitingRoom: new WaitingRoom({} as never, { admitPerSecond: 5, admissionTtlSeconds: 300 }),
        jwtSecret: SECRET,
        heartbeatMs: 60_000,
      }),
    ],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
  await app.listen(0); // real socket, needed by the SSE tests
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

describe('POST /api/bookings/:id/pay', () => {
  const post = (
    id = 'bk-1',
    key: string | null = 'idem-key-000001',
    body: object = { method: 'upi', token: 'tok_success' },
    auth = token('attendee', 'alice'),
  ) => {
    const r = request(app.getHttpServer())
      .post(`/api/bookings/${id}/pay`)
      .set('Authorization', auth);
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  };

  it('requires a token and the attendee role', async () => {
    await request(app.getHttpServer())
      .post('/api/bookings/bk-1/pay')
      .set('Idempotency-Key', 'idem-key-000001')
      .send({})
      .expect(401);
    await post('bk-1', 'idem-key-000001', {}, token('door-staff')).expect(403);
  });

  it('requires an Idempotency-Key header', async () => {
    await post('bk-1', null).expect(400);
  });

  it('only the owner can pay (403), unknown bookings are 404', async () => {
    await post('theirs').expect(403);
    await post('unknown').expect(404);
  });

  it('forwards the verified user, key, method and token and answers 202', async () => {
    const res = await post('bk-1', 'idem-key-000002', {
      method: 'upi',
      token: 'tok_success',
      userId: 'mallory',
    }).expect(202);
    expect(res.body).toEqual({ paymentId: 'pay-1', status: 'processing' });
    expect(payCalls.at(-1)).toEqual({
      bookingId: 'bk-1',
      userId: 'alice', // from the token, not the body
      method: 'upi',
      token: 'tok_success',
      idempotencyKey: 'idem-key-000002',
    });
  });

  it('maps payment errors: 400 bad input, 409 already paying, 422 key reuse', async () => {
    await post('bk-1', 'idem-key-000003', { method: 'cash', token: 't' }).expect(400);
    await post('bk-1', 'conflict-key-0001').expect(409);
    await post('bk-1', 'reused-key-00001').expect(422);
  });
});

describe('SSE /api/bookings/:id/stream', () => {
  const open = async (id: string, auth?: string) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/bookings/${id}/stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream', ...(auth ? { authorization: auth } : {}) },
    });
    return { res, controller };
  };

  it("needs a token and refuses other people's bookings", async () => {
    expect((await open('bk-1')).res.status).toBe(401);
    expect((await open('theirs', token('attendee', 'alice'))).res.status).toBe(403);
    expect((await open('unknown', token('attendee', 'alice'))).res.status).toBe(404);
    expect(bookingHub.observers).toBe(0); // failed opens do not leak subscriptions
  });

  it('sends a snapshot first, then each step live, only for that booking', async () => {
    const { res, controller } = await open('bk-1', token('attendee', 'alice'));
    expect(res.status).toBe(200);
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

    await readUntil('"kind":"snapshot"');
    expect(received).toContain('"state":"HELD"');
    expect(received).toContain('"holdExpiresAt":"2026-12-06T10:10:00.000Z"');
    expect(received).toContain('"serverTime":"2026-12-06T10:00:00.000Z"');

    bookingHub.publish({ bookingId: 'someone-else', type: 'payment.succeeded', at: 'x' });
    bookingHub.publish({
      bookingId: 'bk-1',
      type: 'payment.succeeded',
      at: '2026-12-06T10:01:00.000Z',
    });
    bookingHub.publish({
      bookingId: 'bk-1',
      type: 'payment.failed',
      reason: 'declined',
      at: '2026-12-06T10:02:00.000Z',
    });
    await readUntil('"type":"payment.failed"');
    expect(received).toContain('"kind":"event","type":"payment.succeeded"');
    expect(received).toContain('"reason":"declined"');
    expect(received).not.toContain('someone-else');

    controller.abort();
    const deadline = Date.now() + 3000;
    while (bookingHub.observers > 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(bookingHub.observers).toBe(0); // closing the page releases the subscription
  });
});

describe('GET /api/tickets', () => {
  it("needs a token and shows only the signed-in attendee's tickets with their QR tokens", async () => {
    await request(app.getHttpServer()).get('/api/tickets').expect(401);
    await request(app.getHttpServer())
      .get('/api/tickets')
      .set('Authorization', token('door-staff'))
      .expect(403);
    const mine = await request(app.getHttpServer())
      .get('/api/tickets')
      .set('Authorization', token('attendee', 'alice'))
      .expect(200);
    expect(mine.body).toHaveLength(2);
    expect(mine.body[0]).toMatchObject({
      code: 'GP-7QX2-C6',
      eventTitle: 'Neon Nights Live',
      row: 'C',
      seat: '6',
      tier: 'Mid',
      status: 'valid',
      qrToken: 'GP1.C6.sig',
    });
    const none = await request(app.getHttpServer())
      .get('/api/tickets')
      .set('Authorization', token('attendee', 'bob'))
      .expect(200);
    expect(none.body).toEqual([]);
  });
});

describe('POST /api/checkin', () => {
  const scan = (qrToken: unknown, auth = token('door-staff', 'staff-7')) =>
    request(app.getHttpServer()).post('/api/checkin').set('Authorization', auth).send({ qrToken });

  it('is for door staff only', async () => {
    await request(app.getHttpServer())
      .post('/api/checkin')
      .send({ qrToken: 'GP1.good.sig' })
      .expect(401);
    await scan('GP1.good.sig', token('attendee')).expect(403);
    await scan('GP1.good.sig', token('organizer')).expect(403);
  });

  it('answers 200 valid, 409 used, 404 invalid with the bodies the scanner shows', async () => {
    const ok = await scan('GP1.good.sig').expect(200);
    expect(ok.body).toEqual({ status: 'valid', row: 'C', seat: '6', tier: 'Mid' });
    const used = await scan('GP1.used.sig').expect(409);
    expect(used.body).toEqual({ status: 'used', usedAt: '2026-12-06T13:00:00.000Z' });
    const bad = await scan('GP1.forged.sig').expect(404);
    expect(bad.body).toEqual({ status: 'invalid' });
  });

  it('records WHICH staff member scanned, taken from the token', async () => {
    await scan('GP1.good.sig').expect(200);
    expect(scans.at(-1)).toEqual({ qrToken: 'GP1.good.sig', staffId: 'staff-7' });
  });

  it('rejects a missing, non-string or oversized token, and reports an outage as 503', async () => {
    await scan(undefined).expect(400);
    await scan(12345).expect(400);
    await scan('x'.repeat(3000)).expect(400);
    await scan('GP1.boom.sig').expect(503);
  });
});

describe('organizer dashboard', () => {
  const org = (sub = 'org-1') => token('organizer', sub);

  it('GET summary: organizer only, scoped to the token, maps 403 and 404', async () => {
    await request(app.getHttpServer()).get('/api/organizer/events/neon-nights/summary').expect(401);
    await request(app.getHttpServer())
      .get('/api/organizer/events/neon-nights/summary')
      .set('Authorization', token('attendee'))
      .expect(403);
    const ok = await request(app.getHttpServer())
      .get('/api/organizer/events/neon-nights/summary')
      .set('Authorization', org())
      .expect(200);
    expect(ok.body).toMatchObject({
      sold: 842,
      total: 1200,
      held: 36,
      left: 322,
      tiers: [{ name: 'Front', sold: 288, total: 300 }],
    });
    await request(app.getHttpServer())
      .get('/api/organizer/events/neon-nights/summary')
      .set('Authorization', org('org-2'))
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/organizer/events/unknown/summary')
      .set('Authorization', org())
      .expect(404);
  });

  it('SSE activity: refuses other organizers without leaking a subscription', async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const get = (auth?: string) =>
      fetch(`http://127.0.0.1:${port}/api/organizer/events/neon-nights/activity`, {
        headers: { accept: 'text/event-stream', ...(auth ? { authorization: auth } : {}) },
      });
    for (const [auth, status] of [
      [undefined, 401],
      [token('attendee'), 403],
      [org('org-2'), 403],
    ] as const) {
      const res = await get(auth);
      expect(res.status).toBe(status);
      await res.body?.cancel();
    }
    expect(activityHub.observers).toBe(0);
  });

  it('SSE activity: snapshot of the recent feed first, then live lines for this show only', async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/organizer/events/neon-nights/activity`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream', authorization: org() },
    });
    expect(res.status).toBe(200);
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

    await readUntil('"kind":"snapshot"');
    expect(received).toContain('Row B · seats 8, 9');
    expect(received).toContain('"id":"e2"');

    activityHub.publish({ ...feedItem('x1', 'other show line'), eventId: 'other-show' });
    activityHub.publish({
      ...feedItem('e3', 'Payment failed · declined'),
      type: 'payment.failed',
      failed: true,
    });
    await readUntil('"id":"e3"');
    expect(received).toContain('"kind":"event"');
    expect(received).toContain('"failed":true');
    expect(received).not.toContain('other show line');

    controller.abort();
    const deadline = Date.now() + 3000;
    while (activityHub.observers > 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(activityHub.observers).toBe(0);
  });
});

describe('booking stream: the third light', () => {
  const open = async (id: string) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/bookings/${id}/stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream', authorization: token('attendee', 'alice') },
    });
    return { res, controller };
  };

  it('a confirmed booking whose tickets exist reloads with the light on; without tickets it is off', async () => {
    for (const [id, issued, expected] of [
      ['confirmed', true, true],
      ['confirmed', false, false],
      ['bk-1', true, false], // only a confirmed booking can have tickets
    ] as const) {
      ticketsIssued = issued;
      const { res, controller } = await open(id);
      try {
        expect(await readSse(res, '"ticketsIssued"')).toContain(`"ticketsIssued":${expected}`);
      } finally {
        controller.abort();
      }
    }
  });

  it('ticket.issued arrives live as a step', async () => {
    const { res, controller } = await open('bk-1');
    try {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      while (!received.includes('"kind":"snapshot"'))
        received += decoder.decode((await reader.read()).value);
      bookingHub.publish({
        bookingId: 'bk-1',
        type: 'ticket.issued',
        at: '2026-12-06T10:03:00.000Z',
      });
      const deadline = Date.now() + 5000;
      while (!received.includes('"type":"ticket.issued"')) {
        if (Date.now() > deadline) throw new Error(`timeout; got ${received}`);
        received += decoder.decode((await reader.read()).value);
      }
      expect(received).toContain('"kind":"event","type":"ticket.issued"');
    } finally {
      controller.abort();
    }
  });
});

describe('SSE /api/events/:id/seats/stream', () => {
  it("pushes only that event's seat changes to the browser as they happen", async () => {
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
