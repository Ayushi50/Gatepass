/* eslint-disable no-console */
// `pnpm --filter @gatepass/web review`: boots the real system with a 25-second hold (2 s grace) and
// runs review/review.spec.ts, saving screenshots to docs/review/screenshots.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { startStack } from '../../../scripts/stack/stack';

async function main(): Promise<void> {
  const stack = await startStack({ web: true, seed: true, holdTtlMs: 25_000, holdGraceMs: 2_000 });
  let code = 1;
  try {
    const cli = require.resolve('@playwright/test/cli');
    code = await new Promise<number>((resolve) => {
      spawn(process.execPath, [cli, 'test', '--config', 'review/playwright.config.ts'], {
        cwd: join(__dirname, '..'),
        stdio: 'inherit',
        env: { ...process.env, E2E_BASE_URL: stack.urls.web },
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
