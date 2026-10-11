import {
  listExampleEmbeddings,
  listExamplesToEmbed,
  listRoutes,
  replaceCentroids,
  saveExampleEmbeddings,
} from '@lakka/db';
import type { Db } from '@lakka/db';
import type { ClassifierRuntime } from '../classifier/runtime.ts';
import type { Logger } from '../logger.ts';
import { centroidOf, describedRouteText, scoringBasis } from './score.ts';

/*
 * Compiling a workspace's routing policy (tech spec, Compiling the policy; ADR 0043): embed
 * every example that has no embedding from the current model, then store each route's centroid
 * and bump the policy version so request snapshots reload. A route's name and description count
 * as one more example (ADR 0125), and stand alone while it has none (ADR 0122); RT-12. Runs when
 * a policy is saved and when the embedding model changed, never per request. Without a
 * classifier it does nothing: routes stay uncompiled and routing falls back to the default
 * (invariant 10).
 */

export interface CompileContext {
  db: Db;
  classifier: ClassifierRuntime;
  logger: Logger;
}

export type CompileResult =
  | { status: 'compiled'; model: string; routes: number; embedded: number }
  | { status: 'classifier_unavailable' };

export async function compileWorkspacePolicy(
  ctx: CompileContext,
  workspaceId: string,
): Promise<CompileResult> {
  const embedder = await ctx.classifier.embedder();
  if (embedder === undefined) return { status: 'classifier_unavailable' };
  const model = embedder.modelId;
  const routes = await listRoutes(ctx.db, workspaceId);
  const pending = await listExamplesToEmbed(
    ctx.db,
    workspaceId,
    routes.map((r) => r.id),
    model,
  );
  const embedded: { id: string; embedding: number[] }[] = [];
  for (const example of pending) {
    embedded.push({ id: example.id, embedding: Array.from(await embedder.embed(example.text)) });
  }
  await saveExampleEmbeddings(ctx.db, workspaceId, embedded, model);
  const byRoute = await listExampleEmbeddings(ctx.db, workspaceId, model);
  const centroids: Parameters<typeof replaceCentroids>[2] = [];
  for (const route of routes) {
    const vectors = byRoute.get(route.id) ?? [];
    const source = scoringBasis({ exampleCount: vectors.length, description: route.description });
    if (source === null) continue;
    // Embedded on every compile rather than stored: one text per route, made at save.
    const described =
      source === 'examples'
        ? []
        : [Array.from(await embedder.embed(describedRouteText(route.name, route.description)))];
    centroids.push({
      routeId: route.id,
      embedding: centroidOf([...vectors, ...described]),
      exampleCount: vectors.length,
      source,
    });
  }
  await replaceCentroids(ctx.db, workspaceId, centroids, model);
  ctx.logger.info('routing.policy_compiled', {
    workspace_id: workspaceId,
    count: centroids.length,
  });
  return { status: 'compiled', model, routes: centroids.length, embedded: embedded.length };
}
