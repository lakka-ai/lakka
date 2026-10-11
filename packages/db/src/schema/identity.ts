import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.ts';
import { authUsers } from './auth.ts';

/*
 * Identity (tech spec, Data model: Identity; ID-1, ID-3, ID-4, ID-5; ADR 0027).
 *
 * A principal is a person (kind 'user') or an API key (kind 'key'). A key is a delegation: it
 * points at the user who owns it through owner_principal_id, and permissions always resolve
 * through that link (CLAUDE.md invariant 2, NF-S2).
 *
 * The rules that make delegation safe are enforced by Postgres, not only by application code:
 *   - a key has an owner and a user does not (check)
 *   - the owner is a user, never another key (composite foreign key onto (id, kind))
 *   - only users are workspace members (composite foreign key)
 *   - an api_keys row belongs to a key principal (composite foreign key)
 * The composite keys work by pairing the referencing column with a generated column that is the
 * constant kind the target must have, and pointing both at the unique (id, kind) of principals.
 *
 * Better Auth's own tables (schema/auth.ts) link to principals through auth_subject. A principal
 * is created only after its Better Auth user is committed (ADR 0028).
 */

export const PRINCIPAL_STATUSES = ['active', 'suspended', 'deleted'] as const;
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const principals = pgTable(
  'principals',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    kind: text('kind', { enum: ['user', 'key'] }).notNull(),
    displayName: text('display_name').notNull(),
    /** Users only. Unique regardless of case. */
    email: text('email'),
    /** Users only: the Better Auth user id this principal signs in as. */
    authSubject: text('auth_subject')
      .unique('principals_auth_subject_key')
      .references(() => authUsers.id),
    /** Keys only: the user this key acts for. */
    ownerPrincipalId: uuid('owner_principal_id'),
    ownerKind: text('owner_kind').generatedAlwaysAs(
      sql`case when owner_principal_id is null then null else 'user' end`,
    ),
    /** ID-3: instance admin is a property of a person, not of a workspace membership. */
    isInstanceAdmin: boolean('is_instance_admin').notNull().default(false),
    status: text('status', { enum: PRINCIPAL_STATUSES }).notNull().default('active'),
    /**
     * NF-P4, ADR 0082: a deleted person, or one of their keys, stays as a tombstone with no name
     * or email, so the spend and audit records that point at it stay whole.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByPrincipalId: uuid('deleted_by_principal_id'),
    /**
     * Users only: when they last signed in or made a request, themselves or through a key, to
     * within a few minutes (ADR 0097). Kept through suspension and retention, unlike sessions
     * and usage rows.
     */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('principals_id_kind_key').on(t.id, t.kind),
    foreignKey({
      name: 'principals_owner_is_user_fkey',
      columns: [t.ownerPrincipalId, t.ownerKind],
      foreignColumns: [t.id, t.kind],
    }),
    uniqueIndex('principals_email_lower_key')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    index('principals_owner_principal_id_idx').on(t.ownerPrincipalId),
    check('principals_kind_check', sql`${t.kind} in ('user', 'key')`),
    check('principals_status_check', sql`${t.status} in ('active', 'suspended', 'deleted')`),
    check(
      'principals_deleted_check',
      sql`(${t.status} = 'deleted') = (${t.deletedAt} is not null)
        and (${t.deletedAt} is null) = (${t.deletedByPrincipalId} is null)`,
    ),
    check(
      'principals_key_has_owner_check',
      sql`(${t.kind} = 'key') = (${t.ownerPrincipalId} is not null)`,
    ),
    // A person has an email until they are deleted; a key never has one.
    check(
      'principals_user_has_email_check',
      sql`case when ${t.kind} = 'user' then ${t.email} is not null or ${t.status} = 'deleted'
        else ${t.email} is null end`,
    ),
    check(
      'principals_key_fields_check',
      sql`${t.kind} = 'user' or (${t.authSubject} is null and not ${t.isInstanceAdmin})`,
    ),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique('workspaces_slug_key'),
    /** Chosen when routing finds no better match (RT-6). */
    defaultModel: text('default_model'),
    /** RT-11: with routing off, requests use the pinned or default model only. */
    routingEnabled: boolean('routing_enabled').notNull().default(true),
    /** When set, every request uses this model unless the user chose one (RT-3). */
    pinnedModel: text('pinned_model'),
    /** Goes up on every routing policy change, so cached snapshots know they are stale. */
    policyVersion: integer('policy_version').notNull().default(0),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** Whether prompts and replies are recorded for troubleshooting; off unless opted in (OB-4). */
    contentCapture: boolean('content_capture').notNull().default(false),
    /** How long recorded content is kept, in days (ADR 0075 Q1). */
    contentRetentionDays: integer('content_retention_days').notNull().default(7),
    /** Who last changed the capture setting, and when (NF-P3). */
    contentCaptureChangedAt: timestamp('content_capture_changed_at', { withTimezone: true }),
    contentCaptureChangedBy: uuid('content_capture_changed_by'),
    /**
     * ID-8, ADR 0104: a deleted workspace stays as a tombstone, so the usage, reservations and
     * audit rows that point at it stay whole. Every lookup treats it as missing.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByPrincipalId: uuid('deleted_by_principal_id'),
    /** When the purge job finished removing its content, caps and routes. */
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('workspaces_slug_check', sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`),
    check(
      'workspaces_deleted_check',
      sql`(${t.deletedAt} is null) = (${t.deletedByPrincipalId} is null)
        and (${t.purgedAt} is null or ${t.deletedAt} is not null)`,
    ),
    // The purge job looks for deleted workspaces it has not finished with.
    index('workspaces_unpurged_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null and ${t.purgedAt} is null`),
    check('workspaces_name_check', sql`length(trim(${t.name})) between 1 and 100`),
    check('workspaces_content_retention_check', sql`${t.contentRetentionDays} between 1 and 90`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    principalId: uuid('principal_id').notNull(),
    principalKind: text('principal_kind').generatedAlwaysAs(sql`'user'`),
    /** ID-3: workspace admin or member. Instance admin lives on principals. */
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // ID-4: one row per person per workspace; a person can be in many workspaces.
    primaryKey({ name: 'memberships_pkey', columns: [t.workspaceId, t.principalId] }),
    foreignKey({
      name: 'memberships_principal_is_user_fkey',
      columns: [t.principalId, t.principalKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    index('memberships_principal_id_idx').on(t.principalId),
    check('memberships_role_check', sql`${t.role} in ('admin', 'member')`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    /** The key's own principal (kind 'key'), which carries the owner link. */
    principalId: uuid('principal_id').notNull().unique('api_keys_principal_id_key'),
    principalKind: text('principal_kind').generatedAlwaysAs(sql`'key'`),
    /** ID-5: a key is scoped to exactly one workspace. */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** SHA-256 of the secret, hex. The secret itself is shown once and never stored. */
    hash: text('hash').notNull().unique('api_keys_hash_key'),
    /** First characters of the secret, safe to display so people can tell keys apart. */
    prefix: text('prefix').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'api_keys_principal_is_key_fkey',
      columns: [t.principalId, t.principalKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    index('api_keys_workspace_id_idx').on(t.workspaceId),
    check('api_keys_hash_check', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
  ],
);
