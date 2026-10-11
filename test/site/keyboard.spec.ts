import { expect, test, type Page } from '@playwright/test';
import { settled } from '../axe.ts';
import { NO_TRANSITIONS, pages } from './pages.ts';

/*
 * The site with a keyboard alone (WCAG 2.1.1, 2.4.3, 2.4.7; accessibility.md). On every page the
 * site builds, at a desktop and a phone width, light and dark, Tab goes first to the skip link,
 * which takes focus into the content, and then through the page: every stop is on the screen, not
 * hidden, and shows the focus ring. On a phone each menu opens from the keyboard and closes with
 * Escape, giving focus back to what opened it. The light and dark switch, the copy button and
 * Return to top work as they say.
 */

const sizes = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

/** What has focus, and whether a person can see it and see that it has focus. */
function focusState(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return null;
    const box = el.getBoundingClientRect();
    let opacity = 1;
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    const style = getComputedStyle(el);
    const ring =
      (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2) ||
      style.boxShadow !== 'none';
    return {
      name: `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}`,
      onScreen:
        el.getClientRects().length > 0 &&
        box.width > 0 &&
        box.height > 0 &&
        box.right > 0 &&
        box.left < innerWidth &&
        box.bottom > 0 &&
        box.top < innerHeight,
      seen: opacity > 0 && style.visibility !== 'hidden',
      ring,
      key: el.outerHTML.slice(0, 200),
    };
  });
}

for (const target of pages) {
  for (const size of sizes) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${target.name} at ${size.width}px, ${theme}: the skip link first, then every stop seen and ringed`, async ({
        page,
        browserName,
      }) => {
        // Safari's Tab skips links unless Option is held, or "Press Tab to highlight each item" is
        // on; WebKit does the same.
        const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(target.path);
        await settled(page);
        // What a stop looks like once it has taken focus: VitePress fades some in, such as the
        // heading's permalink and the copy button, and a stop is measured as it ends up.
        await page.addStyleTag({ content: NO_TRANSITIONS });

        // The whole page from the top, every stop in order, the skip link first.
        const faults: string[] = [];
        const seenKeys = new Set<string>();
        const names: string[] = [];
        for (let step = 0; step < 500; step += 1) {
          await page.keyboard.press(next);
          let stop = await focusState(page);
          if (stop !== null && !stop.onScreen) {
            // WebKit can scroll the stop into view a frame after it takes focus; measure it again
            // once the page has painted, so only a stop that stays off the screen is a fault.
            await page.evaluate(
              () =>
                new Promise((painted) =>
                  requestAnimationFrame(() => requestAnimationFrame(painted)),
                ),
            );
            stop = await focusState(page);
          }
          if (stop === null || seenKeys.has(stop.key)) break;
          seenKeys.add(stop.key);
          names.push(stop.name);
          if (!stop.onScreen) faults.push(`${stop.name}: off the screen`);
          else if (!stop.seen) faults.push(`${stop.name}: hidden`);
          else if (!stop.ring) faults.push(`${stop.name}: no focus ring`);
        }
        expect(names[0], 'the first stop').toContain('Skip to content');
        expect(faults).toEqual([]);

        // The skip link takes focus into the content.
        await page.locator('.VPSkipLink').focus();
        await page.keyboard.press('Enter');
        // VitePress moves focus once it has handled the link.
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.closest('#VPContent') !== null), {
            message: 'the skip link takes focus into the content',
          })
          .toBe(true);
        expect(seenKeys.size, 'the page has stops after the skip link').toBeGreaterThan(1);
      });
    }
  }
}

/*
 * On a phone each menu opens from the keyboard and Escape closes it, giving focus back to the
 * button that opened it.
 */
const menus = [
  { name: 'the top menu', opener: '.VPNavBarHamburger', open: '.VPNavScreen' },
  { name: "the guide's drawer of pages", opener: '.VPLocalNav .menu', open: '.VPSidebar.open' },
  {
    name: 'On this page',
    opener: '.VPLocalNavOutlineDropdown button',
    open: '.VPLocalNavOutlineDropdown .items',
  },
  { name: 'search', opener: '.VPNavBarSearchButton', open: '.VPLocalSearchBox' },
] as const;

for (const menu of menus) {
  test(`on a phone, ${menu.name} opens from the keyboard, and Escape closes it and gives focus back`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('guide/install');
    await settled(page);
    await page.locator(menu.opener).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(menu.open)).toBeVisible();
    await settled(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(menu.open)).toHaveCount(0);
    expect(
      await page.locator(menu.opener).evaluate((el) => el === document.activeElement),
      'focus is back on the button that opened it',
    ).toBe(true);
  });
}

/** What focus was moved to, if it shows a ring; empty if it does not. */
function ringed(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el.getAttribute('tabindex') !== '-1') return 'focus did not move';
    return getComputedStyle(el).outlineStyle === 'none' ? '' : `${el.tagName} #${el.id}`;
  });
}

