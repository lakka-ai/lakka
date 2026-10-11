import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  BudgetAlertPayload,
  BudgetAlertView,
  AlertWebhookView,
  BudgetTestPayload,
  CreatedAlertWebhook,
  IssuedKey,
  WebhookTestResult,
  WorkspaceView,
} from '@lakka/contracts';
import {
  AlertDeliveryRetry,
  chargeLines,
  createLogger,
  deliverBudgetAlert,
  enqueuePendingAlerts,
  jobsDatabase,
  policySnapshots,
  reserveBudget,
  settleReservation,
  startAlertJobs,
  sweepExpiredReservations,
} from '@lakka/core';
import type { BudgetEngineContext } from '@lakka/core';
import { valkeyConfig } from '../../../test/integration/valkey.ts';
import { as, createTestApp, CREDENTIAL_KEY, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Budget threshold alerts (BG-10, NF-P2, ADR 0054) against real Postgres and Valkey, a local
 * webhook receiver, and pg-boss for delivery: crossings recorded once, signed deliveries,
 * retries, where alerts go, and who may configure it.
 */

let t: TestApp;
let root: SignedInUser;
let wsAdmin: SignedInUser;
let member: SignedInUser;
let ws: WorkspaceView;
let ctx: BudgetEngineContext;
const logs: string[] = [];
const { logger } = createLogger({
  level: 'debug',
  service: 'budget-alerts-test',
  destination: { write: (line: string) => void logs.push(line) },
});
const DOLLAR = 1_000_000n;
const WORKER = fileURLToPath(new URL('../../worker/src/main.ts', import.meta.url));

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}
let receiver: Server;
let receiverUrl: string;
let received: Received[] = [];
let responses: number[] = [];

async function spend(user: SignedInUser, microUsd: bigint, now?: Date): Promise<void> {
  const snapshot = await policySnapshots({ db: t.db }).get(ws.id);
  if (snapshot === undefined) throw new Error('no snapshot');
  const reservation = await reserveBudget(ctx, {
    requestId: randomUUID(),
    workspaceId: ws.id,
    principal: user.principal,
    lines: chargeLines(snapshot, user.principal, new Date()),
    amountMicroUsd: microUsd,
    ...(now === undefined ? {} : { now }),
  });
  if (now === undefined) await settleReservation(ctx, reservation, microUsd);
}

async function alertsFor(user: SignedInUser) {
  const { rows } = await t.pool.query<{ id: string; percent: number; state: string }>(
    `select a.id, a.percent, a.state from budget_alerts a join budgets b on b.id = a.budget_id
     where b.principal_id = $1 order by a.percent`,
    [user.principal.id],
  );
  return rows;
}

async function freshMember(dollars: number, alertPercents?: number[]): Promise<SignedInUser> {
  const user = await signedInUser(t, `M ${randomBytes(2).toString('hex')}`);
  await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role: 'member',
  });
  const res = await as(t, wsAdmin).put(
    `/api/workspaces/${ws.id}/budgets/members/${user.principal.id}`,
    {
      limitMicroUsd: String(BigInt(dollars) * DOLLAR),
      period: 'monthly',
      ...(alertPercents === undefined ? {} : { alertPercents }),
    },
  );
  if (res.statusCode !== 200) throw new Error(res.body);
  return user;
}

async function alertState(id: string) {
  const { rows } = await t.pool.query<{
    state: string;
    attempts: number;
    last_error: string | null;
  }>('select state, attempts, last_error from budget_alerts where id = $1', [id]);
  return rows[0];
}

const verify = (secret: string, r: Received) => {
  const header = String(r.headers['lakka-signature']);
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (match === null) return false;
  const expected = createHmac('sha256', secret).update(`${match[1]}.${r.body}`).digest('hex');
  return expected === match[2];
};

