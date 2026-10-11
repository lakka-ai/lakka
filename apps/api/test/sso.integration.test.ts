import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type {
  Principal,
  PublicSsoProvider,
  SsoProviderView,
  UserAdminView,
} from '@lakka/contracts';
import { createLocalUser } from '@lakka/core';
import { as, clientIp, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';
import {
  DEX_CLIENT_ID,
  DEX_CLIENT_SECRET,
  loginAtDex,
  startDex,
} from '../../../test/integration/dex.ts';
import type { Dex } from '../../../test/integration/dex.ts';

const PROVIDERS = ['dex-open', 'dex-closed', 'dex-domain', 'dex-removed'];
const USERS = {
  open: 'open@anywhere.org',
  closed: 'closed@example.com',
  allowedDomain: 'allowed@example.com',
  otherDomain: 'other@elsewhere.org',
  taken: 'taken@example.com',
  returning: 'returning@anywhere.org',
};

let dex: Dex;
let t: TestApp;
let admin: SignedInUser;

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;

async function register(
  providerId: string,
  policy: { allowSignUp: boolean; allowedEmailDomains?: string[] },
) {
  return as(t, admin).post('/api/sso/providers', {
    providerId,
    displayName: `Dex (${providerId})`,
    issuer: dex.issuer,
    clientId: DEX_CLIENT_ID,
    clientSecret: DEX_CLIENT_SECRET,
    allowSignUp: policy.allowSignUp,
    allowedEmailDomains: policy.allowedEmailDomains ?? [],
  });
}

/** Signs in through Dex like a browser would, and returns the app's final callback response. */
async function ssoSignIn(providerId: string, email: string) {
  const start = await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/sso',
    headers: {
      origin: PUBLIC_URL,
      'content-type': 'application/json',
      'x-forwarded-for': clientIp(),
    },
    payload: { providerId, callbackURL: '/', errorCallbackURL: '/sign-in-error' },
  });
  if (start.statusCode !== 200)
    throw new Error(`sign-in/sso failed: ${start.statusCode} ${start.body}`);
  const { url } = start.json() as { url: string };
  const cookies = start.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const back = await loginAtDex(url, PUBLIC_URL, email);
  return t.app.inject({
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    headers: { cookie: cookies, 'x-forwarded-for': clientIp() },
  });
}

type Injected = Awaited<ReturnType<typeof ssoSignIn>>;

function sessionOf(res: Injected): string | undefined {
  const cookie = res.cookies.find((c) => c.name === 'lakka.session_token' && c.value !== '');
  return cookie === undefined ? undefined : `${cookie.name}=${cookie.value}`;
}

async function authUserCount(email: string): Promise<number> {
  const r = await t.pool.query<{ n: number }>(
    'select count(*)::int as n from auth_users where email = $1',
    [email],
  );
  return r.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  dex = await startDex({
    callbackUrls: PROVIDERS.map((p) => `${PUBLIC_URL}/api/auth/sso/callback/${p}`),
    users: Object.values(USERS).map((email) => ({ email, username: email.split('@')[0] ?? email })),
  });
  t = await createTestApp({ privateIdpOrigins: [dex.origin] });
  admin = await signedInUser(t, 'Admin');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  for (const [providerId, policy] of [
    ['dex-open', { allowSignUp: true }],
    ['dex-closed', { allowSignUp: false }],
    ['dex-domain', { allowSignUp: true, allowedEmailDomains: ['example.com'] }],
  ] as const) {
    const res = await register(providerId, {
      ...policy,
      allowedEmailDomains: [...(policy.allowedEmailDomains ?? [])],
    });
    if (res.statusCode !== 201)
      throw new Error(`registering ${providerId} failed: ${res.statusCode} ${res.body}`);
  }
}, 180_000);

afterAll(async () => {
  await t.close();
  await dex.stop();
});

