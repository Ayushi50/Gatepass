// `pnpm observability:check`: boots the whole system with Jaeger, Prometheus and Grafana, drives real
// bookings through it, then proves that each dashboard panel has data, that Grafana loaded the
// dashboard, and that one booking is a single trace crossing several services.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signToken } from '@gatepass/gateway';
import { DEMO_EVENTS } from '@gatepass/catalog';
import { JWT_SECRET, PORTS, startStack } from './stack';
import { sleep } from './infra';

const ROOT = join(__dirname, '..', '..');
const DASHBOARD = join(ROOT, 'infra', 'observability', 'grafana', 'dashboards', 'gatepass.json');
const failures: string[] = [];
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures.push(m);
  console.log(`  FAIL ${m}`);
};

const gw = (
  method: string,
  path: string,
  who: string,
  body?: unknown,
  h: Record<string, string> = {},
) =>
  fetch(`http://127.0.0.1:${PORTS.gateway}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${signToken({ sub: who, role: 'attendee' }, JWT_SECRET, { ttlSeconds: 3600 })}`,
      ...h,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({
    status: r.status,
    body: (await r.text().then((t) => (t ? JSON.parse(t) : undefined))) as any,
  }));

async function waitState(who: string, id: string, want: string, ms = 30_000): Promise<string> {
  const end = Date.now() + ms;
  let s = '';
  while (Date.now() < end) {
    s = (await gw('GET', `/api/bookings/${id}`, who)).body?.state;
    if (s === want) return s;
    await sleep(250);
  }
  return s;
}

async function prom(expr: string): Promise<number[]> {
  const u = `http://127.0.0.1:${PORTS.prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`;
  const j: any = await (await fetch(u)).json();
  return (j.data?.result ?? []).map((r: any) => Number(r.value[1]));
}

// the run has one declined payment and one abandoned hold, so these cannot be 1 and 0
const EXPECT: Record<string, { what: string; test: (v: number) => boolean }> = {
  'Saga success rate': { what: 'between 0 and 1', test: (v) => v > 0 && v < 1 },
  'Hold-expiry rate': { what: 'above 0', test: (v) => v > 0 },
};

/** The trace starting at this operation that touches the most services. */
async function widestTrace(service: string, operation: string) {
  const now = Date.now();
  const qs = new URLSearchParams({
    'query.service_name': service,
    'query.operation_name': operation,
    'query.start_time_min': new Date(now - 3600_000).toISOString(),
    'query.start_time_max': new Date(now + 60_000).toISOString(),
    'query.search_depth': '50',
  });
  const res: any = await (
    await fetch(`http://127.0.0.1:${PORTS.jaeger}/api/v3/traces?${qs}`)
  ).json();
  const byTrace = new Map<string, { services: Set<string>; spans: number }>();
  for (const rs of res.result?.resourceSpans ?? []) {
    const svc = rs.resource.attributes.find((a: any) => a.key === 'service.name')?.value
      ?.stringValue;
    for (const ss of rs.scopeSpans)
      for (const sp of ss.spans) {
        const e = byTrace.get(sp.traceId) ?? { services: new Set<string>(), spans: 0 };
        e.services.add(svc);
        e.spans++;
        byTrace.set(sp.traceId, e);
      }
  }
  let best = { services: new Set<string>(), spans: 0 };
  for (const e of byTrace.values()) if (e.services.size > best.services.size) best = e;
  return best;
}

