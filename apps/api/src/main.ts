import {
  byTransport,
  configureCredentialsFromConfig,
  createAuth,
  createCacheClient,
  createLogger,
  createTracing,
  ensureDatabaseReady,
  cachingEmbedder,
  getSetupStatus,
  inProcessExecutor,
  lazyClassifierRuntime,
  loadCatalogue,
  loadOnnxEmbedder,
  loadProcessConfig,
  PRODUCTION_FEED_KEYS,
  readSandboxFacts,
  sandboxExecutor,
  startCatalogueReloader,
  subscribe,
  valkeyEvents,
  valkeyRateLimitStorage,
} from '@lakka/core';
import type {
  Catalogue,
  CatalogueReloader,
  ConfiguredCredentials,
  ToolExecutor,
} from '@lakka/core';
import { createDb, createPool } from '@lakka/db';
import { apiHealthChecks } from './health.ts';
import { sandboxKeys } from './sandbox/keys.ts';
import { SHUTDOWN_DRAIN_MS, STREAM_END_WAIT_MS } from './openai/routes.ts';
import { buildServer } from './server.ts';

const config = loadProcessConfig(process.env);
const { logger, frameworkLogger } = createLogger({ level: config.logLevel, service: 'api' });

if (config.credentials.keys.size === 0) {
  logger.fatal('api.start_failed', { error_code: 'credential_key_missing' });
  process.exit(1);
}

const pool = createPool({ ...config.database, applicationName: 'lakka-api' }, (err) =>
  logger.warn('database.idle_client_error', { dependency: 'database' }, err),
);
const cache = createCacheClient(config.cache, 'lakka-api');

const db = createDb(pool);
// An invalid bundled catalogue stops startup rather than billing with bad prices (ADR 0037).
let catalogue: Catalogue;
try {
  catalogue = loadCatalogue();
} catch (error) {
  logger.fatal('api.start_failed', { error_code: 'catalogue_invalid' }, error);
  process.exit(1);
}

// AD-4: migrate or refuse before serving anything. Then the credential keys: Postgres says which
// version is active, and a missing or wrong key refuses startup (ADR 0115).
let credentials: ConfiguredCredentials;
try {
  await ensureDatabaseReady(pool, logger);
  credentials = await configureCredentialsFromConfig(pool, config);
} catch (error) {
  logger.fatal('api.start_failed', {}, error);
  process.exit(1);
}
// The price feed, when an admin turned it on, merged into the bundled catalogue. A stored feed
// that fails its checks is ignored and never stops startup (PR-6, ADR 0116).
const prices: CatalogueReloader = await startCatalogueReloader({
  db,
  logger,
  bundled: catalogue,
  keys: PRODUCTION_FEED_KEYS,
});

const auth = createAuth({ db, cache, logger, config: config.auth });
// Spans go to Postgres (OB-3, ADR 0076).
const tracing = createTracing({ db, logger, otlp: config.otlp });
// Loaded on first use, not at startup (invariant 10, ADR 0043); the first health check is the
// first use (ADR 0081).
const classifier = lazyClassifierRuntime({
  load: async () =>
    cachingEmbedder(
      await loadOnnxEmbedder({
        modelDir: config.classifier.modelDir,
        threads: config.classifier.threads,
      }),
    ),
  logger,
});

// stdio servers run in the sandbox; HTTP servers are reached from here, through the guarded fetch
// (NF-S4, ADR 0118). In-process is for `pnpm dev` alone, and config refuses it in production.
const { toolHost } = config.sandbox;
let stdioExecutor: ToolExecutor;
if (toolHost.kind === 'in-process') {
  logger.warn('tools.stdio_in_process', { status: 'not_isolated' });
  stdioExecutor = inProcessExecutor;
} else {
  stdioExecutor = sandboxExecutor({
    toolHost,
    // Both read for every operation: init may make them anew.
    token: sandboxKeys.toolHostToken,
    egress: { proxyUrl: config.sandbox.egressProxyUrl, key: sandboxKeys.egressKey },
  });
}

const app = buildServer({
  logger,
  frameworkLogger,
  ...apiHealthChecks({ pool, db, cache, classifier }),
  diagnostics: {
    config,
    pool,
    sandbox: () => readSandboxFacts(config.sandbox, sandboxKeys),
  },
  auth: {
    context: { auth, db, events: valkeyEvents(cache, logger) },
    publicUrl: config.auth.publicUrl,
    trustedOrigins: config.auth.trustedOrigins,
    rateLimit: valkeyRateLimitStorage(cache),
    cache,
    setup: { code: config.setup.code, credentialMasterKey: credentials.activeKey },
    catalogue: prices,
    catalogueFeed: { url: config.catalogueFeed.url },
    classifier,
    mcpPrivateOrigins: config.mcp.privateOrigins,
    toolExecutor: byTransport({ stdio: stdioExecutor, http: inProcessExecutor }),
    tracer: tracing.tracer,
    otlp: config.otlp,
    modelRateLimit: config.modelRateLimit,
    // Ends a revoked person's open streams at once (AC 6, ADR 0063).
    revocations: {
      subscribe: (channels, onMessage) =>
        subscribe(config.cache, 'lakka-api-events', channels, onMessage),
    },
  },
});

let shuttingDown = false;
// NF-O5: in-flight requests get the drain window to finish, then are ended in preClose; this is
// the backstop past both. compose gives the api 30 s before it kills it (ADR 0081).
const SHUTDOWN_GRACE_MS = SHUTDOWN_DRAIN_MS + STREAM_END_WAIT_MS + 3000;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('api.stopping', { signal });
  // Whatever holds a connection open past the grace period is cut, so a stuck client or proxy
  // connection cannot keep the process from exiting.
  const force = setTimeout(() => {
    logger.warn('api.stop_forced', { delay_ms: SHUTDOWN_GRACE_MS });
    app.server.closeAllConnections();
  }, SHUTDOWN_GRACE_MS);
  try {
    await app.close();
    clearTimeout(force);
    prices.stop();
    logger.info('api.stop_step', { status: 'server_closed' });
    // The last requests' spans are written before the database goes.
    await tracing.shutdown();
    await pool.end();
    logger.info('api.stop_step', { status: 'database_closed' });
    cache.close();
    logger.info('api.stopped');
    process.exit(0);
  } catch (error) {
    logger.error('api.stop_failed', {}, error);
    process.exit(1);
  }
}
process.on('SIGTERM', (s) => void shutdown(s));
process.on('SIGINT', (s) => void shutdown(s));

try {
  // Initialize Better Auth now so a bad secret or option fails startup, not the first sign-in.
  await auth.$context;
  await app.listen({
    host: config.api.host,
    port: config.api.port,
    // Fastify logs this text; it must be an event name to pass the log filter (ADR 0005).
    listenTextResolver: () => 'http.listening',
  });
  logger.info('api.started', {
    host: config.api.host,
    port: config.api.port,
    node_version: process.version,
  });
  // Tell the operator what to do next; the code itself is read with `lakka setup-code`.
  if ((await getSetupStatus({ db })).required) {
    if (config.setup.code === undefined) logger.warn('setup.code_missing');
    else logger.info('setup.pending');
  }
} catch (error) {
  logger.fatal('api.start_failed', {}, error);
  process.exit(1);
}
