import { expect, test, type Page } from '@playwright/test';
import { settled } from '../axe.ts';

/*
 * The project site (ADR 0119), built and served by `vitepress preview`: what the broad checks do
 * not cover. every-page.spec.ts checks every page at every size as it loads, every-state.spec.ts
 * every menu, the sidebar and search as they open, and keyboard.spec.ts the site with a keyboard
 * alone. Here: the landing page's nav bar and feature cards on a desktop, search finding a page
 * and working as a dialog of options, and the typefaces in use.
 */

/** Collects console errors, page errors and every request that leaves the site's own origin. */
function watch(page: Page, origin: string) {
  const errors: string[] = [];
  const elsewhere: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} (${m.location().url})`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.origin !== origin) {
      elsewhere.push(r.url());
    }
  });
  return { errors, elsewhere };
}

/*
 * The landing page on a desktop, 1280px, 1440px and 1920px: the nav bar keeps to the hero's
 * column, the wordmark starting where the hero does and the bar ending where the features do
 * (VitePress set it 32px to 112px wider); the page does not scroll sideways; and a hovered
 * feature card takes --surface-tertiary and keeps its --border edge, as buttons and menu items do
 * (patterns.md, States), where VitePress turned the edge accent.
 */
for (const width of [1280, 1440, 1920] as const) {
  test(`on a desktop, ${width}px: the landing page's nav bar keeps to its column, and a feature card hovers as the app does`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('');
    await settled(page);
    const edges = await page.evaluate(() => {
      const title = document.querySelector('.VPNavBarTitle .title')?.getBoundingClientRect();
      const hero = document.querySelector('.VPHero .main')?.getBoundingClientRect();
      const bar = document.querySelector('.VPNavBar .content')?.getBoundingClientRect();
      const last = [...document.querySelectorAll('.VPFeature')].at(-1)?.getBoundingClientRect();
      return {
        wordmark: Math.round(title?.left ?? -1),
        hero: Math.round(hero?.left ?? -2),
        barEnd: Math.round(bar?.right ?? -1),
        featuresEnd: Math.round(last?.right ?? -2),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    expect(edges.wordmark, 'the wordmark starts where the hero does').toBe(edges.hero);
    expect(edges.barEnd, 'the nav bar ends where the features do').toBe(edges.featuresEnd);
    expect(edges.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(edges.clientWidth);

    const card = page.locator('.VPFeature').first();
    const want = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.append(probe);
      probe.style.backgroundColor = 'var(--surface-tertiary)';
      probe.style.borderColor = 'var(--border)';
      const style = getComputedStyle(probe);
      const colors = { fill: style.backgroundColor, edge: style.borderColor };
      probe.remove();
      return colors;
    });
    await card.hover();
    // VitePress fades the fill in over 0.25s.
    await expect
      .poll(() => card.evaluate((el) => getComputedStyle(el).backgroundColor), {
        message: 'a hovered card takes --surface-tertiary',
      })
      .toBe(want.fill);
    expect(
      await card.evaluate((el) => getComputedStyle(el).borderTopColor),
      'a hovered card keeps its --border edge',
    ).toBe(want.edge);
  });
}

test('search finds a guide page from an index served by the site itself', async ({
  page,
  baseURL,
}) => {
  const seen = watch(page, new URL(baseURL ?? '').origin);
  await page.goto('');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('searchbox').fill('recovery key');
  await expect(
    page
      .getByRole('listbox')
      .getByRole('option', { name: /Rotating the recovery key/ })
      .first(),
  ).toBeVisible();
  expect(seen.elsewhere, 'requests to another host').toEqual([]);
  expect(seen.errors, 'console and page errors').toEqual([]);
});

/*
 * The search dialog is a dialog, and its results are options a screen reader can reach: VitePress
 * drew the dialog as a button and put each result's link inside its option, which our patch
 * changes (patches/vitepress@2.0.0-alpha.20.patch, ADR 0119). The keys and a tap still open a
 * result.
 */
test('search is a dialog of options that the arrow keys, Enter and a tap open', async ({
  page,
}) => {
  await page.goto('');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const field = page.getByRole('searchbox');
  await field.fill('recovery key');
  const options = page.getByRole('listbox').getByRole('option');
  await expect(options.first()).toBeVisible();

  // The field names the chosen option, and that option is the one marked selected.
  await field.press('ArrowDown');
  const chosen = await field.getAttribute('aria-activedescendant');
  expect(chosen).not.toBeNull();
  const option = page.locator(`[id="${chosen}"]`);
  await expect(option).toHaveAttribute('role', 'option');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  const target = new URL((await option.getAttribute('href')) ?? '', page.url()).pathname;
  await field.press('Enter');
  await expect(page).toHaveURL((url) => url.pathname === target);

  await page.goto('');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('searchbox').fill('recovery key');
  const rotating = page.getByRole('option', { name: /Rotating the recovery key/ }).first();
  await rotating.click();
  await expect(page).toHaveURL(/backup-and-restore#rotating-the-recovery-key$/);
});

test('the fonts in use are the app typefaces, from the site itself', async ({ page }) => {
  await page.goto('guide/install');
  await settled(page);
  const families = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
  );
  expect(new Set(families)).toEqual(
    new Set(['Atkinson Hyperlegible Next', 'Atkinson Hyperlegible Mono', 'Newsreader']),
  );
});
