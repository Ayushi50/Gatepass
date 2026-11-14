import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvent, DEMO_EVENTS } from '@gatepass/catalog';
import { signToken } from '@gatepass/gateway';
import { startTestPostgres, startTestRedis, type TestDatabase } from '@gatepass/testing';
import {
  createTopics,
  logDir,
  managedService,
  sleep,
  startKafka,
  waitForPort,
  type ManagedProcess,
} from './infra';
import { ensureTool } from './tools';

const ROOT = join(__dirname, '..', '..');
const WEB = join(ROOT, 'apps', 'web');

export const PORTS = {
  gateway: 3000,
  catalog: 3001,
  inventory: 3002,
  booking: 3003,
  payment: 3004,
  ticket: 3005,
  notification: 3006,
  analytics: 3007,
  web: 3100,
  prometheus: 9090,
  grafana: 3200,
  jaeger: 16686,
  otlp: 4318,
};
export const JWT_SECRET = 'local-stack-jwt-secret-for-development-only-32+';

export interface StackOptions {
  /** Start the Next.js web app (builds it first if needed). Default true. */
  web?: boolean;
  /** Publish the five demo shows and sell out Jazz on the Roof. Default true. */
  seed?: boolean;
  /** Seat hold length. Default 10 minutes. */
  holdTtlMs?: number;
  /** Extra time after expiry before an unpaid hold is released. Default 60 seconds. */
  holdGraceMs?: number;
  /** How soon the FAKE payment provider reports a payment as done, in ms. Default 800. */
  autoWebhookMs?: number;
  /** Waiting-room admissions per second. Default 5. */
  admitPerSecond?: number;
  /** Also start Jaeger (traces), Prometheus (metrics) and Grafana (dashboard); downloads them on first use. */
  observability?: boolean;
  log?: (line: string) => void;
}

export interface Stack {
  urls: { web: string; gateway: string; prometheus?: string; grafana?: string; jaeger?: string };
  databases: Record<string, TestDatabase>;
  processes: ManagedProcess[];
  logDir: string;
  stop(): Promise<void>;
}

const SERVICES = [
  'catalog',
  'inventory',
  'booking',
  'payment',
  'ticket',
  'notification',
  'analytics',
] as const;
const GROUPS = ['seat-inventory', 'booking', 'payment', 'ticket', 'notification', 'analytics'];

const token = (sub: string, role: 'attendee' | 'organizer' | 'door-staff') =>
  signToken({ sub, role }, JWT_SECRET, { ttlSeconds: 4 * 3600 });

