import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { startTestRedis, type TestRedis } from '@gatepass/testing';
import {
  ActivityStreamHub,
  BookingStreamHub,
  DownstreamError,
  GatewayModule,
  SeatStreamHub,
  WaitingRoom,
  signAdmissionToken,
  signToken,
  verifyAdmissionToken,
  type AnalyticsClient,
  type BookingClient,
  type BookingView,
  type CatalogClient,
  type TicketClient,
} from '../src';

jest.setTimeout(120_000);

const SECRET = 'a-test-secret-that-is-long-enough-123';
const bearer = (role: 'attendee' | 'organizer' | 'door-staff', sub = 'alice') =>
  `Bearer ${signToken({ sub, role }, SECRET)}`;

const event = (id: string, waitingRoom: boolean) => ({
  id,
  title: id,
  category: 'Music',
  venue: 'Hall',
  startsAt: '2026-12-06T14:00:00.000Z',
  currency: 'INR',
  waitingRoom,
  minPriceMinor: 100000,
  tiers: [],
});

const created: unknown[] = [];
const booking = (userId: string): BookingView => ({
  id: 'bk-1',
  eventId: 'neon-nights',
  userId,
  seatIds: ['C6'],
  state: 'REQUESTED',
  holdExpiresAt: null,
  cancelReason: null,
  serverTime: '2026-12-06T10:00:00.000Z',
});

let app: INestApplication;
let redis: Redis;
let redisServer: TestRedis;
let room: WaitingRoom;

const catalog: CatalogClient = {
  listEvents: async () => [event('neon-nights', true), event('laugh-lab', false)],
  getEvent: async (id) => {
    if (id === 'unknown') throw new DownstreamError(404, 'event unknown not found');
    return event(id, id === 'neon-nights');
  },
};
const bookings: BookingClient = {
  create: async (input) => {
    created.push(input);
    return booking(input.userId);
  },
  get: async () => booking('alice'),
  approveRefund: async (refundId, organizerId) => {
    if (refundId === 'unknown') throw new DownstreamError(404, 'refund unknown not found');
    if (organizerId !== 'org-1') throw new DownstreamError(403, 'not your event');
    return { refundId, state: 'APPROVED' };
  },
};
const tickets: TicketClient = {
  list: async () => [],
  forBooking: async () => ({ issued: false, count: 0 }),
  checkIn: async () => ({ httpStatus: 404, body: { status: 'invalid' } }),
  requestRefund: async (ticketId, userId) => {
    if (ticketId === 'theirs') throw new DownstreamError(404, 'ticket not found');
    if (ticketId === 'used')
      throw new DownstreamError(409, 'a ticket that was used cannot be refunded');
    return { refundId: `rf-${userId}`, status: 'refund_requested' };
  },
};
const analytics: AnalyticsClient = {
  summary: async () => {
    throw new Error('unused');
  },
  activity: async () => [],
  refunds: async (eventId, organizerId) => {
    if (organizerId !== 'org-1') throw new DownstreamError(403, 'not your event');
    return [
      {
        id: 'rf-1',
        bookingId: 'bk-1',
        userId: 'aarav',
        seatId: 'C6',
        amountMinor: 180000,
        currency: 'INR',
        state: 'requested',
      },
    ];
  },
};

