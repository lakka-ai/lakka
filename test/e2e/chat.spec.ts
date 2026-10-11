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

/** A real one-pixel PNG, so the browser can draw the stored image. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/*
 * Chat in the browser (CH-1, CH-2, CH-3, CH-4, CH-5, CH-7, NF-A1, ADR 0061, ADR 0062), against the fake provider
 * the acceptance stack runs (docker/compose.e2e.yaml). An admin sets up a workspace with a cheap
 * default model; the member chats, stops a reply, picks a model, renames and deletes a
 * conversation, sees what is left of their budget, a fallback explained as it happens, and a
 * refusal in plain words.
 */

const FAKE_PROVIDER_URL = 'http://fake-provider:4010/openai/v1';

const suffix = () => randomBytes(3).toString('hex');

/** The model picker in the chat header, at desktop width. */
const modelPicker = (page: Page) => page.locator('#model-picker');

const escaped = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds a model through the picker's search, then picks it. An option is named by its model,
 * its id, then what it reads: "Claude Haiku 4.5 anthropic:claude-haiku-4-5 Text only".
 */
async function chooseModel(page: Page, option: string, search: string = option) {
  await modelPicker(page).click();
  const find = page.getByRole('searchbox', { name: 'Find a model or route' });
  await expect(find).toBeFocused();
  await find.fill(search);
  await page.getByRole('option', { name: new RegExp(`^${escaped(option)}\\b`) }).click();
}

/** A reply, as an article named for the model that wrote it (CH-2). */
const reply = (page: Page, model: string) =>
  page
    .getByRole('list', { name: 'Messages' })
    .getByRole('article', { name: `Reply from ${model}` });

async function post(page: Page, origin: string, url: string, data: unknown, method = 'POST') {
  const res = await page.request.fetch(url, { method, headers: { origin }, data });
  expect(res.status(), `${method} ${url}`).toBeLessThan(300);
  return res.json() as Promise<unknown>;
}

async function customModel(
  page: Page,
  origin: string,
  provider: string,
  name: string,
  input: number,
  vision = false,
) {
  const body = (await post(page, origin, '/api/models/custom', {
    provider,
    model: name,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision,
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
  })) as { model: { id: string; displayName: string } };
  return { id: body.model.id, name: body.model.displayName };
}

