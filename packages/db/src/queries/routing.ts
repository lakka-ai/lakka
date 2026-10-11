import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { CandidateGoneError, MAX_CANDIDATES_PER_GROUP, RouteExistsError } from '@lakka/contracts';
import type {
  BudgetPeriod,
  BudgetScope,
  CentroidSource,
  RouteBody,
  RoutingSettingsBody,
  RoutingSignal,
} from '@lakka/contracts';
import type { Db } from '../client.ts';
import { budgets } from '../schema/budgets.ts';
import { messages, routeCandidateDecisions } from '../schema/conversations.ts';
import { workspaces } from '../schema/identity.ts';
import { mcpServers, workspaceTools } from '../schema/mcp.ts';
import { spanContent } from '../schema/observability.ts';
import { providerConfigs } from '../schema/providers.ts';
import { routeCentroids, routeExamples, routes } from '../schema/routing.ts';
import { usage } from '../schema/usage.ts';

/*
 * Routing policy data access (RT-1, RT-2, RT-11, ADR 0042). Everything is scoped by workspace.
 * Every write bumps the workspace's policy_version in the same transaction, so a cached policy
 * snapshot can tell it is stale with one primary-key read.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface RoutingSettingsRow {
  routingEnabled: boolean;
  defaultModel: string | null;
  pinnedModel: string | null;
  policyVersion: number;
}

export interface RouteRow {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  model: string;
  fallbacks: string[];
  allowCrossProvider: boolean;
  thresholdDown: number;
  thresholdUp: number;
  enabled: boolean;
  signals: RoutingSignal[];
  createdAt: Date;
  updatedAt: Date;
  examples: string[];
  centroid: {
    embeddingModel: string;
    exampleCount: number;
    source: CentroidSource;
    computedAt: Date;
  } | null;
}

function isNameTaken(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint' in current &&
      current.constraint === 'routes_workspace_name_key'
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function bumpPolicyVersion(tx: Tx, workspaceId: string): Promise<void> {
  await tx
    .update(workspaces)
    .set({ policyVersion: sql`${workspaces.policyVersion} + 1` })
    .where(eq(workspaces.id, workspaceId));
}

export async function findRoutingSettings(
  db: Db,
  workspaceId: string,
): Promise<RoutingSettingsRow | undefined> {
  const [row] = await db
    .select({
      routingEnabled: workspaces.routingEnabled,
      defaultModel: workspaces.defaultModel,
      pinnedModel: workspaces.pinnedModel,
      policyVersion: workspaces.policyVersion,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row;
}

export async function updateRoutingSettings(
  db: Db,
  workspaceId: string,
  settings: RoutingSettingsBody,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({
        routingEnabled: settings.routingEnabled,
        defaultModel: settings.defaultModel,
        pinnedModel: settings.pinnedModel,
      })
      .where(eq(workspaces.id, workspaceId));
    await bumpPolicyVersion(tx, workspaceId);
  });
}

export async function listRoutes(db: Db, workspaceId: string): Promise<RouteRow[]> {
  const rows = await db
    .select({
      id: routes.id,
      workspaceId: routes.workspaceId,
      name: routes.name,
      description: routes.description,
      model: routes.model,
      fallbacks: routes.fallbacks,
      allowCrossProvider: routes.allowCrossProvider,
      thresholdDown: routes.thresholdDown,
      thresholdUp: routes.thresholdUp,
      enabled: routes.enabled,
      signals: routes.signals,
      createdAt: routes.createdAt,
      updatedAt: routes.updatedAt,
      centroidModel: routeCentroids.embeddingModel,
      centroidCount: routeCentroids.exampleCount,
      centroidSource: routeCentroids.source,
      centroidAt: routeCentroids.computedAt,
    })
    .from(routes)
    .leftJoin(routeCentroids, eq(routeCentroids.routeId, routes.id))
    .where(eq(routes.workspaceId, workspaceId))
    .orderBy(asc(routes.name));
  const examples = await db
    .select({ routeId: routeExamples.routeId, text: routeExamples.text })
    .from(routeExamples)
    .where(eq(routeExamples.workspaceId, workspaceId))
    .orderBy(asc(routeExamples.position));
  const byRoute = Map.groupBy(examples, (e) => e.routeId);
  return rows.map(({ centroidModel, centroidCount, centroidSource, centroidAt, ...route }) => ({
    ...route,
    signals: route.signals as RoutingSignal[],
    examples: (byRoute.get(route.id) ?? []).map((e) => e.text),
    centroid:
      centroidModel === null ||
      centroidCount === null ||
      centroidSource === null ||
      centroidAt === null
        ? null
        : {
            embeddingModel: centroidModel,
            exampleCount: centroidCount,
            // The column's check constraint allows only these values.
            source: centroidSource as CentroidSource,
            computedAt: centroidAt,
          },
  }));
}

const routeValues = (input: RouteBody) => ({
  name: input.name,
  description: input.description,
  model: input.model,
  fallbacks: input.fallbacks,
  allowCrossProvider: input.allowCrossProvider,
  thresholdDown: input.thresholdDown,
  thresholdUp: input.thresholdUp,
  enabled: input.enabled,
  signals: input.signals,
});

const distinct = (texts: string[]) => [...new Set(texts)];

/** Candidates a route save started from, to mark added with it (RT-10, ADR 0114). */
export interface FromCandidates {
  messageIds: readonly string[];
  decidedBy: string;
}

