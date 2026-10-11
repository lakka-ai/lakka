import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ConversationSummaryView,
  ConversationView,
  IssuedKey,
  ModelView,
  RequestableView,
  WorkspaceView,
} from '@lakka/contracts';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Conversations and their history (CH-1, CH-2, CH-3, CH-5, invariant 9, ADR 0060): managed by
 * their owner only, and written by /v1/chat/completions when a request names one.
 */

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let member: SignedInUser;
let colleague: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let key: IssuedKey;
let models: { ok: ModelView; vision: ModelView; slow: ModelView; dropping: ModelView };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function customModel(scenario: string, vision = false): Promise<ModelView> {
  const res = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `${scenario}~${randomBytes(3).toString('hex')}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision,
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

const paths = (ws = alpha) => `/api/workspaces/${ws.id}/conversations`;

async function start(user: SignedInUser, body: unknown = {}): Promise<ConversationSummaryView> {
  const res = await as(t, user).post(paths(), body);
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { conversation: ConversationSummaryView }).conversation;
}

async function read(user: SignedInUser, id: string): Promise<ConversationView> {
  return ((await as(t, user).get(`${paths()}/${id}`)).json() as { conversation: ConversationView })
    .conversation;
}

/** A chat-completions request, over HTTP, optionally in a conversation. */
function chat(body: unknown, conversationId?: string, user = member) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: user.cookie,
      origin: PUBLIC_URL,
      'x-lakka-workspace': alpha.id,
      ...(conversationId === undefined ? {} : { 'x-lakka-conversation': conversationId }),
    },
    body: JSON.stringify(body),
  });
}

const say = (model: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content }],
  max_tokens: 100,
  ...extra,
});

async function messageCount(): Promise<number> {
  const { rows } = await t.pool.query<{ n: number }>('select count(*)::int as n from messages');
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, member, colleague] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Colleague'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  for (const user of [member, colleague]) {
    await as(t, root).put(`/api/workspaces/${alpha.id}/members/${user.principal.id}`, {
      role: 'member',
    });
  }
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  models = {
    ok: await customModel('ok'),
    vision: await customModel('ok', true),
    slow: await customModel('slow'),
    dropping: await customModel('drop-after-2'),
  };
  await as(t, root).put(`/api/workspaces/${alpha.id}/routing/settings`, {
    routingEnabled: false,
    defaultModel: models.ok.id,
    pinnedModel: null,
  });
  key = (
    await as(t, member).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Script' })
  ).json() as IssuedKey;
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('managing conversations (CH-1, CH-3)', () => {
  it('CH-1, CH-3: an owner starts, lists, renames, picks a model for, and deletes a conversation', async () => {
    const first = await start(member);
    expect(first).toMatchObject({ title: '', modelChoice: null });
    const second = await start(member, { title: 'Planning', modelChoice: models.ok.id });
    const listed = (await as(t, member).get(paths())).json() as {
      conversations: ConversationSummaryView[];
    };
    expect(listed.conversations.map((c) => c.id).slice(0, 2)).toEqual([second.id, first.id]);

    const renamed = await as(t, member).patch(`${paths()}/${first.id}`, {
      title: '  Quarterly report  ',
      modelChoice: 'route/code',
    });
    expect(renamed.json()).toMatchObject({
      conversation: { title: 'Quarterly report', modelChoice: 'route/code' },
    });
    // The most recently changed comes first.
    const after = (await as(t, member).get(paths())).json() as {
      conversations: ConversationSummaryView[];
    };
    expect(after.conversations[0]?.id).toBe(first.id);
    expect(
      (await as(t, member).patch(`${paths()}/${first.id}`, { modelChoice: null })).json(),
    ).toMatchObject({ conversation: { modelChoice: null } });
    expect((await as(t, member).patch(`${paths()}/${first.id}`, {})).statusCode).toBe(400);

    expect((await as(t, member).delete(`${paths()}/${second.id}`)).statusCode).toBe(204);
    expect((await as(t, member).get(`${paths()}/${second.id}`)).statusCode).toBe(404);
    expect((await as(t, member).delete(`${paths()}/${second.id}`)).statusCode).toBe(404);
  });

  it("AC 16: someone else's conversation does not exist for them, in this workspace or another", async () => {
    const mine = await start(member);
    for (const res of [
      await as(t, colleague).get(`${paths()}/${mine.id}`),
      await as(t, colleague).patch(`${paths()}/${mine.id}`, { title: 'x' }),
      await as(t, colleague).delete(`${paths()}/${mine.id}`),
      await as(t, root).get(`${paths()}/${mine.id}`),
      await as(t, member).get(`${paths(bravo)}/${mine.id}`),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    const theirs = (await as(t, colleague).get(paths())).json() as {
      conversations: { id: string }[];
    };
    expect(theirs.conversations.map((c) => c.id)).not.toContain(mine.id);
  });

  it("invariant 2: a key's conversations are its owner's", async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: paths(),
      headers: { authorization: `Bearer ${key.secret}` },
      payload: { title: 'From a script' },
    });
    expect(res.statusCode).toBe(201);
    const { conversation } = res.json() as { conversation: ConversationSummaryView };
    expect((await read(member, conversation.id)).title).toBe('From a script');
  });
});

describe('history written by requests (CH-1, CH-2, CH-5, invariant 9)', () => {
  it('CH-1, CH-2: each turn is stored with the reply, which says which model answered and why', async () => {
    const conversation = await start(member);
    const first = await chat(
      say(models.ok.id, 'Summarize the plan for the launch please'),
      conversation.id,
    );
    expect(first.status).toBe(200);
    await first.json();
    const second = await chat(
      {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Summarize the plan for the launch please' },
          { role: 'assistant', content: 'Hello there' },
          { role: 'user', content: 'Shorter?' },
        ],
      },
      conversation.id,
    );
    expect(second.status).toBe(200);
    await second.json();
    const history = await read(member, conversation.id);
    expect(history.title).toBe('Summarize the plan for the launch please');
    expect(history.messages.map((m) => [m.role, m.content, m.state])).toEqual([
      ['user', 'Summarize the plan for the launch please', 'complete'],
      ['assistant', 'Hello there', 'complete'],
      ['user', 'Shorter?', 'complete'],
      ['assistant', 'Hello there', 'complete'],
    ]);
    expect(history.messages[1]).toMatchObject({ model: models.ok.id, routingRule: 'explicit' });
    expect(history.messages[3]).toMatchObject({ routingRule: 'default', routeName: null });
  });

  it('CH-2, CH-4: a stored reply names its model for people, says why the default answered, and what it cost', async () => {
    const conversation = await start(member);
    const res = await chat(
      say('auto', 'Summarize the plan for the launch please'),
      conversation.id,
    );
    await res.json();
    const [turn, reply] = (await read(member, conversation.id)).messages;
    expect(turn).toMatchObject({ role: 'user', costMicroUsd: null, modelName: null });
    expect(reply).toMatchObject({
      role: 'assistant',
      model: models.ok.id,
      modelName: models.ok.displayName,
      routingRule: 'default',
      routingReason: 'routing_off',
      routingConfidence: null,
      fallbackFrom: null,
      fallbackScope: null,
      tools: null,
    });
    // Priced at $1 and $2 per million tokens: a few tokens cost a few micro-USD, never nothing.
    expect(reply?.costMicroUsd).toMatch(/^[1-9]\d*$/);
  });

  it('CH-5: files are stored with their message and can be read back by their owner, safely typed', async () => {
    const conversation = await start(member);
    const res = await chat(
      say(models.vision.id, [
        { type: 'text', text: '' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` },
        },
      ]),
      conversation.id,
    );
    expect(res.status).toBe(200);
    await res.json();
    const history = await read(member, conversation.id);
    const [attachment] = history.messages[0]?.attachments ?? [];
    expect(attachment).toMatchObject({ mediaType: 'image/png', sizeBytes: PNG.length });
    // No text, and no file name: the title stays empty until renamed.
    expect(history.title).toBe('');
    const url = `${paths()}/${conversation.id}/attachments/${attachment?.id}`;
    const file = await as(t, member).get(url);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    expect(file.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    expect((await as(t, colleague).get(url)).statusCode).toBe(404);
  });

  it("invariant 9, AC 16: a request that names no conversation, is refused, or names someone else's stores no text", async () => {
    const before = await messageCount();
    const plain = await chat(say(models.ok.id, 'Nothing to keep'));
    await plain.json();
    const conversation = await start(member);
    const refused = await chat(say('fake:no-such-model', 'Also nothing'), conversation.id);
    expect(refused.status).toBe(404);
    await refused.json();
    const intruder = await chat(say(models.ok.id, 'Not yours'), conversation.id, colleague);
    expect(intruder.status).toBe(404);
    await intruder.json();
    expect(await messageCount()).toBe(before);
  });

  it('CH-1: a reply cut short keeps what arrived, marked as such', async () => {
    const dropped = await start(member);
    const res = await chat(
      say(models.dropping.id, 'Tell me a long story', { stream: true }),
      dropped.id,
    );
    await res.text();
    const history = await read(member, dropped.id);
    expect(history.messages.map((m) => [m.role, m.state])).toEqual([
      ['user', 'complete'],
      ['assistant', 'interrupted'],
    ]);
    expect(history.messages[1]?.content).not.toBe('');

    const abandoned = await start(member);
    const stream = await chat(say(models.slow.id, 'Count slowly', { stream: true }), abandoned.id);
    const reader = stream.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await expect
      .poll(async () => (await read(member, abandoned.id)).messages.map((m) => m.state), {
        timeout: 5000,
      })
      .toEqual(['complete', 'aborted']);
  });

  it('NF-S5: message text reaches the database, never the logs', () => {
    const logs = t.logs.join('\n');
    for (const text of ['Summarize the plan', 'Hello there', 'Tell me a long story']) {
      expect(logs).not.toContain(text);
    }
  });
});

