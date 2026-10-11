import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Checks the built project site (ADR 0119), after `pnpm site:build`:
 *
 * - every #fragment in a link inside the built pages is an id on its target page;
 * - every #fragment in a link in the Markdown sources is a heading on its target as GitHub names
 *   it, so the guide's anchors work when read on GitHub too;
 * - nothing in the built HTML, CSS or JS loads a resource from another host: no font service, no
 *   CDN, no analytics. Links out are fine;
 * - every file of the site's own that a page loads, such as the favicon, is in the build;
 * - the app's typefaces are in the build.
 *
 * The build itself fails on a dead link. test/site/site.spec.ts checks the pages in a browser.
 *
 * Usage: node scripts/site-check.ts   (LAKKA_SITE_BASE as for the build)
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'apps/site/.vitepress/dist');
const base = process.env['LAKKA_SITE_BASE'] ?? '/lakka/';
const problems: string[] = [];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((f) => join(dir, f));
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

const files = filesUnder(dist);
const pages = files.filter((f) => f.endsWith('.html'));

// --- Fragments in the built pages ---

/** The built page a site path is served from, with clean URLs: /guide/api is guide/api.html. */
function pageFor(pathname: string): string | undefined {
  if (!pathname.startsWith(base)) return undefined;
  const rest = pathname.slice(base.length);
  const file = rest === '' || rest.endsWith('/') ? `${rest}index.html` : `${rest}.html`;
  return join(dist, file);
}

const idsByPage = new Map<string, Set<string>>();
function idsOf(page: string): Set<string> {
  let ids = idsByPage.get(page);
  if (ids === undefined) {
    const html = readFileSync(page, 'utf8');
    ids = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decodeEntities(m[1] ?? '')));
    idsByPage.set(page, ids);
  }
  return ids;
}

let fragmentLinks = 0;
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const pageUrl = new URL(
    `${base}${relative(dist, page)
      .replace(/(^|\/)index\.html$/, '$1')
      .replace(/\.html$/, '')}`,
    'http://site.invalid',
  );
  for (const match of html.matchAll(/<a\s[^>]*?href="([^"]*)"/g)) {
    const href = decodeEntities(match[1] ?? '');
    const url = new URL(href, pageUrl);
    if (url.origin !== pageUrl.origin || url.hash === '') continue;
    const target = pageFor(url.pathname);
    fragmentLinks += 1;
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (target === undefined || !files.includes(target)) {
      problems.push(`${relative(dist, page)}: ${href} points at no page`);
    } else if (!idsOf(target).has(fragment)) {
      problems.push(`${relative(dist, page)}: ${href} has no id "${fragment}" on its page`);
    }
  }
}

// --- Fragments in the Markdown, as GitHub names headings ---

/** GitHub's heading ids (github-slugger): lower case, punctuation dropped, spaces to hyphens. */
function githubIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const heading = fence ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const text = (heading[1] ?? '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*]/g, '')
      .replace(/\\(.)/g, '$1');
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    ids.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return ids;
}

const sources = [
  join(root, 'docs/index.md'),
  ...filesUnder(join(root, 'docs/guide')).filter((f) => f.endsWith('.md')),
];
let markdownFragments = 0;
for (const source of sources) {
  const markdown = readFileSync(source, 'utf8');
  for (const match of markdown.matchAll(/\]\(([^)\s]*#[^)\s]*)\)/g)) {
    const link = match[1] ?? '';
    if (/^[a-z]+:/i.test(link)) continue;
    const [path = '', fragment = ''] = link.split('#');
    const target = path === '' ? source : join(posix.dirname(source), path);
    markdownFragments += 1;
    if (!sources.includes(target)) {
      problems.push(`${relative(root, source)}: ${link} points outside the published pages`);
    } else if (!githubIds(readFileSync(target, 'utf8')).has(fragment)) {
      problems.push(`${relative(root, source)}: ${link} is not a heading on GitHub`);
    }
  }
}

// --- No resources from another host ---

// Services a page must never load from. Built JS also carries the guide's text, which names
// example addresses, so it is checked for these rather than for every URL.
const thirdParty =
  /fonts\.googleapis\.com|fonts\.gstatic\.com|googletagmanager|google-analytics|algolia(net)?\.(com|net)|carbonads\.(com|net)|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|plausible\.io|cloudflareinsights/i;
const external = (url: string) => /^(https?:)?\/\//i.test(url.trim());

let resources = 0;
for (const file of files) {
  const name = relative(dist, file);
  if (!/\.(html|css|js)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  const service = thirdParty.exec(text);
  if (service !== null) problems.push(`${name}: names ${service[0]}`);
  if (file.endsWith('.html')) {
    const urls = [
      ...text.matchAll(/<(?:script|img|iframe|source|video|audio|embed)\s[^>]*?src="([^"]*)"/g),
      ...text.matchAll(/<link\s[^>]*?href="([^"]*)"/g),
      ...text.matchAll(/\ssrcset="([^"]*)"/g),
    ].map((m) => decodeEntities(m[1] ?? ''));
    resources += urls.length;
    for (const url of urls.filter(external)) problems.push(`${name}: loads ${url}`);
    // A file of the site's own that the page asks for is in the build: the favicon once was not.
    for (const url of urls.filter((u) => !external(u) && u.startsWith(base))) {
      const path = decodeURIComponent(url.split(/[?#]/)[0] ?? '').slice(base.length);
      if (!files.includes(join(dist, path))) problems.push(`${name}: ${url} is not in the build`);
    }
  }
  if (file.endsWith('.css')) {
    const urls = [
      ...text.matchAll(/url\(\s*['"]?([^'")]*)/g),
      ...text.matchAll(/@import\s+['"]([^'"]*)/g),
    ].map((m) => m[1] ?? '');
    resources += urls.length;
    for (const url of urls.filter(external)) problems.push(`${name}: loads ${url}`);
  }
}

// --- The fonts are in the build ---

const fonts = [
  'atkinson-hyperlegible-next-latin-400-normal',
  'atkinson-hyperlegible-next-latin-500-normal',
  'atkinson-hyperlegible-next-latin-600-normal',
  'atkinson-hyperlegible-next-latin-700-normal',
  'atkinson-hyperlegible-mono-latin-400-normal',
  'atkinson-hyperlegible-mono-latin-500-normal',
  'newsreader-latin-400-normal',
];
const fontFiles = files.filter((f) => f.endsWith('.woff2')).map((f) => relative(dist, f));
for (const font of fonts) {
  if (!fontFiles.some((f) => f.startsWith(`assets/${font}.`))) problems.push(`no ${font}.woff2`);
}

process.stdout.write(
  `site-check: ${pages.length} pages, ${fragmentLinks} fragment links in the build, ${markdownFragments} in the Markdown, ${resources} resources, ${fontFiles.length} font files\n`,
);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`site-check: ${problem}\n`);
  process.exit(1);
}
