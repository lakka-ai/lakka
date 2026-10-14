import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import type { ApiErrorBody } from '@lakka/contracts';
import { LakkaError, McpOriginNotAllowedError, RateLimitedError } from '@lakka/contracts';
import { checkHealth } from '@lakka/core';
import {
  DEFAULT_CATALOGUE_FEED_URL,
  liveRequests,
  noClassifier,
  policySnapshots,
  PRODUCTION_FEED_KEYS,
  watchRevocations,
} from '@lakka/core';
import type {
  AuthContext,
  CacheClient,
  CacheSubscription,
  CatalogueStore,
  ClassifierRuntime,
  Config,
  FeedKey,
  FrameworkLogger,
  HealthCheck,
  Logger,
  ModelRateLimit,
  PipelineContext,
  RateLimitStorage,
  SandboxFacts,
  ToolExecutor,
} from '@lakka/core';
import type { Pool } from '@lakka/db';
import { authRoutes } from './auth-routes.ts';
import { inviteRoutes } from './invite-routes.ts';
import { passwordResetRoutes } from './password-reset-routes.ts';
import { keyRoutes } from './key-routes.ts';
import { modelsRoutes } from './models-routes.ts';
import { originCheck } from './origin-check.ts';
import { principalRoutes } from './principal-routes.ts';
import { providersRoutes } from './providers-routes.ts';
import { mcpRoutes } from './mcp-routes.ts';
import { routingRoutes } from './routing-routes.ts';
import { openAiRoutes, SHUTDOWN_DRAIN_MS, STREAM_END_WAIT_MS } from './openai/routes.ts';
import { budgetRoutes } from './budget-routes.ts';
import { conversationRoutes } from './conversation-routes.ts';
import { setupRoutes } from './setup-routes.ts';
import { ssoRoutes } from './sso-routes.ts';
import { retentionRoutes } from './retention-routes.ts';
import { diagnosticsRoutes } from './diagnostics-routes.ts';
import { workspaceRoutes } from './workspace-routes.ts';

export interface ServerDeps {
  logger: Logger;
  frameworkLogger: FrameworkLogger;
  /** Required dependencies: one down makes /healthz answer 503. */
  healthChecks: Readonly<Record<string, HealthCheck>>;
  /** The classifier and providers: reported, but one down only degrades (ADR 0081). */
  optionalHealthChecks?: () => Promise<Readonly<Record<string, HealthCheck>>>;
  healthTimeoutMs?: number;
  /** How long shutdown lets in-flight requests finish before ending them (NF-O5, ADR 0081). */
  shutdownDrainMs?: number;
  /** What the diagnostics bundle reads (AD-3, ADR 0083); without it, there is no bundle route. */
  diagnostics?: { config: Config; pool: Pool; sandbox?: () => Promise<SandboxFacts> };
  /** Sign-in, sessions, setup and everything behind them. Omitted only in tests without them. */
  auth?: {
    context: AuthContext;
    publicUrl: string;
    trustedOrigins: readonly string[];
    /** Throttles public endpoints that take secrets or hash passwords. */
    rateLimit: RateLimitStorage;
    /** Valkey, for budget counters (ADR 0050). */
    cache: CacheClient;
    setup: { code: string | undefined; credentialMasterKey: string };
    /**
     * The model catalogue: the bundled file, with the signed price feed merged in while it is on
     * (ADR 0037, ADR 0116).
     */
    catalogue: CatalogueStore;
    /**
     * Where the price feed comes from, null when an operator locked it off, and the keys that
     * check it. The project's address and the baked-in keys unless a test gives others.
     */
    catalogueFeed?: { url: string | null; keys?: readonly FeedKey[] };
    /** Replaces global fetch for provider credential tests. Tests only. */
    providerFetch?: typeof fetch;
    /** The routing classifier; none means routing falls back to defaults (invariant 10). */
    classifier?: ClassifierRuntime;
    /** MCP server origins on a private network workspace admins may use (ADR 0066 Q2). */
    mcpPrivateOrigins?: readonly string[];
    /**
     * Where MCP servers are started and called (TL-8, ADR 0070): stdio servers in the sandbox,
     * HTTP servers from the api (ADR 0118). Required, so nothing falls back to running a stdio
     * server in the api.
     */
    toolExecutor: ToolExecutor;
    /** Where the pipeline's spans go: the process's own tracer (OB-1, ADR 0076). */
    tracer?: PipelineContext['tracer'];
    /** Where traces are also sent, if anywhere, for instance admins to see (OB-5, ADR 0080). */
    otlp?: { endpoint: string } | null;
    /** How many model requests one person may start (BG-12); none, or 0 per minute, is off. */
    modelRateLimit?: ModelRateLimit;
    /**
     * Revocation events, so live streams end when access is revoked (AC 6, ADR 0063). Without a
     * subscription, the periodic check against Postgres still ends them.
     */
    revocations?: {
      subscribe?: (
        channels: string[],
        onMessage: (channel: string, message: string) => void,
      ) => Promise<CacheSubscription>;
      /** Tests shorten it; production uses DEFAULT_RECHECK_MS. */
      recheckMs?: number;
    };
  };
}

