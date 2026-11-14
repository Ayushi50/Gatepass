import { createPool, migrate, requireEnv } from '@gatepass/db';
import { join } from 'node:path';
import { ConflictError, createEvent } from './events';
import { DEMO_EVENTS } from './demo-events';

/** Idempotent: publishes the five demo events (skips ones that already exist). */
async function main(): Promise<void> {
  const pool = createPool(requireEnv('DATABASE_URL'));
  try {
    await migrate(pool, join(__dirname, '..', 'migrations'));
    for (const e of DEMO_EVENTS) {
      try {
        await createEvent(pool, e);
        console.log(`published ${e.id}`);
      } catch (err) {
        if (err instanceof ConflictError) console.log(`exists    ${e.id}`);
        else throw err;
      }
    }
  } finally {
    await pool.end();
  }
}

void main();
