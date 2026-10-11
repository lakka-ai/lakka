import { defineConfig } from 'vitest/config';

// Open WebUI and LibreChat against the running stack (AC 14, API-6, ADR 0064). Run through
// scripts/compat-apps.sh, which starts them, after `pnpm test:compat` has prepared the stack.
export default defineConfig({
  test: {
    include: ['test/compat/apps/*.apps.test.ts'],
    // They change one workspace's cap in turn, so they must not overlap.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
