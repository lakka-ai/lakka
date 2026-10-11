import { defineConfig, devices } from '@playwright/test';

/*
 * The project site's pages in a browser (ADR 0119), from the built site in
 * apps/site/.vitepress/dist, in Chromium, WebKit and Firefox. `pnpm site:check` builds it first.
 */
const base = process.env['LAKKA_SITE_BASE'] ?? '/lakka/';

export default defineConfig({
  testDir: 'test/site',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:4174${base}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // VitePress itself rather than through pnpm, so Playwright can stop it when the run ends.
    command: 'node_modules/.bin/vitepress preview --port 4174',
    cwd: 'apps/site',
    url: `http://localhost:4174${base}`,
    reuseExistingServer: false,
  },
  // Chrome's engine, Safari's and Firefox's: iOS and iPadOS run every browser on WebKit, so the
  // phones and tablets the site is laid out for are WebKit first.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
