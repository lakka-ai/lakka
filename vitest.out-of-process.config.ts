import { defineConfig } from 'vitest/config';

// The out-of-process proof (TL-8, ADR 0073): a tool runs in the app image, in a locked-down
// container, through the same dispatch seam. CI only, since it needs the built image:
//   docker build -f docker/Dockerfile -t lakka/app:ci .
//   LAKKA_RUNNER_IMAGE=lakka/app:ci pnpm test:out-of-process
export default defineConfig({
  test: {
    include: ['apps/api/test/**/*.out-of-process.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
