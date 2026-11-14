import { buildEnvelope, encodeEnvelope } from '@gatepass/events';
import {
  RetriesExhaustedError,
  backoffDelayMs,
  createMessageHandler,
  dlqTopicFor,
  runWithRetry,
  type DeadLetterPublisher,
  type IncomingMessage,
} from '../src';

const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };
const noSleep = { sleep: async () => {}, random: () => 0.5 };

const message = (value: Uint8Array | null): IncomingMessage => ({
  topic: 'seats.held',
  partition: 2,
  offset: '41',
  key: 'b-1',
  value,
  headers: { eventType: 'seats.held' },
});

const validBytes = () =>
  encodeEnvelope(
    buildEnvelope({
      eventType: 'seats.held',
      payload: { bookingId: 'b-1', eventId: 'e-1', seatIds: ['A1'], holdExpiresAtMs: 1n },
      correlationId: 'b-1',
      producer: 'seat-inventory',
    }),
  );

class FakeDlq implements DeadLetterPublisher {
  published: { topic: string; headers: Record<string, string>; value: Uint8Array | null }[] = [];
  fail = false;
  async publish(
    topic: string,
    m: { key: string | null; value: Uint8Array | null; headers: Record<string, string> },
  ) {
    if (this.fail) throw new Error('dlq down');
    this.published.push({ topic, headers: m.headers, value: m.value });
  }
}

describe('backoff', () => {
  it('doubles up to the cap (full jitter at the ceiling)', () => {
    const top = () => 0.999999;
    expect(backoffDelayMs(1, policy, top)).toBe(99);
    expect(backoffDelayMs(2, policy, top)).toBe(199);
    expect(backoffDelayMs(3, policy, top)).toBe(399);
    expect(backoffDelayMs(10, policy, top)).toBe(999);
  });
  it('is never negative and never above the ceiling', () => {
    expect(backoffDelayMs(1, policy, () => 0)).toBe(0);
  });
});

describe('runWithRetry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = jest.fn();
    await expect(runWithRetry(async () => 'ok', policy, { sleep })).resolves.toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries until it succeeds', async () => {
    let calls = 0;
    const result = await runWithRetry(
      async () => {
        if (++calls < 3) throw new Error('flaky');
        return 'done';
      },
      policy,
      noSleep,
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('throws RetriesExhaustedError after maxAttempts', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls++;
          throw new Error('always');
        },
        policy,
        noSleep,
      ),
    ).rejects.toBeInstanceOf(RetriesExhaustedError);
    expect(calls).toBe(3);
  });
});

describe('message handler (decode -> retry -> DLQ)', () => {
  it('handles a good message and publishes nothing to the DLQ', async () => {
    const dlq = new FakeDlq();
    const handle = jest.fn(async () => {});
    const run = createMessageHandler({
      groupId: 'booking',
      handle,
      dlq,
      retry: policy,
      retryDeps: noSleep,
    });

    expect(await run(message(validBytes()))).toBe('handled');
    expect(handle).toHaveBeenCalledTimes(1);
    expect(dlq.published).toHaveLength(0);
  });

  it('retries a failing handler, then succeeds without dead-lettering', async () => {
    const dlq = new FakeDlq();
    let calls = 0;
    const run = createMessageHandler({
      groupId: 'booking',
      handle: async () => {
        if (++calls < 3) throw new Error('transient');
      },
      dlq,
      retry: policy,
      retryDeps: noSleep,
    });
    expect(await run(message(validBytes()))).toBe('handled');
    expect(calls).toBe(3);
    expect(dlq.published).toHaveLength(0);
  });

  it('dead-letters a poison message after exhausting retries, with diagnostics', async () => {
    const dlq = new FakeDlq();
    const handle = jest.fn(async () => {
      throw new Error('cannot process');
    });
    const run = createMessageHandler({
      groupId: 'booking',
      handle,
      dlq,
      retry: policy,
      retryDeps: noSleep,
    });
    const bytes = validBytes();

    expect(await run(message(bytes))).toBe('dead-lettered');
    expect(handle).toHaveBeenCalledTimes(3);
    expect(dlq.published).toHaveLength(1);
    const sent = dlq.published[0]!;
    expect(sent.topic).toBe(dlqTopicFor('booking'));
    expect(sent.topic).toBe('booking.dlq');
    expect(sent.value).toEqual(bytes);
    expect(sent.headers).toMatchObject({
      'x-dlq-original-topic': 'seats.held',
      'x-dlq-original-partition': '2',
      'x-dlq-original-offset': '41',
      'x-dlq-consumer': 'booking',
      'x-dlq-attempts': '3',
      'x-dlq-error': expect.stringContaining('cannot process'),
    });
  });

  it('dead-letters an undecodable message immediately without calling the handler', async () => {
    const dlq = new FakeDlq();
    const handle = jest.fn(async () => {});
    const run = createMessageHandler({
      groupId: 'booking',
      handle,
      dlq,
      retry: policy,
      retryDeps: noSleep,
    });

    expect(await run(message(new Uint8Array([0xff, 0xff])))).toBe('dead-lettered');
    expect(handle).not.toHaveBeenCalled();
    expect(dlq.published[0]!.headers['x-dlq-attempts']).toBe('0');
  });

  it('dead-letters a null (tombstone) message', async () => {
    const dlq = new FakeDlq();
    const run = createMessageHandler({
      groupId: 'booking',
      handle: async () => {},
      dlq,
      retry: policy,
      retryDeps: noSleep,
    });
    expect(await run(message(null))).toBe('dead-lettered');
  });

  it('throws if the DLQ is unavailable, so the offset is not committed', async () => {
    const dlq = new FakeDlq();
    dlq.fail = true;
    const run = createMessageHandler({
      groupId: 'booking',
      handle: async () => {
        throw new Error('nope');
      },
      dlq,
      retry: policy,
      retryDeps: noSleep,
    });
    await expect(run(message(validBytes()))).rejects.toThrow('dlq down');
  });
});
