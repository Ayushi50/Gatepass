import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  dateOf,
  dateTimeOf,
  dayMonth,
  fmt,
  fmtMinor,
  sortSeats,
  splitSeat,
  splitTitle,
  timeAgo,
  timeOf,
} from '@/lib/format';
import { clockSkew, secondsLeft } from '@/lib/hold';
import { GATEWAY_METHOD, testToken } from '@/lib/payment';
import { clearSession, decodeToken, getSession, setSession } from '@/lib/session';
import { idempotencyKeyFor } from '@/lib/storage';
import { calendarFile } from '@/lib/ics';

const jwt = (payload: object) =>
  `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify(payload)).replace(/=/g, '')}.sig`;

describe('formatting reads exactly as the design does', () => {
  it('money', () => {
    expect(fmt(1800)).toBe('₹1,800');
    expect(fmt(1234567)).toBe('₹12,34,567');
    expect(fmtMinor(240000)).toBe('₹2,400');
    expect(fmtMinor(1050, 'USD')).toBe('USD 10.5');
  });
  it('dates and times in the show timezone (IST)', () => {
    const t = '2025-12-06T14:00:00.000Z'; // 7:30 PM in Kolkata
    expect(timeOf(t)).toBe('7:30 PM');
    expect(dateOf(t)).toBe('Sat 6 Dec');
    expect(dateTimeOf(t)).toBe('Sat 6 Dec · 7:30 PM');
    expect(dayMonth(t)).toEqual({ day: '06', month: 'DEC' });
    expect(timeOf('2025-12-06T16:30:00.000Z')).toBe('10:00 PM');
    expect(timeOf('2025-12-06T00:45:00.000Z')).toBe('6:15 AM');
  });
  it('the last word of a title is the italic one', () => {
    expect(splitTitle('Neon Nights Live')).toEqual(['Neon Nights', 'Live']);
    expect(splitTitle('Midnight')).toEqual(['', 'Midnight']);
  });
  it('relative times', () => {
    const now = Date.parse('2025-12-06T10:00:00Z');
    const ago = (s: number) => new Date(now - s * 1000).toISOString();
    expect([2, 14, 59, 60, 119, 3600, 7200, 90000].map((s) => timeAgo(ago(s), now))).toEqual([
      '2s ago',
      '14s ago',
      '59s ago',
      '1m ago',
      '1m ago',
      '1h ago',
      '2h ago',
      '1d ago',
    ]);
    expect(timeAgo(new Date(now + 5000).toISOString(), now)).toBe('0s ago'); // never negative
  });
  it('the countdown clock and seats', () => {
    expect([521, 600, 0, 59, 3599].map(clock)).toEqual([
      '08:41',
      '10:00',
      '00:00',
      '00:59',
      '59:59',
    ]);
    expect(splitSeat('C12')).toEqual({ row: 'C', number: '12' });
    expect(sortSeats(['C10', 'A2', 'C9', 'B1', 'A10'])).toEqual(['A2', 'A10', 'B1', 'C9', 'C10']);
  });
});

describe('the hold countdown follows the SERVER clock', () => {
  const serverNow = '2025-12-06T10:00:00.000Z';
  const expires = '2025-12-06T10:08:41.000Z'; // 521 s of hold left, by the server's reckoning

  it('with an accurate browser clock it is exact', () => {
    const now = Date.parse(serverNow);
    expect(secondsLeft(expires, now, clockSkew(serverNow, now))).toBe(521);
  });
  it('a browser 5 minutes FAST still shows the true time left', () => {
    const browser = Date.parse(serverNow) + 5 * 60_000;
    const skew = clockSkew(serverNow, browser);
    expect(secondsLeft(expires, browser, skew)).toBe(521);
    expect(secondsLeft(expires, browser + 21_000, skew)).toBe(500); // and it counts down from there
  });
  it('a browser 5 minutes SLOW too', () => {
    const browser = Date.parse(serverNow) - 5 * 60_000;
    expect(secondsLeft(expires, browser, clockSkew(serverNow, browser))).toBe(521);
  });
  it('never goes below zero and rounds down', () => {
    const now = Date.parse(serverNow);
    expect(secondsLeft(expires, now + 600_000, 0)).toBe(0);
    expect(secondsLeft(expires, now + 520_500, 0)).toBe(0); // 0.5 s left is "00:00", never "00:01"
  });
});

