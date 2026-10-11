import { request } from '@playwright/test';
import type { APIRequestContext, APIResponse, Browser, Page } from '@playwright/test';
import {
  accounts,
  createWorkspace,
  expect,
  expectAccessible,
  expectWorkspaceSettings,
  pressUntil,
  test,
  watchErrors,
} from './fixtures.ts';

/*
 * The M1 exit journey (docs/roadmap.md, M1): an admin who has just finished first-run setup
 * invites a member, keys are issued, and the admin revokes both the member's key and the member.
 * Along the way, the member's session and key are pointed at a workspace they do not belong
 * to by calling the api directly, not through the UI (AC 16). It runs on the real stack, so CI
 * checks it on amd64 and arm64.
 */

// The fields this journey reads from api responses.
interface Principal {
  id: string;
  kind: 'user' | 'key';
  actingUserId: string;
  workspaceScope: string | null;
}
interface WorkspaceView {
  id: string;
}

const EMPTY_SESSION = { cookies: [], origins: [] };
const bearer = (secret: string) => ({ headers: { authorization: `Bearer ${secret}` } });

async function issueKey(page: Page, name: string): Promise<string> {
  await page.getByLabel('New key name').fill(name);
  await page.getByRole('button', { name: 'Create key' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Copy the new API key' });
  const secret = await dialog.getByLabel('API key').inputValue();
  expect(secret).toMatch(/^lk_[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole('button', { name: 'I have saved it' }).click();
  await expect(dialog).toBeHidden();
  return secret;
}

async function openWorkspace(page: Page, name: string): Promise<string> {
  await page.goto('/workspaces');
  await page.getByRole('link', { name, exact: true }).click();
  await expectWorkspaceSettings(page, name);
  const id = /\/workspaces\/([0-9a-f-]{36})$/.exec(page.url())?.[1];
  if (id === undefined) throw new Error(`no workspace id in ${page.url()}`);
  return id;
}

/** Every way to reach into a workspace, each of which must answer 404 to an outsider. */
function intrusions(workspaceId: string, keyId: string, memberId: string) {
  const base = `/api/workspaces/${workspaceId}`;
  return [
    ['read the workspace', 'GET', base, undefined],
    ['rename it', 'PATCH', base, { name: 'Taken over' }],
    ['list its members', 'GET', `${base}/members`, undefined],
    ['add themselves as admin', 'PUT', `${base}/members/${memberId}`, { role: 'admin' }],
    ['list its keys', 'GET', `${base}/keys`, undefined],
    ['revoke its key', 'DELETE', `${base}/keys/${keyId}`, undefined],
    ['list its invites', 'GET', `${base}/invites`, undefined],
    ['invite themselves', 'POST', `${base}/invites`, { role: 'admin' }],
  ] as const;
}

async function send(
  api: APIRequestContext,
  method: string,
  url: string,
  data: unknown,
  headers: Record<string, string>,
): Promise<APIResponse> {
  return api.fetch(url, { method, headers, ...(data === undefined ? {} : { data }) });
}

export async function m1ExitJourney(
  browser: Browser,
  errors: string[],
  adminSession: string,
): Promise<void> {
  const baseURL = test.info().project.use.baseURL ?? 'http://127.0.0.1:8080';
  const admin = await browser.newContext({ storageState: adminSession });
  const adminPage = await admin.newPage();
  watchErrors(adminPage, errors);
  const keys = await request.newContext({ baseURL, storageState: EMPTY_SESSION });

  // A second workspace, which the member will never join.
  const globexName = `Globex ${accounts.tag}`;
  await createWorkspace(adminPage, globexName);
  const globexId = await openWorkspace(adminPage, globexName);

  // ID-5: the admin issues a key.
  const adminSecret = await issueKey(adminPage, 'Globex deploy');
  const adminKeys = (await (
    await admin.request.get(`/api/workspaces/${globexId}/keys`)
  ).json()) as {
    keys: { id: string }[];
  };
  const adminKeyId = adminKeys.keys[0]?.id ?? '';
  expect((await keys.get(`/api/workspaces/${globexId}`, bearer(adminSecret))).status()).toBe(200);

  // ID-7: the admin invites a member to Acme, the workspace setup created.
  const acmeId = await openWorkspace(adminPage, 'Acme');
  const dialog = adminPage.getByRole('alertdialog', { name: 'Copy the invite link' });
  await pressUntil(adminPage.getByRole('button', { name: 'Create invite link' }), dialog);
  const link = await dialog.getByLabel('Invite link').inputValue();
  await dialog.getByRole('button', { name: 'I have saved it' }).click();

  const member = await browser.newContext({ storageState: EMPTY_SESSION });
  const memberPage = await member.newPage();
  watchErrors(memberPage, errors);
  const email = `m1-member-${accounts.tag}@example.com`;
  await memberPage.goto(link);
  await memberPage.getByLabel('Name', { exact: true }).fill('M1 Member');
  await memberPage.getByLabel('Email').fill(email);
  await memberPage.getByLabel('Password').fill(`m1 member password ${accounts.tag}`);
  await memberPage.getByRole('button', { name: 'Create account and join' }).click();
  await expectWorkspaceSettings(memberPage, 'Acme');
  await expectAccessible(memberPage);
  const me = (await (await member.request.get('/api/me')).json()) as { principal: Principal };
  const memberId = me.principal.id;

  // ID-5: the member issues keys. Each acts as the member, only in Acme.
  const scriptSecret = await issueKey(memberPage, 'Member script');
  const backupSecret = await issueKey(memberPage, 'Member backup');
  const asKey = (await (await keys.get('/api/me', bearer(scriptSecret))).json()) as {
    principal: Principal;
  };
  expect(asKey.principal).toMatchObject({
    kind: 'key',
    actingUserId: memberId,
    workspaceScope: acmeId,
  });

  // AC 16: the member's session and key cannot reach Globex, whatever they try.
  const credentials = [
    ['session', member.request, { origin: baseURL }],
    ['key', keys, bearer(scriptSecret).headers],
  ] as const;
  for (const [label, api, headers] of credentials) {
    for (const [what, method, url, data] of intrusions(globexId, adminKeyId, memberId)) {
      const res = await send(api, method, url, data, headers);
      expect(res.status(), `${label}: ${what}`).toBe(404);
    }
    const visible = (await (
      await send(api, 'GET', '/api/workspaces', undefined, headers)
    ).json()) as {
      workspaces: WorkspaceView[];
    };
    expect(
      visible.workspaces.map((w) => w.id),
      `${label}: workspaces listed`,
    ).toEqual([acmeId]);
  }
  expect((await keys.get(`/api/workspaces/${globexId}`, bearer(adminSecret))).status()).toBe(200);

  // ID-6, AC 6: the admin revokes the member's key; it stops working within 5 seconds.
  await adminPage.reload();
  const scriptRow = adminPage.getByRole('row', { name: /Member script/ });
  // A plain confirm first; a revoked key leaves the list.
  const confirmRevoke = adminPage.getByRole('alertdialog', {
    name: 'Revoke the key Member script?',
  });
  await pressUntil(
    scriptRow.getByRole('button', { name: 'Revoke key Member script' }),
    confirmRevoke,
  );
  await confirmRevoke.getByRole('button', { name: 'Revoke' }).click();
  await expect(scriptRow).toHaveCount(0);
  await expect
    .poll(async () => (await keys.get('/api/me', bearer(scriptSecret))).status(), {
      timeout: 5000,
    })
    .toBe(401);
  expect((await keys.get('/api/me', bearer(backupSecret))).status()).toBe(200);

  // ID-6, AC 6: the admin suspends the member; their session and remaining key end within
  // 5 seconds.
  await adminPage.getByRole('link', { name: 'People and sign-in' }).click();
  const memberRow = adminPage.getByRole('row').filter({ hasText: email });
  await memberRow.getByRole('button', { name: 'Suspend' }).click();
  await expect(memberRow).toContainText('Suspended');
  await expect
    .poll(async () => (await member.request.get('/api/me')).status(), { timeout: 5000 })
    .toBe(401);
  await expect
    .poll(async () => (await keys.get('/api/me', bearer(backupSecret))).status(), {
      timeout: 5000,
    })
    .toBe(401);
  await memberPage.goto('/');
  await expect(memberPage).toHaveURL(/\/sign-in$/);

  await keys.dispose();
  await member.close();
  await admin.close();
}
