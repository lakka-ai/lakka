import { PgBoss } from 'pg-boss';
import type { Pool, QueryResult } from '@lakka/db';
import { BUDGET_ALERT_QUEUE, deliverBudgetAlert } from '../budgets/alerts.ts';
import {
  CATALOGUE_FEED_QUEUE,
  CATALOGUE_FEED_SCHEDULE,
  checkCatalogueFeed,
} from '../models/feed-check.ts';
import type { FeedCheckContext } from '../models/feed-check.ts';
import type { AlertSender, DeliveryContext } from '../budgets/alerts.ts';
import {
  enforceRetention,
  RETENTION_QUEUE,
  RETENTION_SCHEDULE,
} from '../observability/retention.ts';
import type { RetentionContext } from '../observability/retention.ts';
import {
  purgeDeletedWorkspaces,
  WORKSPACE_PURGE_QUEUE,
  WORKSPACE_PURGE_SCHEDULE,
} from '../workspaces/purge.ts';
import type { PurgeContext } from '../workspaces/purge.ts';

/*
 * The job queue for budget alerts (BG-10, Q3, ADR 0054): pg-boss, in its own `pgboss` schema, on
 * the worker's existing Postgres pool. Postgres stays the only store (invariant 11). Each alert
 * is one job whose id is the alert's own, so queueing it twice queues it once. A failed delivery
 * is retried with exponential backoff; after the last try the alert is marked failed.
 *
 * With `retention` given, as in the worker, the same queue also runs retention every day, as a
 * scheduled pg-boss job (NF-P5, ADR 0078), and with `purge` given, the purge of deleted
 * workspaces every minute (ID-8, ADR 0104), and with `catalogueFeed` given, the signed price
 * feed's check every minute, which does nothing while the feed is off (PR-6, ADR 0116).
 * pg-boss's scheduler is on only for those.
 */

export interface AlertJobs extends AlertSender {
  stop(): Promise<void>;
}

export interface AlertJobOptions {
  /** How often an idle worker looks for jobs. */
  pollingIntervalSeconds?: number;
  /** First retry delay; later retries back off exponentially. */
  retryDelaySeconds?: number;
  retryLimit?: number;
  /** Runs retention on its daily schedule too; the worker passes it. */
  retention?: RetentionContext;
  /** Purges deleted workspaces every minute; the worker passes it. */
  purge?: PurgeContext;
  /** Checks the signed price feed when it is on and due; the worker passes it. */
  catalogueFeed?: FeedCheckContext;
  /** How often pg-boss expires, fails and deletes jobs; a minute unless a test needs it sooner. */
  superviseIntervalSeconds?: number;
}

/**
 * pg-boss's view of the worker's pool. pg-boss sends its maintenance as one multi-statement query
 * (BEGIN ... COMMIT), and pg answers that with one result per statement, not one result. So the
 * rows of all of them are given back, as pg-boss's own pool does; giving only `result.rows` handed
 * it nothing, and every supervise pass then failed before it expired, failed or deleted any job.
 */
export function jobsDatabase(pool: Pool) {
  return {
    executeSql: async (text: string, values?: unknown[]) => {
      // pg types a query as one result; a query of several statements gives an array of them.
      const result: QueryResult | QueryResult[] = await pool.query(text, values);
      return { rows: Array.isArray(result) ? result.flatMap((r) => r.rows) : result.rows };
    },
  };
}

export async function startAlertJobs(
  ctx: DeliveryContext & { pool: Pool },
  options: AlertJobOptions = {},
): Promise<AlertJobs> {
  const supervise = options.superviseIntervalSeconds;
  const boss = new PgBoss({
    db: jobsDatabase(ctx.pool),
    schema: 'pgboss',
    ...(supervise === undefined
      ? {}
      : { superviseIntervalSeconds: supervise, monitorIntervalSeconds: supervise }),
    // Scheduling is needed only for the scheduled jobs; queue maintenance runs either way.
    schedule:
      options.retention !== undefined ||
      options.purge !== undefined ||
      options.catalogueFeed !== undefined,
  });
  // pg-boss reports background errors as events; an unhandled 'error' event would end the process.
  boss.on('error', (error) => ctx.logger.error('jobs.error', {}, error));
  await boss.start();
  await boss.createQueue(BUDGET_ALERT_QUEUE, {
    retryLimit: options.retryLimit ?? 8,
    retryDelay: options.retryDelaySeconds ?? 30,
    retryBackoff: true,
    retryDelayMax: 3600,
  });
  await boss.work(
    BUDGET_ALERT_QUEUE,
    { includeMetadata: true, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 5 },
    async (jobs) => {
      for (const job of jobs) {
        const { alertId } = job.data as { alertId: string };
        // AlertDeliveryRetry propagates to pg-boss, which retries the job after its backoff.
        await deliverBudgetAlert(ctx, alertId, { final: job.retryCount >= job.retryLimit });
      }
    },
  );
  const retention = options.retention;
  if (retention !== undefined) {
    await boss.createQueue(RETENTION_QUEUE, { retryLimit: 2, retryDelay: 600 });
    await boss.schedule(RETENTION_QUEUE, RETENTION_SCHEDULE, {}, { tz: 'UTC' });
    await boss.work(RETENTION_QUEUE, { pollingIntervalSeconds: 60 }, async () => {
      await enforceRetention(retention);
    });
  }
  const purge = options.purge;
  if (purge !== undefined) {
    // One try per minute is its own retry; a failed run is picked up by the next.
    await boss.createQueue(WORKSPACE_PURGE_QUEUE, { retryLimit: 0, policy: 'singleton' });
    await boss.schedule(WORKSPACE_PURGE_QUEUE, WORKSPACE_PURGE_SCHEDULE, {}, { tz: 'UTC' });
    await boss.work(WORKSPACE_PURGE_QUEUE, { pollingIntervalSeconds: 30 }, async () => {
      await purgeDeletedWorkspaces(purge);
    });
  }
  const feed = options.catalogueFeed;
  if (feed !== undefined) {
    // As the purge: each minute's run is its own retry, and the run decides whether it is due.
    await boss.createQueue(CATALOGUE_FEED_QUEUE, { retryLimit: 0, policy: 'singleton' });
    await boss.schedule(CATALOGUE_FEED_QUEUE, CATALOGUE_FEED_SCHEDULE, {}, { tz: 'UTC' });
    await boss.work(CATALOGUE_FEED_QUEUE, { pollingIntervalSeconds: 30 }, async () => {
      await checkCatalogueFeed(feed);
    });
  }
  return {
    async send(alertId) {
      await boss.send(BUDGET_ALERT_QUEUE, { alertId }, { id: alertId });
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}
