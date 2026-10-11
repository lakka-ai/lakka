import { defineConfig } from 'vitest/config';

// The stdio sandbox in the running stack (NF-S4, ADR 0118): a probe stdio server reports what it
// can and cannot do from inside, and services are stopped and killed under it. Start the stack
// first; the tests stop, kill and start the sandbox and egress services themselves:
//   docker compose -f compose.yaml -f docker/compose.e2e.yaml up -d --build --wait
export default defineConfig({
  test: {
    include: ['test/sandbox/*.stack.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
