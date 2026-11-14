/* Real-process chaos. Usage:  KAFKA_HOME=/path/to/kafka_2.13-3.9.0 pnpm chaos:real
 *
 * Starts a REAL Kafka broker, Redis and Postgres, runs EVERY service as its own OS process, drives
 * bookings through the gateway over HTTP, and kills services with SIGKILL at random moments
 * (mid-booking, mid-payment, mid-refund). Killed services are restarted. Then the abuse stops,
 * the system is left to settle, dead letters are replayed with the real replay CLI, and the same
 * invariants as the in-process chaos test are checked against the real databases.
 *
 *   CHAOS_SEED=3 CHAOS_DURATION_MS=60000 KAFKA_HOME=... pnpm chaos:real
 */
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { buildSeatMap, createEvent } from '@gatepass/catalog';
import { signToken } from '@gatepass/gateway';
import { startTestPostgres, startTestRedis, type TestDatabase } from '@gatepass/testing';
import {
  createTopics,
  dlqDepths,
  logDir,
  managedService,
  sleep,
  startKafka,
  type ManagedProcess,
} from './infra';
import { checkInvariants } from '../src/invariants';
import { chance, mulberry32, pick } from '../src/rng';

const ROOT = join(__dirname, '..', '..', '..');
const SECRET = 'chaos-jwt-secret-that-is-at-least-32-characters-long';
const FAKE_WEBHOOK_SECRET = 'chaos-fake-webhook-secret-value';
const PRICE = 100_000;
const SEATS = 12;
const seatNames = Array.from({ length: SEATS }, (_, i) => `A${i + 1}`);
const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];

const seed = Number(process.env.CHAOS_SEED ?? 1);
const durationMs = Number(process.env.CHAOS_DURATION_MS ?? 45_000);
const rand = mulberry32(seed);

const PORTS = {
  gateway: 43000,
  catalog: 43001,
  inventory: 43002,
  booking: 43003,
  payment: 43004,
  ticket: 43005,
  analytics: 43007,
};
const DB_SERVICES = [
  'catalog',
  'inventory',
  'booking',
  'payment',
  'ticket',
  'notification',
  'analytics',
] as const;
type Svc = (typeof DB_SERVICES)[number];
const GROUPS = ['seat-inventory', 'booking', 'payment', 'ticket', 'notification', 'analytics'];

const token = (sub: string, role: 'attendee' | 'organizer' | 'door-staff') =>
  signToken({ sub, role }, SECRET, { ttlSeconds: 7200 });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function api(
  method: string,
  path: string,
  auth: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.gateway}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...bearer(auth), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json as Record<string, unknown> & unknown[] };
  } catch {
    return { status: 0, body: undefined as never }; // the service was down or too slow; callers retry later
  }
}

