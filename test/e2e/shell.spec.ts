import type { Page } from '@playwright/test';
import {
  accountName,
  accounts,
  expect,
  expectAccessible,
  mainMenu,
  pressUntil,
  sessions,
  test,
} from './fixtures.ts';

/*
 * The app shell (docs/design/docs/screens.md, App shell; docs/design/docs/phone.md): the side
 * menu from 1024px and its collapsed rail, the phone top bar and drawer below it, and the AGPL
 * notice in the account menu on every page (ADR 0107).
 */

const phone = { width: 390, height: 844 };

async function noSidewaysScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(clientWidth);
}

/** Opens a workspace the admin belongs to, creating one for this run. */
async function adminWorkspace(page: Page): Promise<string> {
  await page.goto('/workspaces');
  const origin = new URL(page.url()).origin;
  const slug = `shell-${accounts.tag}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post('/api/workspaces', {
    headers: { origin },
    data: { name: `Shell ${slug}`, slug },
  });
  expect(response.status()).toBe(201);
  const { workspace } = (await response.json()) as { workspace: { id: string } };
  return workspace.id;
}

test.describe('app shell, desktop', () => {
  test.use({ storageState: sessions.admin });

  test('NF-A1: one main menu marks the current page', async ({ page, errors }) => {
    void errors;
    const id = await adminWorkspace(page);
    await page.goto(`/workspaces/${id}/requests`);

    const menu = mainMenu(page);
    await expect(menu).toHaveCount(1);
    await expect(menu.getByRole('link', { name: 'Requests' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
    // Chat comes first, then the workspace pages, then the Admin group.
    const names = await menu.getByRole('link').allTextContents();
    expect(names.slice(0, 2)).toEqual(['Chat', 'Spend and budgets']);
    await expect(menu.getByRole('heading', { name: 'Admin' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'People and sign-in' })).toBeVisible();
    // The source offer moved to the account menu; signed-in pages have no footer.
    await expect(page.getByRole('contentinfo')).toHaveCount(0);
    await expectAccessible(page);
  });

  test('AD-6: the account menu links to the source, with the sentence that says why', async ({
    page,
    errors,
  }) => {
    void errors;
    const id = await adminWorkspace(page);
    await page.goto(`/workspaces/${id}/requests`);
    const source = page.getByRole('menuitem', { name: 'Source code' });
    await pressUntil(page.getByRole('button', { name: accountName(accounts.admin.name) }), source);
    await expect(source).toHaveAttribute('href', /^https?:\/\//);
    await expect(source).toHaveAccessibleDescription('Lakka is free software under the AGPL.');
    await expectAccessible(page);
    await page.keyboard.press('Escape');

    // Collapsed, the avatar alone still opens it.
    await page.getByRole('button', { name: 'Collapse menu' }).click();
    await page.getByRole('button', { name: accountName(accounts.admin.name) }).click();
    await expect(page.getByRole('menuitem', { name: 'Source code' })).toBeVisible();
  });

  test('NF-A1: the menu collapses to a rail of named icons, and nothing moves up or down', async ({
    page,
    errors,
  }) => {
    void errors;
    const id = await adminWorkspace(page);
    await page.goto(`/workspaces/${id}/requests`);
    const menu = mainMenu(page);
    const tops = () =>
      page.locator('#main-menu').evaluate((column) =>
        [...column.querySelectorAll('nav a, nav h2, button')]
          .filter((e) => e instanceof HTMLElement && e.offsetParent !== null)
          .map((e) => {
            const box = e.getBoundingClientRect();
            return [box.top, box.height];
          }),
      );
    const before = await tops();

    const collapse = page.getByRole('button', { name: 'Collapse menu' });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await expect(collapse).toHaveAttribute('aria-controls', 'main-menu');
    await collapse.click();

    // Focus stays on the button that took its place.
    const expand = page.getByRole('button', { name: 'Expand menu' });
    await expect(expand).toBeFocused();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    // 64px inside the border, so every item keeps 12px to either side, as in the full menu.
    const sides = await page.locator('#main-menu').evaluate((column) => {
      const edges = column.getBoundingClientRect();
      return [...column.querySelectorAll('nav a, button')]
        .filter((e) => e instanceof HTMLElement && e.offsetParent !== null)
        .map((e) => {
          const box = e.getBoundingClientRect();
          return [box.left - edges.left, edges.right - 1 - box.right];
        });
    });
    for (const side of sides) expect(side).toEqual([12, 12]);
    expect(await tops()).toEqual(before);

    // Every item keeps its name, and the current one stays marked.
    const requests = menu.getByRole('link', { name: 'Requests' });
    await expect(requests).toHaveAttribute('aria-current', 'page');
    await expect(requests).not.toContainText('Requests');
    await expect(menu.getByRole('heading', { name: 'Admin' })).toBeVisible();
    // The name shows beside the icon on hover and on keyboard focus. One that is fading out
    // can still be in the page, so each is found by its text.
    const tooltip = (name: string) => page.getByRole('tooltip').filter({ hasText: name });
    await menu.getByRole('link', { name: 'Routing' }).hover();
    await expect(tooltip('Routing')).toBeVisible();
    await page.mouse.move(800, 400);
    await expect(tooltip('Routing')).toBeHidden();
    await expand.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('link', { name: 'Chat' })).toBeFocused();
    await expect(tooltip('Chat')).toBeVisible();

    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'light' });

    await expand.click();
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeFocused();
    expect(await tops()).toEqual(before);
  });

  test('the collapsed menu is remembered in this browser, on every page and after a reload', async ({
    page,
    errors,
  }) => {
    void errors;
    const id = await adminWorkspace(page);
    await page.goto(`/workspaces/${id}/spend`);
    await pressUntil(
      page.getByRole('button', { name: 'Collapse menu' }),
      page.getByRole('button', { name: 'Expand menu' }),
    );
    await expect
      .poll(async () => (await page.context().cookies()).find((c) => c.name === 'lk_nav')?.value)
      .toBe('rail');

    // The server draws the rail, so the page never paints wide first.
    const html = await (await page.request.get('/admin/people')).text();
    expect(html).toContain('aria-label="Expand menu"');
    expect(html).not.toContain('aria-label="Collapse menu"');
    for (const path of ['/admin/people', `/workspaces/${id}/routing`]) {
      await page.goto(path);
      await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
    }

    await pressUntil(
      page.getByRole('button', { name: 'Expand menu' }),
      page.getByRole('button', { name: 'Collapse menu' }),
    );
    await expect
      .poll(async () => (await page.context().cookies()).some((c) => c.name === 'lk_nav'))
      .toBe(false);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
  });

  test('`/` opens chat in the workspace used last', async ({ page, errors }) => {
    void errors;
    const id = await adminWorkspace(page);
    await page.goto(`/workspaces/${id}`);
    // The page remembers the workspace once it is running in the browser.
    await expect
      .poll(
        async () => (await page.context().cookies()).find((c) => c.name === 'lk_workspace')?.value,
      )
      .toBe(id);
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/workspaces/${id}/chat`));
    await expect(mainMenu(page).getByRole('link', { name: 'Chat' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the workspace switcher names the workspace and role, and lists the others', async ({
    page,
    errors,
  }) => {
    void errors;
    const id = await adminWorkspace(page);
    await page.goto(`/workspaces/${id}/spend`);
    const switcher = page.getByRole('button', {
      name: /^Shell .*, Admin\. Switch workspace$/,
    });
    const menu = page.getByRole('menu', { name: 'Switch workspace' });
    await pressUntil(switcher, menu);
    await expect(menu.getByRole('menuitemradio', { checked: true })).toContainText('Shell');
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(switcher).toBeFocused();

    await switcher.click();
    await menu.getByRole('menuitem', { name: 'All workspaces' }).click();
    await expect(page.getByRole('heading', { name: 'Workspaces', level: 1 })).toBeVisible();
  });

  test('NF-A1: dark mode follows the system setting and stays accessible', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.emulateMedia({ colorScheme: 'dark' });
    const id = await adminWorkspace(page);
    await page.goto(`/workspaces/${id}`);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await expectAccessible(page);
  });

  test('the account menu signs out', async ({ browser, errors }) => {
    void errors;
    // A fresh copy of the admin session, so signing out here leaves the saved one alone.
    const context = await browser.newContext({ storageState: sessions.admin });
    const page = await context.newPage();
    await page.goto('/workspaces');
    await pressUntil(
      page.getByRole('button', { name: accountName(accounts.admin.name) }),
      page.getByRole('menuitem', { name: 'Sign out' }),
    );
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await context.close();
  });
});

