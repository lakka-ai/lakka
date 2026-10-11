import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IssuedKey, ModelView, RouteView, WorkspaceView } from '@lakka/contracts';
import { listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The OpenAI-compatible surface (API-1 to API-5, G1 to G5, ADR 0059) over real HTTP, against
 * real Postgres and Valkey and a fake provider: responses in the OpenAI shape, streaming, the
 * model field, errors, both kinds of credential, conversations, and client disconnects.
 */

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let member: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let key: IssuedKey;
let models: { ok: ModelView; slow: ModelView; dropping: ModelView; other: ModelView };
let code: RouteView;

async function customModel(scenario: string): Promise<ModelView> {
  const res = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `${scenario}~${randomBytes(3).toString('hex')}`,
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

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

type Auth = { key: string } | { user: SignedInUser; workspace?: string };

function headersFor(auth: Auth, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> =
    'key' in auth
      ? { authorization: `Bearer ${auth.key}` }
      : {
          cookie: auth.user.cookie,
          origin: PUBLIC_URL,
          ...(auth.workspace === undefined ? {} : { 'x-lakka-workspace': auth.workspace }),
        };
  return { 'content-type': 'application/json', ...headers, ...extra };
}

const complete = (auth: Auth, body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: headersFor(auth, extra),
    body: JSON.stringify(body),
  });

const hello = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'Say hello' }],
  max_tokens: 100,
  ...extra,
});

/** The data lines of a server-sent event stream, parsed where they are JSON. */
async function events(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => block.replace(/^data: /, ''))
    .filter((data) => data !== '')
    .map((data) => (data === '[DONE]' ? data : (JSON.parse(data) as unknown)));
}

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { type: string; code: string | null; param: string | null } })
    .error;

