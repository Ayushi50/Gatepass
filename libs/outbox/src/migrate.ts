import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from './db';

/** Creates the outbox and inbox tables if they do not exist. Safe to call on every boot. */
export async function applyOutboxMigrations(db: Queryable): Promise<void> {
  const sql = readFileSync(join(__dirname, '..', 'migrations', '001_outbox_inbox.sql'), 'utf8');
  await db.query(sql);
}
