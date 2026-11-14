/* eslint-disable no-console */
// Replays a consumer's dead letters. Usage:
//   pnpm replay --dlq booking.dlq [--brokers localhost:9092] [--limit 10] [--event-id ID] [--dry-run]
//
// It reads the DLQ with its own consumer group (`replay-<dlq>`), so a second run does not replay
// the same messages again, and it only moves that group's position forward AFTER the broker has
// accepted the replayed messages. A --dry-run reads and reports but changes nothing at all.
import { Kafka, logLevel } from 'kafkajs';
import { parseReplayArgs, replayRecords, type DlqRecord } from '../src/replay';

const IDLE_MS = 4000;

async function readAll(kafka: Kafka, topic: string, groupId: string, commit: boolean) {
  const consumer = kafka.consumer({ groupId });
  const records: DlqRecord[] = [];
  const last = new Map<number, string>();
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  let idle: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve) => {
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(resolve, IDLE_MS);
    };
    arm();
    void consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic: t, partition, message }) => {
        arm();
        last.set(partition, message.offset);
        records.push({
          topic: t,
          partition,
          offset: message.offset,
          key: message.key ? message.key.toString() : null,
          value: message.value,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([k, v]) => [k, v ? v.toString() : '']),
          ),
        });
      },
    });
  });
  return {
    records,
    async finish(ok: boolean) {
      if (ok && commit) {
        await consumer.commitOffsets(
          [...last].map(([partition, offset]) => ({
            topic,
            partition,
            offset: String(Number(offset) + 1),
          })),
        );
      }
      await consumer.disconnect();
    },
  };
}

async function main(): Promise<void> {
  const args = parseReplayArgs(process.argv.slice(2));
  const kafka = new Kafka({
    clientId: 'gatepass-replay',
    brokers: args.brokers,
    logLevel: logLevel.WARN,
  });
  const producer = kafka.producer({ idempotent: true });
  const reader = await readAll(kafka, args.dlq, `replay-${args.dlq}`, !args.dryRun);
  let ok = false;
  try {
    console.log(`read ${reader.records.length} dead letter(s) from ${args.dlq}`);
    if (!args.dryRun) await producer.connect();
    const report = await replayRecords(
      reader.records,
      async (m) => {
        await producer.send({
          topic: m.topic,
          acks: -1,
          messages: [{ key: m.key, value: Buffer.from(m.value), headers: m.headers }],
        });
      },
      args,
    );
    for (const m of report.replayed)
      console.log(
        `${args.dryRun ? 'would replay' : 'replayed'} -> ${m.topic} (${m.key ?? 'no key'})`,
      );
    for (const s of report.skipped)
      console.log(`skipped ${s.record.partition}:${s.record.offset} (${s.reason})`);
    console.log(
      `${args.dryRun ? 'would replay' : 'replayed'} ${report.replayed.length}, skipped ${report.skipped.length}`,
    );
    ok = true;
  } finally {
    await reader.finish(ok);
    await producer.disconnect();
  }
}

main().catch((err) => {
  console.error(`replay failed: ${(err as Error).message}`);
  process.exit(1);
});