/** Fastify's own default, kept for plugins loading at startup. */
const DEFAULT_PLUGIN_TIMEOUT_MS = 10_000;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * HTTP status for our own error codes, the same as the OpenAI surface gives each (API-5). A
 * test checks every error class is listed here or in PROCESS_ONLY_CODES.
 */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  invalid_request: 400,
  confirmation_mismatch: 400,
  unauthenticated: 401,
  forbidden: 403,
  access_revoked: 403,
  not_found: 404,
  slug_taken: 409,
  last_workspace_admin: 409,
  last_instance_admin: 409,
  retention_running: 409,
  model_exists: 409,
  catalogue_feed_off: 409,
  catalogue_feed_locked: 409,
  catalogue_feed_no_key: 409,
  provider_exists: 409,
  mcp_server_exists: 409,
  mcp_oauth_client_required: 422,
  mcp_origin_not_allowed: 422,
  mcp_oauth_failed: 502,
  provider_not_configured: 422,
  no_model: 422,
  unsupported_input: 422,
  budget_exceeded: 402,
  budget_unavailable: 503,
  route_exists: 409,
  signal_claimed: 409,
  candidate_gone: 404,
  unknown_model: 404,
  cannot_suspend_self: 409,
  cannot_delete_self: 409,
  setup_complete: 409,
  invalid_setup_code: 403,
  invite_invalid: 404,
  reset_invalid: 404,
  already_member: 409,
  email_taken: 409,
  rate_limited: 429,
  // A provider's answer, when an /api route reaches one: the request, or Lakka's key, is
  // what failed, not the server.
  context_too_long: 400,
  output_too_long: 400,
  content_filtered: 400,
  provider_rejected_request: 400,
  provider_auth_failed: 502,
  provider_billing: 502,
  provider_model_not_found: 502,
  upstream_unavailable: 502,
  stream_interrupted: 502,
  // A stored credential names a key version this server was not given: its fault, not the
  // request's (ADR 0115).
  credential_key_unavailable: 500,
};

/**
 * Codes only a starting process or an operator command raises, which stop it rather than answer
 * a request: 500.
 */
export const PROCESS_ONLY_CODES: ReadonlySet<string> = new Set([
  'config_invalid',
  'schema_mismatch',
  'migration_lock_timeout',
  'credential_key_missing',
  'credential_key_mismatch',
  'credential_unreadable',
  'credential_key_in_use',
  'database_in_use',
]);

/**
 * Builds the API server. It is a thin adapter: behaviour lives in core (CLAUDE.md invariant 1).
 * Dependencies are injected so tests run without a database or cache.
 */
