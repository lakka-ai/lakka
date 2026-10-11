import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ForbiddenError, InvalidRequestError, NotFoundError } from '@lakka/contracts';
import type {
  AlertWebhookBody,
  AlertWebhookView,
  BudgetAlertPayload,
  BudgetAlertView,
  BudgetTestPayload,
  CreatedAlertWebhook,
  Principal,
  WebhookTestResult,
} from '@lakka/contracts';
import {
  deleteAlertWebhook,
  findAlertForDelivery,
  findAlertWebhook,
  findWebhookWithSecret,
  findWorkspace,
  listBudgetAlerts,
  listPendingAlerts,
  markAlertsEnqueued,
  recordAlertOutcome,
  rotateAlertWebhookSecret,
  setAlertWebhook,
  updateAlertWebhookUrl,
} from '@lakka/db';
import type { AlertWebhookRow, Db } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import type { Logger } from '../logger.ts';
import {
  isPrivateHostLiteral,
  isPublicAddress,
  PrivateAddressError,
  publicOnlyLookup,
} from '../net/public-address.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';

/*
 * Budget threshold alerts (BG-10, NF-P2, ADR 0054).
 *
 * A charge that takes a budget past one of its alert percentages records a budget_alerts row, in
 * the same transaction. The worker hands pending alerts to the job queue, which
 * delivers each to a webhook with retries: the workspace's webhook for caps inside a workspace,
 * or the instance's; with neither configured, nothing is sent anywhere.
 *
 * Deliveries are signed: `lakka-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<body>">`, with the webhook's secret. A workspace webhook must use https and may only
 * reach public addresses; an instance admin's may point anywhere, since they run the instance.
 */

export const BUDGET_ALERT_QUEUE = 'budget-alert';
const DELIVERY_TIMEOUT_MS = 10_000;

// ---- Managing webhooks -------------------------------------------------------------------

function webhookView(row: AlertWebhookRow): AlertWebhookView {
  return { url: row.url, createdAt: row.createdAt.toISOString() };
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

function requireInstanceAdmin(principal: Principal): void {
  if (principal.kind !== 'user' || !principal.isInstanceAdmin) {
    throw new ForbiddenError('only instance admins manage the instance webhook');
  }
}

async function authorizeWorkspaceWebhook(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
): Promise<void> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'budgets.manage');
}

/** A workspace webhook: https only, and not a name or address that is certainly private. */
function checkWorkspaceUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new InvalidRequestError('url: a workspace webhook must use https');
  }
  if (isPrivateHostLiteral(parsed.hostname)) {
    throw new InvalidRequestError('url: a workspace webhook must reach a public address');
  }
}

export async function getAlertWebhook(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string | null,
): Promise<AlertWebhookView | null> {
  if (workspaceId === null) requireInstanceAdmin(principal);
  else await authorizeWorkspaceWebhook(ctx, principal, workspaceId);
  const row = await findAlertWebhook(ctx.db, workspaceId);
  return row === undefined ? null : webhookView(row);
}

/** The newest alerts for the instance cap (null) or a workspace's caps, and their delivery. */
export async function listAlertHistory(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string | null,
): Promise<BudgetAlertView[]> {
  if (workspaceId === null) requireInstanceAdmin(principal);
  else await authorizeWorkspaceWebhook(ctx, principal, workspaceId);
  const rows = await listBudgetAlerts(ctx.db, workspaceId, 100);
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    subject: r.subject,
    percent: r.percent,
    periodStart: r.periodStart.toISOString(),
    state: r.state as BudgetAlertView['state'],
    attempts: r.attempts,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
  }));
}

export async function setWebhook(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string | null,
  body: AlertWebhookBody,
): Promise<CreatedAlertWebhook> {
  if (workspaceId === null) requireInstanceAdmin(principal);
  else {
    await authorizeWorkspaceWebhook(ctx, principal, workspaceId);
    checkWorkspaceUrl(body.url);
  }
  const secret = newSecret();
  const row = await setAlertWebhook(ctx.db, workspaceId, {
    url: body.url,
    secret,
    createdByPrincipalId: principal.actingUserId,
  });
  return { webhook: webhookView(row), secret };
}

