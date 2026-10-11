import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  accounts,
  expect,
  expectAccessible,
  sessions,
  signIn,
  test,
  watchErrors,
} from './fixtures.ts';

/*
 * Content capture in the browser (OB-4, NF-P3, ADR 0077): off by default and said so on the
 * workspace page; an admin turns it on with a retention period; the change shows who made it; a
 * member sees, where they write in chat, that what they say is recorded.
 */

const suffix = () => randomBytes(3).toString('hex');

async function post(page: Page, origin: string, url: string, data: unknown, method = 'POST') {
  const res = await page.request.fetch(url, { method, headers: { origin }, data });
  expect(res.status(), `${method} ${url}`).toBeLessThan(300);
  return res.json() as Promise<unknown>;
}

test.describe('content capture (OB-4, NF-P3)', () => {
  test.use({ storageState: sessions.admin });

  test('an admin turns capture on, and a member is told in chat', async ({
    page,
    browser,
    errors,
  }) => {
    void errors;
    const tag = suffix();
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const { workspace } = (await post(page, origin, '/api/workspaces', {
      name: `Capture ${tag}`,
      slug: `capture-${tag}`,
    })) as { workspace: { id: string } };
    await post(
      page,
      origin,
      `/api/workspaces/${workspace.id}/members/${accounts.member.id}`,
      { role: 'member' },
      'PUT',
    );

    await page.goto(`/workspaces/${workspace.id}`);
    const section = page.getByRole('region', { name: 'Content capture' });
    const record = section.getByRole('checkbox', { name: /^Record prompts and replies/ });
    await expect(record).not.toBeChecked();
    // Kept while recording is off, and not editable until it is on (open-questions.md).
    const keep = section.getByRole('textbox', { name: 'Keep recorded text for' });
    await expect(keep).not.toBeEditable();
    await expectAccessible(page);

    await section.getByText('Record prompts and replies', { exact: true }).click();
    await expect(record).toBeChecked();
    await keep.fill('3');
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText('Settings saved.')).toBeVisible();
    await expect(section.getByText(/^Last changed by E2E Admin on /)).toBeVisible();

    // The member sees it on the workspace page, as read-only rows, and in chat.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const member = await context.newPage();
    const memberErrors: string[] = [];
    watchErrors(member, memberErrors);
    await signIn(member, accounts.member);
    await member.goto(`/workspaces/${workspace.id}`);
    const memberSection = member.getByRole('region', { name: 'Content capture' });
    await expect(memberSection).toContainText('On');
    await expect(memberSection).toContainText('3 days');
    await expect(memberSection.getByRole('checkbox')).toHaveCount(0);
    await expectAccessible(member);
    await member.goto(`/workspaces/${workspace.id}/chat`);
    await expect(
      member.getByText(
        'This workspace records prompts and replies for 3 days. Workspace admins can see them, and see the message your conversation was routed on if you pick another model.',
      ),
    ).toBeVisible();
    expect(memberErrors, 'member console and page errors').toEqual([]);
    await context.close();
  });
});
