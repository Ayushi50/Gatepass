import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ActivityStreamHub,
  BookingStreamHub,
  GatewayModule,
  SeatStreamHub,
  WaitingRoom,
  verifyToken,
  type GatewayOptions,
} from '../src';

const SECRET = 'a-test-secret-that-is-long-enough-123';
const CLIENT = 'client-123.apps.googleusercontent.com';
const REDIRECT = 'http://127.0.0.1:3100/api/auth/google/callback';

/** A stand-in for Google's token endpoint. It answers with whatever `next` says. */
interface Fake {
  server: Server;
  url: string;
  claims: (nonce: string) => Record<string, unknown>;
  used: Set<string>;
  lastNonce: string;
}
async function fakeGoogle(): Promise<Fake> {
  const fake = {
    used: new Set<string>(),
    lastNonce: '',
    claims: (nonce: string) => ({
      iss: 'https://accounts.google.com',
      aud: CLIENT,
      sub: '1100',
      email: 'asha@example.com',
      email_verified: true,
      name: 'Asha',
      nonce,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  } as unknown as Fake;
  fake.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const code = form.get('code') ?? '';
      if (
        form.get('client_secret') !== 'shh' ||
        form.get('redirect_uri') !== REDIRECT ||
        fake.used.has(code)
      ) {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
        return;
      }
      fake.used.add(code);
      const idToken = `x.${Buffer.from(JSON.stringify(fake.claims(fake.lastNonce))).toString('base64url')}.y`;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id_token: idToken, access_token: 'at' }));
    });
  });
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

