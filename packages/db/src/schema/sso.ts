import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { encryptedText } from '../crypto.ts';
import { authUsers } from './auth.ts';

/*
 * OIDC identity providers (ID-2, ADR 0032).
 *
 * sso_providers is Better Auth's SSO plugin table. Property names are what the plugin addresses.
 * oidc_config holds the client secret, so it is encrypted at rest; the plugin never notices.
 * saml_config exists because the plugin writes it, but SAML is not supported and its routes are
 * unreachable (CLAUDE.md, Scope). domain_verified is deliberately absent: domain verification
 * is off, so a provider's email domain can never make it trusted for account linking.
 *
 * sso_provider_policies is ours: its name, its client id, whether the provider may create new
 * accounts, and for which email domains. Without a row, or with allow_sign_up false, only existing accounts sign in.
 */

export const ssoProviders = pgTable('sso_providers', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull(),
  oidcConfig: encryptedText('oidc_config', 'sso_providers.oidc_config'),
  samlConfig: text('saml_config'),
  userId: text('user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  providerId: text('provider_id').notNull().unique('sso_providers_provider_id_key'),
  organizationId: text('organization_id'),
  domain: text('domain').notNull(),
});

export const ssoProviderPolicies = pgTable('sso_provider_policies', {
  providerId: text('provider_id')
    .primaryKey()
    .references(() => ssoProviders.providerId, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  /**
   * A copy of the client id inside oidc_config, so the admin listing can show it without
   * decrypting the secret beside it (ADR 0097). Null for providers added before it was kept,
   * until the listing first fills it in.
   */
  clientId: text('client_id'),
  allowSignUp: boolean('allow_sign_up').notNull().default(false),
  /** Lowercase email domains allowed to sign up; empty means any domain. */
  allowedEmailDomains: text('allowed_email_domains').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
