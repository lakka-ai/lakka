import { findPolicyVersion, loadPolicyRows } from '@lakka/db';
import type { Db } from '@lakka/db';
import type { PolicySnapshot } from './score.ts';

/*
 * The policy a request routes under (tech spec, pipeline stage 3; E9; ADR 0043). Read once into a
 * frozen snapshot and cached in memory per workspace. Each request checks the workspace's
 * policy_version with one primary-key read and reloads only when it changed, so an edit takes
 * effect on the next request and a request never mixes two versions.
 */

export interface PolicySnapshots {
  /** The workspace's current policy, or undefined if the workspace does not exist. */
  get(workspaceId: string): Promise<PolicySnapshot | undefined>;
}

/**
 * The name the model sees for a tool: <server>__<tool> (H1). Server names have no underscores,
 * so two tools can never share one. Null when it would not fit the names models accept.
 */
export function toolModelName(serverName: string, toolName: string): string | null {
  const name = `${serverName}__${toolName}`;
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : null;
}

export function policySnapshots(ctx: { db: Db }): PolicySnapshots {
  const cache = new Map<string, PolicySnapshot>();
  return {
    async get(workspaceId) {
      const version = await findPolicyVersion(ctx.db, workspaceId);
      if (version === undefined) return undefined;
      const cached = cache.get(workspaceId);
      if (cached?.version === version) return cached;
      const rows = await loadPolicyRows(ctx.db, workspaceId);
      if (rows === undefined) return undefined;
      const snapshot: PolicySnapshot = Object.freeze({
        workspaceId,
        version: rows.settings.policyVersion,
        routingEnabled: rows.settings.routingEnabled,
        defaultModel: rows.settings.defaultModel,
        pinnedModel: rows.settings.pinnedModel,
        capture: Object.freeze({ ...rows.capture }),
        budgets: Object.freeze(rows.budgets.map((b) => Object.freeze({ ...b }))),
        tools: Object.freeze(
          rows.tools.flatMap((t) => {
            const modelName = toolModelName(t.serverName, t.name);
            // A name the model cannot be given leaves the tool out, whatever the admin chose.
            return modelName === null
              ? []
              : [Object.freeze({ ...t, modelName, inputSchema: Object.freeze(t.inputSchema) })];
          }),
        ),
        routes: Object.freeze(
          rows.routes.map((r) =>
            Object.freeze({
              ...r,
              fallbacks: Object.freeze([...r.fallbacks]),
              signals: Object.freeze([...r.signals]),
              centroid:
                r.centroid === null
                  ? null
                  : {
                      embedding: Float32Array.from(r.centroid.embedding),
                      model: r.centroid.model,
                      source: r.centroid.source,
                    },
              examples: Object.freeze(
                r.examples.map((e) => ({
                  embedding: Float32Array.from(e.embedding),
                  model: e.model,
                })),
              ),
            }),
          ),
        ),
      });
      cache.set(workspaceId, snapshot);
      return snapshot;
    },
  };
}
