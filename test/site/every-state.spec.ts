import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { realViolations, settled } from '../axe.ts';
import { NO_TRANSITIONS, PHONE_LAYOUT_BELOW, sizes } from './pages.ts';

/*
 * What a page does when it is opened, at every size, light and dark, on a long guide page: each
 * menu the size shows, the sidebar's states and search. On each: no axe violation, no sideways
 * scroll, and below 1024px every target at least 44px each way (accessibility.md); a target may
 * reach past its box with a ::before, as the light and dark switch does.
 *
 * - The top menu, below 768px; the guide's drawer of pages, below 960px; On this page, below
 *   1280px, where the outline has no column of its own.
 * - The sidebar marks the current page with the accent soft fill and semibold, not colour alone
 *   (accessibility.md), as the app's side menu does; other pages are regular and unfilled; rows
 *   are 34px, or 44px below 1024px; each link fills its row, so the focus ring rings it.
 * - Search, in its list and detailed views: results 44px below 1024px, its icon buttons at least
 *   the 32px md button, which accessibility.md exempts from 44; from 768px a dialog's 16px corners
 *   and the overlay shadow (tokens.md).
 */

async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return realViolations(results).map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`,
  );
}

/** Targets in a part of the page under 44px each way, and whether the page scrolls sideways. */
function layout(page: Page, root: string, touchSized: boolean) {
  return page.evaluate(
    ({ selector, check }) => ({
      scrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      smallTargets: check
        ? [...document.querySelectorAll(`${selector} :is(a, button)`)]
            .filter((t) => {
              const box = t.getBoundingClientRect();
              return t.getClientRects().length > 0 && box.width > 0 && box.right > 0;
            })
            .map((t) => {
              const box = t.getBoundingClientRect();
              const before = getComputedStyle(t, '::before');
              const reach =
                before.content === 'none'
                  ? { width: 0, height: 0 }
                  : {
                      width: parseFloat(before.width) || 0,
                      height: parseFloat(before.height) || 0,
                    };
              return {
                name: (t.getAttribute('aria-label') ?? t.textContent ?? '').trim().slice(0, 30),
                width: Math.max(box.width, reach.width),
                height: Math.max(box.height, reach.height),
              };
            })
            .filter((t) => t.width < 44 || t.height < 44)
            .map((t) => `${t.name}: ${Math.round(t.width)} by ${Math.round(t.height)}`)
        : [],
    }),
    { selector: root, check: touchSized },
  );
}

/** The sidebar's rows: which is current, how it is drawn, and how tall each row is. */
function sidebarRows(page: Page) {
  return page.locator('.VPSidebar .VPSidebarItem.is-link').evaluateAll((items) => {
    const probe = document.createElement('div');
    document.body.append(probe);
    probe.style.backgroundColor = 'var(--accent-soft)';
    const accentSoft = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return items.map((item) => {
      const row = item.querySelector(':scope > .item');
      const link = item.querySelector('a');
      const text = item.querySelector('.text');
      const rowBox = row?.getBoundingClientRect();
      const linkBox = link?.getBoundingClientRect();
      return {
        name: text?.textContent?.trim() ?? '',
        current: link?.getAttribute('aria-current') === 'page',
        filled: row !== null && getComputedStyle(row).backgroundColor === accentSoft,
        clear: row !== null && getComputedStyle(row).backgroundColor === 'rgba(0, 0, 0, 0)',
        weight: text === null ? '' : getComputedStyle(text).fontWeight,
        height: Math.round(rowBox?.height ?? 0),
        linkFillsRow: Math.round(linkBox?.width ?? -1) === Math.round(rowBox?.width ?? -2),
      };
    });
  });
}

for (const size of sizes) {
  for (const theme of ['light', 'dark'] as const) {
    test(`at ${size.width}px, ${theme}: every menu, the sidebar and search this size shows pass axe, with 44px targets on a phone and tablet`, async ({
      page,
    }) => {
      const touchSized = size.width < PHONE_LAYOUT_BELOW;
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('guide/configuration');
      await settled(page);
      await page.addStyleTag({ content: NO_TRANSITIONS });
      const faults: string[] = [];
      const check = async (where: string, root: string) => {
        for (const v of await axeViolations(page)) faults.push(`${where}: ${v}`);
        const { scrollsSideways, smallTargets } = await layout(page, root, touchSized);
        if (scrollsSideways) faults.push(`${where}: the page scrolls sideways`);
        for (const t of smallTargets) faults.push(`${where}: ${t}`);
      };
      const checkSidebar = async (where: string) => {
        const rows = await sidebarRows(page);
        const rowHeight = touchSized ? 44 : 34;
        const current = rows.filter((r) => r.current);
        if (current.map((r) => r.name).join() !== 'Configuration') {
          faults.push(
            `${where}: the current page is ${current.map((r) => r.name).join() || 'none'}`,
          );
        }
        for (const r of rows) {
          if (r.current && !(r.filled && r.weight === '600')) {
            faults.push(`${where}: ${r.name}, the current page, is not filled and semibold`);
          }
          if (!r.current && !(r.clear && r.weight === '400')) {
            faults.push(`${where}: ${r.name} is filled or not regular`);
          }
          if (r.height !== rowHeight)
            faults.push(`${where}: ${r.name} is ${r.height}px, not ${rowHeight}`);
          if (!r.linkFillsRow) faults.push(`${where}: ${r.name}'s link does not fill its row`);
        }
      };

      const shows = (selector: string) => page.locator(selector).isVisible();

      if (await shows('.VPNavBarHamburger')) {
        await page.locator('.VPNavBarHamburger').click();
        await expect(page.locator('.VPNavScreen')).toBeVisible();
        await check('the top menu', '.VPNavScreen');
        await page.locator('.VPNavBarHamburger').click();
        await expect(page.locator('.VPNavScreen')).toHaveCount(0);
      }

      if (await shows('.VPLocalNav .menu')) {
        await page.locator('.VPLocalNav .menu').click();
        await expect(page.locator('.VPSidebar.open')).toBeVisible();
        // The pointer stays where it tapped Menu, over the drawer's first row once it opens.
        await page.mouse.move(size.width - 1, size.height - 1);
        await check('the drawer', '.VPSidebar');
        await checkSidebar('the drawer');
        await page.keyboard.press('Escape');
        await expect(page.locator('.VPSidebar.open')).toHaveCount(0);
      } else {
        await checkSidebar('the sidebar');
        await check('the sidebar', '.VPSidebar');
      }

      if (await shows('.VPLocalNavOutlineDropdown button')) {
        await page.locator('.VPLocalNavOutlineDropdown button').click();
        await expect(page.locator('.VPLocalNavOutlineDropdown .items')).toBeVisible();
        await check('On this page', '.VPLocalNavOutlineDropdown .items');
        await page.locator('.VPLocalNavOutlineDropdown button').click();
        await expect(page.locator('.VPLocalNavOutlineDropdown .items')).toHaveCount(0);
      } else {
        expect(await shows('.VPDocAsideOutline'), 'the outline has a column').toBe(true);
      }

      await page.locator('.VPNavBarSearchButton').click();
      await page.getByRole('searchbox').fill('budget');
      await expect(page.locator('.VPLocalSearchBox .result').first()).toBeVisible();
      for (const view of ['list', 'detailed'] as const) {
        if (view === 'detailed') {
          await page.getByRole('button', { name: 'Display detailed list' }).click();
          // Excerpts appear only once VitePress has imported and rendered every result's page.
          // In Linux WebKit that took up to 3.5 s on a cold run with nothing else running, so
          // the default 5 s fails when CI runs the other tests alongside it.
          await expect(page.locator('.VPLocalSearchBox .excerpt').first()).toBeVisible({
            timeout: 15_000,
          });
        }
        await settled(page);
        for (const v of await axeViolations(page)) faults.push(`search, ${view} view: ${v}`);
        const search = await page.locator('.VPLocalSearchBox').evaluate((box) => ({
          scrollsSideways:
            document.documentElement.scrollWidth > document.documentElement.clientWidth,
          shortestRow: Math.min(
            ...[...box.querySelectorAll('.result')].map((r) => r.getBoundingClientRect().height),
          ),
          smallestButton: Math.min(
            ...[...box.querySelectorAll('.search-actions button')]
              .filter((b) => b.getClientRects().length > 0)
              .map((b) => {
                const r = b.getBoundingClientRect();
                return Math.min(r.width, r.height);
              }),
          ),
          radius: getComputedStyle(box.querySelector('.shell') ?? box).borderRadius,
          shadow: getComputedStyle(box.querySelector('.shell') ?? box).boxShadow,
        }));
        if (search.scrollsSideways) faults.push(`search, ${view} view: the page scrolls sideways`);
        if (touchSized && search.shortestRow < 44) {
          faults.push(`search, ${view} view: a result is ${Math.round(search.shortestRow)}px`);
        }
        if (touchSized && search.smallestButton < 32) {
          faults.push(`search: an icon button is ${Math.round(search.smallestButton)}px`);
        }
        if (size.width >= 768 && (search.radius !== '16px' || search.shadow === 'none')) {
          faults.push(
            `search: the dialog has ${search.radius} corners and shadow ${search.shadow}`,
          );
        }
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('.VPLocalSearchBox')).toHaveCount(0);

      expect(faults).toEqual([]);
    });
  }
}
