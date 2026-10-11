import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { DEFAULT_REASONS, RESOLUTION_RULES } from '@lakka/contracts';
import { uuidv7 } from '../uuid.ts';

/*
 * Usage records (BG-8, ADR 0039): one row per provider attempt that may have cost money. The
 * table is partitioned by month on created_at (the migration adds PARTITION BY, which Drizzle
 * cannot express), so retention can drop whole partitions later (M7) instead of deleting rows.
 * Partitions are created ahead of time by ensureMonthlyPartitions.
 *
 * Each row carries a copy of the prices it was charged at, so a later catalogue update never
 * re-prices past spend (ADR 0037). Principals, workspaces and credentials are referenced by id
 * without foreign keys: spend history must outlive a deleted credential, and partitioned tables
 * keep inserts cheap without them.
 *
 * Every row also carries the routing decision behind it (RT-8, RT-9, ADR 0047): the rule that
 * chose the model, the route, the classifier's confidence, why a request fell to the default,
 * and whether the user overrode a routed conversation, keeping the route and model that lost.
 * All attempts of one request carry the same decision; count requests, not rows. When a cap
 * forced a cheaper model, the model chosen first is kept too (BG-7, ADR 0053).
 */
const microUsd = (name: string) => bigint(name, { mode: 'bigint' });
const price = (name: string) => bigint(name, { mode: 'number' });

export const usage = pgTable(
  'usage',
  {
    id: uuid('id').notNull().$defaultFn(uuidv7),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    requestId: uuid('request_id').notNull(),
    attempt: smallint('attempt').notNull(),
    outcome: text('outcome', {
      enum: ['completed', 'interrupted', 'aborted', 'abandoned'],
    }).notNull(),
    surface: text('surface', { enum: ['chat', 'api', 'mcp'] }).notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    /** The principal that made the request: a person or a key. */
    principalId: uuid('principal_id').notNull(),
    /** The person whose budget and permissions apply: the key's owner, or the person. */
    actingUserId: uuid('acting_user_id').notNull(),
    /** Model reference, provider:model (ADR 0037). */
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    providerConfigId: uuid('provider_config_id'),
    inputTokens: integer('input_tokens').notNull(),
    uncachedInputTokens: integer('uncached_input_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    reasoningTokens: integer('reasoning_tokens'),
    /** True when some count is our pessimistic estimate because the provider reported none. */
    usageEstimated: boolean('usage_estimated').notNull(),
    inputMicroUsdPerMtok: price('input_micro_usd_per_mtok').notNull(),
    outputMicroUsdPerMtok: price('output_micro_usd_per_mtok').notNull(),
    cacheReadMicroUsdPerMtok: price('cache_read_micro_usd_per_mtok').notNull(),
    cacheWriteMicroUsdPerMtok: price('cache_write_micro_usd_per_mtok').notNull(),
    /** The long-context tier that applied, by its threshold, or null for the base prices. */
    priceTierAboveInputTokens: integer('price_tier_above_input_tokens'),
    costMicroUsd: microUsd('cost_micro_usd').notNull(),
    finishReason: text('finish_reason'),
    latencyMs: integer('latency_ms').notNull(),
    ttftMs: integer('ttft_ms'),
    resolutionRule: text('resolution_rule', { enum: RESOLUTION_RULES }).notNull(),
    /** The route that chose the model, or for an override the route that lost. */
    routeId: uuid('route_id'),
    routeConfidence: doublePrecision('route_confidence'),
    defaultReason: text('default_reason', { enum: DEFAULT_REASONS }),
    wasOverridden: boolean('was_overridden').notNull().default(false),
    /** For an override: the model the conversation had been routed to. */
    overriddenModel: text('overridden_model'),
    /** When a cap forced a cheaper model (BG-7): the model that was chosen first. */
    budgetFallbackFrom: text('budget_fallback_from'),
  },
  (t) => [
    // A partitioned table's primary key must include the partition key.
    primaryKey({ name: 'usage_pkey', columns: [t.id, t.createdAt] }),
    index('usage_workspace_created_idx').on(t.workspaceId, t.createdAt),
    index('usage_acting_user_created_idx').on(t.actingUserId, t.createdAt),
    index('usage_request_idx').on(t.requestId),
    check(
      'usage_outcome_check',
      sql`${t.outcome} in ('completed', 'interrupted', 'aborted', 'abandoned')`,
    ),
    check('usage_surface_check', sql`${t.surface} in ('chat', 'api', 'mcp')`),
    check(
      'usage_tokens_check',
      sql`${t.uncachedInputTokens} >= 0 and ${t.cacheReadTokens} >= 0 and ${t.cacheWriteTokens} >= 0
        and ${t.outputTokens} >= 0
        and ${t.inputTokens} = ${t.uncachedInputTokens} + ${t.cacheReadTokens} + ${t.cacheWriteTokens}`,
    ),
    check('usage_cost_check', sql`${t.costMicroUsd} >= 0`),
    check(
      'usage_resolution_rule_check',
      sql`${t.resolutionRule} in ('explicit', 'sticky', 'pinned', 'signal', 'classified', 'default')`,
    ),
    check(
      'usage_default_reason_check',
      sql`(${t.defaultReason} is null) = (${t.resolutionRule} <> 'default')
        and (${t.defaultReason} is null or ${t.defaultReason} in
          ('routing_off', 'no_routes', 'too_short', 'classifier_unavailable', 'below_threshold', 'ambiguous'))`,
    ),
    check(
      'usage_override_check',
      sql`${t.wasOverridden} = (${t.overriddenModel} is not null)
        and (not ${t.wasOverridden} or ${t.resolutionRule} = 'explicit')`,
    ),
    check(
      'usage_route_confidence_check',
      sql`${t.routeConfidence} is null or ${t.routeConfidence} between -1 and 1`,
    ),
  ],
);
