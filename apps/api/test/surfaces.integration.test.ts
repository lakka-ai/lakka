import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodStart } from '@lakka/contracts';
import type { BudgetView, IssuedKey, ModelView, WorkspaceView } from '@lakka/contracts';
import { PRINCIPAL_REVOKED_CHANNEL } from '@lakka/core';
import { listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * One policy, whichever surface a request comes from (M5 exit, API-3, ADR 0063). Chat is a
 * signed-in person calling /v1 with their session (G5); the API is the same person's key. Below
 * the transport the two must be indistinguishable:
 *   - AC 4: they share one budget, and whichever comes second is downgraded or refused;
 *   - AC 5: equivalent content takes the same route and records the same rule;
 *   - AC 6: revoking access ends both kinds of stream within 5 seconds.
 */

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let provider: string;

const MEMBER_CAP_MICRO_USD = 10_000_000;
const SPENT_MICRO_USD = 9_500_000;

type Caller = { session: SignedInUser } | { key: string };

async function customModel(
  scenario: string,
  outputMicroUsdPerMtok = 2_000_000,
): Promise<ModelView> {
  const res = await as(t, root).post('/api/models/custom', {
    provider,
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
      outputMicroUsdPerMtok,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { model: ModelView }).model;
}

/** A workspace with the person as a member, their key, and a default model. */
async function team(defaultModel: string) {
  const res = await as(t, root).post('/api/workspaces', {
    name: 'Team',
    slug: `team-${randomBytes(3).toString('hex')}`,
  });
  const workspace = (res.json() as { workspace: WorkspaceView }).workspace;
  const person = await signedInUser(t, 'Person');
  await as(t, root).put(`/api/workspaces/${workspace.id}/members/${person.principal.id}`, {
    role: 'member',
  });
  const key = (
    await as(t, person).post(`/api/workspaces/${workspace.id}/keys`, { name: 'Script' })
  ).json() as IssuedKey;
  await as(t, root).put(`/api/workspaces/${workspace.id}/routing/settings`, {
    routingEnabled: true,
    defaultModel,
    pinnedModel: null,
  });
  return { workspace, person, key };
}

/** /v1/chat/completions from chat (a session) or the API (a key), over real HTTP. */
function complete(caller: Caller, workspaceId: string, body: unknown) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers:
      'key' in caller
        ? { 'content-type': 'application/json', authorization: `Bearer ${caller.key}` }
        : {
            'content-type': 'application/json',
            cookie: caller.session.cookie,
            origin: PUBLIC_URL,
            'x-lakka-workspace': workspaceId,
          },
    body: JSON.stringify(body),
  });
}

const ask = (model: string, content: string, stream = false) => ({
  model,
  messages: [{ role: 'user', content }],
  max_tokens: 100,
  stream,
});

/** A stream already delivering: its first chunk has arrived. The rest is read on demand. */
async function openStream(caller: Caller, workspaceId: string, model: string) {
  const res = await complete(caller, workspaceId, ask(model, 'Tell me a long story', true));
  expect(res.status).toBe(200);
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (reader === undefined) throw new Error('no body');
  let text = (await reader.read()).value ?? '';
  return {
    requestId: res.headers.get('x-lakka-request-id') ?? '',
    /** Reads to the end; resolves to everything sent and when it ended. */
    async ended(): Promise<{ text: string; at: number }> {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { text, at: Date.now() };
        text += value;
      }
    },
    cancel: () => reader.cancel(),
  };
}

const lastEvent = (text: string): unknown => {
  const events = text
    .split('\n\n')
    .map((e) => e.replace(/^data: /, '').trim())
    .filter((e) => e !== '');
  return JSON.parse(events.at(-1) ?? 'null') as unknown;
};

