import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { LIVE_ANNOUNCER, realViolations, settled } from '../axe.ts';

export interface Account {
  id: string;
  email: string;
  name: string;
  password: string;
}

export const accounts = JSON.parse(process.env['LAKKA_E2E_ACCOUNTS'] ?? '{}') as {
  tag: string;
  admin: Account;
  member: Account;
  /** Their accounts at the stack's Keycloak (ADR 0074). */
  keycloak: Record<'admin' | 'member', { username: string; password: string }>;
};

/** Collects console errors and uncaught page errors, such as a hydration mismatch. */
export function watchErrors(page: Page, errors: string[]): void {
  page.on('console', (m) => {
    // The browser logs every 4xx response; tests assert on those responses themselves.
    if (m.type() === 'error' && !/^Failed to load resource: .*status of 4\d\d/.test(m.text())) {
      errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => errors.push(e.message));
}

/**
 * Fails the test on any console or page error. Pages a test opens itself are covered once
 * passed to watchErrors with the same array.
 */
export const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    watchErrors(page, errors);
    await use(errors);
    expect(errors, 'console and page errors').toEqual([]);
  },
});

export { expect };

/** Browser sessions saved by global setup, for test.use({ storageState }). */
export const sessions = {
  admin: 'test/e2e/.auth/admin.json',
  member: 'test/e2e/.auth/member.json',
};

/*
 * Sign-in is throttled to 3 attempts per address per 10 seconds, and the suite must not weaken
 * that (ADR 0033). Every sign-in attempt, from global setup or a test, first takes a slot here:
 * the times of recent attempts are kept in a file, so the count survives the worker restarts
 * Playwright does after a failure, and an attempt waits only as long as the limit requires.
 */
const ATTEMPTS_FILE = 'test/e2e/.auth/sign-in-attempts.json';
const THROTTLE_WINDOW_MS = 10_500;
const THROTTLE_MAX = 3;

function recentAttempts(now: number): number[] {
  try {
    const times = JSON.parse(readFileSync(ATTEMPTS_FILE, 'utf8')) as unknown;
    return Array.isArray(times)
      ? times.filter((t): t is number => typeof t === 'number' && now - t < THROTTLE_WINDOW_MS)
      : [];
  } catch {
    return [];
  }
}

/** Waits until one more sign-in attempt fits within the throttle, then records it. */
export async function awaitSignInSlot(): Promise<void> {
  const recent = recentAttempts(Date.now());
  const blocking = recent.at(-THROTTLE_MAX);
  if (recent.length >= THROTTLE_MAX && blocking !== undefined) {
    await sleep(Math.max(0, blocking + THROTTLE_WINDOW_MS - Date.now()));
  }
  mkdirSync('test/e2e/.auth', { recursive: true });
  writeFileSync(ATTEMPTS_FILE, JSON.stringify([...recentAttempts(Date.now()), Date.now()]));
}

/** Signs in through the form, within the throttle. */
export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await awaitSignInSlot();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: `Account: ${account.name}` })).toBeVisible();
}

/**
 * Waits for a workspace's settings page: the heading is the page's, and the intro names the
 * workspace.
 */
export async function expectWorkspaceSettings(page: Page, workspace: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Workspace settings', level: 1 })).toBeVisible();
  await expect(
    page.getByText(`${workspace} workspace. Its people, keys and settings.`),
  ).toBeVisible();
}

/**
 * ID-3: creates a workspace from Admin, Workspaces, with the signed-in instance admin as its
 * first admin, and opens its settings.
 */
export async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.goto('/admin/workspaces');
  const dialog = page.getByRole('dialog', { name: 'Create a workspace' });
  await pressUntil(page.getByRole('button', { name: 'Create workspace' }), dialog);
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('status').filter({ hasText: `${name} was created.` })).toBeVisible();
  await page.getByRole('link', { name, exact: true }).click();
  await expectWorkspaceSettings(page, name);
}

/** The main menu: the side menu on desktop, the drawer on a phone. */
/**
 * Presses `trigger` until `shown` is visible. Right after a page loads, a button is there,
 * server-rendered, before React has attached its handler, and a press then does nothing
 * (ADR 0044). It is pressed again only while `shown` is not visible, so a menu is not closed
 * again or a toggle undone by a second press.
 */
export async function pressUntil(trigger: Locator, shown: Locator): Promise<void> {
  await expect(async () => {
    if (!(await shown.isVisible())) await trigger.click({ timeout: 2_000 });
    await expect(shown).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

export const mainMenu = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** Signs out through the account menu. */
export async function signOut(page: Page, account: Account): Promise<void> {
  await page.getByRole('button', { name: `Account: ${account.name}` }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}

/** NF-A1: no serious or critical WCAG 2.1 A/AA violations on the current page. */
export async function expectAccessible(page: Page): Promise<void> {
  // Measure the settled page, not a dialog halfway through fading in.
  await settled(page);
  const results = await new AxeBuilder({ page })
    .exclude(LIVE_ANNOUNCER)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = realViolations(results)
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id}: ${v.help} at ${v.nodes.map((n) => `${n.target.join(' ')} [${n.failureSummary?.split('\n').at(-1)?.trim() ?? ''}]`).join('; ')}`,
    );
  expect(serious).toEqual([]);
}
