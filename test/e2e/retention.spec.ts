import { expect, expectAccessible, sessions, test } from './fixtures.ts';

/*
 * Retention in the browser (OB-6, NF-P5, ADR 0078): an instance admin sees the documented
 * defaults, changes a period, and runs retention at once, seeing what it deleted.
 */

test.describe('retention (OB-6, NF-P5)', () => {
  test.use({ storageState: sessions.admin });

  test('an instance admin sees the defaults, changes a period, and runs it now', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/');
    await page.getByRole('link', { name: 'Retention', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Retention', level: 1 })).toBeVisible();
    await expect(page.getByText(/at 03:17 UTC/)).toBeVisible();
    const traces = page.getByRole('textbox', { name: 'Request traces' });
    await expect(traces).toHaveValue(/^\d+$/);
    // ADR 0078: usage is kept in months.
    await expect(page.getByRole('textbox', { name: 'Usage records' })).toHaveAccessibleDescription(
      /months/,
    );
    // Conversations are kept until people delete them, unless a period is entered.
    await expect(page.getByRole('textbox', { name: 'Conversations' })).toHaveValue('');
    await expect(page.getByText('Set per workspace')).toBeVisible();
    // NF-P1: in a default install, traces stay on the server, and the page says so.
    await expect(
      page.getByText('Traces stay on this server. Nothing is sent anywhere.'),
    ).toBeVisible();
    await expectAccessible(page);

    // Checked on Save, and focus goes to the field with a problem.
    await traces.fill('0');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(traces).toBeFocused();
    await expect(traces).toHaveAccessibleDescription(/From 1 to 365/);
    await traces.fill('45');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await expect(page.getByText(/^Last changed by E2E Admin on /)).toBeVisible();
    await page.reload();
    await expect(traces).toHaveValue('45');
    // Back to the default, so other runs of the suite see it.
    await traces.fill('30');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();

    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByText(/^Done\. \d[\d,]* records? (was|were) removed\.$/)).toBeVisible();
    await expect(page.getByText(/^Today at \d\d:\d\d UTC\. Took /)).toBeVisible();
    await expect(
      page
        .getByRole('grid', { name: 'Last run' })
        .getByRole('rowheader', { name: 'Request traces' }),
    ).toBeVisible();
    await expectAccessible(page);
  });
});