async function outcomes(workspaceId: string, requestId: string) {
  return (await listUsageForRequest(t.db, workspaceId, requestId)).map((u) => u.outcome);
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  root = await signedInUser(t, 'Root');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  provider = `fake-${randomBytes(3).toString('hex')}`;
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: provider,
    baseUrl: `${fake.url}/openai/v1`,
  });
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('one budget across surfaces (AC 4)', () => {
  // $0.40 for 100 output tokens, so one fits in the $0.50 left and a second does not.
  const DEAR_OUTPUT = 4_000_000_000;

  for (const [first, second] of [
    ['chat', 'api'],
    ['api', 'chat'],
  ] as const) {
    it(`AC 4: with $0.50 left, a ${first} request holds the budget and the ${second} request that follows is downgraded`, async () => {
      const cheap = await customModel('ok');
      const dear = await customModel('slow', DEAR_OUTPUT);
      const { workspace, person, key } = await team(cheap.id);
      const cap = (
        (
          await as(t, root).put(
            `/api/workspaces/${workspace.id}/budgets/members/${person.principal.id}`,
            { limitMicroUsd: String(MEMBER_CAP_MICRO_USD), period: 'monthly' },
          )
        ).json() as { budget: BudgetView }
      ).budget;
      await t.pool.query(
        'insert into budget_spend (budget_id, period_start, spent_micro_usd) values ($1, $2, $3)',
        [cap.id, periodStart('monthly', new Date()), SPENT_MICRO_USD],
      );
      const via = (surface: 'chat' | 'api'): Caller =>
        surface === 'chat' ? { session: person } : { key: key.secret };

      // The session sees what both surfaces draw from.
      const remaining = await as(t, person).get(
        `/api/workspaces/${workspace.id}/budgets/remaining`,
      );
      expect(remaining.json()).toMatchObject({
        remaining: { remainingMicroUsd: '500000', scope: 'member' },
      });

      const holding = await openStream(via(first), workspace.id, dear.id);
      const late = await complete(via(second), workspace.id, ask(dear.id, 'Me too'));
      expect(late.status).toBe(200);
      expect(late.headers.get('x-lakka-fallback-from')).toBe(dear.id);
      expect(late.headers.get('x-lakka-fallback-scope')).toBe('member');
      expect(late.headers.get('x-lakka-model')).toBe(cheap.id);
      await late.json();
      await holding.ended();

      // Both were charged to the same member cap, each under its own surface.
      const [held] = await listUsageForRequest(t.db, workspace.id, holding.requestId);
      const [downgraded] = await listUsageForRequest(
        t.db,
        workspace.id,
        late.headers.get('x-lakka-request-id') ?? '',
      );
      expect(held).toMatchObject({ surface: first, model: dear.id, budgetFallbackFrom: null });
      expect(downgraded).toMatchObject({
        surface: second,
        model: cheap.id,
        budgetFallbackFrom: dear.id,
      });
      const { rows } = await t.pool.query<{ spent: string }>(
        'select spent_micro_usd::text as spent from budget_spend where budget_id = $1',
        [cap.id],
      );
      const charged = BigInt(held?.costMicroUsd ?? 0) + BigInt(downgraded?.costMicroUsd ?? 0);
      expect(rows[0]?.spent).toBe(String(BigInt(SPENT_MICRO_USD) + charged));
    });
  }
});

describe('one routing policy across surfaces (AC 5)', () => {
  it('AC 5: a chat message and an API call with the same code pick the code route and record the same rule', async () => {
    const general = await customModel('ok');
    const coder = await customModel('ok');
    const { workspace, person, key } = await team(general.id);
    const route = (
      (
        await as(t, root).post(`/api/workspaces/${workspace.id}/routes`, {
          name: 'code',
          model: coder.id,
          signals: ['code_fence'],
        })
      ).json() as { route: { id: string } }
    ).route;
    const content = 'Why does this fail?\n```js\nconst a = 1;\na = 2;\n```';

    const results = [];
    for (const caller of [{ session: person }, { key: key.secret }] satisfies Caller[]) {
      const res = await complete(caller, workspace.id, ask('auto', content));
      expect(res.status).toBe(200);
      await res.json();
      expect(res.headers.get('x-lakka-model')).toBe(coder.id);
      expect(res.headers.get('x-lakka-routing-rule')).toBe('signal');
      expect(res.headers.get('x-lakka-route')).toBe('code');
      const [usage] = await listUsageForRequest(
        t.db,
        workspace.id,
        res.headers.get('x-lakka-request-id') ?? '',
      );
      results.push(usage);
    }
    expect(results.map((u) => [u?.surface, u?.model, u?.resolutionRule, u?.routeId])).toEqual([
      ['chat', coder.id, 'signal', route.id],
      ['api', coder.id, 'signal', route.id],
    ]);
  });
});

