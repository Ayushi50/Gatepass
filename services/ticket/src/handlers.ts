import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { buildEnvelope, ticketCode, type EventEnvelope } from '@gatepass/events';
import { appendToOutbox, processOnce } from '@gatepass/outbox';
import type { QrKeyRing } from './qr-token';

export const PRODUCER = 'ticket';
export const CONSUMER_GROUP = 'ticket';
export const CONSUMED_TOPICS = ['event.published', 'booking.confirmed'];

/** event.published -> remember what a ticket for this show must say. */
export async function onEventPublished(pool: Pool, env: EventEnvelope): Promise<void> {
  if (env.payload.case !== 'eventPublished') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    await tx.query(
      `INSERT INTO events (event_id, title, venue, starts_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (event_id) DO NOTHING`,
      [p.eventId, p.title, p.venue, new Date(Number(p.startsAtMs))],
    );
    await tx.query(
      `INSERT INTO event_seats (event_id, seat_id, row_label, number, tier)
       SELECT $1, u.a, u.b, u.c, u.d
         FROM unnest($2::text[], $3::text[], $4::int[], $5::text[]) AS u(a, b, c, d)
       ON CONFLICT (event_id, seat_id) DO NOTHING`,
      [
        p.eventId,
        p.seats.map((s) => s.seatId),
        p.seats.map((s) => s.row),
        p.seats.map((s) => s.number),
        p.seats.map((s) => s.tier),
      ],
    );
  });
}

/**
 * booking.confirmed -> one ticket per seat, and ticket.issued, in one transaction.
 * If this service has not yet seen the show or a seat, it throws: the message is retried and
 * then dead-lettered, never issued with guessed details.
 */
export async function onBookingConfirmed(
  pool: Pool,
  keys: QrKeyRing,
  env: EventEnvelope,
): Promise<void> {
  if (env.payload.case !== 'bookingConfirmed') return;
  const p = env.payload.value;
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    const seats = await tx.query<{
      seat_id: string;
      row_label: string;
      number: number;
      tier: string;
    }>(
      `SELECT seat_id, row_label, number, tier FROM event_seats
        WHERE event_id = $1 AND seat_id = ANY($2) ORDER BY seat_id`,
      [p.eventId, p.seatIds],
    );
    if (seats.rowCount !== p.seatIds.length) {
      throw new Error(`cannot issue tickets for booking ${p.bookingId}: unknown event or seat`);
    }

    const issued: { ticketId: string; seatId: string; tier: string }[] = [];
    for (const s of seats.rows) {
      const id = uuidv7();
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO tickets (id, code, booking_id, event_id, user_id, seat_id, row_label, number, tier)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (booking_id, seat_id) DO UPDATE SET booking_id = tickets.booking_id
         RETURNING id`,
        [
          id,
          ticketCode(p.bookingId, s.seat_id),
          p.bookingId,
          p.eventId,
          p.userId,
          s.seat_id,
          s.row_label,
          s.number,
          s.tier,
        ],
      );
      issued.push({ ticketId: inserted.rows[0]!.id, seatId: s.seat_id, tier: s.tier });
    }

    await appendToOutbox(
      tx,
      buildEnvelope({
        eventType: 'ticket.issued',
        correlationId: env.correlationId,
        causationId: env.eventId,
        producer: PRODUCER,
        payload: {
          bookingId: p.bookingId,
          eventId: p.eventId,
          userId: p.userId,
          tickets: issued.map((t) => ({
            ticketId: t.ticketId,
            seatId: t.seatId,
            tier: t.tier,
            qrToken: keys.sign(t.ticketId, p.eventId),
          })),
        },
      }),
      p.bookingId,
    );
  });
}

export function ticketHandler(pool: Pool, keys: QrKeyRing) {
  return async (env: EventEnvelope): Promise<void> => {
    if (env.eventType === 'event.published') return onEventPublished(pool, env);
    if (env.eventType === 'booking.confirmed') return onBookingConfirmed(pool, keys, env);
  };
}
