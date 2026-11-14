// The overnight review's browser run: every flow the main e2e does not already cover, with
// screenshots saved to docs/review/screenshots. Run with `pnpm --filter @gatepass/web review`,
// which boots the real system with a 25-second hold so expiry can be watched.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });
const SHOTS = join(__dirname, '..', '..', '..', 'docs', 'review', 'screenshots');
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

const consoleErrors: string[] = [];
function watch(page: Page, where: string) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // the door API answers "already used" with 409 and "invalid" with 404 on purpose; the browser
    // logs every non-2xx response by itself, so those two are expected at the door and nowhere else
    const expected = where.startsWith('door-staff') && /status of (409|404)/.test(m.text());
    if (!expected) consoleErrors.push(`${where}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${where}: ${e.message}`));
}

async function signIn(
  browser: Browser,
  role: 'attendee' | 'organizer' | 'door-staff',
  name?: string,
  next = '/events',
  viewport = { width: 1440, height: 900 },
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  watch(page, `${role}${name ? ':' + name : ''}`);
  await page.goto(`/sign-in?role=${role}&next=${encodeURIComponent(next)}`);
  if (name) await page.fill('#name', name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
  return { context, page };
}
const seat = (page: Page, id: string) => page.locator(`button.seat[data-id="${id}"]`);
async function hold(page: Page, event: string, ids: string[]) {
  await page.goto(`/seats?event=${event}`);
  await expect(seat(page, ids[0]!)).toBeVisible();
  for (const id of ids) await seat(page, id).click();
  await page.locator('#hold-link').click();
  await page.waitForURL(/\/checkout\?booking=/);
}
const myTickets = (page: Page) =>
  page.evaluate(async () => {
    const res = await fetch('/api/tickets', {
      headers: { authorization: `Bearer ${localStorage.getItem('gp.session')}` },
    });
    return (await res.json()) as { qrToken: string; status: string; seatId: string }[];
  });

test('landing page and the show list: filters work and the sold-out show cannot be opened', async ({
  page,
}) => {
  watch(page, 'anonymous');
  await page.goto('/');
  await shot(page, '01-landing');
  await page.goto('/events');
  await expect(page.locator('#show-list li')).toHaveCount(5);
  await shot(page, '02-events');
  await page.getByRole('button', { name: 'Comedy' }).click();
  await expect(page.locator('#show-list li')).toHaveCount(1);
  await expect(page.locator('#show-list li')).toContainText('The Laugh Lab');
  await page.getByRole('button', { name: 'Festivals' }).click();
  await expect(page.locator('#show-list li')).toHaveCount(2); // Campus Fest Finale, Midnight Market
  await shot(page, '03-events-filtered');
  await page.getByRole('button', { name: 'All' }).click();
  const jazz = page.locator('#show-list li', { hasText: 'Jazz on the Roof' });
  await expect(jazz.locator('.sold-badge')).toHaveText('Sold out');
  await expect(jazz.locator('a')).toHaveCount(0);
});

test('seat map: at most six seats, a seventh click is ignored; netbanking pays; ticket has a QR', async ({
  browser,
}) => {
  const { page, context } = await signIn(browser, 'attendee', 'nina');
  await page.goto('/seats?event=campus-fest');
  await expect(seat(page, 'A1')).toBeVisible();
  await shot(page, '04-seats-empty');
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) await seat(page, id).click();
  await expect(page.locator('button.seat[data-state="selected"]')).toHaveCount(6);
  await expect(seat(page, 'A7')).toHaveAttribute('data-state', 'available');
  await expect(page.locator('#limit-note')).toContainText('maximum of six');
  await shot(page, '05-seats-six-selected');
  for (const id of ['A3', 'A4', 'A5', 'A6']) await seat(page, id).click(); // keep two
  await page.locator('#hold-link').click();
  await page.waitForURL(/\/checkout\?booking=/);
  await expect(page.locator('#time')).toHaveText(/^00:(1\d|2[0-5])$/); // 25 s hold, server clock
  await shot(page, '06-checkout-upi');
  await page.getByRole('radio', { name: /Netbanking/ }).click();
  await expect(page.locator('#panel-net')).toBeVisible();
  await shot(page, '07-checkout-netbanking');
  await page.locator('#pay-btn').click();
  await page.waitForURL(/\/status\?booking=/);
  await expect(page.locator('.light[data-s="done"]')).toHaveCount(3, { timeout: 40_000 });
  await shot(page, '08-status-confirmed');
  await page.goto('/tickets');
  await expect(page.locator('article.ticket')).toHaveCount(2);
  await expect(page.locator('article.ticket svg').first()).toBeVisible();
  await shot(page, '09-tickets');
  await context.close();
});

