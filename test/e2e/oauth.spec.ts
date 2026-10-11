import { randomBytes } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import {
  accounts,
  expect,
  expectAccessible,
  pressUntil,
  sessions,
  signIn,
  test,
  watchErrors,
} from './fixtures.ts';
import { E2E_KEYCLOAK_URL } from '../integration/keycloak.ts';

/*
 * Per-user credentials in the browser, against a real authorization server (TL-2, M6 exit,
 * ADR 0074): the stack's Keycloak, and an MCP server that accepts only its tokens and says whose
 * they are. Two people connect their own accounts on their connections page, through Keycloak's
 * own sign-in and consent pages, and the same tool, called from chat, names each of them.
 */

const FAKE_PROVIDER_URL = 'http://fake-provider:4010/openai/v1';
const PROTECTED_MCP_URL = 'http://fake-provider:4012/mcp';

const suffix = () => randomBytes(3).toString('hex');

async function post(page: Page, origin: string, url: string, data: unknown, method = 'POST') {
  const res = await page.request.fetch(url, { method, headers: { origin }, data });
  expect(res.status(), `${method} ${url}`).toBeLessThan(300);
  return res.json() as Promise<unknown>;
}

/** Connects the signed-in person's account at Keycloak, from their connections page. */
async function connect(
  page: Page,
  workspaceId: string,
  server: string,
  person: { username: string; password: string },
) {
  await page.goto(`/workspaces/${workspaceId}/connections`);
  // A server with no display name of its own is named from its short name (ADR 0096).
  const name = server.slice(0, 1).toUpperCase() + server.slice(1).replaceAll('-', ' ');
  const row = page
    .getByRole('list', { name: 'Accounts' })
    .getByRole('listitem')
    .filter({ hasText: name });
  await expect(row).toContainText('Not connected');
  await page.getByRole('button', { name: `Connect your ${name} account` }).click();
  // Keycloak's own pages, not ours.
  await page.getByLabel('Username or email').fill(person.username);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText('Your account is connected.')).toBeVisible();
  await expect(row).toContainText('Connected.');
}

/** Asks chat who the server thinks the person is, and waits for the answer. */
async function whoami(page: Page, workspaceId: string, expected: string) {
  await page.goto(`/workspaces/${workspaceId}/chat`);
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeEnabled();
  await message.fill('Who am I to the server?');
  await message.press('Enter');
  const messages = page.getByRole('list', { name: 'Messages' });
  await expect(
    messages.getByText(new RegExp(`^Tool said: .*\\b${expected}\\b`, 's')).first(),
  ).toBeVisible();
}

async function memberPage(browser: Browser, errors: string[]) {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  watchErrors(page, errors);
  await signIn(page, accounts.member);
  return { context, page };
}

test.describe('per-user credentials (TL-2)', () => {
  // The stack's Keycloak has a certificate of its own, made for the run.
  test.use({ storageState: sessions.admin, ignoreHTTPSErrors: true });

  test('two people connect their own accounts through Keycloak, and the server sees each', async ({
    page,
    browser,
    errors,
  }) => {
    void errors;
    test.setTimeout(90_000);
    const tag = suffix();
    await page.goto('/');
    const origin = new URL(page.url()).origin;

    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `OAuth ${tag}`,
      slug: `oauth-${tag}`,
    })) as { workspace: { id: string } };
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/members/${accounts.member.id}`,
      { role: 'member' },
      'PUT',
    );
    const provider = `fake-${tag}`;
    await post(page, origin, '/api/providers', {
      kind: 'openai-compatible',
      name: provider,
      baseUrl: FAKE_PROVIDER_URL,
    });
    const { model } = (await post(page, origin, '/api/models/custom', {
      provider,
      model: `tool-whoami~${tag}`,
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      capabilities: {
        vision: false,
        pdf: false,
        tools: true,
        structuredOutput: false,
        promptCaching: false,
        reasoning: false,
      },
      prices: {
        inputMicroUsdPerMtok: 1_000_000,
        outputMicroUsdPerMtok: 5_000_000,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
    })) as { model: { id: string } };
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/routing/settings`,
      { routingEnabled: false, defaultModel: model.id, pinnedModel: null },
      'PUT',
    );
    // The server and the authorization server it names must both be listed (NF-S4, ADR 0117).
    // Listing an origin twice changes nothing, so a stack reused across runs is fine.
    for (const allowed of [new URL(PROTECTED_MCP_URL).origin, E2E_KEYCLOAK_URL]) {
      await post(page, origin, '/api/admin/mcp-origins', { origin: allowed });
    }
    const server = `people-${tag}`;
    const { server: added } = (await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/mcp-servers`,
      { transport: 'streamable_http', name: server, url: PROTECTED_MCP_URL, authMode: 'oauth' },
    )) as { server: { id: string } };

    // Before connecting, a sync says what is missing rather than blaming the server.
    await page.goto(`/workspaces/${workspace.id}/tools`);
    const display = server.slice(0, 1).toUpperCase() + server.slice(1).replaceAll('-', ' ');
    await pressUntil(
      page.getByRole('button', { name: `Sync tools from ${display}` }),
      page.getByText(/^The tools were not synced\. Connect your own account/),
    );
    await expect(
      page.getByText(/Last sync failed, .*Connect your own account in Your connections first\./),
    ).toBeVisible();

    // The admin connects first: syncing reads the tools with their own connection.
    await connect(page, workspace.id, server, accounts.keycloak.admin);
    await expectAccessible(page);
    const synced = (await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/mcp-servers/${added.id}/tools/sync`,
      {},
    )) as { tools: { id: string; name: string }[] };
    const whoamiTool = synced.tools.find((tool) => tool.name === 'whoami');
    expect(whoamiTool).toBeDefined();
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/tools/${whoamiTool?.id ?? ''}`,
      { enabled: true },
      'PATCH',
    );
    await whoami(page, workspace.id, accounts.keycloak.admin.username);

    // A second person, with their own account at the same server.
    const memberErrors: string[] = [];
    const member = await memberPage(browser, memberErrors);
    await connect(member.page, workspace.id, server, accounts.keycloak.member);
    await whoami(member.page, workspace.id, accounts.keycloak.member.username);

    expect(memberErrors, 'member console and page errors').toEqual([]);
    await member.context.close();
  });
});
