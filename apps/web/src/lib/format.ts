/** Formatting that must read exactly as in the design ("₹1,800", "Sat 6 Dec · 7:30 PM", "DEC"). */

export const TIMEZONE = process.env.NEXT_PUBLIC_TIMEZONE ?? 'Asia/Kolkata';

export const fmt = (n: number): string => '₹' + n.toLocaleString('en-IN');

/** Money from minor units (paise). */
export const fmtMinor = (minor: number, currency = 'INR'): string =>
  currency === 'INR' ? fmt(minor / 100) : `${currency} ${(minor / 100).toLocaleString('en-IN')}`;

function parts(iso: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    ...options,
  }).formatToParts(new Date(iso))) {
    out[p.type] = p.value;
  }
  return out;
}

/** "7:30 PM" */
export function timeOf(iso: string): string {
  const p = parts(iso, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toUpperCase()}`;
}

/** "Sat 6 Dec · 7:30 PM" */
export function dateTimeOf(iso: string): string {
  const p = parts(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${p.weekday} ${p.day} ${p.month} · ${timeOf(iso)}`;
}

/** "Sat 6 Dec" */
export function dateOf(iso: string): string {
  const p = parts(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** { day: "06", month: "DEC" } for the show list. */
export function dayMonth(iso: string): { day: string; month: string } {
  const p = parts(iso, { day: '2-digit', month: 'short' });
  return { day: p.day ?? '', month: (p.month ?? '').toUpperCase() };
}

/** "Neon Nights Live" -> ["Neon Nights", "Live"]: the design italicises the last word of a title. */
export function splitTitle(title: string): [string, string] {
  const i = title.lastIndexOf(' ');
  return i === -1 ? ['', title] : [title.slice(0, i), title.slice(i + 1)];
}

/** "2s ago", "14s ago", "1m ago", "3h ago" */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** "08:41" */
export const clock = (seconds: number): string =>
  `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;

/** "C6" -> { row: "C", number: "6" } */
export const splitSeat = (id: string): { row: string; number: string } => ({
  row: id.charAt(0),
  number: id.slice(1),
});

/** Seats sorted row then number, as the stub lists them. */
export function sortSeats(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    if (a[0] !== b[0]) return (a[0] ?? '') < (b[0] ?? '') ? -1 : 1;
    return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
  });
}
