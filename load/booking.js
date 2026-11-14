/* global __ENV, __VU -- provided by k6 */
// k6 load test: many buyers fighting over the seats of one 1,000-seat show.
// Run it with `pnpm loadtest` (which boots the system, runs this, then checks the databases).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.GATEWAY_URL || 'http://127.0.0.1:3000';
const EVENT = __ENV.EVENT_ID || 'load-show';
const PEAK = Number(__ENV.PEAK_VUS || 50);

const holdTime = new Trend('gatepass_hold_decision_ms', true); // booking request -> held or refused
const confirmTime = new Trend('gatepass_pay_to_confirmed_ms', true); // pay -> confirmed
const journeyTime = new Trend('gatepass_booking_journey_ms', true); // request -> confirmed
const requested = new Counter('gatepass_bookings_requested');
const confirmed = new Counter('gatepass_bookings_confirmed');
const lostRace = new Counter('gatepass_seats_already_taken');
const stuck = new Counter('gatepass_bookings_stuck');
const duplicatePays = new Counter('gatepass_duplicate_pay_requests');

export const options = {
  scenarios: {
    rush: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: Math.ceil(PEAK / 5) },
        { duration: '15s', target: PEAK },
        { duration: '30s', target: PEAK },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    gatepass_bookings_stuck: ['count==0'],
  },
};

const json = (token, extra) => ({
  headers: Object.assign(
    { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    extra || {},
  ),
});

export function setup() {
  const login = http.post(
    `${BASE}/api/dev-login`,
    JSON.stringify({ role: 'attendee', name: 'load-setup' }),
    {
      headers: { 'content-type': 'application/json' },
    },
  );
  const token = login.json('token');
  const seats = http.get(`${BASE}/api/events/${EVENT}/seats`, json(token)).json();
  return { seatIds: seats.map((s) => s.seatId || s.id) };
}

let token; // one signed-in buyer per virtual user
function signIn() {
  const r = http.post(
    `${BASE}/api/dev-login`,
    JSON.stringify({ role: 'attendee', name: `load-vu-${__VU}` }),
    {
      headers: { 'content-type': 'application/json' },
    },
  );
  token = r.json('token');
}

function waitFor(id, wanted, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let state = '';
  while (Date.now() < end) {
    const r = http.get(
      `${BASE}/api/bookings/${id}`,
      Object.assign(json(token), { tags: { name: 'GET booking' } }),
    );
    state = r.status === 200 ? r.json('state') : '';
    if (wanted.includes(state)) return state;
    sleep(0.1);
  }
  return state;
}

export default function (data) {
  if (!token) signIn();
  // one or two neighbouring seats picked at random: buyers collide more and more as the show fills
  const i = Math.floor(Math.random() * data.seatIds.length);
  const seatIds =
    Math.random() < 0.5 || i + 1 >= data.seatIds.length
      ? [data.seatIds[i]]
      : [data.seatIds[i], data.seatIds[i + 1]];

  const t0 = Date.now();
  const b = http.post(
    `${BASE}/api/bookings`,
    JSON.stringify({ eventId: EVENT, seatIds }),
    Object.assign(json(token), { tags: { name: 'POST booking' } }),
  );
  requested.add(1);
  if (!check(b, { 'booking accepted': (r) => r.status === 201 })) return;
  const id = b.json('id');

  const held = waitFor(id, ['HELD', 'CANCELLED'], 30000);
  holdTime.add(Date.now() - t0);
  if (held === 'CANCELLED') return void lostRace.add(1); // someone else got the seat: the correct answer
  if (held !== 'HELD') return void stuck.add(1);

  // pay; one time in five the buyer double-clicks, sending the same payment twice at once
  const t1 = Date.now();
  const pay = () => ({
    method: 'POST',
    url: `${BASE}/api/bookings/${id}/pay`,
    body: JSON.stringify({ method: 'upi', token: 'tok_success' }),
    params: Object.assign(json(token, { 'idempotency-key': `load-${id}` }), {
      tags: { name: 'POST pay' },
    }),
  });
  const double = Math.random() < 0.2;
  if (double) duplicatePays.add(1);
  const paid = http.batch(double ? [pay(), pay()] : [pay()]);
  check(paid[0], { 'payment accepted': (r) => r.status === 202 });

  const done = waitFor(id, ['CONFIRMED', 'CANCELLED'], 30000);
  if (done === 'CONFIRMED') {
    confirmTime.add(Date.now() - t1);
    journeyTime.add(Date.now() - t0);
    confirmed.add(1);
  } else stuck.add(1);
}

export function handleSummary(data) {
  const out = {};
  if (__ENV.SUMMARY_PATH) out[__ENV.SUMMARY_PATH] = JSON.stringify(data);
  const m = data.metrics;
  const line = (k) => (m[k] ? `${k}: ${JSON.stringify(m[k].values)}` : `${k}: none`);
  out.stdout =
    [
      'http_reqs',
      'http_req_duration',
      'http_req_failed',
      'gatepass_bookings_requested',
      'gatepass_bookings_confirmed',
      'gatepass_seats_already_taken',
      'gatepass_bookings_stuck',
      'gatepass_booking_journey_ms',
    ]
      .map(line)
      .join('\n') + '\n';
  return out;
}
