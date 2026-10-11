import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ConversationSummaryView,
  IssuedKey,
  ModelView,
  RouteCandidatesView,
  RouteView,
  RoutingOverridesView,
  RoutingPolicyView,
  WorkspaceView,
} from '@lakka/contracts';
import type { ClassifierRuntime, Embedder } from '@lakka/core';
import { deleteExpiredSpanContent, listSpanContentForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Route example candidates (RT-10, ADR 0114) against real Postgres and Valkey, through the real
 * request path: chat requests over HTTP to the fake provider, routed by a classifier, recorded by
 * content capture, and overridden by the person choosing another model. A candidate is derived
 * from what is kept, so every way that text goes away takes the candidate with it.
 *
 * The embedder counts topic words, as in the pipeline tests, so routing decisions are exact.
 */

const TOPICS = ['python', 'function', 'bug', 'summarize', 'summary', 'recap', 'report', 'meeting'];
function keywordEmbedder(modelId: string): Embedder {
  return {
    modelId,
    dimensions: TOPICS.length,
    embed(text) {
      const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
      const v = Float32Array.from(TOPICS, (topic) => words.filter((w) => w === topic).length);
      const norm = Math.hypot(...v);
      return Promise.resolve(norm === 0 ? v : v.map((x) => x / norm));
    },
  };
}
const embedder = keywordEmbedder('keyword@1');
const classifier: ClassifierRuntime = {
  status: () => 'ready',
  embedder: () => Promise.resolve(embedder),
};

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let admin: SignedInUser;
let member: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let models: { default: string; cheap: string; strong: string };
let summary: RouteView;
let code: RouteView;
let adminKey: IssuedKey;
/** Every message text the tests send, to look for in the logs. */
const said: string[] = [];

const suffix = () => randomBytes(3).toString('hex');
/** Letters only, so the keyword embedder reads it as one word that is no topic. */
const canary = () =>
  `canary${[...randomBytes(8)].map((b) => String.fromCharCode(97 + (b % 26))).join('')}`;

async function customModel(name: string, input: number, output: number): Promise<string> {
  const res = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `ok~${name}-${suffix()}`,
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
      inputMicroUsdPerMtok: input,
      outputMicroUsdPerMtok: output,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { model: ModelView }).model.id;
}

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${suffix()}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function join(user: SignedInUser, role: 'admin' | 'member'): Promise<void> {
  const res = await as(t, root).put(`/api/workspaces/${alpha.id}/members/${user.principal.id}`, {
    role,
  });
  if (res.statusCode !== 200) throw new Error(res.body);
}

async function addRoute(body: object): Promise<RouteView> {
  const res = await as(t, admin).post(`/api/workspaces/${alpha.id}/routes`, body);
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { route: RouteView }).route;
}

async function capture(enabled: boolean): Promise<void> {
  const res = await as(t, admin).put(`/api/workspaces/${alpha.id}/content-capture`, {
    enabled,
    retentionDays: 7,
  });
  if (res.statusCode !== 200) throw new Error(res.body);
}

async function start(user: SignedInUser): Promise<string> {
  const res = await as(t, user).post(`/api/workspaces/${alpha.id}/conversations`, {});
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { conversation: ConversationSummaryView }).conversation.id;
}

/**
 * One chat message in a conversation, over HTTP, read to the end. Returns its request id once
 * the request's trace, and its recorded content if any, are stored.
 */
async function say(
  user: SignedInUser,
  conversationId: string,
  model: string,
  content: string,
): Promise<string> {
  said.push(content);
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: user.cookie,
      origin: PUBLIC_URL,
      'x-lakka-workspace': alpha.id,
      'x-lakka-conversation': conversationId,
    },
    body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content }] }),
  });
  if (res.status !== 200) throw new Error(await res.text());
  await res.text();
  const requestId = res.headers.get('x-lakka-request-id') ?? '';
  for (let i = 0; i < 40; i += 1) {
    await t.tracing.forceFlush();
    const { rows } = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from spans where request_id = $1 and name = 'request'",
      [requestId],
    );
    if ((rows[0]?.n ?? 0) > 0) return requestId;
    await sleep(50);
  }
  throw new Error('the request was never traced');
}

