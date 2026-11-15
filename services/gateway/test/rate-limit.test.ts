import { Redis } from 'ioredis';
import { startTestRedis, type TestRedis } from '@gatepass/testing';
import { RateLimiter, rateLimitMiddleware } from '../src';

jest.setTimeout(120_000);

let server: TestRedis;
let redis: Redis;
beforeAll(async () => {
  server = await startTestRedis();
  redis = new Redis(server.url);
});
afterAll(async () => {
  redis.disconnect();
  await server.stop();
});

describe('RateLimiter', () => {
  it('lets a client through up to the limit, then refuses until the window ends', async () => {
    let now = 1_000_000;
    const rl = new RateLimiter(redis, { now: () => now });
    const key = `a-${Math.random()}`;
    for (let i = 1; i <= 3; i++) expect((await rl.hit(key, 3, 60)).allowed).toBe(true);
    const refused = await rl.hit(key, 3, 60);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    now += 61_000; // next window
    expect((await rl.hit(key, 3, 60)).allowed).toBe(true);
  });

  it('counts each client on its own', async () => {
    const rl = new RateLimiter(redis);
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    await rl.hit(a, 1, 60);
    expect((await rl.hit(a, 1, 60)).allowed).toBe(false);
    expect((await rl.hit(b, 1, 60)).allowed).toBe(true);
  });

  it('under 200 simultaneous hits admits exactly the limit', async () => {
    const rl = new RateLimiter(redis);
    const key = `race-${Math.random()}`;
    const all = await Promise.all(Array.from({ length: 200 }, () => rl.hit(key, 50, 60)));
    expect(all.filter((r) => r.allowed)).toHaveLength(50);
  });

  it('fails open when Redis is unreachable: the site stays up, the failure is reported', async () => {
    const dead = new Redis({
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    dead.on('error', () => undefined);
    const errors: unknown[] = [];
    const rl = new RateLimiter(dead, { onError: (e) => errors.push(e) });
    expect((await rl.hit('x', 1, 60)).allowed).toBe(true);
    expect(errors).toHaveLength(1);
    dead.disconnect();
  });
});

describe('rateLimitMiddleware', () => {
  const run = async (
    mw: ReturnType<typeof rateLimitMiddleware>,
    path: string,
    ip: string,
    auth?: string,
  ) => {
    const headers: Record<string, string> = {};
    let status = 200;
    let body: unknown;
    let passed = false;
    await mw(
      { path, ip, headers: auth ? { authorization: auth } : {}, socket: { remoteAddress: ip } },
      {
        setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
        status(code: number) {
          status = code;
          return this;
        },
        json(b: unknown) {
          body = b;
        },
      },
      () => void (passed = true),
    );
    return { passed, status, headers, body };
  };

  it('answers 429 with Retry-After once a client is over the limit, and never limits /health or /metrics', async () => {
    const mw = rateLimitMiddleware(new RateLimiter(redis), { perMinute: 2, signInsPerMinute: 1 });
    const ip = `10.0.0.${Math.floor(Math.random() * 250)}`;
    expect((await run(mw, '/api/events', ip)).passed).toBe(true);
    expect((await run(mw, '/api/events', ip)).passed).toBe(true);
    const third = await run(mw, '/api/events', ip);
    expect(third.passed).toBe(false);
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(third.body).toMatchObject({ statusCode: 429 });
    expect((await run(mw, '/health', ip)).passed).toBe(true);
    expect((await run(mw, '/metrics', ip)).passed).toBe(true);
  });

  it('sign-in has its own, tighter limit, and a signed-in user is counted by user, not by address', async () => {
    const mw = rateLimitMiddleware(new RateLimiter(redis), { perMinute: 2, signInsPerMinute: 1 });
    const ip = `10.1.0.${Math.floor(Math.random() * 250)}`;
    expect((await run(mw, '/api/dev-login', ip)).passed).toBe(true);
    expect((await run(mw, '/api/dev-login', ip)).status).toBe(429);
    const token = (sub: string) =>
      `Bearer h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
    const shared = `10.2.0.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 2; i++) await run(mw, '/api/tickets', shared, token(`u1-${shared}`));
    expect((await run(mw, '/api/tickets', shared, token(`u1-${shared}`))).status).toBe(429);
    expect((await run(mw, '/api/tickets', shared, token(`u2-${shared}`))).passed).toBe(true);
  });
});
