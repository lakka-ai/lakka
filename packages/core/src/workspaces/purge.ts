import { periodStart } from '@lakka/contracts';
import { finishWorkspacePurge, listUnpurgedWorkspaces, purgeWorkspaceContent } from '@lakka/db';
import type { RemovedCap } from '@lakka/db';
import { cacheScript } from '../cache.ts';
import { counterKey, DEFAULT_KEY_PREFIX } from '../budgets/engine.ts';
import type { BudgetEngineContext } from '../budgets/engine.ts';

/*
 * The second step of deleting a workspace (ID-8, ADR 0104). Deleting it already ended all access;
 * this removes what it held: captured content, spans, conversations with their messages and
 * files, the tool audit's arguments, then its routes and caps. The worker runs it every minute,
 * so a run that fails, or a workspace deleted while one was running, is picked up by the next.
 * Every step is safe to repeat.
 */

export const WORKSPACE_PURGE_QUEUE = 'workspace-purge';
export const WORKSPACE_PURGE_SCHEDULE = '* * * * *';

/** Rows per statement, so one large workspace never holds long locks. */
const DEFAULT_BATCH = 500;

export interface PurgeContext extends BudgetEngineContext {
  batchSize?: number;
}

const DELETE_KEYS = cacheScript(`
for _, key in ipairs(KEYS) do redis.call('DEL', key) end
return #KEYS
`);

/** The counters a removed cap may still have: every period it recorded, and the current one. */
function counterKeys(prefix: string, caps: readonly RemovedCap[], now: Date): string[] {
  const keys = new Set<string>();
  for (const cap of caps) {
    for (const start of [...cap.periodStarts, periodStart(cap.period, now)]) {
      keys.add(counterKey(prefix, cap.budgetId, start));
    }
  }
  return [...keys];
}

export interface PurgeOutcome {
  /** Workspaces now fully purged. */
  finished: number;
  /** Workspaces whose caps wait for an open reservation to settle or lapse. */
  waiting: number;
}

export async function purgeDeletedWorkspaces(
  ctx: PurgeContext,
  now: Date = new Date(),
): Promise<PurgeOutcome> {
  const batch = ctx.batchSize ?? DEFAULT_BATCH;
  const outcome: PurgeOutcome = { finished: 0, waiting: 0 };
  for (const workspaceId of await listUnpurgedWorkspaces(ctx.db)) {
    let removed = 0;
    let batchRemoved: number;
    do {
      batchRemoved = await purgeWorkspaceContent(ctx.db, workspaceId, batch);
      removed += batchRemoved;
    } while (batchRemoved > 0);
    const finish = await finishWorkspacePurge(ctx.db, workspaceId);
    if (finish.outcome === 'reservations_open') {
      outcome.waiting += 1;
      continue;
    }
    // Postgres first: a counter left behind is never read again, since its cap is gone.
    const keys = counterKeys(ctx.keyPrefix ?? DEFAULT_KEY_PREFIX, finish.removedCaps, now);
    if (keys.length > 0) {
      try {
        await ctx.cache.runScript(DELETE_KEYS, keys, []);
      } catch (error) {
        ctx.logger.warn('workspace.purge_counters_failed', { workspace_id: workspaceId }, error);
      }
    }
    ctx.logger.info('workspace.purged', { workspace_id: workspaceId, count: removed });
    outcome.finished += 1;
  }
  return outcome;
}
