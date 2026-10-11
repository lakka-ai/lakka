import { LakkaError } from '@lakka/contracts';
import {
  configureCredentialsFromConfig,
  createLogger,
  ensureDatabaseReady,
  loadProcessConfig,
} from '@lakka/core';
import { createPool } from '@lakka/db';

/*
 * Operator command: prints the active credential master key, the recovery key (NF-S9, ADR 0115).
 *
 *   docker compose exec api lakka recovery-key
 *
 * After a rotation the key setup showed is no longer the one in use, so the operator needs a way
 * to read the new one to save it. Like setup-code (ADR 0034), it goes to this command's own
 * output, which `docker compose exec` does not hand to the logging driver, and never to a log
 * (ADR 0021). Reading it takes the same access to the server as reading the secrets volume.
 */

const config = loadProcessConfig(process.env);
// Log lines go to stderr, so stdout carries the key alone.
const { logger } = createLogger({
  level: config.logLevel,
  service: 'recovery-key',
  destination: { write: (line: string) => void process.stderr.write(line) },
});

const pool = createPool(
  { ...config.database, applicationName: 'lakka-recovery-key', max: 1 },
  () => undefined,
);
let exitCode = 0;
try {
  await ensureDatabaseReady(pool, logger, { mode: 'verify' });
  // Checked against Postgres, so what is printed is the key stored values are encrypted with.
  const { activeKey } = await configureCredentialsFromConfig(pool, config);
  process.stdout.write(`${activeKey}\n`);
} catch (error) {
  if (error instanceof LakkaError) {
    process.stderr.write(`recovery-key: ${error.message} (${error.code})\n`);
  } else logger.error('recovery_key.failed', {}, error);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
