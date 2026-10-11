import { defineConfig } from 'drizzle-kit';

// Used only by `pnpm db:generate`. Migrations are applied by our own runner (src/migrate.ts),
// never by drizzle-kit migrate, so no database credentials are needed here.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
