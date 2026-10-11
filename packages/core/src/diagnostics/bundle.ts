import { arch, cpus, freemem, loadavg, platform, release, totalmem, uptime } from 'node:os';
import type { HealthReport } from '@lakka/contracts';
import {
  readDatabaseFacts,
  readInstanceFacts,
  readJobFacts,
  readRecentErrorSpans,
  readTableFacts,
} from '@lakka/db';
import type { Pool } from '@lakka/db';
import type { CacheClient } from '../cache.ts';
import type { ClassifierRuntime } from '../classifier/runtime.ts';
import type { Config } from '../config.ts';
import type { TarEntry } from '../export/tar.ts';
import type { SandboxFacts } from '../tools/sandbox.ts';
import { LK, STORED_ATTRIBUTES } from '../gateway/telemetry.ts';

/*
 * The diagnostics bundle (AD-3, AC 17, ADR 0083): a tar.gz an operator attaches to a support
 * request. It is built from what is listed here, field by field, never by redacting a dump, so
 * anything new in the config, the database or a span stays out until someone lists it (H5).
 * Redaction fails open; an allowlist fails closed.
 *
 *   lakka-diagnostics/manifest.json   what this is, when, from where, and what it leaves out
 *   lakka-diagnostics/system.json     build, Node, OS, memory and uptime
 *   lakka-diagnostics/config.json     settings: addresses and whether each secret is set
 *   lakka-diagnostics/health.json     /healthz, per component (AD-5)
 *   lakka-diagnostics/database.json   Postgres version, settings, extensions, migrations,
 *                                        connections, and every table's size
 *   lakka-diagnostics/cache.json      Valkey version, memory and counters
 *   lakka-diagnostics/instance.json   counts by kind and state, per workspace id; provider
 *                                        kinds and test outcomes; retention settings; credential
 *                                        key versions and which is active
 *   lakka-diagnostics/jobs.json       background jobs by queue and state
 *   lakka-diagnostics/sandbox.json    whether the tool host and the egress proxy answer, and
 *                                        whether their key files are there (ADR 0118)
 *   lakka-diagnostics/errors.jsonl    the last day's failed spans, without who made them
 *
 * Never in it: credentials of any kind, prompts, replies, tool arguments, names, emails,
 * provider or MCP addresses beyond whether they are set, and log output, which the process
 * does not keep.
 *
 * A part that cannot be read, such as the database while it is down, says so in its file, and
 * the rest of the bundle is still written: it is most needed when something is broken.
 */

const ROOT = 'lakka-diagnostics';
const ERROR_SPAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const ERROR_SPAN_LIMIT = 200;

export interface DiagnosticsDeps {
  pool: Pool;
  cache: CacheClient;
  config: Config;
  /**
   * The process's own classifier, whose loading state goes in health.json. The operator command
   * has none: it asks the running api instead of loading the model (ADR 0083).
   */
  classifier?: ClassifierRuntime;
  health: () => Promise<HealthReport>;
  /** How the stdio sandbox is, as this process reaches it (ADR 0118). */
  sandbox?: () => Promise<SandboxFacts>;
  /** Who asked for it: an instance admin through the api, or the operator command. */
  generatedBy: { via: 'api'; principalId: string } | { via: 'operator' };
  now?: Date;
}

export function diagnosticsFilename(now: Date): string {
  return `lakka-diagnostics-${now.toISOString().replaceAll(/[:.]/g, '-')}.tar.gz`;
}

