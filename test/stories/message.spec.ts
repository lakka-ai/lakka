import { expect, test } from '@playwright/test';

/*
 * A person's own message (CH-1): code wider than the bubble scrolls inside the bubble. It used
 * to size the bubble's contents to the code, and the bubble's right alignment pushed the code out
 * past its left edge.
 */

for (const width of [1280, 390]) {
  test(`CH-1: at ${width}px, code in your own message stays inside its bubble and scrolls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/iframe.html?id=chat-your-message--long-code-line&viewMode=story');
    const bubble = page.getByRole('article', { name: 'You said' });
    const code = bubble.locator('pre');
    await expect(code).toBeVisible();
    const [outer, inner] = await Promise.all([bubble.boundingBox(), code.boundingBox()]);
    if (outer === null || inner === null) throw new Error('the bubble or its code has no box');
    expect(inner.x).toBeGreaterThanOrEqual(outer.x);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
    // The long line is still all there: the code block scrolls sideways to show it.
    expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  });
}
