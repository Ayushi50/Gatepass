/* eslint-disable no-console */
/**
 * Proves the Next pages look the same as the design pages.
 *
 * For each page and screen size it loads design/<page>.html (running its own sample data) and the
 * Next page (fed the SAME data through intercepted API calls), with the clock frozen, animations
 * off and web fonts blocked (so both use the same fallback font on this machine), takes a
 * full-page screenshot of each, and compares them pixel by pixel.
 *
 *   pnpm --filter @gatepass/web visual            (builds the app first if needed)
 *   pnpm --filter @gatepass/web visual -- --keep  (keep the images in apps/web/visual/out)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, type Browser, type Page, type Route } from '@playwright/test';
import { PNG } from 'pngjs';
import {
  ACTIVITY,
  BOOKING,
  EVENTS,
  FIXED_TIME,
  REFUNDS,
  SEATS,
  SUMMARY,
  TICKETS,
} from './fixtures';

const WEB = join(__dirname, '..');
const DESIGN = join(WEB, '..', '..', 'design');
const OUT = join(__dirname, 'out');
const NEXT_BIN = require.resolve('next/dist/bin/next');
const NEXT_PORT = 3190;
const DESIGN_PORT = 3191;
const MAX_DIFF_RATIO = 0.0005; // at most 0.05% of pixels may differ

const esm = (m: string) =>
  new Function('m', 'return import(m)')(m) as Promise<{ default: (...a: unknown[]) => number }>;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeToken = (role: string, sub: string) =>
  `${b64({ alg: 'none' })}.${b64({ sub, role, exp: 4_102_444_800 })}.x`;

type Mock = (
  url: URL,
  route: Route,
  req: { method: string; body: () => unknown },
) => boolean | Promise<boolean>;

interface Scenario {
  name: string;
  design: string; // path on the design server
  next: string; // path on the next server
  role?: 'attendee' | 'organizer' | 'door-staff';
  mocks: Mock[];
  /** Brings the Next page to the state the design page starts in. */
  setupNext?: (p: Page) => Promise<void>;
  /** Brings the design page to the state under test (and hides its design-review controls). */
  setupDesign?: (p: Page) => Promise<void>;
  css?: string; // injected into BOTH pages
  mask?: string[]; // selectors blanked in both screenshots
  /** Script run on both pages to equalise text that is real data in one and hand-written in the other. */
  normalize?: string;
  sizes?: ('desktop' | 'mobile')[];
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const at =
  (path: string, fn: (route: Route) => unknown): Mock =>
  (url, route) =>
    url.pathname === path ? (void fn(route), true) : false;
const hang: Mock = (url) => url.pathname.endsWith('/stream') || url.pathname.endsWith('/activity'); // streams stay open: never answered
const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

const common: Mock[] = [
  at('/api/events', (r) => json(r, EVENTS)),
  at('/api/events/neon-nights/seats', (r) => json(r, SEATS)),
];
const bookingMocks = (over: object = {}): Mock[] => [
  at('/api/bookings/bk-demo', (r) => json(r, { ...BOOKING, ...over })),
  ...common,
];
const statusStream =
  (snapshot: object): Mock =>
  (url, route) =>
    url.pathname === '/api/bookings/bk-demo/stream'
      ? (void route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sse({ kind: 'snapshot', ...snapshot }),
        }),
        true)
      : false;

const hideDesignReview = '#preview{display:none!important}.manual{display:none!important}';