/** The message a conversation is routed on, then the person choosing `chosen` instead. */
async function routedThenOverridden(
  user: SignedInUser,
  chosen: string,
  text = `please summarize the quarterly report ${canary()}`,
) {
  const conversationId = await start(user);
  const decidedBy = await say(user, conversationId, 'auto', text);
  const overrideBy = await say(user, conversationId, chosen, `make it longer ${canary()}`);
  const { rows } = await t.pool.query<{ id: string }>(
    "select id from messages where request_id = $1 and role = 'user'",
    [decidedBy],
  );
  const messageId = rows[0]?.id;
  if (messageId === undefined) throw new Error('the routed message was not stored');
  return { conversationId, decidedBy, overrideBy, messageId, text };
}

const candidatesPath = (ws = alpha) => `/api/workspaces/${ws.id}/routing/candidates`;

async function candidates(user = admin): Promise<RouteCandidatesView> {
  const res = await as(t, user).get(candidatesPath());
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json() as RouteCandidatesView;
}

async function offered(): Promise<string[]> {
  return (await candidates()).groups.flatMap((g) => g.candidates.map((c) => c.messageId));
}

const dismiss = (messageId: string, user = admin, ws = alpha) =>
  as(t, user).post(`${candidatesPath(ws)}/${messageId}/dismiss`, {});

async function policy(): Promise<RoutingPolicyView> {
  return (
    await as(t, admin).get(`/api/workspaces/${alpha.id}/routing`)
  ).json() as RoutingPolicyView;
}

const routeBodyOf = (r: RouteView) => ({
  name: r.name,
  description: r.description,
  model: r.model,
  fallbacks: r.fallbacks,
  allowCrossProvider: r.allowCrossProvider,
  thresholdDown: r.thresholdDown,
  thresholdUp: r.thresholdUp,
  enabled: r.enabled,
  signals: r.signals,
  examples: r.examples,
});

/** Ends a request's recorded content now, as its period running out would. */
async function expireContent(requestId: string): Promise<void> {
  await t.pool.query(
    "update span_content set created_at = now() - interval '2 days', expires_at = now() - interval '1 second' where request_id = $1",
    [requestId],
  );
}

let before: Awaited<ReturnType<typeof routedThenOverridden>>;

