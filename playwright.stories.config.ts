import { defineConfig, devices } from '@playwright/test';

/*
 * The pattern gallery's checks (NF-A1): every story in the static Storybook build, in light
 * and dark, at desktop size and at 390px. `pnpm test:stories` builds Storybook first.
 */
export default defineConfig({
  testDir: 'test/stories',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:6007',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Vite itself rather than through pnpm, so Playwright can stop it when the run ends.
    command:
      'node_modules/.bin/vite preview --config .storybook/vite.config.ts --outDir storybook-static --host 127.0.0.1 --port 6007 --strictPort',
    cwd: 'apps/web',
    url: 'http://127.0.0.1:6007/index.json',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
