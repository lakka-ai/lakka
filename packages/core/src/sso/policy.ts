/*
 * Whether an identity provider may create a new account for an email address (ADR 0032). Pure,
 * so it is unit-tested. New accounts are refused unless the provider's policy allows sign-up,
 * and, when it lists email domains, the address is in one of them.
 */

export interface SignUpPolicy {
  allowSignUp: boolean;
  allowedEmailDomains: readonly string[];
}

export function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return undefined;
  return email.slice(at + 1).toLowerCase();
}

export function mayProvision(policy: SignUpPolicy | undefined, email: string): boolean {
  if (policy === undefined || !policy.allowSignUp) return false;
  if (policy.allowedEmailDomains.length === 0) return true;
  const domain = emailDomain(email);
  return domain !== undefined && policy.allowedEmailDomains.includes(domain);
}
