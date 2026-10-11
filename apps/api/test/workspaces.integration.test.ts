import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type { MemberView, WorkspaceView } from '@lakka/contracts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

let t: TestApp;
let alice: SignedInUser; // instance admin
let bob: SignedInUser; // admin of alpha
let carol: SignedInUser; // member of alpha, admin of bravo
let dave: SignedInUser; // admin of bravo
let erin: SignedInUser; // belongs to nothing
let alpha: WorkspaceView;
let bravo: WorkspaceView;

const slug = (base: string) => `${base}-${randomBytes(3).toString('hex')}`;
const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const members = (res: { json(): unknown }) => (res.json() as { members: MemberView[] }).members;

async function workspace(owner: SignedInUser, name: string): Promise<WorkspaceView> {
  const res = await as(t, owner).post('/api/workspaces', { name, slug: slug(name.toLowerCase()) });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function addMember(ws: WorkspaceView, user: SignedInUser, role: 'admin' | 'member') {
  const res = await as(t, alice).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role,
  });
  if (res.statusCode !== 200) throw new Error(`add failed: ${res.statusCode} ${res.body}`);
}

const ids = async (user: SignedInUser) =>
  (
    (await as(t, user).get('/api/workspaces')).json() as { workspaces: WorkspaceView[] }
  ).workspaces.map((w) => w.id);

const attempts = (wsId: string, victimId: string) =>
  [
    ['read the workspace', (u: SignedInUser) => as(t, u).get(`/api/workspaces/${wsId}`)],
    [
      'rename it',
      (u: SignedInUser) => as(t, u).patch(`/api/workspaces/${wsId}`, { name: 'Taken over' }),
    ],
    ['list its members', (u: SignedInUser) => as(t, u).get(`/api/workspaces/${wsId}/members`)],
    [
      'make themselves admin',
      (u: SignedInUser) =>
        as(t, u).put(`/api/workspaces/${wsId}/members/${u.principal.id}`, { role: 'admin' }),
    ],
    [
      'demote a member',
      (u: SignedInUser) =>
        as(t, u).put(`/api/workspaces/${wsId}/members/${victimId}`, { role: 'member' }),
    ],
    [
      'remove a member',
      (u: SignedInUser) => as(t, u).delete(`/api/workspaces/${wsId}/members/${victimId}`),
    ],
  ] as const;

