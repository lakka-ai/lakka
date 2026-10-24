import {
  accountName,
  accounts,
  awaitSignInSlot,
  createWorkspace,
  expect,
  expectAccessible,
  expectWorkspaceSettings,
  mainMenu,
  pressUntil,
  sessions,
  signIn,
  signOut,
  test,
} from './fixtures.ts';

test.describe('sign-in (ID-2)', () => {
  test('an anonymous visitor is sent to sign-in, which is accessible and shows the AGPL notice', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
    await expect(
      page.getByText('Forgot your password? Ask an instance admin to reset it.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Source code' })).toHaveAttribute(
      'href',
      /^https?:\/\//,
    );
    await expectAccessible(page);
  });

  test('NF-A1: sign-in works with the keyboard alone, starting from the skip link', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/sign-in');
    // Fields stay disabled until the page has hydrated (ADR 0044), and a disabled field is
    // skipped by Tab; a keyboard user starts once the page is ready, and so does this test.
    await expect(page.getByLabel('Email')).toBeEnabled();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    // Identity providers come first when there are any, which another test may add meanwhile.
    for (
      let i = 0;
      i < 4 && !(await page.getByLabel('Email').evaluate((e) => e === document.activeElement));
      i++
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(page.getByLabel('Email')).toBeFocused();
    await page.keyboard.type(accounts.member.email);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type(accounts.member.password);
    await awaitSignInSlot();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('button', { name: accountName(accounts.member.name) }),
    ).toBeVisible();
  });

  test('a wrong password shows an error and stays on sign-in', async ({ page, errors }) => {
    void errors;
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(accounts.member.email);
    await page.getByLabel('Password').fill('definitely not the password');
    await awaitSignInSlot();
    await page.getByRole('button', { name: 'Sign in' }).click();
    // One alert that never says which was wrong; the email stays and focus goes to Password.
    await expect(page.getByText('The email or password is wrong.')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue(accounts.member.email);
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await expectAccessible(page);
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('signing out ends the session', async ({ page, errors }) => {
    void errors;
    await signIn(page, accounts.member);
    await signOut(page, accounts.member);
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe('workspaces, members and keys (ID-3, ID-4, ID-5)', () => {
  test.use({ storageState: sessions.admin });

  test('ID-3: an instance admin creates and renames a workspace, adds nobody by id, and manages keys', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/admin/workspaces');
    await expect(page.getByRole('heading', { name: 'Workspaces', level: 1 })).toBeVisible();
    await expect(mainMenu(page).getByRole('link', { name: 'Workspaces' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectAccessible(page);

    // Create workspace opens a dialog with focus on Name; an empty name is refused there.
    const name = `E2E ${accounts.tag}`;
    await page.getByRole('button', { name: 'Create workspace' }).click();
    const create = page.getByRole('dialog', { name: 'Create a workspace' });
    await expect(create.getByLabel('Name', { exact: true })).toBeFocused();
    // The trigger, not the hidden native select react-aria keeps for forms.
    await expect(create.getByRole('button', { name: /First admin$/ })).toContainText(
      `${accounts.admin.name} (you)`,
    );
    await expectAccessible(page);
    await create.getByRole('button', { name: 'Create workspace' }).click();
    await expect(create.getByText('Give the workspace a name.')).toBeVisible();
    await create.getByLabel('Name', { exact: true }).fill(`${name} draft`);
    await create.getByRole('button', { name: 'Create workspace' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `${name} draft was created.` }),
    ).toBeVisible();

    // Rename names the workspace, and the table shows the new name.
    await page.getByRole('button', { name: `Rename ${name} draft` }).click();
    const rename = page.getByRole('dialog', { name: `Rename ${name} draft` });
    await expect(rename.getByLabel('Name', { exact: true })).toBeFocused();
    await rename.getByLabel('Name', { exact: true }).fill(name);
    await rename.getByRole('button', { name: 'Save name' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `${name} draft is now called ${name}.` }),
    ).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toContainText(accounts.admin.name);
    await expect(row).toContainText('$0.00');
    await page.getByRole('link', { name, exact: true }).click();

    await expectWorkspaceSettings(page, name);
    await expect(page.getByRole('row').filter({ hasText: accounts.admin.email })).toContainText(
      'Admin',
    );
    await expectAccessible(page);

    await page.getByLabel('New key name').fill('Nightly report');
    await page.getByRole('button', { name: 'Create key' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Copy the new API key' });
    const secret = await dialog.getByLabel('API key').inputValue();
    expect(secret).toMatch(/^lk_[A-Za-z0-9_-]{43}$/);
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'I have saved it' }).click();
    await expect(dialog).toBeHidden();

    // The secret is never shown again; only its prefix is listed.
    await expect(page.getByText(secret)).toHaveCount(0);
    const keyRow = page.getByRole('row', { name: /Nightly report/ });
    await expect(keyRow).toContainText(secret.slice(0, 11));
    await expect(keyRow).toContainText('Never');

    // The key works against the API until it is revoked, after a plain confirm.
    const bearer = { headers: { authorization: `Bearer ${secret}` } };
    expect((await page.request.get('/api/me', bearer)).status()).toBe(200);
    await keyRow.getByRole('button', { name: 'Revoke key Nightly report' }).click();
    await page
      .getByRole('alertdialog', { name: 'Revoke the key Nightly report?' })
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(keyRow).toHaveCount(0);
    expect((await page.request.get('/api/me', bearer)).status()).toBe(401);
  });

  test('ID-8: an instance admin deletes a workspace by typing its name', async ({
    page,
    errors,
  }) => {
    void errors;
    const name = `Delete me ${accounts.tag}`;
    await createWorkspace(page, name);
    await page.goto('/admin/workspaces');

    const dialog = page.getByRole('alertdialog', { name: `Delete ${name}?` });
    await pressUntil(page.getByRole('button', { name: `Delete ${name}` }), dialog);
    await expect(dialog.getByText(`Deleting ${name} removes:`)).toBeVisible();
    await expect(dialog.getByText('Its 1 person keeps their account.')).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Delete workspace' });
    // Until the name matches, the button says why; Playwright, like a person, cannot use it.
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await expect(confirm).toHaveAccessibleDescription('The name does not match yet.');
    await expectAccessible(page);
    await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
    await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
    await confirm.click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('status').filter({ hasText: `${name} was deleted.` }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
    // The row is gone, so focus is on the table.
    await expect(page.getByRole('region', { name: /^Workspaces on this server/ })).toBeFocused();
  });

  test('a member sees no admin pages', async ({ browser, errors }) => {
    void errors;
    const context = await browser.newContext({ storageState: sessions.member });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'People and sign-in' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Models and providers' })).toHaveCount(0);
    // An admin address sends a member back to `/`, which opens their workspace.
    await page.goto('/admin/people');
    await expect(page).toHaveURL(/\/workspaces(\/|$)/);
    await expect(page.getByRole('heading', { name: 'People and sign-in', level: 1 })).toHaveCount(
      0,
    );
    // Prices decide what budgets are charged; only instance admins see them (PR-7).
    await page.goto('/admin/models');
    await expect(page).toHaveURL(/\/workspaces(\/|$)/);
    await expect(page.getByRole('heading', { name: 'Models and providers', level: 1 })).toHaveCount(
      0,
    );
    await context.close();
  });
});

test.describe('instance administration (ID-6, ID-2)', () => {
  test.use({ storageState: sessions.admin });

  test('ID-6: people: an admin finds someone, suspends and reactivates them, and cannot suspend themselves', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/');
    await page.getByRole('link', { name: 'People and sign-in' }).click();
    await expect(page.getByRole('heading', { name: 'People and sign-in', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'People', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectAccessible(page);

    // Your own row offers only Export data.
    // Typed before the page hydrates, the search would be reset; try until it holds.
    await expect(async () => {
      await page.getByLabel('Find a person').fill(accounts.admin.email);
      await expect(page.getByRole('row').filter({ hasText: accounts.admin.email })).toBeVisible({
        timeout: 1000,
      });
    }).toPass();
    const own = page.getByRole('row').filter({ hasText: accounts.admin.email });
    await expect(
      own.getByRole('link', { name: `Export data of ${accounts.admin.name}` }),
    ).toBeVisible();
    await expect(own.getByRole('button')).toHaveCount(0);
    await expect(own).toContainText('Password');
    await expect(own).toContainText('Today');

    await page.getByLabel('Find a person').fill(accounts.member.email.toUpperCase());
    await expect(page.getByText('1 person matches.')).toBeVisible();
    const member = page.getByRole('row').filter({ hasText: accounts.member.email });
    await member.getByRole('button', { name: `Suspend ${accounts.member.name}` }).click();
    await expect(member).toContainText('Suspended');
    await expect(
      page.getByText(`${accounts.member.name} is suspended and signed out everywhere.`),
    ).toBeVisible();
    await member.getByRole('button', { name: `Reactivate ${accounts.member.name}` }).click();
    await expect(member).toContainText('Active');
    await expectAccessible(page);
  });

  test('ID-2: sign-in providers: a provider that cannot be reached is reported, not added', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/');
    // Sign-in providers is the second tab of People and sign-in, nested under it, and the menu
    // item stays the current page on it (ADR 0100). The arrow keys move between the tabs, and
    // focus stays on the tab whose page opened.
    const menuItem = mainMenu(page).getByRole('link', { name: 'People and sign-in' });
    await menuItem.click();
    // The tablist is server-rendered, so it can take focus before the page hydrates, and an
    // arrow key pressed then does nothing. A keyboard user would press again; so does this test.
    await expect(async () => {
      if (!page.url().endsWith('/admin/people/sign-in')) {
        await page.getByRole('tab', { name: 'People', exact: true }).focus();
        await page.keyboard.press('ArrowRight');
      }
      await expect(page).toHaveURL(/\/admin\/people\/sign-in$/, { timeout: 1000 });
    }).toPass();
    await expect(page.getByRole('tab', { name: 'Sign-in providers' })).toBeFocused();
    await expect(page.getByRole('heading', { name: 'People and sign-in', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Sign-in providers' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(menuItem).toHaveAttribute('aria-current', 'page');
    await expectAccessible(page);

    // The new provider's form is in the address, so a reload keeps it open.
    await page.getByRole('button', { name: 'Add a provider' }).click();
    await expect(page).toHaveURL(/\/admin\/people\/sign-in\?new=true$/);
    await page.reload();
    const form = page.getByRole('region', { name: 'New provider' });
    await expect(page.getByRole('button', { name: 'Add a provider' })).toHaveCount(0);
    await form.getByLabel('Provider ID').fill('unreachable');
    await form.getByLabel('Display name').fill('Unreachable');
    await form.getByLabel('Issuer URL').fill('http://127.0.0.1:9/dex');
    await form.getByLabel('Client ID').fill('client');
    await form.getByLabel('Client secret').fill('secret');
    await form.getByRole('button', { name: 'Save provider' }).click();
    await expect(form.getByText(/The provider could not be added/)).toBeVisible();
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toHaveCount(0);
  });
});
