import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigError } from '@lakka/contracts';
import { DEFAULT_CATALOGUE_FEED_URL } from './models/feed.ts';
import { normaliseOrigin } from './net/egress-policy.ts';

/** Returns the named secret, or undefined when it does not exist. */
export type SecretReader = (name: string) => string | undefined;

export const noSecrets: SecretReader = () => undefined;

/** Returns the names of the secrets that exist; used for the numbered credential key files. */
export type SecretLister = () => string[];

/** Lists the secrets directory; a missing directory has no secrets. */
export function fileSecretLister(dir: string): SecretLister {
  return () => {
    try {
      return readdirSync(dir);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new ConfigError('the secrets directory could not be listed', { cause: error });
    }
  };
}

/**
 * Reads secrets written by the compose `init` service: one file per secret in `dir`
 * (ADR 0004). A missing file means the secret is not set.
 */
export function fileSecretReader(dir: string): SecretReader {
  return (name) => {
    try {
      const value = readFileSync(join(dir, name), 'utf8').trim();
      return value === '' ? undefined : value;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new ConfigError(`secret '${name}' could not be read from the secrets directory`, {
        cause: error,
      });
    }
  };
}

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const port = z.coerce.number().int().min(1).max(65535);
const host = z.string().min(1);

// Defaults match the service names in docker/compose.yaml, so the compose file needs no
// settings of its own (NF-D3). Env var names are a stability contract (ADR 0003).
/** A version or commit label: short, and safe to print anywhere. */
const BUILD_LABEL = /^[A-Za-z0-9._+-]{1,64}$/;

