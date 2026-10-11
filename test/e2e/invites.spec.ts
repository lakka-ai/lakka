import { randomBytes } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import {
  accounts,
  awaitSignInSlot,
  createWorkspace,
  expect,
  expectAccessible,
  expectWorkspaceSettings,
  sessions,
  test,
  watchErrors,
} from './fixtures.ts';

/*
 * Invite links (ID-7, ADR 0035): an admin creates a link, and the person it is for joins with a
 * new account or the one they have. Each test uses its own workspace.
 */

// Random, not a counter: Playwright restarts the worker after a failure, resetting module state.
const suffix = () => randomBytes(3).toString('hex');

async function newWorkspace(page: Page): Promise<string> {
  const id = suffix();
  const name = `Invites ${id}`;
  await createWorkspace(page, name);
  return name;
}

/** Open invites; a row's accessible name is only its first cell, so filter by text. */
const openInvites = (page: Page) => page.getByRole('grid', { name: 'Invites' }).getByRole('row');

async function createInviteLink(page: Page, role: 'Member' | 'Admin'): Promise<string> {
  const invites = page.getByRole('region', { name: 'Invites' });
  await invites.getByRole('button', { name: / Role$/ }).click();
  await page.getByRole('option', { name: role, exact: true }).click();
  await invites.getByRole('button', { name: 'Create invite link' }).click();
  // Pattern 5: shown once, and "I have saved it" is the only way out.
  const dialog = page.getByRole('alertdialog', { name: 'Copy the invite link' });
  const link = await dialog.getByLabel('Invite link').inputValue();
  expect(link).toMatch(/\/invite#[A-Za-z0-9_-]{43}$/);
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'I have saved it' }).click();
  await expect(dialog).toBeHidden();
  return link;
}

/**
 * A browser with no session, as the person receiving the link. It must say so: a new context
 * otherwise inherits the storageState this file uses.
 */
async function stranger(browser: Browser, errors: string[]) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  watchErrors(page, errors);
  return { context, page };
}

test.describe('invites (ID-7)', () => {
  test.use({ storageState: sessions.admin });

  test('an admin invites someone new by link, who creates an account and joins', async ({
    page,
    browser,
    errors,
  }) => {
    const name = await newWorkspace(page);
    await expect(page.getByText('No open invites.')).toBeVisible();
    await expectAccessible(page);
    const link = await createInviteLink(page, 'Member');
    await expect(openInvites(page).filter({ hasText: 'E2E Admin' })).toContainText('Member');

    const { context, page: invitee } = await stranger(browser, errors);
    await invitee.goto(link);
    // The workspace and the role come first, in the heading and the first sentence.
    await expect(invitee.getByRole('heading', { name: `Join ${name}`, level: 1 })).toBeVisible();
    await expect(invitee.getByText('E2E Admin invited you as a member.')).toBeVisible();
    // The token leaves the address bar as soon as the page has read it.
    expect(invitee.url()).not.toContain('#');
    await expectAccessible(invitee);

    const email = `invitee-${suffix()}@example.com`;
    await invitee.getByLabel('Name', { exact: true }).fill('New Colleague');
    await invitee.getByLabel('Email').fill(email);
    await invitee.getByLabel('Password').fill(`invitee password ${accounts.tag}`);
    await invitee.getByRole('button', { name: 'Create account and join' }).click();
    await expectWorkspaceSettings(invitee, name);
    await expect(invitee.getByRole('button', { name: 'Account: New Colleague' })).toBeVisible();
    await context.close();

    // The link worked once.
    const again = await stranger(browser, errors);
    await again.page.goto(link);
    const dead = again.page.getByRole('heading', { name: 'This invite link does not work' });
    await expect(dead).toBeFocused();
    await expectAccessible(again.page);
    await expect(again.page.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
    await again.context.close();

    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: email })).toContainText('Member');
    await expect(page.getByText('No open invites.')).toBeVisible();
  });

  test('someone with an account signs in from the invite page and joins as themselves', async ({
    page,
    browser,
    errors,
  }) => {
    const name = await newWorkspace(page);
    const link = await createInviteLink(page, 'Admin');

    const { context, page: invitee } = await stranger(browser, errors);
    await invitee.goto(link);
    await invitee.getByRole('link', { name: 'Sign in to accept' }).click();
    await expect(invitee).toHaveURL(/\/sign-in\?redirect=%2Finvite$/);
    // The invite page has an Email field too; wait until sign-in has replaced it.
    await expect(invitee.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
    await invitee.getByLabel('Email').fill(accounts.member.email);
    await invitee.getByLabel('Password').fill(accounts.member.password);
    await awaitSignInSlot();
    await invitee.getByRole('button', { name: 'Sign in' }).click();

    await expect(invitee).toHaveURL(/\/invite$/);
    await expect(invitee.getByText('E2E Admin invited you as an admin.')).toBeVisible();
    await invitee.getByRole('button', { name: `Join ${name} as E2E Member` }).click();
    await expectWorkspaceSettings(invitee, name);
    await expect(invitee.getByRole('row').filter({ hasText: accounts.member.email })).toContainText(
      'Admin',
    );
    await context.close();
  });

  test('an admin withdraws an invite, and its link stops working', async ({
    page,
    browser,
    errors,
  }) => {
    await newWorkspace(page);
    const link = await createInviteLink(page, 'Member');
    await openInvites(page)
      .filter({ hasText: 'E2E Admin' })
      .getByRole('button', { name: /^Withdraw the member invite made / })
      .click();
    // A plain confirm first.
    await page
      .getByRole('alertdialog', { name: 'Withdraw this invite?' })
      .getByRole('button', { name: 'Withdraw' })
      .click();
    await expect(page.getByText('No open invites.')).toBeVisible();

    const { context, page: invitee } = await stranger(browser, errors);
    await invitee.goto(link);
    await expect(
      invitee.getByRole('heading', { name: 'This invite link does not work' }),
    ).toBeVisible();
    await context.close();
  });
});