describe('files sent again by id (CH-5, ADR 0062)', () => {
  it('CH-5: a later turn refers to an earlier file by id, and the model receives it again', async () => {
    const conversation = await start(member);
    const first = await chat(
      say(models.vision.id, [
        { type: 'text', text: 'What is in this picture?' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` },
        },
      ]),
      conversation.id,
    );
    await first.json();
    const [stored] = (await read(member, conversation.id)).messages[0]?.attachments ?? [];
    expect(stored).toBeDefined();

    const before = fake.count(models.vision.model);
    const second = await chat(
      {
        model: models.vision.id,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this picture?' },
              { type: 'file', file: { file_id: stored?.id } },
            ],
          },
          { role: 'assistant', content: 'Hello there' },
          { role: 'user', content: 'And the colours?' },
        ],
      },
      conversation.id,
    );
    expect(second.status).toBe(200);
    await second.json();
    expect(fake.count(models.vision.model)).toBe(before + 1);
    const sent = fake.requests.findLast((r) => r.model === models.vision.model);
    expect(JSON.stringify(sent?.body)).toContain(PNG.toString('base64'));

    // Only the new turn is stored; the file is not stored a second time.
    const history = await read(member, conversation.id);
    expect(history.messages.map((m) => [m.role, m.attachments.length])).toEqual([
      ['user', 1],
      ['assistant', 0],
      ['user', 0],
      ['assistant', 0],
    ]);
  });

  it('CH-5: a text file reaches a text-only model as its text, and is stored like any file (ADR 0106)', async () => {
    const conversation = await start(member);
    const notes = Buffer.from('# Plan\nShip on Friday, ünd test first.', 'utf8');
    const first = await chat(
      say(models.ok.id, [
        { type: 'text', text: 'Summarize my notes' },
        {
          type: 'file',
          file: {
            file_data: `data:text/plain;base64,${notes.toString('base64')}`,
            filename: 'notes.md',
          },
        },
      ]),
      conversation.id,
    );
    expect(first.status).toBe(200);
    await first.json();
    const sent = JSON.stringify(fake.requests.findLast((r) => r.model === models.ok.model)?.body);
    expect(sent).toContain(
      '<document name=\\"notes.md\\">\\n# Plan\\nShip on Friday, ünd test first.',
    );
    expect(sent).not.toContain(notes.toString('base64'));

    const [stored] = (await read(member, conversation.id)).messages[0]?.attachments ?? [];
    expect(stored).toMatchObject({ mediaType: 'text/plain', filename: 'notes.md' });
    const file = await as(t, member).get(`${paths()}/${conversation.id}/attachments/${stored?.id}`);
    expect(file.rawPayload.equals(notes)).toBe(true);
    // Downloaded, never shown in the page.
    expect(file.headers['content-disposition']).toMatch(/^attachment; /);
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    // Sent again by id on a later turn, it is still text.
    const again = await chat(
      {
        model: models.ok.id,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Summarize my notes' },
              { type: 'file', file: { file_id: stored?.id } },
            ],
          },
          { role: 'assistant', content: 'Hello there' },
          { role: 'user', content: 'And the date?' },
        ],
      },
      conversation.id,
    );
    expect(again.status).toBe(200);
    await again.json();
    expect(
      JSON.stringify(fake.requests.findLast((r) => r.model === models.ok.model)?.body),
    ).toContain('Ship on Friday');
  });

  it('CH-5: a text file that is not UTF-8 is refused before anything is sent or stored', async () => {
    const conversation = await start(member);
    const before = fake.count(models.ok.model);
    const res = await chat(
      say(models.ok.id, [
        {
          type: 'file',
          file: {
            file_data: `data:text/plain;base64,${Buffer.from([0x47, 0x72, 0xfc]).toString('base64')}`,
            filename: 'latin1.txt',
          },
        },
      ]),
      conversation.id,
    );
    expect(res.status).toBe(400);
    await res.json();
    expect(fake.count(models.ok.model)).toBe(before);
    expect((await read(member, conversation.id)).messages).toEqual([]);
  });

  it("AC 16: a file id from someone else's conversation, or without a conversation, is refused", async () => {
    const mine = await start(member);
    const upload = await chat(
      say(models.vision.id, [
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` },
        },
      ]),
      mine.id,
    );
    await upload.json();
    const [file] = (await read(member, mine.id)).messages[0]?.attachments ?? [];
    const refer = say(models.vision.id, [
      { type: 'text', text: 'Describe it' },
      { type: 'file', file: { file_id: file?.id } },
    ]);

    const theirs = await start(colleague);
    const stolen = await chat(refer, theirs.id, colleague);
    expect(stolen.status).toBe(400);
    expect(((await stolen.json()) as { error: { param: string } }).error.param).toBe(
      'messages[0].content[1].file.file_id',
    );
    const loose = await chat(refer);
    expect(loose.status).toBe(400);
    expect(((await loose.json()) as { error: { param: string } }).error.param).toBe(
      'messages[0].content[1].file',
    );
    expect((await read(colleague, theirs.id)).messages).toEqual([]);
  });
});