describe('registering identity providers (ID-2, AD-1)', () => {
  it('stores the client secret encrypted and never returns it', async () => {
    const res = await as(t, admin).get('/api/sso/providers');
    expect(res.body).not.toContain(DEX_CLIENT_SECRET);
    const open = (res.json() as { providers: SsoProviderView[] }).providers.find(
      (p) => p.providerId === 'dex-open',
    );
    expect(open).toMatchObject({ issuer: dex.issuer, allowSignUp: true, allowedEmailDomains: [] });

    const stored = await t.pool.query<{ oidc_config: string }>(
      "select oidc_config from sso_providers where provider_id = 'dex-open'",
    );
    const raw = stored.rows[0]?.oidc_config ?? '';
    expect(raw.startsWith('v1:')).toBe(true);
    expect(raw).not.toContain(DEX_CLIENT_SECRET);
    expect(raw).not.toContain(DEX_CLIENT_ID);
  });

  it('only instance admins, signed in with a session, manage providers', async () => {
    const member = await signedInUser(t, 'Member');
    const denied = await as(t, member).post('/api/sso/providers', {
      providerId: 'rogue',
      displayName: 'Rogue',
      issuer: dex.issuer,
      clientId: 'x',
      clientSecret: 'y',
    });
    expect(denied.statusCode).toBe(403);
    expect((await as(t, member).get('/api/sso/providers')).statusCode).toBe(403);
    expect((await as(t, member).delete('/api/sso/providers/dex-open')).statusCode).toBe(403);
  });

  it('anyone can see which providers exist, but nothing else about them', async () => {
    const res = await t.app.inject({ url: '/api/sso/providers/public' });
    const providers = (res.json() as { providers: PublicSsoProvider[] }).providers;
    expect(providers.map((p) => p.providerId)).toEqual(
      expect.arrayContaining(['dex-open', 'dex-closed']),
    );
    expect(Object.keys(providers[0] ?? {}).toSorted()).toEqual(['displayName', 'providerId']);
  });

  it('refuses an identity provider on a private address unless it is explicitly allowed', async () => {
    const strict = await createTestApp();
    try {
      const boss = await signedInUser(strict, 'Boss');
      await strict.pool.query('update principals set is_instance_admin = true where id = $1', [
        boss.principal.id,
      ]);
      const res = await as(strict, boss).post('/api/sso/providers', {
        providerId: 'internal',
        displayName: 'Internal',
        issuer: dex.issuer,
        clientId: DEX_CLIENT_ID,
        clientSecret: DEX_CLIENT_SECRET,
      });
      expect(res.statusCode).toBe(400);
      expect(code(res)).toBe('invalid_request');
      expect(await strict.pool.query('select 1 from sso_providers').then((r) => r.rowCount)).toBe(
        0,
      );
    } finally {
      await strict.close();
    }
  });

  it('validates input and keeps unknown fields out', async () => {
    const res = await as(t, admin).post('/api/sso/providers', {
      providerId: 'Bad Id',
      displayName: 'x',
      issuer: 'ftp://example.com',
      clientId: 'x',
      clientSecret: 'y',
      extra: true,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('signing in with OIDC (ID-2)', () => {
  it('creates an account through a provider that allows sign-up, and resolves it to a principal', async () => {
    const res = await ssoSignIn('dex-open', USERS.open);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = sessionOf(res);
    expect(cookie).toBeDefined();
    const meRes = await t.app.inject({ url: '/api/me', headers: { cookie: cookie ?? '' } });
    expect(meRes.statusCode).toBe(200);
    const principal = (meRes.json() as { principal: Principal }).principal;
    expect(principal.kind).toBe('user');
    expect(principal.displayName).toBe('open');
    const row = await t.pool.query('select email from principals where id = $1', [principal.id]);
    expect(row.rows[0]?.email).toBe(USERS.open);
  });

  it('stores the identity provider tokens encrypted', async () => {
    const tokens = await t.pool.query<{ id_token: string | null; access_token: string | null }>(
      "select a.id_token, a.access_token from auth_accounts a join auth_users u on u.id = a.user_id where u.email = $1 and a.provider_id = 'dex-open'",
      [USERS.open],
    );
    const row = tokens.rows[0];
    // In the clear the ID token is a JWT ("eyJ..."); stored, it must be our ciphertext.
    expect(row?.id_token?.startsWith('v1:')).toBe(true);
    expect(row?.access_token).toBeTruthy();
    expect(row?.access_token?.startsWith('eyJ')).toBe(false);
  });

  it('refuses new accounts by default, when the provider does not allow sign-up', async () => {
    const res = await ssoSignIn('dex-closed', USERS.closed);
    expect(sessionOf(res)).toBeUndefined();
    expect(res.headers.location).toContain('error');
    expect(await authUserCount(USERS.closed)).toBe(0);
  });

  it('allows sign-up only for the listed email domains', async () => {
    const refused = await ssoSignIn('dex-domain', USERS.otherDomain);
    expect(sessionOf(refused)).toBeUndefined();
    expect(await authUserCount(USERS.otherDomain)).toBe(0);

    const allowed = await ssoSignIn('dex-domain', USERS.allowedDomain);
    expect(sessionOf(allowed)).toBeDefined();
    expect(await authUserCount(USERS.allowedDomain)).toBe(1);
  });

  it('never links to an existing local account with the same email', async () => {
    await createLocalUser(
      { auth: t.auth, db: t.db },
      { email: USERS.taken, password: 'a local password 123', name: 'Taken' },
    );
    const res = await ssoSignIn('dex-open', USERS.taken);
    expect(sessionOf(res)).toBeUndefined();
    const linked = await t.pool.query(
      "select 1 from auth_accounts a join auth_users u on u.id = a.user_id where u.email = $1 and a.provider_id <> 'credential'",
      [USERS.taken],
    );
    expect(linked.rowCount).toBe(0);
  });

  it('lets an existing OIDC user sign in again without creating anyone', async () => {
    expect(sessionOf(await ssoSignIn('dex-open', USERS.returning))).toBeDefined();
    expect(sessionOf(await ssoSignIn('dex-open', USERS.returning))).toBeDefined();
    expect(await authUserCount(USERS.returning)).toBe(1);
  });

  it('ID-6: a suspended OIDC user cannot sign in', async () => {
    // The principal exists from the user's first authenticated request, as in the web app.
    const cookie = sessionOf(await ssoSignIn('dex-open', USERS.returning)) ?? '';
    const me = await t.app.inject({ url: '/api/me', headers: { cookie } });
    const { principal } = me.json() as { principal: Principal };
    expect((await as(t, admin).post(`/api/users/${principal.id}/suspend`, {})).statusCode).toBe(
      200,
    );
    expect(sessionOf(await ssoSignIn('dex-open', USERS.returning))).toBeUndefined();
  });

  it('a removed provider disappears and can no longer be used', async () => {
    expect((await register('dex-removed', { allowSignUp: true })).statusCode).toBe(201);
    expect((await as(t, admin).delete('/api/sso/providers/dex-removed')).statusCode).toBe(204);
    const listed = (await t.app.inject({ url: '/api/sso/providers/public' })).json() as {
      providers: PublicSsoProvider[];
    };
    expect(listed.providers.map((p) => p.providerId)).not.toContain('dex-removed');
    const start = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/sso',
      headers: {
        origin: PUBLIC_URL,
        'content-type': 'application/json',
        'x-forwarded-for': clientIp(),
      },
      payload: { providerId: 'dex-removed', callbackURL: '/' },
    });
    expect(start.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('keeps provider management and SAML routes of the plugin unreachable over HTTP', async () => {
    for (const [method, url] of [
      ['POST', '/api/auth/sso/register'],
      ['POST', '/api/auth/sso/update-provider'],
      ['GET', '/api/auth/sso/saml2/sp/metadata'],
      ['POST', '/api/auth/sso/saml2/sp/acs/dex-open'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: { cookie: admin.cookie, origin: PUBLIC_URL },
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
    }
  });

  it('NF-S5: the client secret never reaches the logs', async () => {
    expect(t.logs.join('')).not.toContain(DEX_CLIENT_SECRET);
  });
});

const list = async () =>
  ((await as(t, admin).get('/api/sso/providers')).json() as { providers: SsoProviderView[] })
    .providers;
const find = async (providerId: string) => {
  const found = (await list()).find((p) => p.providerId === providerId);
  if (found === undefined) throw new Error(`no provider ${providerId}`);
  return found;
};
const edit = (providerId: string, body: Record<string, unknown>) =>
  as(t, admin).put(`/api/sso/providers/${providerId}`, {
    displayName: `Dex (${providerId})`,
    allowSignUp: true,
    allowedEmailDomains: [],
    ...body,
  });

describe('editing identity providers (ID-2, ADR 0097)', () => {
  it('ID-2: lists the client id, the redirect URI to register, and how many people sign in with it', async () => {
    const open = await find('dex-open');
    expect(open.clientId).toBe(DEX_CLIENT_ID);
    expect(open.redirectUri).toBe(`${PUBLIC_URL}/api/auth/sso/callback/dex-open`);
    const rows = await t.pool.query<{ n: number }>(
      "select count(distinct user_id)::int as n from auth_accounts where provider_id = 'dex-open'",
    );
    expect(open.peopleCount).toBe(rows.rows[0]?.n);
    expect(open.peopleCount).toBeGreaterThan(0);
    // Accounts made by a provider have no password, so it is their only way in.
    expect(open.onlyWayCount).toBe(open.peopleCount);
    expect((await find('dex-closed')).peopleCount).toBe(0);
  });

  it('ID-6: the People list names the provider a person signs in with', async () => {
    const users = ((await as(t, admin).get('/api/users')).json() as { users: UserAdminView[] })
      .users;
    const open = users.find((u) => u.email === USERS.open);
    expect(open?.signsInWith).toEqual([
      { kind: 'sso', providerId: 'dex-open', displayName: 'Dex (dex-open)' },
    ]);
  });

  it('ID-2: fills in the client id of a provider added before it was kept', async () => {
    await t.pool.query(
      "update sso_provider_policies set client_id = null where provider_id = 'dex-closed'",
    );
    expect((await find('dex-closed')).clientId).toBe(DEX_CLIENT_ID);
    const stored = await t.pool.query<{ client_id: string | null }>(
      "select client_id from sso_provider_policies where provider_id = 'dex-closed'",
    );
    expect(stored.rows[0]?.client_id).toBe(DEX_CLIENT_ID);
  });

  it('ID-2: changes the name and who may get a new account, which applies to the next sign-in', async () => {
    const res = await edit('dex-closed', { displayName: 'Dex, now open', allowSignUp: true });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { provider: SsoProviderView }).provider).toMatchObject({
      displayName: 'Dex, now open',
      allowSignUp: true,
      clientId: DEX_CLIENT_ID,
    });
    expect(sessionOf(await ssoSignIn('dex-closed', USERS.closed))).toBeDefined();
    expect(await authUserCount(USERS.closed)).toBe(1);
  });

  it('ID-2, NF-S1: replaces the client secret, stored encrypted and never returned or logged', async () => {
    const wrong = `wrong-${randomUUID()}`;
    const replaced = await edit('dex-domain', {
      allowedEmailDomains: ['example.com'],
      clientSecret: wrong,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain(wrong);
    const stored = await t.pool.query<{ oidc_config: string }>(
      "select oidc_config from sso_providers where provider_id = 'dex-domain'",
    );
    expect(stored.rows[0]?.oidc_config.startsWith('v1:')).toBe(true);
    expect(stored.rows[0]?.oidc_config).not.toContain(wrong);
    // Dex refuses the wrong secret, so the sign-in cannot finish.
    expect(sessionOf(await ssoSignIn('dex-domain', USERS.allowedDomain))).toBeUndefined();

    await edit('dex-domain', {
      allowedEmailDomains: ['example.com'],
      clientSecret: DEX_CLIENT_SECRET,
    });
    expect(sessionOf(await ssoSignIn('dex-domain', USERS.allowedDomain))).toBeDefined();
    expect(t.logs.join('')).not.toContain(wrong);
  });

  it('ID-2: keeps the secret when none is sent', async () => {
    expect((await edit('dex-open', { displayName: 'Dex (dex-open)' })).statusCode).toBe(200);
    expect(sessionOf(await ssoSignIn('dex-open', USERS.open))).toBeDefined();
  });

  it('ID-2: the issuer, the client id and the provider id cannot be edited', async () => {
    for (const extra of [{ issuer: 'https://elsewhere.example' }, { clientId: 'other' }]) {
      expect((await edit('dex-open', extra)).statusCode).toBe(400);
    }
    expect((await find('dex-open')).clientId).toBe(DEX_CLIENT_ID);
  });

  it('ID-2: refuses a provider named credential, members, and providers that do not exist', async () => {
    const named = await as(t, admin).post('/api/sso/providers', {
      providerId: 'credential',
      displayName: 'Credential',
      issuer: dex.issuer,
      clientId: DEX_CLIENT_ID,
      clientSecret: DEX_CLIENT_SECRET,
    });
    expect(named.statusCode).toBe(400);
    const member = await signedInUser(t, 'Editor');
    expect(
      (
        await as(t, member).put('/api/sso/providers/dex-open', {
          displayName: 'Mine',
          allowSignUp: true,
          allowedEmailDomains: [],
        })
      ).statusCode,
    ).toBe(403);
    expect((await edit('no-such-provider', {})).statusCode).toBe(404);
  });
});
