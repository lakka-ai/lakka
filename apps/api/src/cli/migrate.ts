import { parseArgs } from 'node:util';
import { createLogger, ensureDatabaseReady, loadProcessConfig } from '@lakka/core';
import { createPool } from '@lakka/db';

/*
 * Applies pending migrations, or with --verify only checks that none are pending. api and worker
 * already do this at startup (AD-4); this command exists for `pnpm db:migrate` in development
 * and for `lakka migrate` when an operator wants to run it by hand.
 */

const { values } = parseArgs({ options: { verify: { type: 'boolean', default: false } } });
const config = loadProcessConfig(process.env);
const { logger } = createLogger({ level: config.logLevel, service: 'migrate' });
const pool = createPool({ ...config.database, applicationName: 'lakka-migrate', max: 1 }, (err) =>
  logger.warn('database.idle_client_error', { dependency: 'database' }, err),
);

let exitCode = 0;
try {
  await ensureDatabaseReady(pool, logger, { mode: values.verify ? 'verify' : 'migrate' });
} catch (error) {
  logger.fatal('migrate.failed', {}, error);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
