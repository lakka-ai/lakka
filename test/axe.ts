import type { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type Result = AxeResults['violations'][number];

/*
 * Known axe false positives, each as narrow as it can be. Anything else axe reports fails.
 *
 * - react-aria's Meter renders role="meter progressbar": the first role a browser knows wins,
 *   and progressbar is there for screen readers older than ARIA 1.2. axe 4.13 accepts
 *   aria-valuenow and aria-valuetext on role="meter" but reports them on the fallback list.
 *   The Budget meter needs the meter role and its aria-valuetext (docs/design/docs/
 *   accessibility.md), and react-aria gives no way to drop the fallback.
 */
function isMeterFallback(violation: Result): boolean {
  return (
    violation.id === 'aria-allowed-attr' &&
    violation.nodes.every(
      (node) =>
        node.html.includes('role="meter progressbar"') &&
        /ARIA attributes are not allowed: (aria-value(now|min|max|text)="[^"]*"(, )?)+$/.test(
          node.failureSummary?.split('\n').at(-1)?.trim() ?? '',
        ),
    )
  );
}

/**
 * react-aria's live announcer: a visually hidden log, outside the page's content, of what it has
 * already told a screen reader, such as "Budget test selected" in a grid list. An entry points at
 * the announced element with aria-labelledby and is removed after seven seconds; if the page
 * redraws that element meanwhile, the entry points at nothing, and axe reports role-img-alt on
 * it. Nobody reads it again, so it is left out of the check, and nothing else is.
 */
export const LIVE_ANNOUNCER = '[data-live-announcer]';

export function realViolations(results: AxeResults): Result[] {
  return results.violations.filter((v) => !isMeterFallback(v));
}

/**
 * How long the page must stay still. An overlay mounts some time after the page has rendered:
 * a dialog story's dialog appears 75 to 200ms after Storybook shows the story. A page that is
 * still only until then is not settled.
 */
const QUIET_MS = 400;

/**
 * Waits for the page to settle, so axe measures what people see, not a dialog halfway through
 * fading in: nothing entering or leaving (react-aria's data-entering and data-exiting) and no
 * animation running, for QUIET_MS on end. Only finite animations on the document's timeline
 * count: a scroll-driven one, such as HeroUI's scroll shadow on a tab list, is always running.
 */
export async function settled(page: Page): Promise<void> {
  // Fonts change text metrics, so they load first.
  await page.evaluate(async (quietMs) => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      let quietSince = performance.now();
      const tick = () => {
        const now = performance.now();
        const busy =
          document.querySelector('[data-entering="true"], [data-exiting="true"]') !== null ||
          document
            .getAnimations()
            .some(
              (a) =>
                a.timeline === document.timeline &&
                a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY &&
                a.playState === 'running',
            );
        if (busy) quietSince = now;
        if (now - quietSince >= quietMs) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, QUIET_MS);
}
