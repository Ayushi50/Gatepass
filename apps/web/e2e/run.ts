/* eslint-disable no-console */
// `pnpm e2e`: boots the whole system (real Kafka, Redis, Postgres, every service, the web app),
// runs the browser specs against it, and shuts it all down.
//
//   KAFKA_HOME=/path/to/kafka_2.13-3.9.0 pnpm e2e        (JAVA_HOME or java on PATH; or KAFKA_BROKERS=...)
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { startStack } from '../../../scripts/stack/stack';

async function main(): Promise<void> {
  const stack = await startStack({ web: true, seed: true });
  let code = 1;
  try {
    const cli = require.resolve('@playwright/test/cli');
    code = await new Promise<number>((resolve) => {
      spawn(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
        cwd: join(__dirname, '..'),
        stdio: 'inherit',
        env: { ...process.env, E2E_BASE_URL: stack.urls.web, E2E_GATEWAY_URL: stack.urls.gateway },
      }).on('exit', (c) => resolve(c ?? 1));
    });
    if (code !== 0) console.log(`service logs: ${stack.logDir}`);
  } finally {
    await stack.stop();
  }
  process.exit(code);
}

void main().catch((err) => {
  console.error(err);
  process.exit(2);
});
