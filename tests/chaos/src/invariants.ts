import type { Pool } from 'pg';

export interface SystemPools {
  inventory: Pool;
  booking: Pool;
  payment: Pool;
  ticket: Pool;
  analytics: Pool;
  /** Every database with an outbox, to prove nothing is left unsent. */
  outboxes: Pool[];
}

export interface InvariantOptions {
  eventId: string;
  organizerId: string;
  seatPriceMinor: number;
  totalSeats: number;
  /** Payments the provider really captured (an authentic success was reported). */
  captured: ReadonlySet<string>;
}

/**
 * The facts that must hold once the system has settled, however badly it was treated on the way.
 * Returns a list of violations (empty = consistent). Every message says what and which ids, so a
 * failure points straight at the broken booking.
 */
export async function checkInvariants(p: SystemPools, o: InvariantOptions): Promise<string[]> {
  const bad: string[] = [];
  const q = async <T>(pool: Pool, sql: string, args: unknown[] = []) =>
    (await pool.query(sql, args)).rows as T[];

  const seats = await q<{ seat_id: string; state: string; booking_id: string | null }>(
    p.inventory,
    'SELECT seat_id, state, booking_id FROM seats WHERE event_id = $1',
    [o.eventId],
  );
  const bookings = await q<{ id: string; state: string; seat_ids: string[] }>(
    p.booking,
    'SELECT id, state, seat_ids FROM bookings',
  );
  const payments = await q<{ id: string; booking_id: string; state: string; amount_minor: string }>(
    p.payment,
    'SELECT id, booking_id, state, amount_minor FROM payments',
  );
  const refunds = await q<{
    id: string;
    payment_id: string;
    booking_id: string;
    seat_id: string;
    state: string;
    amount_minor: string;
  }>(p.payment, 'SELECT id, payment_id, booking_id, seat_id, state, amount_minor FROM refunds');
  const tickets = await q<{ booking_id: string; seat_id: string; status: string }>(
    p.ticket,
    'SELECT booking_id, seat_id, status FROM tickets',
  );

  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const seatById = new Map(seats.map((s) => [s.seat_id, s]));

  // 1. nothing is left half-way
  for (const s of seats) {
    if (s.state === 'held') bad.push(`seat ${s.seat_id} is still held by ${s.booking_id}`);
  }
  for (const b of bookings) {
    if (b.state !== 'CONFIRMED' && b.state !== 'CANCELLED')
      bad.push(`booking ${b.id} is stuck in ${b.state}`);
  }
  for (const pay of payments) {
    if (pay.state !== 'SUCCEEDED' && pay.state !== 'FAILED')
      bad.push(`payment ${pay.id} is stuck in ${pay.state}`);
  }
  for (const r of refunds)
    if (r.state !== 'COMPLETED') bad.push(`refund ${r.id} is stuck in ${r.state}`);

  // 2. no double booking: a sold seat belongs to exactly one booking, and that booking is CONFIRMED and lists it
  for (const s of seats.filter((x) => x.state === 'sold')) {
    const b = s.booking_id ? bookingById.get(s.booking_id) : undefined;
    if (!b) bad.push(`seat ${s.seat_id} is sold to an unknown booking ${s.booking_id}`);
    else if (b.state !== 'CONFIRMED')
      bad.push(`seat ${s.seat_id} is sold to ${b.id} which is ${b.state}`);
    else if (!b.seat_ids.includes(s.seat_id))
      bad.push(`seat ${s.seat_id} is sold to ${b.id} which did not ask for it`);
  }

  // 3. a confirmed booking has its tickets, and each ticket matches its seat
  for (const b of bookings.filter((x) => x.state === 'CONFIRMED')) {
    const mine = tickets.filter((t) => t.booking_id === b.id);
    if (mine.length !== b.seat_ids.length)
      bad.push(`booking ${b.id} has ${mine.length} tickets for ${b.seat_ids.length} seats`);
    for (const t of mine) {
      const seat = seatById.get(t.seat_id);
      const owned = seat?.state === 'sold' && seat.booking_id === b.id;
      if (t.status === 'void' && owned)
        bad.push(`ticket ${b.id}/${t.seat_id} is void but the seat is still sold to it`);
      if (t.status !== 'void' && !owned)
        bad.push(`ticket ${b.id}/${t.seat_id} is ${t.status} but the seat is not sold to it`);
    }
  }

  // 4. a cancelled booking owns nothing and has no tickets, and any money it paid went back in full
  for (const b of bookings.filter((x) => x.state === 'CANCELLED')) {
    if (seats.some((s) => s.booking_id === b.id))
      bad.push(`cancelled booking ${b.id} still owns a seat`);
    if (tickets.some((t) => t.booking_id === b.id))
      bad.push(`cancelled booking ${b.id} has tickets`);
    for (const pay of payments.filter((x) => x.booking_id === b.id && x.state === 'SUCCEEDED')) {
      const back = refunds
        .filter((r) => r.payment_id === pay.id)
        .reduce((n, r) => n + Number(r.amount_minor), 0);
      if (back !== Number(pay.amount_minor))
        bad.push(`cancelled booking ${b.id} paid ${pay.amount_minor} but got back ${back}`);
    }
  }

  // 5. money: what came in, minus what went back, is exactly the value of the seats that are sold
  const paid = payments
    .filter((x) => x.state === 'SUCCEEDED')
    .reduce((n, x) => n + Number(x.amount_minor), 0);
  const back = refunds
    .filter((x) => x.state === 'COMPLETED')
    .reduce((n, x) => n + Number(x.amount_minor), 0);
  const soldValue = seats.filter((s) => s.state === 'sold').length * o.seatPriceMinor;
  if (paid - back !== soldValue)
    bad.push(
      `money: paid ${paid} - refunded ${back} = ${paid - back}, but sold seats are worth ${soldValue}`,
    );
  for (const pay of payments) {
    const total = refunds
      .filter((r) => r.payment_id === pay.id)
      .reduce((n, r) => n + Number(r.amount_minor), 0);
    if (total > Number(pay.amount_minor))
      bad.push(`payment ${pay.id} refunded ${total} of ${pay.amount_minor}`);
  }
  const charged = new Set(payments.filter((x) => x.state === 'SUCCEEDED').map((x) => x.id));
  for (const id of o.captured)
    if (!charged.has(id))
      bad.push(`the provider captured payment ${id} but we do not have it as SUCCEEDED`);
  for (const id of charged)
    if (!o.captured.has(id))
      bad.push(`payment ${id} is SUCCEEDED but the provider never captured it`);
  const perBooking = new Map<string, number>();
  for (const x of payments.filter((y) => y.state !== 'FAILED'))
    perBooking.set(x.booking_id, (perBooking.get(x.booking_id) ?? 0) + 1);
  for (const [bookingId, n] of perBooking)
    if (n > 1) bad.push(`booking ${bookingId} has ${n} live payments`);

  // 6. nothing is waiting to be published
  for (const [i, pool] of p.outboxes.entries()) {
    const pending = await q<{ n: string }>(
      pool,
      'SELECT count(*) AS n FROM outbox WHERE published_at IS NULL',
    );
    if (Number(pending[0]!.n) > 0)
      bad.push(`outbox #${i} still has ${pending[0]!.n} unpublished events`);
  }

  // 7. the dashboard agrees with reality
  const [analytics] = await q<{ sold: string; held: string }>(
    p.analytics,
    `SELECT count(*) FILTER (WHERE state = 'sold') AS sold, count(*) FILTER (WHERE state = 'held') AS held
       FROM seat_status WHERE event_id = $1`,
    [o.eventId],
  );
  const soldSeats = seats.filter((s) => s.state === 'sold').length;
  if (Number(analytics!.sold) !== soldSeats)
    bad.push(`dashboard shows ${analytics!.sold} sold, inventory has ${soldSeats}`);
  if (Number(analytics!.held) !== 0)
    bad.push(`dashboard shows ${analytics!.held} held, there should be none`);
  const openRefundTickets = tickets.filter((t) => t.status === 'refund_requested').length;
  const [openRefunds] = await q<{ n: string }>(
    p.analytics,
    'SELECT count(*) AS n FROM refunds WHERE event_id = $1 AND rank = 1',
    [o.eventId],
  );
  if (Number(openRefunds!.n) !== openRefundTickets)
    bad.push(`dashboard shows ${openRefunds!.n} open refunds, tickets say ${openRefundTickets}`);
  if (seats.length !== o.totalSeats)
    bad.push(`inventory has ${seats.length} seats, expected ${o.totalSeats}`);

  return bad;
}
