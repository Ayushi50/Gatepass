import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

test.describe.configure({ mode: 'serial' });

/** Signs in through the real sign-in page, as the user would. */
async function signIn(
  browser: Browser,
  role: 'attendee' | 'organizer' | 'door-staff',
  name?: string,
  next = '/events',
) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`/sign-in?role=${role}&next=${encodeURIComponent(next)}`);
  if (name) await page.fill('#name', name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
  return { context, page };
}

const seat = (page: Page, id: string) => page.locator(`button.seat[data-id="${id}"]`);

async function chooseAndHold(page: Page, event: string, ids: string[]) {
  await page.goto(`/seats?event=${event}`);
  await expect(seat(page, ids[0]!)).toBeVisible();
  for (const id of ids) await seat(page, id).click();
  await page.locator('#hold-link').click();
  await page.waitForURL(/\/checkout\?booking=/);
}

const state: { qrToken?: string; code?: string } = {};
let aarav: { context: BrowserContext; page: Page };

test('the show list is real, and Jazz on the Roof is genuinely sold out', async ({ page }) => {
  await page.goto('/events');
  await expect(page.locator('#show-list li')).toHaveCount(5);
  const jazz = page.locator('#show-list li', { hasText: 'Jazz on the Roof' });
  await expect(jazz.locator('.sold-badge')).toHaveText('Sold out');
  await expect(jazz.locator('a')).toHaveCount(0); // not clickable
  await expect(
    page.locator('#show-list li', { hasText: 'Neon Nights Live' }).locator('a'),
  ).toHaveCount(1);
});

test('a user books seats, pays, sees the three lights, and gets a ticket whose QR code is real', async ({
  browser,
}) => {
  aarav = await signIn(browser, 'attendee', 'aarav');
  const { page } = aarav;
  await chooseAndHold(page, 'laugh-lab', ['C6', 'C7']);

  // checkout: the hold clock follows the server and starts near ten minutes
  await expect(page.locator('#time')).toHaveText(/^(09:[3-5]\d|10:00)$/);
  await expect(page.locator('.line-item')).toHaveCount(2);

  await page.fill('#upi-id', 'aarav@okbank');
  await page.locator('#pay-btn').click();
  await page.waitForURL(/\/status\?booking=/);
  await expect(page.locator('h1')).toContainText('See you', { timeout: 40_000 });
  await expect(page.locator('.light[data-s="done"]')).toHaveCount(3);

  await page.getByRole('link', { name: 'View my tickets' }).click();
  await expect(page.locator('article.ticket')).toHaveCount(2);

  // what the server issued, versus what the page draws
  const tickets = await page.evaluate(async () => {
    const res = await fetch('/api/tickets', {
      headers: { authorization: `Bearer ${localStorage.getItem('gp.session')}` },
    });
    return (await res.json()) as { qrToken: string; code: string; status: string }[];
  });
  expect(tickets).toHaveLength(2);
  state.qrToken = tickets[0]!.qrToken;
  state.code = tickets[0]!.code;

  // enlarge the first QR, photograph it, and decode it like a scanner would
  await page.locator('article.ticket').first().locator('.qr-btn').click();
  const png = PNG.sync.read(await page.locator('#qr-large svg').screenshot());
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(decoded?.data).toBe(state.qrToken);
});

test('door staff admit that ticket once, and the second scan says it was used', async ({
  browser,
}) => {
  const door = await signIn(browser, 'door-staff', undefined, '/check-in?gate=2&event=laugh-lab');
  const { page } = door;
  const scan = async () => {
    await page.fill('input[aria-label="Ticket code"]', state.qrToken!);
    await page.getByRole('button', { name: 'Check' }).click();
  };
  await scan();
  await expect(page.locator('#result[data-m="valid"]')).toContainText('Welcome');
  await expect(page.locator('#result')).toContainText('Row C · Seat 6');
  await scan();
  await expect(page.locator('#result[data-m="used"]')).toContainText('Already');

  await page.fill('input[aria-label="Ticket code"]', 'GP1.forged.signature');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.locator('#result[data-m="invalid"]')).toBeVisible();
  await door.context.close();
});