beforeAll(async () => {
  t = await createTestApp();
  [alice, bob, carol, dave, erin] = await Promise.all([
    signedInUser(t, 'Alice'),
    signedInUser(t, 'Bob'),
    signedInUser(t, 'Carol'),
    signedInUser(t, 'Dave'),
    signedInUser(t, 'Erin'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    alice.principal.id,
  ]);
  alpha = await workspace(alice, 'Alpha');
  bravo = await workspace(alice, 'Bravo');
  await addMember(alpha, bob, 'admin');
  await addMember(alpha, carol, 'member');
  await addMember(bravo, carol, 'admin');
  await addMember(bravo, dave, 'admin');
});

afterAll(async () => {
  await t.close();
});

describe('creating workspaces', () => {
  it('ID-3: only an instance admin creates a workspace, and becomes its admin', async () => {
    const denied = await as(t, bob).post('/api/workspaces', { name: 'Rogue', slug: slug('rogue') });
    expect(denied.statusCode).toBe(403);
    expect(code(denied)).toBe('forbidden');
    const created = await workspace(alice, 'Charlie');
    expect(created.role).toBe('admin');
  });

  it('ID-3: an instance admin names someone else as the first admin', async () => {
    const frank = await signedInUser(t, 'Frank');
    const res = await as(t, alice).post('/api/workspaces', {
      name: 'Delta',
      slug: slug('delta'),
      adminPrincipalId: frank.principal.id,
    });
    expect(res.statusCode).toBe(201);
    const created = (res.json() as { workspace: WorkspaceView }).workspace;
    expect(created.role).toBeNull();
    expect(
      members(await as(t, alice).get(`/api/workspaces/${created.id}/members`)).map((m) => [
        m.principalId,
        m.role,
      ]),
    ).toEqual([[frank.principal.id, 'admin']]);
    expect(await ids(frank)).toEqual([created.id]);
  });

  it('ID-3: the first admin must be an active user', async () => {
    const res = await as(t, alice).post('/api/workspaces', {
      name: 'Echo',
      slug: slug('echo'),
      adminPrincipalId: randomUUID(),
    });
    expect(res.statusCode).toBe(404);
    expect(code(res)).toBe('not_found');
  });

  it('slugs are unique', async () => {
    const res = await as(t, alice).post('/api/workspaces', { name: 'Again', slug: alpha.slug });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('slug_taken');
  });

  it('invalid input is refused naming the fields, without echoing values', async () => {
    const res = await as(t, alice).post('/api/workspaces', {
      name: '',
      slug: 'Not A Slug!',
      extra: 'x',
    });
    expect(res.statusCode).toBe(400);
    const body = apiErrorBody.parse(res.json());
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('slug');
    expect(body.error.message).not.toContain('Not A Slug');
  });
});

describe('membership and roles', () => {
  it('ID-4: one person belongs to several workspaces with a different role in each', async () => {
    const res = await as(t, carol).get('/api/workspaces');
    const roles = Object.fromEntries(
      (res.json() as { workspaces: WorkspaceView[] }).workspaces.map((w) => [w.id, w.role]),
    );
    expect(roles).toEqual({ [alpha.id]: 'member', [bravo.id]: 'admin' });
  });

  it('ID-3: people list only their own workspaces; instance admins list all', async () => {
    expect(await ids(bob)).toEqual([alpha.id]);
    expect(await ids(erin)).toEqual([]);
    expect(await ids(alice)).toEqual(expect.arrayContaining([alpha.id, bravo.id]));
  });

  it('ID-3: a member reads the workspace and its members but cannot manage it', async () => {
    const api = as(t, carol);
    expect((await api.get(`/api/workspaces/${alpha.id}`)).statusCode).toBe(200);
    expect(members(await api.get(`/api/workspaces/${alpha.id}/members`)).length).toBeGreaterThan(1);
    expect(code(await api.patch(`/api/workspaces/${alpha.id}`, { name: 'Mine' }))).toBe(
      'forbidden',
    );
    expect(
      code(
        await api.put(`/api/workspaces/${alpha.id}/members/${bob.principal.id}`, {
          role: 'member',
        }),
      ),
    ).toBe('forbidden');
    expect(code(await api.delete(`/api/workspaces/${alpha.id}/members/${bob.principal.id}`))).toBe(
      'forbidden',
    );
  });

  it('ID-3: a workspace admin renames it and manages roles, but cannot add people directly', async () => {
    const api = as(t, bob);
    const renamed = await api.patch(`/api/workspaces/${alpha.id}`, { name: 'Alpha Team' });
    expect((renamed.json() as { workspace: WorkspaceView }).workspace.name).toBe('Alpha Team');

    const promoted = await api.put(`/api/workspaces/${alpha.id}/members/${carol.principal.id}`, {
      role: 'admin',
    });
    expect(members(promoted).find((m) => m.principalId === carol.principal.id)?.role).toBe('admin');
    await api.put(`/api/workspaces/${alpha.id}/members/${carol.principal.id}`, { role: 'member' });

    const direct = await api.put(`/api/workspaces/${alpha.id}/members/${erin.principal.id}`, {
      role: 'member',
    });
    expect(direct.statusCode).toBe(403);
  });

  it('adding someone who is not an active user is refused', async () => {
    const api = as(t, alice);
    const ghost = '0192f5e0-0000-7000-8000-000000000000';
    expect(
      (await api.put(`/api/workspaces/${alpha.id}/members/${ghost}`, { role: 'member' }))
        .statusCode,
    ).toBe(404);
    const frank = await signedInUser(t, 'Frank');
    await t.pool.query("update principals set status = 'suspended' where id = $1", [
      frank.principal.id,
    ]);
    expect(
      (
        await api.put(`/api/workspaces/${alpha.id}/members/${frank.principal.id}`, {
          role: 'member',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('anyone may leave a workspace', async () => {
    const gina = await signedInUser(t, 'Gina');
    await addMember(alpha, gina, 'member');
    const res = await as(t, gina).delete(
      `/api/workspaces/${alpha.id}/members/${gina.principal.id}`,
    );
    expect(res.statusCode).toBe(204);
    expect((await as(t, gina).get(`/api/workspaces/${alpha.id}`)).statusCode).toBe(404);
  });
});

describe('the last admin (ADR 0029)', () => {
  it('cannot be demoted or leave', async () => {
    const ws = await workspace(alice, 'Solo');
    await addMember(ws, dave, 'admin');
    expect(
      (await as(t, alice).delete(`/api/workspaces/${ws.id}/members/${alice.principal.id}`))
        .statusCode,
    ).toBe(204);

    const demote = await as(t, dave).put(`/api/workspaces/${ws.id}/members/${dave.principal.id}`, {
      role: 'member',
    });
    expect(demote.statusCode).toBe(409);
    expect(code(demote)).toBe('last_workspace_admin');
    const leave = await as(t, dave).delete(`/api/workspaces/${ws.id}/members/${dave.principal.id}`);
    expect(code(leave)).toBe('last_workspace_admin');
  });

  it('survives two admins demoting each other at the same moment', async () => {
    const ws = await workspace(alice, 'Duel');
    const [x, y] = await Promise.all([signedInUser(t, 'Xena'), signedInUser(t, 'Yuri')]);
    await addMember(ws, x, 'admin');
    await addMember(ws, y, 'admin');
    await as(t, alice).delete(`/api/workspaces/${ws.id}/members/${alice.principal.id}`);

    for (let round = 0; round < 10; round += 1) {
      const [a, b] = await Promise.all([
        as(t, x).put(`/api/workspaces/${ws.id}/members/${y.principal.id}`, { role: 'member' }),
        as(t, y).put(`/api/workspaces/${ws.id}/members/${x.principal.id}`, { role: 'member' }),
      ]);
      const admins = await t.pool.query(
        "select count(*)::int as n from memberships where workspace_id = $1 and role = 'admin'",
        [ws.id],
      );
      expect(admins.rows[0]?.n).toBe(1);
      // One demotion wins. The other is refused: 409 if it reached the locked check while its
      // author was still an admin, 403 if its author had already been demoted when authorized.
      const [winner, loser] = [a.statusCode, b.statusCode].toSorted();
      expect(winner).toBe(200);
      expect([403, 409]).toContain(loser);
      // Put both back as admins for the next round.
      await addMember(ws, x, 'admin');
      await addMember(ws, y, 'admin');
    }
  });
});

describe('isolation between workspaces (AC 16, checked by calling the API directly)', () => {
  const nonexistent = '0192f5e0-ffff-7fff-bfff-ffffffffffff';

  it('ID-3, NF-S2: an outsider and an admin of another workspace both see it as nonexistent', async () => {
    for (const intruder of [erin, bob]) {
      for (const [what, attempt] of attempts(bravo.id, dave.principal.id)) {
        const res = await attempt(intruder);
        expect({ what, status: res.statusCode, code: code(res) }).toEqual({
          what,
          status: 404,
          code: 'not_found',
        });
      }
    }
  });

  it('answers exactly as for a workspace that does not exist, so nothing leaks', async () => {
    const real = await as(t, erin).get(`/api/workspaces/${bravo.id}`);
    const missing = await as(t, erin).get(`/api/workspaces/${nonexistent}`);
    expect(real.statusCode).toBe(missing.statusCode);
    expect(real.json()).toEqual(missing.json());
  });

  it('left the other workspace untouched', async () => {
    const view = (await as(t, dave).get(`/api/workspaces/${bravo.id}`)).json() as {
      workspace: WorkspaceView;
    };
    expect(view.workspace.name).toBe('Bravo');
    const roles = Object.fromEntries(
      members(await as(t, dave).get(`/api/workspaces/${bravo.id}/members`)).map((m) => [
        m.principalId,
        m.role,
      ]),
    );
    expect(roles).toEqual({
      [alice.principal.id]: 'admin',
      [carol.principal.id]: 'admin',
      [dave.principal.id]: 'admin',
    });
  });

  it('the workspace always comes from the path; a body cannot redirect a write', async () => {
    const res = await as(t, bob).put(`/api/workspaces/${alpha.id}/members/${carol.principal.id}`, {
      role: 'admin',
      workspaceId: bravo.id,
    });
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe('invalid_request');
  });

  it('refuses unauthenticated requests before looking anything up', async () => {
    const res = await t.app.inject({ url: `/api/workspaces/${bravo.id}` });
    expect(res.statusCode).toBe(401);
  });
});
