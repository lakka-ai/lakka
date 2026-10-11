import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type {
  CreatedInvite,
  InvitePreview,
  InviteView,
  IssuedKey,
  MemberView,
  WorkspaceView,
} from '@lakka/contracts';
import {
  PUBLIC_URL,
  anonymous,
  as,
  clientIp,
  createTestApp,
  signIn,
  signedInUser,
} from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Invite links (ID-7, ADR 0035) against real Postgres and Valkey. Isolation is checked by
 * calling the api directly with another workspace's ids (CLAUDE.md, Testing).
 */

let t: TestApp;
let alice: SignedInUser; // instance admin, member of nothing
let bob: SignedInUser; // admin of alpha
let carol: SignedInUser; // member of alpha
let dave: SignedInUser; // admin of bravo
let erin: SignedInUser; // belongs to nothing
let alpha: WorkspaceView;
let bravo: WorkspaceView;
const sensitive: string[] = [];

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const tag = () => randomBytes(3).toString('hex');

async function workspace(name: string, admin: SignedInUser): Promise<WorkspaceView> {
  const res = await as(t, alice).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${tag()}`,
  });
  const ws = (res.json() as { workspace: WorkspaceView }).workspace;
  await as(t, alice).put(`/api/workspaces/${ws.id}/members/${admin.principal.id}`, {
    role: 'admin',
  });
  await as(t, alice).delete(`/api/workspaces/${ws.id}/members/${alice.principal.id}`);
  return ws;
}

async function invite(
  by: SignedInUser,
  ws: WorkspaceView,
  role: 'admin' | 'member' = 'member',
): Promise<CreatedInvite> {
  const res = await as(t, by).post(`/api/workspaces/${ws.id}/invites`, { role });
  if (res.statusCode !== 201) throw new Error(`invite failed: ${res.statusCode} ${res.body}`);
  const created = res.json() as CreatedInvite;
  sensitive.push(created.token);
  return created;
}

function newAccount(name = 'Invitee') {
  const t2 = tag();
  const account = {
    name,
    email: `invitee-${t2}@example.com`,
    password: `invitee password ${t2}`,
  };
  sensitive.push(account.password);
  return account;
}

/** Accepts as a signed-in user, from a fresh client address. */
const acceptAs = (user: SignedInUser, token: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/invites/accept',
    headers: { cookie: user.cookie, origin: PUBLIC_URL, 'x-forwarded-for': clientIp() },
    payload: { token },
  });

const members = async (ws: WorkspaceView, viewer: SignedInUser) =>
  (
    (await as(t, viewer).get(`/api/workspaces/${ws.id}/members`)).json() as {
      members: MemberView[];
    }
  ).members;

const pending = async (ws: WorkspaceView, viewer: SignedInUser) =>
  (
    (await as(t, viewer).get(`/api/workspaces/${ws.id}/invites`)).json() as {
      invites: InviteView[];
    }
  ).invites;

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
  alpha = await workspace('Alpha', bob);
  bravo = await workspace('Bravo', dave);
  await as(t, alice).put(`/api/workspaces/${alpha.id}/members/${carol.principal.id}`, {
    role: 'member',
  });
});

afterAll(async () => {
  await t.close();
});

describe('creating and listing invites', () => {
  it('ID-7: a workspace admin creates a link; the token is returned once and never listed', async () => {
    const res = await as(t, bob).post(`/api/workspaces/${alpha.id}/invites`, { role: 'member' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const created = res.json() as CreatedInvite;
    sensitive.push(created.token);
    expect(created.invite).toMatchObject({
      workspaceId: alpha.id,
      role: 'member',
      createdBy: { principalId: bob.principal.id, displayName: 'Bob' },
    });
    const days = (Date.parse(created.invite.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    const list = await as(t, bob).get(`/api/workspaces/${alpha.id}/invites`);
    expect(list.body).not.toContain(created.token);
    expect((list.json() as { invites: InviteView[] }).invites.map((i) => i.id)).toContain(
      created.invite.id,
    );
    const stored = await t.pool.query('select token_hash from invites where id = $1', [
      created.invite.id,
    ]);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ID-3: a member cannot create, list or revoke invites', async () => {
    const theirs = await invite(bob, alpha);
    expect(
      (await as(t, carol).post(`/api/workspaces/${alpha.id}/invites`, { role: 'member' }))
        .statusCode,
    ).toBe(403);
    expect((await as(t, carol).get(`/api/workspaces/${alpha.id}/invites`)).statusCode).toBe(403);
    expect(
      (await as(t, carol).delete(`/api/workspaces/${alpha.id}/invites/${theirs.invite.id}`))
        .statusCode,
    ).toBe(403);
  });

  it('AC 16: another workspace cannot see, create or revoke invites, even with a known id', async () => {
    const theirs = await invite(bob, alpha);
    expect((await as(t, dave).get(`/api/workspaces/${alpha.id}/invites`)).statusCode).toBe(404);
    expect(
      (await as(t, dave).post(`/api/workspaces/${alpha.id}/invites`, { role: 'admin' })).statusCode,
    ).toBe(404);
    expect(
      (await as(t, dave).delete(`/api/workspaces/${alpha.id}/invites/${theirs.invite.id}`))
        .statusCode,
    ).toBe(404);
    // Through their own workspace's path, the other workspace's invite id does not exist.
    const crossPath = await as(t, dave).delete(
      `/api/workspaces/${bravo.id}/invites/${theirs.invite.id}`,
    );
    expect(crossPath.statusCode).toBe(404);
    expect((await pending(alpha, bob)).map((i) => i.id)).toContain(theirs.invite.id);
  });

  it("ID-5, NF-S2: a key can neither create nor accept invites, even its admin owner's", async () => {
    const issued = (
      await as(t, bob).post(`/api/workspaces/${alpha.id}/keys`, { name: 'ci' })
    ).json() as IssuedKey;
    sensitive.push(issued.secret);
    const bearer = { authorization: `Bearer ${issued.secret}`, 'x-forwarded-for': clientIp() };
    const create = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${alpha.id}/invites`,
      headers: bearer,
      payload: { role: 'member' },
    });
    expect(create.statusCode).toBe(403);
    const other = await invite(dave, bravo);
    const accept = await t.app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: bearer,
      payload: { token: other.token },
    });
    expect(accept.statusCode).toBe(403);
    expect((await members(bravo, dave)).map((m) => m.principalId)).not.toContain(bob.principal.id);
  });

  it('ID-3: an instance admin can invite into a workspace they are not a member of', async () => {
    const created = await invite(alice, bravo, 'member');
    const preview = await anonymous(t).post('/api/invites/preview', { token: created.token });
    expect(preview.statusCode).toBe(200);
  });
});

