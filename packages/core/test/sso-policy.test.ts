import { describe, expect, it } from 'vitest';
import { emailDomain, mayProvision } from '../src/sso/policy.ts';

describe('SSO sign-up policy (ADR 0032)', () => {
  it('refuses new accounts by default: no policy, or sign-up off', () => {
    expect(mayProvision(undefined, 'ada@example.com')).toBe(false);
    expect(mayProvision({ allowSignUp: false, allowedEmailDomains: [] }, 'ada@example.com')).toBe(
      false,
    );
  });

  it('allows any domain when sign-up is on and no domains are listed', () => {
    expect(mayProvision({ allowSignUp: true, allowedEmailDomains: [] }, 'ada@anywhere.org')).toBe(
      true,
    );
  });

  it('allows only listed domains, case-insensitively, and never a lookalike', () => {
    const policy = { allowSignUp: true, allowedEmailDomains: ['example.com'] };
    expect(mayProvision(policy, 'Ada@EXAMPLE.com')).toBe(true);
    expect(mayProvision(policy, 'ada@evil-example.com')).toBe(false);
    expect(mayProvision(policy, 'ada@sub.example.com')).toBe(false);
    expect(mayProvision(policy, 'ada@example.com.evil.org')).toBe(false);
    expect(mayProvision(policy, 'not-an-email')).toBe(false);
  });

  it('takes the domain after the last @', () => {
    expect(emailDomain('"a@b"@example.com')).toBe('example.com');
    expect(emailDomain('@example.com')).toBeUndefined();
    expect(emailDomain('ada@')).toBeUndefined();
  });
});
