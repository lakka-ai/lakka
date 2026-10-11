import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import {
  AUTH_RATE_LIMIT_PREFIX,
  cacheScript,
  createAuth,
  createLocalUser,
  createLogger,
  noEvents,
  fixedCatalogue,
  inProcessExecutor,
  loadCatalogue,
  valkeyRateLimitStorage,
} from '@lakka/core';
import type { Auth, CacheClient } from '@lakka/core';
import { createDb, migrate, schema } from '@lakka/db';
import type { Db, Pool } from '@lakka/db';
import { buildServer } from '../src/server.ts';
import type { ApiServer } from '../src/server.ts';
import { createTestDatabase } from '../../../test/integration/postgres.ts';
import type { TestDatabase } from '../../../test/integration/postgres.ts';
import { createTestCache } from '../../../test/integration/valkey.ts';

const PUBLIC_URL = 'http://localhost:8080';
const SECRET = 'integration-tests-only-auth-secret-0123456789abcdef';

let database: TestDatabase;
let db: Db;
let pool: Pool;
let cache: CacheClient;
let auth: Auth;
let app: ApiServer;
const logs: string[] = [];
/** Every email and password used, to check none of them reach the logs. */
const sensitive: string[] = [];

function build(publicUrl: string) {
  const { logger, frameworkLogger } = createLogger({
    level: 'debug',
    service: 'api-test',
    destination: { write: (line: string) => void logs.push(line) },
  });
  const instance = createAuth({
    db,
    cache,
    logger,
    config: { secret: SECRET, publicUrl, trustedOrigins: [publicUrl], privateIdpOrigins: [] },
  });
  const server = buildServer({
    logger,
    frameworkLogger,
    healthChecks: {},
    auth: {
      context: { auth: instance, db, events: noEvents },
      publicUrl,
      trustedOrigins: [publicUrl],
      rateLimit: valkeyRateLimitStorage(cache),
      cache,
      setup: { code: undefined, credentialMasterKey: 'not-used-by-these-tests' },
      catalogue: fixedCatalogue(loadCatalogue()),
      toolExecutor: inProcessExecutor,
    },
  });
  return { auth: instance, app: server };
}

beforeAll(async () => {
  database = await createTestDatabase();
  pool = database.pool();
  await migrate(pool);
  db = createDb(pool);
  cache = createTestCache();
  ({ auth, app } = build(PUBLIC_URL));
  await auth.$context;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  cache.close();
  await database.drop();
});

let lastIp = 0;
/** A fresh client address, so sign-in throttling in one test does not affect another. */
const clientIp = () => `10.20.${Math.floor(++lastIp / 250)}.${lastIp % 250}`;

async function newUser(): Promise<{ email: string; password: string; principal: Principal }> {
  const tag = randomBytes(4).toString('hex');
  const email = `ada-${tag}@example.com`;
  const password = `correct horse battery ${tag}`;
  sensitive.push(email, password);
  const principal = await createLocalUser({ auth, db }, { email, password, name: 'Ada Lovelace' });
  return { email, password, principal };
}

function signIn(
  email: string,
  password: string,
  options: { origin?: string; ip?: string; server?: ApiServer } = {},
) {
  return (options.server ?? app).inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: {
      origin: options.origin ?? PUBLIC_URL,
      'content-type': 'application/json',
      'x-forwarded-for': options.ip ?? clientIp(),
    },
    payload: { email, password },
  });
}

type Injected = Awaited<ReturnType<typeof signIn>>;

function sessionCookie(res: Injected) {
  const cookie = res.cookies.find((c) => c.name.endsWith('lakka.session_token'));
  if (cookie === undefined) throw new Error(`no session cookie (status ${res.statusCode})`);
  return cookie;
}

const cookieHeader = (res: Injected) => {
  const c = sessionCookie(res);
  return `${c.name}=${c.value}`;
};

function me(cookie?: string) {
  return app.inject({ url: '/api/me', headers: cookie === undefined ? {} : { cookie } });
}