async function appWith(google: GatewayOptions['google'], now?: () => number) {
  const stub = {} as never;
  const mod = await Test.createTestingModule({
    imports: [
      GatewayModule.forRoot({
        catalog: stub,
        inventory: stub,
        bookings: stub,
        payments: stub,
        tickets: stub,
        analytics: stub,
        hub: new SeatStreamHub(),
        bookingHub: new BookingStreamHub(),
        activityHub: new ActivityStreamHub(),
        waitingRoom: new WaitingRoom({} as never, { admitPerSecond: 5, admissionTtlSeconds: 300 }),
        jwtSecret: SECRET,
        google: google && { ...google, now },
      }),
    ],
  }).compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

describe('Google sign-in', () => {
  let fake: Fake;
  let app: INestApplication;
  const config = () => ({
    clientId: CLIENT,
    clientSecret: 'shh',
    redirectUri: REDIRECT,
    authUrl: `${fake.url}/auth`,
    tokenUrl: `${fake.url}/token`,
    organizerEmails: ['boss@example.com'],
    doorStaffEmails: ['gate@example.com'],
  });
  beforeEach(async () => {
    fake = await fakeGoogle();
    app = await appWith(config());
  });
  afterEach(async () => {
    await app.close();
    fake.server.close();
  });

  /** Walks the first leg like a browser and returns what it would send back. */
  async function start(next?: string) {
    const res = await request(app.getHttpServer())
      .get('/api/auth/google/start')
      .query(next ? { next } : {})
      .expect(302);
    const loc = new URL(res.headers.location!);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    fake.lastNonce = loc.searchParams.get('nonce')!;
    return { res, loc, cookie, state: loc.searchParams.get('state')! };
  }
  const callback = (q: Record<string, string>, cookie?: string) =>
    request(app.getHttpServer())
      .get('/api/auth/google/callback')
      .query(q)
      .set(cookie ? { cookie } : {});
  const fragment = (location: string) =>
    new URLSearchParams(new URL(location, 'http://x').hash.slice(1));

  it('sends the browser to Google with state, nonce and the right client', async () => {
    const { loc, res } = await start();
    expect(loc.origin + loc.pathname).toBe(`${fake.url}/auth`);
    expect(loc.searchParams.get('client_id')).toBe(CLIENT);
    expect(loc.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(loc.searchParams.get('response_type')).toBe('code');
    expect(loc.searchParams.get('scope')).toContain('openid');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('nonce')).toBeTruthy();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('turns a good sign-in into a Gatepass token for an attendee, and returns to the page asked for', async () => {
    const { cookie, state } = await start('/seats?event=laugh-lab');
    const res = await callback({ code: 'c1', state }, cookie).expect(302);
    const f = fragment(res.headers.location!);
    const claims = verifyToken(f.get('token')!, SECRET);
    expect(claims).toMatchObject({ sub: 'g-1100', role: 'attendee' });
    expect(f.get('next')).toBe('/seats?event=laugh-lab');
    expect(res.headers.location).toMatch(/^\/sign-in#/);
  });

  it('gives organizer and door-staff roles only to the listed, verified emails', async () => {
    for (const [email, role] of [
      ['boss@example.com', 'organizer'],
      ['GATE@example.com', 'door-staff'],
      ['someone@example.com', 'attendee'],
    ] as const) {
      fake.claims = (nonce) => ({
        iss: 'accounts.google.com',
        aud: CLIENT,
        sub: '7',
        email,
        email_verified: true,
        nonce,
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const { cookie, state } = await start();
      const res = await callback({ code: `c-${email}`, state }, cookie).expect(302);
      expect(verifyToken(fragment(res.headers.location!).get('token')!, SECRET).role).toBe(role);
    }
  });

  it('refuses a callback whose state was changed, missing, or started in another browser', async () => {
    const a = await start();
    const b = await start();
    const bad = [
      callback({ code: 'c', state: a.state + 'x' }, a.cookie),
      callback({ code: 'c', state: a.state }), // no cookie
      callback({ code: 'c', state: a.state }, b.cookie), // someone else's cookie
      callback({ code: 'c' }, a.cookie), // no state
      callback({ state: a.state }, a.cookie), // no code
    ];
    for (const p of bad) {
      const res = await p.expect(302);
      expect(res.headers.location).toMatch(/^\/sign-in\?error=/);
      expect(res.headers.location).not.toMatch(/[#&?]token=/);
    }
    expect(fake.used.size).toBe(0); // none of them even reached Google
  });

  it('refuses a callback that took more than ten minutes', async () => {
    let t = 1_000_000;
    await app.close();
    app = await appWith(config(), () => t);
    const { cookie, state } = await start();
    t += 11 * 60_000;
    const res = await callback({ code: 'c', state }, cookie).expect(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('refuses a code Google already honoured once', async () => {
    const first = await start();
    await callback({ code: 'same', state: first.state }, first.cookie).expect(302);
    const second = await start();
    const res = await callback({ code: 'same', state: second.state }, second.cookie).expect(302);
    expect(res.headers.location).toMatch(/error=/);
    expect(res.headers.location).not.toMatch(/[#&?]token=/);
  });

  it.each([
    ['an unverified email', { email_verified: false }],
    ['a token meant for another app', { aud: 'someone-else' }],
    ['a token from another issuer', { iss: 'https://evil.example' }],
    ['an expired token', { exp: 1 }],
    ['a token with the wrong nonce', { nonce: 'not-the-one' }],
    ['a token with no subject', { sub: undefined }],
  ])('refuses %s', async (_name, change) => {
    const base = fake.claims;
    fake.claims = (n) => ({ ...base(n), ...change });
    const { cookie, state } = await start();
    const res = await callback({ code: 'c', state }, cookie).expect(302);
    expect(res.headers.location).toMatch(/^\/sign-in\?error=/);
    expect(res.headers.location).not.toMatch(/[#&?]token=/);
  });

  it('handles Google saying no (the user pressed Cancel)', async () => {
    const { cookie, state } = await start();
    const res = await callback({ error: 'access_denied', state }, cookie).expect(302);
    expect(res.headers.location).toMatch(/^\/sign-in\?error=/);
  });

  it('only ever returns to a page on this site', async () => {
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const { cookie, state } = await start(next);
      const res = await callback({ code: `c${next}`, state }, cookie).expect(302);
      expect(fragment(res.headers.location!).get('next') ?? '').toBe('');
    }
  });

  it('says what sign-in methods exist', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/config')
      .expect(200, { google: true, demo: false });
    const bare = await appWith(undefined);
    await request(bare.getHttpServer())
      .get('/api/auth/config')
      .expect(200, { google: false, demo: false });
    await request(bare.getHttpServer()).get('/api/auth/google/start').expect(404);
    await request(bare.getHttpServer()).get('/api/auth/google/callback').expect(404);
    await bare.close();
  });
});

describe('GET /api/payments/config', () => {
  async function appPayments(payments: GatewayOptions['paymentsConfig']) {
    const stub = {} as never;
    const mod = await Test.createTestingModule({
      imports: [
        GatewayModule.forRoot({
          catalog: stub,
          inventory: stub,
          bookings: stub,
          payments: stub,
          tickets: stub,
          analytics: stub,
          hub: new SeatStreamHub(),
          bookingHub: new BookingStreamHub(),
          activityHub: new ActivityStreamHub(),
          waitingRoom: new WaitingRoom({} as never, {
            admitPerSecond: 5,
            admissionTtlSeconds: 300,
          }),
          jwtSecret: SECRET,
          paymentsConfig: payments,
        }),
      ],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    return app;
  }
  it('says which payment provider checkout should use, and only ever a publishable key', async () => {
    const fake = await appPayments(undefined);
    await request(fake.getHttpServer())
      .get('/api/payments/config')
      .expect(200, { provider: 'fake' });
    await fake.close();
    const stripe = await appPayments({ provider: 'stripe', publishableKey: 'pk_test_abc' });
    await request(stripe.getHttpServer())
      .get('/api/payments/config')
      .expect(200, { provider: 'stripe', publishableKey: 'pk_test_abc' });
    await stripe.close();
  });
});