const envSchema = z.object({
  LAKKA_LOG_LEVEL: logLevel.default('info'),
  LAKKA_SECRETS_DIR: z.string().min(1).optional(),

  LAKKA_DATABASE_HOST: host.default('postgres'),
  LAKKA_DATABASE_PORT: port.default(5432),
  LAKKA_DATABASE_USER: z.string().min(1).default('lakka'),
  LAKKA_DATABASE_NAME: z.string().min(1).default('lakka'),
  LAKKA_DATABASE_PASSWORD: z.string().min(1).optional(),

  LAKKA_CACHE_HOST: host.default('valkey'),
  LAKKA_CACHE_PORT: port.default(6379),
  LAKKA_CACHE_PASSWORD: z.string().min(1).optional(),

  LAKKA_API_HOST: host.default('0.0.0.0'),
  LAKKA_API_PORT: port.default(3000),
  LAKKA_WORKER_HEALTH_HOST: host.default('0.0.0.0'),
  LAKKA_WORKER_HEALTH_PORT: port.default(3001),

  LAKKA_CLASSIFIER_MODEL_DIR: z.string().min(1).optional(),
  LAKKA_CLASSIFIER_THREADS: z.coerce.number().int().min(1).max(64).default(1),

  /** The address people open in a browser. Derived from LAKKA_DOMAIN or the port if unset. */
  LAKKA_PUBLIC_URL: z.url().optional(),
  LAKKA_DOMAIN: host.optional(),
  LAKKA_HTTP_PORT: port.default(8080),
  LAKKA_AUTH_SECRET: z.string().min(32).optional(),
  /** Encrypts stored credentials such as OIDC client secrets (ADR 0032). 32 bytes, base64url. */
  LAKKA_CREDENTIAL_KEY: z.string().min(43).optional(),
  /**
   * Every credential key version, as "2:<key>,1:<key>" (ADR 0115). Set, it replaces
   * LAKKA_CREDENTIAL_KEY and the key files entirely, and rotation never generates a key.
   */
  LAKKA_CREDENTIAL_KEYS: z.string().min(1).optional(),
  /** Proves that whoever completes first-run setup has access to the server (ADR 0034). */
  LAKKA_SETUP_CODE: z.string().min(16).optional(),
  /**
   * Comma-separated origins of identity providers on a private network. Better Auth refuses
   * loopback and private addresses unless listed here (ADR 0032).
   */
  LAKKA_OIDC_PRIVATE_ORIGINS: z.string().optional(),
  /**
   * Comma-separated origins of MCP servers on a private network that workspace admins may
   * configure; instance admins' servers need no listing (ADR 0066 Q2).
   */
  LAKKA_MCP_PRIVATE_ORIGINS: z.string().optional(),
  /**
   * Where traces are also sent, over OTLP/HTTP, e.g. https://collector.example.com/v1/traces.
   * Unset, nothing is sent (OB-5, NF-P1, ADR 0080). The standard OTEL_* variables are ignored on
   * purpose: a platform that sets them for every container must not turn this on.
   */
  LAKKA_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  /** Headers for that endpoint, such as a key: name=value pairs, comma-separated. */
  LAKKA_OTLP_HEADERS: z.string().optional(),

  /** Model requests one person, their keys included, may start per minute; 0 is off (BG-12). */
  LAKKA_MODEL_REQUESTS_PER_MINUTE: z.coerce.number().int().min(0).default(120),
  /**
   * How many they may start at once before the rate applies. At least 1: a bucket that holds
   * nothing would refuse every request.
   */
  LAKKA_MODEL_REQUEST_BURST: z.coerce.number().int().min(1).default(60),

  /**
   * Where the signed price feed is fetched from once an instance admin turns it on (PR-6, ADR
   * 0116): an https mirror, since the signature binds the content, not the host. "off" hides the
   * switch and keeps it off. Unset, the project's own file on GitHub.
   */
  LAKKA_CATALOGUE_FEED_URL: z
    .union([
      z.literal('off'),
      z.url({ protocol: /^https$/ }).refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return url.username === '' && url.password === '' && url.hash === '';
      }),
    ])
    .optional(),

  /**
   * Where the api sends stdio MCP servers' operations (NF-S4, ADR 0118): the sandbox's tool host
   * on its socket by default; http://host:port for a tool host on a network; "in-process" runs
   * them in the api, for `pnpm dev` only, and is refused in production.
   */
  LAKKA_TOOL_HOST_URL: z.string().min(1).optional(),
  /** The egress proxy a stdio server in the sandbox must use; the compose service by default. */
  LAKKA_EGRESS_PROXY_URL: z
    .url({ protocol: /^http$/ })
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return url.username === '' && url.password === '' && url.pathname === '/';
    })
    .optional(),
  /** How many stdio operations the sandbox runs at once, each under a uid of its own. */
  LAKKA_SANDBOX_SLOTS: z.coerce.number().int().min(1).max(64).default(8),

  /** What the image was built from, set at build time; for the diagnostics bundle (AD-3). */
  LAKKA_VERSION: z.string().regex(BUILD_LABEL).optional(),
  LAKKA_REVISION: z.string().regex(BUILD_LABEL).optional(),
});

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** name=value pairs, comma-separated; a malformed one is named in the error, never its value. */
function parseHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === '') return {};
  const headers: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    if (at <= 0 || !HEADER_NAME.test(name)) {
      throw new ConfigError('invalid configuration: LAKKA_OTLP_HEADERS');
    }
    headers[name] = pair.slice(at + 1).trim();
  }
  return headers;
}

/**
 * The bundled model sits at <repo>/models/paraphrase-multilingual-MiniLM-L12-v2, both in a checkout (after
 * `pnpm models:fetch`) and in the image (/app/models). Resolving from this file keeps one default
 * for both. The model is a setting, not a build-time constant (NF-A3, ADR 0022).
 */
export const DEFAULT_CLASSIFIER_MODEL_DIR = fileURLToPath(
  new URL('../../../models/paraphrase-multilingual-MiniLM-L12-v2', import.meta.url),
);

export type LogLevel = z.infer<typeof logLevel>;

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  database: string;
  password: string | undefined;
}

export interface CacheConfig {
  host: string;
  port: number;
  password: string | undefined;
}

