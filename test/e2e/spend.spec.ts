import { randomBytes } from 'node:crypto';
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
 * Spend and budgets in the browser (BG-1, BG-10, BG-11, F5, NF-A1, ADR 0055, ADR 0093): an
 * instance admin caps a workspace and a person, sets where alerts go and sees the signing secret
 * once, and reads the report over a chosen range; a member sees only their own part.
 */

const suffix = () => randomBytes(3).toString('hex');

test.describe('spend and budgets (BG-1, BG-10, BG-11)', () => {
  test.use({ storageState: sessions.admin });

  test('an instance admin caps a workspace and a person, sets an alert address, and reads the spend view', async ({
    page,
    browser,
    errors,
  }) => {
    void errors;
    const tag = suffix();
    const workspace = `Spend ${tag}`;
    await createWorkspace(page, workspace);
    const workspaceUrl = page.url();
    const workspaceId = workspaceUrl.split('/').at(-1) ?? '';

    // The member joins, so their view can be checked at the end.
    const origin = new URL(workspaceUrl).origin;
    const joined = await page.request.put(
      `/api/workspaces/${workspaceId}/members/${accounts.member.id}`,
      { headers: { origin }, data: { role: 'member' } },
    );
    expect(joined.status()).toBe(200);

    await mainMenu(page).getByRole('link', { name: 'Spend and budgets' }).click();
    await expect(page.getByRole('heading', { name: 'Spend and budgets', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No spend yet' })).toBeVisible();
    await expectAccessible(page);

    // BG-1: the workspace cap, with alerts at 75 and 90 percent.
    await page.getByRole('tab', { name: 'Budgets and alerts' }).click();
    await expect(page).toHaveURL(/\/spend\/budgets$/);
    const dialog = page.getByRole('dialog', { name: `Cap for the ${workspace} workspace` });
    // The tab's panel may still be settling after the navigation; open it once it has.
    await expect(page.getByRole('tabpanel', { name: 'Budgets and alerts' })).toBeVisible();
    await expect(async () => {
      if ((await dialog.count()) === 0) {
        await page.getByRole('button', { name: 'Set a workspace cap' }).click();
      }
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    await expect(dialog.getByLabel('Amount in US dollars')).toBeFocused();
    await dialog.getByLabel('Amount in US dollars').fill('50');
    await dialog.getByRole('button', { name: 'Remove 80%' }).click();
    await dialog.getByRole('button', { name: 'Remove 100%' }).click();
    // Alerts are picked from every 10 percent, or typed. The field's button is named by its value,
    // then its label; a pointer clicks the field around it, as with the model pickers.
    await expect(dialog.getByText('No alerts')).toBeVisible();
    await dialog
      .getByRole('button', { name: / Alert at$/ })
      .locator('..')
      .click();
    const findAlert = page.getByRole('searchbox', { name: 'Find or type a percentage' });
    await expect(findAlert).toBeFocused();
    await findAlert.fill('9');
    await page.getByRole('option', { name: '90%' }).click();
    await findAlert.fill('75');
    await page.getByRole('option', { name: '75%' }).click();
    // The api takes whole percentages from 1 to 100; the list says so rather than offer another.
    await findAlert.fill('500');
    await expect(page.getByText('Enter a whole percentage from 1 to 100.')).toBeVisible();
    await expectAccessible(page);
    // Esc first clears the search, then closes the list; the dialog stays.
    await findAlert.press('Escape');
    await expect(findAlert).toHaveValue('');
    await findAlert.press('Escape');
    await expect(findAlert).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('row')).toHaveText(['75%', '90%']);
    await dialog.getByRole('button', { name: 'Save cap' }).click();
    await expect(dialog).toHaveCount(0);
    const workspaceCap = page.getByRole('region', { name: 'Workspace cap' });
    await expect(workspaceCap).toContainText('$50.00 left');
    await expect(workspaceCap).toContainText('Alerts at 75% and 90%.');

    // A cap for a person.
    const people = page.getByRole('region', { name: 'Member caps' });
    await page.getByRole('button', { name: `Set a cap for ${accounts.member.name}` }).click();
    await page.getByRole('dialog').getByLabel('Amount in US dollars').fill('10.50');
    await page.getByRole('dialog').getByRole('button', { name: 'Save cap' }).click();
    await expect(people.getByRole('row').filter({ hasText: accounts.member.name })).toContainText(
      '$10.50',
    );

    // A mistyped amount is explained, not sent.
    await page.getByRole('button', { name: 'Edit workspace cap' }).click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel('Amount in US dollars').fill('ten dollars');
    await edit.getByRole('button', { name: 'Save cap' }).click();
    await expect(edit.getByText('Enter an amount in dollars, such as 25 or 0.50.')).toBeVisible();
    await edit.getByRole('button', { name: 'Cancel' }).click();

    // BG-10: the alert address; the signing secret is shown once.
    await page.getByLabel('Webhook address').fill('https://hooks.example.com/e2e');
    await page.getByRole('button', { name: 'Save address' }).click();
    const secretDialog = page.getByRole('alertdialog', { name: 'Copy the new signing secret' });
    await expect(secretDialog.getByLabel('Signing secret')).toHaveValue(/^whsec_/);
    const secret = await secretDialog.getByLabel('Signing secret').inputValue();
    await expectAccessible(page);
    await secretDialog.getByRole('button', { name: 'I have saved it' }).click();
    await expect(page.getByText('A secret is set')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Webhook address')).toHaveValue('https://hooks.example.com/e2e');
    expect(await page.content()).not.toContain(secret);
    // A new address keeps the secret, so no secret is shown.
    await page.getByLabel('Webhook address').fill('https://hooks.example.com/e2e-2');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('The address was saved.')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    // A workspace address must be public https.
    await page.getByLabel('Webhook address').fill('http://10.0.0.5/alerts');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText(/The address was not saved/)).toBeVisible();
    await expectAccessible(page);

    // BG-11: choosing a range.
    await page.getByRole('tab', { name: 'Report' }).click();
    const range = page.getByRole('group', { name: 'Dates' });
    await range.getByRole('button', { name: 'Last 7 days' }).click();
    await expect(range.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page).toHaveURL(/range=last-7-days/);
    const today = new Date().toISOString().slice(0, 10);
    await range.getByRole('button', { name: 'Custom' }).click();
    const custom = page.getByRole('dialog', { name: 'Choose the dates' });
    await custom.getByLabel('From').fill(today);
    await custom.getByLabel('To').fill(today);
    await custom.getByRole('button', { name: 'Show these dates' }).click();
    await expect(page).toHaveURL(new RegExp(`from=${today}&to=${today}`));
    await expect(
      page.getByRole('heading', { name: 'Nothing was spent on these dates' }),
    ).toBeVisible();
    await expectAccessible(page);

    // F5: the member sees only their own caps and spend, and no budgets or alert settings.
    // A fresh sign-in: an earlier test suspends this account, which ends its saved session (ID-6).
    const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const memberPage = await memberContext.newPage();
    const memberErrors: string[] = [];
    watchErrors(memberPage, memberErrors);
    await signIn(memberPage, accounts.member);
    await memberPage.goto(`${workspaceUrl}/spend`);
    await expect(memberPage.getByRole('heading', { name: 'Your spend', level: 1 })).toBeVisible();
    const mine = memberPage.getByRole('region', { name: 'Caps that apply to you' });
    await expect(mine.getByRole('region', { name: 'Your cap' })).toContainText('$10.50 left');
    await expect(mine.getByRole('region', { name: 'Workspace cap' })).toContainText('$50.00 left');
    await expect(memberPage.getByRole('tab', { name: 'Budgets and alerts' })).toHaveCount(0);
    await expect(memberPage.getByRole('button', { name: /Edit cap for/ })).toHaveCount(0);
    await expectAccessible(memberPage);
    await memberPage.goto(`${workspaceUrl}/spend/budgets`);
    await expect(memberPage).toHaveURL(/\/spend$/);
    expect(memberErrors).toEqual([]);
    await memberContext.close();

    // Removing a cap asks first; so does stopping alerts.
    await page.getByRole('tab', { name: 'Budgets and alerts' }).click();
    await page.getByRole('button', { name: `Edit cap for ${accounts.member.name}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove cap' }).click();
    const confirm = page.getByRole('alertdialog', {
      name: `Remove the cap for ${accounts.member.name}?`,
    });
    await expectAccessible(page);
    await confirm.getByRole('button', { name: 'Remove cap' }).click();
    await expect(people.getByRole('row').filter({ hasText: accounts.member.name })).toContainText(
      'No cap',
    );
    await page.getByRole('button', { name: 'Stop sending alerts' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Stop sending alerts' })
      .click();
    await expect(page.getByText('No secret yet')).toBeVisible();
  });

  test('BG-1, BG-11: an instance admin sets and removes the instance cap, and reads spend by workspace', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/');
    await page.getByRole('link', { name: 'Instance spend', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Instance spend', level: 1 })).toBeVisible();
    await expectAccessible(page);

    const card = page.getByRole('region', { name: /instance cap/i }).first();
    const set = page.getByRole('button', { name: /^(Set an|Edit) instance cap$/ });
    await set.click();
    const dialog = page.getByRole('dialog', { name: 'Instance cap' });
    await dialog.getByLabel('Amount in US dollars').fill('1000');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Save cap' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText('of $1,000.00');

    // Spend so far this month, by workspace first, with each workspace's own cap.
    const breakdown = page.getByRole('region', { name: 'Where the money went' });
    if ((await breakdown.count()) > 0) {
      await expect(breakdown.getByRole('tab', { name: 'By workspace' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(breakdown.getByRole('columnheader', { name: 'Its cap' })).toBeVisible();
    }
    await page.getByRole('link', { name: 'Open the full report' }).click();
    await expect(page.getByRole('heading', { name: 'Instance report', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Last 7 days' })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('link', { name: 'Instance spend' }).first().click();

    await page.getByRole('button', { name: 'Edit instance cap' }).click();
    await page
      .getByRole('dialog', { name: 'Instance cap' })
      .getByRole('button', { name: 'Remove cap' })
      .click();
    await page
      .getByRole('alertdialog', { name: 'Remove the instance cap?' })
      .getByRole('button', { name: 'Remove cap' })
      .click();
    await expect(page.getByRole('heading', { name: 'No instance cap' })).toBeVisible();
  });
});
