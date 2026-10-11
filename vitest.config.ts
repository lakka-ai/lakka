import { defineConfig } from 'vitest/config';

// Unit tests only: no network, no database, no containers. Integration tests
// (*.integration.test.ts) run with vitest.integration.config.ts, and the compatibility suite
// (*.compat.test.ts) with vitest.compat.config.ts, the out-of-process proof
// (*.out-of-process.test.ts) with vitest.out-of-process.config.ts, and the sandbox stack test
// (*.stack.test.ts) with vitest.sandbox.config.ts.
const project = (name: string, root: string) => ({
  extends: true as const,
  test: {
    name,
    root,
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    exclude: [
      '**/*.integration.test.ts',
      '**/*.compat.test.ts',
      '**/*.apps.test.ts',
      '**/*.out-of-process.test.ts',
      '**/*.stack.test.ts',
      '**/node_modules/**',
      'test/e2e/**',
    ],
  },
});

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      project('repo', '.'),
      project('contracts', 'packages/contracts'),
      project('core', 'packages/core'),
      project('db', 'packages/db'),
      project('api', 'apps/api'),
      project('worker', 'apps/worker'),
      project('web', 'apps/web'),
    ],
  },
});
