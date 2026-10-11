import { defineConfig } from 'vitest/config';

// Integration tests: real Postgres and Valkey in containers (CLAUDE.md, Testing). Files end in
// .integration.test.ts and are excluded from `pnpm test`. The Postgres image defaults to the
// version compose ships; CI also runs the supported minimum (ADR 0010):
//   LAKKA_TEST_POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg16-trixie pnpm test:integration
export default defineConfig({
  test: {
    include: ['{packages,apps}/*/{src,test}/**/*.integration.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
