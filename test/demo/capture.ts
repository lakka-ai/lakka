import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/*
 * Screenshots, the social card and the demo video for the tour (docs/guide/tour.md, ADR 0128),
 * from the demo stack after `pnpm demo:seed`. Each screen is taken in light and dark at twice the
 * pixel density, and written as WebP by the same browser, so no image library is needed.
 *
 * The browser reaches the stack as ai.nordlys.example, the address the stack is told it has, by
 * mapping that name to the published port: the screenshots never show a localhost address.
 */

const PORT = process.env['LAKKA_HTTP_PORT'] ?? '8090';
const BASE = 'http://ai.nordlys.example';
const TOUR_DIR = 'docs/guide/tour';
const SITE_PUBLIC = 'apps/site/public';
const WORK_DIR = 'test/demo/.output';

const say = (line: string) => process.stdout.write(`${line}\n`);

interface State {
  admin: { email: string; password: string };
  member: { email: string; password: string };
  workspaces: { product: string; support: string; design: string };
  conversations: Record<string, string>;
  movedRequest: string;
  refusedRequest: string;
}
const state = JSON.parse(readFileSync('test/demo/.state.json', 'utf8')) as State;
const { product, support } = state.workspaces;

/** The follow-up message the video sends; matched by the demo server's reply. */
const VIDEO_PROMPT = [
  'Same debounce question for the filter box, is this one fine?',
  '',
  '```ts',
  'useEffect(() => {',
  '  setTimeout(() => onFilter(filter), 250);',
  '}, [filter]);',
  '```',
].join('\n');

type Theme = 'light' | 'dark';

interface Shot {
  name: string;
  path: string;
  as: 'admin' | 'member';
  /** Runs after the page loads, before the picture: open a tab, scroll, send a message. */
  prepare?: (page: Page) => Promise<void>;
  /** Only part of the page, when the whole would be mostly empty. */
  clip?: (page: Page) => Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Runs after the picture, so the next run starts from the same state. */
  cleanup?: (page: Page) => Promise<void>;
}

// Product's pages come before Support's: the workspace switcher shows the one used last.
const SHOTS: Shot[] = [
  { name: 'sign-in', path: '/sign-in', as: 'admin' },
  {
    name: 'chat-cheaper-model',
    path: `/workspaces/${product}/chat?c=${state.conversations['review'] ?? ''}`,
    as: 'admin',
  },
  { name: 'routing', path: `/workspaces/${product}/routing`, as: 'admin' },
  { name: 'budgets', path: `/workspaces/${product}/spend/budgets`, as: 'admin' },
  { name: 'spend-report', path: `/workspaces/${product}/spend`, as: 'admin' },
  { name: 'requests', path: `/workspaces/${product}/requests`, as: 'admin' },
  { name: 'trace', path: `/workspaces/${product}/requests/${state.movedRequest}`, as: 'admin' },
  { name: 'workspace', path: `/workspaces/${product}`, as: 'admin', prepare: showKeys },
  { name: 'people', path: '/admin/people', as: 'admin' },
  { name: 'providers', path: '/admin/models/providers', as: 'admin' },
  { name: 'instance-spend', path: '/admin/spend', as: 'admin' },
  {
    name: 'chat-tool-approval',
    path: `/workspaces/${support}/chat`,
    as: 'member',
    prepare: askForApproval,
    cleanup: forgetConversation,
  },
  { name: 'tools', path: `/workspaces/${support}/tools`, as: 'admin' },
];

async function launch(): Promise<Browser> {
  return chromium.launch({
    args: [`--host-resolver-rules=MAP ai.nordlys.example 127.0.0.1:${PORT}`],
  });
}

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  // Let entering transitions finish, and the caret blink out of view.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
}

/** A new conversation in Support that stops at the approval card. */
async function askForApproval(page: Page): Promise<void> {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.waitFor();
  await message.fill('Find the open tickets about the invoice export and close any duplicates.');
  await message.press('Enter');
  await page.getByRole('region', { name: /^Allow .* to run\?$/ }).waitFor({ timeout: 30_000 });
  await page.locator('textarea').evaluate((el) => (el as HTMLElement).blur());
}

/** Workspace settings scrolled to its API keys, the part the tour talks about. */
async function showKeys(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'API keys' }).evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -120);
  });
}

/** Deletes the conversation the page has open, so it never shows in a later screenshot. */
async function forgetConversation(page: Page): Promise<void> {
  const id = new URL(page.url()).searchParams.get('c');
  if (id === null) throw new Error('no conversation is open');
  const status = await page.evaluate(
    async (path) => (await fetch(path, { method: 'DELETE' })).status,
    `/api/workspaces/${support}/conversations/${id}`,
  );
  if (status >= 300) throw new Error(`deleting the conversation answered ${status}`);
}

