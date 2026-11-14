import {
  parseReplayArgs,
  replayRecords,
  toReplayMessage,
  type DlqRecord,
  type ReplayMessage,
} from '../src';

const record = (
  over: Partial<DlqRecord> = {},
  headers: Record<string, string> = {},
): DlqRecord => ({
  topic: 'booking.dlq',
  partition: 0,
  offset: '7',
  key: 'b-1',
  value: new Uint8Array([1, 2, 3]),
  headers: {
    eventId: 'evt-1',
    eventType: 'seats.held',
    'x-dlq-original-topic': 'seats.held',
    'x-dlq-original-partition': '2',
    'x-dlq-original-offset': '41',
    'x-dlq-consumer': 'booking',
    'x-dlq-attempts': '5',
    'x-dlq-error': 'boom',
    ...headers,
  },
  ...over,
});

describe('toReplayMessage', () => {
  it('goes back to the original topic with the original bytes and key, minus the dlq bookkeeping', () => {
    const out = toReplayMessage(record());
    expect(out).toEqual({
      ok: true,
      message: {
        topic: 'seats.held',
        key: 'b-1',
        value: new Uint8Array([1, 2, 3]),
        headers: {
          eventId: 'evt-1',
          eventType: 'seats.held',
          'x-replayed-from': 'booking.dlq',
          'x-replayed-offset': '0:7',
        },
      },
    });
  });

  it('refuses a record it cannot place', () => {
    expect(toReplayMessage(record({ headers: { eventId: 'e' } }))).toEqual({
      ok: false,
      reason: 'no_original_topic',
    });
    expect(toReplayMessage(record({ value: null }))).toEqual({ ok: false, reason: 'no_value' });
  });
});

describe('replayRecords', () => {
  const collect = () => {
    const sent: ReplayMessage[] = [];
    return { sent, publish: async (m: ReplayMessage) => void sent.push(m) };
  };
  const three = [
    record({ offset: '1' }, { eventId: 'a' }),
    record({ offset: '2' }, { eventId: 'b' }),
    record({ offset: '3' }, { eventId: 'c' }),
  ];

  it('replays everything in DLQ order', async () => {
    const c = collect();
    const report = await replayRecords(three, c.publish);
    expect(c.sent.map((m) => m.headers.eventId)).toEqual(['a', 'b', 'c']);
    expect(report.skipped).toEqual([]);
  });

  it('can target one event id', async () => {
    const c = collect();
    const report = await replayRecords(three, c.publish, { eventId: 'b' });
    expect(c.sent.map((m) => m.headers.eventId)).toEqual(['b']);
    expect(report.skipped.map((s) => s.reason)).toEqual(['filtered', 'filtered']);
  });

  it('stops at the limit', async () => {
    const c = collect();
    const report = await replayRecords(three, c.publish, { limit: 2 });
    expect(c.sent).toHaveLength(2);
    expect(report.skipped).toEqual([{ record: three[2], reason: 'limit' }]);
  });

  it('a dry run reports what it would do and publishes nothing', async () => {
    const c = collect();
    const report = await replayRecords(three, c.publish, { dryRun: true });
    expect(c.sent).toEqual([]);
    expect(report.replayed).toHaveLength(3);
  });

  it('skips unreplayable records but carries on, and stops at once if publishing fails', async () => {
    const c = collect();
    const mixed = [record({ value: null }), record({ offset: '2' }, { eventId: 'ok' })];
    const report = await replayRecords(mixed, c.publish);
    expect(c.sent.map((m) => m.headers.eventId)).toEqual(['ok']);
    expect(report.skipped.map((s) => s.reason)).toEqual(['no_value']);

    let calls = 0;
    await expect(
      replayRecords(three, async () => {
        if (++calls === 2) throw new Error('broker down');
      }),
    ).rejects.toThrow('broker down');
    expect(calls).toBe(2); // nothing after the failure was attempted
  });
});

describe('parseReplayArgs', () => {
  it('reads the options', () => {
    expect(
      parseReplayArgs(
        [
          '--dlq',
          'booking.dlq',
          '--brokers',
          'a:1,b:2',
          '--limit',
          '5',
          '--event-id',
          'e1',
          '--dry-run',
        ],
        {},
      ),
    ).toEqual({
      dlq: 'booking.dlq',
      brokers: ['a:1', 'b:2'],
      limit: 5,
      eventId: 'e1',
      dryRun: true,
    });
  });
  it('falls back to KAFKA_BROKERS', () => {
    expect(parseReplayArgs(['--dlq', 'payment.dlq'], { KAFKA_BROKERS: 'k:9092' }).brokers).toEqual([
      'k:9092',
    ]);
  });
  it('rejects bad input clearly', () => {
    expect(() => parseReplayArgs([], {})).toThrow('--dlq');
    expect(() => parseReplayArgs(['--dlq', 'booking'], { KAFKA_BROKERS: 'k' })).toThrow('--dlq');
    expect(() => parseReplayArgs(['--dlq', 'a.dlq'], {})).toThrow('--brokers');
    expect(() =>
      parseReplayArgs(['--dlq', 'a.dlq', '--limit', '0'], { KAFKA_BROKERS: 'k' }),
    ).toThrow('--limit');
    expect(() =>
      parseReplayArgs(['--dlq', 'a.dlq', '--bogus', 'x'], { KAFKA_BROKERS: 'k' }),
    ).toThrow('unknown option');
    expect(() => parseReplayArgs(['--dlq'], { KAFKA_BROKERS: 'k' })).toThrow('needs a value');
  });
});
