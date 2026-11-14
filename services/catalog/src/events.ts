import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { buildEnvelope } from '@gatepass/events';
import { appendToOutbox, withTransaction } from '@gatepass/outbox';
import { summarizeTiers, type SeatSpec } from './seat-map';

export const PRODUCER = 'catalog';

export interface CreateEventInput {
  /** Stable slug (the design uses "neon-nights"); generated if omitted. */
  id?: string;
  organizerId: string;
  title: string;
  category: string;
  venue: string;
  startsAt: Date;
  currency?: string;
  seats: SeatSpec[];
}

export interface EventSummary {
  id: string;
  title: string;
  category: string;
  venue: string;
  startsAt: string; // ISO
  currency: string;
  minPriceMinor: number;
  tiers: { name: string; priceMinor: number; seatCount: number }[];
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

/**
 * Creates an event and its seat map and publishes `event.published`, atomically: the rows and
 * the outbox event are one transaction.
 */
export async function createEvent(pool: Pool, input: CreateEventInput): Promise<string> {
  if (!input.title.trim()) throw new ValidationError('title is required');
  if (input.seats.length === 0) throw new ValidationError('an event needs at least one seat');
  const tiers = summarizeTiers(input.seats);
  const id = input.id ?? uuidv7();
  const currency = input.currency ?? 'INR';

  try {
    await withTransaction(pool, async (tx) => {
      await tx.query(
        `INSERT INTO events (id, organizer_id, title, category, venue, starts_at, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, input.organizerId, input.title, input.category, input.venue, input.startsAt, currency],
      );
      for (const [i, t] of tiers.entries()) {
        await tx.query(
          'INSERT INTO event_tiers (event_id, name, price_minor, seat_count, position) VALUES ($1,$2,$3,$4,$5)',
          [id, t.name, t.priceMinor, t.seatCount, i],
        );
      }
      await tx.query(
        `INSERT INTO seat_defs (event_id, seat_id, row_label, number, tier, price_minor)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::bigint[])`,
        [
          id,
          input.seats.map((s) => s.seatId),
          input.seats.map((s) => s.row),
          input.seats.map((s) => s.number),
          input.seats.map((s) => s.tier),
          input.seats.map((s) => s.priceMinor),
        ],
      );
      await appendToOutbox(
        tx,
        buildEnvelope({
          eventType: 'event.published',
          correlationId: id,
          producer: PRODUCER,
          payload: {
            eventId: id,
            organizerId: input.organizerId,
            title: input.title,
            category: input.category,
            venue: input.venue,
            startsAtMs: BigInt(input.startsAt.getTime()),
            currency,
            tiers: tiers.map((t) => ({
              name: t.name,
              priceMinor: BigInt(t.priceMinor),
              seatCount: t.seatCount,
            })),
            seats: input.seats.map((s) => ({
              seatId: s.seatId,
              row: s.row,
              number: s.number,
              tier: s.tier,
              priceMinor: BigInt(s.priceMinor),
            })),
          },
        }),
        id,
      );
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new ConflictError(`event ${id} exists`);
    throw err;
  }
  return id;
}

interface EventRow {
  id: string;
  title: string;
  category: string;
  venue: string;
  starts_at: Date;
  currency: string;
}

async function withTiers(pool: Pool, rows: EventRow[]): Promise<EventSummary[]> {
  if (rows.length === 0) return [];
  const tiers = await pool.query<{
    event_id: string;
    name: string;
    price_minor: string;
    seat_count: number;
  }>(
    'SELECT event_id, name, price_minor, seat_count FROM event_tiers WHERE event_id = ANY($1) ORDER BY event_id, position',
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => {
    const mine = tiers.rows
      .filter((t) => t.event_id === r.id)
      .map((t) => ({
        name: t.name,
        priceMinor: Number(t.price_minor),
        seatCount: t.seat_count,
      }));
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      venue: r.venue,
      startsAt: r.starts_at.toISOString(),
      currency: r.currency,
      minPriceMinor: mine.length ? Math.min(...mine.map((t) => t.priceMinor)) : 0,
      tiers: mine,
    };
  });
}

export async function listEvents(pool: Pool): Promise<EventSummary[]> {
  const { rows } = await pool.query<EventRow>(
    'SELECT id, title, category, venue, starts_at, currency FROM events ORDER BY starts_at, id',
  );
  return withTiers(pool, rows);
}

export async function getEvent(pool: Pool, id: string): Promise<EventSummary> {
  const { rows } = await pool.query<EventRow>(
    'SELECT id, title, category, venue, starts_at, currency FROM events WHERE id = $1',
    [id],
  );
  if (rows.length === 0) throw new NotFoundError(`event ${id} not found`);
  return (await withTiers(pool, rows))[0]!;
}
