import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * What the site's browser checks run on: every page the site builds, read from
 * apps/site/.vitepress/dist so a page added later is checked too, and the sizes it is seen at.
 */

const dist = fileURLToPath(new URL('../../apps/site/.vitepress/dist/', import.meta.url));

export interface SitePage {
  name: string;
  path: string;
  status: number;
}

export const pages: SitePage[] = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.html'))
  .toSorted()
  .map((file) => {
    // An address with no page: VitePress serves its 404 page, with the 404 status.
    if (file === '404.html') return { name: 'the 404 page', path: 'no-such-page', status: 404 };
    const path = file.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '');
    const name = path === '' ? 'the landing page' : path === 'guide/' ? 'the guide index' : path;
    return { name, path, status: 200 };
  });

// Each of VitePress's layouts and the app's breakpoints, from both sides: 320px is WCAG's reflow
// width (1.4.10), 667 by 390 a phone on its side, 768px and 1000px a tablet either side of where
// the sidebar stays (960px), 1100px a laptop between the app's 1024px and the outline column's
// 1280px, then desktops to 2560px.
export const sizes = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 667, height: 390 },
  { width: 768, height: 1024 },
  { width: 1000, height: 800 },
  { width: 1100, height: 800 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const;

/** Below this width the app's phone layout holds, and touch targets are 44px (phone.md). */
export const PHONE_LAYOUT_BELOW = 1024;

/** A stylesheet that ends every transition at once, so a state is measured as it ends up. */
export const NO_TRANSITIONS =
  '*, *::before, *::after { transition: none !important; animation: none !important; }';