describe('revoking access ends live streams (AC 6, G7)', () => {
  const REVOKED = { error: { type: 'permission_error', code: 'access_revoked' } };

  it('AC 6: removing a member ends their chat and API streams within 5 seconds; a colleague streams on', async () => {
    const idle = await customModel('idle-after-1');
    const { workspace, person, key } = await team(idle.id);
    const colleague = await signedInUser(t, 'Colleague');
    await as(t, root).put(`/api/workspaces/${workspace.id}/members/${colleague.principal.id}`, {
      role: 'member',
    });
    const chat = await openStream({ session: person }, workspace.id, idle.id);
    const api = await openStream({ key: key.secret }, workspace.id, idle.id);
    const other = await openStream({ session: colleague }, workspace.id, idle.id);

    const revokedAt = Date.now();
    const removed = await as(t, root).delete(
      `/api/workspaces/${workspace.id}/members/${person.principal.id}`,
    );
    expect(removed.statusCode).toBe(204);
    const [chatEnd, apiEnd] = await Promise.all([chat.ended(), api.ended()]);
    for (const end of [chatEnd, apiEnd]) {
      expect(end.at - revokedAt).toBeLessThan(5000);
      expect(lastEvent(end.text)).toMatchObject(REVOKED);
    }
    // Each is settled as an abort, with its partial usage (invariant 4).
    await expect.poll(() => outcomes(workspace.id, chat.requestId)).toEqual(['aborted']);
    await expect.poll(() => outcomes(workspace.id, api.requestId)).toEqual(['aborted']);

    // The colleague's stream is untouched, and new requests from the removed member are refused.
    const stillOpen = await Promise.race([
      other.ended().then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 1000)),
    ]);
    expect(stillOpen).toBe(true);
    await other.cancel();
    expect((await complete({ session: person }, workspace.id, ask(idle.id, 'Hi'))).status).toBe(
      404,
    );
    expect((await complete({ key: key.secret }, workspace.id, ask(idle.id, 'Hi'))).status).toBe(
      401,
    );
  });

  it('AC 6, ID-6: suspending a person ends their streams from every surface', async () => {
    const idle = await customModel('idle-after-1');
    const { workspace, person, key } = await team(idle.id);
    const chat = await openStream({ session: person }, workspace.id, idle.id);
    const api = await openStream({ key: key.secret }, workspace.id, idle.id);
    const revokedAt = Date.now();
    expect(
      (await as(t, root).post(`/api/users/${person.principal.id}/suspend`, {})).statusCode,
    ).toBe(200);
    for (const end of await Promise.all([chat.ended(), api.ended()])) {
      expect(end.at - revokedAt).toBeLessThan(5000);
      expect(lastEvent(end.text)).toMatchObject(REVOKED);
    }
  });

  it("ID-5: revoking a key ends that key's streams and not its owner's chat", async () => {
    const idle = await customModel('idle-after-1');
    const { workspace, person, key } = await team(idle.id);
    const chat = await openStream({ session: person }, workspace.id, idle.id);
    const api = await openStream({ key: key.secret }, workspace.id, idle.id);
    const revokedAt = Date.now();
    expect(
      (await as(t, person).delete(`/api/workspaces/${workspace.id}/keys/${key.key.id}`)).statusCode,
    ).toBe(204);
    const apiEnd = await api.ended();
    expect(apiEnd.at - revokedAt).toBeLessThan(5000);
    expect(lastEvent(apiEnd.text)).toMatchObject(REVOKED);
    const stillOpen = await Promise.race([
      chat.ended().then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 1000)),
    ]);
    expect(stillOpen).toBe(true);
    await chat.cancel();
  });

  it('a malformed event on the channel is ignored and logged, and nothing ends', async () => {
    const idle = await customModel('idle-after-1');
    const { workspace, person } = await team(idle.id);
    const chat = await openStream({ session: person }, workspace.id, idle.id);
    await t.cache.publish(PRINCIPAL_REVOKED_CHANNEL, '{"principalId":"not a uuid"}');
    await expect.poll(() => t.logs.some((l) => l.includes('revocations.bad_event'))).toBe(true);
    const stillOpen = await Promise.race([
      chat.ended().then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 500)),
    ]);
    expect(stillOpen).toBe(true);
    await chat.cancel();
  });
});

