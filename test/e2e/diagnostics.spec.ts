import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts, expect, expectAccessible, sessions, test } from './fixtures.ts';

/*
 * The diagnostics bundle from the browser (AD-3, AC 17, ADR 0083): an instance admin downloads
 * it from the Diagnostics page, and it holds none of the suite's passwords or emails. Who may
 * download it is tested against the api directly (apps/api/test/diagnostics.integration.test.ts).
 */

test.describe('diagnostics (AD-3)', () => {
  test.use({ storageState: sessions.admin });

  test('AD-3, AC 17: an admin downloads the bundle, and it holds no password or email', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/');
    await page.getByRole('link', { name: 'Diagnostics' }).click();
    await expect(page.getByRole('heading', { name: 'Diagnostics', level: 1 })).toBeVisible();
    await expect(page.getByText(/Credentials are removed/)).toBeVisible();
    await expectAccessible(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Download diagnostics bundle' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^lakka-diagnostics-[0-9T-]+Z\.tar\.gz$/);
    const dir = mkdtempSync(join(tmpdir(), 'lakka-e2e-diagnostics-'));
    try {
      const file = join(dir, 'bundle.tar.gz');
      await download.saveAs(file);
      execFileSync('tar', ['-xzf', file, '-C', dir]);
      const inner = join(dir, 'lakka-diagnostics');
      const all = readdirSync(inner)
        .map((name) => readFileSync(join(inner, name), 'utf8'))
        .join('\n');
      expect(JSON.parse(readFileSync(join(inner, 'health.json'), 'utf8'))).toMatchObject({
        checks: { database: { status: 'ok' }, cache: { status: 'ok' } },
      });
      for (const value of [
        accounts.admin.password,
        accounts.member.password,
        accounts.admin.email,
        accounts.member.email,
      ]) {
        expect(all.includes(value)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