beforeAll(async () => {
  t = await createTestApp();
  ctx = {
    db: t.db,
    cache: t.cache,
    logger,
    keyPrefix: `alerts-test-${randomBytes(4).toString('hex')}:`,
  };
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(responses.shift() ?? 204).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  [root, wsAdmin, member] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Member'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  ws = (
    (
      await as(t, root).post('/api/workspaces', {
        name: 'Alerts',
        slug: `alerts-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  await as(t, root).put(`/api/workspaces/${ws.id}/members/${wsAdmin.principal.id}`, {
    role: 'admin',
  });
  await as(t, root).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
    role: 'member',
  });
});

beforeEach(() => {
  received = [];
  responses = [];
});

afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  await t.close();
});

describe('recording crossings (BG-10)', () => {
  it('BG-10: each alert percentage is recorded once per period, when spend first reaches it', async () => {
    const user = await freshMember(10);
    await spend(user, 7_900_000n);
    expect(await alertsFor(user)).toEqual([]);
    await spend(user, 200_000n);
    expect((await alertsFor(user)).map((a) => [a.percent, a.state])).toEqual([[80, 'pending']]);
    // Two at once, reaching the cap exactly: 8.10 + 0.95 + 0.95.
    await Promise.all([spend(user, 950_000n), spend(user, 950_000n)]);
    expect((await alertsFor(user)).map((a) => a.percent)).toEqual([80, 100]);
  });

  it('BG-10: a lapsed reservation charged by the sweep records its crossings too', async () => {
    const user = await freshMember(10, [50]);
    await spend(user, 6n * DOLLAR, new Date(Date.now() - 20 * 60 * 1000));
    expect(await alertsFor(user)).toEqual([]);
    // The request recorded no usage, so nothing is charged and nothing crosses.
    await sweepExpiredReservations(ctx);
    expect(await alertsFor(user)).toEqual([]);
    await spend(user, 5n * DOLLAR);
    expect((await alertsFor(user)).map((a) => a.percent)).toEqual([50]);
  });

  it('BG-10: a cap with no alert percentages, or a limit of zero, records nothing', async () => {
    const quiet = await freshMember(10, []);
    await spend(quiet, 10n * DOLLAR);
    expect(await alertsFor(quiet)).toEqual([]);
  });
});

describe('delivering (BG-10, NF-P2)', () => {
  it('NF-P2: with no webhook configured, nothing is sent anywhere', async () => {
    const user = await freshMember(10);
    await spend(user, 9n * DOLLAR);
    const [alert] = await alertsFor(user);
    if (alert === undefined) throw new Error('no alert');
    expect(await deliverBudgetAlert(ctx, alert.id, { final: false })).toBe('no_destination');
    expect(received).toEqual([]);
    expect(await alertState(alert.id)).toMatchObject({ state: 'no_destination' });
  });

  it('BG-10: an alert is posted to the instance webhook, signed with its secret', async () => {
    const created = (
      await as(t, root).put('/api/budgets/webhook', { url: receiverUrl })
    ).json() as CreatedAlertWebhook;
    expect(created.secret).toMatch(/^whsec_/);
    const user = await freshMember(10);
    await spend(user, 9n * DOLLAR);
    const [alert] = await alertsFor(user);
    if (alert === undefined) throw new Error('no alert');
    expect(await deliverBudgetAlert(ctx, alert.id, { final: false })).toBe('delivered');
    expect(received).toHaveLength(1);
    const [delivery] = received;
    if (delivery === undefined) throw new Error('nothing received');
    expect(delivery.headers).toMatchObject({
      'content-type': 'application/json',
      'lakka-event': 'budget.threshold',
      'lakka-delivery': alert.id,
    });
    expect(verify(created.secret, delivery)).toBe(true);
    expect(verify('whsec_wrong', delivery)).toBe(false);
    const payload = JSON.parse(delivery.body) as BudgetAlertPayload;
    expect(payload).toMatchObject({
      type: 'budget.threshold',
      id: alert.id,
      percent: 80,
      spentMicroUsd: String(9n * DOLLAR),
      limitMicroUsd: String(10n * DOLLAR),
      budget: {
        scope: 'member',
        period: 'monthly',
        workspace: { id: ws.id, name: 'Alerts' },
        principal: { id: user.principal.id },
      },
    });
    expect(await alertState(alert.id)).toMatchObject({ state: 'delivered', attempts: 1 });
    // Delivering again sends nothing more.
    expect(await deliverBudgetAlert(ctx, alert.id, { final: false })).toBe('delivered');
    expect(received).toHaveLength(1);
  });

  it('BG-10: a server error is retried until the last attempt; a client error is not retried', async () => {
    const user = await freshMember(10, [10, 20]);
    await spend(user, 3n * DOLLAR);
    const [first, second] = await alertsFor(user);
    if (first === undefined || second === undefined) throw new Error('no alerts');
    responses = [503, 503];
    await expect(deliverBudgetAlert(ctx, first.id, { final: false })).rejects.toBeInstanceOf(
      AlertDeliveryRetry,
    );
    expect(await alertState(first.id)).toEqual({
      state: 'pending',
      attempts: 1,
      last_error: 'http_503',
    });
    expect(await deliverBudgetAlert(ctx, first.id, { final: true })).toBe('failed');
    expect(await alertState(first.id)).toMatchObject({ state: 'failed', attempts: 2 });

    responses = [404];
    expect(await deliverBudgetAlert(ctx, second.id, { final: false })).toBe('failed');
    expect(await alertState(second.id)).toMatchObject({ state: 'failed', last_error: 'http_404' });
  });

  it('BG-10: admins see the delivery history, with why a delivery failed', async () => {
    const res = await as(t, wsAdmin).get(`/api/workspaces/${ws.id}/budgets/alerts`);
    expect(res.statusCode).toBe(200);
    const { alerts } = res.json() as { alerts: BudgetAlertView[] };
    expect(alerts.length).toBeGreaterThan(0);
    // Newest first, each with its cap, its subject and what became of it.
    const times = alerts.map((a) => a.createdAt);
    expect(times).toEqual(times.toSorted().toReversed());
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'member', state: 'failed', lastError: 'http_404' }),
        expect.objectContaining({ state: 'failed', attempts: 2, lastError: 'http_503' }),
      ]),
    );
    expect(alerts.every((a) => a.subject !== null)).toBe(true);
    // Not for members, and the instance's history is for instance admins.
    expect((await as(t, member).get(`/api/workspaces/${ws.id}/budgets/alerts`)).statusCode).toBe(
      403,
    );
    expect((await as(t, wsAdmin).get('/api/budgets/alerts')).statusCode).toBe(403);
    const instance = await as(t, root).get('/api/budgets/alerts');
    expect(instance.statusCode).toBe(200);
    expect(
      (instance.json() as { alerts: BudgetAlertView[] }).alerts.every(
        (a) => a.scope === 'instance',
      ),
    ).toBe(true);
  });

  it("BG-10: an alert inside a workspace goes to the workspace's webhook when it has one", async () => {
    // Workspace webhooks must be public https, so point this one at the instance receiver via
    // the database, as only the delivery routing is under test here.
    await as(t, wsAdmin).put(`/api/workspaces/${ws.id}/budgets/webhook`, {
      url: 'https://hooks.example.com/alerts',
    });
    await t.pool.query(`update alert_webhooks set url = $1 where workspace_id = $2`, [
      `${receiverUrl}?workspace`,
      ws.id,
    ]);
    const user = await freshMember(10);
    await spend(user, 9n * DOLLAR);
    const [alert] = await alertsFor(user);
    if (alert === undefined) throw new Error('no alert');
    // The workspace webhook may only reach public addresses, and this one is loopback.
    expect(await deliverBudgetAlert(ctx, alert.id, { final: false })).toBe('failed');
    expect(await alertState(alert.id)).toMatchObject({ last_error: 'private_address' });
    expect(received).toEqual([]);
    await as(t, wsAdmin).delete(`/api/workspaces/${ws.id}/budgets/webhook`);
  });

  it('BG-10, Q3: through pg-boss, a queued alert is delivered, retried after a failure, and queued once however often it is sent', async () => {
    const user = await freshMember(10);
    await spend(user, 9n * DOLLAR);
    const [alert] = await alertsFor(user);
    if (alert === undefined) throw new Error('no alert');
    // Only this alert is queued, so the scripted failure is its own.
    await t.pool.query(
      `update budget_alerts set state = 'no_destination' where state = 'pending' and id <> $1`,
      [alert.id],
    );
    responses = [500];
    const jobs = await startAlertJobs(
      { db: t.db, pool: t.pool, logger },
      { pollingIntervalSeconds: 0.5, retryDelaySeconds: 1 },
    );
    try {
      expect(await enqueuePendingAlerts(ctx, jobs)).toBeGreaterThanOrEqual(1);
      await jobs.send(alert.id);
      await expect
        .poll(async () => (await alertState(alert.id))?.state, { timeout: 15_000 })
        .toBe('delivered');
    } finally {
      await jobs.stop();
    }
    const forThisAlert = received.filter((r) => r.headers['lakka-delivery'] === alert.id);
    expect(forThisAlert).toHaveLength(2);
    expect(await alertState(alert.id)).toMatchObject({ attempts: 2 });
  });

  it('BG-10, NF-S1: the worker process delivers an alert, reading the webhook secret with its own key', async () => {
    // A fresh webhook, so its secret is shown.
    await as(t, root).delete('/api/budgets/webhook');
    const created = (
      await as(t, root).put('/api/budgets/webhook', { url: receiverUrl })
    ).json() as CreatedAlertWebhook;
    const user = await freshMember(10);
    await spend(user, 9n * DOLLAR);
    const [alert] = await alertsFor(user);
    if (alert === undefined) throw new Error('no alert');
    const db = t.database.options();
    const worker = spawn(process.execPath, [WORKER], {
      env: {
        PATH: process.env.PATH,
        LAKKA_LOG_LEVEL: 'warn',
        LAKKA_DATABASE_HOST: db.host,
        LAKKA_DATABASE_PORT: String(db.port),
        LAKKA_DATABASE_USER: db.user,
        LAKKA_DATABASE_PASSWORD: db.password,
        LAKKA_DATABASE_NAME: db.database,
        LAKKA_CACHE_HOST: valkeyConfig().host,
        LAKKA_CACHE_PORT: String(valkeyConfig().port),
        LAKKA_CREDENTIAL_KEY: CREDENTIAL_KEY,
        LAKKA_WORKER_HEALTH_HOST: '127.0.0.1',
        LAKKA_WORKER_HEALTH_PORT: String(await freePort()),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const exited = new Promise((resolve) => worker.on('exit', resolve));
    try {
      await expect
        .poll(async () => (await alertState(alert.id))?.state, { timeout: 30_000, interval: 250 })
        .toBe('delivered');
    } finally {
      worker.kill('SIGTERM');
      await exited;
    }
    const delivery = received.find((r) => r.headers['lakka-delivery'] === alert.id);
    if (delivery === undefined) throw new Error('nothing received');
    expect(verify(created.secret, delivery)).toBe(true);
  });

  it('BG-10: pg-boss is given the rows of every statement of a multi-statement query', async () => {
    const { executeSql } = jobsDatabase(t.pool);
    expect((await executeSql('select $1::int as n', [1])).rows).toEqual([{ n: 1 }]);
    // pg-boss sends its maintenance this way; pg answers with one result per statement.
    const many = await executeSql('begin; select 1 as n; select 2 as n; commit;');
    expect(many.rows).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('BG-10: pg-boss supervision passes finish, so a stuck alert job can expire and be retried', async () => {
    const seen = logs.length;
    const databaseNow = async () => {
      const { rows } = await t.pool.query<{ now: Date }>('select now()');
      const [row] = rows;
      if (row === undefined) throw new Error('no time from the database');
      return row.now;
    };
    const monitoredSince = async (since: Date) => {
      const { rows } = await t.pool.query<{ after: boolean }>(
        `select monitor_on > $1 as after from pgboss.queue where name = 'budget-alert'`,
        [since],
      );
      return rows[0]?.after === true;
    };
    const jobs = await startAlertJobs(
      { db: t.db, pool: t.pool, logger },
      { pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1 },
    );
    try {
      // Two passes: a failing one logged its error between writing the queue's counts and the
      // next pass.
      const start = await databaseNow();
      await expect.poll(() => monitoredSince(start), { timeout: 15_000 }).toBe(true);
      const firstPass = await databaseNow();
      await expect.poll(() => monitoredSince(firstPass), { timeout: 15_000 }).toBe(true);
    } finally {
      await jobs.stop();
    }
    expect(logs.slice(seen).filter((line) => line.includes('"msg":"jobs.error"'))).toEqual([]);
  });
});

describe('configuring webhooks (BG-10, NF-P2)', () => {
  it('BG-10: instance admins set the instance webhook; its secret is shown once and never logged', async () => {
    for (const who of [wsAdmin, member]) {
      expect((await as(t, who).put('/api/budgets/webhook', { url: receiverUrl })).statusCode).toBe(
        403,
      );
      expect((await as(t, who).get('/api/budgets/webhook')).statusCode).toBe(403);
    }
    const res = await as(t, root).put('/api/budgets/webhook', { url: receiverUrl });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { secret } = res.json() as CreatedAlertWebhook;
    const shown = await as(t, root).get('/api/budgets/webhook');
    expect(shown.json()).toEqual({ webhook: { url: receiverUrl, createdAt: expect.any(String) } });
    expect(shown.body).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
    expect(t.logs.join('\n')).not.toContain(secret);
    const { rows } = await t.pool.query<{ secret: string }>('select secret from alert_webhooks');
    for (const row of rows) expect(row.secret).not.toContain(secret);
  });

  it('BG-10: a workspace admin sets their workspace webhook, which must be public https', async () => {
    const path = `/api/workspaces/${ws.id}/budgets/webhook`;
    for (const url of [
      'http://hooks.example.com/alerts',
      'https://localhost/alerts',
      'https://127.0.0.1/alerts',
      'https://10.0.0.5/alerts',
      'https://[::1]/alerts',
      'ftp://hooks.example.com/alerts',
      'not a url',
    ]) {
      expect({ url, status: (await as(t, wsAdmin).put(path, { url })).statusCode }).toEqual({
        url,
        status: 400,
      });
    }
    expect(
      (await as(t, wsAdmin).put(path, { url: 'https://hooks.example.com/a' })).statusCode,
    ).toBe(201);
    expect((await as(t, member).put(path, { url: 'https://hooks.example.com/a' })).statusCode).toBe(
      403,
    );
    const outsider = await signedInUser(t, 'Outsider');
    expect((await as(t, outsider).get(path)).statusCode).toBe(404);
    const key = (
      await as(t, wsAdmin).post(`/api/workspaces/${ws.id}/keys`, { name: 'Hooks' })
    ).json() as IssuedKey;
    const viaKey = await t.app.inject({
      method: 'PUT',
      url: path,
      headers: { authorization: `Bearer ${key.secret}` },
      payload: { url: 'https://hooks.example.com/b' },
    });
    expect(viaKey.statusCode).toBe(403);
    expect((await as(t, wsAdmin).delete(path)).statusCode).toBe(204);
    expect((await as(t, wsAdmin).delete(path)).statusCode).toBe(404);
  });
});

describe('changing a webhook without a new secret, and testing it (BG-10, ADR 0093)', () => {
  const path = '/api/budgets/webhook';

  it('BG-10: a new address keeps the secret; a new secret keeps the address and is shown once', async () => {
    const { secret: first } = (
      await as(t, root).put(path, { url: 'https://hooks.example.com/old' })
    ).json() as CreatedAlertWebhook;
    const moved = await as(t, root).patch(path, { url: receiverUrl });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as { webhook: AlertWebhookView }).webhook.url).toBe(receiverUrl);
    expect(moved.body).not.toContain('whsec_');

    // The moved webhook still signs with the first secret.
    received = [];
    const tested = await as(t, root).post(`${path}/test`, undefined);
    expect((tested.json() as { result: WebhookTestResult }).result).toEqual({
      delivered: true,
      error: null,
    });
    const [delivery] = received;
    if (delivery === undefined) throw new Error('nothing received');
    expect(delivery.headers['lakka-event']).toBe('budget.test');
    expect(verify(first, delivery)).toBe(true);
    expect(JSON.parse(delivery.body) as BudgetTestPayload).toMatchObject({
      type: 'budget.test',
      workspace: null,
    });

    const rotated = await as(t, root).post(`${path}/secret`, undefined);
    expect(rotated.statusCode).toBe(201);
    expect(rotated.headers['cache-control']).toBe('no-store');
    const { webhook, secret } = rotated.json() as CreatedAlertWebhook;
    expect(webhook.url).toBe(receiverUrl);
    expect(secret).not.toBe(first);
    expect(logs.join('\n')).not.toContain(secret);
    expect(t.logs.join('\n')).not.toContain(secret);
    received = [];
    await as(t, root).post(`${path}/test`, undefined);
    const [again] = received;
    if (again === undefined) throw new Error('nothing received');
    expect(verify(secret, again)).toBe(true);
    expect(verify(first, again)).toBe(false);
  });

  it('BG-10: a test alert that does not arrive says why, and is not kept as an alert', async () => {
    const before = await t.pool.query('select count(*)::int as n from budget_alerts');
    responses = [500];
    const res = await as(t, root).post(`${path}/test`, undefined);
    expect((res.json() as { result: WebhookTestResult }).result).toEqual({
      delivered: false,
      error: 'http_500',
    });
    const after = await t.pool.query('select count(*)::int as n from budget_alerts');
    expect(after.rows).toEqual(before.rows);
  });

  it('BG-10, NF-P2: only those who manage the webhook, a workspace one stays public, and none is none', async () => {
    const wsPath = `/api/workspaces/${ws.id}/budgets/webhook`;
    for (const who of [wsAdmin, member]) {
      expect((await as(t, who).patch(path, { url: receiverUrl })).statusCode).toBe(403);
      expect((await as(t, who).post(`${path}/secret`, undefined)).statusCode).toBe(403);
      expect((await as(t, who).post(`${path}/test`, undefined)).statusCode).toBe(403);
    }
    await as(t, wsAdmin).delete(wsPath);
    expect(
      (await as(t, wsAdmin).patch(wsPath, { url: 'https://hooks.example.com/a' })).statusCode,
    ).toBe(404);
    expect((await as(t, wsAdmin).post(`${wsPath}/secret`, undefined)).statusCode).toBe(404);
    expect((await as(t, wsAdmin).post(`${wsPath}/test`, undefined)).statusCode).toBe(404);
    await as(t, wsAdmin).put(wsPath, { url: 'https://hooks.example.com/a' });
    expect((await as(t, wsAdmin).patch(wsPath, { url: 'https://127.0.0.1/a' })).statusCode).toBe(
      400,
    );
    expect((await as(t, member).post(`${wsPath}/test`, undefined)).statusCode).toBe(403);
    // A workspace webhook may only reach public addresses, and a test alert keeps to that too.
    await t.pool.query('update alert_webhooks set url = $1 where workspace_id = $2', [
      receiverUrl,
      ws.id,
    ]);
    const tested = await as(t, wsAdmin).post(`${wsPath}/test`, undefined);
    expect((tested.json() as { result: WebhookTestResult }).result).toEqual({
      delivered: false,
      error: 'private_address',
    });
    await as(t, wsAdmin).delete(wsPath);
  });
});
