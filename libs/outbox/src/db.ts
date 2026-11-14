import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Anything that can run a query: a Pool, a PoolClient, or a transaction handle. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Runs `fn` in one transaction: COMMIT on success, ROLLBACK on any error.
 * Business writes and `outbox.append(tx, ...)` must share the same `tx`.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the original error is the one worth reporting
    }
    throw err;
  } finally {
    client.release();
  }
}