test.describe('chat (CH-1 to CH-5, CH-7, AC 6)', () => {
  test.use({ storageState: sessions.admin });

  test('a member chats, stops a reply, picks a model, sees their budget and a fallback, renames and deletes', async ({
    page,
    browser,
    errors,
  }) => {
    void errors;
    // One journey through every chat feature, with a few streamed replies: longer than most.
    test.setTimeout(90_000);
    const tag = suffix();
    await page.goto('/');
    const origin = new URL(page.url()).origin;

    // Setup through the api, as an instance admin would through the pages already tested.
    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `Chat ${tag}`,
      slug: `chat-${tag}`,
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
    // $1 per million input tokens, and a model a thousand times dearer.
    const cheap = await customModel(page, origin, provider, `ok~${tag}`, 1_000_000);
    const slow = await customModel(page, origin, provider, `slow~${tag}`, 1_000_000);
    const dear = await customModel(page, origin, provider, `ok~dear-${tag}`, 1_000_000_000);
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/routing/settings`,
      { routingEnabled: false, defaultModel: cheap.id, pinnedModel: null },
      'PUT',
    );

    const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const chat = await memberContext.newPage();
    const memberErrors: string[] = [];
    watchErrors(chat, memberErrors);
    await signIn(chat, accounts.member);
    await chat.goto(`/workspaces/${workspace.id}`);
    await mainMenu(chat).getByRole('link', { name: 'Chat', exact: true }).click();
    await expect(chat.getByRole('main', { name: 'Chat' })).toBeVisible();
    await expect(chat.getByRole('heading', { name: 'New conversation', level: 1 })).toBeVisible();
    // Routing is off here, so the empty conversation says the default answers.
    await expect(chat.getByText('What can I help with?')).toBeVisible();
    await expect(chat.getByText('This workspace uses one default model.')).toBeVisible();
    await expectAccessible(chat);

    // CH-1, CH-2: a streamed reply, with the model that answered and why.
    const message = chat.getByRole('textbox', { name: 'Message', exact: true });
    await expect(message).toBeEnabled();
    await message.fill('Hello from the browser');
    await message.press('Enter');
    const messages = chat.getByRole('list', { name: 'Messages' });
    await expect(messages.getByText('Hello there')).toBeVisible();
    const first = reply(chat, cheap.name);
    await expect(first).toBeVisible();
    await expect(
      first.getByRole('button', { name: 'Why this model: This is the workspace default model.' }),
    ).toBeVisible();
    // CH-4: what the reply cost, and a way to its trace.
    await expect(first).toContainText(/\$0\.\d{4}/);
    await expect(first.getByRole('link', { name: 'View trace' })).toBeVisible();
    await expect(chat.getByRole('status').filter({ hasText: 'Reply finished' })).toHaveCount(1);
    const conversations = chat.getByRole('navigation', { name: 'Conversations' });
    await expect(
      conversations.getByRole('row', { name: 'Hello from the browser' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      chat.getByRole('heading', { name: 'Hello from the browser', level: 1 }),
    ).toBeVisible();
    await expectAccessible(chat);

    // CH-3: picking a model, found by its id, is kept with the conversation and recorded as the
    // person's choice.
    await chooseModel(chat, slow.name, slow.id);
    await message.fill('Count slowly');
    await message.press('Enter');
    await expect(reply(chat, slow.name)).toBeVisible();
    await chat.getByRole('button', { name: 'Stop' }).click();
    const stopped = reply(chat, slow.name);
    await expect(stopped).toContainText('You stopped this reply. What arrived is kept.');
    await expect(
      stopped.getByRole('button', { name: 'Why this model: You chose this model.' }),
    ).toBeVisible();
    await expect(chat.getByRole('status').filter({ hasText: 'Reply stopped' })).toHaveCount(1);

    // The history survives a reload, as stored by the api.
    await chat.reload();
    await expect(messages.getByText('Hello there')).toBeVisible();
    await expect(messages.getByText('You stopped this reply.')).toBeVisible();
    await expect(modelPicker(chat)).toContainText(slow.name);

    // CH-4: a cap shows what is left, and a fallback is explained as it happens.
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/budgets/members/${accounts.member.id}`,
      { limitMicroUsd: '1000000', period: 'monthly' },
      'PUT',
    );
    // A new page load reads the cap an admin just set.
    await chat.goto(`/workspaces/${workspace.id}/chat`);
    // The meter says what is left, of what, and when it resets (Pattern 2).
    const meter = chat.getByRole('button', { name: /on your cap\. Resets .+\. Show all caps$/ });
    await expect(meter).toHaveAccessibleName(/^\$1\.00 left of \$1\.00 on your cap\./);
    await pressUntil(meter, chat.getByRole('meter', { name: 'Your cap' }));
    await expectAccessible(chat);
    await chat.keyboard.press('Escape');
    await chooseModel(chat, dear.name);
    await message.fill('Something expensive');
    await message.press('Enter');
    // Explained the moment it happens, before the reply's words (CH-4, Pattern 3).
    const fellBack = reply(chat, cheap.name).last();
    await expect(
      fellBack.getByRole('status').filter({
        hasText: `Your budget would not cover ${dear.name}, so ${cheap.name} answered.`,
      }),
    ).toBeVisible();
    await expect(
      fellBack.getByRole('button', {
        name: `Why this model: Your budget would not cover ${dear.name}, so a cheaper one answered.`,
      }),
    ).toBeVisible();

    const send = chat.getByRole('button', { name: 'Send' });
    await message.fill('One more, please');
    // Until the last reply is stored, Send says why it cannot be used yet. Once it is, the page
    // reads what is left on the cap again, and then asks for it no more until the next send.
    await expect(send).not.toHaveAttribute('aria-disabled', 'true');
    await chat.waitForLoadState('networkidle');

    // CH-7: a refusal is a sentence the person can act on, and their message is not lost. The
    // cap is used up after the page last read it, so Send is still offered and the server
    // refuses.
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/budgets/members/${accounts.member.id}`,
      { limitMicroUsd: '1', period: 'monthly' },
      'PUT',
    );
    await message.press('Enter');
    // Directly above the message box, one sentence on what happened and one on what to do.
    await expect(chat.getByRole('alert')).toContainText('Not sent.');
    await expect(chat.getByRole('alert')).not.toContainText('402');
    await expect(message).toHaveValue('One more, please');
    // CH-4: now the page knows the cap is used up, Send says so instead of sending
    // (accessibility.md, Chat; Chat-Phone-Exhausted).
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).toHaveAccessibleDescription(
      'Your cap is used up. Messages are refused until it resets or an admin raises it.',
    );
    await expectAccessible(chat);

    // CH-1: renaming and deleting.
    await chat.getByRole('button', { name: 'Rename conversation' }).click();
    const dialog = chat.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Budget test');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    const renamed = conversations.getByRole('row', { name: 'Budget test' });
    await expect(renamed).toBeVisible();
    await renamed.getByRole('button', { name: 'Options for Budget test' }).click();
    await chat.getByRole('menuitem', { name: 'Delete' }).click();
    await expectAccessible(chat);
    await chat
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete conversation' })
      .click();
    await expect(conversations.getByRole('row', { name: 'Budget test' })).toHaveCount(0);
    await expect(chat.getByRole('heading', { name: 'New conversation', level: 1 })).toBeVisible();

    expect(memberErrors).toEqual([]);
    await memberContext.close();
  });

  test('CH-5: files are offered only where the chosen model reads them, stored, shown and sent again', async ({
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
      name: `Files ${tag}`,
      slug: `files-${tag}`,
    })) as { workspace: { id: string } };
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/members/${accounts.member.id}`,
      { role: 'member' },
      'PUT',
    );
    const provider = `fake-files-${tag}`;
    await post(page, origin, '/api/providers', {
      kind: 'openai-compatible',
      name: provider,
      baseUrl: FAKE_PROVIDER_URL,
    });
    const text = await customModel(page, origin, provider, `ok~text-${tag}`, 1_000_000);
    const vision = await customModel(page, origin, provider, `ok~vision-${tag}`, 1_000_000, true);
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/routing/settings`,
      { routingEnabled: false, defaultModel: text.id, pinnedModel: null },
      'PUT',
    );

    const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const chat = await memberContext.newPage();
    const memberErrors: string[] = [];
    watchErrors(chat, memberErrors);
    await signIn(chat, accounts.member);
    await chat.goto(`/workspaces/${workspace.id}/chat`);
    const message = chat.getByRole('textbox', { name: 'Message', exact: true });
    await expect(message).toBeEnabled();

    // Every model reads text files (ADR 0106), so Attach files is offered even where the default
    // reads nothing else.
    const attach = chat.getByRole('button', { name: 'Attach files' });
    await expect(attach).toBeVisible();

    await chooseModel(chat, vision.name);

    // A kind of file the model cannot read stays listed, marked with why, and blocks Send.
    let chooser = chat.waitForEvent('filechooser');
    await attach.click();
    await (
      await chooser
    ).setFiles({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7 fake'),
    });
    const toSend = chat.getByRole('list', { name: 'Attached files' });
    await expect(toSend).toContainText('report.pdf');
    await expect(toSend).toContainText(`${vision.name} cannot read this kind of file.`);
    const send = chat.getByRole('button', { name: 'Send' });
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).toHaveAccessibleDescription('Remove the file marked in red to send.');
    await expectAccessible(chat);
    await toSend.getByRole('button', { name: 'Remove report.pdf' }).click();

    chooser = chat.waitForEvent('filechooser');
    await attach.click();
    await (await chooser).setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PIXEL });
    await expect(toSend).toContainText('dot.png');
    await expectAccessible(chat);
    await message.fill('What is in this picture?');
    await message.press('Enter');

    const messages = chat.getByRole('list', { name: 'Messages' });
    const image = messages.getByRole('img', { name: 'Attached image: dot.png' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect(messages.getByText('Hello there')).toHaveCount(1);
    await expect(toSend).toHaveCount(0);

    // The next turn sends the stored file again by id, so the model still sees it.
    await message.fill('And the colours?');
    await message.press('Enter');
    await expect(messages.getByText('Hello there')).toHaveCount(2);
    await expect(chat.getByRole('alert')).toHaveCount(0);

    // A file stays stored even if the conversation moves to a model that cannot read it; the
    // next message is refused with a sentence, and kept. Attach files stays, for text files.
    await chooseModel(chat, text.name);
    await expect(attach).toBeVisible();
    await message.fill('Once more');
    await message.press('Enter');
    await expect(chat.getByRole('alert')).toContainText(
      'The chosen model cannot read this kind of file.',
    );
    await expect(message).toHaveValue('Once more');
    await expectAccessible(chat);

    expect(memberErrors).toEqual([]);
    await memberContext.close();
  });

  test('CH-1: a reply is drawn from its Markdown, and the thread follows it unless scrolled away', async ({
    page,
    errors,
  }) => {
    void errors;
    const tag = suffix();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `Markdown ${tag}`,
      slug: `markdown-${tag}`,
    })) as { workspace: { id: string } };
    const provider = `fake-${tag}`;
    await post(page, origin, '/api/providers', {
      kind: 'openai-compatible',
      name: provider,
      baseUrl: FAKE_PROVIDER_URL,
    });
    // A long reply in Markdown, a line every 60 ms.
    const writer = await customModel(page, origin, provider, `markdown~${tag}`, 1_000_000);
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/routing/settings`,
      { routingEnabled: false, defaultModel: writer.id, pinnedModel: null },
      'PUT',
    );
    await page.goto(`/workspaces/${workspace.id}/chat`);

    /** How far the thread is from its end, and where it is. */
    const thread = () =>
      page.getByRole('list', { name: 'Messages' }).evaluate((list) => {
        const box = list.closest('.overflow-y-auto');
        if (box === null) throw new Error('no scrolling thread');
        return { gap: box.scrollHeight - box.scrollTop - box.clientHeight, top: box.scrollTop };
      });
    const latest = page.getByRole('button', { name: 'Scroll to latest' });
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('Release notes, please');
    await message.press('Enter');

    // At the end, the thread follows the reply as it grows.
    await expect.poll(async () => (await thread()).top, { timeout: 5000 }).toBeGreaterThan(0);
    expect((await thread()).gap).toBeLessThanOrEqual(48);
    await expect(latest).toHaveCount(0);

    // Scrolled away while it is still being written, the thread stays where it was put. It has
    // to have run well past the end first: within 48px of it, the top still counts as the end
    // (NEAR_END_PX, follow-end.ts), and the thread rightly keeps following.
    await expect.poll(async () => (await thread()).top, { timeout: 5000 }).toBeGreaterThan(96);
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.getByRole('list', { name: 'Messages' }).evaluate((list) => {
      const box = list.closest('.overflow-y-auto');
      if (box !== null) box.scrollTop = 0;
    });
    await expect(latest).toBeVisible();
    await page.waitForTimeout(600);
    expect((await thread()).top).toBe(0);
    await expectAccessible(page);

    // Scroll to latest goes back to the end and follows again; focus moves to the message box.
    await latest.click();
    await expect(latest).toHaveCount(0);
    await expect(message).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Reply finished' })).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect.poll(async () => (await thread()).gap).toBeLessThanOrEqual(48);
    await expect(page.getByText('The end.')).toBeInViewport();

    // CH-1: the reply's Markdown, drawn as elements, with model output kept to safe forms. Its
    // headings start at h2, under the conversation's h1 (ADR 0112).
    const answer = reply(page, writer.name);
    await expect(answer.getByRole('heading', { name: 'Release notes', level: 2 })).toBeVisible();
    await expect(answer.getByRole('heading', { name: 'Changes', level: 3 })).toBeVisible();
    await expect(answer.locator('strong', { hasText: 'bold' })).toBeVisible();
    await expect(answer.getByRole('listitem').filter({ hasText: 'Second change' })).toBeVisible();
    await expect(answer.locator('pre code', { hasText: 'print("hello")' })).toBeVisible();
    // A reply's tables are numbered, so two never share a region name (ADR 0112).
    const table = answer.getByRole('region', { name: 'Table 1, scrolls sideways' });
    await expect(table.getByRole('cell', { name: '$0.01' })).toBeVisible();
    const docs = answer.getByRole('link', { name: 'the docs' });
    await expect(docs).toHaveAttribute('href', 'https://example.com/docs');
    await expect(docs).toHaveAttribute('target', '_blank');
    await expect(docs).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    await expectAccessible(page);

    // Switching conversations opens the other one at its end, whatever position was left behind.
    // New conversation is a link: it goes to an address (ADR 0112).
    await page.getByRole('link', { name: 'New conversation' }).click();
    await message.fill('More release notes');
    await message.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Reply finished' })).toHaveCount(1, {
      timeout: 10_000,
    });
    await page.getByRole('list', { name: 'Messages' }).evaluate((list) => {
      const box = list.closest('.overflow-y-auto');
      if (box !== null) box.scrollTop = 0;
    });
    await expect(latest).toBeVisible();
    const conversations = page.getByRole('navigation', { name: 'Conversations' });
    await conversations.getByRole('row', { name: 'Release notes, please' }).click();
    await expect(
      page.getByRole('heading', { name: 'Release notes, please', level: 1 }),
    ).toBeVisible();
    await expect.poll(async () => (await thread()).gap).toBeLessThanOrEqual(48);
    await expect(latest).toHaveCount(0);
  });

  test('CH-5: files dropped on the conversation or pasted are attached, and long text becomes a document', async ({
    page,
    errors,
  }) => {
    void errors;
    const tag = suffix();
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `Drop ${tag}`,
      slug: `drop-${tag}`,
    })) as { workspace: { id: string } };
    const provider = `fake-drop-${tag}`;
    await post(page, origin, '/api/providers', {
      kind: 'openai-compatible',
      name: provider,
      baseUrl: FAKE_PROVIDER_URL,
    });
    // Reads text only: an image is marked, text files are not (ADR 0106).
    const text = await customModel(page, origin, provider, `ok~drop-${tag}`, 1_000_000);
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/routing/settings`,
      { routingEnabled: false, defaultModel: text.id, pinnedModel: null },
      'PUT',
    );
    await page.goto(`/workspaces/${workspace.id}/chat`);
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(message).toBeEnabled();
    const toSend = page.getByRole('list', { name: 'Attached files' });

    // A drag of files over the conversation shows where they go; dropping attaches them. A file
    // the browser gives no type is known as text by its name.
    const main = page.getByRole('main', { name: 'Chat' });
    const files = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['# Plan\nShip on Friday.'], 'plan.md', { type: '' }));
      transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'chart.png', { type: 'image/png' }));
      return transfer;
    });
    await main.dispatchEvent('dragenter', { dataTransfer: files });
    await expect(page.getByText('Drop files to attach them')).toBeVisible();
    await expectAccessible(page);
    await main.dispatchEvent('drop', { dataTransfer: files });
    await expect(page.getByText('Drop files to attach them')).toHaveCount(0);
    await expect(toSend).toContainText('plan.md');
    await expect(toSend).toContainText(`${text.name} cannot read this kind of file.`);
    await toSend.getByRole('button', { name: 'Remove chart.png' }).click();

    // A paste of more than 2,000 characters becomes a document; a short one stays text.
    const paste = (content: string) =>
      message.evaluate((box, pasted) => {
        const transfer = new DataTransfer();
        transfer.setData('text/plain', pasted);
        box.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
        );
      }, content);
    await paste('Long line of pasted text. '.repeat(100));
    await expect(toSend).toContainText('Pasted text.txt');
    await paste('short');
    await expect(toSend.getByRole('listitem')).toHaveCount(2);

    await message.fill('Summarize these');
    await message.press('Enter');
    const turn = page.getByRole('list', { name: 'Messages' }).getByRole('article').first();
    await expect(turn.getByRole('link', { name: /^plan\.md/ })).toBeVisible();
    await expect(turn.getByRole('link', { name: /^Pasted text\.txt/ })).toBeVisible();
    await expect(reply(page, text.name)).toContainText('Hello there');
    await expectAccessible(page);
  });

  test('NF-A1: the conversation list hides, its buttons move to the header, and it stays hidden', async ({
    page,
    errors,
  }) => {
    void errors;
    const tag = suffix();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `Hide ${tag}`,
      slug: `hide-${tag}`,
    })) as { workspace: { id: string } };
    await page.goto(`/workspaces/${workspace.id}/chat`);

    const list = page.getByRole('navigation', { name: 'Conversations' });
    const hide = page.getByRole('button', { name: 'Hide conversations' });
    // The toggles and the title sit on one line, whichever column is collapsed.
    const middle = async (name: string) => {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      if (box === null) throw new Error(`${name} is not shown`);
      return box.y + box.height / 2;
    };
    const title = async () => {
      const box = await page.getByRole('heading', { level: 1 }).boundingBox();
      if (box === null) throw new Error('no title');
      return box.y + box.height / 2;
    };
    expect(await middle('Hide conversations')).toBe(await middle('Collapse menu'));
    expect(await title()).toBe(await middle('Collapse menu'));
    // New conversation starts level with the workspace switcher.
    const tops = await Promise.all(
      [
        list.getByRole('link', { name: 'New conversation' }),
        page.getByRole('button', { name: /^Workspace: / }),
      ].map(async (button) => (await button.boundingBox())?.y),
    );
    expect(tops[0]).toBe(tops[1]);
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    await expect(hide).toHaveAttribute('aria-controls', 'conversation-list');
    await hide.click();
    await expect(list).toBeHidden();

    // Focus stays on the button that took its place, left of the title.
    const show = page.getByRole('button', { name: 'Show conversations' });
    await expect(show).toBeFocused();
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    // The list sits beside the main region, so a New conversation inside main is the header's.
    const header = page.getByRole('main', { name: 'Chat' });
    await expect(header.getByRole('link', { name: 'New conversation' })).toBeVisible();
    expect(await middle('Show conversations')).toBe(await middle('Collapse menu'));
    await expectAccessible(page);

    // Remembered in this browser, also with the menu collapsed.
    await page.getByRole('button', { name: 'Collapse menu' }).click();
    await page.reload();
    await expect(list).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
    expect(await middle('Show conversations')).toBe(await middle('Expand menu'));
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'light' });

    await page.getByRole('button', { name: 'Show conversations' }).click();
    await expect(list).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide conversations' })).toBeFocused();
    await expect(header.getByRole('link', { name: 'New conversation' })).toHaveCount(0);
  });

  test('AC 6: removing a member ends the reply they are watching within 5 seconds, and says why', async ({
    page,
    browser,
    errors,
  }) => {
    void errors;
    const tag = suffix();
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `Revoke ${tag}`,
      slug: `revoke-${tag}`,
    })) as { workspace: { id: string } };
    const membership = `/api/workspaces/${workspace.id}/members/${accounts.member.id}`;
    await post(page, origin, membership, { role: 'member' }, 'PUT');
    const provider = `fake-revoke-${tag}`;
    await post(page, origin, '/api/providers', {
      kind: 'openai-compatible',
      name: provider,
      baseUrl: FAKE_PROVIDER_URL,
    });
    // Sends one chunk, then nothing for a minute: a reply still streaming.
    const idle = await customModel(page, origin, provider, `idle-after-1~${tag}`, 1_000_000);
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/routing/settings`,
      { routingEnabled: false, defaultModel: idle.id, pinnedModel: null },
      'PUT',
    );

    const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const chat = await memberContext.newPage();
    const memberErrors: string[] = [];
    watchErrors(chat, memberErrors);
    await signIn(chat, accounts.member);
    await chat.goto(`/workspaces/${workspace.id}/chat`);
    const message = chat.getByRole('textbox', { name: 'Message', exact: true });
    await expect(message).toBeEnabled();
    await message.fill('Tell me a long story');
    await message.press('Enter');
    await expect(reply(chat, idle.name)).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Stop' })).toBeVisible();

    const res = await page.request.delete(membership, { headers: { origin } });
    expect(res.status()).toBe(204);
    await expect(chat.getByRole('alert')).toContainText(
      'Your access to this workspace has ended, so the reply was stopped.',
      { timeout: 5000 },
    );
    await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);

    expect(memberErrors).toEqual([]);
    await memberContext.close();
  });
});
