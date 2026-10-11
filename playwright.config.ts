import { defineConfig, devices } from '@playwright/test';

/*
 * Acceptance suite (CLAUDE.md, Testing). Runs against a running compose stack, exactly as a
 * customer runs it, plus a fake model provider for chat (ADR 0061): start it first with
 * `docker compose -f compose.yaml -f docker/compose.e2e.yaml up -d --wait`. LAKKA_E2E_URL
 * points somewhere else if needed.
 */
export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './test/e2e/global-setup.ts',
  use: {
    baseURL: process.env['LAKKA_E2E_URL'] ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    // First-run setup can happen once per stack, so it runs first, on its own (ADR 0034).
    {
      name: 'first-run',
      testMatch: /first-run\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: /first-run\.spec\.ts$/,
      dependencies: ['first-run'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
