import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody, periodStart } from '@lakka/contracts';
import type { IssuedKey, ModelView, SpendReport, WorkspaceView } from '@lakka/contracts';
import {
  cacheScript,
  counterKey,
  createLogger,
  PRINCIPAL_REVOKED_CHANNEL,
  purgeDeletedWorkspaces,
  subscribe,
} from '@lakka/core';
import type { CacheSubscription, PrincipalRevokedEvent } from '@lakka/core';
import { listSpansForRequest, listUsageForRequest, schema, uuidv7 } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { valkeyConfig } from '../../../test/integration/valkey.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Deleting a workspace (ID-8, ADR 0104), against real Postgres and Valkey. "Doomed" has an admin,
 * a member who is also in "Kept", a key, an invite, a provider key, a tool server, caps, captured
 * content, conversations, a route and tool calls. Deleting it must end access at once and keep
 * its spend; the purge then removes what it held. "Kept" has the same kinds of thing and must not
 * change.
 */

let t: TestApp;
let fake: FakeProvider;
let base: string;
let subscription: CacheSubscription;
const events: PrincipalRevokedEvent[] = [];
const purgeLogs: string[] = [];
let root: SignedInUser;
let lead: SignedInUser;
let member: SignedInUser;
let doomed: WorkspaceView;
let kept: WorkspaceView;
let quick: ModelView;
let idle: ModelView;
let key: IssuedKey;
let inviteToken: string;
const requests = { doomed: '', kept: '' };

const suffix = () => randomBytes(3).toString('hex');
const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;

const EXISTS = cacheScript(`return redis.call('EXISTS', KEYS[1])`);

const purgeLogger = createLogger({
  level: 'info',
  service: 'test',
  destination: { write: (line: string) => void purgeLogs.push(line) },
}).logger;

const purge = (batchSize = 2) =>
  purgeDeletedWorkspaces({ db: t.db, cache: t.cache, logger: purgeLogger, batchSize });

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', { name, slug: `${name}-${suffix()}` });
  if (res.statusCode !== 201) throw new Error(`create: ${res.statusCode} ${res.body}`);
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function join(ws: WorkspaceView, user: SignedInUser, role: 'admin' | 'member') {
  const res = await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role,
  });
  if (res.statusCode !== 200) throw new Error(`membership: ${res.statusCode}`);
}

