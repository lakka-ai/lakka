import { NotFoundError } from '@lakka/contracts';
import type { Principal, RouteCandidateGroup, RouteCandidatesView } from '@lakka/contracts';
import {
  findContentCapture,
  listRouteCandidates,
  listRouteNames,
  recordCandidateDecision,
} from '@lakka/db';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';
import type { RoutingContext } from './policy-service.ts';

export { suggestTargetRoute } from '@lakka/contracts';
export type { CandidateTarget } from '@lakka/contracts';

/*
 * Route example candidates (RT-10, ADR 0114): the messages conversations were routed on, where
 * the person then chose another model, offered to the admin who manages routing. They are derived
 * from what is already kept, never copied, and offered only while the workspace records content
 * (OB-4): turning capture off hides them at once. Reading them shows other people's words, so it
 * takes policy.manage, like the actions that act on them, and never a key.
 *
 * An admin may turn one into a route example by saving a route with it (createRoute and
 * changeRoute, `fromCandidates`), or dismiss it. Neither happens on its own.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export async function listCandidates(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
  days: number,
  now: Date = new Date(),
): Promise<RouteCandidatesView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.manage');
  const capture = await findContentCapture(ctx.db, workspaceId);
  if (capture === undefined) throw new NotFoundError('workspace not found');
  if (!capture.enabled) return { capture: false, groups: [] };

  const rows = await listRouteCandidates(
    ctx.db,
    workspaceId,
    new Date(now.getTime() - days * DAY_MS),
  );
  const names = await listRouteNames(ctx.db, workspaceId, [...new Set(rows.map((r) => r.routeId))]);
  // Rows come newest first, so groups are ordered by their newest candidate.
  const groups = new Map<string, RouteCandidateGroup>();
  for (const row of rows) {
    const key = JSON.stringify([row.routeId, row.chosenModel]);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        routeId: row.routeId,
        route: names.get(row.routeId) ?? null,
        chosenModel: row.chosenModel,
        candidates: [],
      };
      groups.set(key, group);
    }
    group.candidates.push({
      messageId: row.messageId,
      text: row.text,
      at: row.at.toISOString(),
      keptUntil: row.keptUntil.toISOString(),
    });
  }
  return { capture: true, groups: [...groups.values()] };
}

/** Dismisses a candidate for good (D6); CandidateGoneError if it is no longer offered. */
export async function dismissCandidate(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
  messageId: string,
): Promise<void> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.manage');
  await recordCandidateDecision(
    ctx.db,
    workspaceId,
    messageId,
    'dismissed',
    principal.actingUserId,
  );
}
