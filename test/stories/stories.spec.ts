import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { LIVE_ANNOUNCER, realViolations, settled } from '../axe.ts';

/*
 * Every story in the static Storybook build (apps/web/storybook-static), in light and dark, at
 * 1280px and 390px (docs/design/HANDOFF.md, Done means):
 *
 * - axe finds no WCAG 2.1 A or AA violation;
 * - nothing is logged as an error;
 * - at 390px the story does not scroll sideways.
 */

interface IndexEntry {
  id: string;
  title: string;
  name: string;
  type: 'story' | 'docs';
}

const index = JSON.parse(
  readFileSync(new URL('../../apps/web/storybook-static/index.json', import.meta.url), 'utf8'),
) as { entries: Record<string, IndexEntry> };
const stories = Object.values(index.entries).filter((e) => e.type === 'story');

/**
 * The gallery's a11y addon runs axe on each story as it renders, and axe runs one check at a
 * time per page. Ours waits for that one to finish rather than failing on it.
 */
async function analyze(builder: AxeBuilder) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await builder.analyze();
    } catch (error) {
      if (attempt >= 20 || !String(error).includes('Axe is already running')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const modes = [
  { theme: 'light', width: 1280, height: 800 },
  { theme: 'dark', width: 1280, height: 800 },
  { theme: 'light', width: 390, height: 844 },
  { theme: 'dark', width: 390, height: 844 },
] as const;

test('the gallery has stories', () => {
  expect(stories.length).toBeGreaterThan(0);
});

for (const story of stories) {
  for (const mode of modes) {
    test(`NF-A1: ${story.title} / ${story.name}, ${mode.theme}, ${mode.width}px`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({ width: mode.width, height: mode.height });
      await page.emulateMedia({ colorScheme: mode.theme });
      await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${mode.theme}`);
      // Storybook marks the body once the story has rendered; dialogs render outside its root.
      await expect(page.locator('body')).toHaveClass(/\bsb-show-main\b/);
      const html = expect(page.locator('html'));
      await (mode.theme === 'dark' ? html : html.not).toHaveClass(/\bdark\b/);
      await settled(page);

      const results = await analyze(
        new AxeBuilder({ page })
          .exclude(LIVE_ANNOUNCER)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']),
      );
      const violations = realViolations(results).map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`,
      );
      expect(violations).toEqual([]);

      if (mode.width === 390) {
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth, 'the story scrolls sideways').toBeLessThanOrEqual(clientWidth);
      }
      expect(errors, 'console and page errors').toEqual([]);
    });
  }
}
