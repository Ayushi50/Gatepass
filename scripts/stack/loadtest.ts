// `pnpm loadtest`: boots the whole system, lets k6 fight over a 1,000-seat show, then reads the
// databases to prove nothing was sold or charged twice, and prints the results table.
//
//   KAFKA_HOME=... pnpm loadtest                      50 buyers at peak
//   PEAK_VUS=20 pnpm loadtest                         a gentler run
//   pnpm loadtest -- --observability                  watch it in Grafana at the same time
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSeatMap, createEvent } from '@gatepass/catalog';
import { sleep } from './infra';
import { startStack } from './stack';
import { ensureTool } from './tools';

const ROOT = join(__dirname, '..', '..');
const EVENT = 'load-show';
const ROWS = 25;
const PER_ROW = 40;

async function main(): Promise<void> {
  const k6 = await ensureTool('k6', console.log);
  const stack = await startStack({
    web: false,
    seed: false,
    observability: process.argv.includes('--observability'),
    autoWebhookMs: 100,
    admitPerSecond: 1000,
    rateLimitPerMinute: 10_000_000, // k6 is one client; the limiter is proven by the probe, not here
  });
  let failed = false;
  try {
    const seats = buildSeatMap(
      Array.from({ length: ROWS }, (_, i) => ({
        label: `R${String(i + 1).padStart(2, '0')}-`,
        tier: 'General',
        priceMinor: 50_000,
      })),
      PER_ROW,
    );
    await createEvent(stack.databases.catalog!.pool, {
      id: EVENT,
      organizerId: 'org-load',
      title: 'Load Test Show',
      category: 'Music',
      venue: 'Laptop Arena',
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      seats,
    });
    const inv = stack.databases.inventory!.pool;
    for (let i = 0; ; i++) {
      const { rows } = await inv.query('SELECT count(*)::int AS n FROM seats WHERE event_id = $1', [
        EVENT,
      ]);
      if (rows[0].n === seats.length) break;
      if (i > 120) throw new Error('the show never reached seat-inventory');
      await sleep(500);
    }
    console.log(`${seats.length}-seat show is on sale; starting k6...`);

    const summaryPath = join(mkdtempSync(join(tmpdir(), 'gatepass-load-')), 'summary.json');
    const code = await new Promise<number>((done) =>
      spawn(k6, ['run', '--quiet', join(ROOT, 'load', 'booking.js')], {
        stdio: 'inherit',
        env: {
          ...process.env,
          GATEWAY_URL: stack.urls.gateway,
          EVENT_ID: EVENT,
          SUMMARY_PATH: summaryPath,
          K6_NO_USAGE_REPORT: 'true',
        },
      }).on('exit', (c) => done(c ?? 1)),
    );
    if (code !== 0) {
      failed = true;
      console.log(`k6 exited with ${code} (a threshold failed)`);
    }

    // let every in-flight saga finish before judging the result
    const booking = stack.databases.booking!.pool;
    const outboxes = ['catalog', 'inventory', 'booking', 'payment', 'ticket'].map(
      (s) => stack.databases[s]!.pool,
    );
    for (let i = 0; i < 120; i++) {
      const open = (
        await booking.query(
          "SELECT count(*)::int AS n FROM bookings WHERE state IN ('REQUESTED','PAID')",
        )
      ).rows[0].n;
      let unsent = 0;
      for (const p of outboxes)
        unsent += (
          await p.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')
        ).rows[0].n;
      if (open === 0 && unsent === 0) break;
      await sleep(500);
    }

    const one = async (pool: typeof booking, sql: string) =>
      (await pool.query(sql)).rows[0].n as number;
    const confirmed = await one(
      booking,
      "SELECT count(*)::int AS n FROM bookings WHERE state = 'CONFIRMED'",
    );
    const total = await one(booking, 'SELECT count(*)::int AS n FROM bookings');
    const unfinished = await one(
      booking,
      "SELECT count(*)::int AS n FROM bookings WHERE state IN ('REQUESTED','PAID')",
    );
    const seatsSoldTwice = await one(
      booking,
      `SELECT count(*)::int AS n FROM (
         SELECT seat FROM bookings, unnest(seat_ids) AS seat
          WHERE state = 'CONFIRMED' GROUP BY seat HAVING count(*) > 1) d`,
    );
    const confirmedSeats = await one(
      booking,
      "SELECT coalesce(sum(cardinality(seat_ids)), 0)::int AS n FROM bookings WHERE state = 'CONFIRMED'",
    );
    const soldSeats = await one(inv, "SELECT count(*)::int AS n FROM seats WHERE state = 'sold'");
    const chargedTwice = await one(
      stack.databases.payment!.pool,
      `SELECT count(*)::int AS n FROM (
         SELECT booking_id FROM payments WHERE state = 'SUCCEEDED' GROUP BY booking_id HAVING count(*) > 1) d`,
    );
    const charges = await one(
      stack.databases.payment!.pool,
      "SELECT count(*)::int AS n FROM payments WHERE state = 'SUCCEEDED'",
    );
    const tickets = await one(
      stack.databases.ticket!.pool,
      'SELECT count(*)::int AS n FROM tickets',
    );

    const m = JSON.parse(readFileSync(summaryPath, 'utf8')).metrics;
    const v = (k: string, f: string): number => m[k]?.values?.[f] ?? 0;
    const secs =
      (JSON.parse(readFileSync(summaryPath, 'utf8')).state?.testRunDurationMs ?? 0) / 1000;
    const duplicates = seatsSoldTwice + chargedTwice;
    const rate = confirmed ? duplicates / confirmed : 0;
    const ms = (n: number) => `${Math.round(n)} ms`;
    console.log(`
| Measure | Result |
| --- | --- |
| Buyers at peak | ${process.env.PEAK_VUS ?? 50} |
| Run length | ${Math.round(secs)} s |
| Booking attempts | ${total} (${(total / secs).toFixed(1)} per second) |
| Bookings confirmed | ${confirmed} (${soldSeats} of ${seats.length} seats sold) |
| Refused because the seat was taken | ${v('gatepass_seats_already_taken', 'count')} |
| HTTP requests | ${v('http_reqs', 'count')} (${v('http_reqs', 'rate').toFixed(0)} per second), ${(v('http_req_failed', 'rate') * 100).toFixed(2)}% failed |
| HTTP latency p95 | ${ms(v('http_req_duration', 'p(95)'))} |
| Request to seat decision p95 | ${ms(v('gatepass_hold_decision_ms', 'p(95)'))} |
| Pay to confirmed p95 | ${ms(v('gatepass_pay_to_confirmed_ms', 'p(95)'))} (includes the fake provider's 100 ms) |
| Whole booking p95 | ${ms(v('gatepass_booking_journey_ms', 'p(95)'))} |
| Double-clicked payments sent | ${v('gatepass_duplicate_pay_requests', 'count')} |
| Seats sold twice | ${seatsSoldTwice} |
| Bookings charged twice | ${chargedTwice} |
| **Duplicate rate** | **${rate}** |
`);
    const problems: string[] = [];
    if (duplicates) problems.push(`${duplicates} duplicates`);
    if (unfinished) problems.push(`${unfinished} bookings never finished`);
    if (confirmedSeats !== soldSeats)
      problems.push(`confirmed bookings cover ${confirmedSeats} seats but ${soldSeats} are sold`);
    if (charges !== confirmed)
      problems.push(`${charges} successful charges for ${confirmed} confirmed bookings`);
    if (tickets !== confirmedSeats)
      problems.push(`${tickets} tickets for ${confirmedSeats} sold seats`);
    if (problems.length) {
      failed = true;
      console.log('PROBLEMS:\n - ' + problems.join('\n - '));
    } else
      console.log(
        `consistent: ${charges} charges = ${confirmed} confirmed bookings; ${tickets} tickets = ${soldSeats} sold seats`,
      );
  } finally {
    await stack.stop();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