export async function insertRoute(
  db: Db,
  workspaceId: string,
  input: RouteBody,
  createdByPrincipalId: string,
  candidates?: FromCandidates,
): Promise<string> {
  try {
    return await db.transaction(async (tx) => {
      if (candidates !== undefined) await requireLiveCandidates(tx, workspaceId, candidates);
      const [route] = await tx
        .insert(routes)
        .values({ ...routeValues(input), workspaceId, createdByPrincipalId })
        .returning({ id: routes.id });
      if (route === undefined) throw new Error('route insert returned nothing');
      const texts = distinct(input.examples);
      if (texts.length > 0) {
        await tx
          .insert(routeExamples)
          .values(
            texts.map((text, position) => ({ routeId: route.id, workspaceId, text, position })),
          );
      }
      if (candidates !== undefined) {
        await decideCandidates(tx, workspaceId, candidates, 'added', route.id);
      }
      await bumpPolicyVersion(tx, workspaceId);
      return route.id;
    });
  } catch (error) {
    if (isNameTaken(error))
      throw new RouteExistsError('a route with this name already exists', { cause: error });
    throw error;
  }
}

/**
 * Replaces a route's settings and examples. Examples whose text is unchanged keep their
 * embeddings; if the set of examples changed, the centroid is dropped until it is recompiled,
 * and so it is when the name or description changed and the route has a description before or
 * after, since the description is part of the centroid then (ADR 0122, ADR 0125).
 * Returns false if there is no such route in the workspace. Candidates the examples started from
 * are marked added in the same transaction, or nothing changes (CandidateGoneError).
 */
export async function updateRoute(
  db: Db,
  workspaceId: string,
  routeId: string,
  input: RouteBody,
  candidates?: FromCandidates,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      if (candidates !== undefined) await requireLiveCandidates(tx, workspaceId, candidates);
      const [before] = await tx
        .select({ name: routes.name, description: routes.description })
        .from(routes)
        .where(and(eq(routes.workspaceId, workspaceId), eq(routes.id, routeId)));
      const updated = await tx
        .update(routes)
        .set({ ...routeValues(input), updatedAt: sql`now()` })
        .where(and(eq(routes.workspaceId, workspaceId), eq(routes.id, routeId)))
        .returning({ id: routes.id });
      if (updated.length === 0) return false;
      const texts = distinct(input.examples);
      const inRoute = and(
        eq(routeExamples.workspaceId, workspaceId),
        eq(routeExamples.routeId, routeId),
      );
      const removed = await tx
        .delete(routeExamples)
        .where(texts.length === 0 ? inRoute : and(inRoute, notInArray(routeExamples.text, texts)))
        .returning({ id: routeExamples.id });
      const existing = await tx
        .select({ text: routeExamples.text })
        .from(routeExamples)
        .where(inRoute);
      const have = new Set(existing.map((e) => e.text));
      const added = texts.filter((text) => !have.has(text));
      if (added.length > 0) {
        await tx
          .insert(routeExamples)
          .values(
            added.map((text) => ({ routeId, workspaceId, text, position: texts.indexOf(text) })),
          );
      }
      // Kept examples take their new place in the admin's order.
      for (const [position, text] of texts.entries()) {
        if (have.has(text)) {
          await tx
            .update(routeExamples)
            .set({ position })
            .where(and(inRoute, eq(routeExamples.text, text)));
        }
      }
      const ofRoute = and(
        eq(routeCentroids.workspaceId, workspaceId),
        eq(routeCentroids.routeId, routeId),
      );
      if (removed.length > 0 || added.length > 0) {
        await tx.delete(routeCentroids).where(ofRoute);
      } else if (
        (before?.name !== input.name || before.description !== input.description) &&
        ((before?.description.trim() ?? '') !== '' || input.description.trim() !== '')
      ) {
        // The described text changed (describedRouteText), or a description came or went.
        await tx.delete(routeCentroids).where(ofRoute);
      }
      if (candidates !== undefined) {
        await decideCandidates(tx, workspaceId, candidates, 'added', routeId);
      }
      await bumpPolicyVersion(tx, workspaceId);
      return true;
    });
  } catch (error) {
    if (isNameTaken(error))
      throw new RouteExistsError('a route with this name already exists', { cause: error });
    throw error;
  }
}

