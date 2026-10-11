import { randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@lakka/contracts';
import {
  byTransport,
  configureCredentialsFromConfig,
  createAuth,
  createLocalUser,
  createLogger,
  createTracing,
  inProcessExecutor,
  noClassifier,
  subscribe,
  valkeyEvents,
  fixedCatalogue,
  loadCatalogue,
  loadConfig,
  readSandboxFacts,
  sandboxExecutor,
  valkeyRateLimitStorage,
} from '@lakka/core';
import type {
  Auth,
  CacheClient,
  CatalogueStore,
  ClassifierRuntime,
  FeedKey,
  Logger,
  ModelRateLimit,
  ToolExecutor,
  Tracing,
} from '@lakka/core';
import { createDb, createPool, ensureMonthlyPartitions, migrate } from '@lakka/db';
import type { Db, Pool } from '@lakka/db';
import { apiHealthChecks } from '../src/health.ts';
import { SlotPool } from '../src/sandbox/slots.ts';
import { createToolHost } from '../src/sandbox/tool-host.ts';
import type { ToolHost } from '../src/sandbox/tool-host.ts';
import { buildServer } from '../src/server.ts';
import type { ApiServer } from '../src/server.ts';
import { createTestDatabase } from '../../../test/integration/postgres.ts';
import type { TestDatabase } from '../../../test/integration/postgres.ts';
import { createTestCache, valkeyConfig } from '../../../test/integration/valkey.ts';

/** Shared setup for api integration tests: a real server over real Postgres and Valkey. */

export const PUBLIC_URL = 'http://localhost:8080';
const SECRET = 'integration-tests-only-auth-secret-0123456789abcdef';

export interface TestApp {
  app: ApiServer;
  setupCode: string | undefined;
  auth: Auth;
  db: Db;
  pool: Pool;
  /** The test database, for a child process that connects on its own. */
  database: TestDatabase;
  cache: CacheClient;
  logs: string[];
  /** The app's tracing, writing to its database as in production (ADR 0076). */
  tracing: Tracing;
  /**
   * The tool host stdio servers run in, in this process, with runners as child processes, as
   * the api uses the sandbox's (ADR 0118); and the key its egress tokens are signed with.
   */
  sandbox: { host: ToolHost; token: string; egressKey: string; egressProxyUrl: string };
  /** The executor the app runs MCP servers with, for tests that call the dispatch seam. */
  toolExecutor: ToolExecutor;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Private identity provider origins Better Auth may contact, e.g. a Dex test container. */
  privateIdpOrigins?: string[];
  /** The first-run setup code; random unless given, and null for an instance without one. */
  setupCode?: string | null;
  /** Replaces global fetch for provider credential tests. */
  providerFetch?: typeof fetch;
  /** The routing classifier; defaults to none. */
  classifier?: ClassifierRuntime;
  /** Listens for revocation events over Valkey; true unless a test turns it off. */
  revocationEvents?: boolean;
  /** How often live requests are checked against Postgres; the production default unless set. */
  recheckMs?: number;
  /** Serves with a database that cannot be reached, for tests of an outage (ADR 0056). */
  unreachableDatabase?: boolean;
  /** LAKKA_MCP_PRIVATE_ORIGINS for this app (ADR 0066 Q2). */
  mcpPrivateOrigins?: string[];
  /**
   * Origins on the instance's MCP allowlist from the start (NF-S4, ADR 0117), as an instance
   * admin would list them; allowMcpOrigins lists more later.
   */
  mcpAllowedOrigins?: string[];
  /**
   * Where MCP servers run (TL-8). Unless a test replaces it: stdio servers in a tool host in
   * this process, HTTP servers from the api, as in production (ADR 0118).
   */
  toolExecutor?: ToolExecutor;
  /** An OTLP backend to send traces to as well (OB-5). */
  otlp?: { endpoint: string; headers: Record<string, string> };
  /** How long shutdown lets in-flight requests finish (NF-O5); the production default unless set. */
  shutdownDrainMs?: number;
  /** More environment for the config the diagnostics bundle reads (AD-3), e.g. canary secrets. */
  configEnv?: Record<string, string>;
  /**
   * The per-person rate limit on model requests (BG-12); off unless given. Read on every
   * request, so a test may change it between requests.
   */
  modelRateLimit?: ModelRateLimit;
  /** The catalogue store, made once the database exists; the bundled file, fixed, unless given. */
  catalogue?: (db: Db, logger: Logger) => Promise<CatalogueStore>;
  /** Where price updates come from and the keys that check them (PR-6); production's unless given. */
  catalogueFeed?: { url: string | null; keys: readonly FeedKey[] };
}

// The credential key is process-wide, as in production; every test app shares one.
export const CREDENTIAL_KEY = randomBytes(32).toString('base64url');

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database: TestDatabase = await createTestDatabase();
  const pool = database.pool(10);
  await migrate(pool);
  await ensureMonthlyPartitions(pool);
  // As the api starts: v1 recorded against the database, then configured (ADR 0115).
  await configureCredentialsFromConfig(pool, loadConfig({ LAKKA_CREDENTIAL_KEY: CREDENTIAL_KEY }));
  const unreachable = options.unreachableDatabase === true ? unreachablePool() : undefined;
  await listOrigins(pool, options.mcpAllowedOrigins ?? []);
  const db = createDb(unreachable ?? pool);
  const cache = createTestCache();
  const logs: string[] = [];
  const { logger, frameworkLogger } = createLogger({
    level: 'debug',
    service: 'api-test',
    destination: { write: (line: string) => void logs.push(line) },
  });
  const auth = createAuth({
    db,
    cache,
    logger,
    config: {
      secret: SECRET,
      publicUrl: PUBLIC_URL,
      trustedOrigins: [PUBLIC_URL],
      privateIdpOrigins: options.privateIdpOrigins ?? [],
    },
  });
  const setupCode =
    options.setupCode === null
      ? undefined
      : (options.setupCode ?? randomBytes(32).toString('base64url'));
  const tracing = createTracing({ db, logger, otlp: options.otlp ?? null });
  const sandbox = await startToolHost(logger);
  const toolExecutor =
    options.toolExecutor ??
    byTransport({
      stdio: sandboxExecutor({
        toolHost: { kind: 'http', url: sandbox.url },
        token: () => sandbox.token,
        egress: { proxyUrl: sandbox.egressProxyUrl, key: () => sandbox.egressKey },
      }),
      http: inProcessExecutor,
    });
  const app = buildServer({
    logger,
    frameworkLogger,
    // What the api checks in production, with the test's classifier and provider fetch.
    ...apiHealthChecks({
      pool: unreachable ?? pool,
      db,
      cache,
      classifier: options.classifier ?? noClassifier,
      ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }),
    }),
    ...(options.shutdownDrainMs === undefined ? {} : { shutdownDrainMs: options.shutdownDrainMs }),
    diagnostics: {
      // The tool host in this process; no egress proxy runs in these tests.
      sandbox: () =>
        readSandboxFacts(
          { toolHost: { kind: 'http', url: sandbox.url }, egressProxyUrl: sandbox.egressProxyUrl },
          { toolHostToken: () => sandbox.token, egressKey: () => sandbox.egressKey },
        ),
      pool: unreachable ?? pool,
      // The config this app would have been started with: its own secrets, and the test's.
      config: loadConfig({
        LAKKA_AUTH_SECRET: SECRET,
        LAKKA_CREDENTIAL_KEY: CREDENTIAL_KEY,
        LAKKA_PUBLIC_URL: PUBLIC_URL,
        ...(setupCode === undefined ? {} : { LAKKA_SETUP_CODE: setupCode }),
        ...(options.otlp === undefined
          ? {}
          : {
              LAKKA_OTLP_ENDPOINT: options.otlp.endpoint,
              LAKKA_OTLP_HEADERS: Object.entries(options.otlp.headers)
                .map(([k, v]) => `${k}=${v}`)
                .join(','),
            }),
        ...options.configEnv,
      }),
    },
    auth: {
      context: { auth, db, events: valkeyEvents(cache, logger) },
      publicUrl: PUBLIC_URL,
      trustedOrigins: [PUBLIC_URL],
      rateLimit: valkeyRateLimitStorage(cache),
      cache,
      setup: { code: setupCode, credentialMasterKey: CREDENTIAL_KEY },
      catalogue:
        options.catalogue === undefined
          ? fixedCatalogue(loadCatalogue())
          : await options.catalogue(db, logger),
      ...(options.catalogueFeed === undefined ? {} : { catalogueFeed: options.catalogueFeed }),
      ...(options.providerFetch === undefined ? {} : { providerFetch: options.providerFetch }),
      ...(options.classifier === undefined ? {} : { classifier: options.classifier }),
      ...(options.mcpPrivateOrigins === undefined
        ? {}
        : { mcpPrivateOrigins: options.mcpPrivateOrigins }),
      toolExecutor,
      tracer: tracing.tracer,
      ...(options.otlp === undefined ? {} : { otlp: options.otlp }),
      ...(options.modelRateLimit === undefined ? {} : { modelRateLimit: options.modelRateLimit }),
      revocations: {
        ...(options.revocationEvents === false
          ? {}
          : {
              subscribe: (channels: string[], onMessage: (c: string, m: string) => void) =>
                subscribe(valkeyConfig(), 'lakka-tests-api-events', channels, onMessage),
            }),
        ...(options.recheckMs === undefined ? {} : { recheckMs: options.recheckMs }),
      },
    },
  });
  await app.ready();
  return {
    app,
    setupCode,
    auth,
    db,
    pool,
    database,
    cache,
    logs,
    tracing,
    sandbox: {
      host: sandbox.host,
      token: sandbox.token,
      egressKey: sandbox.egressKey,
      egressProxyUrl: sandbox.egressProxyUrl,
    },
    toolExecutor,
    async close() {
      await app.close();
      await sandbox.close();
      await tracing.shutdown();
      cache.close();
      await unreachable?.end();
      await database.drop();
    },
  };
}

