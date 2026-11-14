import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface TestDatabase {
  pool: Pool;
  connectionString: string;
  close(): Promise<void>;
}

/**
 * A throwaway Postgres database for integration tests.
 *
 * Default: starts a Postgres container with Testcontainers (needs Docker).
 * If TEST_DATABASE_URL is set (an admin connection to an existing server), it creates and drops
 * a uniquely named database on that server instead, so tests can run without Docker.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (adminUrl) return createOnExistingServer(adminUrl);

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  return {
    pool,
    connectionString: container.getConnectionUri(),
    close: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

async function createOnExistingServer(adminUrl: string): Promise<TestDatabase> {
  const name = `gp_test_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  return {
    pool,
    connectionString: url.toString(),
    close: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
