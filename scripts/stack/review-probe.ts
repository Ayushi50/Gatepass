/* eslint-disable @typescript-eslint/no-explicit-any -- probing arbitrary JSON answers */
// `pnpm review:probe`: boots the real system and attacks it from outside: missing and wrong roles,
// one user reading another's data, forged tokens, bad input, request floods, a Kafka restart.
// Prints one line per probe; exits 1 if any probe finds a hole.
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signToken } from '@gatepass/gateway';
import { sleep, waitForPort } from './infra';
import { JWT_SECRET, PORTS, startStack } from './stack';

const G = `http://127.0.0.1:${PORTS.gateway}`;
type Role = 'attendee' | 'organizer' | 'door-staff';
const tok = (sub: string, role: Role, secret = JWT_SECRET, ttlSeconds = 3600) =>
  signToken({ sub, role }, secret, { ttlSeconds });
const results: { ok: boolean; name: string; detail: string }[] = [];
const record = (ok: boolean, name: string, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'HOLE'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

async function req(
  method: string,
  url: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(url.startsWith('http') ? url : G + url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}
/** First status line of an SSE endpoint, without waiting for the stream to end. */
async function sseStatus(path: string, token?: string): Promise<number> {
  const ac = new AbortController();
  try {
    const res = await fetch(G + path, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: ac.signal,
    });
    return res.status;
  } finally {
    ac.abort();
  }
}
async function waitState(who: string, id: string, want: string[], ms = 40_000): Promise<string> {
  const end = Date.now() + ms;
  let s = '';
  while (Date.now() < end) {
    s = (await req('GET', `/api/bookings/${id}`, tok(who, 'attendee'))).body?.state;
    if (want.includes(s)) return s;
    await sleep(300);
  }
  return s;
}
async function buy(who: string, event: string, seatIds: string[]): Promise<string> {
  const b = await req('POST', '/api/bookings', tok(who, 'attendee'), { eventId: event, seatIds });
  if (b.status !== 201) throw new Error(`booking ${b.status} ${JSON.stringify(b.body)}`);
  await waitState(who, b.body.id, ['HELD']);
  await req(
    'POST',
    `/api/bookings/${b.body.id}/pay`,
    tok(who, 'attendee'),
    { method: 'upi', token: 'tok_success' },
    { 'idempotency-key': `probe-${b.body.id}` },
  );
  await waitState(who, b.body.id, ['CONFIRMED']);
  return b.body.id;
}

async function main(): Promise<void> {
  const stack = await startStack({ web: false, seed: true });
  try {
    const alice = tok('alice', 'attendee');
    const mallory = tok('mallory', 'attendee');
    const bookingId = await buy('alice', 'laugh-lab', ['D1', 'D2']);
    let tickets: any[] = [];
    for (let i = 0; i < 60 && tickets.length < 2; i++) {
      tickets = (await req('GET', '/api/tickets', alice)).body;
      await sleep(300);
    }

    console.log('\n-- no token, wrong role');
    const guarded: [string, string, Role, unknown?][] = [
      ['POST', '/api/bookings', 'attendee', { eventId: 'laugh-lab', seatIds: ['F9'] }],
      ['GET', `/api/bookings/${bookingId}`, 'attendee'],
      [
        'POST',
        `/api/bookings/${bookingId}/pay`,
        'attendee',
        { method: 'upi', token: 'tok_success' },
      ],
      ['GET', '/api/tickets', 'attendee'],
      ['POST', `/api/tickets/${tickets[0]?.id}/refund`, 'attendee', {}],
      ['POST', '/api/checkin', 'door-staff', { qrToken: 'x' }],
      ['GET', '/api/organizer/events/laugh-lab/summary', 'organizer'],
      ['GET', '/api/organizer/events/laugh-lab/refunds', 'organizer'],
      ['POST', '/api/refunds/some-id/approve', 'organizer', {}],
    ];
    const others: Record<Role, Role> = {
      attendee: 'door-staff',
      organizer: 'attendee',
      'door-staff': 'attendee',
    };
    for (const [m, p, role, body] of guarded) {
      const none = await req(m, p, undefined, body);
      record(
        none.status === 401,
        `${m} ${p.replace(bookingId, ':id')} without a token is refused`,
        String(none.status),
      );
      const wrong = await req(m, p, tok('someone', others[role]), body);
      record(
        wrong.status === 403,
        `${m} ${p.replace(bookingId, ':id')} with the wrong role is refused`,
        String(wrong.status),
      );
    }
    for (const p of [
      `/api/bookings/${bookingId}/stream`,
      '/api/organizer/events/laugh-lab/activity',
    ]) {
      const s = await sseStatus(p);
      record(
        s === 401,
        `stream ${p.replace(bookingId, ':id')} without a token is refused`,
        String(s),
      );
    }

    console.log('\n-- forged and stale tokens');
    const parts = alice.split('.');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${parts[1]}.`;
    for (const [name, t] of [
      [
        'signed with another secret',
        tok('alice', 'attendee', 'some-other-secret-that-is-32-characters-long'),
      ],
      ['alg none', none],
      ['expired', tok('alice', 'attendee', JWT_SECRET, -10)],
      [
        'payload swapped to organizer',
        `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'alice', role: 'organizer', exp: 9999999999 })).toString('base64url')}.${parts[2]}`,
      ],
    ] as const) {
      const r = await req('GET', '/api/tickets', t);
      record(r.status === 401, `token ${name} is refused`, String(r.status));
    }

    console.log("\n-- one user reaching for another's things");
    const peek = await req('GET', `/api/bookings/${bookingId}`, mallory);
    record([403, 404].includes(peek.status), "reading someone else's booking", String(peek.status));
    const pay = await req(
      'POST',
      `/api/bookings/${bookingId}/pay`,
      mallory,
      { method: 'upi', token: 'tok_success' },
      { 'idempotency-key': 'mallory-key-00001' },
    );
    record([403, 404].includes(pay.status), "paying someone else's booking", String(pay.status));
    const st = await sseStatus(`/api/bookings/${bookingId}/stream`, mallory);
    record([403, 404].includes(st), "watching someone else's booking stream", String(st));
    const theirs = await req('GET', '/api/tickets', mallory);
    record(
      Array.isArray(theirs.body) && theirs.body.length === 0,
      "listing tickets shows only one's own",
      `${theirs.body?.length} tickets`,
    );
    const ref = await req('POST', `/api/tickets/${tickets[0]?.id}/refund`, mallory, {});
    record([403, 404].includes(ref.status), "refunding someone else's ticket", String(ref.status));
    const otherOrg = tok('org-someone-else', 'organizer');
    for (const p of [
      '/api/organizer/events/laugh-lab/summary',
      '/api/organizer/events/laugh-lab/refunds',
    ]) {
      const r = await req('GET', p, otherOrg);
      record([403, 404].includes(r.status), `another organizer reading ${p}`, String(r.status));
    }
    const act = await sseStatus('/api/organizer/events/laugh-lab/activity', otherOrg);
    record([403, 404].includes(act), 'another organizer watching the activity stream', String(act));

    console.log('\n-- bad input');
    const bad: [string, unknown][] = [
      [
        'seven seats',
        { eventId: 'laugh-lab', seatIds: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'] },
      ],
      ['no seats', { eventId: 'laugh-lab', seatIds: [] }],
      ['the same seat twice', { eventId: 'laugh-lab', seatIds: ['E1', 'E1'] }],
      ['seatIds not a list', { eventId: 'laugh-lab', seatIds: 'E1' }],
      ['seat ids that are objects', { eventId: 'laugh-lab', seatIds: [{ a: 1 }] }],
      ['no event', { seatIds: ['E1'] }],
      ['an SQL fragment as the event', { eventId: "x'; DROP TABLE bookings;--", seatIds: ['E1'] }],
      ['a 5,000-character seat id', { eventId: 'laugh-lab', seatIds: ['E'.repeat(5000)] }],
    ];
    for (const [name, body] of bad) {
      const r = await req('POST', '/api/bookings', alice, body);
      let end = '';
      if (r.status === 201)
        end = await waitState('alice', r.body.id, ['CANCELLED', 'HELD'], 15_000);
      // refused at the door (4xx), or accepted and then cleanly cancelled by the saga
      record(
        (r.status >= 400 && r.status < 500) || end === 'CANCELLED',
        `booking with ${name}`,
        `${r.status}${end ? ' then ' + end : ''}`,
      );
    }
    const junk = await req('POST', '/api/bookings', alice, '{not json');
    record(junk.status === 400, 'malformed JSON body', String(junk.status));
    const big = await req('POST', '/api/bookings', alice, {
      eventId: 'laugh-lab',
      seatIds: ['E1'],
      pad: 'x'.repeat(2_000_000),
    });
    record(big.status === 413 || big.status === 400, 'a 2 MB body is refused', String(big.status));
    const noKey = await req('POST', `/api/bookings/${bookingId}/pay`, alice, {
      method: 'upi',
      token: 'tok_success',
    });
    record(noKey.status === 400, 'paying without an Idempotency-Key', String(noKey.status));
    const leak = await req('GET', '/api/bookings/not-a-real-id', alice);
    record(
      !JSON.stringify(leak.body).match(/at .*\.(ts|js):\d+|SELECT |pg_/),
      'errors do not leak stack traces or SQL',
      `${leak.status} ${JSON.stringify(leak.body).slice(0, 80)}`,
    );

    console.log('\n-- webhook, internal ports, CORS, health');
    const forged = await req(
      'POST',
      `http://127.0.0.1:${PORTS.payment}/webhooks/fake`,
      undefined,
      { id: 'evt_x', type: 'payment.succeeded', paymentId: 'nope' },
      { 'x-fake-signature': 'deadbeef' },
    );
    record(
      [400, 401].includes(forged.status),
      'a webhook with a forged signature is refused',
      String(forged.status),
    );
    const direct = await req(
      'GET',
      `http://127.0.0.1:${PORTS.booking}/bookings/${bookingId}`,
      undefined,
      undefined,
      { 'x-user-id': 'mallory' },
    );
    // F-04: internal services demand the shared token; claiming a user id is not enough
    record(
      direct.status === 401,
      'an internal service refuses a caller with no internal token',
      String(direct.status),
    );
    const wrong = await req(
      'GET',
      `http://127.0.0.1:${PORTS.booking}/bookings/${bookingId}`,
      undefined,
      undefined,
      { 'x-user-id': 'mallory', 'x-internal-token': 'x'.repeat(40) },
    );
    record(
      wrong.status === 401,
      'an internal service refuses a wrong internal token',
      String(wrong.status),
    );
    const cors = await req('OPTIONS', '/api/events', undefined, undefined, {
      origin: 'https://evil.example',
      'access-control-request-method': 'GET',
    });
    record(
      !cors.headers.get('access-control-allow-origin'),
      'no CORS permission for a foreign origin',
      cors.headers.get('access-control-allow-origin') ?? 'none',
    );
    for (const [name, port] of Object.entries({
      gateway: PORTS.gateway,
      catalog: PORTS.catalog,
      inventory: PORTS.inventory,
      booking: PORTS.booking,
      payment: PORTS.payment,
      ticket: PORTS.ticket,
      analytics: PORTS.analytics,
    })) {
      const h = await req('GET', `http://127.0.0.1:${port}/health`).catch(() => ({
        status: 0,
        body: '',
      }));
      record(
        h.status === 200,
        `${name} answers /health`,
        `${h.status} ${JSON.stringify(h.body).slice(0, 60)}`,
      );
    }

    console.log('\n-- request flood');
    const flood = await Promise.all(
      Array.from({ length: 400 }, () =>
        req('POST', '/api/dev-login', undefined, { role: 'attendee', name: 'flood' })
          .then((r) => r.status)
          .catch(() => 0),
      ),
    );
    const limited = flood.filter((s) => s === 429).length;
    record(
      limited > 0,
      '400 sign-ins at once from one client are rate limited',
      `${limited} of 400 answered 429`,
    );
    const flood2 = await Promise.all(
      Array.from({ length: 450 }, () =>
        req('GET', `/api/bookings/${bookingId}`, alice)
          .then((r) => r.status)
          .catch(() => 0),
      ),
    );
    record(
      flood2.filter((s) => s === 429).length > 0,
      '450 API calls at once from one user are rate limited',
      `${flood2.filter((s) => s === 429).length} of 450 answered 429`,
    );

    console.log('\n-- Kafka restart with bookings in flight');
    const dirs = readdirSync(tmpdir())
      .filter((d) => d.startsWith('gatepass-kafka-'))
      .map((d) => join(tmpdir(), d))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const config = join(dirs[0]!, 'server.properties');
    const pids = execFileSync('pgrep', ['-f', config]).toString().trim().split('\n');
    for (const p of pids) process.kill(Number(p), 'SIGKILL');
    await sleep(2000);
    const during = await Promise.all(
      ['G1', 'G2', 'G3'].map((s, i) =>
        req('POST', '/api/bookings', tok(`outage-${i}`, 'attendee'), {
          eventId: 'midnight-market',
          seatIds: [s.replace('G', 'B')],
        }),
      ),
    );
    record(
      during.every((r) => r.status === 201),
      'bookings are still accepted while Kafka is down',
      during.map((r) => r.status).join(','),
    );
    await sleep(8000);
    const child = spawn(join(process.env.KAFKA_HOME!, 'bin', 'kafka-server-start.sh'), [config], {
      stdio: 'ignore',
      env: process.env,
    });
    await waitForPort(29092, 90_000);
    const ends = await Promise.all(
      during.map((r, i) => waitState(`outage-${i}`, r.body.id, ['HELD', 'CANCELLED'], 90_000)),
    );
    record(
      ends.every((s) => s === 'HELD'),
      'after Kafka returns every one of them is held: nothing lost',
      ends.join(','),
    );
    const after = await buy('after-outage', 'midnight-market', ['C1'])
      .then(() => 'CONFIRMED')
      .catch((e) => String(e));
    record(after === 'CONFIRMED', 'a full purchase works after the restart', after);
    child.kill('SIGKILL');
  } finally {
    await stack.stop();
  }
  const holes = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - holes.length} of ${results.length} probes passed; ${holes.length} holes`,
  );
  process.exit(holes.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
