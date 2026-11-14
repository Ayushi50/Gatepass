import type { Pool, PoolClient } from 'pg';
import { metrics } from '@gatepass/telemetry';
import { withTransaction } from './db';

export type InboxResult = 'processed' | 'duplicate';

/**
 * Idempotent-consumer guard. In ONE transaction: record (consumer, eventId) in the inbox,
 * then run the handler. A duplicate delivery inserts nothing, so the handler is skipped.
 * If the handler throws, the inbox row rolls back too, so a retry is processed normally.
 *
 * Handlers should write their own data and any outgoing events (appendToOutbox) through
 * the `tx` they are given, so everything commits atomically.
 */
export async function processOnce(
  pool: Pool,
  consumer: string,
  event: { eventId: string; eventType: string },
  handler: (tx: PoolClient) => Promise<void>,
): Promise<InboxResult> {
  return withTransaction(pool, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO inbox (consumer, event_id, event_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (consumer, event_id) DO NOTHING`,
      [consumer, event.eventId, event.eventType],
    );
    if (inserted.rowCount === 0) {
      metrics.duplicatesIgnored().inc({ consumer });
      return 'duplicate' as const;
    }
    await handler(tx);
    return 'processed' as const;
  });
}
