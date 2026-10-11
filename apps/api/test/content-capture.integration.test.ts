import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentCaptureView, IssuedKey, ModelView, WorkspaceView } from '@lakka/contracts';
import { listSpanContentForRequest, listSpansForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Content capture (OB-4, NF-P3, AC 20, ADR 0077), against real Postgres: off by default, and then
 * nothing of what was said is in the trace store; turned on only by a workspace admin, logged
 * with who did it; while on, each model call's prompt and reply are kept for the workspace's
 * period, in span_content and nowhere else.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let admin: SignedInUser;
let member: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let model: ModelView;
let adminKey: IssuedKey;

const suffix = () => randomBytes(3).toString('hex');
const capturePath = (ws = alpha) => `/api/workspaces/${ws.id}/content-capture`;

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', { name, slug: `${name}-${suffix()}` });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function capture(user = member): Promise<ContentCaptureView> {
  return ((await as(t, user).get(capturePath())).json() as { capture: ContentCaptureView }).capture;
}

/** Sends one message as the member and waits until its trace is stored. */
async function say(content: unknown): Promise<string> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: member.cookie,
      origin: PUBLIC_URL,
      'x-lakka-workspace': alpha.id,
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: 100,
      messages: [{ role: 'user', content }],
    }),
  });
  expect(res.status).toBe(200);
  await res.text();
  const requestId = res.headers.get('x-lakka-request-id') ?? '';
  for (let i = 0; i < 40; i += 1) {
    await t.tracing.forceFlush();
    const spans = await listSpansForRequest(t.db, alpha.id, requestId);
    if (spans.some((s) => s.name === 'request')) return requestId;
    await sleep(50);
  }
  throw new Error('the request was never traced');
}

/** Whether a string appears anywhere in the trace store, spans and captured content alike. */
async function inTraceStore(text: string): Promise<{ spans: number; content: number }> {
  const like = `%${text}%`;
  const spans = await t.pool.query<{ n: number }>(
    'select count(*)::int as n from spans where attributes::text like $1 or events::text like $1 or name like $1',
    [like],
  );
  const content = await t.pool.query<{ n: number }>(
    'select count(*)::int as n from span_content where prompt::text like $1 or response::text like $1',
    [like],
  );
  return { spans: spans.rows[0]?.n ?? -1, content: content.rows[0]?.n ?? -1 };
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, admin, member] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Member'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('alpha');
  bravo = await workspace('bravo');
  await as(t, root).put(`/api/workspaces/${alpha.id}/members/${admin.principal.id}`, {
    role: 'admin',
  });
  await as(t, root).put(`/api/workspaces/${alpha.id}/members/${member.principal.id}`, {
    role: 'member',
  });
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  const created = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `ok~${suffix()}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: true,
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
  model = (created.json() as { model: ModelView }).model;
  adminKey = (
    await as(t, admin).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Script' })
  ).json() as IssuedKey;
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('content capture (OB-4, NF-P3)', () => {
  it('OB-4, AC 20: capture is off by default, and nothing of what was said reaches the trace store', async () => {
    expect(await capture()).toEqual({
      enabled: false,
      retentionDays: 7,
      changedAt: null,
      changedBy: null,
    });
    const canary = `canary-${randomBytes(6).toString('hex')}`;
    const requestId = await say(`Please remember ${canary}`);
    expect(await inTraceStore(canary)).toEqual({ spans: 0, content: 0 });
    // Nor the reply.
    expect(await inTraceStore('Hello there')).toEqual({ spans: 0, content: 0 });
    expect(await listSpanContentForRequest(t.db, alpha.id, requestId)).toEqual([]);
  });

  it("NF-P3: only a workspace admin turns it on, not a member, a key, or another workspace's admin", async () => {
    const body = { enabled: true, retentionDays: 3 };
    expect((await as(t, member).put(capturePath(), body)).statusCode).toBe(403);
    const byKey = await t.app.inject({
      method: 'PUT',
      url: capturePath(),
      headers: { authorization: `Bearer ${adminKey.secret}` },
      payload: body,
    });
    expect(byKey.statusCode).toBe(403);
    expect((await as(t, admin).put(capturePath(bravo), body)).statusCode).toBe(404);
    expect(
      (await as(t, admin).put(capturePath(), { enabled: true, retentionDays: 91 })).statusCode,
    ).toBe(400);
    expect((await capture()).enabled).toBe(false);
  });

  it('NF-P3: turning it on is logged with who did it, and shown with the setting', async () => {
    const logsBefore = t.logs.length;
    const res = await as(t, admin).put(capturePath(), { enabled: true, retentionDays: 3 });
    expect(res.statusCode).toBe(200);
    const shown = await capture();
    expect(shown).toMatchObject({
      enabled: true,
      retentionDays: 3,
      changedBy: { id: admin.principal.id, displayName: 'Admin' },
    });
    expect(shown.changedAt).not.toBeNull();
    const logged = t.logs
      .slice(logsBefore)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['msg'] === 'workspace.content_capture_changed');
    expect(logged).toMatchObject([
      {
        principal_id: admin.principal.id,
        workspace_id: alpha.id,
        status: 'on',
        retention_days: 3,
      },
    ]);
  });

  it("OB-4: while on, each model call's prompt and reply are kept for the period, and only there", async () => {
    const canary = `canary-${randomBytes(6).toString('hex')}`;
    const requestId = await say(`Please remember ${canary}`);
    const [kept] = await listSpanContentForRequest(t.db, alpha.id, requestId);
    expect(kept?.prompt).toEqual({
      messages: [{ role: 'user', content: `Please remember ${canary}` }],
    });
    expect(kept?.response).toEqual({ text: 'Hello there', finishReason: 'stop' });
    // It belongs to the model call's span, and expires after the workspace's period.
    const spans = await listSpansForRequest(t.db, alpha.id, requestId);
    const call = spans.find((s) => s.name.startsWith('chat '));
    expect(kept).toMatchObject({ traceId: call?.traceId, spanId: call?.spanId });
    const days = ((kept?.expiresAt.getTime() ?? 0) - (kept?.createdAt.getTime() ?? 0)) / 86_400_000;
    expect(days).toBeCloseTo(3, 1);
    // Spans still carry none of it.
    expect((await inTraceStore(canary)).spans).toBe(0);
    // And a request's content is read within its own workspace only (AC 16).
    expect(await listSpanContentForRequest(t.db, bravo.id, requestId)).toEqual([]);
  });

  it("a file's bytes are not kept, only what it was", async () => {
    const requestId = await say([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
    ]);
    const [kept] = await listSpanContentForRequest(t.db, alpha.id, requestId);
    expect(kept?.prompt).toEqual({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'file', mediaType: 'image/png', bytes: PNG.length },
          ],
        },
      ],
    });
    expect(JSON.stringify(kept?.prompt)).not.toContain(PNG.toString('base64'));
  });

  it('turning it off stops the recording at once', async () => {
    expect(
      (await as(t, admin).put(capturePath(), { enabled: false, retentionDays: 3 })).statusCode,
    ).toBe(200);
    const canary = `canary-${randomBytes(6).toString('hex')}`;
    const requestId = await say(`Please remember ${canary}`);
    expect(await listSpanContentForRequest(t.db, alpha.id, requestId)).toEqual([]);
    expect(await inTraceStore(canary)).toEqual({ spans: 0, content: 0 });
  });
});
