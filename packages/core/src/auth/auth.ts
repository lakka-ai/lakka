import { sso } from '@better-auth/sso';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { ConfigError } from '@lakka/contracts';
import { findPrincipalByAuthSubject, findSsoPolicy, schema, uuidv7 } from '@lakka/db';
import type { Db } from '@lakka/db';
import type { CacheClient } from '../cache.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { mayProvision } from '../sso/policy.ts';
import { valkeyRateLimitStorage } from './rate-limit.ts';

/*
 * Better Auth, configured for this product (ID-2, ADR 0028). It owns passwords, sessions and
 * cookies; our identity (principals) links to its users. Settings that matter:
 *   - Sessions live in Postgres and the cookie cache is off, so revoking a session or
 *     suspending a principal takes effect on the next request (ID-6).
 *   - Telemetry is off, and its environment switches are removed first (NF-P1).
 *   - Its logs go through our field filter with their text dropped, because Better Auth logs
 *     email addresses in some messages (invariant 9).
 *   - Sign-in throttling counts in Valkey.
 *   - Ids are UUIDv7 (ADR 0027).
 *   - OIDC through the SSO plugin: only instance admins register providers, a provider creates
 *     new accounts only if its policy allows, and an email match never links accounts on its
 *     own. OAuth tokens are encrypted (ADR 0032).
 * Which of its HTTP routes are reachable is decided by the api's allowlist, not here.
 */

const BETTER_AUTH_TELEMETRY_ENV = [
  'BETTER_AUTH_TELEMETRY',
  'BETTER_AUTH_TELEMETRY_ENDPOINT',
  'BETTER_AUTH_TELEMETRY_DEBUG',
  'BETTER_AUTH_TELEMETRY_ID',
] as const;

/**
 * Better Auth sends telemetry when BETTER_AUTH_TELEMETRY_ENDPOINT is set, and its environment
 * flag overrides `telemetry.enabled: false`. It reads these lazily, so removing them before
 * betterAuth() runs is enough. Returns the names it removed.
 */
export function removeBetterAuthTelemetryEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of BETTER_AUTH_TELEMETRY_ENV) {
    if (name in env) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

export interface AuthDeps {
  db: Db;
  cache: CacheClient;
  logger: Logger;
  config: Config['auth'];
}

export const AUTH_BASE_PATH = '/api/auth';

export function createAuth({ db, cache, logger, config }: AuthDeps) {
  if (config.secret === undefined) {
    throw new ConfigError('invalid configuration: the auth secret is missing');
  }
  const removed = removeBetterAuthTelemetryEnv();
  if (removed.length > 0) logger.warn('auth.telemetry_env_removed', { count: removed.length });

  return betterAuth({
    appName: 'Lakka',
    baseURL: config.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    // Private-network identity providers must be listed explicitly; Better Auth refuses to
    // contact loopback and private addresses otherwise (ADR 0032).
    trustedOrigins: [...config.trustedOrigins, ...config.privateIdpOrigins],
    database: drizzleAdapter(db, {
      provider: 'pg',
      transaction: true,
      schema: {
        user: schema.authUsers,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
        ssoProvider: schema.ssoProviders,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    session: {
      cookieCache: { enabled: false },
    },
    account: {
      // Tokens from identity providers are stored encrypted with the auth secret.
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      user: {
        create: {
          // Local accounts are created server-side only (createLocalUser). A user created by an
          // SSO callback needs the provider's policy to allow sign-up for that email address.
          // The plugin's own disableImplicitSignUp can be bypassed by the client, so it is not
          // relied on (ADR 0032).
          before: async (user, ctx) => {
            if (ctx === null || !ctx.path.startsWith('/sso/')) return true;
            const params: unknown = ctx.params;
            const providerId =
              params !== null && typeof params === 'object' && 'providerId' in params
                ? params.providerId
                : undefined;
            if (typeof providerId !== 'string') return false;
            return mayProvision(await findSsoPolicy(db, providerId), user.email);
          },
        },
      },
      session: {
        create: {
          // A suspended or deleted person gets no new session at all (ID-6, NF-P4). This only reads, so running
          // inside Better Auth's transaction on another connection is safe.
          before: async (session) => {
            const principal = await findPrincipalByAuthSubject(db, session.userId);
            return principal === undefined || principal.status === 'active';
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      customStorage: valkeyRateLimitStorage(cache),
    },
    advanced: {
      cookiePrefix: 'lakka',
      useSecureCookies: config.publicUrl.startsWith('https:'),
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      database: { generateId: () => uuidv7() },
    },
    plugins: [
      sso({
        // Only instance admins register identity providers (ID-2).
        providersLimit: async (user) => {
          const principal = await findPrincipalByAuthSubject(db, user.id);
          return principal?.isInstanceAdmin === true && principal.status === 'active' ? 100 : 0;
        },
        // Never treat a provider's email_verified claim as proof for linking to an existing
        // account; a matching email is refused rather than linked.
        trustEmailVerified: false,
        // Not our control: a client can bypass it with requestSignUp. Whether a provider may create
        // accounts is decided by its policy in the user.create.before hook above.
        disableImplicitSignUp: false,
      }),
    ],
    telemetry: { enabled: false },
    onAPIError: {
      // Unexpected errors would otherwise be printed with console.error by Better Auth's router,
      // bypassing our log filter. Rethrowing sends them to the api's error handler, which logs
      // them filtered and answers a generic 500. Ordinary API errors (a wrong password) still
      // become normal responses.
      onError: (error) => {
        if (!(error instanceof APIError)) throw error;
        if (error.status === 'INTERNAL_SERVER_ERROR')
          logger.error('better_auth.api_error', {}, error);
      },
    },
    logger: {
      level: 'warn',
      log: (level, _message, ...args) => {
        const err: unknown = args.find((a: unknown) => a instanceof Error);
        const event = `better_auth.${level}`;
        if (level === 'error') logger.error(event, {}, err);
        else if (level === 'warn') logger.warn(event, {}, err);
        else logger.debug(event);
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
