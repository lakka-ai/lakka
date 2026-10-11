import { randomBytes } from 'node:crypto';
import { E2E_KEYCLOAK_URL, KEYCLOAK_REALM } from '../integration/keycloak.ts';
import { expect, expectAccessible, pressUntil, sessions, test } from './fixtures.ts';

/*
 * Sign-in providers in the browser (ID-2, AD-1, NF-S5, ADR 0032, ADR 0097), against the stack's
 * own Keycloak. An admin adds one, reads the redirect URI to register, edits what may change,
 * and removes it again. Before the page hydrates, the form that holds the client secret takes no
 * input and cannot be sent (ADR 0044).
 */

const ISSUER = `${E2E_KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;
const suffix = () => randomBytes(3).toString('hex');

test.describe('sign-in providers (ID-2)', () => {
  test.use({ storageState: sessions.admin });

  test('ID-2: an admin adds a provider, edits it, and removes it', async ({ page, errors }) => {
    void errors;
    const id = `kc-${suffix()}`;
    const secret = `e2e-secret-${suffix()}${suffix()}`;
    await page.goto('/admin/people/sign-in');
    const added = page.getByRole('region', { name: 'New provider' });
    await pressUntil(page.getByRole('button', { name: 'Add a provider' }), added);
    await added.getByLabel('Provider ID').fill(id);
    await added.getByLabel('Display name').fill(`Keycloak ${id}`);
    await added.getByLabel('Issuer URL').fill(ISSUER);
    await added.getByLabel('Client ID').fill('lakka-e2e');
    await added.getByLabel('Client secret').fill(secret);
    await added.getByRole('button', { name: 'Save provider' }).click();
    await expect(page.getByText(`Keycloak ${id} was saved.`)).toBeVisible();

    const form = page.getByRole('region', { name: `Keycloak ${id}` });
    await expect(form).toContainText('Not used yet');
    await expect(form.getByLabel('Client ID')).toHaveValue('lakka-e2e');
    // Fixed once added, since they decide who a sign-in is.
    await expect(form.getByLabel('Provider ID')).toHaveAttribute('readonly', '');
    await expect(form.getByLabel('Issuer URL')).toHaveAttribute('readonly', '');
    const redirect = form.getByLabel('Redirect URI');
    await expect(redirect).toHaveValue(new RegExp(`/api/auth/sso/callback/${id}$`));
    await expectAccessible(page);

    // PR-3, NF-S5: the secret is never shown again.
    await page.reload();
    expect(await page.content()).not.toContain(secret);

    await form.getByLabel('Display name').fill(`Company ${id}`);
    // Allowed domains are typed into the field's list; one is kept in lower case. The field's
    // button is named by its value, then its label; a pointer clicks the field around it.
    await expect(form.getByText('Any domain', { exact: true })).toBeVisible();
    await form
      .getByRole('button', { name: / Allowed email domains$/ })
      .locator('..')
      .click();
    const typeDomain = page.getByRole('searchbox', { name: 'Type a domain' });
    await expect(typeDomain).toBeFocused();
    await expect(page.getByText('Type a domain, such as example.com.')).toBeVisible();
    await typeDomain.fill('Example.COM');
    await typeDomain.press('Enter');
    // Picked, the search is clear for the next one.
    await expect(typeDomain).toHaveValue('');
    await typeDomain.fill('not a domain');
    await expect(page.getByText('Enter a domain such as example.com.')).toBeVisible();
    await expectAccessible(page);
    await typeDomain.press('Escape');
    await typeDomain.press('Escape');
    await expect(typeDomain).toHaveCount(0);
    await expect(form.getByRole('row')).toHaveText(['example.com']);
    await form.getByText('Let this provider create new accounts').click();
    await form.getByRole('button', { name: 'Save provider' }).click();
    await expect(page.getByText(`Company ${id} was saved.`)).toBeVisible();
    const renamed = page.getByRole('region', { name: `Company ${id}` });
    await page.reload();
    await expect(renamed.getByRole('checkbox', { name: /create new accounts/ })).toBeChecked();
    await expect(renamed.getByRole('row')).toHaveText(['example.com']);

    // The sign-in page offers it by its new name.
    const offered = await page.request.get('/api/sso/providers/public');
    expect(JSON.stringify(await offered.json())).toContain(`Company ${id}`);

    await renamed.getByRole('button', { name: 'Remove provider' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Remove Company ${id}?` });
    await expect(confirm).toContainText('Nobody has signed in with it yet.');
    await expectAccessible(page);
    await confirm.getByRole('button', { name: 'Remove provider' }).click();
    await expect(page.getByText(`Company ${id} was removed.`)).toBeVisible();
    await expect(renamed).toHaveCount(0);
  });
});

test.describe('sign-in providers before hydration (NF-S5)', () => {
  test.use({ storageState: sessions.admin, javaScriptEnabled: false });

  test('NF-S5: the form with the client secret posts, and takes no input until the page has hydrated', async ({
    page,
  }) => {
    const id = `kc-${suffix()}`;
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const made = await page.request.post('/api/sso/providers', {
      headers: { origin },
      data: {
        providerId: id,
        displayName: `Keycloak ${id}`,
        issuer: ISSUER,
        clientId: 'lakka-e2e',
        clientSecret: `e2e-secret-${suffix()}`,
      },
    });
    expect(made.status()).toBe(201);
    try {
      await page.goto('/admin/people/sign-in');
      const form = page.locator('form', { has: page.getByLabel('Client secret') });
      await expect(form).toHaveAttribute('method', 'post');
      await expect(form.getByRole('button', { name: 'Save provider' })).toBeDisabled();
      await expect(form.getByLabel('Client secret')).toBeDisabled();
    } finally {
      await page.request.delete(`/api/sso/providers/${id}`, { headers: { origin } });
    }
  });
});
