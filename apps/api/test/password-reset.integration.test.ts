import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type {
  CreatedInvite,
  CreatedPasswordReset,
  InvitePreview,
  PasswordResetPreview,
  WorkspaceView,
} from '@lakka/contracts';
import { anonymous, as, createTestApp, PUBLIC_URL, signIn, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Password reset links (ID-2, ID-6, ADR 0098) and what an invite link tells its holder before
 * they accept (ID-7, ADR 0098).
 */

let t: TestApp;
let admin: SignedInUser;

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const newPassword = () => `a brand new password ${randomBytes(3).toString('hex')}`;

async function makeReset(person: SignedInUser, by: SignedInUser = admin) {
  const res = await as(t, by).post(`/api/users/${person.principal.id}/password-reset`, {});
  return { res, created: res.json() as CreatedPasswordReset };
}

beforeAll(async () => {
  t = await createTestApp();
  admin = await signedInUser(t, 'Admin');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
});

afterAll(async () => {
  await t.close();
});

describe('password reset links (ID-2, ADR 0098)', () => {
  it('ID-2: an instance admin makes a link; it names the person, sets a new password once, and signs them out', async () => {
    const person = await signedInUser(t, 'Forgetful');
    const { res, created } = await makeReset(person);
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const preview = await anonymous(t).post('/api/password-reset/preview', {
      token: created.token,
    });
    expect(preview.json() as PasswordResetPreview).toMatchObject({
      displayName: 'Forgetful',
      email: person.email,
    });

    const password = newPassword();
    const used = await anonymous(t).post('/api/password-reset', { token: created.token, password });
    expect(used.statusCode).toBe(204);
    // Signed out everywhere, the old password is gone, and the new one works.
    expect(
      (await t.app.inject({ url: '/api/me', headers: { cookie: person.cookie } })).statusCode,
    ).toBe(401);
    expect(await signIn(t, person.email, person.password)).toBeUndefined();
    expect(await signIn(t, person.email, password)).toBeDefined();

    const again = await anonymous(t).post('/api/password-reset', {
      token: created.token,
      password: newPassword(),
    });
    expect(again.statusCode).toBe(404);
    expect(code(again)).toBe('reset_invalid');
  });

  it('ID-2: a new link replaces the old one, and an expired link does not work', async () => {
    const person = await signedInUser(t, 'Twice');
    const first = (await makeReset(person)).created;
    const second = (await makeReset(person)).created;
    const old = await anonymous(t).post('/api/password-reset/preview', { token: first.token });
    expect(code(old)).toBe('reset_invalid');
    await t.pool.query(
      "update password_resets set expires_at = now() - interval '1 minute' where principal_id = $1",
      [person.principal.id],
    );
    const expired = await anonymous(t).post('/api/password-reset', {
      token: second.token,
      password: newPassword(),
    });
    expect(code(expired)).toBe('reset_invalid');
  });

  it('invariant 2: a link stops working once its maker is no longer an instance admin', async () => {
    const other = await signedInUser(t, 'Other admin');
    await t.pool.query('update principals set is_instance_admin = true where id = $1', [
      other.principal.id,
    ]);
    const person = await signedInUser(t, 'Delegated');
    const { created } = await makeReset(person, other);
    await t.pool.query('update principals set is_instance_admin = false where id = $1', [
      other.principal.id,
    ]);
    const res = await anonymous(t).post('/api/password-reset', {
      token: created.token,
      password: newPassword(),
    });
    expect(code(res)).toBe('reset_invalid');
  });

  it('ID-2: someone who signs in only through a provider gets a password', async () => {
    const person = await signedInUser(t, 'Provider only');
    await t.pool.query(
      "update auth_accounts set provider_id = 'dex', account_id = 'dex-subject', password = null where user_id = (select auth_subject from principals where id = $1)",
      [person.principal.id],
    );
    const { created } = await makeReset(person);
    const password = newPassword();
    expect(
      (await anonymous(t).post('/api/password-reset', { token: created.token, password }))
        .statusCode,
    ).toBe(204);
    expect(await signIn(t, person.email, password)).toBeDefined();
  });

  it('ID-6: only instance admins make links, and a short password or a bad token is refused', async () => {
    const person = await signedInUser(t, 'Plain');
    const target = await signedInUser(t, 'Target');
    expect((await makeReset(target, person)).res.statusCode).toBe(403);
    const { created } = await makeReset(target);
    const short = await anonymous(t).post('/api/password-reset', {
      token: created.token,
      password: 'short',
    });
    expect(short.statusCode).toBe(400);
    const bad = await anonymous(t).post('/api/password-reset/preview', { token: 'x'.repeat(43) });
    expect(code(bad)).toBe('reset_invalid');
    expect(
      (
        await as(t, admin).post(
          '/api/users/01920000-0000-7000-8000-000000000000/password-reset',
          {},
        )
      ).statusCode,
    ).toBe(404);
  });

  it('NF-P4: deleting a person removes their link', async () => {
    const person = await signedInUser(t, 'Leaving');
    const { created } = await makeReset(person);
    await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${person.principal.id}`,
      headers: { cookie: admin.cookie, origin: PUBLIC_URL },
      payload: { confirmEmail: person.email },
    });
    const rows = await t.pool.query('select 1 from password_resets where principal_id = $1', [
      person.principal.id,
    ]);
    expect(rows.rowCount).toBe(0);
    expect(
      code(await anonymous(t).post('/api/password-reset/preview', { token: created.token })),
    ).toBe('reset_invalid');
  });

  it('NF-S5: neither the token nor the new password reaches the logs', async () => {
    const person = await signedInUser(t, 'Logged');
    const { created } = await makeReset(person);
    const password = newPassword();
    await anonymous(t).post('/api/password-reset', { token: created.token, password });
    const logs = t.logs.join('');
    expect(logs).not.toContain(created.token);
    expect(logs).not.toContain(password);
  });
});

describe('invite previews (ID-7, ADR 0098)', () => {
  it('ID-7: say who made the link, and tell a signed-in member they are in already', async () => {
    const ws = (
      (
        await as(t, admin).post('/api/workspaces', {
          name: 'Product',
          slug: `product-${randomBytes(3).toString('hex')}`,
        })
      ).json() as { workspace: WorkspaceView }
    ).workspace;
    const invite = (
      await as(t, admin).post(`/api/workspaces/${ws.id}/invites`, { role: 'member' })
    ).json() as CreatedInvite;

    const stranger = (
      await anonymous(t).post('/api/invites/preview', { token: invite.token })
    ).json() as InvitePreview;
    expect(stranger).toMatchObject({ invitedBy: 'Admin', alreadyMember: null, role: 'member' });

    const member = await signedInUser(t, 'Member');
    expect(
      (
        (
          await as(t, member).post('/api/invites/preview', { token: invite.token })
        ).json() as InvitePreview
      ).alreadyMember,
    ).toBeNull();
    await as(t, admin).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
      role: 'member',
    });
    const joined = (
      await as(t, member).post('/api/invites/preview', { token: invite.token })
    ).json() as InvitePreview;
    expect(joined.alreadyMember).toMatchObject({ workspaceId: ws.id, role: 'member' });
    expect(Date.now() - Date.parse(joined.alreadyMember?.joinedAt ?? '')).toBeLessThan(60_000);
  });
});
