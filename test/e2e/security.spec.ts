import { expect, pressUntil, sessions, test } from './fixtures.ts';

/*
 * The page policy and the AGPL notice in a real browser (ADR 0075 H6, AD-6, ADR 0085). Every
 * other test already fails on a policy violation, since the browser reports one as a console
 * error; these check the policy itself, and that it stops an injected script.
 */

test.describe('page security (H6)', () => {
  test.use({ storageState: sessions.admin });

  test('H6: every page is sent with a nonce policy, and every script on it carries the nonce', async ({
    page,
    errors,
  }) => {
    void errors;
    const response = await page.goto('/');
    const headers = response?.headers() ?? {};
    const policy = headers['content-security-policy'] ?? '';
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(headers['x-content-type-options']).toBe('nosniff');

    const scripts = await page.evaluate(() =>
      [...document.scripts].map((s) => ({ nonce: s.nonce, src: s.src })),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script.nonce).toBe(nonce);

    // A second document gets a nonce of its own.
    const again = await page.reload();
    expect(again?.headers()['content-security-policy']).not.toContain(`'nonce-${nonce}'`);
  });

  // No `errors` fixture: the blocked handler is reported as a console error, on purpose.
  // 'strict-dynamic' lets code that is already running add scripts, by design; what the policy
  // stops is injected markup, such as the classic <img onerror> payload.
  test('H6: markup injected into the page cannot run script, and is reported as a violation', async ({
    page,
  }) => {
    await page.goto('/');
    const outcome = await page.evaluate(async () => {
      const violation = new Promise<string>((resolve) => {
        document.addEventListener('securitypolicyviolation', (e) => resolve(e.violatedDirective), {
          once: true,
        });
      });
      const box = document.createElement('div');
      box.innerHTML = '<img src="/no-such-image.png" onerror="window.injected = true">';
      document.body.append(box);
      const directive = await violation;
      // Give the handler, were it allowed, the chance to run.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { directive, ran: 'injected' in window };
    });
    expect(outcome).toEqual({ directive: 'script-src-attr', ran: false });
  });

  test('AD-6: the source link is the one the operator configured, read at runtime', async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto('/');
    // Signed in, the link is in the account menu (ADR 0107).
    await pressUntil(
      page.getByRole('button', { name: /^Account: / }),
      page.getByRole('menuitem', { name: 'Source code' }),
    );
    await expect(page.getByRole('menuitem', { name: 'Source code' })).toHaveAttribute(
      'href',
      'https://source.example.com/lakka-e2e',
    );
  });
});