describe('without events, the check against Postgres still ends streams (AC 6, ADR 0063)', () => {
  let quiet: TestApp;
  let quietBase: string;

  beforeAll(async () => {
    quiet = await createTestApp({ revocationEvents: false });
    await quiet.app.listen({ port: 0, host: '127.0.0.1' });
    quietBase = `http://127.0.0.1:${(quiet.app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await quiet.close();
  });

  it('AC 6: a removed member whose event never arrives still loses their stream within 5 seconds', async () => {
    const admin = await signedInUser(quiet, 'Admin');
    await quiet.pool.query('update principals set is_instance_admin = true where id = $1', [
      admin.principal.id,
    ]);
    const person = await signedInUser(quiet, 'Person');
    const workspace = (
      (
        await as(quiet, admin).post('/api/workspaces', {
          name: 'Quiet',
          slug: `quiet-${randomBytes(3).toString('hex')}`,
        })
      ).json() as { workspace: WorkspaceView }
    ).workspace;
    await as(quiet, admin).put(`/api/workspaces/${workspace.id}/members/${person.principal.id}`, {
      role: 'member',
    });
    const name = `fake-${randomBytes(3).toString('hex')}`;
    await as(quiet, admin).post('/api/providers', {
      kind: 'openai-compatible',
      name,
      baseUrl: `${fake.url}/openai/v1`,
    });
    const idle = (
      (
        await as(quiet, admin).post('/api/models/custom', {
          provider: name,
          model: `idle-after-1~${randomBytes(3).toString('hex')}`,
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
        })
      ).json() as { model: ModelView }
    ).model;

    const res = await fetch(`${quietBase}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: person.cookie,
        origin: PUBLIC_URL,
        'x-lakka-workspace': workspace.id,
      },
      body: JSON.stringify(ask(idle.id, 'Tell me a long story', true)),
    });
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    let text = (await reader?.read())?.value ?? '';
    const revokedAt = Date.now();
    await as(quiet, admin).delete(`/api/workspaces/${workspace.id}/members/${person.principal.id}`);
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      text += next.value;
    }
    expect(Date.now() - revokedAt).toBeLessThan(5000);
    expect(lastEvent(text)).toMatchObject(REVOKED_EVENT);
    expect(
      quiet.logs.some(
        (l) => l.includes('request.revoked') && l.includes('"dependency":"postgres"'),
      ),
    ).toBe(true);
  });
});

const REVOKED_EVENT = { error: { code: 'access_revoked' } };

/** An app of its own, since each test closes it, with a slow model and one that stalls. */
async function closingApp(shutdownDrainMs: number) {
  const closing = await createTestApp({ revocationEvents: false, shutdownDrainMs });
  await closing.app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(closing.app.server.address() as AddressInfo).port}`;
  const admin = await signedInUser(closing, 'Admin');
  await closing.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  const workspace = (
    (
      await as(closing, admin).post('/api/workspaces', {
        name: 'Closing',
        slug: `closing-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  // A cap, so each request holds a reservation (no cap, no hold).
  await as(closing, admin).put(
    `/api/workspaces/${workspace.id}/budgets/members/${admin.principal.id}`,
    { limitMicroUsd: '10000000', period: 'monthly' },
  );
  const name = `fake-${randomBytes(3).toString('hex')}`;
  await as(closing, admin).post('/api/providers', {
    kind: 'openai-compatible',
    name,
    baseUrl: `${fake.url}/openai/v1`,
  });
  const model = async (scenario: string) =>
    (
      (
        await as(closing, admin).post('/api/models/custom', {
          provider: name,
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
        })
      ).json() as { model: ModelView }
    ).model;
  const [slow, idle] = [await model('slow'), await model('idle-after-1')];
  // fetch keeps its connections alive, as a proxy in front of the api does.
  const send = (modelId: string, stream = true) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: admin.cookie,
        origin: PUBLIC_URL,
        'x-lakka-workspace': workspace.id,
      },
      body: JSON.stringify(ask(modelId, 'Tell me a long story', stream)),
    });
  /** The request's reservation and what its usage rows cost. */
  const settled = async (requestId: string) => {
    const { rows } = await closing.pool.query<{ state: string; actual: string | null }>(
      'select state, actual_micro_usd::text as actual from reservations where request_id = $1',
      [requestId],
    );
    const usage = await listUsageForRequest(closing.db, workspace.id, requestId);
    return {
      reservations: rows,
      usage: usage.map((u) => ({ outcome: u.outcome, cost: String(u.costMicroUsd) })),
    };
  };
  return { closing, send, settled, slow, idle };
}

