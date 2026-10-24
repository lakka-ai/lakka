import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import {
  accountName,
  accounts,
  expect,
  expectAccessible,
  expectWorkspaceSettings,
  test,
} from './fixtures.ts';
import { m1ExitJourney } from './m1-exit.ts';

/*
 * First-run setup in the browser (AD-1, NF-D1, ADR 0034), then the M1 exit journey as the admin
 * it created. Setup can happen once per stack, so this runs as its own project before the rest
 * of the suite. On a stack that was set up before, both are skipped with a note, except in CI,
 * where LAKKA_E2E_REQUIRE_FIRST_RUN makes that a failure: CI always starts from a fresh stack.
 */

/** The first admin's browser session, saved by setup for the journey that follows. */
const FIRST_ADMIN_SESSION = 'test/e2e/.auth/first-admin.json';

test.describe.configure({ mode: 'serial' });

function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'api', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('AD-1, NF-D1: a fresh instance is set up in the browser with the setup code', async ({
  page,
  errors,
}) => {
  void errors;
  // Never let a session saved against an earlier stack stand in for this run's admin.
  rmSync(FIRST_ADMIN_SESSION, { force: true });
  const { required } = (await (await page.request.get('/api/setup')).json()) as {
    required: boolean;
  };
  if (!required) {
    expect(
      process.env['LAKKA_E2E_REQUIRE_FIRST_RUN'],
      'this run needs a fresh stack, but setup was already completed',
    ).toBeUndefined();
    test.skip(true, 'setup was already completed on this stack; run against a fresh one');
  }

  // A visitor to a fresh instance lands on setup, wherever they start.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup\/code$/);
  await expect(
    page.getByRole('navigation', { name: 'Setup steps' }).locator('[aria-current=step]'),
  ).toContainText('Setup code');
  await expect(page.getByRole('heading', { name: 'Set up Lakka', level: 1 })).toBeVisible();
  await expect(page.getByText('docker compose exec api lakka setup-code')).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel('Setup code').fill('not-the-setup-code');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Inline, tied to the field, and what was typed stays.
  await expect(page.getByLabel('Setup code')).toHaveAccessibleDescription(
    /That setup code is not right/,
  );
  await expect(page.getByLabel('Setup code')).toHaveValue('not-the-setup-code');

  await page.getByLabel('Setup code').fill(compose('lakka', 'setup-code'));
  await page.getByRole('button', { name: 'Continue' }).click();

  // ADR 0021: the recovery key is the credential master key, shown here and nowhere else.
  await expect(page).toHaveURL(/\/setup\/recovery-key$/);
  const keyHeading = page.getByRole('heading', { name: 'Save your recovery key' });
  await expect(keyHeading).toBeFocused();
  const shown = await page.getByLabel('Recovery key', { exact: true }).inputValue();
  const actual = compose('cat', '/run/lakka/secrets/credential_master_key');
  expect(shown === actual, 'the key shown is the credential master key').toBe(true);
  await expectAccessible(page);
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(next).toHaveAccessibleDescription('Tick the box to continue.');
  await page.getByText('I have saved the recovery key somewhere safe').click();
  await next.click();

  await expect(page).toHaveURL(/\/setup\/account$/);
  await expect(page.getByRole('heading', { name: 'Create your admin account' })).toBeFocused();
  await expect(page.getByLabel('Recovery key', { exact: true })).toHaveCount(0);
  await expectAccessible(page);
  const email = `first-admin-${accounts.tag}@example.com`;
  await page.getByLabel('Name', { exact: true }).fill('First Admin');
  await page.getByLabel('Email').fill(email);
  const password = page.getByLabel('Password', { exact: true });
  await password.fill(`first admin password ${accounts.tag}`);
  // The button says what it does: Show while hidden, Hide while shown.
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByLabel('Workspace name').fill('Acme');
  await page.getByRole('button', { name: 'Create account and workspace' }).click();

  // Signed in as the new instance admin, in the first workspace.
  await expectWorkspaceSettings(page, 'Acme');
  await expect(page.getByRole('button', { name: accountName('First Admin') })).toBeVisible();
  await expect(page.getByRole('link', { name: 'People and sign-in' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: email })).toContainText('Admin');

  // Setup is closed: the page sends people to sign-in and the command no longer gives a code.
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(() => compose('lakka', 'setup-code')).toThrow(/already complete/);
  await page.context().storageState({ path: FIRST_ADMIN_SESSION });
});

test('M1 exit: the first admin invites a member, both issue keys, the admin revokes both, and workspaces stay isolated', async ({
  browser,
  errors,
}) => {
  test.skip(!existsSync(FIRST_ADMIN_SESSION), 'runs only after first-run setup in this run');
  await m1ExitJourney(browser, errors, FIRST_ADMIN_SESSION);
});
