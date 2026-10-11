import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type { IssuedKey, UserAdminView, WorkspaceView } from '@lakka/contracts';
import {
  createCacheClient,
  createLogger,
  PRINCIPAL_REVOKED_CHANNEL,
  subscribe,
  suspendUser,
  valkeyEvents,
} from '@lakka/core';
import type { CacheSubscription, PrincipalRevokedEvent } from '@lakka/core';
import { as, createTestApp, signIn, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';
import { valkeyConfig } from '../../../test/integration/valkey.ts';

let t: TestApp;
let admin: SignedInUser;
let ws: WorkspaceView;
let subscription: CacheSubscription;
const events: PrincipalRevokedEvent[] = [];

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const me = (headers: Record<string, string>) => t.app.inject({ url: '/api/me', headers });

async function member(name: string): Promise<SignedInUser> {
  const user = await signedInUser(t, name);
  const res = await as(t, admin).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role: 'member',
  });
  if (res.statusCode !== 200) throw new Error(`add failed: ${res.statusCode}`);
  return user;
}

async function issueKey(user: SignedInUser): Promise<IssuedKey> {
  return (
    await as(t, user).post(`/api/workspaces/${ws.id}/keys`, { name: 'Key' })
  ).json() as IssuedKey;
}

/** Waits for a matching event; pub/sub delivery is asynchronous. */
async function eventFor(principalId: string, reason: PrincipalRevokedEvent['reason']) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = events.find((e) => e.principalId === principalId && e.reason === reason);
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${reason} event for ${principalId}`);
}

beforeAll(async () => {
  t = await createTestApp();
  subscription = await subscribe(
    valkeyConfig(),
    'lakka-tests-sub',
    [PRINCIPAL_REVOKED_CHANNEL],
    (_c, m) => {
      events.push(JSON.parse(m) as PrincipalRevokedEvent);
    },
  );
  admin = await signedInUser(t, 'Admin');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  const res = await as(t, admin).post('/api/workspaces', {
    name: 'Team',
    slug: `team-${randomBytes(3).toString('hex')}`,
  });
  ws = (res.json() as { workspace: WorkspaceView }).workspace;
});

afterAll(async () => {
  subscription.close();
  await t.close();
});

describe('suspending a person (ID-6, AC 6)', () => {
  it('ends their sessions and disables their keys within 5 seconds, then publishes an event', async () => {
    const person = await member('Suspendee');
    const key = await issueKey(person);
    expect((await me({ cookie: person.cookie })).statusCode).toBe(200);
    expect((await me({ authorization: `Bearer ${key.secret}` })).statusCode).toBe(200);

    const started = Date.now();
    const res = await as(t, admin).post(`/api/users/${person.principal.id}/suspend`, {});
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: UserAdminView }).user.status).toBe('suspended');
    expect((await me({ cookie: person.cookie })).statusCode).toBe(401);
    expect((await me({ authorization: `Bearer ${key.secret}` })).statusCode).toBe(401);
    expect(Date.now() - started).toBeLessThan(5000);

    const sessions = await t.pool.query(
      'select count(*)::int as n from auth_sessions s join principals p on p.auth_subject = s.user_id where p.id = $1',
      [person.principal.id],
    );
    expect(sessions.rows[0]?.n).toBe(0);
    expect(await eventFor(person.principal.id, 'suspended')).toMatchObject({ workspaceId: null });
  });

  it('cannot sign in while suspended', async () => {
    const person = await member('Locked Out');
    await as(t, admin).post(`/api/users/${person.principal.id}/suspend`, {});
    expect(await signIn(t, person.email, person.password)).toBeUndefined();
    const sessions = await t.pool.query(
      'select count(*)::int as n from auth_sessions s join principals p on p.auth_subject = s.user_id where p.id = $1',
      [person.principal.id],
    );
    expect(sessions.rows[0]?.n).toBe(0);
  });

  it('reactivation restores access by signing in again, not the old session; keys work again', async () => {
    const person = await member('Returner');
    const key = await issueKey(person);
    await as(t, admin).post(`/api/users/${person.principal.id}/suspend`, {});
    const res = await as(t, admin).post(`/api/users/${person.principal.id}/reactivate`, {});
    expect((res.json() as { user: UserAdminView }).user.status).toBe('active');

    expect((await me({ cookie: person.cookie })).statusCode).toBe(401);
    const fresh = await signIn(t, person.email, person.password);
    expect(fresh).toBeDefined();
    expect((await me({ cookie: fresh ?? '' })).statusCode).toBe(200);
    expect((await me({ authorization: `Bearer ${key.secret}` })).statusCode).toBe(200);
  });

  it('only instance admins suspend, list or reactivate people; keys never can', async () => {
    const person = await member('Plain Member');
    const target = await member('Target');
    expect((await as(t, person).get('/api/users')).statusCode).toBe(403);
    expect(code(await as(t, person).post(`/api/users/${target.principal.id}/suspend`, {}))).toBe(
      'forbidden',
    );
    expect(
      (await as(t, person).post(`/api/users/${target.principal.id}/reactivate`, {})).statusCode,
    ).toBe(403);

    await t.pool.query('update principals set is_instance_admin = true where id = $1', [
      person.principal.id,
    ]);
    await t.pool.query("update memberships set role = 'admin' where principal_id = $1", [
      person.principal.id,
    ]);
    const key = await issueKey(person);
    const byKey = await t.app.inject({
      method: 'POST',
      url: `/api/users/${target.principal.id}/suspend`,
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(byKey.statusCode).toBe(403);
  });

  it('an instance admin cannot suspend themselves', async () => {
    const res = await as(t, admin).post(`/api/users/${admin.principal.id}/suspend`, {});
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('cannot_suspend_self');
  });

  it('only people can be suspended; unknown ids and key principals are not found', async () => {
    const person = await member('Key Holder');
    const key = await issueKey(person);
    const keyPrincipal = await t.pool.query<{ principal_id: string }>(
      'select principal_id from api_keys where id = $1',
      [key.key.id],
    );
    const keyPrincipalId = keyPrincipal.rows[0]?.principal_id ?? '';
    expect((await as(t, admin).post(`/api/users/${keyPrincipalId}/suspend`, {})).statusCode).toBe(
      404,
    );
    const ghost = '0192f5e0-0000-7000-8000-00000000abcd';
    expect((await as(t, admin).post(`/api/users/${ghost}/suspend`, {})).statusCode).toBe(404);
  });

  it('lists every person with their status for instance admins', async () => {
    const person = await member('Listed');
    await as(t, admin).post(`/api/users/${person.principal.id}/suspend`, {});
    const users = ((await as(t, admin).get('/api/users')).json() as { users: UserAdminView[] })
      .users;
    expect(users.find((u) => u.id === person.principal.id)).toMatchObject({
      status: 'suspended',
      email: person.email,
      isInstanceAdmin: false,
    });
    expect(users.every((u) => !('authSubject' in u))).toBe(true);
  });
});

describe('revocation events (ADR 0031)', () => {
  it('are published when a key is revoked and when a member is removed', async () => {
    const person = await member('Evented');
    const key = await issueKey(person);
    const keyPrincipalId = (
      await t.pool.query<{ principal_id: string }>(
        'select principal_id from api_keys where id = $1',
        [key.key.id],
      )
    ).rows[0]?.principal_id;
    await as(t, person).delete(`/api/workspaces/${ws.id}/keys/${key.key.id}`);
    expect(await eventFor(keyPrincipalId ?? '', 'key_revoked')).toMatchObject({
      workspaceId: ws.id,
    });

    await as(t, admin).delete(`/api/workspaces/${ws.id}/members/${person.principal.id}`);
    expect(await eventFor(person.principal.id, 'membership_removed')).toMatchObject({
      workspaceId: ws.id,
    });
  });

  it('a failed publish does not undo or fail the suspension; the database decides', async () => {
    const person = await member('Unannounced');
    const logs: string[] = [];
    const { logger } = createLogger({
      level: 'warn',
      service: 'api-test',
      destination: { write: (line: string) => void logs.push(line) },
    });
    const unreachable = createCacheClient(
      { host: '127.0.0.1', port: 1, password: undefined },
      'dead',
    );
    const view = await suspendUser(
      { db: t.db, events: valkeyEvents(unreachable, logger) },
      { ...admin.principal, isInstanceAdmin: true },
      person.principal.id,
    );
    unreachable.close();
    expect(view.status).toBe('suspended');
    expect((await me({ cookie: person.cookie })).statusCode).toBe(401);
    expect(logs.join('')).toContain('events.publish_failed');
  });
});
