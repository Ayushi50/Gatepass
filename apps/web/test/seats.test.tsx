import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => new URLSearchParams('event=neon-nights'),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));

const stream: { onMessage?: (m: { seatId: string; state: string }) => void } = {};
vi.mock('@/lib/sse', () => ({
  openStream: (_p: string, o: { onMessage: (m: { seatId: string; state: string }) => void }) => {
    stream.onMessage = o.onMessage;
    return new Promise(() => undefined); // stays open
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
const seats = ['A', 'B'].flatMap((row) =>
  Array.from({ length: 10 }, (_, i) => ({
    id: `${row}${i + 1}`,
    row,
    number: i + 1,
    tier: row === 'A' ? 'Front' : 'Mid',
    price: row === 'A' ? 2400 : 1800,
    state: row === 'A' && i === 0 ? 'taken' : 'available',
  })),
);

let bookingState = 'HELD';
const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] =
  [];
function fakeFetch(url: string, init: RequestInit = {}) {
  const method = init.method ?? 'GET';
  calls.push({
    url,
    method,
    headers: (init.headers ?? {}) as Record<string, string>,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  });
  const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (url === '/api/events') return Promise.resolve(ok([EVENT]));
  if (url === '/api/events/neon-nights/seats') return Promise.resolve(ok(seats));
  if (url === '/api/bookings' && method === 'POST')
    return Promise.resolve(ok({ id: 'bk-1', state: 'REQUESTED' }, 201));
  if (url === '/api/bookings/bk-1') return Promise.resolve(ok({ id: 'bk-1', state: bookingState }));
  return Promise.resolve(ok({ message: 'nope' }, 404));
}

const token = `${btoa('{}')}.${btoa(JSON.stringify({ sub: 'alice', role: 'attendee', exp: 9_999_999_999 }))}.s`;

async function page() {
  const { default: Page } = await import('@/app/seats/page');
  render(<Page />);
  await screen.findByLabelText(/Row B, seat 3/);
}
const seat = (id: string) =>
  document.querySelector<HTMLButtonElement>(`button.seat[data-id="${id}"]`)!;

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  calls.length = 0;
  bookingState = 'HELD';
  window.localStorage.setItem('gp.session', token);
  window.sessionStorage.clear();
  vi.stubGlobal('fetch', fakeFetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('seat map', () => {
  it('draws each seat with its state as a shape and a spoken label, not colour alone', async () => {
    await page();
    expect(seat('A1').dataset.state).toBe('taken');
    expect(seat('A1').disabled).toBe(true);
    expect(seat('A1').getAttribute('aria-label')).toBe('Row A, seat 1, Front tier, ₹2,400, taken');
    expect(seat('A1').querySelector('svg')).not.toBeNull(); // the "x"
    expect(seat('B3').dataset.state).toBe('available');
    expect(seat('B3').getAttribute('aria-pressed')).toBe('false');
  });

  it('selecting shows a check, lists the seat and adds up the total; removing undoes it', async () => {
    await page();
    fireEvent.click(seat('B3'));
    fireEvent.click(seat('A4'));
    expect(seat('B3').dataset.state).toBe('selected');
    expect(seat('B3').querySelector('svg')).not.toBeNull(); // the tick
    expect(screen.getByText('2 seats chosen')).toBeTruthy();
    expect(document.getElementById('total')!.textContent).toBe('₹4,200');
    const list = within(document.getElementById('selected')!);
    expect(list.getByText('Row A, seat 4')).toBeTruthy();
    fireEvent.click(list.getByLabelText('Remove row A, seat 4'));
    expect(document.getElementById('total')!.textContent).toBe('₹1,800');
    expect(screen.getByText('1 seat chosen')).toBeTruthy();
  });

  it('allows at most six seats', async () => {
    await page();
    for (const id of ['A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']) fireEvent.click(seat(id));
    expect(document.querySelectorAll('button.seat[data-state="selected"]').length).toBe(6);
    expect(seat('A8').dataset.state).toBe('available');
    expect(screen.getByText('That is the maximum of six.')).toBeTruthy();
  });

  it('a seat someone else gets first (live) is taken off your list, and you are told', async () => {
    await page();
    fireEvent.click(seat('B5'));
    fireEvent.click(seat('B6'));
    act(() => stream.onMessage!({ seatId: 'B5', state: 'held' }));
    await waitFor(() => expect(seat('B5').dataset.state).toBe('held'));
    expect(seat('B5').disabled).toBe(true);
    expect(seat('B6').dataset.state).toBe('selected'); // the other one is untouched
    expect(screen.getByText(/Row B, seat 5 just went to someone else/)).toBeTruthy();
    expect(document.getElementById('total')!.textContent).toBe('₹1,800');
  });

  it('live updates change other seats without any click', async () => {
    await page();
    act(() => stream.onMessage!({ seatId: 'A9', state: 'taken' }));
    await waitFor(() => expect(seat('A9').dataset.state).toBe('taken'));
    act(() => stream.onMessage!({ seatId: 'A9', state: 'available' }));
    await waitFor(() => expect(seat('A9').dataset.state).toBe('available'));
  });

  it('with nothing chosen the hold button is disabled and the empty note shows', async () => {
    await page();
    expect(document.getElementById('hold-disabled')!.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('hold-link')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('empty-note')!.hasAttribute('hidden')).toBe(false);
  });
});

describe('holding the seats', () => {
  it('books the chosen seats (sorted), waits for the hold, then goes to checkout', async () => {
    await page();
    fireEvent.click(seat('B3'));
    fireEvent.click(seat('A4'));
    fireEvent.click(document.getElementById('hold-link')!);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/checkout?booking=bk-1'));
    const post = calls.find((c) => c.url === '/api/bookings')!;
    expect(post.body).toEqual({ eventId: 'neon-nights', seatIds: ['A4', 'B3'] });
    expect(post.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('if the seat service refuses the hold, you stay on the map, told, with it refreshed', async () => {
    bookingState = 'CANCELLED';
    await page();
    fireEvent.click(seat('B3'));
    fireEvent.click(document.getElementById('hold-link')!);
    await screen.findByText(/Someone else got one of those seats first/);
    expect(push).not.toHaveBeenCalled();
    expect(document.querySelectorAll('button.seat[data-state="selected"]').length).toBe(0);
  });

  it('signed out: nothing loads, and you are sent to sign in and back', async () => {
    window.localStorage.clear();
    const goTo = vi.fn();
    vi.stubGlobal('location', {
      ...window.location,
      pathname: '/seats',
      search: '?event=neon-nights',
      replace: goTo,
    });
    const { default: Page } = await import('@/app/seats/page');
    render(<Page />);
    await waitFor(() => expect(goTo).toHaveBeenCalled());
    expect(goTo.mock.calls[0]![0]).toBe('/sign-in?next=%2Fseats%3Fevent%3Dneon-nights');
    expect(calls.some((c) => c.url.includes('/seats'))).toBe(false); // no seat data for a stranger
    vi.unstubAllGlobals();
  });

  it('a session that ends while you choose: the picks are kept and you sign in, then come back', async () => {
    await page();
    window.localStorage.clear();
    fireEvent.click(seat('B3'));
    fireEvent.click(document.getElementById('hold-link')!);
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls[0]![0])).toContain('/sign-in?role=attendee&next=');
    expect(JSON.parse(window.sessionStorage.getItem('gp.pending.neon-nights')!)).toEqual(['B3']);
    expect(calls.some((c) => c.url === '/api/bookings')).toBe(false); // nothing was booked
  });
});