const scenarios: Scenario[] = [
  { name: 'index', design: '/index.html', next: '/', mocks: [] },
  { name: 'events', design: '/events.html', next: '/events', mocks: common },
  {
    name: 'seats',
    design: '/seats.html',
    next: '/seats?event=neon-nights',
    mocks: [...common, hang],
    // the design opens with C6 and C7 already chosen
    setupNext: async (p) => {
      await p.waitForSelector('button.seat[data-id="C6"]');
      // dispatch the click: a real click would scroll the seat map sideways on a phone
      await p.dispatchEvent('button.seat[data-id="C6"]', 'click');
      await p.dispatchEvent('button.seat[data-id="C7"]', 'click');
    },
  },
  {
    name: 'checkout',
    design: '/checkout.html',
    next: '/checkout?booking=bk-demo',
    role: 'attendee',
    mocks: bookingMocks(),
  },
  {
    name: 'status-progress',
    design: '/status.html',
    next: '/status?booking=bk-demo',
    role: 'attendee',
    mocks: [
      ...bookingMocks(),
      statusStream({ state: 'HELD', cancelReason: null, ticketsIssued: false }),
    ],
    setupDesign: async (p) => void (await p.click('[data-m="progress"]')),
    css: hideDesignReview,
  },
  {
    name: 'status-confirmed',
    design: '/status.html',
    next: '/status?booking=bk-demo',
    role: 'attendee',
    mocks: [
      ...bookingMocks({ state: 'CONFIRMED' }),
      statusStream({ state: 'CONFIRMED', cancelReason: null, ticketsIssued: true }),
    ],
    setupDesign: async (p) => void (await p.click('[data-m="confirmed"]')),
    css: hideDesignReview,
  },
  {
    name: 'status-failed',
    design: '/status.html',
    next: '/status?booking=bk-demo',
    role: 'attendee',
    mocks: [
      ...bookingMocks({ state: 'CANCELLED', cancelReason: 'payment_failed' }),
      statusStream({ state: 'CANCELLED', cancelReason: 'payment_failed', ticketsIssued: false }),
    ],
    setupDesign: async (p) => void (await p.click('[data-m="failed"]')),
    css: hideDesignReview,
  },
  {
    name: 'tickets',
    design: '/tickets.html',
    next: '/tickets',
    role: 'attendee',
    mocks: [at('/api/tickets', (r) => json(r, TICKETS)), ...common],
    mask: ['.ticket-stubside svg'],
  },
  {
    name: 'organizer',
    design: '/organizer.html',
    next: '/organizer?event=neon-nights',
    role: 'organizer',
    mocks: [
      at('/api/organizer/events/neon-nights/summary', (r) => json(r, SUMMARY)),
      at('/api/organizer/events/neon-nights/refunds', (r) => json(r, REFUNDS)),
      (url, route) =>
        url.pathname === '/api/organizer/events/neon-nights/activity'
          ? (void route.fulfill({
              status: 200,
              contentType: 'text/event-stream',
              body: sse({ kind: 'snapshot', items: ACTIVITY }),
            }),
            true)
          : false,
      ...common,
    ],
  },
  {
    name: 'check-in-ready',
    design: '/check-in.html',
    next: '/check-in?gate=2&event=neon-nights',
    role: 'door-staff',
    mocks: common,
    setupDesign: async (p) => void (await p.click('[data-m="ready"]')),
    css: hideDesignReview,
    // the gate label is real data (the show's full title), where the design abbreviates it by hand
    mask: ['.viewfinder'],
    normalize: "document.querySelector('.where').textContent = 'Gate 2 · Neon Nights'",
    sizes: ['mobile'],
  },
  {
    name: 'check-in-valid',
    design: '/check-in.html',
    next: '/check-in?gate=2&event=neon-nights',
    role: 'door-staff',
    mocks: [
      at('/api/checkin', (r) => json(r, { status: 'valid', row: 'C', seat: '6', tier: 'Mid' })),
      ...common,
    ],
    setupNext: async (p) => {
      await p.fill('input[aria-label="Ticket code"]', 'GP1.demo.sig');
      await p.dispatchEvent('form.manual', 'submit');
      await p.waitForSelector('#result[data-m="valid"]');
    },
    setupDesign: async (p) => void (await p.click('[data-m="valid"]')),
    css: hideDesignReview,
    // the gate label is real data (the show's full title), where the design abbreviates it by hand
    mask: ['.viewfinder'],
    normalize: "document.querySelector('.where').textContent = 'Gate 2 · Neon Nights'",
    sizes: ['mobile'],
  },
];