test.describe('app shell, phone', () => {
  test.use({ storageState: sessions.admin, viewport: phone });

  test('NF-A1: at 390px the page does not scroll sideways', async ({ page, errors }) => {
    void errors;
    const id = await adminWorkspace(page);
    // The spend pages' date pills scroll in their own row rather than widen the page.
    for (const path of [
      '/workspaces',
      `/workspaces/${id}`,
      `/workspaces/${id}/spend`,
      '/admin/spend/report',
      '/admin/people',
    ]) {
      await page.goto(path);
      await noSidewaysScroll(page);
    }
    await expect(page.getByRole('banner')).toContainText('People and sign-in');
    await expect(mainMenu(page)).toHaveCount(0);
    await expectAccessible(page);
  });

  test('CH-1: in chat, the drawer lists the conversations right under Chat', async ({
    page,
    errors,
  }) => {
    void errors;
    const id = await adminWorkspace(page);
    await page.goto(`/workspaces/${id}/chat`);
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await pressUntil(page.getByRole('button', { name: 'Menu', exact: true }), drawer);
    const top = async (name: string, role: 'link' | 'button') => {
      const box = await drawer.getByRole(role, { name, exact: true }).boundingBox();
      if (box === null) throw new Error(`${name} is not shown`);
      return box.y;
    };
    const conversations = drawer.getByRole('navigation', { name: 'Conversations' });
    await expect(conversations).toBeVisible();
    // ADR 0110: Chat, then its conversations, then the other pages.
    const chat = await top('Chat', 'link');
    const newConversation = await top('New conversation', 'link');
    const spend = await top('Spend and budgets', 'link');
    expect(chat).toBeLessThan(newConversation);
    expect(newConversation).toBeLessThan(spend);
    await expectAccessible(page);
  });

  test('AD-6: the drawer offers the source through the account menu', async ({ page, errors }) => {
    void errors;
    await adminWorkspace(page);
    await page.goto('/admin/people');
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await pressUntil(page.getByRole('button', { name: 'Menu', exact: true }), drawer);
    await drawer.getByRole('button', { name: accountName(accounts.admin.name) }).click();
    const source = page.getByRole('menuitem', { name: 'Source code' });
    await expect(source).toHaveAttribute('href', /^https?:\/\//);
    await expect(source).toHaveAccessibleDescription('Lakka is free software under the AGPL.');
    await expectAccessible(page);
  });

  test('the collapsed menu does not reach the phone layout', async ({ page, errors }) => {
    void errors;
    await adminWorkspace(page);
    const { origin } = new URL(page.url());
    await page.context().addCookies([{ name: 'lk_nav', value: 'rail', url: origin }]);
    await page.goto('/admin/people');
    await expect(page.getByRole('button', { name: 'Expand menu' })).toBeHidden();
    await pressUntil(
      page.getByRole('button', { name: 'Menu', exact: true }),
      page.getByRole('dialog', { name: 'Menu' }),
    );
    await expect(
      page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'People and sign-in' }),
    ).toContainText('People and sign-in');
  });

  test('NF-A1: the menu drawer is modal, closes on Esc and returns focus to Menu', async ({
    page,
    errors,
  }) => {
    void errors;
    await adminWorkspace(page);
    await page.goto('/admin/people');
    const menuButton = page.getByRole('button', { name: 'Menu', exact: true });
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await pressUntil(menuButton, drawer);
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(mainMenu(page).getByRole('link', { name: 'People and sign-in' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectAccessible(page);

    // Focus stays inside while it is open.
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(menuButton).toBeFocused();

    // Following a link closes it too.
    await menuButton.click();
    await mainMenu(page).getByRole('link', { name: 'Models and providers' }).click();
    await expect(
      page.getByRole('heading', { name: 'Models and providers', level: 1 }),
    ).toBeVisible();
    await expect(drawer).toBeHidden();
  });
});
