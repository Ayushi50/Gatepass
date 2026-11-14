import { registry } from '@gatepass/telemetry';
import { LagMonitor, measureDepth, measureLag, type AdminLike } from '../src';

/** A pretend Kafka: per topic, per partition [low, high, committed-by-the-group]. */
function fakeAdmin(topics: Record<string, [number, number, number | undefined][]>): AdminLike {
  return {
    fetchTopicOffsets: async (t) => {
      if (!topics[t]) throw new Error('unknown topic');
      return topics[t]!.map(([low, high], partition) => ({
        partition,
        offset: String(high),
        high: String(high),
        low: String(low),
      }));
    },
    fetchOffsets: async ({ topics: ts }) =>
      ts.map((topic) => ({
        topic,
        partitions: (topics[topic] ?? []).map(([, , at], partition) => ({
          partition,
          offset: String(at ?? -1),
        })),
      })),
  };
}

const gaugeValue = async (name: string, labels: Record<string, string>) => {
  const { values } = await registry.getSingleMetric(name)!.get();
  return values.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value;
};

describe('consumer lag', () => {
  it('is what the group has not read, summed over partitions', async () => {
    const admin = fakeAdmin({
      'seats.held': [
        [0, 100, 90],
        [0, 50, 50],
        [10, 40, 25],
      ],
    });
    expect(await measureLag(admin, 'booking', 'seats.held')).toBe(10 + 0 + 15);
  });
  it('a group that has committed nothing is behind by everything still in the log', async () => {
    expect(await measureLag(fakeAdmin({ t: [[5, 20, undefined]] }), 'g', 't')).toBe(15);
  });
  it('never goes negative', async () => {
    expect(await measureLag(fakeAdmin({ t: [[0, 10, 12]] }), 'g', 't')).toBe(0);
  });
});

describe('dead-letter depth', () => {
  it('is the messages still in the dead-letter topic', async () => {
    expect(
      await measureDepth(
        fakeAdmin({
          'booking.dlq': [
            [0, 3, undefined],
            [2, 6, undefined],
          ],
        }),
        'booking.dlq',
      ),
    ).toBe(3 + 4);
  });
});

describe('LagMonitor', () => {
  it('publishes both gauges for its group, labelled by group, topic and dead-letter topic', async () => {
    const admin = fakeAdmin({
      'seats.held': [[0, 30, 10]],
      'seats.sold': [[0, 5, 5]],
      'booking.dlq': [[0, 2, undefined]],
    });
    await new LagMonitor(admin, 'booking', ['seats.held', 'seats.sold']).tick();
    expect(
      await gaugeValue('gatepass_consumer_lag', { group: 'booking', topic: 'seats.held' }),
    ).toBe(20);
    expect(
      await gaugeValue('gatepass_consumer_lag', { group: 'booking', topic: 'seats.sold' }),
    ).toBe(0);
    expect(await gaugeValue('gatepass_dlq_depth', { dlq: 'booking.dlq' })).toBe(2);
  });
  it('a topic it cannot read yet is skipped, not fatal', async () => {
    await expect(new LagMonitor(fakeAdmin({}), 'g', ['nope']).tick()).resolves.toBeUndefined();
  });
});