test('card pays; a declined card shows the failure state', async ({ browser }) => {
  const ok = await signIn(browser, 'attendee', 'omar');
  await hold(ok.page, 'campus-fest', ['B1']);
  await ok.page.getByRole('radio', { name: /Card/ }).click();
  await ok.page.fill('#card-no', '4242 4242 4242 4242');
  await ok.page.fill('#card-exp', '12/30');
  await ok.page.fill('#card-cvc', '123');
  await shot(ok.page, '10-checkout-card');
  await ok.page.locator('#pay-btn').click();
  await ok.page.waitForURL(/\/status\?booking=/);
  await expect(ok.page.locator('.light[data-s="done"]')).toHaveCount(3, { timeout: 40_000 });
  await ok.context.close();

  const no = await signIn(browser, 'attendee', 'pia');
  await hold(no.page, 'campus-fest', ['B2']);
  await no.page.getByRole('radio', { name: /Card/ }).click();
  await no.page.fill('#card-no', '4000 0000 0000 0002');
  await no.page.locator('#pay-btn').click();
  await no.page.waitForURL(/\/status\?booking=/);
  await expect(no.page.locator('.light[data-s="failed"]')).toHaveCount(1, { timeout: 40_000 });
  await shot(no.page, '11-status-payment-failed');
  await no.context.close();
});

test('an unpaid hold runs out on screen, payment is switched off, and the seat goes back on sale', async ({
  browser,
}) => {
  const { page, context } = await signIn(browser, 'attendee', 'quinn');
  const other = await signIn(browser, 'attendee', 'rhea');
  await other.page.goto('/seats?event=campus-fest');
  await hold(page, 'campus-fest', ['C1']);
  await expect(seat(other.page, 'C1')).toHaveAttribute('data-state', 'held');
  await expect(page.locator('#expired')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('#pay-btn')).toBeHidden();
  await expect(page.locator('#pay-off')).toBeDisabled();
  await shot(page, '12-checkout-hold-expired');
  // the other buyer's map frees the seat by itself (stream), once the server releases it
  await expect(seat(other.page, 'C1')).toHaveAttribute('data-state', 'available', {
    timeout: 40_000,
  });
  await context.close();
  await other.context.close();
});

test('door: valid, already used and invalid; organizer dashboard; waiting room', async ({
  browser,
}) => {
  const buyer = await signIn(browser, 'attendee', 'nina', '/tickets');
  const tickets = await myTickets(buyer.page);
  expect(tickets.length).toBe(2);
  const door = await signIn(browser, 'door-staff', undefined, '/check-in?gate=1&event=campus-fest');
  const scan = async (code: string) => {
    await door.page.fill('input[aria-label="Ticket code"]', code);
    await door.page.getByRole('button', { name: 'Check' }).click();
  };
  await shot(door.page, '13-door-ready');
  await scan(tickets[0]!.qrToken);
  await expect(door.page.locator('#result[data-m="valid"]')).toBeVisible();
  await shot(door.page, '14-door-valid');
  await scan(tickets[0]!.qrToken);
  await expect(door.page.locator('#result[data-m="used"]')).toBeVisible();
  await shot(door.page, '15-door-used');
  await scan('GP1.forged.signature');
  await expect(door.page.locator('#result[data-m="invalid"]')).toBeVisible();
  await shot(door.page, '16-door-invalid');
  await door.context.close();

  // refund the other ticket and approve it as the organizer
  const org = await signIn(browser, 'organizer', undefined, '/organizer?event=campus-fest');
  await buyer.page.goto('/tickets');
  await buyer.page.getByRole('button', { name: 'Request a refund' }).first().click();
  const row = org.page.locator('#refunds .refund', { hasText: 'nina' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await shot(org.page, '17-organizer-refund-waiting');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(org.page.locator('#refund-count')).toHaveText('0', { timeout: 30_000 });
  await shot(org.page, '18-organizer-after-approval');
  await expect(async () => {
    await buyer.page.reload();
    await expect(buyer.page.locator('.tag', { hasText: 'REFUNDED' })).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 40_000 });
  await shot(buyer.page, '19-tickets-used-and-refunded');
  await org.context.close();
  await buyer.context.close();

  const fan = await signIn(browser, 'attendee', 'sam');
  await fan.page.goto('/waiting-room?event=neon-nights');
  await expect(fan.page.locator('h1')).toContainText('Hold tight');
  await shot(fan.page, '20-waiting-room');
  await fan.page.waitForURL(/\/seats\?event=neon-nights/, { timeout: 30_000 });
  await fan.context.close();
});

test('phone width (390px): every page fits without sideways scrolling', async ({ browser }) => {
  const phone = { width: 390, height: 844 };
  const { page, context } = await signIn(browser, 'attendee', 'nina', '/events', phone);
  const overflow: string[] = [];
  const visit = async (path: string, name: string) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    if (w > 390) overflow.push(`${path} is ${w}px wide`);
    await shot(page, `m-${name}`);
  };
  await visit('/', 'landing');
  await visit('/events', 'events');
  await visit('/seats?event=midnight-market', 'seats');
  await visit('/tickets', 'tickets');
  await hold(page, 'midnight-market', ['A1']);
  await shot(page, 'm-checkout');
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 390) overflow.push(`/checkout is ${w}px wide`);
  await context.close();
  const org = await signIn(browser, 'organizer', undefined, '/organizer?event=campus-fest', phone);
  await shot(org.page, 'm-organizer');
  const ow = await org.page.evaluate(() => document.documentElement.scrollWidth);
  if (ow > 390) overflow.push(`/organizer is ${ow}px wide`);
  await org.context.close();
  expect(overflow).toEqual([]);
});

test('no page logged a console error during the whole run', () => {
  expect(consoleErrors).toEqual([]);
});
