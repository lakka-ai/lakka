import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type { Principal, SetupResult, WorkspaceView } from '@lakka/contracts';
import { createLocalUser } from '@lakka/core';
import { PUBLIC_URL, anonymous, createTestApp, CREDENTIAL_KEY, signIn } from './support.ts';
import type { TestApp } from './support.ts';

/*
 * First-run setup (AD-1, ADR 0034, ADR 0021) against real Postgres and Valkey. Each test that
 * needs a fresh instance builds its own app, which gets its own database.
 */

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const tag = () => randomBytes(3).toString('hex');

function setupBody(
  setupCode: string | undefined,
  overrides: { email?: string; slug?: string } = {},
) {
  const t = tag();
  return {
    code: setupCode ?? 'no-code',
    admin: {
      name: 'First Admin',
      email: overrides.email ?? `first-admin-${t}@example.com`,
      password: `first admin password ${t}`,
    },
    workspace: { name: 'Acme', slug: overrides.slug ?? `acme-${t}` },
  };
}

const apps: TestApp[] = [];
async function fresh(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const t = await createTestApp(options);
  apps.push(t);
  return t;
}

afterAll(async () => {
  await Promise.all(apps.map((t) => t.close()));
});

describe('first-run setup', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await fresh();
  });

  it('AD-1, NF-D1: a fresh instance reports that setup is required', async () => {
    const res = await anonymous(t).get('/api/setup');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ required: true });
  });

  it('AD-1: a wrong setup code reveals nothing and creates nothing', async () => {
    const wrong = randomBytes(32).toString('base64url');
    const secrets = await anonymous(t).post('/api/setup/secrets', { code: wrong });
    expect(secrets.statusCode).toBe(403);
    expect(code(secrets)).toBe('invalid_setup_code');
    expect(secrets.body).not.toContain(CREDENTIAL_KEY);

    const body = setupBody(wrong);
    const complete = await anonymous(t).post('/api/setup', body);
    expect(complete.statusCode).toBe(403);
    expect(code(complete)).toBe('invalid_setup_code');
    const users = await t.pool.query('select 1 from auth_users where email = $1', [
      body.admin.email,
    ]);
    expect(users.rowCount).toBe(0);
    expect((await anonymous(t).get('/api/setup')).json()).toEqual({ required: true });
  });

  it('ADR 0021: the right code shows the credential master key, marked no-store', async () => {
    const res = await anonymous(t).post('/api/setup/secrets', { code: t.setupCode });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ credentialMasterKey: CREDENTIAL_KEY });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('AD-1: refuses an email address that already has an account, leaving setup open', async () => {
    const email = `taken-${tag()}@example.com`;
    await createLocalUser(
      { auth: t.auth, db: t.db },
      { email, password: 'an existing password', name: 'Existing' },
    );
    const res = await anonymous(t).post('/api/setup', setupBody(t.setupCode, { email }));
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('email_taken');
    expect((await anonymous(t).get('/api/setup')).json()).toEqual({ required: true });
  });

  it('AD-1: validates the admin and workspace fields at the boundary', async () => {
    const body = setupBody(t.setupCode, { slug: 'Not A Slug' });
    const res = await anonymous(t).post('/api/setup', body);
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe('invalid_request');
    const short = { ...setupBody(t.setupCode), admin: { ...body.admin, password: 'short' } };
    expect((await anonymous(t).post('/api/setup', short)).statusCode).toBe(400);
  });

  it('AD-1: a failed setup leaves no session or account behind', async () => {
    const body = setupBody(t.setupCode, { slug: 'taken-slug' });
    await t.pool.query(
      "insert into workspaces (id, name, slug) values (gen_random_uuid(), 'x', 'taken-slug')",
    );
    const res = await anonymous(t).post('/api/setup', body);
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('slug_taken');
    expect(res.cookies.find((c) => c.name === 'lakka.session_token')).toBeUndefined();
    const leftovers = await t.pool.query('select 1 from auth_users where email = $1', [
      body.admin.email,
    ]);
    expect(leftovers.rowCount).toBe(0);
    await t.pool.query("delete from workspaces where slug = 'taken-slug'");
  });

  it('AD-1, ID-3: setup creates an instance admin, signed in by the response, who admins the first workspace', async () => {
    const body = setupBody(t.setupCode);
    const res = await anonymous(t).post('/api/setup', body);
    expect(res.statusCode).toBe(201);
    const { workspace } = res.json() as SetupResult;
    expect(workspace).toMatchObject({ name: 'Acme', slug: body.workspace.slug, role: 'admin' });

    const session = res.cookies.find((c) => c.name === 'lakka.session_token');
    expect(session?.httpOnly).toBe(true);
    const headers = { cookie: `${session?.name}=${session?.value}`, origin: PUBLIC_URL };
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers })).json() as {
      principal: Principal;
    };
    expect(me.principal).toMatchObject({ kind: 'user', isInstanceAdmin: true });
    const list = (
      await t.app.inject({ method: 'GET', url: '/api/workspaces', headers })
    ).json() as { workspaces: WorkspaceView[] };
    expect(list.workspaces.map((w) => [w.id, w.role])).toEqual([[workspace.id, 'admin']]);
    // The password works for later sign-ins too.
    expect(await signIn(t, body.admin.email, body.admin.password)).toBeDefined();
  });

  it('AD-1, ADR 0021: once setup is complete, the code opens nothing, including the master key', async () => {
    expect((await anonymous(t).get('/api/setup')).json()).toEqual({ required: false });
    const secrets = await anonymous(t).post('/api/setup/secrets', { code: t.setupCode });
    expect(secrets.statusCode).toBe(409);
    expect(code(secrets)).toBe('setup_complete');
    expect(secrets.body).not.toContain(CREDENTIAL_KEY);
    const again = await anonymous(t).post('/api/setup', setupBody(t.setupCode));
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('setup_complete');
  });

  it('NF-S5: no setup code, master key or password reaches the logs', () => {
    const logs = t.logs.join('\n');
    expect(t.setupCode).toBeDefined();
    expect(logs).not.toContain(t.setupCode);
    expect(logs).not.toContain(CREDENTIAL_KEY);
    expect(logs).not.toContain('first admin password');
    expect(logs).toContain('"msg":"setup.completed"');
  });
});