export interface Config {
  logLevel: LogLevel;
  database: DatabaseConfig;
  cache: CacheConfig;
  api: { host: string; port: number };
  worker: { healthHost: string; healthPort: number };
  classifier: { modelDir: string; threads: number };
  auth: {
    /** Signs session cookies. Required by the api; generated on first run (ADR 0004). */
    secret: string | undefined;
    /** Origin of the public address, e.g. http://localhost:8080. */
    publicUrl: string;
    /** Origins allowed to make cookie-authenticated, state-changing requests (ADR 0006). */
    trustedOrigins: string[];
    /** Private-network identity provider origins Better Auth may contact (ADR 0032). */
    privateIdpOrigins: string[];
  };
  credentials: {
    /**
     * The credential master keys by version, base64url (ADR 0115). Required by any process that
     * reads encrypted credentials; v1 is generated on first run. Which version is active is
     * Postgres's to say, not this config's.
     */
    keys: ReadonlyMap<number, string>;
    /** 'env' when LAKKA_CREDENTIAL_KEYS lists them; then nothing generates or removes a key. */
    source: 'env' | 'secrets';
  };
  mcp: {
    /** Private-network MCP server origins workspace admins may configure (ADR 0066 Q2). */
    privateOrigins: string[];
  };
  /** OTLP export of traces, off unless an operator set an endpoint (OB-5, ADR 0080). */
  otlp: { endpoint: string; headers: Record<string, string> } | null;
  /** The per-person rate limit on model requests; 0 per minute turns it off (BG-12). */
  modelRateLimit: { perMinute: number; burst: number };
  setup: {
    /** Required to complete first-run setup. Generated on first run (ADR 0034). */
    code: string | undefined;
  };
  /** What this build is: a release version and commit, or 'dev' and 'unknown' from source. */
  build: { version: string; revision: string };
  /** The signed price feed's address, or null when an operator locked it off (ADR 0116). */
  catalogueFeed: { url: string | null };
  /** Where stdio MCP servers run, and how they reach the network (NF-S4, ADR 0118). */
  sandbox: {
    toolHost: ToolHostAddress;
    /** The egress proxy's origin, as a stdio server in the sandbox reaches it. */
    egressProxyUrl: string;
    /** Operations the tool host runs at once. */
    slots: number;
  };
}

/** Where the tool host listens, and the api connects. */
export type ToolHostAddress =
  | { kind: 'unix'; path: string }
  | { kind: 'http'; url: string }
  | { kind: 'in-process' };

/** The tool host's socket, in the tool-host volume the api and the sandbox share. */
export const DEFAULT_TOOL_HOST_SOCKET = '/run/lakka/tool-host/tool-host.sock';
export const DEFAULT_EGRESS_PROXY_URL = 'http://egress:3128';

/**
 * LAKKA_TOOL_HOST_URL: unix:/absolute/path, http://host:port, or in-process. In-process runs
 * stdio servers inside the api with its network and its secrets, so a production image refuses
 * it rather than lose the sandbox to a stray setting.
 */
function toolHostAddress(value: string | undefined, nodeEnv: string | undefined): ToolHostAddress {
  if (value === undefined) return { kind: 'unix', path: DEFAULT_TOOL_HOST_SOCKET };
  if (value === 'in-process') {
    if (nodeEnv === 'production') {
      throw new ConfigError(
        'invalid configuration: LAKKA_TOOL_HOST_URL cannot be in-process in production',
      );
    }
    return { kind: 'in-process' };
  }
  if (value.startsWith('unix:/') && !value.includes('\0')) {
    return { kind: 'unix', path: value.slice('unix:'.length) };
  }
  if (URL.canParse(value)) {
    const url = new URL(value);
    if (
      url.protocol === 'http:' &&
      url.port !== '' &&
      url.pathname === '/' &&
      url.username === ''
    ) {
      return { kind: 'http', url: url.origin };
    }
  }
  throw new ConfigError('invalid configuration: LAKKA_TOOL_HOST_URL');
}