export async function deleteRoute(db: Db, workspaceId: string, routeId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(routes)
      .where(and(eq(routes.workspaceId, workspaceId), eq(routes.id, routeId)))
      .returning({ id: routes.id });
    if (deleted.length === 0) return false;
    await bumpPolicyVersion(tx, workspaceId);
    return true;
  });
}

/** Names of provider credentials a request in this workspace can use: its own and the instance's. */
export async function listUsableProviderNames(db: Db, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ name: providerConfigs.name })
    .from(providerConfigs)
    .where(or(eq(providerConfigs.workspaceId, workspaceId), isNull(providerConfigs.workspaceId)));
  return new Set(rows.map((r) => r.name));
}

/** Examples of these routes that have no embedding from `model` yet, for compiling. */
export async function listExamplesToEmbed(
  db: Db,
  workspaceId: string,
  routeIds: string[],
  model: string,
): Promise<{ id: string; routeId: string; text: string }[]> {
  if (routeIds.length === 0) return [];
  return db
    .select({ id: routeExamples.id, routeId: routeExamples.routeId, text: routeExamples.text })
    .from(routeExamples)
    .where(
      and(
        eq(routeExamples.workspaceId, workspaceId),
        inArray(routeExamples.routeId, routeIds),
        or(isNull(routeExamples.embeddingModel), sql`${routeExamples.embeddingModel} <> ${model}`),
      ),
    );
}

/** Stores example embeddings produced by `model`. Scoped by workspace. */
export async function saveExampleEmbeddings(
  db: Db,
  workspaceId: string,
  items: { id: string; embedding: number[] }[],
  model: string,
): Promise<void> {
  if (items.length === 0) return;
  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx
        .update(routeExamples)
        .set({ embedding: item.embedding, embeddingModel: model })
        .where(and(eq(routeExamples.workspaceId, workspaceId), eq(routeExamples.id, item.id)));
    }
  });
}

/** Example embeddings from `model`, per route, for computing centroids. */
export async function listExampleEmbeddings(
  db: Db,
  workspaceId: string,
  model: string,
): Promise<Map<string, number[][]>> {
  const rows = await db
    .select({ routeId: routeExamples.routeId, embedding: routeExamples.embedding })
    .from(routeExamples)
    .where(and(eq(routeExamples.workspaceId, workspaceId), eq(routeExamples.embeddingModel, model)))
    .orderBy(asc(routeExamples.position));
  const byRoute = new Map<string, number[][]>();
  for (const row of rows) {
    if (row.embedding === null) continue;
    byRoute.set(row.routeId, [...(byRoute.get(row.routeId) ?? []), row.embedding]);
  }
  return byRoute;
}

/** One route's examples with their embeddings from `model`, in the order they were typed. */
export async function listRouteExamples(
  db: Db,
  workspaceId: string,
  routeId: string,
  model: string,
): Promise<{ text: string; embedding: number[] }[]> {
  const rows = await db
    .select({ text: routeExamples.text, embedding: routeExamples.embedding })
    .from(routeExamples)
    .where(
      and(
        eq(routeExamples.workspaceId, workspaceId),
        eq(routeExamples.routeId, routeId),
        eq(routeExamples.embeddingModel, model),
      ),
    )
    .orderBy(asc(routeExamples.position));
  return rows.flatMap((r) =>
    r.embedding === null ? [] : [{ text: r.text, embedding: r.embedding }],
  );
}

/**
 * Replaces the workspace's centroids with those given (routes missing from `centroids` lose
 * theirs) and bumps the policy version, in one transaction, so snapshots reload.
 */