async function main(): Promise<void> {
  // short holds, so one unpaid booking really expires during the run
  const stack = await startStack({
    web: false,
    observability: true,
    holdTtlMs: 6_000,
    holdGraceMs: 2_000,
  });
  try {
    // a normal booking, a declined payment, and a hold nobody pays for
    const show = DEMO_EVENTS.find((e) => e.id === 'laugh-lab') ?? DEMO_EVENTS[1]!;
    const seats = show.seats.map((s) => s.seatId);
    const run = async (who: string, seatIds: string[], tok?: string) => {
      const b = await gw('POST', '/api/bookings', who, { eventId: show.id, seatIds });
      if (b.status !== 201) throw new Error(`booking failed ${b.status}`);
      if ((await waitState(who, b.body.id, 'HELD')) !== 'HELD') throw new Error('never held');
      if (tok) {
        await gw(
          'POST',
          `/api/bookings/${b.body.id}/pay`,
          who,
          { method: 'upi', token: tok },
          { 'idempotency-key': `${who}-pay-0001` },
        );
      }
      return b.body.id as string;
    };
    const good = await run('obs-good', seats.slice(0, 2), 'tok_success');
    const declined = await run('obs-declined', seats.slice(2, 4), 'tok_declined');
    const abandoned = await run('obs-abandoned', seats.slice(4, 6));
    const outcomes: [string, string, string][] = [
      ['obs-good', good, 'CONFIRMED'],
      ['obs-declined', declined, 'CANCELLED'],
      ['obs-abandoned', abandoned, 'CANCELLED'],
    ];
    for (const [who, id, want] of outcomes) {
      const got = await waitState(who, id, want);
      if (got !== want) bad(`booking of ${who} ended ${got}, expected ${want}`);
    }

    console.log('\nPrometheus: every panel expression returns data');
    const dash = JSON.parse(readFileSync(DASHBOARD, 'utf8'));
    for (const panel of dash.panels) {
      for (const t of panel.targets) {
        const want = t === panel.targets[0] ? EXPECT[panel.title as string] : undefined;
        let values: number[] = [];
        for (let i = 0; i < 40; i++) {
          values = (await prom(t.expr)).filter(Number.isFinite);
          if (values.length && (!want || want.test(values[0]!))) break;
          await sleep(1000);
        }
        if (values.length && want && !want.test(values[0]!))
          bad(`${panel.title}: ${values[0]} is not ${want.what}`);
        else if (values.length)
          ok(
            `${panel.title}: ${t.expr.slice(0, 60)}... = ${values.map((v) => +v.toFixed(3)).join(', ')}`,
          );
        else bad(`${panel.title}: no data for ${t.expr}`);
      }
    }

    console.log('\nGrafana');
    const g = `http://127.0.0.1:${PORTS.grafana}`;
    const found: any = await (await fetch(`${g}/api/dashboards/uid/gatepass-overview`)).json();
    if (found.dashboard?.panels?.length === dash.panels.length)
      ok(`dashboard provisioned with ${dash.panels.length} panels`);
    else bad('Grafana did not load the dashboard');
    const ds: any = await (
      await fetch(`${g}/api/datasources/uid/gatepass-prom/health`)
    )
      .json()
      .catch(() => ({}));
    if (ds.status === 'OK') ok('Prometheus data source healthy');
    else bad(`data source health: ${JSON.stringify(ds)}`);

    console.log('\nJaeger: one booking is one trace across services');
    // a booking request and its payment are two traces: the payment starts at the provider's webhook
    const journeys: [string, string, string, string[]][] = [
      [
        'booking request',
        'gateway',
        'POST /api/bookings',
        ['booking', 'seat-inventory', 'payment'],
      ],
      [
        'payment',
        'payment',
        'POST /webhooks/:provider',
        ['seat-inventory', 'booking', 'ticket', 'notification'],
      ],
    ];
    for (const [label, service, operation, mustReach] of journeys) {
      let best = { services: new Set<string>(), spans: 0 };
      const reached = () => mustReach.every((s) => best.services.has(s));
      for (let i = 0; i < 20 && !reached(); i++) {
        best = await widestTrace(service, operation);
        if (!reached()) await sleep(1500);
      }
      const list = [...best.services].sort().join(', ');
      if (reached()) ok(`${label}: one trace, ${best.spans} spans, across ${list}`);
      else bad(`${label}: widest trace only covered ${list || 'nothing'}`);
    }

    if (process.argv.includes('--screenshot')) {
      const { chromium } = require(
        require.resolve('@playwright/test', { paths: [join(ROOT, 'apps', 'web')] }),
      );
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
      await page.goto(`${g}/d/gatepass-overview?kiosk`, { waitUntil: 'networkidle' });
      await sleep(4000);
      mkdirSync(join(ROOT, 'docs', 'images'), { recursive: true });
      await page.screenshot({ path: join(ROOT, 'docs', 'images', 'grafana-dashboard.png') });
      await browser.close();
      ok('saved docs/images/grafana-dashboard.png');
    }
  } finally {
    await stack.stop();
  }
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nobservability check passed');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
