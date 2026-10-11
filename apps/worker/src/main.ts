import { createServer } from 'node:http';
import {
  checkHealth,
  configureCredentialsFromConfig,
  createCacheClient,
  createLogger,
  ensureDatabaseReady,
  feedRecords,
  loadCatalogue,
  loadProcessConfig,
  PRODUCTION_FEED_KEYS,
  startAlertJobs,
  startBudgetMaintenance,
} from '@lakka/core';
import type { AlertJobs } from '@lakka/core';
import { createDb, createPool, ensureMonthlyPartitions, pingDatabase } from '@lakka/db';

/*
 * Worker: checks the database schema at startup, keeps usage partitions ahead of time, keeps
 * budgets honest (the sweep of lapsed reservations every 30 seconds, and a rebuild of Valkey
 * counters from Postgres every five minutes; ADR 0052), delivers budget alerts through pg-boss
 * (ADR 0054), checks the signed price feed when an admin turned it on (PR-6, ADR 0116), and
 * exposes an internal health endpoint.
 * The health port is not published outside the compose network.
 */

/** Usage partitions are created months ahead; a daily check keeps that true (ADR 0039). */
const PARTITION_CHECK_MS = 24 * 60 * 60 * 1000;

const config = loadProcessConfig(process.env);
const { logger } = createLogger({ level: config.logLevel, service: 'worker' });

// Delivering a budget alert reads the webhook's signing secret, which is stored encrypted
// (BG-10, ADR 0054), so the worker needs the master key as the api does (ADR 0032).
// The keys are configured once the schema is ready, since Postgres says which is active (ADR 0115).
if (config.credentials.keys.size === 0) {
  logger.fatal('worker.start_failed', { error_code: 'credential_key_missing' });
  process.exit(1);
}

const pool = createPool({ ...config.database, applicationName: 'lakka-worker' }, (err) =>
  logger.warn('database.idle_client_error', { dependency: 'database' }, err),
);

const cache = createCacheClient(config.cache, 'lakka-worker');

const health = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/healthz') {
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end('{"error":{"code":"not_found","message":"Not found"}}');
    return;
  }
  checkHealth(
    { database: () => pingDatabase(pool), cache: () => cache.ping() },
    { timeoutMs: 2000, logger },
  )
    .then((report) => {
      res
        .writeHead(report.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify(report));
    })
    .catch((error: unknown) => {
      logger.error('worker.health_failed', {}, error);
      res.writeHead(500).end();
    });
});

let partitionTimer: NodeJS.Timeout | undefined;
let stopBudgets: (() => Promise<void>) | undefined;
let alertJobs: AlertJobs | undefined;
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('worker.stopping', { signal });
  clearInterval(partitionTimer);
  await stopBudgets?.().catch((error: unknown) =>
    logger.warn('worker.budget_maintenance_stop_failed', {}, error),
  );
  await alertJobs
    ?.stop()
    .catch((error: unknown) => logger.warn('worker.jobs_stop_failed', {}, error));
  health.close();
  cache.close();
  await pool.end().catch((error: unknown) => logger.warn('worker.pool_close_failed', {}, error));
  logger.info('worker.stopped');
  process.exit(0);
}
process.on('SIGTERM', (s) => void shutdown(s));
process.on('SIGINT', (s) => void shutdown(s));

health.listen(config.worker.healthPort, config.worker.healthHost, () => {
  logger.info('worker.health_listening', {
    host: config.worker.healthHost,
    port: config.worker.healthPort,
  });
});
try {
  // AD-4: the worker also migrates at startup; the migration lock makes api and worker safe to
  // start together (ADR 0026).
  await ensureDatabaseReady(pool, logger);
  await configureCredentialsFromConfig(pool, config);
} catch (error) {
  logger.fatal('worker.start_failed', {}, error);
  process.exit(1);
}
partitionTimer = setInterval(() => {
  ensureMonthlyPartitions(pool)
    .then((created) => {
      if (created > 0) logger.info('database.partitions_created', { count: created });
    })
    .catch((error: unknown) => logger.error('worker.usage_partitions_failed', {}, error));
}, PARTITION_CHECK_MS);
partitionTimer.unref();
const db = createDb(pool);
try {
  // Budget alerts are delivered by pg-boss, in its own schema in the same Postgres (ADR 0054).
  alertJobs = await startAlertJobs(
    { db, pool, logger },
    // Retention runs every day as a scheduled job on the same queue (NF-P5, ADR 0078), the
    // purge of deleted workspaces every minute (ID-8, ADR 0104), and the price feed's check
    // every minute, which contacts nothing while the feed is off (PR-6, ADR 0116).
    {
      retention: { db, pool, logger },
      purge: { db, cache, logger },
      catalogueFeed: {
        records: feedRecords(db),
        logger,
        // The feed is held to this release's serial and prices.
        bundled: loadCatalogue(),
        keys: PRODUCTION_FEED_KEYS,
        url: config.catalogueFeed.url,
      },
    },
  );
} catch (error) {
  logger.fatal('worker.start_failed', {}, error);
  process.exit(1);
}
stopBudgets = startBudgetMaintenance({ db, cache, logger }, pool, { alerts: alertJobs });
logger.info('worker.started', { node_version: process.version });
