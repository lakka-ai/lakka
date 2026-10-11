import { createLogger, ensureDatabaseReady, loadProcessConfig } from '@lakka/core';
import { createPool, isSetupComplete, createDb } from '@lakka/db';

/*
 * Operator command: prints the first-run setup code (AD-1, ADR 0034).
 *
 *   docker compose exec api lakka setup-code
 *   pnpm setup-code              (under `pnpm dev`, where the api runs on this machine)
 *
 * The code goes to this command's own output only, never to a log (ADR 0021). Once setup is
 * complete the code is useless, and the command says so instead of printing it.
 */

const config = loadProcessConfig(process.env);
// Log lines go to stderr, so stdout carries the code alone and can be copied or piped as is.
const { logger } = createLogger({
  level: config.logLevel,
  service: 'setup-code',
  destination: { write: (line: string) => void process.stderr.write(line) },
});

if (config.setup.code === undefined) {
  process.stderr.write(
    'setup-code: no setup code is configured (the setup_code secret is missing)\n',
  );
  process.exit(1);
}

const pool = createPool(
  { ...config.database, applicationName: 'lakka-setup-code', max: 1 },
  () => undefined,
);
let exitCode = 0;
try {
  await ensureDatabaseReady(pool, logger, { mode: 'verify' });
  if (await isSetupComplete(createDb(pool))) {
    process.stderr.write('setup-code: setup is already complete; sign in instead\n');
    exitCode = 1;
  } else {
    process.stdout.write(`${config.setup.code}\n`);
  }
} catch (error) {
  logger.error('setup_code.failed', {}, error);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
