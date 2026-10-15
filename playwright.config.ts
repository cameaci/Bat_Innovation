import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './electron/tests',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: './work/playwright-results',
  use: { trace: 'retain-on-failure' },
});