test('two people at once: a seat one person holds turns "someone is paying" for the other, live', async ({
  browser,
}) => {
  const ben = await signIn(browser, 'attendee', 'ben');
  const cara = await signIn(browser, 'attendee', 'cara');
  await cara.page.goto('/seats?event=laugh-lab');
  await expect(seat(cara.page, 'E3')).toHaveAttribute('data-state', 'available');

  await chooseAndHold(ben.page, 'laugh-lab', ['E3']);
  await expect(seat(cara.page, 'E3')).toHaveAttribute('data-state', 'held'); // no reload: the stream told her
  await expect(seat(cara.page, 'E3')).toBeDisabled();
  await ben.context.close();
  await cara.context.close();
});

test('a declined payment shows the failure and gives the seats back', async ({ browser }) => {
  const dev = await signIn(browser, 'attendee', 'dev');
  const { page } = dev;
  await chooseAndHold(page, 'laugh-lab', ['F1']);
  await page.getByRole('radio', { name: /Card/ }).click();
  await page.fill('#card-no', '4000 0000 0000 0002');
  await page.locator('#pay-btn').click();
  await page.waitForURL(/\/status\?booking=/);
  await expect(page.locator('h1')).toContainText('back down', { timeout: 40_000 });
  await expect(page.locator('.light[data-s="failed"]')).toHaveCount(1);

  await page.goto('/seats?event=laugh-lab');
  await expect(seat(page, 'F1')).toHaveAttribute('data-state', 'available', { timeout: 30_000 });
  await dev.context.close();
});

test('a refund: the buyer asks, the organizer sees it live and approves, the ticket is refunded', async ({
  browser,
}) => {
  // seat 6 was used at the door in an earlier test, so it can no longer be refunded: use seat 7
  const seat7 = () =>
    aarav.page
      .locator('article.ticket')
      .filter({ has: aarav.page.locator('.v', { hasText: /^7$/ }) });
  const org = await signIn(browser, 'organizer', undefined, '/organizer?event=laugh-lab');
  await expect(org.page.locator('.tile', { hasText: 'Sold' }).locator('.n')).toContainText('2', {
    timeout: 20_000,
  });

  await aarav.page.goto('/tickets');
  await aarav.page
    .locator('article.ticket')
    .filter({ has: aarav.page.locator('.v', { hasText: /^7$/ }) })
    .getByRole('button', { name: 'Request a refund' })
    .click();
  await expect(seat7().locator('.tag', { hasText: 'REFUND REQUESTED' })).toBeVisible();

  const row = org.page.locator('#refunds .refund', { hasText: 'aarav' });
  await expect(row).toBeVisible({ timeout: 30_000 }); // appeared without the organizer reloading
  await expect(org.page.locator('#refund-count')).toHaveText('1');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row.locator('.done')).toHaveText('Approved ✓');
  await expect(org.page.locator('#refund-count')).toHaveText('0', { timeout: 20_000 });
  await expect(org.page.locator('#feed')).toContainText('refund.completed', { timeout: 30_000 });

  await expect(async () => {
    await aarav.page.reload();
    await expect(seat7().locator('.tag', { hasText: 'REFUNDED' })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000 });
  await org.context.close();
  await aarav.context.close();
});

test('a high-demand show sends you through the waiting room, and booking needs the pass', async ({
  browser,
}) => {
  const eli = await signIn(browser, 'attendee', 'eli');
  const { page } = eli;
  await page.goto('/events');
  await page.locator('#show-list li', { hasText: 'Neon Nights Live' }).locator('a').click();
  await page.waitForURL(/\/waiting-room\?event=neon-nights/);
  await expect(page.locator('h1')).toContainText('Hold tight');
  await page.waitForURL(/\/seats\?event=neon-nights/, { timeout: 30_000 }); // admitted, then moved on
  await expect(seat(page, 'A1')).toBeVisible();

  // without the pass the server refuses, whatever the page does
  const refused = await page.evaluate(async () => {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${localStorage.getItem('gp.session')}`,
      },
      body: JSON.stringify({ eventId: 'neon-nights', seatIds: ['A1'] }),
    });
    return { status: res.status, body: await res.json() };
  });
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('waiting_room_required');
  await eli.context.close();
});