async function call(
  method: string,
  path: string,
  auth: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`http://127.0.0.1:${PORTS.gateway}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** Boots everything: real Kafka, Redis, Postgres, all 8 services and (optionally) the web app. */
export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const say = opts.log ?? ((m: string) => console.log(m));
  const kafka = await startKafka();
  const redis = await startTestRedis();
  const pg = await startTestPostgres();
  const databases = {} as Record<(typeof SERVICES)[number], TestDatabase>;
  const processes: ManagedProcess[] = [];
  let web: ChildProcess | undefined;
  const spawned: ChildProcess[] = [];

  const stop = async () => {
    web?.kill('SIGTERM');
    for (const c of spawned) c.kill('SIGTERM');
    for (const p of processes) p.kill();
    await Promise.all(Object.values(databases).map((d) => d.close().catch(() => undefined)));
    await pg.stop().catch(() => undefined);
    await redis.stop().catch(() => undefined);
    await kafka.stop().catch(() => undefined);
  };

  try {
    for (const s of SERVICES) databases[s] = await pg.createDatabase(10);
    await createTopics(kafka.brokers, GROUPS);
    say('infrastructure is up (Kafka, Postgres, Redis)');

    const obs: Record<string, string> = {};
    if (opts.observability) {
      await startObservability(say, spawned);
      obs.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${PORTS.otlp}`;
    }
    const common = { KAFKA_BROKERS: kafka.brokers.join(','), LAG_INTERVAL_MS: '2000', ...obs };
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
    const url = (s: (typeof SERVICES)[number]) => ({ DATABASE_URL: databases[s].connectionString });
    const list = [
      svc('catalog', 'catalog', url('catalog'), PORTS.catalog),
      svc(
        'seat-inventory',
        'seat-inventory',
        {
          ...url('inventory'),
          HOLD_TTL_MS: String(opts.holdTtlMs ?? 600_000),
          ...(opts.holdGraceMs === undefined ? {} : { HOLD_GRACE_MS: String(opts.holdGraceMs) }),
        },
        PORTS.inventory,
      ),
      svc('booking', 'booking', url('booking'), PORTS.booking),
      svc(
        'payment',
        'payment',
        {
          ...url('payment'),
          PAYMENT_PROVIDER: 'fake',
          FAKE_WEBHOOK_SECRET: 'local-stack-fake-webhook-secret',
          FAKE_AUTO_WEBHOOK_MS: String(opts.autoWebhookMs ?? 800),
        },
        PORTS.payment,
      ),
      svc(
        'ticket',
        'ticket',
        { ...url('ticket'), TICKET_SIGNING_KEYS: 'k1:local-stack-ticket-signing-secret-32+chars' },
        PORTS.ticket,
      ),
      svc(
        'notification',
        'notification',
        url('notification'),
        undefined,
        '[notification] consuming',
      ),
      svc('analytics', 'analytics', url('analytics'), PORTS.analytics),
      svc(
        'gateway',
        'gateway',
        {
          JWT_SECRET,
          REDIS_URL: redis.url,
          ENABLE_DEV_LOGIN: 'true',
          WAITING_ROOM_ADMIT_PER_SECOND: String(opts.admitPerSecond ?? 5),
          CATALOG_URL: `http://127.0.0.1:${PORTS.catalog}`,
          SEAT_INVENTORY_URL: `http://127.0.0.1:${PORTS.inventory}`,
          BOOKING_URL: `http://127.0.0.1:${PORTS.booking}`,
          PAYMENT_URL: `http://127.0.0.1:${PORTS.payment}`,
          TICKET_URL: `http://127.0.0.1:${PORTS.ticket}`,
          ANALYTICS_URL: `http://127.0.0.1:${PORTS.analytics}`,
        },
        PORTS.gateway,
      ),
    ];
    processes.push(...list);
    say('starting 8 services...');
    await Promise.all(list.map((p) => p.start()));
    say('services are up');

    if (opts.seed !== false) await seed(databases.catalog, say);

    if (opts.web !== false) {
      const next = require.resolve('next/dist/bin/next', { paths: [WEB] });
      if (!existsSync(join(WEB, '.next', 'BUILD_ID'))) {
        say('building the web app...');
        await new Promise<void>((ok, bad) =>
          spawn(process.execPath, [next, 'build'], { cwd: WEB, stdio: 'inherit' }).on(
            'exit',
            (c) => (c === 0 ? ok() : bad(new Error('web build failed'))),
          ),
        );
      }
      web = spawn(process.execPath, [next, 'start', '-p', String(PORTS.web)], {
        cwd: WEB,
        env: { ...process.env, GATEWAY_URL: `http://127.0.0.1:${PORTS.gateway}` },
      });
      const out = createWriteStream(join(logDir, 'web.log'));
      web.stdout?.pipe(out);
      web.stderr?.pipe(out);
      await waitForPort(PORTS.web, 60_000);
      say('web app is up');
    }
  } catch (err) {
    await stop();
    throw err;
  }

  const urls: Stack['urls'] = {
    web: `http://127.0.0.1:${PORTS.web}`,
    gateway: `http://127.0.0.1:${PORTS.gateway}`,
  };
  if (opts.observability) {
    urls.prometheus = `http://127.0.0.1:${PORTS.prometheus}`;
    urls.grafana = `http://127.0.0.1:${PORTS.grafana}`;
    urls.jaeger = `http://127.0.0.1:${PORTS.jaeger}`;
  }
  return {
    urls,
    databases,
    processes,
    logDir,
    stop,
  };
}

/** The five demo shows from design/events.html; Jazz on the Roof is then genuinely sold out. */
async function seed(catalogDb: TestDatabase, say: (m: string) => void): Promise<void> {
  for (const e of DEMO_EVENTS) await createEvent(catalogDb.pool, e);
  const probe = token('probe', 'attendee');
  for (const e of DEMO_EVENTS) {
    for (let i = 0; ; i++) {
      const r = await call('GET', `/api/events/${e.id}/seats`, probe).catch(() => ({
        status: 0,
        body: undefined,
      }));
      if (r.status === 200 && r.body.length === e.seats.length) break;
      if (i > 120) throw new Error(`${e.id} never reached seat-inventory`);
      await sleep(500);
    }
  }
  say('five demo shows published; selling out Jazz on the Roof...');

  const jazz = DEMO_EVENTS.find((e) => e.id === 'jazz-roof')!;
  const ids = jazz.seats.map((s) => s.seatId);
  const groups: string[][] = [];
  for (let i = 0; i < ids.length; i += 6) groups.push(ids.slice(i, i + 6));
  await Promise.all(
    groups.map(async (seatIds, n) => {
      const who = token(`seed-${n}`, 'attendee');
      const b = await call('POST', '/api/bookings', who, { eventId: 'jazz-roof', seatIds });
      if (b.status !== 201)
        throw new Error(`seed booking failed: ${b.status} ${JSON.stringify(b.body)}`);
      for (let i = 0; ; i++) {
        const cur = await call('GET', `/api/bookings/${b.body.id}`, who);
        if (cur.body.state === 'HELD') break;
        if (cur.body.state === 'CANCELLED' || i > 60)
          throw new Error(`seed hold failed for ${seatIds.join(',')}: ${cur.body.state}`);
        await sleep(300);
      }
      const p = await call(
        'POST',
        `/api/bookings/${b.body.id}/pay`,
        who,
        { method: 'upi', token: 'tok_success' },
        { 'idempotency-key': `seed-pay-${n}-0001` },
      );
      if (p.status !== 202) throw new Error(`seed payment failed: ${p.status}`);
      for (let i = 0; ; i++) {
        const cur = await call('GET', `/api/bookings/${b.body.id}`, who);
        if (cur.body.state === 'CONFIRMED') break;
        if (i > 120) throw new Error(`seed booking never confirmed: ${cur.body.state}`);
        await sleep(300);
      }
    }),
  );
  // the show list is a read model; wait until it agrees the show is sold out
  for (let i = 0; ; i++) {
    const list = await call('GET', '/api/events', probe);
    if (list.body.find((e: { id: string }) => e.id === 'jazz-roof')?.status === 'sold_out') break;
    if (i > 60) throw new Error('Jazz on the Roof never showed as sold out');
    await sleep(500);
  }
  say('Jazz on the Roof is sold out');
}