/**
 * Builds the backend config from environment variables. Pure: the caller supplies the env and
 * a secret reader, so this runs in unit tests with no filesystem.
 *
 * Precedence for secrets: env var, then the secrets directory, then unset. Unset passwords are
 * only valid against the dev compose file, which uses trust auth on loopback.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  readSecret: SecretReader = noSecrets,
  listSecrets: SecretLister = () => [],
): Config {
  // Treat empty strings as unset so `FOO=` in an env file does not override a default.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Only report which variables are wrong, never their values.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new ConfigError(`invalid configuration: ${names}`);
  }
  const e = parsed.data;
  return {
    logLevel: e.LAKKA_LOG_LEVEL,
    database: {
      host: e.LAKKA_DATABASE_HOST,
      port: e.LAKKA_DATABASE_PORT,
      user: e.LAKKA_DATABASE_USER,
      database: e.LAKKA_DATABASE_NAME,
      password: e.LAKKA_DATABASE_PASSWORD ?? readSecret('database_password'),
    },
    cache: {
      host: e.LAKKA_CACHE_HOST,
      port: e.LAKKA_CACHE_PORT,
      password: e.LAKKA_CACHE_PASSWORD ?? readSecret('cache_password'),
    },
    api: { host: e.LAKKA_API_HOST, port: e.LAKKA_API_PORT },
    worker: {
      healthHost: e.LAKKA_WORKER_HEALTH_HOST,
      healthPort: e.LAKKA_WORKER_HEALTH_PORT,
    },
    classifier: {
      modelDir: e.LAKKA_CLASSIFIER_MODEL_DIR ?? DEFAULT_CLASSIFIER_MODEL_DIR,
      threads: e.LAKKA_CLASSIFIER_THREADS,
    },
    auth: authConfig(e, readSecret),
    credentials: credentialKeysConfig(e, readSecret, listSecrets),
    mcp: {
      privateOrigins: parseOrigins(e.LAKKA_MCP_PRIVATE_ORIGINS, 'LAKKA_MCP_PRIVATE_ORIGINS'),
    },
    otlp:
      e.LAKKA_OTLP_ENDPOINT === undefined
        ? null
        : {
            endpoint: e.LAKKA_OTLP_ENDPOINT,
            headers: parseHeaders(e.LAKKA_OTLP_HEADERS ?? readSecret('otlp_headers')),
          },
    modelRateLimit: {
      perMinute: e.LAKKA_MODEL_REQUESTS_PER_MINUTE,
      burst: e.LAKKA_MODEL_REQUEST_BURST,
    },
    setup: { code: e.LAKKA_SETUP_CODE ?? readSecret('setup_code') },
    build: { version: e.LAKKA_VERSION ?? 'dev', revision: e.LAKKA_REVISION ?? 'unknown' },
    catalogueFeed: {
      url:
        e.LAKKA_CATALOGUE_FEED_URL === 'off'
          ? null
          : (e.LAKKA_CATALOGUE_FEED_URL ?? DEFAULT_CATALOGUE_FEED_URL),
    },
    sandbox: {
      toolHost: toolHostAddress(e.LAKKA_TOOL_HOST_URL, cleaned['NODE_ENV']),
      egressProxyUrl: new URL(e.LAKKA_EGRESS_PROXY_URL ?? DEFAULT_EGRESS_PROXY_URL).origin,
      slots: e.LAKKA_SANDBOX_SLOTS,
    },
  };
}

/** The file that holds credential key v1, as init has always written it (ADR 0004). */
export const CREDENTIAL_KEY_FILE = 'credential_master_key';
const NUMBERED_KEY_FILE = /^credential_master_key_v([1-9][0-9]{0,8})$/;

/** The secret file name for a credential key version: v1 keeps its original name. */
export function credentialKeyFileName(version: number): string {
  return version === 1 ? CREDENTIAL_KEY_FILE : `${CREDENTIAL_KEY_FILE}_v${version}`;
}

/** The version a secret file name holds, or undefined if it is not a credential key file. */
export function credentialKeyFileVersion(name: string): number | undefined {
  if (name === CREDENTIAL_KEY_FILE) return 1;
  const match = NUMBERED_KEY_FILE.exec(name);
  // credential_master_key_v1 would be a second v1; only the original name holds it.
  return match?.[1] === undefined || match[1] === '1' ? undefined : Number(match[1]);
}

