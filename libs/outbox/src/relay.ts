import type { Pool } from 'pg';
import { collectedGauge, inSpan } from '@gatepass/telemetry';

export interface OutboundMessage {
  topic: string;
  key: string;
  value: Uint8Array;
  headers: Record<string, string>;
}

/** The relay's only dependency on the broker. The Kafka implementation lives in libs/messaging. */
export interface EventPublisher {
  /** Publishes in order. Resolves only when the broker has acknowledged every message. */
  publishBatch(messages: OutboundMessage[]): Promise<void>;
}

export interface RelayOptions {
  pool: Pool;
  publisher: EventPublisher;
  /** Rows per poll. Default 100. */
  batchSize?: number;
  /** Idle sleep between polls in ms. Default 200. */
  pollIntervalMs?: number;
  /** Sleep after a failed publish in ms. Default 1000. */
  errorBackoffMs?: number;
  /** Identifies this service's relay for the advisory lock. Default "outbox-relay". */
  lockName?: string;
  onError?: (err: unknown) => void;
}

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  correlation_id: string;
  payload: Buffer;
  headers: Record<string, string>;
  event_id: string;
}

/**
 * Publishes pending outbox rows to the broker, in id order, at-least-once.
 *
 * A transaction-level advisory lock makes exactly one relay active per database at a time
 * (extra replicas simply idle), which preserves ordering. Rows are marked published only
 * after the broker acknowledges them; if the broker is down the rows stay pending and are
 * retried, so no event is lost. A crash between "acked" and "marked" re-sends a batch, which
 * is why consumers must be idempotent (inbox).
 */
/** Pools whose unsent events the `gatepass_outbox_pending` gauge reports on, by relay name. */
const watched = new Map<string, Pool>();
let gaugeReady = false;
function watchOutbox(name: string, pool: Pool): void {
  watched.set(name, pool);
  if (gaugeReady) return;
  gaugeReady = true;
  collectedGauge(
    'gatepass_outbox_pending',
    'Events written but not yet published (a growing number means a stuck relay).',
    ['relay'],
    async (g) => {
      g.reset();
      for (const [relay, p] of watched) {
        const { rows } = await p.query<{ n: string }>(
          'SELECT count(*) AS n FROM outbox WHERE published_at IS NULL',
        );
        g.set({ relay }, Number(rows[0]!.n));
      }
    },
  );
}

export class OutboxRelay {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly opts: RelayOptions) {
    watchOutbox(opts.lockName ?? 'outbox-relay', opts.pool);
  }

  /** Processes one batch. Returns the number of events published (0 if idle or not the leader). */
  async pollOnce(): Promise<number> {
    const { pool, publisher } = this.opts;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        [this.opts.lockName ?? 'outbox-relay'],
      );
      if (!lock.rows[0]?.locked) {
        await client.query('ROLLBACK');
        return 0;
      }

      const { rows } = await client.query<OutboxRow>(
        `SELECT id, event_id, event_type, aggregate_id, correlation_id, payload, headers
           FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1`,
        [this.opts.batchSize ?? 100],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return 0;
      }

      try {
        await inSpan('outbox.publish', { attributes: { 'gatepass.batch_size': rows.length } }, () =>
          publisher.publishBatch(
            rows.map((r) => ({
              topic: r.event_type,
              key: r.aggregate_id,
              value: r.payload,
              headers: {
                ...r.headers,
                eventId: r.event_id,
                eventType: r.event_type,
                correlationId: r.correlation_id,
              },
            })),
          ),
        );
      } catch (err) {
        await client.query('ROLLBACK');
        await this.recordFailure(
          rows.map((r) => r.id),
          err,
        );
        throw err;
      }

      await client.query(
        'UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1::bigint[])',
        [rows.map((r) => r.id)],
      );
      await client.query('COMMIT');
      return rows.length;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async recordFailure(ids: string[], err: unknown): Promise<void> {
    try {
      await this.opts.pool.query(
        'UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])',
        [ids, String((err as Error)?.message ?? err).slice(0, 500)],
      );
    } catch {
      // bookkeeping only; the rows stay pending either way
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const idle = this.opts.pollIntervalMs ?? 200;
    const onError = this.opts.errorBackoffMs ?? 1000;
    while (this.running) {
      let delay = idle;
      try {
        const sent = await this.pollOnce();
        if (sent === (this.opts.batchSize ?? 100)) delay = 0; // more waiting, keep draining
      } catch (err) {
        this.opts.onError?.(err);
        delay = onError;
      }
      if (delay > 0 && this.running) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}
