#!/usr/bin/env node
// Post-deploy smoke test. Run it through deploy/scripts/11-smoke-test.sh (which loads the secrets
// without printing them). Plain Node 22, no dependencies. Exit code 0 only if nothing FAILED.
//
// Environment: JWT_SECRET, RAZORPAY_WEBHOOK_SECRET (required), PUBLIC_URL (https://<domain>, so the
// webhook goes through Caddy), GATEWAY_URL (default http://127.0.0.1:3000), SMOKE_EVENT_ID (optional).
import { createHmac, randomBytes } from 'node:crypto';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:3000';
const PUBLIC = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET ?? '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
if (!JWT_SECRET || !WEBHOOK_SECRET) {
  console.error('JWT_SECRET and RAZORPAY_WEBHOOK_SECRET are required (use 11-smoke-test.sh)');
  process.exit(2);
}

const results = [];
const record = (status, name, detail = '') => {
  results.push({ status, name });
  console.log(`${status.padEnd(4)}  ${name}${detail ? `  (${detail})` : ''}`);
};
async function check(name, fn) {
  try {
    const detail = await fn();
    if (detail === 'SKIP') record('SKIP', name);
    else record('PASS', name, typeof detail === 'string' ? detail : '');
  } catch (e) {
    record('FAIL', name, e.message);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HS256 token, same format as services/gateway/src/auth/jwt.ts (the gateway verifies it with JWT_SECRET)
const b64 = (x) => Buffer.from(x).toString('base64url');
function token(sub, role) {
  const iat = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub, role, iat, exp: iat + 1800 }));
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

