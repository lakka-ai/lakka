import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { realViolations, settled } from '../axe.ts';
import { PHONE_LAYOUT_BELOW, pages, sizes } from './pages.ts';

/*
 * Every page the site builds, read from apps/site/.vitepress/dist so a page added later is
 * checked too, at ten sizes in light and dark: phones (320px, 390px, and 667px on its side), a
 * tablet either side of where the sidebar stays (768px and 1000px), and desktops from 1100px to
 * 2560px. Below 1024px the browser is a touch device, as phones and tablets are. On each:
 *
 * - the page answers with its status, the 404 page with 404;
 * - axe finds no WCAG 2.1 A or AA violation;
 * - nothing is logged as an error, and nothing is asked of another host;
 * - the page does not scroll sideways;
 * - no code block scrolls up and down; below 640px a top-level code block runs from one screen
 *   edge to the other, and anywhere else every code block and table stays inside its column,
 *   list item or quote;
 * - on a touch screen every copy button is shown and clear of the code;
 * - on the landing page each feature card leaves its text at least 200px, so it reads in lines:
 *   278px on a tablet two by two, 226px at 1280px four in a row. VitePress set them four in a row
 *   from 960px, 156px at 1000px; a rule against that once made a phone's single column two;
 * - below 1024px every target in the page's chrome is at least 44px each way (accessibility.md).
 *
 * site.spec.ts checks what a page does when opened: menus, search, the sidebar's states.
 */

// The chrome a phone or tablet is tapped on; links inside the text are exempt, as WCAG's inline
// exception allows.
const chrome = [
  '.VPNavBar :is(a, button)',
  '.VPLocalNav :is(a, button)',
  '.VPSidebar a',
  '.VPHero a',
  '.VPFeature',
  '.VPFooter a',
  '.NotFound a',
  '.VPDocFooter a',
].join(', ');

test('the build has the landing page, the guide and the 404 page', () => {
  expect(pages.map((p) => p.path)).toContain('');
  expect(pages.map((p) => p.path)).toContain('guide/');
  expect(pages.map((p) => p.status)).toContain(404);
  expect(pages.length).toBeGreaterThanOrEqual(12);
});

for (const target of pages) {
  for (const size of sizes) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${target.name} at ${size.width}px, ${theme}: axe, no errors, no sideways scroll, code, tables and features in place, 44px targets`, async ({
        browser,
        browserName,
        baseURL,
      }) => {
        const touch = size.width < PHONE_LAYOUT_BELOW;
        const context = await browser.newContext({
          viewport: size,
          colorScheme: theme,
          // Firefox has no mobile emulation; it gets touch alone.
          ...(touch
            ? { hasTouch: true, ...(browserName === 'firefox' ? {} : { isMobile: true }) }
            : {}),
        });
        const page = await context.newPage();
        const origin = new URL(baseURL ?? '').origin;
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

        const response = await page.goto(new URL(target.path, baseURL).href);
        expect(response?.status(), 'the status').toBe(target.status);
        await settled(page);
        await page.waitForLoadState('networkidle');

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const violations = realViolations(results).map(
          (v) =>
            `${v.id} (${v.impact}): ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`,
        );

        const layout = await page.evaluate(
          ({ isTouch, selector }) => {
            const doc = document.querySelector('.vp-doc');
            const outOfPlace = (el: Element) => {
              const box = el.getBoundingClientRect();
              const holder = el.parentElement?.closest('li, blockquote') ?? null;
              if (holder === null && innerWidth < 640 && el.matches('div[class*="language-"]')) {
                return (
                  Math.round(box.left) !== 0 ||
                  Math.round(box.right) !== document.documentElement.clientWidth
                );
              }
              const room = (holder ?? doc)?.getBoundingClientRect();
              return (
                room !== undefined && (box.left < room.left - 0.5 || box.right > room.right + 0.5)
              );
            };
            const blocks = [...document.querySelectorAll('.vp-doc div[class*="language-"]')];
            const tables = [...document.querySelectorAll('.vp-doc .lk-table-scroll')];
            return {
              scrollsSideways:
                document.documentElement.scrollWidth > document.documentElement.clientWidth,
              blocksScrollingDown: blocks
                .filter((b) => b.scrollHeight > b.clientHeight)
                .map((b) => b.textContent?.trim().slice(0, 30) ?? ''),
              blocksOutOfPlace: blocks
                .filter(outOfPlace)
                .map((b) => b.textContent?.trim().slice(0, 30) ?? ''),
              narrowFeatures: [...document.querySelectorAll('.VPFeature .details')]
                .map((d) => Math.round(d.getBoundingClientRect().width))
                .filter((w) => w < 200),
              tablesOutOfPlace: tables
                .filter(outOfPlace)
                .map((t) => t.getAttribute('aria-label') ?? ''),
              // Where nothing can hover, as the browser reports it: Firefox's touch does not.
              copyButtonsUnseen: matchMedia('(hover: none)').matches
                ? blocks
                    .filter((b) => {
                      const button = b.querySelector('button.copy');
                      const code = b.querySelector('code');
                      if (button === null || code === null) return true;
                      const reach =
                        b.getBoundingClientRect().right - button.getBoundingClientRect().left;
                      return (
                        getComputedStyle(button).opacity !== '1' ||
                        parseFloat(getComputedStyle(code).paddingRight) < reach
                      );
                    })
                    .map((b) => b.textContent?.trim().slice(0, 30) ?? '')
                : [],
              smallTargets: isTouch
                ? [...document.querySelectorAll(selector)]
                    .filter((t) => {
                      const box = t.getBoundingClientRect();
                      return (
                        t.getClientRects().length > 0 &&
                        box.width > 0 &&
                        box.right > 0 &&
                        box.left < innerWidth
                      );
                    })
                    .map((t) => {
                      const box = t.getBoundingClientRect();
                      const before = getComputedStyle(t, '::before');
                      const reach = before.content === 'none' ? 0 : parseFloat(before.height) || 0;
                      return {
                        name: (t.getAttribute('aria-label') ?? t.textContent ?? '')
                          .trim()
                          .slice(0, 30),
                        width: box.width,
                        height: Math.max(box.height, reach),
                      };
                    })
                    .filter((t) => t.width < 44 || t.height < 44)
                    .map((t) => `${t.name}: ${Math.round(t.width)} by ${Math.round(t.height)}`)
                : [],
            };
          },
          { isTouch: touch, selector: chrome },
        );

        // The browser logs the page's own 404 status as an error; nothing else may be one.
        const pageErrors = errors.filter(
          (e) => !(target.status === 404 && e.endsWith(`(${page.url()})`) && e.includes('404')),
        );
        await context.close();

        expect({ violations, errors: pageErrors, elsewhere, ...layout }).toEqual({
          violations: [],
          errors: [],
          elsewhere: [],
          scrollsSideways: false,
          blocksScrollingDown: [],
          blocksOutOfPlace: [],
          narrowFeatures: [],
          tablesOutOfPlace: [],
          copyButtonsUnseen: [],
          smallTargets: [],
        });
      });
    }
  }
}
