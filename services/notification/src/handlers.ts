import type { Pool } from 'pg';
import { bookingCode, describeSeats, formatMoney, type EventEnvelope } from '@gatepass/events';
import { processOnce } from '@gatepass/outbox';

export const CONSUMER_GROUP = 'notification';
/** This service only consumes; it publishes nothing. */
export const CONSUMED_TOPICS = ['ticket.issued', 'payment.failed', 'refund.completed'];

export type Logger = (line: string) => void;

interface Draft {
  channel: 'email' | 'sms';
  template: string;
  subject?: string;
  body: string;
}

async function write(
  pool: Pool,
  env: EventEnvelope,
  userId: string,
  bookingId: string,
  drafts: Draft[],
  log: Logger,
): Promise<void> {
  await processOnce(pool, CONSUMER_GROUP, env, async (tx) => {
    for (const d of drafts) {
      const r = await tx.query(
        `INSERT INTO notifications (source_event_id, user_id, booking_id, channel, template, subject, body)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_event_id, channel) DO NOTHING`,
        [env.eventId, userId, bookingId, d.channel, d.template, d.subject ?? null, d.body],
      );
      if (r.rowCount) log(`[notification] ${d.channel} to user ${userId}: ${d.subject ?? d.body}`);
    }
  });
}

/** ticket.issued -> "your tickets are ready" by email and SMS. */
export async function onTicketIssued(
  pool: Pool,
  env: EventEnvelope,
  log: Logger = console.log,
): Promise<void> {
  if (env.payload.case !== 'ticketIssued') return;
  const p = env.payload.value;
  const code = bookingCode(p.bookingId);
  const n = p.tickets.length;
  const noun = n === 1 ? 'ticket' : 'tickets';
  await write(
    pool,
    env,
    p.userId,
    p.bookingId,
    [
      {
        channel: 'email',
        template: 'tickets-ready',
        subject: `Your ${noun} ${n === 1 ? 'is' : 'are'} ready · ${code}`,
        body: `Your booking ${code} is confirmed: ${n} ${noun} (${describeSeats(p.tickets.map((t) => t.seatId))}). Show the QR code at the gate.`,
      },
      {
        channel: 'sms',
        template: 'tickets-ready',
        body: `Gatepass: ${n} ${noun} confirmed for booking ${code}. Open the app for your QR.`,
      },
    ],
    log,
  );
}

/** payment.failed -> "your payment did not go through" by email. */
export async function onPaymentFailed(
  pool: Pool,
  env: EventEnvelope,
  log: Logger = console.log,
): Promise<void> {
  if (env.payload.case !== 'paymentFailed') return;
  const p = env.payload.value;
  if (!p.userId) return; // an event from before user ids were added: nobody to tell
  const code = bookingCode(p.bookingId);
  await write(
    pool,
    env,
    p.userId,
    p.bookingId,
    [
      {
        channel: 'email',
        template: 'payment-failed',
        subject: `Your payment did not go through · ${code}`,
        body: `Payment for booking ${code} failed (${p.reason || 'declined'}). Your seats were released; you can book again.`,
      },
    ],
    log,
  );
}

/** refund.completed -> "your money is on its way back" (a different message for an automatic refund). */
export async function onRefundCompleted(
  pool: Pool,
  env: EventEnvelope,
  log: Logger = console.log,
): Promise<void> {
  if (env.payload.case !== 'refundCompleted') return;
  const p = env.payload.value;
  if (!p.userId) return;
  const code = bookingCode(p.bookingId);
  const amount = formatMoney(p.amountMinor, p.currency);
  await write(
    pool,
    env,
    p.userId,
    p.bookingId,
    [
      p.automatic
        ? {
            channel: 'email',
            template: 'refund-automatic',
            subject: `We refunded ${amount} · ${code}`,
            body: `Your payment of ${amount} for booking ${code} arrived after your seat hold ended, so the seats could not be sold to you. We have refunded all of it.`,
          }
        : {
            channel: 'email',
            template: 'refund-completed',
            subject: `Your refund of ${amount} is on its way · ${code}`,
            body: `Your refund of ${amount} for booking ${code}${p.seatId ? ` (${describeSeats([p.seatId])})` : ''} has been processed.`,
          },
    ],
    log,
  );
}

export function notificationHandler(pool: Pool, log: Logger = console.log) {
  return async (env: EventEnvelope): Promise<void> => {
    if (env.eventType === 'ticket.issued') return onTicketIssued(pool, env, log);
    if (env.eventType === 'payment.failed') return onPaymentFailed(pool, env, log);
    if (env.eventType === 'refund.completed') return onRefundCompleted(pool, env, log);
  };
}