describe('first-run setup races and limits', () => {
  it('AD-1: of two setups racing with the right code, exactly one wins and the other leaves no account', async () => {
    const t = await fresh();
    const bodies = [setupBody(t.setupCode), setupBody(t.setupCode)];
    const results = await Promise.all(bodies.map((b) => anonymous(t).post('/api/setup', b)));
    expect(results.map((r) => r.statusCode).toSorted()).toEqual([201, 409]);
    const lost = results.findIndex((r) => r.statusCode === 409);
    expect(results[lost]?.json()).toMatchObject({ error: { code: 'setup_complete' } });
    const loser = bodies[lost];
    const orphans = await t.pool.query('select 1 from auth_users where email = $1', [
      loser?.admin.email,
    ]);
    expect(orphans.rowCount).toBe(0);
    const admins = await t.pool.query('select 1 from principals where is_instance_admin');
    expect(admins.rowCount).toBe(1);
    const workspaces = await t.pool.query('select 1 from workspaces');
    expect(workspaces.rowCount).toBe(1);
  });

  it('AD-1: an instance with no setup code configured cannot be set up', async () => {
    const t = await fresh({ setupCode: null });
    for (const guess of ['', 'undefined', 'null']) {
      const res = await anonymous(t).post('/api/setup', setupBody(guess || 'x'));
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('invalid_setup_code');
    }
  });

  it('AD-1: setup attempts are throttled per client address', async () => {
    const t = await fresh();
    const address = `192.0.2.${Math.floor(Math.random() * 250)}`;
    const attempt = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/setup/secrets',
        headers: { origin: PUBLIC_URL, 'x-forwarded-for': address },
        payload: { code: 'wrong-code-wrong-code' },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await attempt()).statusCode);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(403));
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(code(limited)).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another address is unaffected, and the right code still works from it.
    expect((await anonymous(t).post('/api/setup/secrets', { code: t.setupCode })).statusCode).toBe(
      200,
    );
  });
});
