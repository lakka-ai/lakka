import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  accounts,
  createWorkspace,
  expect,
  expectAccessible,
  mainMenu,
  sessions,
  signIn,
  test,
  watchErrors,
} from './fixtures.ts';

/*
 * Routing in the browser (RT-1, RT-2, RT-5, RT-10, RT-11, RT-12, NF-A1, ADR 0094): a workspace
 * admin sets the default model, adds a route with examples that the bundled classifier learns and
 * a fallback, tries phrases, turns routing off and back on, and edits and deletes the route; then
 * a route with only a description, which gains examples and keeps its description among them
 * (ADR 0122, ADR 0125); a member is told who manages it. No request reaches a model.
 */

const suffix = () => randomBytes(3).toString('hex');

const SUMMARIES = [
  'Summarize this report in three bullet points',
  'Give me a short summary of this article',
  'Can you recap the main points of this meeting transcript',
  'TL;DR this email thread please',
  'Condense this document into one paragraph',
  'What are the key takeaways from this text',
  'Write a brief summary of the attached minutes',
  'Shorten this long description to two sentences',
  'Sum up the findings of this study',
  'Boil this proposal down to its essentials',
  'Summarize the discussion in this chat log',
  'Give me the gist of this press release',
];

/** Registers a priced model for a provider through the api, as the models page would. */
async function customModel(
  page: Page,
  origin: string,
  provider: string,
  name: string,
  input: number,
  displayName: string,
) {
  const res = await page.request.post('/api/models/custom', {
    headers: { origin },
    data: {
      provider,
      model: name,
      displayName,
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
        inputMicroUsdPerMtok: input,
        outputMicroUsdPerMtok: input * 5,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { model: { id: string } }).model.id;
}

/**
 * A model picker's trigger, named by its current value, then its label, then an asterisk if it is
 * required. It is the button keyboards and screen readers reach, but HeroUI gives it no size of
 * its own: a pointer clicks the field around it, its parent.
 */
const picker = (scope: Locator, label: string) =>
  scope.getByRole('button', { name: new RegExp(` ${label}\\*?$`) });

/**
 * Picks a model as a person does: clicks the field, finds the model by name, then clicks it. The
 * list builds only the rows in view, so a model further down is not there until it is found.
 */
async function choose(page: Page, scope: Locator, label: string, option: string) {
  await picker(scope, label).locator('..').click();
  await page.getByRole('searchbox', { name: 'Find a model' }).fill(option);
  // An option is named by its model's name, then its id.
  const name = option.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('option', { name: new RegExp(`^${name} `) }).click();
}

test.describe('routing (RT-1, RT-2, RT-10, RT-11)', () => {
  test.use({ storageState: sessions.admin });

  test('a workspace admin sets up routing, tries phrases, turns it off, and edits and deletes a route', async ({
    page,
    browser,
    errors,
  }) => {
    void errors;
    test.slow();
    const tag = suffix();
    await page.goto('/workspaces');
    const origin = new URL(page.url()).origin;
    const provider = `route-${tag}`;
    const created = await page.request.post('/api/providers', {
      headers: { origin },
      data: { kind: 'openai-compatible', name: provider, baseUrl: 'http://api:3000/v1' },
    });
    expect(created.status()).toBe(201);
    // Names of their own, so models left by other runs on this stack never share them.
    const standard = `Standard ${tag}`;
    const small = `Small ${tag}`;
    await customModel(page, origin, provider, 'standard', 3_000_000, standard);
    await customModel(page, origin, provider, 'small', 150_000, small);

    const workspace = `Routing ${tag}`;
    await createWorkspace(page, workspace);
    const workspaceUrl = page.url();
    await mainMenu(page).getByRole('link', { name: 'Routing', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Routing', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No routes yet' })).toBeVisible();
    await expect(
      page.getByText('Nobody chose another model over a route in the last 30 days.'),
    ).toBeVisible();
    await expectAccessible(page);

    // RT-6: the default model, named as people see it.
    await choose(page, page.locator('main'), 'Default model', standard);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();

    // RT-1, RT-2: a route with examples, learned by the bundled classifier when saved.
    await page.getByRole('button', { name: 'Add a route' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a route' });
    await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
    await dialog.getByLabel('Name', { exact: true }).fill('summaries');
    await expect(dialog.getByText('Replies show it as Summaries')).toBeVisible();
    await choose(page, dialog, 'Model', small);
    await expect(dialog.getByText('Cheaper than the default model.')).toBeVisible();
    // The cheaper direction's threshold is the one that applies (RT-5).
    await expect(dialog.getByText(/so this one is higher\. This one applies now\./)).toBeVisible();
    await dialog.getByLabel('Example phrasings, one per line').fill(SUMMARIES.join('\n'));
    await expect(dialog.getByText('12 lines.')).toBeVisible();
    // NF-A1: the picker by keyboard. Typing narrows the list and highlights the first match, Enter
    // picks it, and focus returns to the picker.
    const fallback = picker(dialog, 'Fallback to add');
    await fallback.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('searchbox', { name: 'Find a model' })).toBeFocused();
    await page.keyboard.type(standard);
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(fallback).toHaveAccessibleName(new RegExp(`^${standard} Fallback to add`));
    await expect(fallback).toBeFocused();
    await dialog.getByRole('button', { name: 'Add a fallback' }).click();
    await expect(dialog.getByRole('listitem').filter({ hasText: standard })).toBeVisible();
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Save route' }).click();
    await expect(dialog).toHaveCount(0);
    const row = page
      .getByRole('region', { name: 'Routes', exact: true })
      .getByRole('row')
      .filter({ hasText: 'Summaries' });
    await expect(row).toContainText(small);
    await expect(row).toContainText('Cheaper than default');
    await expect(row).toContainText('On');

    // RT-3, RT-5: the tester shows what a new conversation would get, and why.
    const phrase = page.getByRole('textbox', { name: 'Message' });
    const result = page.getByRole('region', { name: 'Try a phrase' }).getByRole('status');
    await phrase.fill('Please summarize this quarterly report as a few short bullet points');
    await page.getByRole('button', { name: 'Try', exact: true }).click();
    await expect(result).toContainText(`Summaries route, ${small}`);
    await expect(result).toContainText('Matched examples');
    await expect(result).toContainText(/above the 0\.\d\d this route needs/);
    await expect(result).toContainText('Closest to the examples');
    await phrase.fill('What is the capital city of Peru?');
    await page.getByRole('button', { name: 'Try', exact: true }).click();
    await expect(result).toContainText(`Default model, ${standard}`);
    await expect(result).toContainText('No route was sure enough');
    await expect(result).toContainText(/Summaries, 0\.\d\d\. It needs 0\.\d\d\./);
    await expectAccessible(page);

    // RT-11: with routing off, the routes are kept but hidden until asked for.
    await page.getByText('Choose models automatically', { exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByText('1 route is saved and not used while routing is off.'),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Routes', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show routes' }).click();
    await expect(row).toBeVisible();
    await page.getByText('Choose models automatically', { exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Try a phrase' })).toBeVisible();

    // Editing keeps the examples and the fallback; a route switched off is shown as off.
    await page.getByRole('button', { name: 'Edit route Summaries' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit route' });
    await expect(edit.getByLabel('Example phrasings, one per line')).toHaveValue(
      SUMMARIES.join('\n'),
    );
    await expect(edit.getByRole('listitem').filter({ hasText: standard })).toBeVisible();
    await edit.getByText('Use this route', { exact: true }).click();
    await edit.getByRole('button', { name: 'Save route' }).click();
    await expect(edit).toHaveCount(0);
    await expect(row).toContainText('Off');

    // A member reads who manages routing, and no settings.
    const joined = await page.request.put(
      `/api/workspaces/${workspaceUrl.split('/').at(-1) ?? ''}/members/${accounts.member.id}`,
      { headers: { origin }, data: { role: 'member' } },
    );
    expect(joined.status()).toBe(200);
    const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const memberPage = await memberContext.newPage();
    const memberErrors: string[] = [];
    watchErrors(memberPage, memberErrors);
    await signIn(memberPage, accounts.member);
    await memberPage.goto(`${workspaceUrl}/routing`);
    await expect(
      memberPage.getByRole('heading', { name: 'Routing is managed by workspace admins' }),
    ).toBeVisible();
    await expect(memberPage.getByRole('link', { name: 'Back to chat' })).toBeVisible();
    await expect(memberPage.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await expectAccessible(memberPage);
    expect(memberErrors).toEqual([]);
    await memberContext.close();

    // Deleting asks first.
    await page.getByRole('button', { name: 'Edit route Summaries' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete route' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete the route Summaries?' });
    await expectAccessible(page);
    await confirm.getByRole('button', { name: 'Delete route' }).click();
    await expect(page.getByRole('heading', { name: 'No routes yet' })).toBeVisible();

    // RT-12: a route with a description and no examples is chosen by its description.
    await page.getByRole('button', { name: 'Add a route' }).click();
    const legal = page.getByRole('dialog', { name: 'Add a route' });
    await legal.getByLabel('Name', { exact: true }).fill('legal');
    await choose(page, legal, 'Model', standard);
    await legal
      .getByLabel('Description', { exact: true })
      .fill('Contracts, NDAs, privacy law and other legal questions.');
    await expect(
      legal.getByText('Routing uses it from the start, and with the examples once there are some.'),
    ).toBeVisible();
    await expectAccessible(page);
    await legal.getByRole('button', { name: 'Save route' }).click();
    await expect(legal).toHaveCount(0);
    await phrase.fill('Review the indemnification clause in this vendor contract');
    await page.getByRole('button', { name: 'Try', exact: true }).click();
    await expect(result).toContainText(`Legal route, ${standard}`);
    await expect(result).toContainText('Matched the description');
    await expect(result).toContainText('Closest to its description. It has no examples yet.');
    await phrase.fill('What is the capital city of Peru?');
    await page.getByRole('button', { name: 'Try', exact: true }).click();
    await expect(result).toContainText('No route was sure enough');
    await expect(result).toContainText('Closest to its description. It has no examples yet.');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Edit route Legal' }).click();
    const legalEdit = page.getByRole('dialog', { name: 'Edit route' });
    await expect(legalEdit.getByLabel('Description', { exact: true })).toHaveValue(
      'Contracts, NDAs, privacy law and other legal questions.',
    );
    // RT-12, ADR 0125: with examples, the description still counts, as one of them.
    await legalEdit
      .getByLabel('Example phrasings, one per line')
      .fill(
        [
          'Is the non-compete clause in my employment contract enforceable?',
          'What should a mutual NDA with a supplier cover?',
        ].join('\n'),
      );
    await legalEdit.getByRole('button', { name: 'Save route' }).click();
    await expect(legalEdit).toHaveCount(0);
    await phrase.fill('Review the indemnification clause in this vendor contract');
    await page.getByRole('button', { name: 'Try', exact: true }).click();
    await expect(result).toContainText(`Legal route, ${standard}`);
    await expect(result).toContainText('Matched examples and the description');
    await expect(result).toContainText('Closest to the examples');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Edit route Legal' }).click();
    const legalAgain = page.getByRole('dialog', { name: 'Edit route' });
    await legalAgain.getByRole('button', { name: 'Delete route' }).click();
    await page
      .getByRole('alertdialog', { name: 'Delete the route Legal?' })
      .getByRole('button', { name: 'Delete route' })
      .click();
    await expect(page.getByRole('heading', { name: 'No routes yet' })).toBeVisible();
  });
});
