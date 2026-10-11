import { boolean, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { encryptedText } from '../crypto.ts';

/*
 * Better Auth's tables (ADR 0028). Property names are the field names Better Auth addresses;
 * column names follow our snake_case convention. Better Auth checks at startup that these match
 * what its configuration writes (advanced.database.validateSchema), and refuses to serve if not.
 *
 * Better Auth owns these rows. Our identity lives in principals, linked through
 * principals.auth_subject = auth_users.id.
 *
 * Sensitive columns: auth_sessions.token (a bearer secret), auth_accounts.password (a scrypt
 * hash) and the OAuth tokens on auth_accounts (all encrypted, see idToken). None of them are ever returned by our API or
 * logged (CLAUDE.md invariant 9).
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique('auth_users_email_key'),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique('auth_sessions_token_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (t) => [index('auth_sessions_user_id_idx').on(t.userId)],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    // Better Auth encrypts access and refresh tokens (encryptOAuthTokens) but not the ID token,
    // which carries the person's identity claims; we encrypt it at rest (ADR 0032).
    idToken: encryptedText('id_token', 'auth_accounts.id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('auth_accounts_user_id_idx').on(t.userId),
    unique('auth_accounts_provider_account_key').on(t.providerId, t.accountId),
  ],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);
