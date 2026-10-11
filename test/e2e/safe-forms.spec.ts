import { expect, test } from './fixtures.ts';

/*
 * Forms before hydration (invariant 9, NF-S5, ADR 0044). With no JavaScript running, as in the
 * moment before a page hydrates, nothing can be typed into a form or submitted from it: typed
 * text would either leak into a URL or be wiped when React takes over.
 */

test.describe('forms before hydration', () => {
  test.use({ javaScriptEnabled: false });

  test('NF-S5: sign-in posts, and takes no input and no submission until the page has hydrated', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const form = page.locator('form');
    await expect(form).toHaveAttribute('method', 'post');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await expect(page.getByLabel('Email')).toBeDisabled();
    await expect(page.getByLabel('Password')).toBeDisabled();
    // Nothing typed, nothing sent: pressing Enter on the page leaves the URL as it was.
    await page.keyboard.type('typed before hydration');
    await page.keyboard.press('Enter');
    await page.waitForLoadState();
    expect(page.url()).not.toContain('typed');
    expect(page.url()).not.toContain('?');
  });

  // The client secret form on Sign-in providers is checked in sign-in-providers.spec.ts. Other
  // admin forms with a credential open in a dialog, which needs JavaScript to open at all.
});
