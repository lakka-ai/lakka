import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { FIRST_PARTY_KINDS, PROVIDER_KINDS } from '@lakka/contracts';
import { encryptedText } from '../crypto.ts';
import { uuidv7 } from '../uuid.ts';
import { principals, workspaces } from './identity.ts';

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/*
 * Model provider credentials (PR-1, PR-2, PR-8, ADR 0038). The API key is encrypted at rest with
 * the credential master key from the environment (ADR 0032) and never leaves the api in a
 * response. workspace_id null means instance-wide.
 *
 * A workspace credential is for a first-party provider at its standard address only: letting a
 * workspace admin choose where the server connects would let them reach addresses inside the
 * customer's network. Postgres enforces that, not only application code.
 */

export const providerConfigs = pgTable(
  'provider_configs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    kind: text('kind', { enum: PROVIDER_KINDS }).notNull(),
    /** The provider part of model references. */
    name: text('name').notNull(),
    baseUrl: text('base_url'),
    apiKey: encryptedText('api_key', 'provider_configs.api_key'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestStatus: text('last_test_status', {
      enum: ['ok', 'auth_failed', 'unreachable', 'error'],
    }),
    lastTestHttpStatus: integer('last_test_http_status'),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdByKind: text('created_by_kind').generatedAlwaysAs(sql`'user'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One credential per name per scope; null workspace_id is one scope, not many.
    unique('provider_configs_scope_name_key').on(t.workspaceId, t.name).nullsNotDistinct(),
    index('provider_configs_workspace_id_idx').on(t.workspaceId),
    foreignKey({
      name: 'provider_configs_created_by_is_user_fkey',
      columns: [t.createdByPrincipalId, t.createdByKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('provider_configs_kind_check', sql`${t.kind} in (${quoted(PROVIDER_KINDS)})`),
    check(
      'provider_configs_name_check',
      sql`case when ${t.kind} = 'openai-compatible'
        then ${t.name} ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'
          and ${t.name} not in (${quoted(FIRST_PARTY_KINDS)})
          and ${t.baseUrl} is not null
        else ${t.name} = ${t.kind} and ${t.apiKey} is not null end`,
    ),
    check(
      'provider_configs_workspace_scope_check',
      sql`${t.workspaceId} is null or (${t.kind} <> 'openai-compatible' and ${t.baseUrl} is null)`,
    ),
    check(
      'provider_configs_test_check',
      sql`(${t.lastTestedAt} is null) = (${t.lastTestStatus} is null)`,
    ),
  ],
);
