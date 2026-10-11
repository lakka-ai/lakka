import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type { IssuedKey, UserAdminView, WorkspaceView } from '@lakka/contracts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The People page's data (ID-3, ID-6, ADR 0097): each person's workspaces, how they sign in and
 * when they were last active, and making someone an instance admin or not.
 */

let t: TestApp;
let admin: SignedInUser;
let ws: WorkspaceView;

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;

async function people(): Promise<UserAdminView[]> {
  const res = await as(t, admin).get('/api/users');
  expect(res.statusCode).toBe(200);
  return (res.json() as { users: UserAdminView[] }).users;
}

async function person(id: string): Promise<UserAdminView> {
  const found = (await people()).find((p) => p.id === id);
  if (found === undefined) throw new Error(`no person ${id}`);
  return found;
}

const setAdmin = (user: SignedInUser, id: string, isInstanceAdmin: boolean) =>
  as(t, user).put(`/api/users/${id}/instance-admin`, { isInstanceAdmin });

beforeAll(async () => {
  t = await createTestApp();
  admin = await signedInUser(t, 'Admin');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  ws = (
    (
      await as(t, admin).post('/api/workspaces', {
        name: 'Product',
        slug: `product-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
});

afterAll(async () => {
  await t.close();
});

describe('the People list (ID-6, ADR 0097)', () => {
  it('ID-6: lists each person with their workspaces and roles, and that they sign in with a password', async () => {
    const member = await signedInUser(t, 'Member');
    await as(t, admin).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
      role: 'member',
    });
    const row = await person(member.principal.id);
    expect(row.workspaces).toEqual([{ id: ws.id, name: 'Product', role: 'member' }]);
    expect(row.signsInWith).toEqual([{ kind: 'password' }]);
    expect((await person(admin.principal.id)).workspaces).toEqual([
      { id: ws.id, name: 'Product', role: 'admin' },
    ]);
  });

  it('ID-6: records when a person was last active, by session or through their key, and keeps it through suspension', async () => {
    const member = await signedInUser(t, 'Active');
    await as(t, admin).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
      role: 'member',
    });
    await t.pool.query('update principals set last_active_at = null where id = $1', [
      member.principal.id,
    ]);
    expect((await person(member.principal.id)).lastActiveAt).toBeNull();

    await as(t, member).get('/api/me');
    const first = (await person(member.principal.id)).lastActiveAt;
    expect(first).not.toBeNull();

    const key = (
      await as(t, member).post(`/api/workspaces/${ws.id}/keys`, { name: 'Script' })
    ).json() as IssuedKey;
    await t.pool.query(
      "update principals set last_active_at = now() - interval '1 day' where id = $1",
      [member.principal.id],
    );
    const viaKey = await t.app.inject({
      url: '/api/me',
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(viaKey.statusCode).toBe(200);
    const afterKey = (await person(member.principal.id)).lastActiveAt;
    expect(Date.now() - Date.parse(afterKey ?? '')).toBeLessThan(60_000);

    await as(t, admin).post(`/api/users/${member.principal.id}/suspend`, {});
    expect((await person(member.principal.id)).lastActiveAt).toBe(afterKey);
  });

  it('ID-6: writes activity at most once every few minutes', async () => {
    const busy = await signedInUser(t, 'Busy');
    await as(t, busy).get('/api/me');
    const before = (await person(busy.principal.id)).lastActiveAt;
    await as(t, busy).get('/api/me');
    expect((await person(busy.principal.id)).lastActiveAt).toBe(before);
  });
});

describe('instance admins (ID-3, ADR 0097)', () => {
  it('ID-3: an instance admin makes someone an instance admin, and removes it again', async () => {
    const other = await signedInUser(t, 'Other');
    const made = await setAdmin(admin, other.principal.id, true);
    expect(made.statusCode).toBe(200);
    expect((made.json() as { user: UserAdminView }).user.isInstanceAdmin).toBe(true);
    const me = await as(t, other).get('/api/me');
    expect(
      (me.json() as { principal: { isInstanceAdmin: boolean } }).principal.isInstanceAdmin,
    ).toBe(true);

    const removed = await setAdmin(admin, other.principal.id, false);
    expect(removed.statusCode).toBe(200);
    expect((await person(other.principal.id)).isInstanceAdmin).toBe(false);
  });

  it('ID-3: refuses to remove the last active instance admin', async () => {
    const res = await setAdmin(admin, admin.principal.id, false);
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('last_instance_admin');
    expect((await person(admin.principal.id)).isInstanceAdmin).toBe(true);
  });

  it('ID-3: a suspended instance admin does not count as the one left', async () => {
    const second = await signedInUser(t, 'Second');
    await setAdmin(admin, second.principal.id, true);
    await as(t, admin).post(`/api/users/${second.principal.id}/suspend`, {});
    const res = await setAdmin(admin, admin.principal.id, false);
    expect(code(res)).toBe('last_instance_admin');
  });

  it('ID-3: people who are not instance admins cannot change it, for themselves or anyone', async () => {
    const plain = await signedInUser(t, 'Plain');
    expect((await setAdmin(plain, plain.principal.id, true)).statusCode).toBe(403);
    expect((await setAdmin(plain, admin.principal.id, false)).statusCode).toBe(403);
  });

  it('ID-3: answers 404 for someone who does not exist', async () => {
    const res = await setAdmin(admin, '01920000-0000-7000-8000-000000000000', true);
    expect(res.statusCode).toBe(404);
  });
});