beforeAll(async () => {
  t = await createTestApp({ classifier });
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
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  await join(admin, 'admin');
  await join(member, 'member');
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  models = {
    default: await customModel('default', 3_000_000, 15_000_000),
    cheap: await customModel('cheap', 150_000, 600_000),
    strong: await customModel('strong', 15_000_000, 75_000_000),
  };
  code = await addRoute({
    name: 'code',
    model: models.strong,
    signals: ['code_fence'],
    examples: ['fix the python function bug', 'python function bug'],
  });
  summary = await addRoute({
    name: 'summary',
    model: models.cheap,
    examples: ['summarize this report', 'give me a short summary', 'recap the meeting'],
  });
  const settings = await as(t, admin).put(`/api/workspaces/${alpha.id}/routing/settings`, {
    routingEnabled: true,
    defaultModel: models.default,
    pinnedModel: null,
  });
  if (settings.statusCode !== 200) throw new Error(settings.body);
  adminKey = (
    await as(t, admin).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Script' })
  ).json() as IssuedKey;

  // Routed while nothing was recorded; overridden after capture is turned on, below.
  const conversationId = await start(member);
  const text = `please summarize the quarterly report ${canary()}`;
  const decidedBy = await say(member, conversationId, 'auto', text);
  before = { conversationId, decidedBy, overrideBy: '', messageId: '', text };
  await capture(true);
  before.overrideBy = await say(member, conversationId, models.strong, `longer ${canary()}`);
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('route example candidates (RT-10)', () => {
  it('RT-9, RT-10: a candidate is the message the conversation was routed on, grouped by losing route and chosen model', async () => {
    const first = await routedThenOverridden(member, models.strong);
    const second = await routedThenOverridden(member, models.strong);
    const third = await routedThenOverridden(member, models.default);
    expect(await listSpanContentForRequest(t.db, alpha.id, first.decidedBy)).not.toEqual([]);

    const view = await candidates();
    expect(view.capture).toBe(true);
    const groups = view.groups.filter((g) =>
      g.candidates.some((c) => [first, second, third].some((x) => x.messageId === c.messageId)),
    );
    expect(groups.map((g) => [g.route, g.chosenModel, g.candidates.map((c) => c.text)])).toEqual([
      ['summary', models.default, [third.text]],
      ['summary', models.strong, [second.text, first.text]],
    ]);
    const [candidate] = groups[1]?.candidates ?? [];
    expect(candidate?.messageId).toBe(second.messageId);
    // Kept until its recorded content expires: the workspace keeps it for 7 days.
    const keptFor = Date.parse(candidate?.keptUntil ?? '') - Date.parse(candidate?.at ?? '');
    expect(keptFor).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(keptFor).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
    // The override's own message is never a candidate, and neither is the reply.
    const texts = view.groups.flatMap((g) => g.candidates.map((c) => c.text));
    expect(texts.some((x) => x.startsWith('make it longer'))).toBe(false);
  });

  it('RT-10, OB-4: no candidates while capture is off, or for a decision made before capture was on', async () => {
    // Overridden after capture was on, but routed before: nothing of it was recorded.
    expect(await listSpanContentForRequest(t.db, alpha.id, before.decidedBy)).toEqual([]);
    const { rows } = await t.pool.query<{ n: number }>(
      'select count(*)::int as n from usage where request_id = $1 and was_overridden',
      [before.overrideBy],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
    const texts = (await candidates()).groups.flatMap((g) => g.candidates.map((c) => c.text));
    expect(texts).not.toContain(before.text);

    const shown = await offered();
    expect(shown.length).toBeGreaterThan(0);
    await capture(false);
    try {
      expect(await candidates()).toEqual({ capture: false, groups: [] });
      // Nothing can be dismissed or added while it is off, either.
      expect((await dismiss(shown[0] ?? '')).json()).toMatchObject({
        error: { code: 'candidate_gone' },
      });
    } finally {
      await capture(true);
    }
    expect(await offered()).toEqual(shown);
  });

  it('RT-10, OB-4, AC 21: a candidate goes when its recorded content expires', async () => {
    const x = await routedThenOverridden(member, models.strong);
    expect(await offered()).toContain(x.messageId);
    await expireContent(x.decidedBy);
    expect(await offered()).not.toContain(x.messageId);
    // Retention then deletes the content; the message itself is still in the history.
    expect(await deleteExpiredSpanContent(t.db, new Date())).toBeGreaterThan(0);
    expect(await listSpanContentForRequest(t.db, alpha.id, x.decidedBy)).toEqual([]);
    expect(await offered()).not.toContain(x.messageId);
  });

  it('RT-10, NF-P4: deleting the person or the conversation removes the candidate', async () => {
    const mine = await routedThenOverridden(member, models.strong);
    expect(await offered()).toContain(mine.messageId);
    const removed = await as(t, member).delete(
      `/api/workspaces/${alpha.id}/conversations/${mine.conversationId}`,
    );
    expect(removed.statusCode).toBe(204);
    expect(await offered()).not.toContain(mine.messageId);

    const leaver = await signedInUser(t, 'Leaver');
    await join(leaver, 'member');
    const theirs = await routedThenOverridden(leaver, models.strong);
    // A decision recorded for it goes too: nothing about the message is left.
    const dismissed = await routedThenOverridden(leaver, models.strong);
    expect((await dismiss(dismissed.messageId)).statusCode).toBe(204);
    expect(await offered()).toContain(theirs.messageId);
    const deleted = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${leaver.principal.id}`,
      headers: { cookie: root.cookie, origin: PUBLIC_URL },
      payload: { confirmEmail: leaver.email },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await offered()).not.toContain(theirs.messageId);
    const { rows } = await t.pool.query<{ n: number }>(
      'select count(*)::int as n from route_candidate_decisions where message_id = any($1)',
      [[theirs.messageId, dismissed.messageId]],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("RT-10, AC 16: another workspace's id is not_found, a member and a key are refused", async () => {
    const x = await routedThenOverridden(member, models.strong);
    // An admin of alpha is not in bravo: it does not exist for them.
    const elsewhere = await as(t, admin).get(candidatesPath(bravo));
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await dismiss(x.messageId, admin, bravo)).statusCode).toBe(404);
    // An instance admin may manage bravo, but alpha's message is not a candidate there.
    const across = await dismiss(x.messageId, root, bravo);
    expect(across.statusCode).toBe(404);
    expect(across.json()).toMatchObject({ error: { code: 'candidate_gone' } });
    const bravoRoute = await as(t, root).post(`/api/workspaces/${bravo.id}/routes`, {
      name: 'stolen',
      model: models.strong,
      examples: ['an example'],
      fromCandidates: [x.messageId],
    });
    expect(bravoRoute.json()).toMatchObject({ error: { code: 'candidate_gone' } });
    expect((await as(t, root).get(candidatesPath(bravo))).json()).toEqual({
      capture: false,
      groups: [],
    });

    // Reading them shows other people's words: policy management, never a member or a key.
    expect((await as(t, member).get(candidatesPath())).statusCode).toBe(403);
    expect((await dismiss(x.messageId, member)).statusCode).toBe(403);
    const byKey = await t.app.inject({
      method: 'GET',
      url: candidatesPath(),
      headers: { authorization: `Bearer ${adminKey.secret}` },
    });
    expect(byKey.statusCode).toBe(403);
    const keyDismiss = await t.app.inject({
      method: 'POST',
      url: `${candidatesPath()}/${x.messageId}/dismiss`,
      headers: { authorization: `Bearer ${adminKey.secret}` },
    });
    expect(keyDismiss.statusCode).toBe(403);
    // An instance admin who is not a member may manage it, as for the rest of the policy.
    expect((await as(t, root).get(candidatesPath())).statusCode).toBe(200);
    expect(await offered()).toContain(x.messageId);
  });

  it('RT-10, RT-2: adding writes the edited example, recompiles, and the candidate is gone, dismissing hides it', async () => {
    const added = await routedThenOverridden(member, models.strong);
    const dropped = await routedThenOverridden(member, models.strong);
    const current = (await policy()).routes.find((r) => r.id === code.id);
    if (current === undefined) throw new Error('no code route');
    const edited = 'please summarize the python function bug report';
    const res = await as(t, admin).put(`/api/workspaces/${alpha.id}/routes/${code.id}`, {
      ...routeBodyOf(current),
      examples: [...current.examples, edited],
      fromCandidates: [added.messageId],
    });
    expect(res.statusCode).toBe(200);
    const route = (res.json() as { route: RouteView }).route;
    expect(route.examples).toEqual([...current.examples, edited]);
    expect(route.compiled?.exampleCount).toBe(current.examples.length + 1);
    expect(await offered()).not.toContain(added.messageId);
    const { rows } = await t.pool.query<{ decision: string; route_id: string; decided_by: string }>(
      'select decision, route_id, decided_by from route_candidate_decisions where message_id = $1',
      [added.messageId],
    );
    expect(rows).toEqual([
      { decision: 'added', route_id: code.id, decided_by: admin.principal.id },
    ]);
    // Added once: the same candidate cannot be added again.
    const again = await as(t, admin).put(`/api/workspaces/${alpha.id}/routes/${code.id}`, {
      ...routeBodyOf(route),
      fromCandidates: [added.messageId],
    });
    expect(again.json()).toMatchObject({ error: { code: 'candidate_gone' } });

    // A new route from a candidate, too.
    const fresh = await routedThenOverridden(member, models.strong);
    const created = await as(t, admin).post(`/api/workspaces/${alpha.id}/routes`, {
      name: `strong-${suffix()}`,
      model: models.strong,
      examples: ['write a careful long summary of the meeting'],
      fromCandidates: [fresh.messageId],
    });
    expect(created.statusCode).toBe(201);
    expect(await offered()).not.toContain(fresh.messageId);

    expect((await dismiss(dropped.messageId)).statusCode).toBe(204);
    expect(await offered()).not.toContain(dropped.messageId);
    // Final: there is nothing to undo, and dismissing again finds nothing.
    const twice = await dismiss(dropped.messageId);
    expect(twice.statusCode).toBe(404);
    expect(twice.json()).toMatchObject({ error: { code: 'candidate_gone' } });
    const logged = t.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['msg'] === 'routing.candidate_dismissed');
    expect(logged).toContainEqual(
      expect.objectContaining({
        principal_id: admin.principal.id,
        workspace_id: alpha.id,
        message_id: dropped.messageId,
      }),
    );
  });

  it('RT-10: a signal-decided override offers no candidate', async () => {
    const x = await routedThenOverridden(
      member,
      models.cheap,
      `\`\`\`\nprint(1)\n\`\`\`\nwhy does this python function fail ${canary()}`,
    );
    const { rows } = await t.pool.query<{ resolution_rule: string; route_id: string }>(
      'select resolution_rule, route_id from usage where request_id = $1',
      [x.decidedBy],
    );
    expect(rows[0]).toEqual({ resolution_rule: 'signal', route_id: code.id });
    expect(await listSpanContentForRequest(t.db, alpha.id, x.decidedBy)).not.toEqual([]);
    expect(await offered()).not.toContain(x.messageId);
    expect((await candidates()).groups.some((g) => g.routeId === code.id)).toBe(false);
  });

  it('RT-10: failure injection: adding a candidate whose content expired between listing and saving is candidate_gone and leaves the route unchanged', async () => {
    const x = await routedThenOverridden(member, models.strong);
    expect(await offered()).toContain(x.messageId);
    const was = await policy();
    const route = was.routes.find((r) => r.id === summary.id);
    if (route === undefined) throw new Error('no summary route');

    await expireContent(x.decidedBy);
    const res = await as(t, admin).put(`/api/workspaces/${alpha.id}/routes/${summary.id}`, {
      ...routeBodyOf(route),
      thresholdUp: 0.2,
      examples: [...route.examples, x.text],
      fromCandidates: [x.messageId],
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'candidate_gone' } });
    const now = await policy();
    expect(now.settings.policyVersion).toBe(was.settings.policyVersion);
    expect(now.routes.find((r) => r.id === summary.id)).toEqual(route);
    const { rows } = await t.pool.query<{ n: number }>(
      'select count(*)::int as n from route_candidate_decisions where message_id = $1',
      [x.messageId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('RT-9: the chosen model after a budget fallback is the one people picked', async () => {
    const saver = await signedInUser(t, 'Saver');
    await join(saver, 'member');
    // Room for the default model's estimate (about 1,500 micro-USD) but not the strong one's.
    const cap = await as(t, admin).put(
      `/api/workspaces/${alpha.id}/budgets/members/${saver.principal.id}`,
      { limitMicroUsd: '4000', period: 'monthly' },
    );
    expect(cap.statusCode).toBe(200);
    const towardsStrong = async () => {
      const view = (
        await as(t, admin).get(`/api/workspaces/${alpha.id}/routing/overrides`)
      ).json() as RoutingOverridesView;
      return view.routes.find((r) => r.routeId === summary.id)?.suggestion;
    };
    const was = await towardsStrong();
    expect(was?.model).toBe(models.strong);

    const x = await routedThenOverridden(saver, models.strong);
    const { rows } = await t.pool.query<{ model: string; budget_fallback_from: string | null }>(
      'select model, budget_fallback_from from usage where request_id = $1 order by attempt',
      [x.overrideBy],
    );
    // The cap sent it to the default model; the person chose the strong one.
    expect(rows[0]).toEqual({ model: models.default, budget_fallback_from: models.strong });
    const group = (await candidates()).groups.find((g) =>
      g.candidates.some((c) => c.messageId === x.messageId),
    );
    expect(group).toMatchObject({ routeId: summary.id, chosenModel: models.strong });
    expect(await towardsStrong()).toMatchObject({
      model: models.strong,
      overrides: (was?.overrides ?? 0) + 1,
    });
  });

  it('RT-10, NF-S5: no candidate text in logs, with a spy logger', async () => {
    // Every candidate was listed, added or dismissed above; the logs saw ids at most.
    expect(said.length).toBeGreaterThan(10);
    expect(t.logs.length).toBeGreaterThan(0);
    for (const text of said) {
      const word = text.match(/canary[a-z]+/)?.[0] ?? text;
      expect(t.logs.filter((line) => line.includes(word))).toEqual([]);
    }
  });
});