/** PNG bytes to WebP, encoded by Chromium's own canvas. */
async function toWebp(page: Page, png: Buffer): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', 0.92);
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function contextFor(
  browser: Browser,
  theme: Theme,
  who: State['admin'],
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  await signIn(await context.newPage(), who);
  return context;
}

async function screenshots(browser: Browser): Promise<void> {
  const encoder = await (await browser.newContext()).newPage();
  for (const theme of ['light', 'dark'] as const) {
    const contexts = {
      admin: await contextFor(browser, theme, state.admin),
      member: await contextFor(browser, theme, state.member),
    };
    const signedOut = await browser.newContext({
      baseURL: BASE,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    for (const shot of SHOTS) {
      const context = shot.name === 'sign-in' ? signedOut : contexts[shot.as];
      const page = await context.newPage();
      await page.goto(shot.path);
      await settle(page);
      await shot.prepare?.(page);
      await settle(page);
      const clip = (await shot.clip?.(page)) ?? undefined;
      const png = await page.screenshot(clip === undefined ? {} : { clip });
      writeFileSync(`${WORK_DIR}/${shot.name}-${theme}.png`, png);
      writeFileSync(`${TOUR_DIR}/${shot.name}-${theme}.webp`, await toWebp(encoder, png));
      await shot.cleanup?.(page);
      await page.close();
      say(`${shot.name} (${theme})`);
    }
    await Promise.all([contexts.admin.close(), contexts.member.close(), signedOut.close()]);
  }
}

/** The social card: the product's line beside the cheaper-model chat, 1200 by 630. */
async function socialCard(browser: Browser): Promise<void> {
  const shot = readFileSync(`${WORK_DIR}/chat-cheaper-model-light.png`).toString('base64');
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.goto(`${BASE}/sign-in`);
  // Drawn on the app's own origin with its own stylesheets, so the card uses the app's fonts;
  // the colours are the light theme's.
  const sheets = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => l.href),
  );
  await page.setContent(`<!doctype html>
<html data-theme="light"><head><meta charset="utf-8">
${sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<style>
  body { margin: 0; width: 1200px; height: 630px; overflow: hidden; display: grid;
    grid-template-columns: 430px 1fr; background: #F3F5F4; color: #212423;
    font-family: var(--font-sans); }
  .text { padding: 64px 0 56px 64px; display: flex; flex-direction: column; }
  .name { font-family: var(--font-serif); font-size: 72px; line-height: 1; margin: 0 0 28px; }
  .line { font-size: 30px; line-height: 1.3; margin: 0 0 24px; }
  .promise { font-size: 21px; line-height: 1.45; color: #5D615F; margin: 0; }
  .foot { margin-top: auto; font-size: 19px; color: #2A5245; }
  .shot { margin: 48px 0 0 8px; border-radius: 14px 0 0 0; overflow: hidden;
    box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 18px 40px rgba(0,0,0,.12); }
  .shot { align-self: start; }
  /* Only the chat column: the notice and the budget chip are what the card is about. */
  .shot img { width: 1205px; max-width: none; margin-left: -435px; display: block; }
</style></head><body>
  <div class="text">
    <p class="name">Lakka</p>
    <p class="line">A self-hosted AI control plane for teams</p>
    <p class="promise">Spend cannot pass a cap. Every request is traced. Tools act only as the person asking.</p>
    <p class="foot">Free software under the AGPL-3.0</p>
  </div>
  <div class="shot"><img src="data:image/png;base64,${shot}" alt=""></div>
</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SITE_PUBLIC}/og.png` });
  await page.close();
  say('social card');
}

/** About fifteen seconds: a code question at the cap, moved to a cheaper model as it is sent. */
async function video(browser: Browser): Promise<void> {
  const signedIn = await contextFor(browser, 'light', state.admin);
  const storageState = await signedIn.storageState();
  await signedIn.close();
  const dir = `${WORK_DIR}/video`;
  rmSync(dir, { recursive: true, force: true });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    storageState,
    recordVideo: { dir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  await page.goto(`/workspaces/${product}/chat?c=${state.conversations['review'] ?? ''}`);
  await settle(page);
  await page.waitForTimeout(1200);
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.click();
  await message.pressSequentially(VIDEO_PROMPT.split('\n')[0] ?? '', { delay: 35 });
  await message.fill(VIDEO_PROMPT);
  await page.waitForTimeout(500);
  await message.press('Enter');
  // The reply streams, then says which model answered and why.
  await page.getByRole('button', { name: 'Send' }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3500);
  const file = await page.video()?.path();
  await context.close();
  if (file === undefined) throw new Error('no video was recorded');
  renameSync(file, `${TOUR_DIR}/cheaper-model.webm`);
  say('video');
}

const only = process.argv.slice(2);
mkdirSync(TOUR_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });
const browser = await launch();
try {
  if (only.length === 0 || only.includes('screens')) await screenshots(browser);
  if (only.length === 0 || only.includes('card')) await socialCard(browser);
  if (only.length === 0 || only.includes('video')) await video(browser);
} finally {
  await browser.close();
}
