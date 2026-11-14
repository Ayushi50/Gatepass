import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestPostgres, type TestDatabase, type TestPostgres } from '@gatepass/testing';
import { migrate, requireEnv } from '../src';

jest.setTimeout(120_000);

let server: TestPostgres;
let db: TestDatabase;

beforeAll(async () => {
  server = await startTestPostgres();
  db = await server.createDatabase();
});
afterAll(async () => {
  await db.close();
  await server.stop();
});

const dirWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};

describe('migrate', () => {
  it('applies outbox tables and service migrations once, in order', async () => {
    const dir = dirWith({
      '002_b.sql': 'ALTER TABLE t ADD COLUMN b INT',
      '001_a.sql': 'CREATE TABLE t (a INT)',
    });
    expect(await migrate(db.pool, dir)).toEqual(['001_a.sql', '002_b.sql']);
    expect(await migrate(db.pool, dir)).toEqual([]);
    const cols = await db.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='t' ORDER BY 1",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(['a', 'b']);
    await db.pool.query('SELECT 1 FROM outbox');
    await db.pool.query('SELECT 1 FROM inbox');
  });

  it('rolls a failing migration back and does not record it', async () => {
    const dir = dirWith({ '010_bad.sql': 'CREATE TABLE ok (x INT); SELECT * FROM nope;' });
    await expect(migrate(db.pool, dir)).rejects.toThrow();
    const exists = await db.pool.query("SELECT to_regclass('ok') AS r");
    expect(exists.rows[0].r).toBeNull();
  });

  it('is safe to run concurrently', async () => {
    const dir = dirWith({ '020_c.sql': 'CREATE TABLE conc (x INT)' });
    await Promise.all([migrate(db.pool, dir), migrate(db.pool, dir), migrate(db.pool, dir)]);
    await db.pool.query('SELECT 1 FROM conc');
  });
});

describe('requireEnv', () => {
  it('returns the value or throws', () => {
    expect(requireEnv('X', { X: 'v' })).toBe('v');
    expect(() => requireEnv('X', {})).toThrow(/X/);
  });
});
