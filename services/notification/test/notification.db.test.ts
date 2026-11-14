import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate } from '@gatepass/db';
import { bookingCode, buildEnvelope } from '@gatepass/events';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import { onPaymentFailed, onTicketIssued } from '../src';

jest.setTimeout(120_000);

let server: TestPostgres;
let db: TestDatabase;
let pool: Pool;
const lines: string[] = [];
const log = (l: string) => lines.push(l);

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase();
  pool = db.pool;
  await migrate(pool, join(__dirname, '..', 'migrations'));
});
afterAll(async () => {
  await db.close();
  await server.stop();
});
beforeEach(async () => {
  await pool.query('TRUNCATE notifications, inbox, outbox RESTART IDENTITY');
  lines.length = 0;
});

const issued = (bookingId: string, seatIds: string[], userId = 'alice') =>
  buildEnvelope({
    eventType: 'ticket.issued',
    correlationId: bookingId,
    producer: 'ticket',
    payload: {
      bookingId,
      eventId: 'show',
      userId,
      tickets: seatIds.map((s) => ({
        ticketId: `t-${s}`,
        seatId: s,
        tier: 'Mid',
        qrToken: 'GP1.x.y',
      })),
    },
  });

const failed = (bookingId: string, userId = 'alice') =>
  buildEnvelope({
    eventType: 'payment.failed',
    correlationId: bookingId,
    producer: 'payment',
    payload: { bookingId, paymentId: 'p1', reason: 'insufficient_funds', eventId: 'show', userId },
  });

const rows = async () => (await pool.query('SELECT * FROM notifications ORDER BY id')).rows;

describe('ticket.issued', () => {
  it('logs one email and one SMS for the right user, never the QR token', async () => {
    await onTicketIssued(pool, issued('bk-1', ['C6', 'C7']), log);
    const r = await rows();
    expect(r.map((x) => [x.channel, x.user_id, x.template, x.status])).toEqual([
      ['email', 'alice', 'tickets-ready', 'logged'],
      ['sms', 'alice', 'tickets-ready', 'logged'],
    ]);
    expect(r[0].subject).toBe(`Your tickets are ready · ${bookingCode('bk-1')}`);
    expect(r[0].body).toContain('2 tickets (Row C · seats 6, 7)');
    expect(r[1].subject).toBeNull();
    expect(r[1].body).toContain('2 tickets confirmed');
    expect(JSON.stringify(r)).not.toContain('GP1.');
    expect(lines).toHaveLength(2);
  });

  it('uses the singular for one ticket', async () => {
    await onTicketIssued(pool, issued('bk-2', ['A1']), log);
    const [email] = await rows();
    expect(email.subject).toContain('Your ticket is ready');
    expect(email.body).toContain('1 ticket (Row A · seat 1)');
  });

  it('is idempotent: the same event twice, or a re-sent event, never notifies twice', async () => {
    const ev = issued('bk-3', ['B1']);
    await onTicketIssued(pool, ev, log);
    await onTicketIssued(pool, ev, log);
    expect(await rows()).toHaveLength(2);
    expect(lines).toHaveLength(2);
  });
});

describe('payment.failed', () => {
  it('logs one email saying the seats were released', async () => {
    await onPaymentFailed(pool, failed('bk-4'), log);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ channel: 'email', user_id: 'alice', template: 'payment-failed' });
    expect(r[0].body).toContain('insufficient_funds');
    expect(r[0].body).toContain('seats were released');
  });

  it('is idempotent', async () => {
    const ev = failed('bk-5');
    await onPaymentFailed(pool, ev, log);
    await onPaymentFailed(pool, ev, log);
    expect(await rows()).toHaveLength(1);
  });

  it('skips an event that names no user (nobody to tell) without failing', async () => {
    await expect(onPaymentFailed(pool, failed('bk-6', ''), log)).resolves.toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });
});

describe('other events', () => {
  it('ignores events it does not handle', async () => {
    const other = buildEnvelope({
      eventType: 'seats.sold',
      correlationId: 'bk-7',
      producer: 'seat-inventory',
      payload: { bookingId: 'bk-7', eventId: 'show', seatIds: ['A1'] },
    });
    await onTicketIssued(pool, other, log);
    await onPaymentFailed(pool, other, log);
    expect(await rows()).toHaveLength(0);
  });
});
