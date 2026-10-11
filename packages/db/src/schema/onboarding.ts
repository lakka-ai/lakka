import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.ts';
import { principals, workspaces } from './identity.ts';

/*
 * How people arrive: first-run setup (AD-1, ADR 0034) and invite links (ID-7, ADR 0035).
 */

/**
 * One row, written in the same transaction that creates the first instance admin and
 * workspace. Its primary key can only be true, so a second setup cannot commit: two setups
 * racing each other conflict on this insert and exactly one wins.
 */
export const instanceSetup = pgTable(
  'instance_setup',
  {
    id: boolean('id').primaryKey().default(true),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    completedByPrincipalId: uuid('completed_by_principal_id')
      .notNull()
      .references(() => principals.id),
  },
  (t) => [check('instance_setup_single_row_check', sql`${t.id}`)],
);

/**
 * A single-use link into one workspace with one role. Like API keys, only the SHA-256 digest
 * of the token is stored. The creator and the person who accepted are always users, never
 * keys, enforced with the same composite foreign key pattern as identity.ts.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique('invites_token_hash_key'),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdByKind: text('created_by_kind').generatedAlwaysAs(sql`'user'`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByPrincipalId: uuid('accepted_by_principal_id'),
    acceptedByKind: text('accepted_by_kind').generatedAlwaysAs(
      sql`case when accepted_by_principal_id is null then null else 'user' end`,
    ),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'invites_created_by_is_user_fkey',
      columns: [t.createdByPrincipalId, t.createdByKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    foreignKey({
      name: 'invites_accepted_by_is_user_fkey',
      columns: [t.acceptedByPrincipalId, t.acceptedByKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    index('invites_workspace_id_idx').on(t.workspaceId),
    check('invites_role_check', sql`${t.role} in ('admin', 'member')`),
    check('invites_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'invites_accepted_check',
      sql`(${t.acceptedAt} is null) = (${t.acceptedByPrincipalId} is null)`,
    ),
    check(
      'invites_accepted_or_revoked_check',
      sql`${t.acceptedAt} is null or ${t.revokedAt} is null`,
    ),
  ],
);

/**
 * A one-time link that lets a person choose a new password (ADR 0098). An instance admin makes
 * it, since there is no email to send a reset to. Only the digest of the token is stored, a
 * person has at most one at a time, and the row goes when the link is used.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    principalId: uuid('principal_id').notNull(),
    principalKind: text('principal_kind').generatedAlwaysAs(sql`'user'`),
    tokenHash: text('token_hash').notNull().unique('password_resets_token_hash_key'),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdByKind: text('created_by_kind').generatedAlwaysAs(sql`'user'`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('password_resets_principal_id_key').on(t.principalId),
    foreignKey({
      name: 'password_resets_principal_is_user_fkey',
      columns: [t.principalId, t.principalKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    foreignKey({
      name: 'password_resets_created_by_is_user_fkey',
      columns: [t.createdByPrincipalId, t.createdByKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('password_resets_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
