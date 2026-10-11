import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Exporting and deleting a person from the People page (NF-P4, ADR 0082). The person is new to
 * this test, joined through an invite link, so deleting them leaves the suite's accounts alone.
 */

const suffix = () => randomBytes(3).toString('hex');

/** A new person in a new workspace, signed in in a browser of their own. */
async function newPerson(page: Page, browser: Browser, errors: string[]) {
  const id = suffix();
  const workspace = `People ${id}`;
  await createWorkspace(page, workspace);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Copy the invite link' });
  const link = await dialog.getByLabel('Invite link').inputValue();
  await dialog.getByRole('button', { name: 'I have saved it' }).click();

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const theirs = await context.newPage();
  watchErrors(theirs, errors);
  const email = `leaver-${id}@example.com`;
  await theirs.goto(link);
  await theirs.getByLabel('Name', { exact: true }).fill(`Leaver ${id}`);
  await theirs.getByLabel('Email').fill(email);
  await theirs.getByLabel('Password').fill(`leaver password ${accounts.tag}`);
  await theirs.getByRole('button', { name: 'Create account and join' }).click();
  await expectWorkspaceSettings(theirs, workspace);
  return { email, name: `Leaver ${id}`, workspace, context, page: theirs };
}

test.describe('people: instance admins, export and delete (ID-3, NF-P4)', () => {
  test.use({ storageState: sessions.admin });

  test("NF-P4: an admin downloads a person's data, then deletes them, and they are signed out", async ({
    page,
    browser,
    errors,
  }) => {
    const person = await newPerson(page, browser, errors);
    await page.goto('/admin/people');
    // The suite makes many people; find this one rather than page through.
    // Typed before the page hydrates, the search would be reset; try until it holds.
    await expect(async () => {
      await page.getByLabel('Find a person').fill(person.email);
      await expect(page.getByRole('row').filter({ hasText: person.email })).toBeVisible({
        timeout: 1000,
      });
    }).toPass();
    const row = page.getByRole('row').filter({ hasText: person.email });
    await expect(row).toContainText(`${person.workspace}: Member.`);
    // The instance role has a column of its own, after the person.
    await expect(page.getByRole('columnheader', { name: 'Role' })).toBeVisible();
    const role = row.getByRole('gridcell').first();
    await expect(role).toHaveText('Member');

    // ID-3: an instance admin makes them one, and they see the Admin pages; then removes it.
    await row.getByRole('button', { name: `More actions for ${person.name}` }).click();
    await page.getByRole('menuitem', { name: `Make ${person.name} an instance admin` }).click();
    const grant = page.getByRole('alertdialog', { name: `Make ${person.name} an instance admin?` });
    await expectAccessible(page);
    await grant.getByRole('button', { name: 'Make instance admin' }).click();
    await expect(role).toHaveText('Admin');
    await person.page.goto('/admin/people');
    await expect(
      person.page.getByRole('heading', { name: 'People and sign-in', level: 1 }),
    ).toBeVisible();
    await row.getByRole('button', { name: `More actions for ${person.name}` }).click();
    await page.getByRole('menuitem', { name: `Remove instance admin from ${person.name}` }).click();
    await page
      .getByRole('alertdialog', { name: `Remove instance admin from ${person.name}?` })
      .getByRole('button', { name: 'Remove instance admin' })
      .click();
    await expect(role).toHaveText('Member');
    await person.page.goto('/admin/people');
    await expect(person.page).toHaveURL(/\/workspaces(\/|$)/);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      row.getByRole('link', { name: `Export the data of ${person.name}` }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^lakka-export-\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}\.tar\.gz$/,
    );
    const dir = mkdtempSync(join(tmpdir(), 'lakka-e2e-export-'));
    try {
      const file = join(dir, 'export.tar.gz');
      await download.saveAs(file);
      execFileSync('tar', ['-xzf', file, '-C', dir]);
      const profile = JSON.parse(
        readFileSync(join(dir, 'lakka-export', 'person.json'), 'utf8'),
      ) as { email: string };
      expect(profile.email).toBe(person.email);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    await row.getByRole('button', { name: `Delete ${person.name}` }).click();
    const dialog = page.getByRole('alertdialog', { name: `Delete ${person.name}` });
    await expectAccessible(page);
    const typed = dialog.getByLabel(`Type ${person.email} to confirm`);
    await typed.fill(accounts.member.email);
    // aria-disabled until the email matches, so it stays focusable and says why.
    await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(dialog.getByText('The email does not match yet.')).toBeVisible();
    await typed.fill(person.email);
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`${person.name} was deleted.`)).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: person.email })).toHaveCount(0);

    // Their own browser is signed out on its next request.
    await person.page.reload();
    await expect(person.page).toHaveURL(/\/sign-in/);
    await person.context.close();
  });

  test('ID-2: an admin makes a password reset link, and the person sets a new password with it', async ({
    page,
    browser,
    errors,
  }) => {
    const person = await newPerson(page, browser, errors);
    await page.goto('/admin/people');
    // The suite makes many people; find this one rather than page through.
    // Typed before the page hydrates, the search would be reset; try until it holds.
    await expect(async () => {
      await page.getByLabel('Find a person').fill(person.email);
      await expect(page.getByRole('row').filter({ hasText: person.email })).toBeVisible({
        timeout: 1000,
      });
    }).toPass();
    const row = page.getByRole('row').filter({ hasText: person.email });
    await row.getByRole('button', { name: `More actions for ${person.name}` }).click();
    await page
      .getByRole('menuitem', { name: `Make a password reset link for ${person.name}` })
      .click();
    const dialog = page.getByRole('alertdialog', {
      name: `Copy the reset link for ${person.name}`,
    });
    const link = await dialog.getByLabel('Reset link').inputValue();
    expect(link).toMatch(/\/reset#[A-Za-z0-9_-]{43}$/);
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'I have saved it' }).click();
    await expect(page.getByText(`A reset link for ${person.name} was made.`)).toBeVisible();

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const reset = await context.newPage();
    watchErrors(reset, errors);
    await reset.goto(link);
    await expect(
      reset.getByRole('heading', { name: 'Choose a new password', level: 1 }),
    ).toBeVisible();
    await expect(reset.getByText(`For ${person.name}, ${person.email}.`)).toBeVisible();
    expect(reset.url()).not.toContain('#');
    await expectAccessible(reset);
    const password = `a new password ${accounts.tag}`;
    await reset.getByLabel('New password').fill(password);
    await reset.getByRole('button', { name: 'Set new password' }).click();
    await expect(reset.getByRole('heading', { name: 'Your password is set' })).toBeFocused();

    // Signed out everywhere, and the new password works; the link does not work twice.
    await person.page.reload();
    await expect(person.page).toHaveURL(/\/sign-in/);
    await awaitSignInSlot();
    await person.page.getByLabel('Email').fill(person.email);
    await person.page.getByLabel('Password', { exact: true }).fill(password);
    await person.page.getByRole('button', { name: 'Sign in' }).click();
    await expect(
      person.page.getByRole('button', { name: `Account: ${person.name}` }),
    ).toBeVisible();
    // A new tab: in this one only the fragment would change, which loads nothing.
    const again = await context.newPage();
    watchErrors(again, errors);
    await again.goto(link);
    await expect(
      again.getByRole('heading', { name: 'This reset link does not work' }),
    ).toBeFocused();
    await context.close();
    await person.context.close();
  });
});
