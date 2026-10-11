import { randomBytes } from 'node:crypto';
import { expect, expectAccessible, sessions, test } from './fixtures.ts';

/* The model catalogue and custom models in the browser (PR-5, PR-7). */

test.describe('models (PR-5, PR-7)', () => {
  test.use({ storageState: sessions.admin });

  test('an instance admin browses catalogue prices and adds a model by hand', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/');
    await page.getByRole('link', { name: 'Models and providers' }).click();
    await expect(
      page.getByRole('heading', { name: 'Models and providers', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Models', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectAccessible(page);

    // The bundled catalogue, with exact prices.
    await page.getByLabel('Find a model').fill('claude-sonnet-4-5');
    const sonnet = page
      .getByRole('grid', { name: 'Catalogue' })
      .getByRole('row')
      .filter({ hasText: 'anthropic:claude-sonnet-4-5' })
      .first();
    await expect(sonnet).toContainText('$3.00');
    await expect(sonnet).toContainText('$15.00');
    await expect(sonnet).toContainText('Images, PDFs');

    // A long-context tier. Sonnet 4.5 lost its own when Anthropic retired the 1M-context beta.
    await page.getByLabel('Find a model').fill('gemini-2.5-pro');
    const gemini = page
      .getByRole('grid', { name: 'Catalogue' })
      .getByRole('row')
      .filter({ hasText: 'google:gemini-2.5-pro' })
      .first();
    await expect(gemini).toContainText('$1.25');
    await expect(gemini).toContainText('$2.50 above 200,000 input tokens');

    const model = `llama-${randomBytes(3).toString('hex')}:70b`;
    await page.getByRole('button', { name: 'Add a model' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a model' });
    await expect(dialog.getByLabel('Model name')).toBeFocused();
    // Checked on submit, and focus goes to the first field with a problem.
    await dialog.getByLabel('Model name').fill('no colon');
    await dialog.getByRole('button', { name: 'Add model' }).click();
    await expect(dialog.getByLabel('Model name')).toBeFocused();
    await expect(dialog.getByText(/Write the provider, a colon/)).toBeVisible();
    await dialog.getByLabel('Model name').fill(`ollama:${model}`);
    await dialog.getByLabel('Context window').fill('131072');
    await dialog.getByLabel('Output limit').fill('8192');
    await dialog.getByLabel(/^Input price/).fill('0');
    await dialog.getByLabel(/^Output price/).fill('0.075');
    await expect(dialog.getByRole('checkbox', { name: /It can call tools/ })).toBeChecked();
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Add model' }).click();
    await expect(dialog).toHaveCount(0);
    const row = page
      .getByRole('grid', { name: 'Models you added' })
      .getByRole('row')
      .filter({ hasText: `ollama:${model}` });
    await expect(row).toContainText('$0.075');
    await expect(row).toContainText('Text');
    await expectAccessible(page);

    // Edit keeps the name, which routes point to.
    await row.getByRole('button', { name: /^Edit / }).click();
    const edit = page.getByRole('dialog', { name: /^Edit / });
    await expect(edit.getByLabel('Model name')).toHaveAttribute('readonly', '');
    await edit.getByLabel(/^Output price/).fill('0.1');
    await edit.getByRole('button', { name: 'Save model' }).click();
    await expect(edit).toHaveCount(0);
    await expect(row).toContainText('$0.10');

    await row.getByRole('button', { name: /^Remove / }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
  });
});
