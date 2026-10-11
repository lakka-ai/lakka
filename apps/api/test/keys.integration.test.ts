import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type { IssuedKey, KeyView, Principal, WorkspaceView } from '@lakka/contracts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

let t: TestApp;
let root: SignedInUser; // instance admin, sets things up
let owner: SignedInUser; // admin of alpha, member of bravo
let colleague: SignedInUser; // member of alpha
let outsider: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Requests authenticated only by an API key. */
function bearer(secret: string, origin?: string) {
  const headers = {
    authorization: `Bearer ${secret}`,
    ...(origin === undefined ? {} : { origin }),
  };
  return {
    get: (url: string) => t.app.inject({ method: 'GET', url, headers }),
    patch: (url: string, payload: object) =>
      t.app.inject({ method: 'PATCH', url, headers, payload }),
    post: (url: string, payload: object) => t.app.inject({ method: 'POST', url, headers, payload }),
    delete: (url: string) => t.app.inject({ method: 'DELETE', url, headers }),
  };
}

async function workspace(name: string): Promise<WorkspaceView> {
  const slug = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}`;
  const res = await as(t, root).post('/api/workspaces', { name, slug });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function setRole(ws: WorkspaceView, user: SignedInUser, role: 'admin' | 'member') {
  const res = await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role,
  });
  if (res.statusCode !== 200) throw new Error(`setRole failed: ${res.statusCode}`);
}

async function issue(user: SignedInUser, ws: WorkspaceView, name = 'CI key'): Promise<IssuedKey> {
  const res = await as(t, user).post(`/api/workspaces/${ws.id}/keys`, { name });
  if (res.statusCode !== 201) throw new Error(`issue failed: ${res.statusCode} ${res.body}`);
  return res.json() as IssuedKey;
}

const me = async (secret: string) => bearer(secret).get('/api/me');

beforeAll(async () => {
  t = await createTestApp();
  [root, owner, colleague, outsider] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Owner'),
    signedInUser(t, 'Colleague'),
    signedInUser(t, 'Outsider'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  await setRole(alpha, owner, 'admin');
  await setRole(alpha, colleague, 'member');
  await setRole(bravo, owner, 'member');
});

afterAll(async () => {
  await t.close();
});

describe('issuing keys (ID-5)', () => {
  it('a member issues a key for one workspace and sees the secret exactly once', async () => {
    const res = await as(t, colleague).post(`/api/workspaces/${alpha.id}/keys`, {
      name: 'Scripts',
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { key, secret } = res.json() as IssuedKey;
    expect(secret).toMatch(/^lk_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({
      name: 'Scripts',
      prefix: secret.slice(0, 11),
      workspaceId: alpha.id,
      owner: { principalId: colleague.principal.id, displayName: 'Colleague' },
      revokedAt: null,
    });

    const listed = await as(t, colleague).get(`/api/workspaces/${alpha.id}/keys`);
    expect(listed.body).not.toContain(secret);
  });

  it('PR-3: only a digest of the secret is stored', async () => {
    const { key, secret } = await issue(colleague, alpha);
    const row = await t.pool.query<{ hash: string; prefix: string }>(
      'select hash, prefix from api_keys where id = $1',
      [key.id],
    );
    expect(row.rows[0]).toEqual({ hash: sha256(secret), prefix: secret.slice(0, 11) });
    const anywhere = await t.pool.query(
      'select 1 from api_keys where hash = $1 or prefix = $1 union all select 1 from principals where display_name = $1',
      [secret],
    );
    expect(anywhere.rowCount).toBe(0);
  });

  it('ID-1, ID-5: a key authenticates as its own principal, acting for its owner, in one workspace', async () => {
    const { key, secret } = await issue(colleague, alpha, 'Reports');
    const res = await me(secret);
    expect(res.statusCode).toBe(200);
    const principal = (res.json() as { principal: Principal }).principal;
    expect(principal).toEqual({
      id: expect.any(String),
      kind: 'key',
      displayName: 'Reports',
      actingUserId: colleague.principal.id,
      isInstanceAdmin: false,
      workspaceScope: alpha.id,
    });
    expect(principal.id).not.toBe(colleague.principal.id);
    const used = await t.pool.query<{ last_used_at: Date | null }>(
      'select last_used_at from api_keys where id = $1',
      [key.id],
    );
    expect(used.rows[0]?.last_used_at).not.toBeNull();
  });

  it("ID-5: a key's caller is not told its owner's email", async () => {
    const { secret } = await issue(colleague, alpha, 'Mailer');
    const res = await me(secret);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { email: string | null }).email).toBeNull();
  });

  it('an outsider cannot issue a key for a workspace they are not in', async () => {
    const res = await as(t, outsider).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Sneaky' });
    expect(res.statusCode).toBe(404);
  });
});

describe('what a key may do (ID-5, NF-S2)', () => {
  it('reaches its own workspace, and not another workspace its owner also belongs to', async () => {
    const { secret } = await issue(owner, alpha);
    const api = bearer(secret);
    expect((await api.get(`/api/workspaces/${alpha.id}`)).statusCode).toBe(200);
    const other = await api.get(`/api/workspaces/${bravo.id}`);
    expect(other.statusCode).toBe(404);
    expect(code(other)).toBe('not_found');
    const listed = (await api.get('/api/workspaces')).json() as { workspaces: WorkspaceView[] };
    expect(listed.workspaces.map((w) => w.id)).toEqual([alpha.id]);
  });

  it('has exactly its owner role: demoting the owner demotes the key on its next request', async () => {
    const admin = await signedInUser(t, 'Temporary Admin');
    await setRole(alpha, admin, 'admin');
    const { secret } = await issue(admin, alpha);
    const rename = () => bearer(secret).patch(`/api/workspaces/${alpha.id}`, { name: 'Alpha' });

    expect((await rename()).statusCode).toBe(200);
    await setRole(alpha, admin, 'member');
    const after = await rename();
    expect(after.statusCode).toBe(403);
    expect(code(after)).toBe('forbidden');
  });

  it('stops working when its owner leaves the workspace', async () => {
    const leaver = await signedInUser(t, 'Leaver');
    await setRole(alpha, leaver, 'member');
    const { secret } = await issue(leaver, alpha);
    expect((await me(secret)).statusCode).toBe(200);
    await as(t, leaver).delete(`/api/workspaces/${alpha.id}/members/${leaver.principal.id}`);
    const res = await me(secret);
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe('unauthenticated');
  });

  it('stops working when its owner is suspended', async () => {
    const suspended = await signedInUser(t, 'Suspended');
    await setRole(alpha, suspended, 'member');
    const { secret } = await issue(suspended, alpha);
    await t.pool.query("update principals set status = 'suspended' where id = $1", [
      suspended.principal.id,
    ]);
    expect((await me(secret)).statusCode).toBe(401);
  });

  it('cannot mint, list or revoke keys, even for an admin owner', async () => {
    const { key, secret } = await issue(owner, alpha);
    const api = bearer(secret);
    expect((await api.post(`/api/workspaces/${alpha.id}/keys`, { name: 'Child' })).statusCode).toBe(
      403,
    );
    expect((await api.get(`/api/workspaces/${alpha.id}/keys`)).statusCode).toBe(403);
    expect((await api.delete(`/api/workspaces/${alpha.id}/keys/${key.id}`)).statusCode).toBe(403);
  });

  it('needs no Origin check: a bearer request carries no ambient credential', async () => {
    const { secret } = await issue(owner, alpha);
    const res = await bearer(secret, 'https://evil.example').patch(`/api/workspaces/${alpha.id}`, {
      name: 'Alpha',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('revoking keys (ID-6)', () => {
  it('a revoked key is refused on its very next request', async () => {
    const { key, secret } = await issue(colleague, alpha);
    expect((await me(secret)).statusCode).toBe(200);
    const started = Date.now();
    expect(
      (await as(t, colleague).delete(`/api/workspaces/${alpha.id}/keys/${key.id}`)).statusCode,
    ).toBe(204);
    expect((await me(secret)).statusCode).toBe(401);
    expect(Date.now() - started).toBeLessThan(5000);
    const listed = (await as(t, colleague).get(`/api/workspaces/${alpha.id}/keys`)).json() as {
      keys: KeyView[];
    };
    expect(listed.keys.find((k) => k.id === key.id)?.revokedAt).not.toBeNull();
  });

  it('admins see and revoke every key in their workspace; members only their own', async () => {
    const mine = await issue(colleague, alpha, 'Colleague key');
    const theirs = await issue(owner, alpha, 'Owner key');

    const memberList = (await as(t, colleague).get(`/api/workspaces/${alpha.id}/keys`)).json() as {
      keys: KeyView[];
    };
    expect(memberList.keys.every((k) => k.owner.principalId === colleague.principal.id)).toBe(true);
    const adminList = (await as(t, owner).get(`/api/workspaces/${alpha.id}/keys`)).json() as {
      keys: KeyView[];
    };
    expect(adminList.keys.map((k) => k.id)).toEqual(
      expect.arrayContaining([mine.key.id, theirs.key.id]),
    );

    const denied = await as(t, colleague).delete(
      `/api/workspaces/${alpha.id}/keys/${theirs.key.id}`,
    );
    expect(denied.statusCode).toBe(403);
    expect(
      (await as(t, owner).delete(`/api/workspaces/${alpha.id}/keys/${mine.key.id}`)).statusCode,
    ).toBe(204);
    expect((await me(mine.secret)).statusCode).toBe(401);
  });

  it('AC 16: a key cannot be reached through another workspace path', async () => {
    const bravoKey = await issue(owner, bravo);
    const res = await as(t, owner).delete(`/api/workspaces/${alpha.id}/keys/${bravoKey.key.id}`);
    expect(res.statusCode).toBe(404);
    expect((await me(bravoKey.secret)).statusCode).toBe(200);
    const outsider404 = await as(t, outsider).get(`/api/workspaces/${alpha.id}/keys`);
    expect(outsider404.statusCode).toBe(404);
  });
});

describe('bearer authentication', () => {
  it('unknown, malformed and wrong-scheme credentials are refused alike', async () => {
    const unknown = `lk_${randomBytes(32).toString('base64url')}`;
    for (const authorization of [
      `Bearer ${unknown}`,
      'Bearer not-a-key',
      'Basic dXNlcjpwYXNz',
      'Bearer',
    ]) {
      const res = await t.app.inject({ url: '/api/me', headers: { authorization } });
      expect({ authorization, status: res.statusCode }).toEqual({ authorization, status: 401 });
    }
  });

  it('a bad key is never rescued by a valid session cookie', async () => {
    const res = await t.app.inject({
      url: '/api/me',
      headers: { authorization: 'Bearer lk_wrong', cookie: colleague.cookie, origin: PUBLIC_URL },
    });
    expect(res.statusCode).toBe(401);
  });

  it('NF-S5: key secrets never reach the logs', async () => {
    const { secret } = await issue(colleague, alpha);
    await me(secret);
    await bearer(secret).get(`/api/workspaces/${bravo.id}`);
    expect(t.logs.join('')).not.toContain(secret);
    expect(t.logs.join('')).not.toContain(secret.slice(3));
  });
});