export async function replaceCentroids(
  db: Db,
  workspaceId: string,
  centroids: {
    routeId: string;
    embedding: number[];
    exampleCount: number;
    source: CentroidSource;
  }[],
  model: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(routeCentroids).where(eq(routeCentroids.workspaceId, workspaceId));
    if (centroids.length > 0) {
      await tx.insert(routeCentroids).values(
        centroids.map((c) => ({
          routeId: c.routeId,
          workspaceId,
          embedding: c.embedding,
          embeddingModel: model,
          exampleCount: c.exampleCount,
          source: c.source,
        })),
      );
    }
    await bumpPolicyVersion(tx, workspaceId);
  });
}

export interface SnapshotRouteRow {
  id: string;
  name: string;
  model: string;
  fallbacks: string[];
  allowCrossProvider: boolean;
  thresholdDown: number;
  thresholdUp: number;
  enabled: boolean;
  signals: RoutingSignal[];
  /** The text a route with no examples is scored from (RT-12, ADR 0122); empty for none. */
  description: string;
  exampleCount: number;
  centroid: { embedding: number[]; model: string; source: CentroidSource } | null;
  examples: { embedding: number[]; model: string }[];
}

export interface SnapshotBudgetRow {
  id: string;
  scope: BudgetScope;
  principalId: string | null;
  limitMicroUsd: bigint;
  period: BudgetPeriod;
}

/**
 * Everything a request needs to route and meter in this workspace, read at one policy version:
 * settings, routes, and every cap that can apply here, the instance cap included (ADR 0049).
 */
export interface SnapshotToolRow {
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | null>;
  approvalRequired: boolean;
}

export async function loadPolicyRows(
  db: Db,
  workspaceId: string,
): Promise<
  | {
      settings: RoutingSettingsRow;
      capture: { enabled: boolean; retentionDays: number };
      routes: SnapshotRouteRow[];
      budgets: SnapshotBudgetRow[];
      tools: SnapshotToolRow[];
    }
  | undefined
