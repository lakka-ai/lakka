import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type MarkdownOptions } from 'vitepress';

/*
 * The project site (ADR 0119): the landing page and the operator guide, read in place from the
 * repository's docs/ folder. Nothing else in docs/ is published.
 */

// GitHub Pages serves a project site under the repository's name; a custom domain is '/'.
const base = process.env.LAKKA_SITE_BASE ?? '/lakka/';

// The browser's toolbar colour is the page's surface, read from the design's theme file so the
// two cannot drift apart.
const theme = readFileSync(
  new URL('../../../docs/design/theme/lakka-theme.css', import.meta.url),
  'utf8',
);
function surface(block: string): string {
  const value = new RegExp(`${block}[^}]*?--surface:\\s*(#[0-9A-Fa-f]{6})`).exec(theme)?.[1];
  if (value === undefined) throw new Error(`no --surface in the ${block} block of the theme`);
  return value;
}

// Pages live outside this package, in docs/, where Vue cannot be resolved: pnpm installs it here
// only. Point the compiled pages at this package's copy, the one VitePress itself uses.
const vue = dirname(createRequire(import.meta.url).resolve('vue/package.json'));

// Each table sits in a box that scrolls sideways and takes keyboard focus, numbered within its
// page so two never share a name, as the app's chat does (docs/design/docs/accessibility.md).
const tablesSeen = new WeakMap<object, number>();

export default defineConfig({
  title: 'Lakka',
  description:
    'A self-hosted AI control plane for teams of 10 to 50 people: one install, your own model keys, and one identity and policy model applied across web chat, an OpenAI-compatible API and MCP.',
  lang: 'en',
  base,
  cleanUrls: true,
  lastUpdated: false,

  srcDir: '../../docs',
  // Only the landing page (docs/index.md) and the guide. Specs, decisions, design and gates stay
  // in the repository.
  srcExclude: ['!(guide)/**/*', '!(index).md'],
  // The guide's index is a README so GitHub shows it in the folder; the site serves it as /guide/.
  rewrites: { 'guide/README.md': 'guide/index.md' },
  // A localhost link points at the reader's own install, which the build cannot reach. Every
  // other dead link fails the build.
  ignoreDeadLinks: 'localhostLinks',

  vite: {
    // VitePress looks for public files beside the pages, in docs/public. The favicon lives with
    // the site, in apps/site/public; without this it was never published.
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    resolve: {
      alias: [
        { find: /^vue$/, replacement: vue },
        { find: /^vue\/server-renderer$/, replacement: `${vue}/server-renderer` },
      ],
    },
  },

  // VitePress keeps one meta per key, its first attribute other than content, so media comes
  // first: keyed on name, the dark colour would replace the light one.
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    [
      'meta',
      { media: '(prefers-color-scheme: light)', name: 'theme-color', content: surface(':root') },
    ],
    [
      'meta',
      { media: '(prefers-color-scheme: dark)', name: 'theme-color', content: surface('\\.dark') },
    ],
  ],

  markdown: {
    // Code is drawn as the app draws it: plain text in the code block colours. Highlighting
    // themes bring colours that were never contrast-checked against the tokens. Shiki's special
    // 'none' theme does this; VitePress passes it through but leaves it out of its type.
    theme: 'none' as unknown as NonNullable<MarkdownOptions['theme']>,
    config(md) {
      md.renderer.rules.table_open = (tokens, idx, options, env: object, self) => {
        const count = (tablesSeen.get(env) ?? 0) + 1;
        tablesSeen.set(env, count);
        return `<div class="lk-table-scroll" role="region" tabindex="0" aria-label="Table ${count}, scrolls sideways">${self.renderToken(tokens, idx, options)}`;
      };
      md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
        `${self.renderToken(tokens, idx, options)}</div>`;
    },
  },

  themeConfig: {
    nav: [
      // One way in: the docs, marked on every page of the guide.
      { text: 'Docs', link: '/guide/', activeMatch: '^/guide/' },
    ],
    // The icon is drawn from a stylesheet built with the site, not fetched from an icon service.
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/lakka-ai/lakka',
        ariaLabel: 'Source on GitHub',
      },
    ],
    // What Lakka is, then the guide in the order of the table in docs/guide/README.md, each
    // labelled with its page's title.
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [{ text: 'What is Lakka?', link: '/guide/' }],
        },
        {
          text: 'Guide',
          items: [
            { text: 'Install', link: '/guide/install' },
            { text: 'Administration', link: '/guide/administration' },
            { text: 'Example routes', link: '/guide/routing-examples' },
            { text: 'Adding a provider', link: '/guide/providers' },
            { text: 'The API', link: '/guide/api' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Operations', link: '/guide/operations' },
            { text: 'Backup and restore', link: '/guide/backup-and-restore' },
            { text: 'Upgrade', link: '/guide/upgrade' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            { text: 'Licence and source', link: '/guide/license' },
          ],
        },
      ],
    },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    // Search runs in the browser over an index built with the site; nothing is sent anywhere.
    search: { provider: 'local' },
    footer: {
      message: `Free software under the <a href="${base}guide/license">AGPL-3.0</a>.`,
    },
    notFound: {
      title: 'Page not found',
      quote: 'There is no page at this address.',
      linkText: 'Go to the start',
      linkLabel: 'Go to the start',
    },
  },
});
