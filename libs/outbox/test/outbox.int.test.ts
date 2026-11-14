import type { Pool } from 'pg';
import { buildEnvelope } from '@gatepass/events';
import { createTestDatabase, type TestDatabase } from '@gatepass/testing';
import {
  OutboxRelay,
  appendToOutbox,
  applyOutboxMigrations,
  processOnce,
  withTransaction,
  type EventPublisher,
  type OutboundMessage,
} from '../src';

jest.setTimeout(180_000);

let db: TestDatabase;
let pool: Pool;

const heldEvent = (bookingId = 'b-1') =>
  buildEnvelope({
    eventType: 'seats.held',
    payload: { bookingId, eventId: 'e-1', seatIds: ['A1'], holdExpiresAtMs: 1n },
    correlationId: bookingId,
    producer: 'seat-inventory',
  });

class RecordingPublisher implements EventPublisher {
  sent: OutboundMessage[] = [];
  down = false;
  async publishBatch(messages: OutboundMessage[]): Promise<void> {
    if (this.down) throw new Error('broker unavailable');
    this.sent.push(...messages);
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await applyOutboxMigrations(pool);
  await pool.query('CREATE TABLE orders (id TEXT PRIMARY KEY)');
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await pool.query('TRUNCATE outbox, inbox, orders RESTART IDENTITY');
});

describe('migrations', () => {
  it('can be applied twice', async () => {
    await expect(applyOutboxMigrations(pool)).resolves.toBeUndefined();
  });
});

describe('outbox write', () => {
  it('commits the business row and the event together', async () => {
    await withTransaction(pool, async (tx) => {
      await tx.query('INSERT INTO orders (id) VALUES ($1)', ['b-1']);
      await appendToOutbox(tx, heldEvent(), 'b-1');
    });
    expect((await pool.query('SELECT * FROM orders')).rowCount).toBe(1);
    const { rows } = await pool.query('SELECT event_type, aggregate_id, published_at FROM outbox');
    expect(rows).toEqual([{ event_type: 'seats.held', aggregate_id: 'b-1', published_at: null }]);
  });

  it('rolls back the business row and the event together', async () => {
    await expect(
      withTransaction(pool, async (tx) => {
        await tx.query('INSERT INTO orders (id) VALUES ($1)', ['b-2']);
        await appendToOutbox(tx, heldEvent('b-2'), 'b-2');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await pool.query('SELECT * FROM orders')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM outbox')).rowCount).toBe(0);
  });

  it('rejects the same eventId twice', async () => {
    const ev = heldEvent();
    await appendToOutbox(pool, ev, 'b-1');
    await expect(appendToOutbox(pool, ev, 'b-1')).rejects.toThrow(/duplicate key/);
  });
});

describe('outbox relay', () => {
  it('publishes pending events in order and marks them published', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay({ pool, publisher });
    const events = [heldEvent('b-1'), heldEvent('b-2'), heldEvent('b-3')];
    for (const ev of events) await appendToOutbox(pool, ev, ev.correlationId);

    expect(await relay.pollOnce()).toBe(3);
    expect(publisher.sent.map((m) => m.headers.eventId)).toEqual(events.map((e) => e.eventId));
    expect(publisher.sent[0]).toMatchObject({ topic: 'seats.held', key: 'b-1' });
    expect(await relay.pollOnce()).toBe(0);
    const pending = await pool.query('SELECT 1 FROM outbox WHERE published_at IS NULL');
    expect(pending.rowCount).toBe(0);
  });

  it('loses nothing across a broker outage', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay({ pool, publisher });
    const events = [heldEvent('b-1'), heldEvent('b-2')];
    for (const ev of events) await appendToOutbox(pool, ev, ev.correlationId);

    publisher.down = true;
    await expect(relay.pollOnce()).rejects.toThrow('broker unavailable');
    const stuck = await pool.query(
      'SELECT attempts, last_error, published_at FROM outbox ORDER BY id',
    );
    expect(stuck.rows.every((r) => r.published_at === null && r.attempts === 1)).toBe(true);
    expect(stuck.rows[0].last_error).toMatch(/broker unavailable/);

    publisher.down = false;
    expect(await relay.pollOnce()).toBe(2);
    expect(publisher.sent.map((m) => m.headers.eventId)).toEqual(events.map((e) => e.eventId));
  });

  it('only one relay is active at a time (no reordering)', async () => {
    const gate: { release?: () => void } = {};
    const slow: EventPublisher = {
      publishBatch: () => new Promise<void>((resolve) => (gate.release = resolve)),
    };
    const fast = new RecordingPublisher();
    await appendToOutbox(pool, heldEvent(), 'b-1');

    const first = new OutboxRelay({ pool, publisher: slow }).pollOnce();
    await new Promise((r) => setTimeout(r, 300)); // first relay now holds the lock, mid-publish
    expect(await new OutboxRelay({ pool, publisher: fast }).pollOnce()).toBe(0);
    gate.release?.();
    expect(await first).toBe(1);
    expect(fast.sent).toHaveLength(0);
  });

  it('start/stop drains events in the background', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay({ pool, publisher, pollIntervalMs: 20 });
    relay.start();
    await appendToOutbox(pool, heldEvent('b-9'), 'b-9');
    await waitFor(() => publisher.sent.length === 1);
    await relay.stop();
    expect(publisher.sent).toHaveLength(1);
  });
});

describe('inbox (idempotent consumer)', () => {
  it('runs the handler once for duplicate deliveries', async () => {
    const ev = heldEvent();
    let calls = 0;
    const handler = async () => {
      calls++;
    };
    expect(await processOnce(pool, 'booking', ev, handler)).toBe('processed');
    expect(await processOnce(pool, 'booking', ev, handler)).toBe('duplicate');
    expect(calls).toBe(1);
  });

  it('handles the same event once per consumer, not once globally', async () => {
    const ev = heldEvent();
    expect(await processOnce(pool, 'booking', ev, async () => {})).toBe('processed');
    expect(await processOnce(pool, 'analytics', ev, async () => {})).toBe('processed');
  });

  it('does not run the handler twice under concurrent duplicates', async () => {
    const ev = heldEvent();
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        processOnce(pool, 'booking', ev, async () => {
          calls++;
        }),
      ),
    );
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('rolls the inbox row back when the handler fails, so a retry succeeds', async () => {
    const ev = heldEvent();
    await expect(
      processOnce(pool, 'booking', ev, async (tx) => {
        await tx.query('INSERT INTO orders (id) VALUES ($1)', ['b-1']);
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect((await pool.query('SELECT * FROM orders')).rowCount).toBe(0);
    expect(await processOnce(pool, 'booking', ev, async () => {})).toBe('processed');
  });

  it('commits handler writes and outgoing events atomically', async () => {
    const ev = heldEvent();
    await processOnce(pool, 'booking', ev, async (tx) => {
      await tx.query('INSERT INTO orders (id) VALUES ($1)', ['b-1']);
      await appendToOutbox(
        tx,
        buildEnvelope({
          eventType: 'booking.cancelled',
          payload: { bookingId: 'b-1', eventId: 'e-1', reason: 'hold_failed' },
          correlationId: 'b-1',
          causationId: ev.eventId,
          producer: 'booking',
        }),
        'b-1',
      );
    });
    const out = await pool.query('SELECT event_type, causation_id FROM outbox');
    expect(out.rows).toEqual([{ event_type: 'booking.cancelled', causation_id: ev.eventId }]);
  });
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}
