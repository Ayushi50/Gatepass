import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('booking=bk-1'),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/sse', () => ({ openStream: () => new Promise(() => undefined) }));

// Razorpay's window: pressing Pay must open it for the order the server made, then confirm
const razorpay = vi.hoisted(() => ({ opened: [] as { keyId: string; orderId: string }[] }));
vi.mock('@/lib/razorpay', () => ({
  payWithRazorpay: async (o: { keyId: string; orderId: string }) => {
    razorpay.opened.push(o);
    return { orderId: o.orderId, paymentId: 'pay_9', signature: 'sig' };
  },
}));

const EVENT = {
  id: 'neon-nights',
  title: 'Neon Nights Live',
  category: 'Music',
  venue: 'Open Air Arena',
  startsAt: '2025-12-06T14:00:00.000Z',
  currency: 'INR',
  waitingRoom: false,
  minPrice: 1200,
  status: 'available',
  availability: { total: 20, available: 20 },
};
const BOOKING = {
  id: 'bk-1',
  eventId: 'neon-nights',
  seatIds: ['B3'],
  state: 'HELD',
  userId: 'alice',
  amountMinor: 120000,
  currency: 'INR',
  holdExpiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
};

let provider: object = { provider: 'razorpay', keyId: 'rzp_test_abc' };
const calls: { url: string; method: string; body?: unknown }[] = [];
function fakeFetch(url: string, init: RequestInit = {}) {
  const method = init.method ?? 'GET';
  calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
  const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (url === '/api/events') return Promise.resolve(ok([EVENT]));
  if (url === '/api/events/neon-nights/seats') return Promise.resolve(ok([]));
  if (url === '/api/payments/config') return Promise.resolve(ok(provider));
  if (url === '/api/bookings/bk-1') return Promise.resolve(ok(BOOKING));
  if (url === '/api/bookings/bk-1/pay')
    return Promise.resolve(
      ok({ paymentId: 'p1', status: 'processing', providerRef: 'order_1' }, 202),
    );
  if (url === '/api/bookings/bk-1/pay/confirm')
    return Promise.resolve(ok({ paymentId: 'p1', status: 'succeeded' }));
  return Promise.resolve(ok({ message: 'nope' }, 404));
}

const token = `${btoa('{}')}.${btoa(JSON.stringify({ sub: 'alice', role: 'attendee', exp: 9_999_999_999 }))}.s`;

beforeEach(() => {
  push.mockReset();
  calls.length = 0;
  razorpay.opened.length = 0;
  provider = { provider: 'razorpay', keyId: 'rzp_test_abc' };
  window.localStorage.setItem('gp.session', token);
  window.sessionStorage.clear();
  vi.stubGlobal('fetch', fakeFetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function page() {
  const { default: Page } = await import('@/app/checkout/page');
  render(<Page />);
  await waitFor(() =>
    expect(document.getElementById('pay-btn')!.hasAttribute('disabled')).toBe(false),
  );
}

describe('paying with Razorpay', () => {
  it('opens Razorpay for the order and confirms, without asking for a UPI id or card here', async () => {
    await page();
    await screen.findByText(/choose UPI, card or netbanking in Razorpay/);
    fireEvent.click(document.getElementById('pay-btn')!);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/status?booking=bk-1'));

    expect(razorpay.opened).toEqual([{ keyId: 'rzp_test_abc', orderId: 'order_1' }]);
    const pay = calls.find((c) => c.url === '/api/bookings/bk-1/pay')!;
    expect(pay.body).toMatchObject({ token: 'razorpay_checkout' });
    expect(calls.find((c) => c.url === '/api/bookings/bk-1/pay/confirm')!.body).toEqual({
      orderId: 'order_1',
      paymentId: 'pay_9',
      signature: 'sig',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('paying with the fake provider', () => {
  it('still wants a UPI id first', async () => {
    provider = { provider: 'fake' };
    await page();
    fireEvent.click(document.getElementById('pay-btn')!);
    await screen.findByText('Enter your UPI ID, like name@bank.');
    expect(calls.some((c) => c.url === '/api/bookings/bk-1/pay')).toBe(false);
  });
});
