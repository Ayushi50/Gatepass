import 'reflect-metadata';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Pool } from 'pg';
import { migrate } from '@gatepass/db';
import { buildEnvelope, type EventEnvelope } from '@gatepass/events';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import {
  CONSUMED_TOPICS,
  ForbiddenError,
  NotFoundError,
  getActivity,
  getSummary,
  onEvent,
} from '../src';
import { AnalyticsModule } from '../src/http/analytics.module';

jest.setTimeout(120_000);

let server: TestPostgres;
let db: TestDatabase;
let pool: Pool;
let app: INestApplication;
let n = 0;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase();
  pool = db.pool;
  await migrate(pool, join(__dirname, '..', 'migrations'));
  const mod = await Test.createTestingModule({
    imports: [AnalyticsModule.forPool(pool)],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app?.close();
  await db.close();
  await server.stop();
});

let eventId: string;
beforeEach(async () => {
  eventId = `show-${++n}`;
});

const at = (ms: number) => () => 1_800_000_000_000 + ms;
const publishedShow = (id = eventId, organizerId = 'org-1') =>
  buildEnvelope({
    eventType: 'event.published',
    correlationId: id,
    producer: 'catalog',
    now: at(0),
    payload: {
      eventId: id,
      organizerId,
      title: 'Neon Nights Live',
      category: 'Music',
      venue: 'Hall',
      startsAtMs: 1_800_100_000_000n,
      currency: 'INR',
      // 2 Front (A1,A2) + 3 Mid (B1,B2,B3)
      seats: [
        { seatId: 'A1', row: 'A', number: 1, tier: 'Front', priceMinor: 240000n },
        { seatId: 'A2', row: 'A', number: 2, tier: 'Front', priceMinor: 240000n },
        { seatId: 'B1', row: 'B', number: 1, tier: 'Mid', priceMinor: 180000n },
        { seatId: 'B2', row: 'B', number: 2, tier: 'Mid', priceMinor: 180000n },
        { seatId: 'B3', row: 'B', number: 3, tier: 'Mid', priceMinor: 180000n },
      ],
    },
  });
const seatEvent = (
  type: 'seats.held' | 'seats.sold' | 'seats.released' | 'hold.expired',
  seatIds: string[],
  ms: number,
  booking = 'bk-1',
) =>
  buildEnvelope({
    eventType: type,
    correlationId: booking,
    producer: 'seat-inventory',
    now: at(ms),
    payload:
      type === 'seats.held'
        ? { bookingId: booking, eventId, seatIds, holdExpiresAtMs: 1n }
        : { bookingId: booking, eventId, seatIds },
  } as never) as EventEnvelope;
const feed = (organizerId = 'org-1', limit = 20) => getActivity(pool, eventId, organizerId, limit);
const summary = (organizerId = 'org-1') => getSummary(pool, eventId, organizerId);

describe('consumes every event type', () => {
  it('subscribes to all 17 topics', () => {
    expect(CONSUMED_TOPICS).toHaveLength(17);
    expect(CONSUMED_TOPICS).toContain('seats.sold');
    expect(CONSUMED_TOPICS).toContain('refund.completed');
  });
});

describe('summary', () => {
  it('starts with everything available, with tier totals from event.published', async () => {
    await onEvent(pool, publishedShow());
    expect(await summary()).toEqual({
      eventId,
      title: 'Neon Nights Live',
      startsAt: new Date(1_800_100_000_000).toISOString(),
      sold: 0,
      total: 5,
      held: 0,
      left: 5,
      tiers: [
        { name: 'Front', sold: 0, total: 2 },
        { name: 'Mid', sold: 0, total: 3 },
      ],
    });
  });

  it('tracks hold, sale and release, so tiles and tier bars always add up', async () => {
    await onEvent(pool, publishedShow());
    await onEvent(pool, seatEvent('seats.held', ['A1', 'B1', 'B2'], 10));
    expect(await summary()).toMatchObject({ sold: 0, held: 3, left: 2 });

    await onEvent(pool, seatEvent('seats.sold', ['A1', 'B1'], 20));
    expect(await summary()).toMatchObject({
      sold: 2,
      held: 1,
      left: 2,
      tiers: [
        { name: 'Front', sold: 1, total: 2 },
        { name: 'Mid', sold: 1, total: 3 },
      ],
    });

    await onEvent(pool, seatEvent('seats.released', ['B2'], 30));
    expect(await summary()).toMatchObject({ sold: 2, held: 0, left: 3 });
    const s = await summary();
    expect(s.sold + s.held + s.left).toBe(s.total);
  });

  it('hold.expired returns a seat to sale', async () => {
    await onEvent(pool, publishedShow());
    await onEvent(pool, seatEvent('seats.held', ['A2'], 10));
    await onEvent(pool, seatEvent('hold.expired', ['A2'], 20));
    expect(await summary()).toMatchObject({ held: 0, left: 5 });
  });

  it('an older event can never overwrite a newer one (out of order, late, replayed)', async () => {
    await onEvent(pool, publishedShow());
    await onEvent(pool, seatEvent('seats.sold', ['A1'], 50)); // newest fact arrives first
    await onEvent(pool, seatEvent('seats.held', ['A1'], 10)); // stale: ignored
    await onEvent(pool, seatEvent('seats.released', ['A1'], 20)); // stale: ignored
    expect(await summary()).toMatchObject({ sold: 1, held: 0 });
  });

  it('seat events that arrive BEFORE event.published are not lost', async () => {
    await onEvent(pool, seatEvent('seats.held', ['A1', 'B1'], 10));
    await onEvent(pool, seatEvent('seats.sold', ['A1'], 20));
    await onEvent(pool, publishedShow()); // tier info arrives late; must not reset state
    expect(await summary()).toMatchObject({
      sold: 1,
      held: 1,
      left: 3,
      tiers: [
        { name: 'Front', sold: 1, total: 2 },
        { name: 'Mid', sold: 0, total: 3 },
      ],
    });
  });

  it('a duplicate delivery changes nothing', async () => {
    await onEvent(pool, publishedShow());
    const ev = seatEvent('seats.held', ['A1'], 10);
    await onEvent(pool, ev);
    await onEvent(pool, ev);
    expect(await summary()).toMatchObject({ held: 1 });
    expect((await feed()).filter((a) => a.type === 'seats.held')).toHaveLength(1);
  });
});

