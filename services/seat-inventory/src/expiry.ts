import type { Pool } from 'pg';
import { buildEnvelope } from '@gatepass/events';
import { appendToOutbox, withTransaction } from '@gatepass/outbox';
import { metrics } from '@gatepass/telemetry';

const PRODUCER = 'seat-inventory';

export interface SweepOptions {
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /**
   * Extra time after `hold_expires_at` before a hold is actually released. The buyer still sees
   * the original expiry; this only absorbs a payment that was already in flight when it passed.
   */
  graceMs?: number;
  /** Max bookings released per sweep. */
  limit?: number;
}

export const DEFAULT_GRACE_MS = 60_000;

/**
 * Releases holds that have expired, and tells everyone. Returns how many bookings were released.
 *
 * Per booking, in ONE transaction: lock its held seats (in a fixed order, so it cannot deadlock
 * with a concurrent sale), return the still-expired ones to sale, and write `hold.expired` and
 * `seats.released` (reason `hold_expired`) to the outbox.
 *
 * Safe to run on several instances and to race with a payment: both sides lock the same rows
 * and re-check `state = 'held'` after the lock, so exactly one wins. If the sale committed first
 * the seats are `sold` and this finds nothing; if this committed first the sale finds the seats
 * released and reports `seats.sale_failed` (which makes payment refund the buyer).
 */
export async function sweepExpiredHolds(pool: Pool, opts: SweepOptions = {}): Promise<number> {
  const cutoff = new Date((opts.now ?? Date.now)() - (opts.graceMs ?? DEFAULT_GRACE_MS));
  const candidates = await pool.query<{ booking_id: string }>(
    `SELECT DISTINCT booking_id FROM seats
      WHERE state = 'held' AND hold_expires_at <= $1
      ORDER BY booking_id LIMIT $2`,
    [cutoff, opts.limit ?? 100],
  );

  let released = 0;
  for (const { booking_id: bookingId } of candidates.rows) {
    const did = await withTransaction(pool, async (tx) => {
      const locked = await tx.query<{ event_id: string; seat_id: string }>(
        `SELECT event_id, seat_id FROM seats
          WHERE booking_id = $1 AND state = 'held' AND hold_expires_at <= $2
          ORDER BY seat_id FOR UPDATE`,
        [bookingId, cutoff],
      );
      if (locked.rowCount === 0) return false; // a payment or another sweeper got there first
      const eventId = locked.rows[0]!.event_id;
      const seatIds = locked.rows.map((r) => r.seat_id);

      await tx.query(
        `UPDATE seats
            SET state = 'available', booking_id = NULL, hold_expires_at = NULL,
                version = version + 1, updated_at = now()
          WHERE event_id = $1 AND seat_id = ANY($2) AND booking_id = $3 AND state = 'held'`,
        [eventId, seatIds, bookingId],
      );

      const expired = buildEnvelope({
        eventType: 'hold.expired',
        correlationId: bookingId,
        producer: PRODUCER,
        payload: { bookingId, eventId, seatIds },
      });
      await appendToOutbox(tx, expired, eventId);
      await appendToOutbox(
        tx,
        buildEnvelope({
          eventType: 'seats.released',
          correlationId: bookingId,
          causationId: expired.eventId,
          producer: PRODUCER,
          payload: { bookingId, eventId, seatIds, reason: 'hold_expired' },
        }),
        eventId,
      );
      return true;
    });
    if (did) {
      released++;
      metrics.holdsExpired().inc(); // after the commit
    }
  }
  return released;
}

/** Runs the sweep on an interval. A failed sweep is reported and retried on the next tick. */
export class HoldSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly opts: SweepOptions & {
      intervalMs?: number;
      onError?: (e: unknown) => void;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await sweepExpiredHolds(this.pool, this.opts);
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), this.opts.intervalMs ?? 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