/** The payment provider talking to us: a signed webhook, like Razorpay's callback. */
async function sendWebhook(
  paymentId: string,
  amountMinor: string,
  outcome: 'succeeded' | 'failed',
  eventId: string,
): Promise<boolean> {
  const body = JSON.stringify({
    id: eventId,
    type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
    paymentId,
    amountMinor: Number(amountMinor),
    reason: outcome === 'failed' ? 'declined' : undefined,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.payment}/webhooks/fake`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fake-signature': createHmac('sha256', FAKE_WEBHOOK_SECRET).update(body).digest('hex'),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const say = (m: string) =>
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
  console.log(`seed=${seed} duration=${durationMs}ms logs=${logDir}`);

  const kafka = await startKafka();
  const redis = await startTestRedis();
  const pg = await startTestPostgres();
  const dbs = {} as Record<Svc, TestDatabase>;
  const procs: ManagedProcess[] = [];
  const cleanup = async () => {
    for (const p of procs) p.kill();
    for (const d of Object.values(dbs)) await d.close().catch(() => {});
    await pg.stop().catch(() => {});
    await redis.stop().catch(() => {});
    await kafka.stop().catch(() => {});
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

  let exitCode = 0;
  try {
    for (const s of DB_SERVICES) dbs[s] = await pg.createDatabase(10);
    say('postgres, redis and kafka are up');
    await createTopics(kafka.brokers, GROUPS);

    const common = {
      KAFKA_BROKERS: kafka.brokers.join(','),
      KAFKA_SESSION_TIMEOUT_MS: '6000',
      KAFKA_HEARTBEAT_INTERVAL_MS: '1000',
      KAFKA_REBALANCE_TIMEOUT_MS: '8000',
    };
    const svc = (
      name: string,
      dir: string,
      extra: Record<string, string>,
      port?: number,
      readyLine?: string,
    ) =>
      managedService({
        name,
        cwd: ROOT,
        entry: join(ROOT, 'services', dir, 'src', 'main.ts'),
        port,
        readyLine,
        env: { ...common, ...extra, ...(port ? { PORT: String(port) } : {}) },
      });
    const dbUrl = (s: Svc) => ({ DATABASE_URL: dbs[s].connectionString });
    const byName: Record<string, ManagedProcess> = {
      catalog: svc('catalog', 'catalog', dbUrl('catalog'), PORTS.catalog),
      'seat-inventory': svc(
        'seat-inventory',
        'seat-inventory',
        {
          ...dbUrl('inventory'),
          HOLD_TTL_MS: '8000',
          HOLD_GRACE_MS: '1500',
          HOLD_SWEEP_INTERVAL_MS: '500',
        },
        PORTS.inventory,
      ),
      booking: svc('booking', 'booking', dbUrl('booking'), PORTS.booking),
      payment: svc(
        'payment',
        'payment',
        { ...dbUrl('payment'), PAYMENT_PROVIDER: 'fake', FAKE_WEBHOOK_SECRET },
        PORTS.payment,
      ),
      ticket: svc(
        'ticket',
        'ticket',
        { ...dbUrl('ticket'), TICKET_SIGNING_KEYS: 'k1:chaos-ticket-signing-secret-32-chars-long' },
        PORTS.ticket,
      ),
      notification: svc(
        'notification',
        'notification',
        dbUrl('notification'),
        undefined,
        '[notification] consuming',
      ),
      analytics: svc('analytics', 'analytics', dbUrl('analytics'), PORTS.analytics),
      gateway: svc(
        'gateway',
        'gateway',
        {
          JWT_SECRET: SECRET,
          REDIS_URL: redis.url,
          CATALOG_URL: `http://127.0.0.1:${PORTS.catalog}`,
          SEAT_INVENTORY_URL: `http://127.0.0.1:${PORTS.inventory}`,
          BOOKING_URL: `http://127.0.0.1:${PORTS.booking}`,
          PAYMENT_URL: `http://127.0.0.1:${PORTS.payment}`,
          TICKET_URL: `http://127.0.0.1:${PORTS.ticket}`,
          ANALYTICS_URL: `http://127.0.0.1:${PORTS.analytics}`,
        },
        PORTS.gateway,
      ),
    };
    procs.push(...Object.values(byName));

    say('starting 8 services as real processes...');
    await Promise.all(procs.map((p) => p.start()));
    say('all services are up');

    // the demo show, published through the real catalog service
    await createEvent(dbs.catalog.pool, {
      id: 'show',
      organizerId: 'org',
      title: 'Show',
      category: 'Music',
      venue: 'Hall',
      startsAt: new Date(Date.now() + 86_400_000),
      seats: buildSeatMap([{ label: 'A', tier: 'Front', priceMinor: PRICE }], SEATS),
    });
    for (let i = 0; i < 120; i++) {
      const r = await api('GET', '/api/events/show/seats', token('probe', 'attendee'));
      if (r.status === 200 && Array.isArray(r.body) && r.body.length === SEATS) break;
      if (i === 119) throw new Error('the show never reached seat-inventory');
      await sleep(500);
    }
    say(`the show is published and has ${SEATS} seats`);

    // ---------------------------------------------------------------- the abuse
    const stats = {
      booked: 0,
      bookRejected: 0,
      payAttempts: 0,
      webhooks: 0,
      refundRequests: 0,
      approvals: 0,
      scans: 0,
      httpFailures: 0,
      kills: {} as Record<string, number>,
    };
    const intended = new Map<
      string,
      { token: string; outcome: 'succeeded' | 'failed'; dueAt: number; done: boolean }
    >(); // by booking id
    const captured = new Set<string>();
    const userOfBooking = new Map<string, string>();
    let chaosOn = true;

    const killer = (async () => {
      while (chaosOn) {
        await sleep(1200 + rand() * 2200);
        if (!chaosOn) break;
        const up = procs.filter((p) => p.isUp());
        if (up.length < procs.length - 1) continue; // one at a time
        const victim = pick(rand, up);
        victim.kill();
        stats.kills[victim.name] = (stats.kills[victim.name] ?? 0) + 1;
        say(`KILL -9 ${victim.name}`);
        void sleep(400 + rand() * 2200)
          .then(() => victim.start())
          .then(() => say(`restarted ${victim.name}`))
          .catch((e) => say(`restart of ${victim.name} failed: ${e.message}`));
      }
    })();

    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const a = rand();
      if (a < 0.34) {
        const want = 1 + Math.floor(rand() * 3);
        const seatIds = [...new Set(Array.from({ length: want }, () => pick(rand, seatNames)))];
        const user = pick(rand, users);
        const r = await api('POST', '/api/bookings', token(user, 'attendee'), {
          eventId: 'show',
          seatIds,
        });
        if (r.status === 201) {
          stats.booked++;
          userOfBooking.set((r.body as unknown as { id: string }).id, user);
        } else if (r.status === 0) stats.httpFailures++;
        else stats.bookRejected++;
      } else if (a < 0.58) {
        const held = (
          await dbs.booking.pool.query("SELECT id, user_id FROM bookings WHERE state = 'HELD'")
        ).rows;
        if (held.length) {
          const b = pick(rand, held);
          let plan = intended.get(b.id);
          if (!plan) {
            const t = pick(rand, [
              'tok_success',
              'tok_success',
              'tok_success',
              'tok_declined',
              'tok_rejected',
            ]);
            plan = {
              token: t,
              outcome: t === 'tok_success' ? 'succeeded' : 'failed',
              // some providers answer slowly: after the hold (8s) AND its grace (1.5s) are over
              dueAt: Date.now() + (chance(rand, 0.3) ? 9500 + rand() * 3000 : rand() * 2000),
              done: t === 'tok_rejected', // refused on the spot: no webhook will ever come
            };
            intended.set(b.id, plan);
          }
          stats.payAttempts++;
          const r = await api(
            'POST',
            `/api/bookings/${b.id}/pay`,
            token(b.user_id, 'attendee'),
            { method: 'upi', token: plan.token },
            { 'idempotency-key': `idem-${b.id}-0001` },
          );
          if (r.status === 0) stats.httpFailures++;
        }
      } else if (a < 0.8) {
        await deliverWebhooks(false);
      } else if (a < 0.88) {
        const confirmed = (
          await dbs.booking.pool.query("SELECT user_id FROM bookings WHERE state = 'CONFIRMED'")
        ).rows;
        if (confirmed.length) {
          const user = pick(rand, confirmed).user_id as string;
          const mine = await api('GET', '/api/tickets', token(user, 'attendee'));
          const valid = Array.isArray(mine.body)
            ? (mine.body as { id: string; status: string }[]).filter((t) => t.status === 'valid')
            : [];
          if (
            valid.length &&
            (
              await api(
                'POST',
                `/api/tickets/${pick(rand, valid).id}/refund`,
                token(user, 'attendee'),
              )
            ).status === 202
          )
            stats.refundRequests++;
        }
      } else if (a < 0.93) {
        const open = (
          await dbs.booking.pool.query("SELECT id FROM refunds WHERE state = 'REQUESTED'")
        ).rows;
        if (
          open.length &&
          (
            await api(
              'POST',
              `/api/refunds/${pick(rand, open).id}/approve`,
              token('org', 'organizer'),
            )
          ).status === 200
        )
          stats.approvals++;
      } else if (a < 0.96) {
        const any = (await dbs.ticket.pool.query('SELECT user_id FROM tickets LIMIT 20')).rows;
        if (any.length) {
          const user = pick(rand, any).user_id as string;
          const mine = await api('GET', '/api/tickets', token(user, 'attendee'));
          if (Array.isArray(mine.body) && mine.body.length) {
            await api('POST', '/api/checkin', token('gate-1', 'door-staff'), {
              qrToken: (pick(rand, mine.body) as { qrToken: string }).qrToken,
            });
            stats.scans++;
          }
        }
      }
      await sleep(60 + rand() * 160);
    }

    /** As the provider: report on every payment that is due (or all of them), duplicates included. */
    async function deliverWebhooks(all: boolean): Promise<number> {
      let pending = 0;
      for (const [bookingId, plan] of intended) {
        if (plan.done || (!all && Date.now() < plan.dueAt)) continue;
        const pay = (
          await dbs.payment.pool.query(
            'SELECT id, amount_minor FROM payments WHERE booking_id = $1 ORDER BY created_at LIMIT 1',
            [bookingId],
          )
        ).rows[0];
        if (!pay) {
          pending++;
          continue; // our side has not recorded the payment yet; the provider will try again later
        }
        if (plan.outcome === 'succeeded') captured.add(pay.id); // the money WAS taken, whether or not we heard yet
        const ok = await sendWebhook(
          pay.id,
          pay.amount_minor,
          plan.outcome,
          `evt-${pay.id}-${plan.outcome}`,
        );
        stats.webhooks++;
        if (ok) {
          if (chance(rand, 0.35))
            await sendWebhook(
              pay.id,
              pay.amount_minor,
              plan.outcome,
              `evt-${pay.id}-${plan.outcome}`,
            ); // provider retry
          if (plan.outcome === 'succeeded' && chance(rand, 0.15))
            await sendWebhook(pay.id, pay.amount_minor, 'failed', `evt-${pay.id}-stray`);
          plan.done = true;
        } else pending++;
      }
      return pending;
    }

    // ---------------------------------------------------------------- the abuse stops
    chaosOn = false;
    await killer;
    say(`abuse over. kills: ${JSON.stringify(stats.kills)}. bringing everything back up...`);
    await Promise.all(procs.filter((p) => !p.isUp()).map((p) => p.start()));
    say('every service is running again; letting the system settle');

    const snapshot = async (): Promise<string> => {
      const q = async (p: Pool, sql: string) => JSON.stringify((await p.query(sql)).rows);
      const outboxes = await Promise.all(
        DB_SERVICES.map((s) =>
          q(dbs[s].pool, 'SELECT count(*) FROM outbox WHERE published_at IS NULL'),
        ),
      );
      return [
        await q(
          dbs.booking.pool,
          'SELECT state, count(*) FROM bookings GROUP BY state ORDER BY state',
        ),
        await q(
          dbs.payment.pool,
          'SELECT state, count(*) FROM payments GROUP BY state ORDER BY state',
        ),
        await q(
          dbs.payment.pool,
          'SELECT state, count(*) FROM refunds GROUP BY state ORDER BY state',
        ),
        await q(
          dbs.inventory.pool,
          'SELECT state, count(*) FROM seats GROUP BY state ORDER BY state',
        ),
        await q(
          dbs.ticket.pool,
          'SELECT status, count(*) FROM tickets GROUP BY status ORDER BY status',
        ),
        ...outboxes,
      ].join('|');
    };
    const isFinal = async (): Promise<boolean> => {
      const stuck = (
        await dbs.booking.pool.query(
          "SELECT 1 FROM bookings WHERE state NOT IN ('CONFIRMED','CANCELLED') LIMIT 1",
        )
      ).rowCount;
      const pay = (
        await dbs.payment.pool.query(
          "SELECT 1 FROM payments WHERE state NOT IN ('SUCCEEDED','FAILED') LIMIT 1",
        )
      ).rowCount;
      const ref = (
        await dbs.payment.pool.query("SELECT 1 FROM refunds WHERE state <> 'COMPLETED' LIMIT 1")
      ).rowCount;
      const open = (
        await dbs.booking.pool.query("SELECT 1 FROM refunds WHERE state <> 'COMPLETED' LIMIT 1")
      ).rowCount;
      return !stuck && !pay && !ref && !open;
    };
    const settle = async (label: string): Promise<boolean> => {
      let last = '';
      let calm = 0;
      const end = Date.now() + 150_000;
      while (Date.now() < end) {
        const pendingHooks = await deliverWebhooks(true);
        for (const r of (
          await dbs.booking.pool.query("SELECT id FROM refunds WHERE state = 'REQUESTED'")
        ).rows) {
          await api('POST', `/api/refunds/${r.id}/approve`, token('org', 'organizer'));
        }
        const snap = await snapshot();
        calm = snap === last && pendingHooks === 0 && (await isFinal()) ? calm + 1 : 0;
        last = snap;
        if (calm >= 4) {
          say(`${label}: settled`);
          return true;
        }
        await sleep(1000);
      }
      say(`${label}: DID NOT SETTLE in 150s: ${last}`);
      return false;
    };
    const settled = await settle('first settle');

    const depths = await dlqDepths(kafka.brokers, GROUPS);
    const dead = Object.entries(depths).filter(([, n]) => n > 0);
    say(`dead letters: ${dead.length ? JSON.stringify(Object.fromEntries(dead)) : 'none'}`);
    for (const [dlq, n] of dead) {
      say(`replaying ${n} message(s) from ${dlq} with the real replay CLI`);
      await new Promise<void>((resolve, reject) => {
        const p = spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            join(ROOT, 'libs/messaging/bin/replay.ts'),
            '--dlq',
            dlq,
            '--brokers',
            kafka.brokers.join(','),
          ],
          {
            cwd: ROOT,
            env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
            stdio: 'inherit',
          },
        );
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`replay exited ${c}`))));
      });
    }
    const settledAgain = dead.length ? await settle('after replay') : true;

    const violations = await checkInvariants(
      {
        inventory: dbs.inventory.pool,
        booking: dbs.booking.pool,
        payment: dbs.payment.pool,
        ticket: dbs.ticket.pool,
        analytics: dbs.analytics.pool,
        outboxes: DB_SERVICES.map((s) => dbs[s].pool),
      },
      { eventId: 'show', organizerId: 'org', seatPriceMinor: PRICE, totalSeats: SEATS, captured },
    );
    if (!settled || !settledAgain) violations.push('the system did not settle');

    const counts = {
      bookings: (
        await dbs.booking.pool.query('SELECT state, count(*) FROM bookings GROUP BY state')
      ).rows,
      payments: (
        await dbs.payment.pool.query('SELECT state, count(*) FROM payments GROUP BY state')
      ).rows,
      refunds: (
        await dbs.payment.pool.query('SELECT automatic, count(*) FROM refunds GROUP BY automatic')
      ).rows,
      tickets: (await dbs.ticket.pool.query('SELECT status, count(*) FROM tickets GROUP BY status'))
        .rows,
    };
    console.log('\n=== RESULT ===');
    console.log(
      JSON.stringify(
        {
          seed,
          stats,
          restarts: Object.fromEntries(procs.map((p) => [p.name, p.starts - 1])),
          deadLetters: depths,
          counts,
        },
        null,
        2,
      ),
    );
    if (violations.length) {
      console.log('\nVIOLATIONS:');
      for (const v of violations) console.log(` - ${v}`);
      exitCode = 1;
    } else {
      console.log(
        '\nALL INVARIANTS HOLD: no double sale, every booking final, money adds up, nothing unsent.',
      );
    }
    console.log(`service logs: ${logDir}`);
  } catch (err) {
    console.error('chaos run failed:', err);
    console.error(`service logs: ${logDir}`);
    exitCode = 2;
  } finally {
    await cleanup();
  }
  process.exit(exitCode);
}

void main();