const TOOL_RUNNER = fileURLToPath(new URL('../src/cli/tool-runner.ts', import.meta.url));

/**
 * A tool host on loopback, below root: runners are child processes of this one, with no uid of
 * their own (slots.ts). The egress proxy is not running; nothing in these tests needs it, and a
 * stdio server that tried would have no network, as in the sandbox.
 */
async function startToolHost(logger: Logger) {
  const root = mkdtempSync(join(tmpdir(), 'lakka-sandbox-'));
  const slots = new SlotPool({ count: 4, root, switchUser: false, logger });
  await slots.prepare();
  const token = randomBytes(32).toString('base64url');
  const host = createToolHost({
    token: () => token,
    slots,
    runner: [process.execPath, TOOL_RUNNER],
    logger,
  });
  await new Promise<void>((done) => host.server.listen(0, '127.0.0.1', done));
  return {
    host,
    token,
    url: `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`,
    egressKey: randomBytes(32).toString('base64url'),
    // Port 9, discard: nothing answers there.
    egressProxyUrl: 'http://127.0.0.1:9',
    async close() {
      await host.stop();
      host.server.closeAllConnections();
      await new Promise((done) => host.server.close(done));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function listOrigins(pool: Pool, urls: readonly string[]): Promise<void> {
  for (const url of urls) {
    await pool.query(
      `insert into mcp_allowed_origins (origin, source) values ($1, 'admin') on conflict do nothing`,
      [new URL(url).origin],
    );
  }
}

/**
 * Lists the origins of `urls` on the app's MCP allowlist (NF-S4), for a server or authorization
 * server a test starts after the app. Straight into the table: the admin API is tested on its own.
 */
export async function allowMcpOrigins(t: TestApp, ...urls: string[]): Promise<void> {
  await listOrigins(t.pool, urls);
}

/** A pool whose every connection is refused: nothing listens on port 1. */
function unreachablePool(): Pool {
  return createPool(
    {
      host: '127.0.0.1',
      port: 1,
      user: 'x',
      password: undefined,
      database: 'x',
      applicationName: 'dead',
    },
    () => undefined,
  );
}

// Test files run in parallel against one Valkey, and sign-in throttling counts per address, so
// each file gets its own random block of addresses.
const ipBlock = randomInt(0, 255);
let lastIp = 0;
/** A fresh client address per sign-in, so throttling never couples tests. */
export const clientIp = () => `10.${ipBlock}.${Math.floor(++lastIp / 250)}.${lastIp % 250}`;

export interface SignedInUser {
  principal: Principal;
  email: string;
  password: string;
  /** Cookie header value for this user's session. */
  cookie: string;
}

/** Signs an existing account in over HTTP and returns its session cookie header, or undefined. */
export async function signIn(
  t: TestApp,
  email: string,
  password: string,
): Promise<string | undefined> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: {
      origin: PUBLIC_URL,
      'content-type': 'application/json',
      'x-forwarded-for': clientIp(),
    },
    payload: { email, password },
  });
  const cookie = res.cookies.find((c) => c.name === 'lakka.session_token' && c.value !== '');
  return res.statusCode === 200 && cookie !== undefined
    ? `${cookie.name}=${cookie.value}`
    : undefined;
}

