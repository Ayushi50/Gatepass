import { buildSeatMap, type RowSpec } from './seat-map';
import type { CreateEventInput } from './events';

const DEMO_ORGANIZER = 'org-demo';
const ROWS = ['A', 'B', 'C', 'D', 'E', 'F'];
const TIER_OF_ROW: Record<string, string> = {
  A: 'Front',
  B: 'Front',
  C: 'Mid',
  D: 'Mid',
  E: 'Back',
  F: 'Back',
};

/** A–F, 14 seats per row; Front = A,B  Mid = C,D  Back = E,F (matches design/seats.html). */
function layout(front: number, mid: number, back: number) {
  const price: Record<string, number> = { Front: front, Mid: mid, Back: back };
  const rows: RowSpec[] = ROWS.map((label) => ({
    label,
    tier: TIER_OF_ROW[label]!,
    priceMinor: price[TIER_OF_ROW[label]!]! * 100, // rupees -> paise
  }));
  return buildSeatMap(rows, 14);
}

// The five events of design/events.html. Times are IST (+05:30), December 2026.
export const DEMO_EVENTS: CreateEventInput[] = [
  {
    id: 'neon-nights',
    organizerId: DEMO_ORGANIZER,
    title: 'Neon Nights Live',
    category: 'Music',
    venue: 'Open Air Arena',
    startsAt: new Date('2026-12-06T19:30:00+05:30'),
    seats: layout(2400, 1800, 1200),
  },
  {
    id: 'laugh-lab',
    organizerId: DEMO_ORGANIZER,
    title: 'The Laugh Lab',
    category: 'Comedy',
    venue: 'Studio Theatre',
    startsAt: new Date('2026-12-13T20:00:00+05:30'),
    seats: layout(1200, 900, 600),
  },
  {
    id: 'campus-fest',
    organizerId: DEMO_ORGANIZER,
    title: 'Campus Fest Finale',
    category: 'Festivals',
    venue: 'College Grounds',
    startsAt: new Date('2026-12-14T17:00:00+05:30'),
    seats: layout(999, 699, 499),
  },
  {
    id: 'jazz-roof',
    organizerId: DEMO_ORGANIZER,
    title: 'Jazz on the Roof',
    category: 'Music',
    venue: 'Skyline Terrace',
    startsAt: new Date('2026-12-20T21:15:00+05:30'),
    seats: layout(1500, 1200, 900),
  },
  {
    id: 'midnight-market',
    organizerId: DEMO_ORGANIZER,
    title: 'Midnight Market',
    category: 'Festivals',
    venue: 'Old Mill Yard',
    startsAt: new Date('2026-12-27T22:00:00+05:30'),
    seats: layout(650, 450, 350),
  },
];
