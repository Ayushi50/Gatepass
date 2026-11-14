import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { applyOutboxMigrations, withTransaction } from '@gatepass/outbox';

export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({ connectionString, max });
}

/**
 * Applies the outbox/inbox tables, then every `*.sql` file in `dir` (sorted by name) that has
 * not been applied yet. Each file runs in its own transaction and is recorded in
 * `schema_migrations`. Safe to call on every boot, and from several replicas at once.
 */
export async function migrate(pool: Pool, dir: string): Promise<string[]> {
  await applyOutboxMigrations(pool);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    await withTransaction(pool, async (tx) => {
      // serialize concurrent migrators; released at commit
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gatepass-migrate']);
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) return;
      await tx.query(readFileSync(join(dir, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    });
  }
  return applied;
}

/** Reads a required environment variable or throws with a clear message. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}
