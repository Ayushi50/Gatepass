import { defineConfig } from '@playwright/test';

// Run through `pnpm e2e`, which boots the whole system first and sets E2E_BASE_URL.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  workers: 1, // the specs share one running system and build on each other
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    headless: true,
    trace: 'retain-on-failure',
  },
  outputDir: './test-results',
});