describe('shutdown with requests in flight (NF-O5, ADR 0081)', () => {
  it('NF-O5: a stream in flight when shutdown starts finishes, and its reservation is settled at its cost', async () => {
    const { closing, send, settled, slow } = await closingApp(10_000);
    try {
      const res = await send(slow.id);
      expect(res.status).toBe(200);
      const requestId = res.headers.get('x-lakka-request-id') ?? '';
      const body = res.text();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const closed = closing.app.close();
      // Nothing new is taken on while it drains.
      const late = await send(slow.id).catch(() => null);
      expect(late === null || late.status === 503).toBe(true);
      await late?.text();
      const text = await body;
      expect(text).toContain('w39 ');
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
      expect(text).not.toContain('server_shutting_down');
      await closed;
      const { reservations, usage } = await settled(requestId);
      expect(usage).toMatchObject([{ outcome: 'completed' }]);
      expect(reservations).toEqual([{ state: 'settled', actual: usage[0]?.cost }]);
    } finally {
      await closing.close();
    }
  });

  it('NF-O5: a stream still open when the drain ends gets an error event, and its partial usage is settled', async () => {
    const { closing, send, settled, idle } = await closingApp(300);
    try {
      const res = await send(idle.id);
      const requestId = res.headers.get('x-lakka-request-id') ?? '';
      const body = res.text();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const started = Date.now();
      await closing.app.close();
      // The drain, then the wait for the ended streams to be written, and no longer.
      expect(Date.now() - started).toBeLessThan(3000);
      expect(lastEvent(await body)).toMatchObject({ error: { code: 'server_shutting_down' } });
      const { reservations, usage } = await settled(requestId);
      expect(usage).toHaveLength(1);
      expect(usage[0]?.outcome).not.toBe('completed');
      // Settled with what was used, not released whole and not left holding the budget.
      expect(reservations).toEqual([{ state: 'settled', actual: usage[0]?.cost }]);
    } finally {
      await closing.close();
    }
  });

  it("NF-O5: a drain longer than Fastify's 10 s plugin timeout still closes cleanly", async () => {
    const { closing, send, settled, idle } = await closingApp(10_500);
    try {
      const res = await send(idle.id);
      const requestId = res.headers.get('x-lakka-request-id') ?? '';
      const body = res.text();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await closing.app.close();
      expect(lastEvent(await body)).toMatchObject({ error: { code: 'server_shutting_down' } });
      expect((await settled(requestId)).reservations).toMatchObject([{ state: 'settled' }]);
    } finally {
      await closing.close();
    }
  }, 30_000);

  it('NF-O5: a request that is not streamed also finishes during the drain', async () => {
    const { closing, send, settled, slow } = await closingApp(10_000);
    try {
      const pending = send(slow.id, false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const closed = closing.app.close();
      const res = await pending;
      expect(res.status).toBe(200);
      const requestId = res.headers.get('x-lakka-request-id') ?? '';
      expect(
        ((await res.json()) as { choices: { finish_reason: string }[] }).choices[0]?.finish_reason,
      ).toBe('stop');
      await closed;
      expect((await settled(requestId)).reservations).toMatchObject([{ state: 'settled' }]);
    } finally {
      await closing.close();
    }
  });
});

describe('a store outage before core (ADR 0056)', () => {
  it('BG-4, AC 9: with Postgres unreachable while a key is checked, /v1 refuses with budget_unavailable', async () => {
    const down = await createTestApp({ unreachableDatabase: true, revocationEvents: false });
    try {
      // A key of the right shape, so authentication has to ask the database.
      const key = `lk_${randomBytes(32).toString('base64url')}`;
      for (const [method, url, payload] of [
        ['GET', '/v1/models', undefined],
        ['POST', '/v1/chat/completions', ask('auto', 'Hello')],
      ] as const) {
        const res = await down.app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${key}` },
          ...(payload === undefined ? {} : { payload }),
        });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ error: { code: 'budget_unavailable' } });
      }
    } finally {
      await down.close();
    }
  });
});
