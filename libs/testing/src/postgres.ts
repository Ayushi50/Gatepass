import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';

export interface TestDatabase {
  pool: Pool;
  connectionString: string;
  close(): Promise<void>;
}

export interface TestPostgres {
  /** Creates an empty, uniquely named database on this server. */
  createDatabase(poolSize?: number): Promise<TestDatabase>;
  stop(): Promise<void>;
}

const PASSWORD = 'test';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a real Postgres server in-process (no Docker) for tests, in a temp directory on a free
 * port. Start it once per test file in `beforeAll`, create one database per suite, `stop()` after.
 */
export async function startTestPostgres(): Promise<TestPostgres> {
  const dir = mkdtempSync(join(tmpdir(), 'gatepass-pg-'));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [join(__dirname, '..', 'scripts', 'pg-server.mjs'), dir, String(port), PASSWORD],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += String(d)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`postgres start timeout: ${stderr}`)), 60_000);
    child.stdout?.on('data', (d) => {
      if (String(d).includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`postgres exited (${code}): ${stderr}`));
    });
  });

  const adminUrl = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });

  return {
    async createDatabase(poolSize = 10) {
      const name = `gp_${randomBytes(6).toString('hex')}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const connectionString = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/${name}`;
      const pool = new Pool({ connectionString, max: poolSize });
      return {
        pool,
        connectionString,
        close: async () => {
          await pool.end();
        },
      };
    },
    async stop() {
      await admin.end();
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