/** Points the webhook at a new address and keeps its secret, so receivers need no change. */
export async function setWebhookUrl(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string | null,
  body: AlertWebhookBody,
): Promise<AlertWebhookView> {
  if (workspaceId === null) requireInstanceAdmin(principal);
  else {
    await authorizeWorkspaceWebhook(ctx, principal, workspaceId);
    checkWorkspaceUrl(body.url);
  }
  const row = await updateAlertWebhookUrl(ctx.db, workspaceId, body.url);
  if (row === undefined) throw new NotFoundError('no webhook');
  return webhookView(row);
}

/** A new signing secret, shown once. The old one stops working at once. */
export async function rotateWebhookSecret(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string | null,
): Promise<CreatedAlertWebhook> {
  if (workspaceId === null) requireInstanceAdmin(principal);
  else await authorizeWorkspaceWebhook(ctx, principal, workspaceId);
  const secret = newSecret();
  const row = await rotateAlertWebhookSecret(ctx.db, workspaceId, secret);
  if (row === undefined) throw new NotFoundError('no webhook');
  return { webhook: webhookView(row), secret };
}

/**
 * Sends a signed test alert now and says whether it arrived (Spend-Budgets board, "Send a test
 * alert"). It is not queued or retried, and not kept in the alert history: it is about no budget.
 */
export async function sendTestAlert(
  ctx: ServiceContext & { logger: Logger },
  principal: Principal,
  workspaceId: string | null,
  now: Date = new Date(),
): Promise<WebhookTestResult> {
  if (workspaceId === null) requireInstanceAdmin(principal);
  else await authorizeWorkspaceWebhook(ctx, principal, workspaceId);
  const webhook = await findWebhookWithSecret(ctx.db, workspaceId);
  if (webhook === undefined) throw new NotFoundError('no webhook');
  const workspace = workspaceId === null ? undefined : await findWorkspace(ctx.db, workspaceId);
  const payload: BudgetTestPayload = {
    type: 'budget.test',
    id: randomUUID(),
    occurredAt: now.toISOString(),
    workspace: workspace === undefined ? null : { id: workspace.id, name: workspace.name },
  };
  const sent = await signedPost(
    { ...webhook, scope: workspaceId === null ? 'instance' : 'workspace' },
    'budget.test',
    payload.id,
    JSON.stringify(payload),
    now,
  );
  const result: WebhookTestResult =
    'status' in sent
      ? { delivered: true, error: null }
      : { delivered: false, error: sent.failure.error };
  if (result.error === null) ctx.logger.info('budget.webhook_test_delivered');
  else ctx.logger.warn('budget.webhook_test_failed', { error_code: result.error });
  return result;
}

export async function removeWebhook(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string | null,
): Promise<void> {
  if (workspaceId === null) requireInstanceAdmin(principal);
  else await authorizeWorkspaceWebhook(ctx, principal, workspaceId);
  if (!(await deleteAlertWebhook(ctx.db, workspaceId))) throw new NotFoundError('no webhook');
}

// ---- Queueing and delivering -------------------------------------------------------------

export interface AlertSender {
  /** Queues delivery of one alert. Sending the same alert twice queues it once. */
  send(alertId: string): Promise<void>;
}

/** Hands recorded alerts to the job queue. Returns how many it queued. */
export async function enqueuePendingAlerts(
  ctx: { db: Db },
  sender: AlertSender,
  limit = 100,
): Promise<number> {
  const ids = await listPendingAlerts(ctx.db, limit);
  for (const id of ids) await sender.send(id);
  await markAlertsEnqueued(ctx.db, ids);
  return ids.length;
}

/** Thrown to have the job queue try the delivery again later. */
export class AlertDeliveryRetry extends Error {}

export type DeliveryOutcome = 'delivered' | 'no_destination' | 'failed';

export interface DeliveryContext {
  db: Db;
  logger: Logger;
  now?: () => Date;
}

/**
 * Delivers one alert. Resolves with the outcome, or throws AlertDeliveryRetry for a failure
 * worth retrying unless `final` says this was the last attempt, in which case the alert is
 * marked failed instead.
 */