> {
  return db.transaction(
    async (tx) => {
      const [settings] = await tx
        .select({
          routingEnabled: workspaces.routingEnabled,
          defaultModel: workspaces.defaultModel,
          pinnedModel: workspaces.pinnedModel,
          policyVersion: workspaces.policyVersion,
          captureEnabled: workspaces.contentCapture,
          captureRetentionDays: workspaces.contentRetentionDays,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (settings === undefined) return undefined;
      const routeRows = await tx
        .select({
          id: routes.id,
          name: routes.name,
          model: routes.model,
          fallbacks: routes.fallbacks,
          allowCrossProvider: routes.allowCrossProvider,
          thresholdDown: routes.thresholdDown,
          thresholdUp: routes.thresholdUp,
          enabled: routes.enabled,
          signals: routes.signals,
          description: routes.description,
          centroid: routeCentroids.embedding,
          centroidModel: routeCentroids.embeddingModel,
          centroidSource: routeCentroids.source,
        })
        .from(routes)
        .leftJoin(routeCentroids, eq(routeCentroids.routeId, routes.id))
        .where(eq(routes.workspaceId, workspaceId))
        .orderBy(asc(routes.name));
      const exampleRows = await tx
        .select({
          routeId: routeExamples.routeId,
          embedding: routeExamples.embedding,
          model: routeExamples.embeddingModel,
        })
        .from(routeExamples)
        .where(eq(routeExamples.workspaceId, workspaceId))
        .orderBy(asc(routeExamples.position));
      const byRoute = Map.groupBy(exampleRows, (e) => e.routeId);
      const budgetRows = await tx
        .select({
          id: budgets.id,
          scope: budgets.scope,
          principalId: budgets.principalId,
          limitMicroUsd: budgets.limitMicroUsd,
          period: budgets.period,
        })
        .from(budgets)
        .where(or(eq(budgets.workspaceId, workspaceId), eq(budgets.scope, 'instance')));
      // The allowlist: enabled tools with the definitions stored when they were synced (TL-3).
      const toolRows = await tx
        .select({
          id: workspaceTools.id,
          serverId: workspaceTools.mcpServerId,
          serverName: mcpServers.name,
          name: workspaceTools.name,
          title: workspaceTools.title,
          description: workspaceTools.description,
          inputSchema: workspaceTools.inputSchema,
          annotations: workspaceTools.annotations,
          approvalRequired: workspaceTools.approvalRequired,
        })
        .from(workspaceTools)
        .innerJoin(mcpServers, eq(mcpServers.id, workspaceTools.mcpServerId))
        .where(and(eq(workspaceTools.workspaceId, workspaceId), eq(workspaceTools.enabled, true)))
        .orderBy(asc(mcpServers.name), asc(workspaceTools.name));
      return {
        settings: {
          routingEnabled: settings.routingEnabled,
          defaultModel: settings.defaultModel,
          pinnedModel: settings.pinnedModel,
          policyVersion: settings.policyVersion,
        },
        capture: {
          enabled: settings.captureEnabled,
          retentionDays: settings.captureRetentionDays,
        },
        budgets: budgetRows,
        tools: toolRows,
        routes: routeRows.map(({ centroid, centroidModel, centroidSource, ...route }) => {
          const examples = byRoute.get(route.id) ?? [];
          return {
            ...route,
            signals: route.signals as RoutingSignal[],
            exampleCount: examples.length,
            centroid:
              centroid === null || centroidModel === null || centroidSource === null
                ? null
                : {
                    embedding: centroid,
                    model: centroidModel,
                    // The column's check constraint allows only these values.
                    source: centroidSource as CentroidSource,
                  },
            examples: examples.flatMap((e) =>
              e.embedding === null || e.model === null
                ? []
                : [{ embedding: e.embedding, model: e.model }],
            ),
          };
        }),
      };
    },
    // One consistent read, so the version matches the rows it came with.
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function findPolicyVersion(db: Db, workspaceId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ version: workspaces.policyVersion })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.version;
}

/** The names of these routes in a workspace; a removed one is missing. */
export async function listRouteNames(
  db: Db,
  workspaceId: string,
  routeIds: readonly string[],
): Promise<Map<string, string>> {
  if (routeIds.length === 0) return new Map();
  const rows = await db
    .select({ id: routes.id, name: routes.name })
    .from(routes)
    .where(and(eq(routes.workspaceId, workspaceId), inArray(routes.id, [...routeIds])));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/*
 * Route example candidates (RT-10, ADR 0114), derived when read and never copied (invariant 9).
 * From each override in the period (the losing route, and the model the person chose: after a
 * budget fallback that is budget_fallback_from), to the person's turn in that request, to the
 * conversation's latest earlier message that decided its route. When the classifier decided it,
 * for the route that lost, that message is the text routing judged and the candidate. A signal
 * decision offers none: an example cannot change it. The candidate is offered only while the
 * workspace records content and that request's recorded content has not expired, and until an
 * admin adds or dismisses it. Each step reads within the workspace.
 */

/** How far back a candidate's override may be: the longest period the page offers. */
export const CANDIDATE_MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RouteCandidateRow {
  messageId: string;
  /** The route people moved away from. */
  routeId: string;
  chosenModel: string;
  text: string;
  at: Date;
  keptUntil: Date;
}

interface RawCandidate extends Record<string, unknown> {
  message_id: string;
  route_id: string;
  chosen_model: string;
  content: string;
  at: Date | string;
  kept_until: Date | string;
}

function candidatesSql(workspaceId: string, since: Date, messageIds?: readonly string[]): SQL {
  const only =
    messageIds === undefined
      ? sql``
      : sql`and c.message_id in (${sql.join(
          messageIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  return sql`
    with overrides as (
      select distinct on (u.request_id)
             u.request_id, u.route_id, coalesce(u.budget_fallback_from, u.model) as chosen_model
        from ${usage} u
       where u.workspace_id = ${workspaceId} and u.created_at >= ${since}
         and u.was_overridden and u.route_id is not null
       order by u.request_id, u.attempt
    ),
    decided as (
      select o.route_id, o.chosen_model, d.id as message_id, d.content, d.request_id,
             d.created_at as at
        from overrides o
        join ${messages} turn
          on turn.workspace_id = ${workspaceId} and turn.request_id = o.request_id
         and turn.role = 'user'
       cross join lateral (
         select m.id, m.content, m.request_id, m.created_at, r.resolution_rule, r.route_id
           from ${messages} m
          cross join lateral (
            select x.resolution_rule, x.route_id from ${usage} x
             where x.workspace_id = ${workspaceId} and x.request_id = m.request_id
             order by x.attempt limit 1
          ) r
          where m.workspace_id = ${workspaceId} and m.conversation_id = turn.conversation_id
            and m.role = 'user' and (m.created_at, m.id) < (turn.created_at, turn.id)
            and r.resolution_rule in ('signal', 'classified')
          order by m.created_at desc, m.id desc
          limit 1
       ) d
       where d.resolution_rule = 'classified' and d.route_id = o.route_id
    ),
    live as (
      select distinct on (c.message_id)
             c.message_id, c.route_id, c.chosen_model, c.content, c.at, k.kept_until
        from decided c
       cross join lateral (
         select max(sc.expires_at) as kept_until from ${spanContent} sc
          where sc.workspace_id = ${workspaceId} and sc.request_id = c.request_id
            and sc.expires_at > now()
       ) k
       where k.kept_until is not null
         and exists (
           select 1 from ${workspaces} w
            where w.id = ${workspaceId} and w.content_capture and w.deleted_at is null
         )
         and not exists (
           select 1 from ${routeCandidateDecisions} rcd where rcd.message_id = c.message_id
         )
         ${only}
       order by c.message_id
    )
    select message_id, route_id, chosen_model, content, at, kept_until from (
      select live.*, row_number() over (
               partition by route_id, chosen_model order by at desc, message_id desc
             ) as n
        from live
    ) ranked
     where n <= ${MAX_CANDIDATES_PER_GROUP}
     order by at desc, message_id desc`;
}

function candidateRow(r: RawCandidate): RouteCandidateRow {
  return {
    messageId: r.message_id,
    routeId: r.route_id,
    chosenModel: r.chosen_model,
    text: r.content,
    at: new Date(r.at),
    keptUntil: new Date(r.kept_until),
  };
}

/**
 * Candidates from overrides since a time, newest first, at most MAX_CANDIDATES_PER_GROUP for each
 * losing route and chosen model. Empty while the workspace does not record content.
 */
export async function listRouteCandidates(
  db: Db,
  workspaceId: string,
  since: Date,
): Promise<RouteCandidateRow[]> {
  const { rows } = await db.execute<RawCandidate>(candidatesSql(workspaceId, since));
  return rows.map(candidateRow);
}

const candidateWindow = () => new Date(Date.now() - CANDIDATE_MAX_DAYS * DAY_MS);

/** Throws CandidateGoneError unless every one of these is offered now. */
async function requireLiveCandidates(
  tx: Tx,
  workspaceId: string,
  candidates: FromCandidates,
): Promise<void> {
  const ids = [...new Set(candidates.messageIds)];
  if (ids.length === 0) return;
  const { rows } = await tx.execute<RawCandidate>(
    candidatesSql(workspaceId, candidateWindow(), ids),
  );
  if (rows.length !== ids.length) {
    throw new CandidateGoneError('this message is no longer offered as a route example');
  }
}

/** A foreign key or primary key on the decisions refused the row: the message went meanwhile. */
function isDecisionConflict(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      'code' in current &&
      (current.code === '23503' || current.code === '23505') &&
      'table' in current &&
      current.table === 'route_candidate_decisions'
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function decideCandidates(
  tx: Tx,
  workspaceId: string,
  candidates: FromCandidates,
  decision: 'added' | 'dismissed',
  routeId: string | null,
): Promise<void> {
  const ids = [...new Set(candidates.messageIds)];
  if (ids.length === 0) return;
  let written: { id: string }[];
  try {
    written = await tx
      .insert(routeCandidateDecisions)
      .values(
        ids.map((messageId) => ({
          messageId,
          workspaceId,
          decision,
          routeId,
          decidedBy: candidates.decidedBy,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: routeCandidateDecisions.messageId });
  } catch (error) {
    if (isDecisionConflict(error)) {
      throw new CandidateGoneError('this message is no longer offered as a route example', {
        cause: error,
      });
    }
    throw error;
  }
  // Another admin decided one of them at the same moment.
  if (written.length !== ids.length) {
    throw new CandidateGoneError('this message is no longer offered as a route example');
  }
}

/**
 * Records what an admin did with a candidate, for good: a dismissal has no undo (D6). Throws
 * CandidateGoneError unless it is offered now, so a stale page, another workspace's message or
 * any other id changes nothing. An addition is recorded with its route by insertRoute and
 * updateRoute instead, in the transaction that writes the example.
 */
export async function recordCandidateDecision(
  db: Db,
  workspaceId: string,
  messageId: string,
  decision: 'dismissed',
  decidedBy: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const candidates = { messageIds: [messageId], decidedBy };
    await requireLiveCandidates(tx, workspaceId, candidates);
    await decideCandidates(tx, workspaceId, candidates, decision, null);
  });
}