describe('local accounts and sessions', () => {
  it('ID-2: a local account signs in and gets an HttpOnly, SameSite=Lax session cookie', async () => {
    const { email, password } = await newUser();
    const res = await signIn(email, password);
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.name).toBe('lakka.session_token');
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
    expect(res.body).not.toContain(password);
  });

  it('ID-1: the session resolves to the principal created for the account, with its email', async () => {
    const { email, password, principal } = await newUser();
    const res = await me(cookieHeader(await signIn(email, password)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      principal: {
        id: principal.id,
        kind: 'user',
        displayName: 'Ada Lovelace',
        actingUserId: principal.id,
        isInstanceAdmin: false,
        workspaceScope: null,
      },
      email: email.toLowerCase(),
    });
  });

  it('ID-1: without a session the api answers 401 with the documented error', async () => {
    const res = await me();
    expect(res.statusCode).toBe(401);
    expect(apiErrorBody.parse(res.json()).error.code).toBe('unauthenticated');
    const forged = await me('lakka.session_token=forged.value');
    expect(forged.statusCode).toBe(401);
  });

  it('a wrong password is refused and sets no session', async () => {
    const { email } = await newUser();
    const res = await signIn(email, 'not the right password at all');
    expect(res.statusCode).toBe(401);
    expect(
      res.cookies.find((c) => c.name.endsWith('session_token') && c.value !== ''),
    ).toBeUndefined();
  });

  it('ADR 0028: public sign-up and unlisted Better Auth routes are not reachable', async () => {
    const before = await db.$count(schema.authUsers);
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: PUBLIC_URL, 'content-type': 'application/json' },
      payload: { email: 'mallory@example.com', password: 'a password long enough', name: 'M' },
    });
    expect(signUp.statusCode).toBe(404);
    expect(await db.$count(schema.authUsers)).toBe(before);
    const listSessions = await app.inject({ url: '/api/auth/list-sessions' });
    expect(listSessions.statusCode).toBe(404);
  });

  it('signing out ends the session', async () => {
    const { email, password } = await newUser();
    const cookie = cookieHeader(await signIn(email, password));
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('ID-6: a suspended principal is refused on its next request, and allowed again when reactivated', async () => {
    const { email, password, principal } = await newUser();
    const cookie = cookieHeader(await signIn(email, password));
    expect((await me(cookie)).statusCode).toBe(200);

    await pool.query("update principals set status = 'suspended' where id = $1", [principal.id]);
    expect((await me(cookie)).statusCode).toBe(401);

    await pool.query("update principals set status = 'active' where id = $1", [principal.id]);
    expect((await me(cookie)).statusCode).toBe(200);
  });

  it('sessions are stored in Postgres, not in the cookie', async () => {
    const { email, password } = await newUser();
    await signIn(email, password);
    const result = await pool.query<{ n: number }>(
      'select count(*)::int as n from auth_sessions s join auth_users u on u.id = s.user_id where u.email = $1',
      [email],
    );
    expect(result.rows[0]?.n).toBe(1);
  });
});

describe('cross-site request protection (ADR 0006)', () => {
  it('a sign-in from a foreign origin is refused (login CSRF)', async () => {
    const { email, password } = await newUser();
    const res = await signIn(email, password, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.cookies.find((c) => c.name.endsWith('session_token'))).toBeUndefined();
  });

  it('any cookie-authenticated state change from a foreign origin is refused before routing', async () => {
    const { email, password } = await newUser();
    const cookie = cookieHeader(await signIn(email, password));
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/does-not-exist',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(apiErrorBody.parse(foreign.json()).error.code).toBe('origin_not_allowed');
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/does-not-exist',
      headers: { cookie },
    });
    expect(noOrigin.statusCode).toBe(403);
    const own = await app.inject({
      method: 'POST',
      url: '/api/does-not-exist',
      headers: { cookie, origin: PUBLIC_URL },
    });
    expect(own.statusCode).toBe(404);
  });
});

describe('sign-in throttling', () => {
  it('blocks repeated attempts from one address, counted in Valkey, without affecting others', async () => {
    const { email, password } = await newUser();
    const ip = clientIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1)
      statuses.push((await signIn(email, 'wrong password attempt', { ip })).statusCode);
    expect(statuses).toEqual([401, 401, 401, 429]);
    // The right password from the same address is still throttled; another address is not.
    expect((await signIn(email, password, { ip })).statusCode).toBe(429);
    expect((await signIn(email, password)).statusCode).toBe(200);
    const pong = await cache.runScript(
      cacheScript(`return redis.call('EXISTS', KEYS[1])`),
      [`${AUTH_RATE_LIMIT_PREFIX}${ip}|/sign-in/email`],
      [],
    );
    expect(pong).toBe(1);
  });
});

describe('secure deployments', () => {
  it('NF-S6: behind https the session cookie is Secure and __Secure- prefixed', async () => {
    const https = build('https://ai.example.com');
    await https.app.ready();
    try {
      const { email, password } = await newUser();
      const res = await signIn(email, password, {
        origin: 'https://ai.example.com',
        server: https.app,
      });
      expect(res.statusCode).toBe(200);
      const cookie = sessionCookie(res);
      expect(cookie.name).toBe('__Secure-lakka.session_token');
      expect(cookie.secure).toBe(true);
    } finally {
      await https.app.close();
    }
  });
});

describe('logs', () => {
  it('NF-S5: no email address or password reaches the logs', async () => {
    const { email, password } = await newUser();
    await signIn(email, password);
    await signIn(email, 'a wrong password for the log check');
    // Better Auth logs "Sign-up attempt for existing email: <email>" on a duplicate sign-up.
    await expect(createLocalUser({ auth, db }, { email, password, name: 'Dup' })).rejects.toThrow(
      /already exists/i,
    );
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(0);
    for (const value of sensitive) expect(text).not.toContain(value);
  });
});