describe('activity feed', () => {
  it('stores design-style lines newest first, flags failures, and attributes payments to the show', async () => {
    await onEvent(pool, publishedShow());
    await onEvent(pool, seatEvent('seats.sold', ['B2', 'B3'], 10, 'bk-1'));
    await onEvent(
      pool,
      buildEnvelope({
        eventType: 'payment.failed',
        correlationId: 'bk-2',
        producer: 'payment',
        now: at(20),
        payload: {
          bookingId: 'bk-2',
          paymentId: 'p',
          reason: 'card declined',
          eventId,
          userId: 'u',
        },
      }),
    );
    await onEvent(
      pool,
      buildEnvelope({
        eventType: 'ticket.issued',
        correlationId: 'bk-1',
        producer: 'ticket',
        now: at(30),
        payload: {
          bookingId: 'bk-1',
          eventId,
          userId: 'u',
          tickets: [{ ticketId: 't1' }, { ticketId: 't2' }],
        },
      }),
    );
    const items = await feed();
    expect(items.map((i) => [i.type, i.failed])).toEqual([
      ['ticket.issued', false],
      ['payment.failed', true],
      ['seats.sold', false],
    ]);
    expect(items[2]!.text).toBe('Row B · seats 2, 3');
    expect(items[1]!.text).toBe('Payment failed · card declined');
    expect(items[0]!.text).toMatch(/^Booking GP-[A-Z0-9]{4} · 2 tickets$/);
  });

  it('respects the limit and ignores events that are not feed material', async () => {
    await onEvent(pool, publishedShow());
    for (let i = 0; i < 5; i++)
      await onEvent(pool, seatEvent('seats.held', [`B${(i % 3) + 1}`], 10 + i, `bk-${i}`));
    expect(await feed('org-1', 3)).toHaveLength(3);
    expect((await feed('org-1', 50)).every((a) => a.type !== 'event.published')).toBe(true);
  });
});

describe('ownership', () => {
  it("only the event's organizer can read it; unknown events are 404", async () => {
    await onEvent(pool, publishedShow(eventId, 'org-1'));
    await expect(getSummary(pool, eventId, 'org-2')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getActivity(pool, eventId, 'org-2')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getSummary(pool, 'nope', 'org-1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('HTTP', () => {
  it('serves summary and activity, enforcing the organizer', async () => {
    await onEvent(pool, publishedShow());
    await onEvent(pool, seatEvent('seats.held', ['A1'], 10));
    const s = await request(app.getHttpServer())
      .get(`/organizer/events/${eventId}/summary`)
      .query({ organizerId: 'org-1' })
      .expect(200);
    expect(s.body).toMatchObject({ held: 1, total: 5 });
    const a = await request(app.getHttpServer())
      .get(`/organizer/events/${eventId}/activity`)
      .query({ organizerId: 'org-1', limit: '1' })
      .expect(200);
    expect(a.body).toHaveLength(1);
    await request(app.getHttpServer())
      .get(`/organizer/events/${eventId}/summary`)
      .query({ organizerId: 'org-2' })
      .expect(403);
    await request(app.getHttpServer())
      .get('/organizer/events/nope/summary')
      .query({ organizerId: 'org-1' })
      .expect(404);
    await request(app.getHttpServer()).get(`/organizer/events/${eventId}/summary`).expect(400);
  });
});