beforeAll(async () => {
  redisServer = await startTestRedis();
  redis = new Redis(redisServer.url);
  room = new WaitingRoom(redis, { admitPerSecond: 5, admissionTtlSeconds: 300 });
  const mod = await Test.createTestingModule({
    imports: [
      GatewayModule.forRoot({
        catalog,
        inventory: { getSeats: async () => [], getAvailability: async () => [] },
        bookings,
        payments: {
          pay: async () => ({ paymentId: 'p', status: 'processing' }),
          confirm: async () => ({ paymentId: 'p', status: 'succeeded' }),
        },
        tickets,
        analytics,
        hub: new SeatStreamHub(),
        bookingHub: new BookingStreamHub(),
        activityHub: new ActivityStreamHub(),
        waitingRoom: room,
        jwtSecret: SECRET,
        heartbeatMs: 60_000,
      }),
    ],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app?.close();
  redis.disconnect();
  await redisServer.stop();
});
beforeEach(async () => {
  await redis.flushall();
  created.length = 0;
});

const http = () => request(app.getHttpServer());
const book = (eventId: string, auth = bearer('attendee'), admission?: string) => {
  const r = http().post('/api/bookings').set('Authorization', auth);
  if (admission) r.set('X-Admission-Token', admission);
  return r.send({ eventId, seatIds: ['C6'] });
};

describe('events list', () => {
  it('tells the frontend which shows use the waiting room', async () => {
    const res = await http().get('/api/events').expect(200);
    expect(
      res.body.map((e: { id: string; waitingRoom: boolean }) => [e.id, e.waitingRoom]),
    ).toEqual([
      ['neon-nights', true],
      ['laugh-lab', false],
    ]);
  });
});

describe('waiting room endpoints', () => {
  it('require an attendee token', async () => {
    await http().post('/api/events/neon-nights/waiting-room/join').expect(401);
    await http()
      .get('/api/events/neon-nights/waiting-room')
      .set('Authorization', bearer('door-staff'))
      .expect(403);
  });

  it('a show without a waiting room answers 409, an unknown show 404', async () => {
    const res = await http()
      .post('/api/events/laugh-lab/waiting-room/join')
      .set('Authorization', bearer('attendee'))
      .expect(409);
    expect(res.body).toMatchObject({ code: 'waiting_room_not_required' });
    await http()
      .post('/api/events/unknown/waiting-room/join')
      .set('Authorization', bearer('attendee'))
      .expect(404);
  });

  it('join gives a place and an estimated wait; repeating keeps the place; status agrees', async () => {
    const auth = (u: string) => bearer('attendee', u);
    await http()
      .post('/api/events/neon-nights/waiting-room/join')
      .set('Authorization', auth('first'))
      .expect(200);
    const second = await http()
      .post('/api/events/neon-nights/waiting-room/join')
      .set('Authorization', auth('second'))
      .expect(200);
    expect(second.body).toEqual({ state: 'waiting', position: 2, estimatedWaitSeconds: 1 });
    const again = await http()
      .post('/api/events/neon-nights/waiting-room/join')
      .set('Authorization', auth('second'))
      .expect(200);
    expect(again.body.position).toBe(2);
    const status = await http()
      .get('/api/events/neon-nights/waiting-room')
      .set('Authorization', auth('second'))
      .expect(200);
    expect(status.body).toEqual({ state: 'waiting', position: 2, estimatedWaitSeconds: 1 });
    const stranger = await http()
      .get('/api/events/neon-nights/waiting-room')
      .set('Authorization', auth('nobody'))
      .expect(200);
    expect(stranger.body).toEqual({ state: 'not_queued' });
  });

  it('once admitted, the status carries a pass for this user and this show that lasts as long as the admission', async () => {
    await http()
      .post('/api/events/neon-nights/waiting-room/join')
      .set('Authorization', bearer('attendee', 'carol'))
      .expect(200);
    await room.admit('neon-nights', 1);
    const res = await http()
      .get('/api/events/neon-nights/waiting-room')
      .set('Authorization', bearer('attendee', 'carol'))
      .expect(200);
    expect(res.body).toMatchObject({ state: 'admitted', expiresInSeconds: expect.any(Number) });
    const claims = verifyAdmissionToken(res.body.admissionToken, SECRET);
    expect(claims).toMatchObject({ sub: 'carol', evt: 'neon-nights' });
    expect(claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(300_000);
    expect(claims.exp * 1000 - Date.now()).toBeGreaterThan(290_000);
  });
});

describe('POST /api/bookings is gated by the waiting room', () => {
  const admit = async (userId: string, eventId = 'neon-nights') => {
    await room.join(eventId, userId);
    await room.admit(eventId, 1);
    const res = await http()
      .get(`/api/events/${eventId}/waiting-room`)
      .set('Authorization', bearer('attendee', userId));
    return res.body.admissionToken as string;
  };

  it('a high-demand show refuses a booking without an admission token', async () => {
    const res = await book('neon-nights').expect(403);
    expect(res.body).toMatchObject({ code: 'waiting_room_required' });
    expect(created).toHaveLength(0);
  });

  it("refuses garbage, another user's pass, another show's pass, and an access token posing as a pass", async () => {
    const mine = await admit('alice');
    await room.join('neon-nights', 'bob');
    await room.admit('neon-nights', 1);
    const bobs = (
      await http()
        .get('/api/events/neon-nights/waiting-room')
        .set('Authorization', bearer('attendee', 'bob'))
    ).body.admissionToken;
    const otherShow = signAdmissionToken({ sub: 'alice', eventId: 'laugh-lab' }, SECRET, {
      ttlSeconds: 60,
    });
    const accessToken = signToken({ sub: 'alice', role: 'attendee' }, SECRET);

    for (const bad of ['garbage', bobs, otherShow, accessToken]) {
      const res = await book('neon-nights', bearer('attendee', 'alice'), bad).expect(403);
      expect(res.body.code).toBe('admission_invalid');
    }
    expect(created).toHaveLength(0);
    await book('neon-nights', bearer('attendee', 'alice'), mine).expect(201);
  });

  it('an admitted user can book, and the booking is made for the signed-in user', async () => {
    const pass = await admit('alice');
    const res = await book('neon-nights', bearer('attendee', 'alice'), pass).expect(201);
    expect(res.body).toMatchObject({ id: 'bk-1' });
    expect(created).toEqual([{ eventId: 'neon-nights', seatIds: ['C6'], userId: 'alice' }]);
  });

  it('the pass can be reused while the admission lasts (e.g. a retry after a failed hold)', async () => {
    const pass = await admit('alice');
    await book('neon-nights', bearer('attendee', 'alice'), pass).expect(201);
    await book('neon-nights', bearer('attendee', 'alice'), pass).expect(201);
    expect(created).toHaveLength(2);
  });

  it('a pass stops working the moment the admission ends, even though its signature is still good', async () => {
    const pass = await admit('alice');
    await redis.del('wr:neon-nights:a:alice');
    const res = await book('neon-nights', bearer('attendee', 'alice'), pass).expect(403);
    expect(res.body.code).toBe('admission_expired');
  });

  it('an expired pass is refused as expired', async () => {
    const old = signAdmissionToken({ sub: 'alice', eventId: 'neon-nights' }, SECRET, {
      ttlSeconds: 60,
      now: () => Date.now() - 120_000,
    });
    const res = await book('neon-nights', bearer('attendee', 'alice'), old).expect(403);
    expect(res.body.code).toBe('admission_expired');
  });

  it('shows without a waiting room need no pass and are unaffected', async () => {
    await book('laugh-lab').expect(201);
    expect(created).toHaveLength(1);
  });

  it('still requires a normal login first', async () => {
    await http()
      .post('/api/bookings')
      .send({ eventId: 'neon-nights', seatIds: ['C6'] })
      .expect(401);
  });
});

describe('admission tokens', () => {
  it('are bound to a user and a show, expire, and cannot be forged or turned into access tokens', () => {
    const t = signAdmissionToken({ sub: 'u', eventId: 'e' }, SECRET, { ttlSeconds: 60 });
    expect(verifyAdmissionToken(t, SECRET)).toMatchObject({ sub: 'u', evt: 'e' });
    expect(() => verifyAdmissionToken(t, 'another-secret-another-secret-12345')).toThrow(
      'bad signature',
    );
    expect(() =>
      verifyAdmissionToken(signToken({ sub: 'u', role: 'attendee' }, SECRET), SECRET),
    ).toThrow('not an admission token');
    const [h, p, s] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u', evt: 'other', typ: 'admission', exp: 9_999_999_999 }),
    ).toString('base64url');
    expect(() => verifyAdmissionToken(`${h}.${forged}.${s}`, SECRET)).toThrow('bad signature');
    expect(p).toBeDefined();
  });
});

describe('refund endpoints', () => {
  it('POST /api/tickets/:id/refund: attendee only, 202 on success, 404 and 409 mapped', async () => {
    await http().post('/api/tickets/t1/refund').expect(401);
    await http()
      .post('/api/tickets/t1/refund')
      .set('Authorization', bearer('organizer'))
      .expect(403);
    const ok = await http()
      .post('/api/tickets/t1/refund')
      .set('Authorization', bearer('attendee', 'alice'))
      .expect(202);
    expect(ok.body).toEqual({ refundId: 'rf-alice', status: 'refund_requested' }); // the user came from the token
    await http()
      .post('/api/tickets/theirs/refund')
      .set('Authorization', bearer('attendee'))
      .expect(404);
    await http()
      .post('/api/tickets/used/refund')
      .set('Authorization', bearer('attendee'))
      .expect(409);
  });

  it('GET /api/organizer/events/:id/refunds: organizer only and scoped to their shows', async () => {
    await http()
      .get('/api/organizer/events/neon-nights/refunds')
      .set('Authorization', bearer('attendee'))
      .expect(403);
    const ok = await http()
      .get('/api/organizer/events/neon-nights/refunds')
      .set('Authorization', bearer('organizer', 'org-1'))
      .expect(200);
    expect(ok.body).toEqual([
      expect.objectContaining({
        id: 'rf-1',
        seatId: 'C6',
        amountMinor: 180000,
        state: 'requested',
      }),
    ]);
    await http()
      .get('/api/organizer/events/neon-nights/refunds')
      .set('Authorization', bearer('organizer', 'org-2'))
      .expect(403);
  });

  it('POST /api/refunds/:id/approve: organizer only; their id comes from the token; 403 and 404 mapped', async () => {
    await http().post('/api/refunds/rf-1/approve').expect(401);
    await http()
      .post('/api/refunds/rf-1/approve')
      .set('Authorization', bearer('attendee'))
      .expect(403);
    const ok = await http()
      .post('/api/refunds/rf-1/approve')
      .set('Authorization', bearer('organizer', 'org-1'))
      .expect(200);
    expect(ok.body).toEqual({ refundId: 'rf-1', state: 'APPROVED' });
    await http()
      .post('/api/refunds/rf-1/approve')
      .set('Authorization', bearer('organizer', 'org-2'))
      .expect(403);
    await http()
      .post('/api/refunds/unknown/approve')
      .set('Authorization', bearer('organizer', 'org-1'))
      .expect(404);
  });
});