async function model(scenario: string): Promise<ModelView> {
  const res = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `${scenario}~${suffix()}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools: false,
      structuredOutput: false,
      promptCaching: false,
      reasoning: false,
    },
    prices: {
      inputMicroUsdPerMtok: 1_000_000,
      outputMicroUsdPerMtok: 2_000_000,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { model: ModelView }).model;
}

function complete(
  auth: { session: SignedInUser; workspaceId: string; conversationId?: string } | { key: string },
  modelId: string,
  stream: boolean,
) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers:
      'key' in auth
        ? { 'content-type': 'application/json', authorization: `Bearer ${auth.key}` }
        : {
            'content-type': 'application/json',
            cookie: auth.session.cookie,
            origin: PUBLIC_URL,
            'x-lakka-workspace': auth.workspaceId,
            ...(auth.conversationId === undefined
              ? {}
              : { 'x-lakka-conversation': auth.conversationId }),
          },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 100,
      stream,
      messages: [{ role: 'user', content: 'Tell me a long story' }],
    }),
  });
}

/** A chat request in a conversation, finished and traced; returns its request id. */
async function chatIn(ws: WorkspaceView, user: SignedInUser): Promise<string> {
  const conversation = (
    (await as(t, user).post(`/api/workspaces/${ws.id}/conversations`, {})).json() as {
      conversation: { id: string };
    }
  ).conversation.id;
  const res = await complete(
    { session: user, workspaceId: ws.id, conversationId: conversation },
    quick.id,
    false,
  );
  if (res.status !== 200) throw new Error(`chat: ${res.status} ${await res.text()}`);
  await res.text();
  const requestId = res.headers.get('x-lakka-request-id') ?? '';
  for (let i = 0; i < 40; i += 1) {
    await t.tracing.forceFlush();
    if ((await listSpansForRequest(t.db, ws.id, requestId)).some((s) => s.name === 'request'))
      return requestId;
    await sleep(50);
  }
  throw new Error('never traced');
}

/** A stream already delivering; `ended` reads it to the end. */
async function openStream(auth: Parameters<typeof complete>[0]) {
  const res = await complete(auth, idle.id, true);
  expect(res.status).toBe(200);
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (reader === undefined) throw new Error('no body');
  await reader.read();
  return {
    requestId: res.headers.get('x-lakka-request-id') ?? '',
    async ended(): Promise<number> {
      for (;;) {
        const { done } = await reader.read();
        if (done) return Date.now();
      }
    },
    cancel: () => reader.cancel(),
  };
}

async function toolCall(ws: WorkspaceView, requestId: string, secret: string) {
  await t.db.insert(schema.toolInvocations).values({
    requestId,
    workspaceId: ws.id,
    principalId: lead.principal.id,
    actingUserId: lead.principal.id,
    callId: `call-${suffix()}`,
    toolName: 'files__search',
    arguments: { query: secret },
    status: 'ok',
    durationMs: 12,
  });
}

function deleteWorkspace(by: SignedInUser | { key: string }, id: string, confirmName: string) {
  return t.app.inject({
    method: 'DELETE',
    url: `/api/workspaces/${id}`,
    headers:
      'key' in by
        ? { authorization: `Bearer ${by.key}` }
        : { cookie: by.cookie, origin: PUBLIC_URL },
    payload: { confirmName },
  });
}

async function instanceSpend(): Promise<SpendReport> {
  return (await as(t, root).get('/api/spend')).json() as SpendReport;
}

/** How many of a table's rows belong to the workspace. */
async function rows(table: string, workspaceId: string): Promise<number> {
  const res = await t.pool.query<{ n: string }>(
    `select count(*)::text as n from ${table} where workspace_id = $1`,
    [workspaceId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function eventFor(principalId: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = events.find(
      (e) => e.principalId === principalId && e.reason === 'workspace_deleted',
    );
    if (found !== undefined) return found;
    await sleep(20);
  }
  throw new Error(`no workspace_deleted event for ${principalId}`);
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  subscription = await subscribe(
    valkeyConfig(),
    'lakka-tests-workspace-deletion',
    [PRINCIPAL_REVOKED_CHANNEL],
    (_c, m) => void events.push(JSON.parse(m) as PrincipalRevokedEvent),
  );
  [root, lead, member] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Lead'),
    signedInUser(t, 'Member'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  quick = await model('ok');
  // One chunk, then quiet: a stream that is still open when the workspace goes.
  idle = await model('idle-after-1');

  doomed = await workspace('doomed');
  kept = await workspace('kept');
  for (const ws of [doomed, kept]) {
    await join(ws, lead, 'admin');
    await join(ws, member, 'member');
    await as(t, root).put(`/api/workspaces/${ws.id}/budgets/workspace`, {
      limitMicroUsd: '100000000',
      period: 'monthly',
    });
    await as(t, root).put(`/api/workspaces/${ws.id}/budgets/members/${member.principal.id}`, {
      limitMicroUsd: '50000000',
      period: 'monthly',
    });
    await as(t, lead).put(`/api/workspaces/${ws.id}/content-capture`, {
      enabled: true,
      retentionDays: 7,
    });
    await t.db.insert(schema.routes).values({
      workspaceId: ws.id,
      name: `summaries-${suffix()}`,
      model: quick.id,
      thresholdDown: 0.6,
      thresholdUp: 0.5,
      createdByPrincipalId: lead.principal.id,
    });
    await t.db.insert(schema.mcpServers).values({
      workspaceId: ws.id,
      name: `files-${suffix()}`,
      transport: 'streamable_http',
      url: 'https://mcp.example.com/mcp',
      authMode: 'none',
      createdByPrincipalId: lead.principal.id,
    });
    await t.db.insert(schema.alertWebhooks).values({
      workspaceId: ws.id,
      url: 'https://hooks.example.com/alerts',
      secret: `whsec-${suffix()}`,
      createdByPrincipalId: lead.principal.id,
    });
  }
  key = (
    await as(t, member).post(`/api/workspaces/${doomed.id}/keys`, { name: 'Nightly report' })
  ).json() as IssuedKey;
  inviteToken = (
    (await as(t, lead).post(`/api/workspaces/${doomed.id}/invites`, { role: 'member' })).json() as {
      token: string;
    }
  ).token;
  requests.doomed = await chatIn(doomed, member);
  requests.kept = await chatIn(kept, member);
  await toolCall(doomed, requests.doomed, 'doomed-args');
  await toolCall(kept, requests.kept, 'kept-args');
});

afterAll(async () => {
  subscription?.close();
  await fake?.close();
  await t?.close();
});

describe('deleting a workspace (ID-8)', () => {
  it('ID-8: only an instance admin deletes a workspace, and only with its exact name', async () => {
    const byAdmin = await deleteWorkspace(lead, doomed.id, doomed.name);
    expect(byAdmin.statusCode).toBe(403);
    expect(code(byAdmin)).toBe('forbidden');
    const byKey = await deleteWorkspace({ key: key.secret }, doomed.id, doomed.name);
    expect(byKey.statusCode).toBe(403);
    const wrongName = await deleteWorkspace(root, doomed.id, `${doomed.name}x`);
    expect(wrongName.statusCode).toBe(400);
    expect(code(wrongName)).toBe('confirmation_mismatch');
    const otherCase = await deleteWorkspace(root, doomed.id, doomed.name.toUpperCase());
    expect(code(otherCase)).toBe('confirmation_mismatch');
    const unknown = await deleteWorkspace(root, uuidv7(), doomed.name);
    expect(unknown.statusCode).toBe(404);
    // Nothing changed.
    expect((await as(t, member).get(`/api/workspaces/${doomed.id}`)).statusCode).toBe(200);
  });

  it('ID-8, AC 6, BG-3: open streams end within 5 seconds, settle their partial usage, and the instance spend does not drop', async () => {
    const before = BigInt((await instanceSpend()).totalMicroUsd);
    const chat = await openStream({ session: member, workspaceId: doomed.id });
    const api = await openStream({ key: key.secret });
    const keptStream = await openStream({ session: member, workspaceId: kept.id });

    const deletedAt = Date.now();
    // Surrounding spaces are forgiven, as when deleting a person.
    const res = await deleteWorkspace(root, doomed.id, `  ${doomed.name} `);
    expect(res.statusCode).toBe(204);

    for (const stream of [chat, api]) {
      expect((await stream.ended()) - deletedAt).toBeLessThan(5000);
    }
    // The same person's stream in another workspace stays open.
    const stillOpen = await Promise.race([
      keptStream.ended().then(() => false),
      sleep(1000).then(() => true),
    ]);
    expect(stillOpen).toBe(true);
    await keptStream.cancel();

    // Each is settled as an abort, with its partial usage (invariant 4).
    for (const stream of [chat, api]) {
      await expect
        .poll(async () =>
          (await listUsageForRequest(t.db, doomed.id, stream.requestId)).map((u) => u.outcome),
        )
        .toEqual(['aborted']);
    }
    const open = await t.pool.query(
      `select id from reservations where workspace_id = $1 and state in ('pending', 'active')`,
      [doomed.id],
    );
    expect(open.rows).toEqual([]);
    expect(BigInt((await instanceSpend()).totalMicroUsd)).toBeGreaterThanOrEqual(before);

    expect(await eventFor(member.principal.id)).toMatchObject({ workspaceId: doomed.id });
    expect(await eventFor(lead.principal.id)).toMatchObject({ workspaceId: doomed.id });
  });

  it('ID-8: a deleted workspace answers 404 everywhere, to its former members and to admins', async () => {
    for (const user of [root, lead, member]) {
      expect((await as(t, user).get(`/api/workspaces/${doomed.id}`)).statusCode).toBe(404);
      expect((await as(t, user).get(`/api/workspaces/${doomed.id}/members`)).statusCode).toBe(404);
      const listed = (
        (await as(t, user).get('/api/workspaces')).json() as { workspaces: WorkspaceView[] }
      ).workspaces.map((w) => w.id);
      expect(listed).not.toContain(doomed.id);
    }
    expect(
      (await as(t, root).patch(`/api/workspaces/${doomed.id}`, { name: 'Back' })).statusCode,
    ).toBe(404);
    // Deleting it again finds nothing.
    expect((await deleteWorkspace(root, doomed.id, doomed.name)).statusCode).toBe(404);
  });

  it('ID-8: its keys, invite links, credentials and webhook go at once', async () => {
    const me = await t.app.inject({
      url: '/api/me',
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(me.statusCode).toBe(401);
    const preview = await t.app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: { origin: PUBLIC_URL },
      payload: { token: inviteToken },
    });
    expect(preview.statusCode).toBe(404);
    for (const table of ['memberships', 'invites', 'mcp_servers', 'alert_webhooks']) {
      expect({ table, n: await rows(table, doomed.id) }).toEqual({ table, n: 0 });
    }
  });

  it('ID-8: members keep their accounts and their other workspaces', async () => {
    const listed = (
      (await as(t, member).get('/api/workspaces')).json() as { workspaces: WorkspaceView[] }
    ).workspaces.map((w) => w.id);
    expect(listed).toEqual([kept.id]);
    expect((await as(t, member).get('/api/me')).statusCode).toBe(200);
  });

  it('ID-8: its slug is free again', async () => {
    const res = await as(t, root).post('/api/workspaces', { name: 'Again', slug: doomed.slug });
    expect(res.statusCode).toBe(201);
  });

  it('ID-8: the instance report keeps its spend, labelled as deleted', async () => {
    const report = await instanceSpend();
    const row = report.byWorkspace.find((w) => w.key === doomed.id);
    expect(row).toMatchObject({ label: doomed.name, deleted: true });
    expect(BigInt(row?.costMicroUsd ?? '0')).toBeGreaterThan(0n);
    expect(report.byWorkspace.find((w) => w.key === kept.id)).toMatchObject({ deleted: false });
  });

  it('NF-S5: the log records the deletion by id, never the name', () => {
    const line = t.logs.find((l) => l.includes('"msg":"workspace.deleted"'));
    expect(line).toBeDefined();
    expect(line).toContain(doomed.id);
    expect(line).toContain(root.principal.id);
    expect(line).not.toContain(doomed.name);
  });
});

describe('the purge (ID-8)', () => {
  it('ID-8: caps are removed only after the last open reservation settles', async () => {
    const caps = await t.pool.query<{ id: string; period: 'daily' | 'monthly' | 'none' }>(
      `select id, period from budgets where workspace_id = $1 and scope = 'workspace'`,
      [doomed.id],
    );
    const cap = caps.rows[0];
    if (cap === undefined) throw new Error('no cap');
    const counter = counterKey('budget:', cap.id, periodStart(cap.period, new Date()));
    expect(await t.cache.runScript(EXISTS, [counter], [])).toBe(1);

    // A request still holding a reservation, as one in flight when the workspace went.
    const reservationId = uuidv7();
    await t.db.insert(schema.reservations).values({
      id: reservationId,
      requestId: uuidv7(),
      workspaceId: doomed.id,
      principalId: member.principal.id,
      actingUserId: member.principal.id,
      amountMicroUsd: 1000n,
      state: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await purge()).toMatchObject({ waiting: 1 });
    expect(await rows('budgets', doomed.id)).toBe(2);

    await t.pool.query(
      `update reservations set state = 'settled', actual_micro_usd = 0, settled_at = now()
        where id = $1`,
      [reservationId],
    );
    expect(await purge()).toMatchObject({ finished: 1, waiting: 0 });
    expect(await rows('budgets', doomed.id)).toBe(0);
    expect(await t.cache.runScript(EXISTS, [counter], [])).toBe(0);
  });

  it('ID-8: the purge removes conversations, attachments, spans and captured content in batches', async () => {
    for (const table of ['conversations', 'messages', 'attachments', 'span_content', 'spans']) {
      expect({ table, n: await rows(table, doomed.id) }).toEqual({ table, n: 0 });
    }
    expect(await rows('routes', doomed.id)).toBe(0);
    // Usage stays: it records the spend (BG-3).
    expect(await rows('usage', doomed.id)).toBeGreaterThan(0);
    const purged = await t.pool.query<{ purged: boolean }>(
      'select purged_at is not null as purged from workspaces where id = $1',
      [doomed.id],
    );
    expect(purged.rows).toEqual([{ purged: true }]);
    expect(purgeLogs.some((l) => l.includes('"msg":"workspace.purged"'))).toBe(true);
  });

  it('ID-8, TL-6: tool invocations stay with their arguments erased', async () => {
    const audit = await t.pool.query(
      'select arguments from tool_invocations where workspace_id = $1',
      [doomed.id],
    );
    expect(audit.rows).toEqual([{ arguments: null }]);
  });

  it('ID-8: running the purge twice is safe', async () => {
    expect(await purge()).toEqual({ finished: 0, waiting: 0 });
  });

  it('ID-8: another workspace keeps everything, checked row by row', async () => {
    for (const table of [
      'memberships',
      'conversations',
      'messages',
      'span_content',
      'spans',
      'usage',
      'routes',
      'mcp_servers',
      'alert_webhooks',
    ]) {
      expect({ table, n: (await rows(table, kept.id)) > 0 }).toEqual({ table, n: true });
    }
    expect(await rows('budgets', kept.id)).toBe(2);
    const args = await t.pool.query(
      'select id from tool_invocations where workspace_id = $1 and arguments is not null',
      [kept.id],
    );
    expect(args.rows).toHaveLength(1);
    expect((await as(t, member).get(`/api/workspaces/${kept.id}`)).statusCode).toBe(200);
  });

  it('ID-8: the last workspace can be deleted, and its members see the empty list', async () => {
    const left = (
      (await as(t, root).get('/api/workspaces')).json() as { workspaces: WorkspaceView[] }
    ).workspaces;
    for (const w of left) {
      expect((await deleteWorkspace(root, w.id, w.name)).statusCode).toBe(204);
    }
    for (const user of [root, member]) {
      const listed = (
        (await as(t, user).get('/api/workspaces')).json() as { workspaces: WorkspaceView[] }
      ).workspaces;
      expect(listed).toEqual([]);
    }
  });
});
