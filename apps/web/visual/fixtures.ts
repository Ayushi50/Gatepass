/**
 * The design's own sample data, expressed as the API answers that would produce it.
 * (design/events.html, seats.html, checkout.html, status.html, tickets.html, organizer.html.)
 */
export const FIXED_TIME = new Date('2025-12-06T10:00:00.000Z'); // 3:30 PM IST on the day of the show

const iso = (s: string) => new Date(s).toISOString();

export const EVENTS = [
  {
    id: 'neon-nights',
    title: 'Neon Nights Live',
    category: 'Music',
    venue: 'Open Air Arena',
    startsAt: iso('2025-12-06T19:30:00+05:30'),
    minPrice: 1200,
    status: 'selling_fast',
  },
  {
    id: 'laugh-lab',
    title: 'The Laugh Lab',
    category: 'Comedy',
    venue: 'Studio Theatre',
    startsAt: iso('2025-12-13T20:00:00+05:30'),
    minPrice: 600,
    status: 'available',
  },
  {
    id: 'campus-fest',
    title: 'Campus Fest Finale',
    category: 'Festivals',
    venue: 'College Grounds',
    startsAt: iso('2025-12-14T17:00:00+05:30'),
    minPrice: 499,
    status: 'available',
  },
  {
    id: 'jazz-roof',
    title: 'Jazz on the Roof',
    category: 'Music',
    venue: 'Skyline Terrace',
    startsAt: iso('2025-12-20T21:15:00+05:30'),
    minPrice: 0,
    status: 'sold_out',
  },
  {
    id: 'midnight-market',
    title: 'Midnight Market',
    category: 'Festivals',
    venue: 'Old Mill Yard',
    startsAt: iso('2025-12-27T22:00:00+05:30'),
    minPrice: 350,
    status: 'available',
  },
].map((e) => ({
  ...e,
  currency: 'INR',
  waitingRoom: false,
  availability: { total: 84, available: e.status === 'sold_out' ? 0 : 40 },
}));

const ROWS = [
  { l: 'A', tier: 'Front', price: 2400 },
  { l: 'B', tier: 'Front', price: 2400 },
  { l: 'C', tier: 'Mid', price: 1800 },
  { l: 'D', tier: 'Mid', price: 1800 },
  { l: 'E', tier: 'Back', price: 1200 },
  { l: 'F', tier: 'Back', price: 1200 },
];
const TAKEN = [
  'A3',
  'A4',
  'A11',
  'B2',
  'B12',
  'C1',
  'C12',
  'C13',
  'D5',
  'D6',
  'D14',
  'E3',
  'E9',
  'F1',
  'F2',
  'F8',
];
const HELD = ['A7', 'B5', 'C9', 'D2', 'E6'];

export const SEATS = ROWS.flatMap((r) =>
  Array.from({ length: 14 }, (_, i) => {
    const id = `${r.l}${i + 1}`;
    return {
      id,
      row: r.l,
      number: i + 1,
      tier: r.tier,
      price: r.price,
      state: TAKEN.includes(id) ? 'taken' : HELD.includes(id) ? 'held' : 'available',
    };
  }),
);

export const BOOKING = {
  id: 'bk-demo',
  eventId: 'neon-nights',
  userId: 'attendee-1',
  seatIds: ['C6', 'C7'],
  state: 'HELD',
  holdExpiresAt: new Date(FIXED_TIME.getTime() + 521_000).toISOString(),
  cancelReason: null,
  amountMinor: 360000,
  currency: 'INR',
  serverTime: FIXED_TIME.toISOString(),
};

export const TICKETS = ['C6', 'C7'].map((s) => ({
  id: `t-${s}`,
  code: `GP-7QX2-${s}`,
  bookingId: 'bk-demo',
  eventId: 'neon-nights',
  eventTitle: 'Neon Nights Live',
  startsAt: EVENTS[0]!.startsAt,
  venue: 'Open Air Arena',
  row: 'C',
  seat: s.slice(1),
  tier: 'Mid',
  qrToken: `GP1.demo-${s}.signature-that-is-long-enough-to-make-a-real-looking-qr-code-in-the-test`,
  status: 'valid',
}));

export const SUMMARY = {
  eventId: 'neon-nights',
  title: 'Neon Nights Live',
  startsAt: EVENTS[0]!.startsAt,
  sold: 842,
  total: 1200,
  held: 36,
  left: 322,
  refundRequests: 5,
  tiers: [
    { name: 'Front', sold: 288, total: 300 },
    { name: 'Mid', sold: 372, total: 500 },
    { name: 'Back', sold: 182, total: 400 },
  ],
};

export const REFUNDS = [
  ['Aarav M.', 'C6', 180000],
  ['Isha K.', 'A9', 240000],
  ['Rohan P.', 'E4', 120000],
  ['Meera S.', 'D10', 180000],
  ['Kabir T.', 'F7', 120000],
].map(([who, seat, amount], i) => ({
  id: `rf-${i + 1}`,
  bookingId: `bk-${i}`,
  userId: who,
  seatId: seat,
  amountMinor: amount,
  currency: 'INR',
  state: 'requested',
}));

const ago = (s: number) => new Date(FIXED_TIME.getTime() - s * 1000).toISOString();
export const ACTIVITY = [
  ['seats.sold', 'Row B · seats 8, 9', 2, false],
  ['payment.failed', 'Card declined · seats released', 14, true],
  ['ticket.issued', 'Booking GP-7QX2 · 2 tickets', 31, false],
  ['hold.expired', 'Row D · seat 2 returned to sale', 48, false],
  ['refund.completed', 'Booking GP-4LM8 · ₹2,400', 60, false],
].map(([type, text, s, failed], i) => ({
  id: `a${i}`,
  eventId: 'neon-nights',
  bookingId: 'bk',
  type,
  text,
  failed,
  at: ago(s as number),
}));
