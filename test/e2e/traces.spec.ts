import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  accounts,
  expect,
  expectAccessible,
  mainMenu,
  sessions,
  signIn,
  test,
  watchErrors,
} from './fixtures.ts';

/*
 * Traces in the browser (OB-1, ADR 0075 H1, ADR 0079, ADR 0095): a member follows a chat reply to
 * its trace and sees each step, the model call and its cost, then their own requests; the
 * workspace admin finds the request in the workspace's list and filters it; the spend page shows
 * how requests behaved and the alerts sent.
 */

const FAKE_PROVIDER_URL = 'http://fake-provider:4010/openai/v1';
const suffix = () => randomBytes(3).toString('hex');

async function post(page: Page, origin: string, url: string, data: unknown, method = 'POST') {
  const res = await page.request.fetch(url, { method, headers: { origin }, data });
  expect(res.status(), `${method} ${url}`).toBeLessThan(300);
  return res.json() as Promise<unknown>;
}

test.describe('traces (OB-1)', () => {
  test.use({ storageState: sessions.admin });

  test('a member opens the trace of a reply, and the admin finds it in the list', async ({
    page,
    browser,
    errors,
  }) => {
    void errors;
    test.setTimeout(60_000);
    const tag = suffix();
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `Traces ${tag}`,
      slug: `traces-${tag}`,
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
      model: `ok~${tag}`,
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      capabilities: {
        vision: false,
        pdf: false,
        tools: false,
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
    })) as { model: { id: string; model: string } };
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/routing/settings`,
      { routingEnabled: false, defaultModel: model.id, pinnedModel: null },
      'PUT',
    );

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const chat = await context.newPage();
    const memberErrors: string[] = [];
    watchErrors(chat, memberErrors);
    await signIn(chat, accounts.member);
    await chat.goto(`/workspaces/${workspace.id}/chat`);
    const message = chat.getByRole('textbox', { name: 'Message', exact: true });
    await expect(message).toBeEnabled();
    await message.fill('Hello, trace me');
    await message.press('Enter');
    const messages = chat.getByRole('list', { name: 'Messages' });
    await expect(messages.getByText('Hello there')).toBeVisible();

    // Straight from the reply, before its spans may be written: the page waits for them.
    await messages.getByRole('link', { name: 'View trace' }).click();
    await expect(chat.getByRole('heading', { name: 'Request trace', level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    // OB-1: the steps, each named with its step, outcome and time. A step with details is a
    // disclosure; one with nothing to show is a plain heading, with nothing to press.
    const steps = chat.getByRole('region', { name: 'Steps' });
    await expect(steps.getByRole('heading', { name: /^Checking access, Allowed, / })).toBeVisible();
    await expect(steps.getByRole('button', { name: /^Checking access, / })).toHaveCount(0);
    await expect(steps.getByRole('button', { name: /^Choosing the model, / })).toBeVisible();
    await expect(
      steps.getByRole('button', { name: /^Calling the model, Reply finished, / }),
    ).toBeVisible();
    await expect(steps.getByText('Attempt 1')).toBeVisible();
    // OB-4: nothing was recorded here, so nothing is shown.
    await expect(chat.getByText('Recorded prompt and reply')).toHaveCount(0);
    const summary = chat.getByRole('complementary', { name: 'Summary' });
    await expect(summary).toContainText('Answered by');
    await expectAccessible(chat);

    await chat
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Requests' })
      .click();
    await expect(chat.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible();
    await expect(chat.getByText('1 request matches.')).toBeVisible();
    await expect(
      chat.getByRole('grid', { name: 'Requests, newest first, page 1' }).getByRole('row'),
    ).toHaveCount(2);
    // AC 16: a member reads their own, with no Person filter.
    await expect(chat.getByRole('search').getByText('Person', { exact: true })).toHaveCount(0);
    expect(memberErrors, 'member console and page errors').toEqual([]);
    await context.close();

    // The admin sees the member's request among the workspace's, and filters by outcome.
    await page.goto(`/workspaces/${workspace.id}`);
    await mainMenu(page).getByRole('link', { name: 'Requests', exact: true }).click();
    const list = page.getByRole('grid', { name: 'Requests, newest first, page 1' });
    await expect(list.getByText(accounts.member.name)).toBeVisible();
    await expect(
      list.getByRole('link', {
        name: new RegExp(`^View trace for request by ${accounts.member.name} at `),
      }),
    ).toBeVisible();
    await expectAccessible(page);
    await page
      .getByRole('search')
      .getByRole('button', { name: /Outcome$/ })
      .click();
    await page.getByRole('option', { name: 'Refused', exact: true }).click();
    await expect(page.getByText('No requests match.')).toBeVisible();
    await expect(page).toHaveURL(/outcome=refused/);

    // The spend report shows how requests behaved, and Budgets and alerts the alerts sent.
    await page.goto(`/workspaces/${workspace.id}/spend`);
    await expect(page.getByRole('heading', { name: 'Speed and size by model' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Where the money went' })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('tab', { name: 'Budgets and alerts' }).click();
    await expect(page.getByRole('heading', { name: 'Alerts sent' })).toBeVisible();
    await expectAccessible(page);
  });
});