function json(value: unknown): Buffer {
  return Buffer.from(
    `${JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
  );
}

/** The origin of an address: never its path, query or credentials. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The settings, each listed by hand. Secrets appear only as whether they are set; the OTLP
 * endpoint only as its origin, since a path or query can carry a key.
 */
export function configSummary(config: Config) {
  return {
    logLevel: config.logLevel,
    database: {
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      passwordSet: config.database.password !== undefined,
    },
    cache: {
      host: config.cache.host,
      port: config.cache.port,
      passwordSet: config.cache.password !== undefined,
    },
    api: { host: config.api.host, port: config.api.port },
    worker: { healthHost: config.worker.healthHost, healthPort: config.worker.healthPort },
    classifier: { modelDir: config.classifier.modelDir, threads: config.classifier.threads },
    auth: {
      publicUrl: originOf(config.auth.publicUrl),
      trustedOrigins: config.auth.trustedOrigins.map(originOf),
      privateIdpOrigins: config.auth.privateIdpOrigins.map(originOf),
      secretSet: config.auth.secret !== undefined,
    },
    // Which key versions this process was given, never a key (ADR 0115); the active version is
    // in instance.json, since Postgres decides it.
    credentials: {
      masterKeySet: config.credentials.keys.size > 0,
      keyVersions: [...config.credentials.keys.keys()].toSorted((a, b) => a - b),
      keySource: config.credentials.source,
    },
    mcp: { privateOrigins: config.mcp.privateOrigins.map(originOf) },
    otlp:
      config.otlp === null
        ? { enabled: false }
        : {
            enabled: true,
            destination: originOf(config.otlp.endpoint),
            headerCount: Object.keys(config.otlp.headers).length,
          },
    setup: { codeSet: config.setup.code !== undefined },
    // Where price updates would come from, as an origin; null when an operator locked them off.
    catalogueFeed: {
      locked: config.catalogueFeed.url === null,
      origin: config.catalogueFeed.url === null ? null : originOf(config.catalogueFeed.url),
    },
    build: config.build,
    // Where stdio servers run: the socket's path is the image's own, never a secret.
    sandbox: {
      toolHost:
        config.sandbox.toolHost.kind === 'unix'
          ? { kind: 'unix', path: config.sandbox.toolHost.path }
          : config.sandbox.toolHost.kind === 'http'
            ? { kind: 'http', origin: originOf(config.sandbox.toolHost.url) }
            : { kind: 'in-process' },
      egressProxy: originOf(config.sandbox.egressProxyUrl),
      slots: config.sandbox.slots,
    },
  };
}

/** The Valkey INFO fields support needs, by name; everything else in INFO stays out. */
const CACHE_INFO_FIELDS = new Set([
  'redis_version',
  'valkey_version',
  'redis_mode',
  'server_mode',
  'os',
  'arch_bits',
  'uptime_in_seconds',
  'connected_clients',
  'blocked_clients',
  'used_memory',
  'used_memory_peak',
  'maxmemory',
  'maxmemory_policy',
  'mem_fragmentation_ratio',
  'total_connections_received',
  'total_commands_processed',
  'rejected_connections',
  'expired_keys',
  'evicted_keys',
  'keyspace_hits',
  'keyspace_misses',
  'pubsub_channels',
  'role',
  'aof_enabled',
  'rdb_last_bgsave_status',
]);

export function cacheInfoSummary(info: string): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const line of info.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0 || line.startsWith('#')) continue;
    const name = line.slice(0, at);
    if (CACHE_INFO_FIELDS.has(name)) picked[name] = line.slice(at + 1).trim();
  }
  return picked;
}

/** Span attributes that say what happened, not who asked: the stored set, minus people. */
const BUNDLE_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set(
  [...STORED_ATTRIBUTES].filter(
    (name) =>
      name !== LK.PRINCIPAL_ID &&
      name !== LK.ACTING_USER_ID &&
      name !== LK.TOOL_CREDENTIAL_PRINCIPAL &&
      name !== LK.CONVERSATION_ID,
  ),
);

export function errorSpanSummary(row: Record<string, unknown>) {
  const attributes =
    row['attributes'] !== null && typeof row['attributes'] === 'object'
      ? Object.fromEntries(
          Object.entries(row['attributes']).filter(([name]) => BUNDLE_SPAN_ATTRIBUTES.has(name)),
        )
      : {};
  const events = Array.isArray(row['events'])
    ? row['events'].map((e: unknown) =>
        e !== null && typeof e === 'object' && 'name' in e && 'atMs' in e
          ? { name: e.name, atMs: e.atMs }
          : null,
      )
    : [];
  return {
    traceId: row['trace_id'],
    spanId: row['span_id'],
    parentSpanId: row['parent_span_id'],
    workspaceId: row['workspace_id'],
    requestId: row['request_id'],
    name: row['name'],
    kind: row['kind'],
    status: row['status'],
    errorType: row['error_type'],
    startedAt: row['started_at'],
    durationMs: row['duration_ms'],
    attributes,
    events,
  };
}

/** Runs one part; a failure becomes a note in its file instead of ending the bundle. */
async function part<T>(read: () => Promise<T>): Promise<T | { unavailable: true }> {
  try {
    return await read();
  } catch {
    return { unavailable: true };
  }
}

export async function* diagnosticsEntries(deps: DiagnosticsDeps): AsyncGenerator<TarEntry> {
  const now = deps.now ?? new Date();
  const file = (name: string, value: unknown): TarEntry => ({
    name: `${ROOT}/${name}`,
    data: json(value),
    mtime: now,
  });

  yield file('manifest.json', {
    format: 'lakka.diagnostics',
    version: 1,
    generatedAt: now.toISOString(),
    generatedBy: deps.generatedBy,
    build: deps.config.build,
    leftOut:
      'Credentials, prompts, replies, tool arguments, names, emails, addresses of providers ' +
      'and MCP servers, and logs. Collect logs separately with `docker compose logs` if asked.',
  });

  const memory = process.memoryUsage();
  yield file('system.json', {
    build: deps.config.build,
    node: process.version,
    platform: platform(),
    osRelease: release(),
    arch: arch(),
    cpus: cpus().length,
    loadAverage: loadavg(),
    memoryBytes: { total: totalmem(), free: freemem() },
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
    systemUptimeSeconds: Math.round(uptime()),
  });

  yield file('config.json', configSummary(deps.config));
  yield file(
    'health.json',
    await part(async () => ({
      ...(await deps.health()),
      ...(deps.classifier === undefined ? {} : { classifierState: deps.classifier.status() }),
    })),
  );
  yield file(
    'database.json',
    await part(async () => ({
      ...(await readDatabaseFacts(deps.pool)),
      tables: await readTableFacts(deps.pool),
    })),
  );
  yield file(
    'cache.json',
    await part(async () => {
      const { info, keys } = await deps.cache.serverInfo();
      return { ...cacheInfoSummary(info), keys };
    }),
  );
  yield file('instance.json', await part(() => readInstanceFacts(deps.pool)));
  yield file('jobs.json', await part(async () => ({ jobs: await readJobFacts(deps.pool) })));
  const { sandbox } = deps;
  if (sandbox !== undefined) yield file('sandbox.json', await part(sandbox));

  const spans = await part(() =>
    readRecentErrorSpans(
      deps.pool,
      new Date(now.getTime() - ERROR_SPAN_WINDOW_MS),
      ERROR_SPAN_LIMIT,
    ),
  );
  yield {
    name: `${ROOT}/errors.jsonl`,
    data: Buffer.from(
      Array.isArray(spans)
        ? spans.map((s) => JSON.stringify(errorSpanSummary(s))).join('\n') +
            (spans.length > 0 ? '\n' : '')
        : `${JSON.stringify(spans)}\n`,
    ),
    mtime: now,
  };
}