async function http(method, url, { auth, body, headers = {}, raw } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(raw === undefined ? { 'content-type': 'application/json' } : { 'content-type': 'application/json' }),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

// ── 1. /health on every process ─────────────────────────────────────────────
console.log('\n[1] /health on every process (direct, on this server)');
const HEALTH = {
  gateway: 3000, catalog: 3001, 'seat-inventory': 3002, booking: 3003,
  payment: 3004, ticket: 3005, notification: 3006, analytics: 3007,
};
for (const [name, port] of Object.entries(HEALTH)) {
  await check(`${name} /health`, async () => {
    const r = await http('GET', `http://127.0.0.1:${port}/health`);
    assert(r.status === 200, `HTTP ${r.status}`);
  });
}
await check('web app serves the front page', async () => {
  const r = await http('GET', 'http://127.0.0.1:3100/sign-in');
  assert(r.status === 200, `HTTP ${r.status}`);
});

// ── 2. gateway reaches each service ─────────────────────────────────────────
console.log('\n[2] the gateway reaching each service');
const attendee = `smoke-${Date.now()}`;
const tAttendee = token(attendee, 'attendee');
const tOrganizer = token('smoke-organizer', 'organizer');
let events = [];
await check('gateway -> catalog + seat-inventory (GET /api/events)', async () => {
  const r = await http('GET', `${GATEWAY}/api/events`, { auth: tAttendee });
  assert(r.status === 200 && Array.isArray(r.json), `HTTP ${r.status}`);
  events = r.json;
  assert(events.length > 0, 'no events: run deploy/scripts/08-seed.sh');
  return `${events.length} events`;
});
await check('gateway -> payment (GET /api/payments/config is razorpay)', async () => {
  const r = await http('GET', `${GATEWAY}/api/payments/config`, { auth: tAttendee });
  assert(r.status === 200 && r.json?.provider === 'razorpay', `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  assert(String(r.json.keyId).startsWith('rzp_test_'), 'key id is not a test key');
});
await check('gateway -> booking (unknown booking is a clean 404)', async () => {
  const r = await http('GET', `${GATEWAY}/api/bookings/00000000-0000-0000-0000-000000000000`, { auth: tAttendee });
  assert(r.status === 404, `HTTP ${r.status}`);
});
await check('gateway -> ticket (GET /api/tickets)', async () => {
  const r = await http('GET', `${GATEWAY}/api/tickets`, { auth: tAttendee });
  assert(r.status === 200 && Array.isArray(r.json), `HTTP ${r.status}`);
});
await check('gateway rejects a request with no token', async () => {
  const r = await http('GET', `${GATEWAY}/api/tickets`);
  assert(r.status === 401, `HTTP ${r.status}`);
});
await check('demo sign-in is off (POST /api/dev-login is not served)', async () => {
  const r = await http('POST', `${GATEWAY}/api/dev-login`, { body: { role: 'organizer' } });
  assert(r.status === 404 || r.status === 403, `HTTP ${r.status}: demo sign-in must be disabled`);
});

// ── 3. webhook endpoint: signature checks (through Caddy when PUBLIC_URL is set) ──
console.log('\n[3] webhook signature handling (signed by THIS script with your webhook secret, not by Razorpay)');
const WEBHOOK = PUBLIC ? `${PUBLIC}/webhooks/razorpay` : 'http://127.0.0.1:3004/webhooks/razorpay';
const sign = (raw) => createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
const eventBody = (paymentId, event = 'payment.captured') =>
  JSON.stringify({
    event,
    payload: { payment: { entity: { id: `pay_smoke${randomBytes(4).toString('hex')}`, order_id: 'order_smoke', notes: { paymentId } } } },
  });
const postWebhook = (raw, signature, eventId) =>
  http('POST', WEBHOOK, {
    raw,
    headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': eventId },
  });
if (!PUBLIC) console.log('      (PUBLIC_URL not set: testing the payment service directly, Caddy routing is NOT covered)');
await check('valid signature is accepted (unknown payment id -> 200 "unmatched", no side effects)', async () => {
  const raw = eventBody('00000000-0000-0000-0000-000000000000');
  const r = await postWebhook(raw, sign(raw), `evt_smoke_${randomBytes(6).toString('hex')}`);
  assert(r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  return `result=${r.json?.result}`;
});
await check('bad signature is rejected (400)', async () => {
  const raw = eventBody('00000000-0000-0000-0000-000000000000');
  const r = await postWebhook(raw, sign(raw + 'x'), `evt_smoke_${randomBytes(6).toString('hex')}`);
  assert(r.status === 400, `HTTP ${r.status}`);
});
await check('missing signature is rejected (400)', async () => {
  const raw = eventBody('00000000-0000-0000-0000-000000000000');
  const r = await postWebhook(raw, '', `evt_smoke_${randomBytes(6).toString('hex')}`);
  assert(r.status === 400, `HTTP ${r.status}`);
});
await check('the fake provider webhook is not served (POST /webhooks/fake)', async () => {
  const r = await http('POST', WEBHOOK.replace('/razorpay', '/fake'), { raw: '{}' });
  assert(r.status === 404, `HTTP ${r.status}`);
});

// ── 4. a booking: hold -> pay -> ticket issued ──────────────────────────────
console.log('\n[4] booking: hold, pay, ticket issued');
console.log('      Razorpay cannot be paid by a script (the buyer pays in Razorpay\'s window), so the payment');
console.log('      step creates a REAL Razorpay test-mode order, then this script delivers the signed');
console.log('      payment.captured webhook itself. This tests Gatepass end to end, not Razorpay\'s delivery.');
let bookingId, paymentId, seatId, eventId;
await check('pick an event that has a free seat and no waiting room', async () => {
  const wanted = process.env.SMOKE_EVENT_ID;
  const candidates = events.filter((e) => (wanted ? e.id === wanted : !e.waitingRoom && e.availability?.available > 0));
  assert(candidates.length > 0, 'no suitable event (set SMOKE_EVENT_ID, or seed the demo shows)');
  for (const e of candidates) {
    const r = await http('GET', `${GATEWAY}/api/events/${e.id}/seats`, { auth: tAttendee });
    const free = Array.isArray(r.json) ? r.json.find((s) => s.state === 'available') : undefined;
    if (free) {
      eventId = e.id;
      seatId = free.id;
      return `${e.id}, seat ${seatId}`;
    }
  }
  throw new Error('no available seat found');
});
if (eventId) {
  await check('POST /api/bookings creates a booking', async () => {
    const r = await http('POST', `${GATEWAY}/api/bookings`, { auth: tAttendee, body: { eventId, seatIds: [seatId] } });
    assert(r.status === 201 && r.json?.id, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    bookingId = r.json.id;
  });
}
const waitFor = async (what, fn, tries = 40, ms = 500) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(ms);
  }
  throw new Error(`timed out waiting for ${what}`);
};
if (bookingId) {
  await check('seats are held (booking -> seat-inventory over Kafka)', async () => {
    const b = await waitFor('HELD', async () => {
      const r = await http('GET', `${GATEWAY}/api/bookings/${bookingId}`, { auth: tAttendee });
      if (r.json?.state === 'CANCELLED') throw new Error('booking was cancelled');
      return r.json?.state === 'HELD' ? r.json : null;
    });
    assert(b.holdExpiresAt, 'no holdExpiresAt');
  });
  await check('POST /api/bookings/:id/pay creates a Razorpay test order (202)', async () => {
    const r = await http('POST', `${GATEWAY}/api/bookings/${bookingId}/pay`, {
      auth: tAttendee,
      body: { method: 'upi', token: 'smoke-test' },
      headers: { 'idempotency-key': `smoke-${randomBytes(8).toString('hex')}` },
    });
    assert(r.status === 202 && r.json?.paymentId, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    paymentId = r.json.paymentId;
    return `status=${r.json.status}, order=${r.json.providerRef ?? 'none'}`;
  });
}
if (paymentId) {
  const raw = eventBody(paymentId);
  const sig = sign(raw);
  const evId = `evt_smoke_${randomBytes(6).toString('hex')}`;
  await check('signed payment.captured webhook is applied (200)', async () => {
    const r = await postWebhook(raw, sig, evId);
    assert(r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
    return `result=${r.json?.result}`;
  });
  await check('the same webhook delivered again is a harmless duplicate (200)', async () => {
    const r = await postWebhook(raw, sig, evId);
    assert(r.status === 200 && r.json?.result === 'duplicate', `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  });
  await check('booking becomes CONFIRMED (payment -> booking over Kafka)', async () => {
    await waitFor('CONFIRMED', async () => {
      const r = await http('GET', `${GATEWAY}/api/bookings/${bookingId}`, { auth: tAttendee });
      return r.json?.state === 'CONFIRMED';
    }, 60);
  });
  await check('ticket is issued with a QR token (booking -> ticket over Kafka)', async () => {
    const list = await waitFor('ticket', async () => {
      const r = await http('GET', `${GATEWAY}/api/tickets`, { auth: tAttendee });
      return Array.isArray(r.json) && r.json.length > 0 ? r.json : null;
    }, 60);
    assert(list.every((t) => typeof t.qrToken === 'string' && t.qrToken.length > 20), 'ticket has no qrToken');
  });
  await check('gateway -> analytics (organizer summary for that event)', async () => {
    const r = await http('GET', `${GATEWAY}/api/organizer/events/${eventId}/summary`, { auth: tOrganizer });
    assert(r.status === 200, `HTTP ${r.status}`);
  });
} else {
  for (const n of ['signed webhook applied', 'duplicate webhook', 'booking CONFIRMED', 'ticket issued', 'analytics'])
    record('SKIP', `${n} (no payment was created)`);
}

// ── summary ────────────────────────────────────────────────────────────────
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
console.log('NOT covered by this script: Razorpay itself delivering a webhook, a real UPI/card payment in the');
console.log('browser, Google sign-in, ports being closed to the outside, and the waiting-room event. See deploy/CHECKLIST.md.');
process.exit(count('FAIL') ? 1 : 0);