const SIZES = {
  desktop: { width: Number(process.env.VISUAL_DESKTOP_WIDTH ?? 1280), height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

function serveDesign(): Server {
  return createServer((req, res) => {
    const file = join(DESIGN, (req.url ?? '/').split('?')[0]!);
    if (!file.startsWith(DESIGN) || !existsSync(file)) return void res.writeHead(404).end();
    res
      .writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      .end(readFileSync(file));
  }).listen(DESIGN_PORT);
}

async function startNext(): Promise<ChildProcess> {
  if (!existsSync(join(WEB, '.next', 'BUILD_ID'))) {
    console.log('building the web app first...');
    await new Promise<void>((ok, bad) =>
      spawn(process.execPath, [NEXT_BIN, 'build'], { cwd: WEB, stdio: 'inherit' }).on(
        'exit',
        (c) => (c === 0 ? ok() : bad(new Error('build failed'))),
      ),
    );
  }
  const child = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(NEXT_PORT)], {
    cwd: WEB,
    env: { ...process.env, GATEWAY_URL: 'http://127.0.0.1:1' },
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${NEXT_PORT}/`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the web server did not start');
}

async function shoot(
  browser: Browser,
  s: Scenario,
  which: 'design' | 'next',
  size: keyof typeof SIZES,
): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: SIZES[size],
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    permissions: ['camera'],
  });
  const page = await context.newPage();
  // both pages use the same fallback font: the fonts are fetched from the network, so block them
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.clock.install({ time: FIXED_TIME });
  if (which === 'next') {
    await page.addInitScript(
      (tok) => localStorage.setItem('gp.session', tok),
      fakeToken(s.role ?? 'attendee', 'attendee-1'),
    );
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      for (const m of s.mocks)
        if (await m(url, route, { method: route.request().method(), body: () => undefined }))
          return;
      await json(route, { message: `unmocked ${url.pathname}` }, 404);
    });
  }
  await page.goto(
    `http://127.0.0.1:${which === 'next' ? NEXT_PORT : DESIGN_PORT}${which === 'next' ? s.next : s.design}`,
    { waitUntil: 'load' },
  );
  // a held-open stream means the network never goes fully idle; wait briefly, then carry on
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => undefined);
  if (which === 'next') await s.setupNext?.(page);
  else await s.setupDesign?.(page);
  // `[hidden]` is honoured on both sides: the design's CSS accidentally un-hides its stand-in
  // buttons, the app does not (ADR 0018). Everything else is compared as drawn.
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}[hidden]{display:none!important}${s.css ?? ''}`,
  });
  if (s.normalize) await page.evaluate(s.normalize);
  await page.waitForTimeout(400);
  const png = await page.screenshot({
    fullPage: true,
    mask: (s.mask ?? []).map((m) => page.locator(m)),
    maskColor: '#FF00FF',
  });
  await context.close();
  return png;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { default: pixelmatch } = await esm('pixelmatch');
  const design = serveDesign();
  const next = await startNext();
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const results: { name: string; ok: boolean; note: string }[] = [];
  try {
    for (const s of scenarios) {
      for (const size of s.sizes ?? ['desktop', 'mobile']) {
        const label = `${s.name} @ ${size}`;
        const [a, b] = [
          await shoot(browser, s, 'design', size),
          await shoot(browser, s, 'next', size),
        ];
        const [pa, pb] = [PNG.sync.read(a), PNG.sync.read(b)];
        const base = join(OUT, `${s.name}-${size}`);
        writeFileSync(`${base}.design.png`, a);
        writeFileSync(`${base}.next.png`, b);
        if (pa.width !== pb.width || pa.height !== pb.height) {
          results.push({
            name: label,
            ok: false,
            note: `different size: design ${pa.width}x${pa.height}, next ${pb.width}x${pb.height}`,
          });
          continue;
        }
        const diff = new PNG({ width: pa.width, height: pa.height });
        const bad = pixelmatch(pa.data, pb.data, diff.data, pa.width, pa.height, {
          threshold: 0.1,
        });
        writeFileSync(`${base}.diff.png`, PNG.sync.write(diff));
        const ratio = bad / (pa.width * pa.height);
        results.push({
          name: label,
          ok: ratio <= MAX_DIFF_RATIO,
          note: `${bad} px differ (${(ratio * 100).toFixed(3)}%)`,
        });
      }
    }
  } finally {
    await browser.close();
    design.close();
    next.kill('SIGTERM');
  }
  console.log('');
  for (const r of results)
    console.log(`${r.ok ? 'SAME  ' : 'DIFFER'}  ${r.name.padEnd(30)} ${r.note}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} identical. Images: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

void main();