describe('test-mode payment tokens (the form is read here, only the token leaves the browser)', () => {
  it('chooses declined, refused or success', () => {
    expect(testToken('card', { card: '4000 0000 0000 0002' })).toBe('tok_declined');
    expect(testToken('card', { card: '4000000000000069' })).toBe('tok_rejected');
    expect(testToken('card', { card: '4242 4242 4242 4242' })).toBe('tok_success');
    expect(testToken('upi', { upi: 'sam@fail' })).toBe('tok_declined');
    expect(testToken('upi', { upi: 'sam@okbank' })).toBe('tok_success');
    expect(testToken('net', {})).toBe('tok_success');
  });
  it('never puts what was typed into the token', () => {
    for (const t of [
      testToken('card', { card: '4242424242424242' }),
      testToken('upi', { upi: 'secret@bank' }),
    ]) {
      expect(t).not.toContain('4242');
      expect(t).not.toContain('secret');
    }
  });
  it('speaks the gateway names', () => {
    expect(GATEWAY_METHOD).toEqual({ upi: 'upi', card: 'card', net: 'netbanking' });
  });
});

describe('session', () => {
  beforeEach(() => window.localStorage.clear());

  it('reads a token for display and expiry', () => {
    expect(decodeToken(jwt({ sub: 'alice', role: 'attendee', exp: 9_999_999_999 }))).toMatchObject({
      sub: 'alice',
      role: 'attendee',
    });
    expect(decodeToken('garbage')).toBeNull();
    expect(decodeToken(jwt({ sub: 'x' }))).toBeNull();
  });
  it('keeps a session until it expires, then forgets it', () => {
    const live = jwt({ sub: 'alice', role: 'attendee', exp: Math.floor(Date.now() / 1000) + 60 });
    expect(setSession(live)).not.toBeNull();
    expect(getSession()?.sub).toBe('alice');
    expect(getSession(Date.now() + 120_000)).toBeNull();
    expect(window.localStorage.getItem('gp.session')).toBeNull(); // expired tokens are removed
  });
  it('refuses to store something that is not a token, and can sign out', () => {
    expect(setSession('nope')).toBeNull();
    setSession(jwt({ sub: 'a', role: 'organizer', exp: 9_999_999_999 }));
    clearSession();
    expect(getSession()).toBeNull();
  });
});

describe('the Idempotency-Key', () => {
  beforeEach(() => window.sessionStorage.clear());
  it('is the same for one booking however often Pay is pressed, and different per booking', () => {
    const a = idempotencyKeyFor('bk-aaaaaaaa-1');
    expect(idempotencyKeyFor('bk-aaaaaaaa-1')).toBe(a);
    expect(idempotencyKeyFor('bk-bbbbbbbb-2')).not.toBe(a);
    expect(a.length).toBeGreaterThanOrEqual(8); // the gateway wants 8-128 characters
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
  });
});

describe('calendar file', () => {
  afterEach(() => vi.useRealTimers());
  it('is a valid single event with the show, time and place', () => {
    const ics = calendarFile({
      eventTitle: 'Neon Nights, Live',
      startsAt: '2025-12-06T14:00:00.000Z',
      venue: 'Open Air Arena',
      code: 'GP-7QX2-C6',
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART:20251206T140000Z');
    expect(ics).toContain('DTEND:20251206T170000Z');
    expect(ics).toContain('SUMMARY:Neon Nights\\, Live');
    expect(ics).toContain('LOCATION:Open Air Arena');
    expect(ics.split('\r\n').at(-1)).toBe('END:VCALENDAR');
  });
});
