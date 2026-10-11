import { randomBytes } from 'node:crypto';
import { createWorkspace, expect, expectAccessible, sessions, test } from './fixtures.ts';

/*
 * Model provider keys in the browser (PR-1, PR-3, PR-8). No test calls a real provider: the
 * endpoint that gets checked is the api itself, inside the compose network.
 */

const suffix = () => randomBytes(3).toString('hex');

test.describe('model providers (PR-1, PR-8)', () => {
  test.use({ storageState: sessions.admin });

  test('an instance admin adds, checks and removes an OpenAI-compatible endpoint', async ({
    page,
    errors,
  }) => {
    void errors;
    const name = `local-${suffix()}`;
    const key = `sk-e2e-${suffix()}${suffix()}`;
    await page.goto('/');
    await page.getByRole('link', { name: 'Models and providers' }).click();
    await page.getByRole('tab', { name: 'Model providers' }).click();
    await expect(page).toHaveURL(/\/admin\/models\/providers$/);
    await expect(
      page.getByRole('heading', { name: 'Models and providers', level: 1 }),
    ).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Add a provider' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a provider' });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Address').fill('http://api:3000/v1');
    await dialog.getByLabel('API key, if it needs one').fill(key);
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Save and check' }).click();
    await expect(dialog).toHaveCount(0);

    // Save and check checks at once. The address is the api's own OpenAI-compatible endpoint,
    // which refuses this made-up key; the check reports that instead of failing silently.
    const shown = name.slice(0, 1).toUpperCase() + name.slice(1);
    const row = page.getByRole('row').filter({ hasText: shown });
    await expect(row).toContainText('Key refused');
    await expect(
      page.getByRole('status').filter({ hasText: `${shown}: Key refused.` }),
    ).toBeVisible();
    await row.getByRole('button', { name: `Check ${shown}` }).click();
    await expect(row).toContainText('Key refused');
    await expectAccessible(page);

    // PR-3: the key is never shown again, not even after a reload.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Model providers' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await page.content()).not.toContain(key);

    await row.getByRole('button', { name: `Remove ${shown}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
  });

  test('a workspace admin adds the workspace its own key, for a first-party provider only', async ({
    page,
    errors,
  }) => {
    void errors;
    const workspace = `Keys ${suffix()}`;
    const key = `sk-ant-e2e-${suffix()}${suffix()}`;
    await createWorkspace(page, workspace);

    const section = page.getByRole('region', { name: 'Model providers', exact: true });
    await expect(section).toBeVisible();
    // One row per first-party provider; workspaces cannot point the server at an address of
    // their choosing (ADR 0038).
    await expect(section.getByText('OpenAI-compatible server')).toHaveCount(0);
    const row = section.getByRole('row', { name: /^Anthropic/ });
    await section.getByRole('button', { name: 'Add a workspace key for Anthropic' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workspace key for Anthropic' });
    await dialog.getByLabel('API key').fill(key);
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Save key' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('Workspace key set');
    await expect(row).toContainText('Not checked yet');
    await expectAccessible(page);
    expect(await page.content()).not.toContain(key);

    // Removing it asks first, and says what requests fall back to.
    await section.getByRole('button', { name: 'Remove the Anthropic workspace key' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Remove the Anthropic workspace key?' });
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await expect(row).not.toContainText('Workspace key set');
  });
});
