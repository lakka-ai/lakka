import { z } from 'zod';

/* OIDC identity providers (ID-2, ADR 0032). The client secret is write-only. */

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain name');

export const registerSsoProviderBody = z
  .object({
    providerId: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, 'lowercase letters, digits and hyphens')
      // Better Auth names password accounts "credential"; a provider by that name would read as one.
      .refine((id) => id !== 'credential', 'a name other than credential'),
    displayName: z.string().trim().min(1).max(100),
    issuer: z.url({ protocol: /^https?$/ }),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2000),
    allowSignUp: z.boolean().default(false),
    allowedEmailDomains: z.array(domain).max(50).default([]),
  })
  .strict();

/**
 * Editing a provider (ADR 0097). The issuer and client id stay as registered: Better Auth
 * refuses to change them once anyone has signed in, since they decide who a sign-in is. The
 * secret is replaced only when sent.
 */
export const updateSsoProviderBody = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    clientSecret: z.string().min(1).max(2000).optional(),
    allowSignUp: z.boolean(),
    allowedEmailDomains: z.array(domain).max(50),
  })
  .strict();
export type UpdateSsoProviderBody = z.infer<typeof updateSsoProviderBody>;

export const ssoProviderParams = z.object({ providerId: z.string().min(1).max(40) });

export interface SsoProviderView {
  providerId: string;
  displayName: string;
  issuer: string;
  /** Null only if Better Auth's stored settings could not be read. */
  clientId: string | null;
  /** Where the provider sends people back; the admin registers it with the provider. */
  redirectUri: string;
  allowSignUp: boolean;
  allowedEmailDomains: string[];
  createdAt: string;
  /** People who have signed in with it. */
  peopleCount: number;
  /** Of those, the ones who have no other way to sign in. */
  onlyWayCount: number;
}

/** What the sign-in page may show before anyone is signed in. */
export interface PublicSsoProvider {
  providerId: string;
  displayName: string;
}