/*
 * VitePress moves focus to the heading a link names, and the skip link to the content, so a
 * screen reader goes on from there. Neither is a control, so neither shows the ring, as in the
 * app, which rings controls only (accessibility.md). WebKit drew it after a tap and a click too.
 */
test('a heading or the content that focus moves to shows no focus ring, after a tap, a click or a key', async ({
  browser,
  browserName,
  baseURL,
}) => {
  const faults: string[] = [];

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    ...(browserName === 'firefox' ? {} : { isMobile: true }),
  });
  let page = await phone.newPage();
  await page.goto(new URL('', baseURL).href);
  await page.locator('.VPFeature').first().tap();
  await page.waitForURL(/administration#workspaces$/);
  await expect.poll(() => ringed(page)).not.toBe('focus did not move');
  const afterTap = await ringed(page);
  if (afterTap) faults.push(`after a tap on a feature: ${afterTap}`);
  await phone.close();

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await desktop.newPage();
  await page.goto(new URL('guide/administration', baseURL).href);
  await settled(page);
  await page.locator('.VPDocAsideOutline a').nth(3).click();
  await expect.poll(() => ringed(page)).not.toBe('focus did not move');
  const afterClick = await ringed(page);
  if (afterClick) faults.push(`after a click in the outline: ${afterClick}`);
  await page.locator('.VPDocAsideOutline a').nth(5).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H3');
  const afterEnter = await ringed(page);
  if (afterEnter) faults.push(`after Enter in the outline: ${afterEnter}`);
  await page.locator('.VPSkipLink').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('VPContent');
  const afterSkip = await ringed(page);
  if (afterSkip) faults.push(`after the skip link: ${afterSkip}`);
  await desktop.close();

  expect(faults).toEqual([]);
});

test('the light and dark switch works from the keyboard and is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('guide/install');
  await settled(page);
  const html = page.locator('html');
  const toggle = page.locator('.VPNavBarAppearance .VPSwitch');
  await expect(html).not.toHaveClass(/\bdark\b/);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.locator('.VPNavBarAppearance .VPSwitch').focus();
  await page.keyboard.press('Space');
  await expect(html).not.toHaveClass(/\bdark\b/);
});

test('the copy button copies the code and says so', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'reading the clipboard back needs Chromium permissions');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('guide/install');
  await settled(page);
  const block = page.locator('.vp-doc div[class*="language-"]').first();
  const code = (await block.locator('code').innerText()).trim();
  await block.hover();
  await block.locator('button.copy').click();
  await expect(block.locator('button.copy')).toHaveClass(/\bcopied\b/);
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(code);
});

test('on a phone, Return to top in On this page goes back to the top', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('guide/configuration');
  await settled(page);
  await page.evaluate(() => window.scrollTo(0, 3000));
  await page.locator('.VPLocalNavOutlineDropdown button').click();
  await page.locator('.VPLocalNavOutlineDropdown .items').getByText('Return to top').click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