describe('accepting invites', () => {
  it('ID-7: someone new previews the link, creates an account with it, and is signed in as a member', async () => {
    const created = await invite(bob, alpha, 'member');
    const preview = await anonymous(t).post('/api/invites/preview', { token: created.token });
    expect(preview.statusCode).toBe(200);
    expect(preview.json() as InvitePreview).toMatchObject({
      workspaceName: 'Alpha',
      role: 'member',
    });

    const account = newAccount('Frank');
    const res = await anonymous(t).post('/api/invites/accept', { token: created.token, account });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspaceId: alpha.id });
    const session = res.cookies.find((c) => c.name === 'lakka.session_token');
    const headers = { cookie: `${session?.name}=${session?.value}`, origin: PUBLIC_URL };
    const ws = await t.app.inject({ method: 'GET', url: `/api/workspaces/${alpha.id}`, headers });
    expect((ws.json() as { workspace: WorkspaceView }).workspace.role).toBe('member');

    expect(await signIn(t, account.email, account.password)).toBeDefined();
    const frank = (await members(alpha, bob)).find((m) => m.email === account.email);
    expect(frank).toMatchObject({ displayName: 'Frank', role: 'member' });
    expect((await pending(alpha, bob)).map((i) => i.id)).not.toContain(created.invite.id);
  });

  it('ID-7: a link works once', async () => {
    const created = await invite(bob, alpha);
    const first = await anonymous(t).post('/api/invites/accept', {
      token: created.token,
      account: newAccount(),
    });
    expect(first.statusCode).toBe(200);
    const second = await anonymous(t).post('/api/invites/accept', {
      token: created.token,
      account: newAccount(),
    });
    expect(second.statusCode).toBe(404);
    expect(code(second)).toBe('invite_invalid');
    expect(
      (await anonymous(t).post('/api/invites/preview', { token: created.token })).statusCode,
    ).toBe(404);
  });

  it('ID-7, ID-4: a signed-in person joins as themselves with the invited role', async () => {
    const created = await invite(dave, bravo, 'admin');
    const res = await acceptAs(erin, created.token);
    expect(res.statusCode).toBe(200);
    const row = (await members(bravo, dave)).find((m) => m.principalId === erin.principal.id);
    expect(row?.role).toBe('admin');
  });

  it('ID-7: someone already in the workspace is told so, and the link stays usable', async () => {
    const created = await invite(bob, alpha);
    const res = await acceptAs(carol, created.token);
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('already_member');
    expect(
      (await anonymous(t).post('/api/invites/preview', { token: created.token })).statusCode,
    ).toBe(200);
  });

  it('ID-7: accepting without an account or a session is refused', async () => {
    const created = await invite(bob, alpha);
    const res = await anonymous(t).post('/api/invites/accept', { token: created.token });
    expect(res.statusCode).toBe(401);
  });

  it('ID-7: an email that already has an account is refused, leaving the link usable', async () => {
    const created = await invite(bob, alpha);
    const res = await anonymous(t).post('/api/invites/accept', {
      token: created.token,
      account: { ...newAccount(), email: erin.email },
    });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('email_taken');
    expect(
      (await anonymous(t).post('/api/invites/preview', { token: created.token })).statusCode,
    ).toBe(200);
  });

  it('ID-7: two people racing for one link: exactly one joins, and the other is left with no account', async () => {
    const created = await invite(bob, alpha);
    const accounts = [newAccount('Racer'), newAccount('Racer')];
    const results = await Promise.all(
      accounts.map((account) =>
        anonymous(t).post('/api/invites/accept', { token: created.token, account }),
      ),
    );
    expect(results.map((r) => r.statusCode).toSorted()).toEqual([200, 404]);
    const loser = accounts[results.findIndex((r) => r.statusCode === 404)];
    const orphans = await t.pool.query('select 1 from auth_users where email = $1', [loser?.email]);
    expect(orphans.rowCount).toBe(0);
  });

  it('ID-7: an unknown, malformed, revoked or expired token is refused alike', async () => {
    const unknown = randomBytes(32).toString('base64url');
    const res = await anonymous(t).post('/api/invites/preview', { token: unknown });
    expect(res.statusCode).toBe(404);
    expect(code(res)).toBe('invite_invalid');
    expect((await anonymous(t).post('/api/invites/preview', { token: 'short' })).statusCode).toBe(
      400,
    );

    const revoked = await invite(bob, alpha);
    expect(
      (await as(t, bob).delete(`/api/workspaces/${alpha.id}/invites/${revoked.invite.id}`))
        .statusCode,
    ).toBe(204);
    const afterRevoke = await anonymous(t).post('/api/invites/accept', {
      token: revoked.token,
      account: newAccount(),
    });
    expect(code(afterRevoke)).toBe('invite_invalid');
    expect(
      (await as(t, bob).delete(`/api/workspaces/${alpha.id}/invites/${revoked.invite.id}`))
        .statusCode,
    ).toBe(404);

    const expired = await invite(bob, alpha);
    await t.pool.query(
      "update invites set expires_at = now() - interval '1 second' where id = $1",
      [expired.invite.id],
    );
    expect(code(await acceptAs(erin, expired.token))).toBe('invite_invalid');
    expect((await pending(alpha, bob)).map((i) => i.id)).not.toContain(expired.invite.id);
  });

  it('NF-S2: an invite stops working when its creator is demoted, and works again when restored', async () => {
    const created = await invite(bob, alpha);
    await as(t, alice).put(`/api/workspaces/${alpha.id}/members/${carol.principal.id}`, {
      role: 'admin',
    });
    await as(t, alice).put(`/api/workspaces/${alpha.id}/members/${bob.principal.id}`, {
      role: 'member',
    });
    const preview = () => anonymous(t).post('/api/invites/preview', { token: created.token });
    expect((await preview()).statusCode).toBe(404);
    await as(t, alice).put(`/api/workspaces/${alpha.id}/members/${bob.principal.id}`, {
      role: 'admin',
    });
    await as(t, alice).put(`/api/workspaces/${alpha.id}/members/${carol.principal.id}`, {
      role: 'member',
    });
    expect((await preview()).statusCode).toBe(200);
  });

  it('ID-6: an invite from a suspended person does not work', async () => {
    const created = await invite(dave, bravo);
    await as(t, alice).post(`/api/users/${dave.principal.id}/suspend`, {});
    const preview = await anonymous(t).post('/api/invites/preview', { token: created.token });
    expect(preview.statusCode).toBe(404);
    await as(t, alice).post(`/api/users/${dave.principal.id}/reactivate`, {});
    dave = { ...dave, cookie: (await signIn(t, dave.email, dave.password)) ?? '' };
  });

  it('NF-S5: no invite token, key secret or password reaches the logs', () => {
    const logs = t.logs.join('\n');
    expect(sensitive.length).toBeGreaterThan(10);
    for (const value of sensitive) expect(logs).not.toContain(value);
    expect(logs).toContain('"msg":"invite.accepted"');
  });
});