/** Creates a local account and signs it in over HTTP. */
export async function signedInUser(t: TestApp, name: string): Promise<SignedInUser> {
  const tag = randomBytes(4).toString('hex');
  const email = `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${tag}@example.com`;
  const password = `correct horse battery ${tag}`;
  const principal = await createLocalUser({ auth: t.auth, db: t.db }, { email, password, name });
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: {
      origin: PUBLIC_URL,
      'content-type': 'application/json',
      'x-forwarded-for': clientIp(),
    },
    payload: { email, password },
  });
  const cookie = res.cookies.find((c) => c.name === 'lakka.session_token');
  if (res.statusCode !== 200 || cookie === undefined)
    throw new Error(`sign-in failed: ${res.statusCode}`);
  return { principal, email, password, cookie: `${cookie.name}=${cookie.value}` };
}

/** Sends a request as a signed-in user, from our own origin. */
export function as(t: TestApp, user: SignedInUser) {
  const headers = { cookie: user.cookie, origin: PUBLIC_URL };
  return {
    get: (url: string) => t.app.inject({ method: 'GET', url, headers }),
    post: (url: string, payload: unknown) =>
      t.app.inject({ method: 'POST', url, headers, payload: payload as object }),
    patch: (url: string, payload: unknown) =>
      t.app.inject({ method: 'PATCH', url, headers, payload: payload as object }),
    put: (url: string, payload: unknown) =>
      t.app.inject({ method: 'PUT', url, headers, payload: payload as object }),
    delete: (url: string) => t.app.inject({ method: 'DELETE', url, headers }),
  };
}

const anonymousHeaders = () => ({ origin: PUBLIC_URL, 'x-forwarded-for': clientIp() });

/** An anonymous request from a fresh client address, from our own origin. */
export function anonymous(t: TestApp) {
  const headers = anonymousHeaders;
  return {
    get: (url: string) => t.app.inject({ method: 'GET', url, headers: headers() }),
    post: (url: string, payload: unknown) =>
      t.app.inject({ method: 'POST', url, headers: headers(), payload: payload as object }),
  };
}