export async function deliverBudgetAlert(
  ctx: DeliveryContext,
  alertId: string,
  options: { final: boolean },
): Promise<DeliveryOutcome> {
  const alert = await findAlertForDelivery(ctx.db, alertId);
  if (alert === undefined || alert.state === 'delivered') return 'delivered';
  if (alert.webhook === null) {
    await recordAlertOutcome(ctx.db, alertId, { state: 'no_destination' });
    return 'no_destination';
  }
  const payload: BudgetAlertPayload = {
    type: 'budget.threshold',
    id: alert.id,
    occurredAt: alert.createdAt.toISOString(),
    budget: {
      id: alert.budgetId,
      scope: alert.scope,
      period: alert.period,
      periodStart: alert.periodStart.toISOString(),
      workspace:
        alert.workspaceId === null
          ? null
          : { id: alert.workspaceId, name: alert.workspaceName ?? '' },
      principal:
        alert.principalId === null
          ? null
          : { id: alert.principalId, name: alert.principalName ?? '' },
    },
    percent: alert.percent,
    spentMicroUsd: String(alert.spentMicroUsd),
    limitMicroUsd: String(alert.limitMicroUsd),
  };
  const sent = await signedPost(
    alert.webhook,
    'budget.threshold',
    alert.id,
    JSON.stringify(payload),
    ctx.now?.() ?? new Date(),
  );
  if ('status' in sent) {
    await recordAlertOutcome(ctx.db, alertId, { state: 'delivered' });
    ctx.logger.info('budget.alert_delivered', { status_code: sent.status });
    return 'delivered';
  }
  const { failure } = sent;
  if (failure.retry && !options.final) {
    await recordAlertOutcome(ctx.db, alertId, { state: 'retrying', error: failure.error });
    ctx.logger.warn('budget.alert_retrying', { error_code: failure.error });
    throw new AlertDeliveryRetry(failure.error);
  }
  await recordAlertOutcome(ctx.db, alertId, { state: 'failed', error: failure.error });
  ctx.logger.warn('budget.alert_failed', { error_code: failure.error });
  return 'failed';
}

/**
 * Signs and POSTs one delivery. Resolves with the status for a 2xx answer, or with why it failed
 * and whether trying again could help.
 */
async function signedPost(
  webhook: { url: string; secret: string; scope: 'instance' | 'workspace' },
  event: string,
  deliveryId: string,
  body: string,
  now: Date,
): Promise<{ status: number } | { failure: { error: string; retry: boolean } }> {
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = createHmac('sha256', webhook.secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  try {
    const status = await postWebhook(
      webhook.url,
      body,
      {
        'content-type': 'application/json',
        'user-agent': 'lakka-webhooks',
        'lakka-event': event,
        'lakka-delivery': deliveryId,
        'lakka-signature': `t=${timestamp},v1=${signature}`,
      },
      webhook.scope === 'workspace',
    );
    if (status >= 200 && status < 300) return { status };
    // A client error will not fix itself, except for throttling.
    return {
      failure: {
        error: `http_${status}`,
        retry: status >= 500 || status === 429 || status === 408,
      },
    };
  } catch (error) {
    if (error instanceof PrivateAddressError) {
      return { failure: { error: 'private_address', retry: false } };
    }
    return { failure: { error: errorCode(error), retry: true } };
  }
}

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code.toLowerCase();
  }
  return 'network_error';
}

/**
 * POSTs the body and resolves with the status. Redirects are not followed, the response body is
 * never read, and a workspace webhook may only connect to a public address. Exported for tests.
 */
export function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  publicOnly: boolean,
): Promise<number> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  // Node does not call `lookup` for a host that is already an address, so check it here.
  const literal = target.hostname.replace(/^\[|\]$/g, '');
  if (publicOnly && isIP(literal) !== 0 && !isPublicAddress(literal)) {
    return Promise.reject(new PrivateAddressError('the webhook points at a private address'));
  }
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        timeout: DELIVERY_TIMEOUT_MS,
        // A fresh connection for every delivery. Node's shared agent would reuse a socket an
        // instance webhook opened to a private address for a workspace webhook at the same host,
        // without looking the name up again. Alerts are rare enough that pooling buys nothing.
        agent: false,
        ...(publicOnly ? { lookup: publicOnlyLookup } : {}),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () =>
      req.destroy(Object.assign(new Error('timed out'), { code: 'timeout' })),
    );
    req.on('error', reject);
    req.end(body);
  });
}