async function requestable(user: SignedInUser, ws = alpha) {
  const res = await as(t, user).get(`/api/workspaces/${ws.id}/requestable`);
  return { status: res.statusCode, view: res.json() as RequestableView };
}

describe('what each choice can read (CH-5, ADR 0062)', () => {
  it('CH-5: a model reads what it supports, a route what any of its models does, auto what it could pick', async () => {
    await as(t, root).post(`/api/workspaces/${alpha.id}/routes`, {
      name: 'look',
      model: models.ok.id,
      fallbacks: [models.vision.id],
      signals: ['code_fence'],
    });
    const off = (await requestable(member)).view;
    expect(off.models.find((m) => m.id === models.ok.id)?.input).toEqual({
      images: false,
      pdf: false,
    });
    expect(off.models.find((m) => m.id === models.vision.id)?.input).toEqual({
      images: true,
      pdf: false,
    });
    expect(off.routes).toEqual([
      {
        name: 'look',
        model: models.ok.id,
        modelName: models.ok.displayName,
        input: { images: true, pdf: false },
      },
    ]);
    expect(off.models.find((m) => m.id === models.ok.id)?.displayName).toBe(models.ok.displayName);
    // CH-2, RT-11: a member can see how the workspace picks a model, to be told it in chat.
    expect(off.routing).toEqual({
      enabled: false,
      defaultModel: { id: models.ok.id, name: models.ok.displayName },
      pinnedModel: null,
    });
    // Routing is off, so auto means the default, which reads no images.
    expect(off.auto).toEqual({ images: false, pdf: false });

    const settings = (routingEnabled: boolean, pinnedModel: string | null) =>
      as(t, root).put(`/api/workspaces/${alpha.id}/routing/settings`, {
        routingEnabled,
        defaultModel: models.ok.id,
        pinnedModel,
      });
    await settings(true, null);
    expect((await requestable(member)).view.auto).toEqual({ images: true, pdf: false });
    await settings(true, models.ok.id);
    const pinned = (await requestable(member)).view;
    expect(pinned.auto).toEqual({ images: false, pdf: false });
    expect(pinned.routing).toMatchObject({ enabled: true, pinnedModel: { id: models.ok.id } });
    await settings(false, null);

    // Another workspace's choices do not exist for a non-member (AC 16).
    expect((await requestable(member, bravo)).status).toBe(404);
  });
});