async function usageFor(requestId: string) {
  return listUsageForRequest(t.db, alpha.id, requestId);
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, member] = await Promise.all([signedInUser(t, 'Root'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  await as(t, root).put(`/api/workspaces/${alpha.id}/members/${member.principal.id}`, {
    role: 'member',
  });
  const provider = await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  if (provider.statusCode !== 201) throw new Error(provider.body);
  models = {
    ok: await customModel('ok'),
    slow: await customModel('slow'),
    dropping: await customModel('drop-after-2'),
    other: await customModel('ok'),
  };
  code = (
    (
      await as(t, root).post(`/api/workspaces/${alpha.id}/routes`, {
        name: 'code',
        model: models.ok.id,
        signals: ['code_fence'],
      })
    ).json() as { route: RouteView }
  ).route;
  await as(t, root).put(`/api/workspaces/${alpha.id}/routing/settings`, {
    routingEnabled: true,
    defaultModel: models.other.id,
    pinnedModel: null,
  });
  key = (
    await as(t, member).post(`/api/workspaces/${alpha.id}/keys`, { name: 'SDK' })
  ).json() as IssuedKey;
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('/v1/models (API-2)', () => {
  it("API-2, G1: lists auto, the workspace's routes and the models it can use, and nothing else", async () => {
    const res = await fetch(`${base}/v1/models`, { headers: headersFor({ key: key.secret }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: { id: string; object: string }[] };
    expect(body.object).toBe('list');
    const ids = body.data.map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(['auto', 'route/code']);
    expect(ids).toEqual(expect.arrayContaining([models.ok.id, models.slow.id, models.other.id]));
    // Only priced models with a credential: nothing from the catalogue without a provider key.
    expect(
      ids.every((id) => id === 'auto' || id.startsWith('route/') || id.startsWith('fake:')),
    ).toBe(true);
    expect(body.data.every((m) => m.object === 'model')).toBe(true);
  });
});

describe('/v1/chat/completions (API-1)', () => {
  it('API-1: a non-streaming request returns one chat.completion, and the decision in headers (G3)', async () => {
    const res = await complete({ key: key.secret }, hello(models.ok.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: models.ok.id,
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) },
    });
    expect(String(body['id'])).toMatch(/^chatcmpl-/);
    expect(res.headers.get('x-lakka-model')).toBe(models.ok.id);
    expect(res.headers.get('x-lakka-routing-rule')).toBe('explicit');
    const [usage] = await usageFor(res.headers.get('x-lakka-request-id') ?? '');
    // A key's request is the API surface, attributed to the person the key acts for (invariant 2).
    expect(usage).toMatchObject({ surface: 'api', actingUserId: member.principal.id });
  });

  it('API-1: a streamed request sends chunks, a finish, a usage chunk when asked, and [DONE]', async () => {
    const res = await complete(
      { key: key.secret },
      hello(models.ok.id, { stream: true, stream_options: { include_usage: true } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const received = await events(res);
    expect(received.at(-1)).toBe('[DONE]');
    const chunks = received.slice(0, -1) as {
      object: string;
      model: string;
      choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
      usage?: { total_tokens: number };
    }[];
    expect(
      chunks.every((c) => c.object === 'chat.completion.chunk' && c.model === models.ok.id),
    ).toBe(true);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: '' });
    const text = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? '')).join('');
    expect(text).toBe('Hello there');
    const finish = chunks.find((c) => c.choices[0]?.finish_reason !== null && c.choices.length > 0);
    expect(finish?.choices[0]?.finish_reason).toBe('stop');
    const usage = chunks.at(-1);
    expect(usage?.choices).toEqual([]);
    expect(usage?.usage?.total_tokens).toBeGreaterThan(0);
  });

  it('G1, API-4: "auto" runs the resolution order, and "route/<name>" asks for a route', async () => {
    const auto = await complete(
      { key: key.secret },
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'Why?\n```\nx = 1/0\n```' }],
      },
    );
    expect(auto.status).toBe(200);
    expect(auto.headers.get('x-lakka-routing-rule')).toBe('signal');
    expect(auto.headers.get('x-lakka-route')).toBe('code');
    // A signal is certain; only the classifier says how sure it was.
    expect(auto.headers.get('x-lakka-routing-confidence')).toBeNull();
    await auto.text();
    const unsure = await complete({ key: key.secret }, hello('auto'));
    expect(unsure.headers.get('x-lakka-routing-rule')).toBe('default');
    expect(unsure.headers.get('x-lakka-routing-reason')).toBe('no_routes');
    expect(((await unsure.json()) as { model: string }).model).toBe(models.other.id);

    const named = await complete({ key: key.secret }, hello('route/code'));
    expect(named.status).toBe(200);
    expect(named.headers.get('x-lakka-routing-rule')).toBe('explicit');
    expect(named.headers.get('x-lakka-route')).toBe(code.name);
    await named.text();
  });

  it('G5: a signed-in person can call it too, as the chat surface, naming the workspace', async () => {
    const res = await complete({ user: member, workspace: alpha.id }, hello(models.ok.id));
    expect(res.status).toBe(200);
    await res.json();
    const [usage] = await usageFor(res.headers.get('x-lakka-request-id') ?? '');
    expect(usage).toMatchObject({ surface: 'chat', principalId: member.principal.id });
    // One workspace: the header may be left out. Several: it must be given.
    expect((await complete({ user: member }, hello(models.ok.id))).status).toBe(200);
    await as(t, root).put(`/api/workspaces/${bravo.id}/members/${member.principal.id}`, {
      role: 'member',
    });
    const ambiguous = await complete({ user: member }, hello(models.ok.id));
    expect(ambiguous.status).toBe(400);
    expect(((await ambiguous.json()) as { error: { message: string } }).error.message).toMatch(
      /x-lakka-workspace/,
    );
  });

  it('G4: a conversation header keeps one routing decision across requests', async () => {
    const created = await t.pool.query<{ id: string }>(
      `insert into conversations (id, workspace_id, principal_id) values (gen_random_uuid(), $1, $2) returning id`,
      [alpha.id, member.principal.id],
    );
    const conversation = created.rows[0]?.id ?? '';
    const first = await complete(
      { key: key.secret },
      { model: 'auto', messages: [{ role: 'user', content: '```\ncode\n```' }] },
      { 'x-lakka-conversation': conversation },
    );
    expect(first.headers.get('x-lakka-routing-rule')).toBe('signal');
    await first.text();
    const second = await complete({ key: key.secret }, hello('auto'), {
      'x-lakka-conversation': conversation,
    });
    expect(second.headers.get('x-lakka-routing-rule')).toBe('sticky');
    await second.text();
    const bad = await complete({ key: key.secret }, hello('auto'), {
      'x-lakka-conversation': 'nope',
    });
    expect(bad.status).toBe(400);
  });
});

