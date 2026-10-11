import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/*
 * The model picker lists only the rows in view, so each option tells screen readers where it
 * sits in the list (NF-A1). Filtered, that is its place among the matches, not in the catalogue.
 */

/** Each option as "name id position/size", its lines joined by spaces, in list order. */
const positions = (page: Page) =>
  page
    .getByRole('option')
    .evaluateAll((options) =>
      options.map(
        (o) =>
          `${(o as HTMLElement).innerText.trim().replaceAll(/\s*\n\s*/g, ' ')} ${o.getAttribute('aria-posinset')}/${o.getAttribute('aria-setsize')}`,
      ),
    );

test('NF-A1: a filtered model picker numbers its options among the matches', async ({ page }) => {
  await page.goto('/iframe.html?id=components-model-select--with-search&viewMode=story');
  await page.getByRole('button', { name: 'None Pinned model' }).focus();
  await page.keyboard.press('Enter');
  const find = page.getByRole('searchbox', { name: 'Find a model' });
  await expect(find).toBeFocused();
  await expect.poll(() => positions(page)).toContain('None 1/15');

  await find.fill('mistral');
  await expect
    .poll(() => positions(page))
    .toEqual(['Mistral Small mistral:mistral-small 1/2', 'Mistral Small ollama:mistral-small 2/2']);

  // A search matches an id as well as a name.
  await find.fill('gpt-5.4-n');
  await expect.poll(() => positions(page)).toEqual(['GPT-5.4 nano openai:gpt-5.4-nano 1/1']);

  // Closed and opened again, the list starts unfiltered.
  await page.mouse.click(5, 400);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'None Pinned model' }).press('Enter');
  await expect(find).toHaveValue('');
  await expect.poll(() => positions(page)).toContain('None 1/15');
});