const METRIC_TARGETS: [string, number][] = [
  ['gateway', PORTS.gateway],
  ['catalog', PORTS.catalog],
  ['seat-inventory', PORTS.inventory],
  ['booking', PORTS.booking],
  ['payment', PORTS.payment],
  ['ticket', PORTS.ticket],
  ['notification', PORTS.notification],
  ['analytics', PORTS.analytics],
];

function launch(
  name: string,
  bin: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  spawned: ChildProcess[],
): void {
  const child = spawn(bin, args, { cwd, env: { ...process.env, ...env } });
  const out = createWriteStream(join(logDir, `${name}.log`));
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  spawned.push(child);
}

/** Jaeger (traces), Prometheus (metrics) and Grafana (dashboard, provisioned from infra/observability). */
async function startObservability(
  say: (m: string) => void,
  spawned: ChildProcess[],
): Promise<void> {
  const jaeger = await ensureTool('jaeger', say);
  const prometheus = await ensureTool('prometheus', say);
  const grafana = await ensureTool('grafana', say);
  const work = mkdtempSync(join(tmpdir(), 'gatepass-obs-'));

  launch('jaeger', jaeger, [], {}, work, spawned);
  await waitForPort(PORTS.otlp, 60_000);
  await waitForPort(PORTS.jaeger, 60_000);

  const config = join(work, 'prometheus.yml');
  writeFileSync(
    config,
    [
      'global:',
      '  scrape_interval: 2s',
      '  evaluation_interval: 5s',
      'scrape_configs:',
      ...METRIC_TARGETS.flatMap(([service, port]) => [
        `  - job_name: ${service}`,
        '    static_configs:',
        `      - targets: ['127.0.0.1:${port}']`,
        `        labels: { service: '${service}' }`,
      ]),
    ].join('\n'),
  );
  launch(
    'prometheus',
    prometheus,
    [
      `--config.file=${config}`,
      `--storage.tsdb.path=${join(work, 'prom')}`,
      `--web.listen-address=127.0.0.1:${PORTS.prometheus}`,
    ],
    {},
    work,
    spawned,
  );
  await waitForPort(PORTS.prometheus, 60_000);

  const obsRoot = join(ROOT, 'infra', 'observability', 'grafana');
  const home = join(grafana, '..', '..');
  mkdirSync(join(work, 'grafana-data'), { recursive: true });
  launch(
    'grafana',
    grafana,
    ['server', '--homepath', home],
    {
      GF_PATHS_DATA: join(work, 'grafana-data'),
      GF_PATHS_LOGS: join(work, 'grafana-logs'),
      GF_PATHS_PROVISIONING: join(obsRoot, 'provisioning'),
      GATEPASS_PROMETHEUS_URL: `http://127.0.0.1:${PORTS.prometheus}`,
      GATEPASS_DASHBOARDS_DIR: join(obsRoot, 'dashboards'),
      GF_SERVER_HTTP_ADDR: '127.0.0.1',
      GF_SERVER_HTTP_PORT: String(PORTS.grafana),
      GF_AUTH_ANONYMOUS_ENABLED: 'true',
      GF_AUTH_ANONYMOUS_ORG_ROLE: 'Viewer',
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
      GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
      GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: join(obsRoot, 'dashboards', 'gatepass.json'),
    },
    home,
    spawned,
  );
  await waitForPort(PORTS.grafana, 120_000);
  say('observability is up (Jaeger, Prometheus, Grafana)');
}
