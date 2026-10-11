import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ModelCapabilities } from '@lakka/contracts';
import { uuidv7 } from '../uuid.ts';
import { principals } from './identity.ts';

/*
 * Models an instance admin added by hand, with the prices they entered (PR-7, ADR 0037). The
 * bundled catalogue lives in the image, not here. A custom model can never reuse a catalogue
 * model's id; core refuses that, because it would change what an existing model is billed.
 * Prices are integer micro-USD per million tokens, like the catalogue.
 */
const microUsd = (name: string) => bigint(name, { mode: 'number' });

export const customModels = pgTable(
  'custom_models',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    modelRef: text('model_ref').notNull().unique('custom_models_model_ref_key'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** The name people see; null to use one made from the model id. */
    displayName: text('display_name'),
    contextWindow: integer('context_window').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    capabilities: jsonb('capabilities').$type<ModelCapabilities>().notNull(),
    inputMicroUsdPerMtok: microUsd('input_micro_usd_per_mtok').notNull(),
    outputMicroUsdPerMtok: microUsd('output_micro_usd_per_mtok').notNull(),
    cacheReadMicroUsdPerMtok: microUsd('cache_read_micro_usd_per_mtok'),
    cacheWriteMicroUsdPerMtok: microUsd('cache_write_micro_usd_per_mtok'),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdByKind: text('created_by_kind').generatedAlwaysAs(sql`'user'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'custom_models_created_by_is_user_fkey',
      columns: [t.createdByPrincipalId, t.createdByKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('custom_models_ref_check', sql`${t.modelRef} = ${t.provider} || ':' || ${t.model}`),
    check(
      'custom_models_provider_check',
      sql`${t.provider} ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'`,
    ),
    check(
      'custom_models_display_name_check',
      sql`${t.displayName} is null or length(${t.displayName}) between 1 and 80`,
    ),
    check('custom_models_limits_check', sql`${t.contextWindow} > 0 and ${t.maxOutputTokens} > 0`),
    check(
      'custom_models_prices_check',
      sql`${t.inputMicroUsdPerMtok} >= 0 and ${t.outputMicroUsdPerMtok} >= 0
        and coalesce(${t.cacheReadMicroUsdPerMtok}, 0) >= 0
        and coalesce(${t.cacheWriteMicroUsdPerMtok}, 0) >= 0`,
    ),
  ],
);

/**
 * The signed price feed (PR-6, ADR 0116): one row for the instance. Off until an instance admin
 * turns it on. The newest verified feed file is kept as it was fetched, and every process
 * checks its signature again before using it, so a row edited by hand is never trusted.
 * Switching off keeps the feed and its serial, so an older feed can never be replayed after
 * switching on again; it only stops being used.
 */
export const catalogueFeed = pgTable(
  'catalogue_feed',
  {
    /** Always true: there is one row. */
    id: boolean('id').primaryKey().default(true),
    enabled: boolean('enabled').notNull().default(false),
    /** Who last turned it on or off, and when. */
    enabledBy: uuid('enabled_by'),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    /** The newest feed file that verified and passed every check, exactly as fetched. */
    envelope: text('envelope'),
    appliedSerial: integer('applied_serial'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastResult: text('last_result'),
    lastErrorCode: text('last_error_code'),
    /** Set by Check now; the worker's next run checks and clears it. */
    checkRequestedAt: timestamp('check_requested_at', { withTimezone: true }),
    /** The minute of the day (UTC) this instance checks at, so instances do not all ask at once. */
    checkMinute: integer('check_minute')
      .notNull()
      .default(sql`floor(random() * 1440)`),
  },
  (t) => [
    check('catalogue_feed_singleton_check', sql`${t.id}`),
    check('catalogue_feed_minute_check', sql`${t.checkMinute} between 0 and 1439`),
    check(
      'catalogue_feed_result_check',
      sql`${t.lastResult} is null or ${t.lastResult} in ('applied', 'unchanged', 'failed')`,
    ),
    check(
      'catalogue_feed_applied_check',
      sql`(${t.envelope} is null) = (${t.appliedSerial} is null)`,
    ),
  ],
);