describe('errors in the OpenAI shape (API-5, CH-7)', () => {
  it('API-5, G2: a budget refusal is a 402 of its own type, and nothing is sent', async () => {
    await as(t, root).put(`/api/workspaces/${alpha.id}/budgets/keys/${key.key.id}`, {
      limitMicroUsd: '1',
      period: 'monthly',
    });
    const before = fake.requests.length;
    const res = await complete({ key: key.secret }, hello(models.ok.id));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: unknown; lakka?: Record<string, unknown> };
    expect(body.error).toMatchObject({ type: 'budget_exceeded', code: 'budget_exceeded' });
    // CH-4: the key's cap refused it: 1 micro-USD, all of it left, and less than it needed.
    expect(body.lakka).toMatchObject({ scope: 'key', remaining_micro_usd: '1' });
    expect(BigInt(String(body.lakka?.['required_micro_usd']))).toBeGreaterThan(1n);
    expect(fake.requests.length).toBe(before);
    await as(t, root).delete(`/api/workspaces/${alpha.id}/budgets/keys/${key.key.id}`);
  });

  it('refuses a bad key, an unknown model or route, tools and malformed bodies, each in the OpenAI shape', async () => {
    const badKey = await complete({ key: 'lk_not_a_real_key' }, hello(models.ok.id));
    expect(badKey.status).toBe(401);
    expect(await errorOf(badKey)).toMatchObject({
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    });

    const unknown = await complete({ key: key.secret }, hello('fake:no-such-model'));
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toMatchObject({ code: 'model_not_found' });
    const noRoute = await complete({ key: key.secret }, hello('route/nothing'));
    expect(noRoute.status).toBe(404);
    expect(await errorOf(noRoute)).toMatchObject({ code: 'model_not_found' });

    const tools = await complete(
      { key: key.secret },
      hello(models.ok.id, { tools: [{ type: 'function' }] }),
    );
    expect(tools.status).toBe(400);
    expect(await errorOf(tools)).toMatchObject({
      type: 'invalid_request_error',
      param: 'tools[0]',
    });

    const malformed = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: headersFor({ key: key.secret }),
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect(await errorOf(malformed)).toMatchObject({ type: 'invalid_request_error' });
  });

  it('CH-7: a provider that fails mid-stream ends the stream with an error event, not a raw status', async () => {
    const res = await complete({ key: key.secret }, hello(models.dropping.id, { stream: true }));
    expect(res.status).toBe(200);
    const received = await events(res);
    expect(received.at(-1)).toMatchObject({
      error: { code: 'stream_interrupted', type: 'server_error' },
    });
    expect(received).not.toContain('[DONE]');
  });
});

describe('client disconnects and logs (invariant 4, NF-S5)', () => {
  it('invariant 4: a client that disconnects mid-stream aborts the request, which records its partial usage', async () => {
    const res = await complete({ key: key.secret }, hello(models.slow.id, { stream: true }));
    const requestId = res.headers.get('x-lakka-request-id') ?? '';
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await expect
      .poll(async () => (await usageFor(requestId)).map((u) => u.outcome), { timeout: 5000 })
      .toEqual(['aborted']);
  });

  it('NF-S5: no prompt or response text reaches the logs', () => {
    const logs = t.logs.join('\n');
    for (const text of ['Say hello', 'Hello there', 'x = 1/0']) expect(logs).not.toContain(text);
  });
});
