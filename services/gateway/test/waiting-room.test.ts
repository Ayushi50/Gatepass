import { Redis } from 'ioredis';
import { startTestRedis, type TestRedis } from '@gatepass/testing';
import { WaitingRoom, WaitingRoomAdmitter } from '../src';

jest.setTimeout(120_000);

let server: TestRedis;
let redis: Redis;
let n = 0;

beforeAll(async () => {
  server = await startTestRedis();
  redis = new Redis(server.url);
});
afterAll(async () => {
  redis.disconnect();
  await server.stop();
});

const room = (admitPerSecond = 5, admissionTtlSeconds = 300) =>
  new WaitingRoom(redis, { admitPerSecond, admissionTtlSeconds });
const newEvent = () => `show-${++n}`;
const users = (count: number, prefix = 'u') =>
  Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

describe('queue', () => {
  it('is first come, first served, with 1-based positions and an estimated wait from the rate', async () => {
    const wr = room(5);
    const e = newEvent();
    expect(await wr.join(e, 'a')).toEqual({
      state: 'waiting',
      position: 1,
      estimatedWaitSeconds: 1,
    });
    expect(await wr.join(e, 'b')).toEqual({
      state: 'waiting',
      position: 2,
      estimatedWaitSeconds: 1,
    });
    for (const u of users(8, 'x')) await wr.join(e, u); // positions 3..10
    expect(await wr.status(e, 'x8')).toEqual({
      state: 'waiting',
      position: 10,
      estimatedWaitSeconds: 2,
    });
    expect(await wr.queueLength(e)).toBe(10);
  });

  it('joining again keeps your place instead of going to the back', async () => {
    const wr = room();
    const e = newEvent();
    await wr.join(e, 'a');
    await wr.join(e, 'b');
    await wr.join(e, 'c');
    expect(await wr.join(e, 'a')).toMatchObject({ state: 'waiting', position: 1 });
    expect(await wr.join(e, 'b')).toMatchObject({ position: 2 });
    expect(await wr.queueLength(e)).toBe(3);
  });

  it('300 people joining at the same moment get 300 distinct places, 1..300', async () => {
    const wr = room();
    const e = newEvent();
    const results = await Promise.all(users(300).map((u) => wr.join(e, u)));
    const positions = results
      .map((r) => (r.state === 'waiting' ? r.position : -1))
      .sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  it('queues are independent per event; unknown users are not queued', async () => {
    const wr = room();
    const [e1, e2] = [newEvent(), newEvent()];
    await wr.join(e1, 'a');
    await wr.join(e2, 'b');
    expect(await wr.status(e1, 'b')).toEqual({ state: 'not_queued' });
    expect(await wr.status(e2, 'b')).toMatchObject({ position: 1 });
  });
});

describe('admission', () => {
  it('admits from the front, in order, and everyone behind moves up', async () => {
    const wr = room();
    const e = newEvent();
    for (const u of users(6)) await wr.join(e, u);
    expect(await wr.admit(e, 2)).toEqual(['u1', 'u2']);
    expect(await wr.status(e, 'u1')).toMatchObject({ state: 'admitted' });
    expect(await wr.status(e, 'u3')).toMatchObject({ state: 'waiting', position: 1 });
    expect(await wr.status(e, 'u6')).toMatchObject({ state: 'waiting', position: 4 });
    expect(await wr.isAdmitted(e, 'u2')).toBe(true);
    expect(await wr.isAdmitted(e, 'u3')).toBe(false);
  });

  it('an admitted user who joins again is told they are admitted, not put back in the queue', async () => {
    const wr = room();
    const e = newEvent();
    await wr.join(e, 'a');
    await wr.admit(e, 1);
    expect(await wr.join(e, 'a')).toMatchObject({ state: 'admitted' });
    expect(await wr.queueLength(e)).toBe(0);
  });

  it('admission is short-lived: it ends by itself', async () => {
    const wr = room(5, 1); // 1 second
    const e = newEvent();
    await wr.join(e, 'a');
    await wr.admit(e, 1);
    expect(await wr.isAdmitted(e, 'a')).toBe(true);
    await new Promise((r) => setTimeout(r, 1300));
    expect(await wr.isAdmitted(e, 'a')).toBe(false);
    expect(await wr.status(e, 'a')).toEqual({ state: 'not_queued' });
  });

  it('never admits more than are waiting, and 0 or negative counts admit nobody', async () => {
    const wr = room();
    const e = newEvent();
    await wr.join(e, 'a');
    expect(await wr.admit(e, 50)).toEqual(['a']);
    expect(await wr.admit(e, 5)).toEqual([]);
    expect(await wr.admit(e, 0)).toEqual([]);
    expect(await wr.admit(e, -3)).toEqual([]);
  });

  it('tracks which events have a queue, and forgets an event once its queue is empty', async () => {
    const wr = room();
    const e = newEvent();
    await wr.join(e, 'a');
    expect(await wr.activeEvents()).toContain(e);
    await wr.admit(e, 1);
    expect(await wr.activeEvents()).not.toContain(e);
  });

  it('two admit calls at once never admit the same person twice', async () => {
    const wr = room();
    const e = newEvent();
    for (const u of users(40)) await wr.join(e, u);
    const batches = await Promise.all(Array.from({ length: 8 }, () => wr.admit(e, 5)));
    const all = batches.flat();
    expect(all).toHaveLength(40);
    expect(new Set(all).size).toBe(40);
  });
});

describe('admitter (the configured admission rate)', () => {
  beforeEach(async () => {
    await redis.flushall(); // the admitter works across ALL events and holds a leader lease
  });

  it('lets in exactly the configured number per second', async () => {
    const wr = room(5);
    const e = newEvent();
    for (const u of users(100)) await wr.join(e, u);
    let t = 1_000_000;
    const admitter = new WaitingRoomAdmitter(wr, { tickMs: 1000, now: () => t });
    const perSecond: number[] = [];
    for (let i = 0; i < 6; i++) {
      perSecond.push(await admitter.tick());
      t += 1000;
    }
    expect(perSecond).toEqual([5, 5, 5, 5, 5, 5]);
    expect(await wr.queueLength(e)).toBe(70);
    expect(await wr.status(e, 'u30')).toMatchObject({ state: 'admitted' });
    expect(await wr.status(e, 'u31')).toMatchObject({ state: 'waiting', position: 1 });
  });

  it('handles fractional rates and short ticks: 2.5 per second over 4 seconds is 10', async () => {
    const wr = room(2.5);
    const e = newEvent();
    for (const u of users(50)) await wr.join(e, u);
    let t = 5_000_000;
    const admitter = new WaitingRoomAdmitter(wr, { tickMs: 250, now: () => t });
    let total = 0;
    for (let i = 0; i < 16; i++) {
      total += await admitter.tick();
      t += 250;
    }
    expect(total).toBe(10);
  });

  it('does not store up a burst while the queue is empty', async () => {
    const wr = room(5);
    const e = newEvent();
    await wr.join(e, 'warmup');
    let t = 9_000_000;
    const admitter = new WaitingRoomAdmitter(wr, { tickMs: 1000, now: () => t });
    await admitter.tick(); // admits 'warmup'
    t += 60_000; // a quiet minute
    for (const u of users(30)) await wr.join(e, u);
    expect(await admitter.tick()).toBe(5); // 5, not 300
  });

  it('with two gateways, only one admits: the rate is not doubled', async () => {
    const wr = room(5);
    const e = newEvent();
    for (const u of users(100)) await wr.join(e, u);
    let t = 20_000_000;
    const a = new WaitingRoomAdmitter(wr, { tickMs: 1000, now: () => t });
    const b = new WaitingRoomAdmitter(wr, { tickMs: 1000, now: () => t });
    let total = 0;
    const who: string[] = [];
    for (let i = 0; i < 4; i++) {
      for (const x of [a, b]) {
        const got = await x.tick();
        total += got;
        if (got > 0) who.push(x === a ? 'a' : 'b');
      }
      t += 1000;
    }
    expect(total).toBe(20); // 4 seconds x 5, not x 10
    expect(new Set(who).size).toBe(1); // always the same leader
  });

  it('another gateway takes over when the leader disappears', async () => {
    const wr = room(5);
    const e = newEvent();
    for (const u of users(100)) await wr.join(e, u);
    let t = 30_000_000;
    const a = new WaitingRoomAdmitter(wr, { tickMs: 50, now: () => t });
    const b = new WaitingRoomAdmitter(wr, { tickMs: 50, now: () => t });
    expect(await a.tick()).toBeGreaterThanOrEqual(0);
    expect(await b.tick()).toBe(0); // b is not the leader while a's lease is alive
    await new Promise((r) => setTimeout(r, 260)); // a stops ticking; its 200ms lease runs out
    await b.tick(); // b takes the lease (a new leader starts its clock here, so admits ~nothing yet)
    t += 1000;
    expect(await b.tick()).toBe(5); // and then admits at the configured rate
  });
});