export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    loggerInstance: deps.frameworkLogger,
    // Avvio's timeout covers preClose hooks too, and the shutdown drain runs in one; at the
    // default 10 s, a drain longer than that fails close() (NF-O5, ADR 0081).
    pluginTimeout:
      (deps.shutdownDrainMs ?? SHUTDOWN_DRAIN_MS) + STREAM_END_WAIT_MS + DEFAULT_PLUGIN_TIMEOUT_MS,
    // Fastify's request log lines include the raw URL (with query string). We log requests
    // ourselves in onResponse with the route pattern instead (ADR 0005).
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    // Accept an upstream request id only if it looks like one; it is untrusted input.
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    // The api serves data, never pages: nothing it returns may run, be framed or be sniffed
    // (ADR 0085). A route that serves files sets a stricter policy of its own.
    if (!reply.hasHeader('content-security-policy')) {
      void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
  });

  app.addHook('onResponse', async (request, reply) => {
    deps.logger.info('http.request', {
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status_code: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const status = statusOf(error);
    if (error instanceof RateLimitedError) {
      void reply.header('retry-after', String(error.retryAfterSeconds));
    }
    if (status >= 500) {
      deps.logger.error('http.unhandled_error', { request_id: request.id }, error);
    }
    const body: ApiErrorBody =
      error instanceof LakkaError
        ? { error: { code: error.code, message: error.message, ...detailsOf(error) } }
        : status >= 500
          ? { error: { code: 'internal_error', message: 'Internal server error' } }
          : { error: { code: 'bad_request', message: 'The request could not be processed' } };
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler(async (_request, reply) => {
    const body: ApiErrorBody = { error: { code: 'not_found', message: 'Not found' } };
    return reply.status(404).send(body);
  });

  // AD-5: per-dependency status. 503 when a required dependency is down, so orchestrators and
  // operators see the failure; 200 and `degraded` when only the classifier or a provider is
  // (ADR 0017, ADR 0081).
  const health = () =>
    checkHealth(deps.healthChecks, {
      timeoutMs: deps.healthTimeoutMs ?? 2000,
      ...(deps.optionalHealthChecks === undefined ? {} : { optional: deps.optionalHealthChecks }),
      logger: deps.logger,
    });
  app.get('/healthz', async (_request, reply) => {
    const report = await health();
    return reply.status(report.status === 'down' ? 503 : 200).send(report);
  });

  if (deps.auth !== undefined) {
    app.decorateRequest('principal', null);
    app.addHook('onRequest', originCheck(deps.auth.trustedOrigins));
    void app.register(authRoutes, { context: deps.auth.context, publicUrl: deps.auth.publicUrl });
    void app.register(workspaceRoutes, { context: deps.auth.context, logger: deps.logger });
    void app.register(retentionRoutes, {
      auth: deps.auth.context,
      retention: {
        db: deps.auth.context.db,
        pool: deps.auth.context.db.$client,
        logger: deps.logger,
      },
      otlp: deps.auth.otlp ?? null,
      logger: deps.logger,
    });
    void app.register(keyRoutes, { context: deps.auth.context });
    void app.register(budgetRoutes, {
      context: deps.auth.context,
      catalogue: deps.auth.catalogue,
      cache: deps.auth.cache,
      logger: deps.logger,
    });
    void app.register(conversationRoutes, {
      context: deps.auth.context,
      catalogue: deps.auth.catalogue,
    });
    void app.register(principalRoutes, { context: deps.auth.context, logger: deps.logger });
    void app.register(ssoRoutes, { context: deps.auth.context, publicUrl: deps.auth.publicUrl });
    void app.register(setupRoutes, {
      context: {
        auth: deps.auth.context.auth,
        db: deps.auth.context.db,
        setupCode: deps.auth.setup.code,
        credentialMasterKey: deps.auth.setup.credentialMasterKey,
      },
      rateLimit: deps.auth.rateLimit,
      logger: deps.logger,
    });
    void app.register(modelsRoutes, {
      auth: deps.auth.context,
      models: { db: deps.auth.context.db, catalogue: deps.auth.catalogue },
      feed: {
        db: deps.auth.context.db,
        catalogue: deps.auth.catalogue,
        logger: deps.logger,
        feed: {
          url:
            deps.auth.catalogueFeed === undefined
              ? DEFAULT_CATALOGUE_FEED_URL
              : deps.auth.catalogueFeed.url,
          keys: deps.auth.catalogueFeed?.keys ?? PRODUCTION_FEED_KEYS,
        },
      },
      logger: deps.logger,
    });
    void app.register(providersRoutes, {
      auth: deps.auth.context,
      providers: {
        db: deps.auth.context.db,
        events: deps.auth.context.events,
        ...(deps.auth.providerFetch === undefined ? {} : { fetch: deps.auth.providerFetch }),
      },
      logger: deps.logger,
    });
    // One policy cache for the admin routes and for requests, so both see every version bump.
    const snapshots = policySnapshots({ db: deps.auth.context.db });
    void app.register(mcpRoutes, {
      auth: deps.auth.context,
      mcp: {
        ...deps.auth.context,
        mcpPrivateOrigins: deps.auth.mcpPrivateOrigins ?? [],
        publicUrl: deps.auth.publicUrl,
        executor: deps.auth.toolExecutor,
        snapshots,
      },
      logger: deps.logger,
    });
    // Requests streaming in this process, ended when their access is revoked (ADR 0063).
    const live = liveRequests(deps.logger);
    const revocations = deps.auth.revocations;
    let watcher: { close(): void } | null = null;
    const db = deps.auth.context.db;
    app.addHook('onReady', async () => {
      watcher = await watchRevocations({
        live,
        db,
        logger: deps.logger,
        ...(revocations?.subscribe === undefined ? {} : { subscribe: revocations.subscribe }),
        ...(revocations?.recheckMs === undefined ? {} : { recheckMs: revocations.recheckMs }),
      });
    });
    app.addHook('onClose', async () => watcher?.close());
    void app.register(routingRoutes, {
      auth: deps.auth.context,
      routing: {
        db: deps.auth.context.db,
        events: deps.auth.context.events,
        catalogue: deps.auth.catalogue,
        classifier: deps.auth.classifier ?? noClassifier,
        snapshots,
        logger: deps.logger,
      },
      logger: deps.logger,
    });
    if (deps.diagnostics !== undefined) {
      void app.register(diagnosticsRoutes, {
        auth: deps.auth.context,
        pool: deps.diagnostics.pool,
        cache: deps.auth.cache,
        config: deps.diagnostics.config,
        classifier: deps.auth.classifier ?? noClassifier,
        health,
        ...(deps.diagnostics.sandbox === undefined ? {} : { sandbox: deps.diagnostics.sandbox }),
        logger: deps.logger,
      });
    }
    void app.register(openAiRoutes, {
      auth: deps.auth.context,
      ...(deps.shutdownDrainMs === undefined ? {} : { shutdownDrainMs: deps.shutdownDrainMs }),
      pipeline: {
        db: deps.auth.context.db,
        events: deps.auth.context.events,
        catalogue: deps.auth.catalogue,
        logger: deps.logger,
        cache: deps.auth.cache,
        classifier: deps.auth.classifier ?? noClassifier,
        snapshots,
        live,
        ...(deps.auth.tracer === undefined ? {} : { tracer: deps.auth.tracer }),
        ...(deps.auth.modelRateLimit === undefined
          ? {}
          : { modelRateLimit: deps.auth.modelRateLimit }),
        tools: {
          executor: deps.auth.toolExecutor,
          mcpPrivateOrigins: deps.auth.mcpPrivateOrigins ?? [],
          publicUrl: deps.auth.publicUrl,
        },
      },
      logger: deps.logger,
    });
    void app.register(inviteRoutes, {
      context: deps.auth.context,
      rateLimit: deps.auth.rateLimit,
      logger: deps.logger,
    });
    void app.register(passwordResetRoutes, {
      context: deps.auth.context,
      rateLimit: deps.auth.rateLimit,
      logger: deps.logger,
    });
  }

  return app;
}

export type ApiServer = ReturnType<typeof buildServer>;

/** What an error needs to be acted on, for the few that carry it. */
function detailsOf(error: LakkaError): Pick<ApiErrorBody['error'], 'details'> {
  // The origin an instance admin would list; the person asking already gave or saw it.
  if (error instanceof McpOriginNotAllowedError) return { details: { origin: error.origin } };
  return {};
}

function statusOf(error: unknown): number {
  if (error instanceof LakkaError) return STATUS_BY_CODE[error.code] ?? 500;
  const code: unknown = (error as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' && code >= 400 && code <= 599 ? code : 500;
}
