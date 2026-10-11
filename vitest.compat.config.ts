import { defineConfig } from 'vitest/config';

// Compatibility suite (AC 14, AC 15, API-6, ADR 0064): official clients against a running stack
// with the fake provider, from outside it, through Caddy. Start the stack first:
//   docker compose -f compose.yaml -f docker/compose.e2e.yaml up -d --wait
export default defineConfig({
  test: {
    include: ['test/compat/**/*.compat.test.ts'],
    globalSetup: ['./test/compat/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