const KEY_LIST_ENTRY = /^([1-9][0-9]{0,8}):([A-Za-z0-9_-]{43,})$/;

/**
 * LAKKA_CREDENTIAL_KEYS: "version:key" pairs, comma-separated, in any order. A malformed or
 * repeated entry is refused by its position, never by its value.
 */
export function parseCredentialKeys(value: string): Map<number, string> {
  const keys = new Map<number, string>();
  value.split(',').forEach((entry, index) => {
    const match = KEY_LIST_ENTRY.exec(entry.trim());
    const version = match?.[1] === undefined ? undefined : Number(match[1]);
    if (version === undefined || match?.[2] === undefined || keys.has(version)) {
      throw new ConfigError(
        `invalid configuration: LAKKA_CREDENTIAL_KEYS entry ${index + 1} must be version:key, each version once`,
      );
    }
    keys.set(version, match[2]);
  });
  return keys;
}

function credentialKeysConfig(
  e: z.infer<typeof envSchema>,
  readSecret: SecretReader,
  listSecrets: SecretLister,
): Config['credentials'] {
  if (e.LAKKA_CREDENTIAL_KEYS !== undefined) {
    return { keys: parseCredentialKeys(e.LAKKA_CREDENTIAL_KEYS), source: 'env' };
  }
  const keys = new Map<number, string>();
  const original = e.LAKKA_CREDENTIAL_KEY ?? readSecret(CREDENTIAL_KEY_FILE);
  if (original !== undefined) keys.set(1, original);
  for (const name of listSecrets()) {
    const version = credentialKeyFileVersion(name);
    if (version === undefined || version === 1) continue;
    const key = readSecret(name);
    if (key !== undefined) keys.set(version, key);
  }
  return { keys, source: 'secrets' };
}

/** A comma-separated list of origins, each exactly an origin (scheme, host and port). */
function parseOrigins(value: string | undefined, name: string): string[] {
  return (value ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')
    .map((o) => {
      // Written as they are compared, by the one normaliser the MCP allowlist uses (ADR 0117).
      const origin = normaliseOrigin(o);
      if (origin === null || origin !== o.replace(/\/$/, '')) {
        throw new ConfigError(`invalid configuration: ${name} must list origins`);
      }
      return origin;
    });
}

function authConfig(e: z.infer<typeof envSchema>, readSecret: SecretReader): Config['auth'] {
  const secret = e.LAKKA_AUTH_SECRET ?? readSecret('auth_secret');
  if (secret !== undefined && secret.length < 32) {
    throw new ConfigError('invalid configuration: auth_secret must be at least 32 characters');
  }
  const derived = e.LAKKA_DOMAIN
    ? `https://${e.LAKKA_DOMAIN}`
    : `http://localhost:${e.LAKKA_HTTP_PORT}`;
  const url = new URL(e.LAKKA_PUBLIC_URL ?? derived);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    // Serving under a subpath (NF-C4) is not supported yet.
    throw new ConfigError('invalid configuration: LAKKA_PUBLIC_URL must be an origin with no path');
  }
  const trustedOrigins = [url.origin];
  // The default loopback install is reachable as both localhost and 127.0.0.1.
  if (url.hostname === 'localhost')
    trustedOrigins.push(`${url.protocol}//127.0.0.1:${url.port || '80'}`);
  const privateIdpOrigins = parseOrigins(
    e.LAKKA_OIDC_PRIVATE_ORIGINS,
    'LAKKA_OIDC_PRIVATE_ORIGINS',
  );
  return { secret, publicUrl: url.origin, trustedOrigins, privateIdpOrigins };
}

/** Config for a running process: env plus the secrets directory it names, if any. */
export function loadProcessConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const dir = env['LAKKA_SECRETS_DIR'];
  return dir
    ? loadConfig(env, fileSecretReader(dir), fileSecretLister(dir))
    : loadConfig(env, noSecrets);
}
