import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  accounts,
  expect,
  expectAccessible,
  mainMenu,
  pressUntil,
  sessions,
  signIn,
  test,
  watchErrors,
} from './fixtures.ts';

/*
 * Tools in the browser (TL-1, TL-3, TL-4, TL-5, AC 18, ADR 0069, ADR 0071), against the MCP server
 * and the fake provider the acceptance stack runs (docker/compose.e2e.yaml). An admin adds a
 * server, syncs and enables its tools; a member's chat asks before a destructive tool runs, and
 * runs it once, always, or not at all; the member takes a standing approval back.
 */

const FAKE_PROVIDER_URL = 'http://fake-provider:4010/openai/v1';
const FAKE_MCP_URL = 'http://fake-provider:4011/mcp';

const suffix = () => randomBytes(3).toString('hex');

async function post(page: Page, origin: string, url: string, data: unknown, method = 'POST') {
  const res = await page.request.fetch(url, { method, headers: { origin }, data });
  expect(res.status(), `${method} ${url}`).toBeLessThan(300);
  return res.json() as Promise<unknown>;
}

test.describe('tools (TL-1, TL-3 to TL-5, AC 18)', () => {
  test.use({ storageState: sessions.admin });

  test('an admin sets up a server and its tools; a member approves once, always, or denies', async ({
    page,
    browser,
    errors,
  }) => {
    void errors;
    test.setTimeout(90_000);
    const tag = suffix();
    await page.goto('/');
    const origin = new URL(page.url()).origin;

    // A workspace with a member and a model that calls tools, set up through the api.
    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `Tools ${tag}`,
      slug: `tools-${tag}`,
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
      model: `tool-delete~${tag}`,
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

    // NF-S4: the server's origin is on the instance's allowlist; listing it again changes
    // nothing, so a stack reused across runs is fine.
    await post(page, origin, '/api/admin/mcp-origins', { origin: new URL(FAKE_MCP_URL).origin });

    // TL-1: the admin adds the server and syncs its tools, from one dialog.
    await page.goto(`/workspaces/${workspace.id}`);
    await mainMenu(page).getByRole('link', { name: 'Tools', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tools', level: 1 })).toBeVisible();
    const display = `Files ${tag}`;
    const server = `files-${tag}`;
    const tool = `${server}__delete`;
    const dialog = page.getByRole('dialog', { name: 'Add a tool server' });
    await pressUntil(page.getByRole('button', { name: 'Add a tool server' }), dialog);
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(display);
    // The short name the model sees is made from the name.
    await expect(dialog.getByRole('textbox', { name: /^Short name/ })).toHaveValue(server);
    await dialog.getByRole('textbox', { name: 'Address' }).fill(FAKE_MCP_URL);
    // A shared credential waits for its warning to be agreed to.
    await dialog.getByText('A shared credential', { exact: true }).click();
    const add = dialog.getByRole('button', { name: 'Add and sync tools' });
    await expect(add).toHaveAttribute('aria-disabled', 'true');
    await expectAccessible(page);
    await dialog.getByText('Nothing', { exact: true }).click();
    await expect(add).not.toHaveAttribute('aria-disabled', 'true');
    await add.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(`Synced ${display}: 2 added, 0 changed, 0 removed.`)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Tool servers' })).toContainText(display);

    // TL-3, TL-4: tools start off the allowlist; the destructive one asks first (H2).
    const deleteAsks = page.getByRole('switch', { name: `Asks first: ${server}.delete` });
    const echoAsks = page.getByRole('switch', { name: `Asks first: ${server}.echo` });
    await expect(deleteAsks).toBeChecked();
    await expect(echoAsks).not.toBeChecked();
    // Asks first waits for the tool to be on.
    await expect(deleteAsks).toHaveAttribute('aria-disabled', 'true');
    for (const name of [`${server}.delete`, `${server}.echo`]) {
      const enable = page.getByRole('switch', { name: `Enabled: ${name}` });
      await expect(enable).not.toBeChecked();
      // The input is visually hidden under the switch drawn in its label, which people click.
      await enable.locator('xpath=ancestor::label[1]').click();
      await expect(enable).toBeChecked();
    }
    await expect(deleteAsks).not.toHaveAttribute('aria-disabled', 'true');
    await expectAccessible(page);

    // AC 18: the member's chat stops before the tool runs, and asks.
    // A sign-in of its own: other specs sign the saved member session out.
    const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const chat = await memberContext.newPage();
    const memberErrors: string[] = [];
    watchErrors(chat, memberErrors);
    await signIn(chat, accounts.member);
    const message = chat.getByRole('textbox', { name: 'Message', exact: true });
    const messages = chat.getByRole('list', { name: 'Messages' });
    // Chat names a tool as people read it: <server>.<tool>.
    const shown = `${server}.delete`;
    const approval = chat.getByRole('region', { name: `Allow ${shown} to run?` });
    const newChat = async (text: string) => {
      await chat.goto(`/workspaces/${workspace.id}/chat`);
      await expect(message).toBeEnabled();
      await message.fill(text);
      await message.press('Enter');
    };
    const result = `Tool said: <tool_result name="${tool}">\ndeleted\n</tool_result>`;

    await newChat('Delete record 42');
    await expect(approval).toBeVisible();
    // The arguments, as plain text lines.
    await expect(approval.getByText('id: 42')).toBeVisible();
    await expectAccessible(chat);
    // It survives a reload: the conversation is waiting, not the page.
    await chat.reload();
    await expect(approval).toBeVisible();
    // After the reload, a press before the page has hydrated does nothing (ADR 0044). Answered,
    // the approval goes, so press while it is there.
    await expect(async () => {
      if (await approval.isVisible()) {
        await approval.getByRole('button', { name: 'Allow once' }).click({ timeout: 2_000 });
      }
      await expect(approval).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(messages.getByText(result).first()).toBeVisible();
    await expect(approval).toBeHidden();
    // TL-6: the call is folded into the reply; opening it shows its arguments and result.
    const used = messages.getByRole('button', { name: new RegExp(`^Used ${shown}`) });
    await used.click();
    await expect(used).toHaveAttribute('aria-expanded', 'true');
    await expect(messages.getByText('deleted', { exact: true })).toBeVisible();

    // Deny: the tool never runs, and the model is told.
    await newChat('Delete record 42 again');
    await approval.getByRole('button', { name: 'Deny' }).click();
    await expect(messages.getByText(/^Tool said: .*declined/s).first()).toBeVisible();
    await expect(approval).toBeHidden();
    await expect(messages.getByText(`You denied ${shown}.`)).toBeVisible();

    // TL-5: always allow, and the next conversation runs it without asking.
    await newChat('Delete it, and do not ask next time');
    await approval.getByRole('button', { name: 'Always allow' }).click();
    await expect(messages.getByText(result).first()).toBeVisible();
    await newChat('Delete another');
    await expect(messages.getByText(result).first()).toBeVisible();
    await expect(approval).toBeHidden();

    // The admin sees the standing approval.
    await page.reload();
    const adminGrants = page.getByRole('grid', { name: 'Standing approvals' });
    await expect(adminGrants.getByRole('rowheader', { name: accounts.member.name })).toBeVisible();
    await expect(adminGrants).toContainText(`${server}.delete`);

    // TL-5: the member takes it back on their connections page, and chat asks again.
    await chat.goto(`/workspaces/${workspace.id}`);
    await mainMenu(chat).getByRole('link', { name: 'Your connections' }).click();
    await expect(chat.getByRole('heading', { name: 'Your connections', level: 1 })).toBeVisible();
    const usable = chat.getByRole('grid', { name: 'Tools you can use' });
    await expect(usable.getByRole('row').filter({ hasText: `${server}.delete` })).toContainText(
      'You always allow it',
    );
    await expect(chat.getByRole('list', { name: 'Accounts' })).toContainText(
      'Needs no account. Nothing to connect.',
    );
    await expectAccessible(chat);
    await chat
      .getByRole('button', { name: `Revoke the standing approval for ${server}.delete` })
      .click();
    await expect(chat.getByText('You have not told any tool to always run.')).toBeVisible();
    await newChat('Delete one more');
    await expect(approval).toBeVisible();

    expect(memberErrors, 'member console and page errors').toEqual([]);
    await memberContext.close();
  });
});
