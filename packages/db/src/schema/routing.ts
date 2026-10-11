import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  doublePrecision,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.ts';
import { embedding } from '../vector.ts';
import { principals, workspaces } from './identity.ts';

/*
 * Routing policy (tech spec, Data model: Policy; RT-1, RT-2, RT-5; ADR 0042). Routes belong to a
 * workspace; examples keep the text an admin typed so the policy stays readable and editable, and
 * both examples and centroids keep their embedding with the model that produced it (pgvector).
 * Centroids are computed when a policy is saved, never per request. A route with no examples
 * gets its centroid from its name and description (RT-12, ADR 0122), and says so in `source`.
 */

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    model: text('model').notNull(),
    fallbacks: text('fallbacks')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    allowCrossProvider: boolean('allow_cross_provider').notNull().default(false),
    /** Similarity needed to route to a model cheaper than the workspace default (RT-5). */
    thresholdDown: doublePrecision('threshold_down').notNull(),
    /** Similarity needed to route to a model as expensive or pricier. */
    thresholdUp: doublePrecision('threshold_up').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    signals: text('signals')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdByKind: text('created_by_kind').generatedAlwaysAs(sql`'user'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('routes_workspace_name_key').on(t.workspaceId, t.name),
    index('routes_workspace_id_idx').on(t.workspaceId),
    foreignKey({
      name: 'routes_created_by_is_user_fkey',
      columns: [t.createdByPrincipalId, t.createdByKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('routes_name_check', sql`${t.name} ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'`),
    // RT-5 in the schema: the cheaper direction never needs less confidence than the other.
    check(
      'routes_thresholds_check',
      sql`${t.thresholdUp} > 0 and ${t.thresholdDown} <= 1 and ${t.thresholdDown} >= ${t.thresholdUp}`,
    ),
    check('routes_fallbacks_check', sql`cardinality(${t.fallbacks}) <= 5`),
    check('routes_signals_check', sql`${t.signals} <@ array['code_fence', 'code_file']::text[]`),
  ],
);

export const routeExamples = pgTable(
  'route_examples',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    routeId: uuid('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    text: text('text').notNull(),
    /** The order the admin gave, so the policy reads back as it was written. */
    position: integer('position').notNull(),
    embedding: embedding('embedding'),
    embeddingModel: text('embedding_model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('route_examples_route_text_key').on(t.routeId, t.text),
    index('route_examples_workspace_id_idx').on(t.workspaceId),
    check('route_examples_text_check', sql`length(${t.text}) between 1 and 1000`),
    check(
      'route_examples_embedding_check',
      sql`(${t.embedding} is null) = (${t.embeddingModel} is null)`,
    ),
  ],
);

export const routeCentroids = pgTable(
  'route_centroids',
  {
    routeId: uuid('route_id')
      .primaryKey()
      .references(() => routes.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    embedding: embedding('embedding').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    exampleCount: integer('example_count').notNull(),
    source: text('source').notNull().default('examples'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('route_centroids_workspace_id_idx').on(t.workspaceId),
    // A description centroid comes from no examples; the other two from at least one, which
    // example_count counts without the description (ADR 0125).
    check(
      'route_centroids_source_check',
      sql`(${t.source} in ('examples', 'examples_and_description') and ${t.exampleCount} > 0) or (${t.source} = 'description' and ${t.exampleCount} = 0)`,
    ),
  ],
);
