import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import {
  checkHealth,
  configureCredentialsFromConfig,
  createCacheClient,
  createLogger,
  diagnosticsEntries,
  loadProcessConfig,
  readSandboxFacts,
  tarStream,
} from '@lakka/core';
import { createDb, createPool } from '@lakka/db';
import { apiHealthChecks, liveApiClassifierCheck } from '../health.ts';
import { sandboxKeys } from '../sandbox/keys.ts';

/*
 * Operator command: writes the diagnostics bundle to stdout (AD-3, ADR 0083).
 *
 *   docker compose exec -T api lakka diagnostics > lakka-diagnostics.tar.gz
 *
 * For when the web app cannot be reached; instance admins can also download it from the
 * Diagnostics page. It works with the database or the cache down, and says so in the bundle.
 * It asks the running api how the classifier is rather than loading its own copy of the model,
 * which could get it killed for want of memory (ADR 0083).
 */

/** The api's /healthz waits up to 2 s for providers; the classifier answer comes through it. */
const OPERATOR_HEALTH_TIMEOUT_MS = 5000;

if (process.stdout.isTTY) {
  process.stderr.write(
    'diagnostics: writes a tar.gz to stdout; redirect it to a file, for example\n' +
      '  docker compose exec -T api lakka diagnostics > lakka-diagnostics.tar.gz\n',
  );
  process.exit(64);
}

const config = loadProcessConfig(process.env);
// stdout carries the archive alone; log lines go to stderr.
const { logger } = createLogger({
  level: config.logLevel,
  service: 'diagnostics',
  destination: { write: (line: string) => void process.stderr.write(line) },
});

const pool = createPool(
  { ...config.database, applicationName: 'lakka-diagnostics', max: 2 },
  () => undefined,
);
const cache = createCacheClient(config.cache, 'lakka-diagnostics');
// The provider checks read stored provider keys, so the key ring is needed as in the api
// (ADR 0115). The bundle must still be written with the database down, so a failure here only
// leaves those checks without keys; the bundle reports the database as it is.
try {
  await configureCredentialsFromConfig(pool, config);
} catch (error) {
  logger.warn('diagnostics.credentials_unavailable', {}, error);
}
const checks = apiHealthChecks({
  pool,
  db: createDb(pool),
  cache,
  classifier: liveApiClassifierCheck(`http://127.0.0.1:${config.api.port}/healthz`),
  timeoutMs: OPERATOR_HEALTH_TIMEOUT_MS,
});

let exitCode = 0;
try {
  await pipeline(
    Readable.from(
      tarStream(
        diagnosticsEntries({
          pool,
          cache,
          config,
          health: () =>
            checkHealth(checks.healthChecks, {
              timeoutMs: checks.healthTimeoutMs ?? 2000,
              ...(checks.optionalHealthChecks === undefined
                ? {}
                : { optional: checks.optionalHealthChecks }),
              logger,
            }),
          sandbox: () => readSandboxFacts(config.sandbox, sandboxKeys),
          generatedBy: { via: 'operator' },
        }),
      ),
    ),
    createGzip(),
    process.stdout,
  );
} catch (error) {
  logger.error('diagnostics.failed', {}, error);
  exitCode = 1;
} finally {
  cache.close();
  await pool.end();
}
process.exit(exitCode);
