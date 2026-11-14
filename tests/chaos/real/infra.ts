import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kafka, logLevel } from 'kafkajs';
import { EVENT_TYPES } from '@gatepass/events';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitForPort(
  port: number,
  timeoutMs: number,
  host = '127.0.0.1',
): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({ port, host }, () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > end)
      throw new Error(`nothing listening on ${host}:${port} after ${timeoutMs} ms`);
    await sleep(250);
  }
}

export const logDir = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'gatepass-chaos-'));
  mkdirSync(dir, { recursive: true });
  return dir;
})();

export interface StartedKafka {
  brokers: string[];
  stop(): Promise<void>;
}

/**
 * A real single-node Apache Kafka (KRaft, no ZooKeeper) from a distribution you downloaded:
 * KAFKA_HOME=/path/to/kafka_2.13-3.9.0. Or point KAFKA_BROKERS at one that is already running.
 * It needs Java (JAVA_HOME or `java` on PATH).
 */
export async function startKafka(): Promise<StartedKafka> {
  if (process.env.KAFKA_BROKERS) {
    return { brokers: process.env.KAFKA_BROKERS.split(','), stop: async () => {} };
  }
  const home = process.env.KAFKA_HOME;
  if (!home || !existsSync(join(home, 'bin', 'kafka-server-start.sh'))) {
    throw new Error(
      'set KAFKA_HOME to an extracted Apache Kafka distribution (or KAFKA_BROKERS to a running broker)',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'gatepass-kafka-'));
  const config = join(dir, 'server.properties');
  const port = 29092;
  const ctl = 29093;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    config,
    [
      'process.roles=broker,controller',
      'node.id=1',
      `controller.quorum.voters=1@127.0.0.1:${ctl}`,
      `listeners=PLAINTEXT://127.0.0.1:${port},CONTROLLER://127.0.0.1:${ctl}`,
      `advertised.listeners=PLAINTEXT://127.0.0.1:${port}`,
      'controller.listener.names=CONTROLLER',
      'inter.broker.listener.name=PLAINTEXT',
      'listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      `log.dirs=${join(dir, 'data')}`,
      'num.partitions=3',
      'offsets.topic.replication.factor=1',
      'transaction.state.log.replication.factor=1',
      'transaction.state.log.min.isr=1',
      'group.initial.rebalance.delay.ms=0',
      'auto.create.topics.enable=true',
    ].join('\n'),
  );
  const run = (script: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn(join(home, 'bin', script), args, { env: process.env });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('exit', (code) =>
        code === 0 ? resolve(out) : reject(new Error(`${script} failed: ${out}`)),
      );
    });
  const id = (await run('kafka-storage.sh', ['random-uuid'])).trim().split('\n').pop()!.trim();
  await run('kafka-storage.sh', ['format', '-t', id, '-c', config]);
  const child = spawn(join(home, 'bin', 'kafka-server-start.sh'), [config], { env: process.env });
  const log = createWriteStream(join(logDir, 'kafka.log'));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  await waitForPort(port, 90_000);
  return {
    brokers: [`127.0.0.1:${port}`],
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
      child.kill('SIGKILL');
    },
  };
}

/** Pre-creates every event topic (3 partitions) and each consumer's dead-letter topic. */
export async function createTopics(brokers: string[], groups: string[]): Promise<string[]> {
  const kafka = new Kafka({ clientId: 'chaos-admin', brokers, logLevel: logLevel.NOTHING });
  const admin = kafka.admin();
  await admin.connect();
  const topics = [...EVENT_TYPES, ...groups.map((g) => `${g}.dlq`)];
  await admin.createTopics({
    waitForLeaders: true,
    topics: topics.map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })),
  });
  await admin.disconnect();
  return topics;
}

/** How many messages sit in each dead-letter topic. */
export async function dlqDepths(
  brokers: string[],
  groups: string[],
): Promise<Record<string, number>> {
  const kafka = new Kafka({ clientId: 'chaos-admin', brokers, logLevel: logLevel.NOTHING });
  const admin = kafka.admin();
  await admin.connect();
  const out: Record<string, number> = {};
  for (const g of groups) {
    const offsets = await admin.fetchTopicOffsets(`${g}.dlq`);
    out[`${g}.dlq`] = offsets.reduce((n, o) => n + (Number(o.high) - Number(o.low)), 0);
  }
  await admin.disconnect();
  return out;
}

export interface ManagedProcess {
  name: string;
  port?: number;
  start(): Promise<void>;
  kill(): void;
  isUp(): boolean;
  starts: number;
  kills: number;
}

/** A service run as a real OS process (ts-node), killable with SIGKILL and restartable. */
export function managedService(opts: {
  name: string;
  entry: string;
  cwd: string;
  env: Record<string, string>;
  port?: number;
  readyLine?: string;
}): ManagedProcess {
  let child: ChildProcess | undefined;
  const log = createWriteStream(join(logDir, `${opts.name}.log`), { flags: 'a' });
  const self: ManagedProcess = {
    name: opts.name,
    port: opts.port,
    starts: 0,
    kills: 0,
    isUp: () => !!child && child.exitCode === null && child.signalCode === null,
    kill() {
      if (child && self.isUp()) {
        self.kills++;
        child.kill('SIGKILL');
      }
    },
    async start() {
      if (self.isUp()) return;
      self.starts++;
      log.write(`\n=== start #${self.starts} ${new Date().toISOString()} ===\n`);
      let ready = !opts.readyLine;
      child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', opts.entry], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, TS_NODE_TRANSPILE_ONLY: 'true' },
      });
      const watch = (d: Buffer) => {
        log.write(d);
        if (opts.readyLine && d.toString().includes(opts.readyLine)) ready = true;
      };
      child.stdout?.on('data', watch);
      child.stderr?.on('data', (d) => log.write(d));
      if (opts.port) await waitForPort(opts.port, 120_000);
      const end = Date.now() + 120_000;
      while (!ready) {
        if (Date.now() > end) throw new Error(`${opts.name} never reported ready`);
        await sleep(200);
      }
    },
  };
  return self;
}
