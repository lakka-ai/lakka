import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IssuedKey, ModelView, WorkspaceBudgetsView, WorkspaceView } from '@lakka/contracts';
import { createLocalUser } from '@lakka/core';
import { listSpansForRequest, schema } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signIn, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Exporting and deleting everything linked to a person (NF-P4, ADR 0082), against real Postgres
 * and Valkey. The person has a conversation with a file, a key, requests through both, recorded
 * content, tool calls, an MCP account and a cap; a colleague in the same workspace has the same
 * kinds of thing, and none of theirs may appear in the export or go with the deletion.
 */

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let admin: SignedInUser;
let person: SignedInUser;
let colleague: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let model: ModelView;
let personKey: IssuedKey;
let mcpServerId: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const canary = `person-${randomBytes(6).toString('hex')}`;
const theirs = `colleague-${randomBytes(6).toString('hex')}`;
const made = { conversation: '', colleagueConversation: '', viaChat: '', viaKey: '' };

const suffix = () => randomBytes(3).toString('hex');

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', { name, slug: `${name}-${suffix()}` });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function member(ws: WorkspaceView, user: SignedInUser, role: 'admin' | 'member') {
  const res = await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role,
  });
  if (res.statusCode !== 200) throw new Error(`membership: ${res.statusCode}`);
}

/** A chat request, in a conversation or through a key, and its request id once traced. */
async function chat(
  auth: { cookie: string } | { key: string },
  content: unknown,
  conversationId?: string,
): Promise<string> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lakka-workspace': alpha.id,
      ...(conversationId === undefined ? {} : { 'x-lakka-conversation': conversationId }),
      ...('key' in auth
        ? { authorization: `Bearer ${auth.key}` }
        : { cookie: auth.cookie, origin: PUBLIC_URL }),
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: 100,
      messages: [{ role: 'user', content }],
    }),
  });
  if (res.status !== 200) throw new Error(`chat: ${res.status} ${await res.text()}`);
  await res.text();
  const requestId = res.headers.get('x-lakka-request-id') ?? '';
  for (let i = 0; i < 40; i += 1) {
    await t.tracing.forceFlush();
    if ((await listSpansForRequest(t.db, alpha.id, requestId)).some((s) => s.name === 'request'))
      return requestId;
    await sleep(50);
  }
  throw new Error('never traced');
}

async function startConversation(user: SignedInUser): Promise<string> {
  const res = await as(t, user).post(`/api/workspaces/${alpha.id}/conversations`, {});
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

async function toolCall(user: SignedInUser, requestId: string, secret: string) {
  await t.db.insert(schema.toolInvocations).values({
    requestId,
    workspaceId: alpha.id,
    principalId: user.principal.id,
    actingUserId: user.principal.id,
    callId: `call-${suffix()}`,
    toolName: 'files__search',
    mcpServerId,
    arguments: { query: secret },
    status: 'ok',
    durationMs: 12,
  });
}

function deletePerson(by: SignedInUser, principalId: string, confirmEmail: string) {
  return t.app.inject({
    method: 'DELETE',
    url: `/api/users/${principalId}`,
    headers: { cookie: by.cookie, origin: PUBLIC_URL },
    payload: { confirmEmail },
  });
}

async function memberSpend(): Promise<string | undefined> {
  const res = await as(t, root).get(`/api/workspaces/${alpha.id}/budgets`);
  return (res.json() as WorkspaceBudgetsView).members.find(
    (b) => b.principalId === person.principal.id,
  )?.spentMicroUsd;
}

/** Every file in the export, by its path inside `lakka-export/`. */
async function exported(by: SignedInUser, principalId: string): Promise<Map<string, Buffer>> {
  const res = await fetch(`${base}/api/users/${principalId}/export`, {
    headers: { cookie: by.cookie, origin: PUBLIC_URL },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/gzip');
  expect(res.headers.get('content-disposition')).toMatch(
    new RegExp(
      `^attachment; filename="lakka-export-\\d{4}-\\d{2}-\\d{2}-${principalId}\\.tar\\.gz"$`,
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), 'lakka-export-'));
  try {
    const archive = join(dir, 'export.tar.gz');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // The system tar reads it: the archive is a standard one, not only one our reader accepts.
    execFileSync('tar', ['-xzf', archive, '-C', dir]);
    const files = new Map<string, Buffer>();
    const walk = (at: string, rel: string) => {
      for (const name of readdirSync(at)) {
        const path = join(at, name);
        const inner = rel === '' ? name : `${rel}/${name}`;
        if (statSync(path).isDirectory()) walk(path, inner);
        else files.set(inner, readFileSync(path));
      }
    };
    walk(join(dir, 'lakka-export'), '');
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const everything = (files: Map<string, Buffer>) =>
  [...files.values()].map((b) => b.toString('latin1')).join('\n');

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, admin, person, colleague] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Person'),
    signedInUser(t, 'Colleague'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('alpha');
  bravo = await workspace('bravo');
  await member(alpha, admin, 'admin');
  await member(alpha, person, 'member');
  await member(alpha, colleague, 'member');
  // The person administers bravo, alongside root, so deleting them leaves it an admin.
  await member(bravo, person, 'admin');
  await member(bravo, root, 'admin');

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
  await as(t, root).put(`/api/workspaces/${alpha.id}/budgets/members/${person.principal.id}`, {
    limitMicroUsd: '10000000',
    period: 'monthly',
  });
  await as(t, admin).put(`/api/workspaces/${alpha.id}/content-capture`, {
    enabled: true,
    retentionDays: 7,
  });
  personKey = (
    await as(t, person).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Laptop script' })
  ).json() as IssuedKey;

  made.conversation = await startConversation(person);
  made.viaChat = await chat(
    person,
    [
      { type: 'text', text: `Remember ${canary}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
    ],
    made.conversation,
  );
  made.viaKey = await chat({ key: personKey.secret }, `Also ${canary}`);
  made.colleagueConversation = await startConversation(colleague);
  await chat(colleague, `Mine is ${theirs}`, made.colleagueConversation);

  const [server] = await t.db
    .insert(schema.mcpServers)
    .values({
      workspaceId: alpha.id,
      name: `files-${suffix()}`,
      transport: 'streamable_http',
      url: 'https://mcp.example.com/mcp',
      authMode: 'oauth',
      createdByPrincipalId: admin.principal.id,
    })
    .returning({ id: schema.mcpServers.id });
  // Set below by an insert that must succeed; the server row is what it returns.
  mcpServerId = server?.id ?? '';
  await t.db.insert(schema.mcpCredentials).values([
    { mcpServerId, principalId: person.principal.id, kind: 'user', secret: `mcp-${canary}` },
    { mcpServerId, principalId: colleague.principal.id, kind: 'user', secret: `mcp-${theirs}` },
  ]);
  await toolCall(person, made.viaChat, `args-${canary}`);
  await toolCall(colleague, made.viaChat, `args-${theirs}`);
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('exporting a person (NF-P4)', () => {
  it('NF-P4: only an instance admin may export, and only a person who exists', async () => {
    const url = `/api/users/${person.principal.id}/export`;
    expect((await as(t, admin).get(url)).statusCode).toBe(403);
    expect((await as(t, person).get(url)).statusCode).toBe(403);
    expect((await as(t, root).get(`/api/users/${personKey.key.id}/export`)).statusCode).toBe(404);
    const keyPrincipal = await t.pool.query<{ id: string }>(
      'select id from principals where owner_principal_id = $1',
      [person.principal.id],
    );
    expect(
      (await as(t, root).get(`/api/users/${keyPrincipal.rows[0]?.id}/export`)).statusCode,
    ).toBe(404);
  });

  it('NF-P4: the archive holds everything linked to the person, and nothing of anyone else', async () => {
    const files = await exported(root, person.principal.id);
    const dir = `workspaces/${alpha.slug}`;

    expect(JSON.parse(files.get('manifest.json')?.toString() ?? '{}')).toMatchObject({
      format: 'lakka.person-export',
      version: 1,
      principalId: person.principal.id,
      exportedByPrincipalId: root.principal.id,
    });
    const profile = JSON.parse(files.get('person.json')?.toString() ?? '{}') as {
      email: string;
      memberships: { workspace: { slug: string }; role: string }[];
      keys: { name: string; prefix: string }[];
      budgets: { limitMicroUsd: string }[];
      mcpConnections: { mcpServerId: string }[];
    };
    expect(profile.email).toBe(person.email);
    expect(profile.memberships.map((m) => [m.workspace.slug, m.role]).toSorted()).toEqual(
      [
        [alpha.slug, 'member'],
        [bravo.slug, 'admin'],
      ].toSorted(),
    );
    expect(profile.keys).toMatchObject([{ name: 'Laptop script', prefix: personKey.key.prefix }]);
    expect(profile.budgets).toMatchObject([{ limitMicroUsd: '10000000' }]);
    expect(profile.mcpConnections).toMatchObject([{ mcpServerId }]);

    const conversation = JSON.parse(
      files.get(`${dir}/conversations/${made.conversation}.json`)?.toString() ?? '{}',
    ) as { messages: { content: string; attachments: { file: string }[] }[] };
    expect(conversation.messages.map((m) => m.content)).toEqual([
      `Remember ${canary}`,
      'Hello there',
    ]);
    const file = conversation.messages[0]?.attachments[0]?.file ?? '';
    expect(files.get(file)?.equals(PNG)).toBe(true);

    const usage = files.get(`${dir}/usage/part-0001.jsonl`)?.toString().trim().split('\n') ?? [];
    expect(usage.map((l) => (JSON.parse(l) as { requestId: string }).requestId).toSorted()).toEqual(
      [made.viaChat, made.viaKey].toSorted(),
    );
    expect(files.get(`${dir}/tool-invocations/part-0001.jsonl`)?.toString()).toContain(
      `args-${canary}`,
    );
    const captured = files.get(`${dir}/captured-content/part-0001.jsonl`)?.toString() ?? '';
    expect(captured).toContain(`Remember ${canary}`);
    expect(captured).toContain(`Also ${canary}`);
    const requests = (files.get(`${dir}/requests/part-0001.jsonl`)?.toString() ?? '')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { request: { requestId: string }; spans: { name: string }[] });
    expect(requests.map((r) => r.request.requestId).toSorted()).toEqual(
      [made.viaChat, made.viaKey].toSorted(),
    );
    expect(requests[0]?.spans.some((s) => s.name === 'gateway.dispatch')).toBe(true);

    const all = everything(files);
    // Nobody else's data, and no secret of anyone's.
    expect(all).not.toContain(theirs);
    expect(all).not.toContain(made.colleagueConversation);
    expect(all).not.toContain(personKey.secret);
    expect(all).not.toContain(`mcp-${canary}`);
    expect(all).not.toMatch(/"hash"/);
    expect(all).not.toContain(person.password);
  });
});

describe('deleting a person (NF-P4)', () => {
  it('NF-P4: only an instance admin may delete, never themselves, and only with the email', async () => {
    expect((await deletePerson(admin, person.principal.id, person.email)).statusCode).toBe(403);
    const self = await deletePerson(root, root.principal.id, root.email);
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ error: { code: 'cannot_delete_self' } });
    const wrong = await deletePerson(root, person.principal.id, colleague.email);
    expect(wrong.statusCode).toBe(400);
    expect((await deletePerson(root, personKey.key.id, person.email)).statusCode).toBe(404);
  });

  it('NF-P4: the only admin of a workspace is not deleted, and nothing of theirs changes', async () => {
    const solo = await signedInUser(t, 'Solo');
    const ws = await workspace('solo');
    await member(ws, solo, 'admin');
    // Its creator was its first admin; leave the solo person the only one.
    expect(
      (await as(t, root).delete(`/api/workspaces/${ws.id}/members/${root.principal.id}`))
        .statusCode,
    ).toBe(204);
    const res = await deletePerson(root, solo.principal.id, solo.email);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'last_workspace_admin' } });
    expect((await as(t, solo).get('/api/me')).statusCode).toBe(200);
  });

  it('NF-P4: deletes what is theirs, keeps what records spend, and ends their access', async () => {
    const spentBefore = await memberSpend();
    expect(BigInt(spentBefore ?? '0')).toBeGreaterThan(0n);
    const usageBefore = await t.pool.query(
      'select count(*)::int as n from usage where acting_user_id = $1',
      [person.principal.id],
    );

    const res = await deletePerson(root, person.principal.id, ` ${person.email.toUpperCase()} `);
    expect(res.statusCode).toBe(204);

    // Sign-in, sessions and keys stop at once.
    expect((await as(t, person).get('/api/me')).statusCode).toBe(401);
    expect(await signIn(t, person.email, person.password)).toBeUndefined();
    const byKey = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${personKey.secret}` },
    });
    expect(byKey.status).toBe(401);

    // A tombstone with no name or email, and no Better Auth user behind it.
    const tombstone = await t.pool.query(
      'select status, display_name, email, auth_subject, deleted_by_principal_id from principals where id = $1',
      [person.principal.id],
    );
    expect(tombstone.rows).toEqual([
      {
        status: 'deleted',
        display_name: 'Deleted person',
        email: null,
        auth_subject: null,
        deleted_by_principal_id: root.principal.id,
      },
    ]);
    const signIns = await t.pool.query(
      'select count(*)::int as n from auth_users where lower(email) = lower($1)',
      [person.email],
    );
    expect(signIns.rows[0]).toEqual({ n: 0 });
    const keys = await t.pool.query(
      `select p.status, p.display_name, k.revoked_at is not null as revoked
       from principals p join api_keys k on k.principal_id = p.id where p.owner_principal_id = $1`,
      [person.principal.id],
    );
    expect(keys.rows).toEqual([{ status: 'deleted', display_name: 'Deleted key', revoked: true }]);
    expect(
      (
        await t.pool.query('select count(*)::int as n from memberships where principal_id = $1', [
          person.principal.id,
        ])
      ).rows[0],
    ).toEqual({ n: 0 });

    // What they said is gone; the colleague's is not.
    const conversations = await t.pool.query<{ id: string }>(
      'select id from conversations where workspace_id = $1 order by id',
      [alpha.id],
    );
    expect(conversations.rows.map((r) => r.id)).toEqual([made.colleagueConversation]);
    const orphans = await t.pool.query(
      `select (select count(*)::int from messages where conversation_id = $1) as messages,
              (select count(*)::int from attachments a join messages m on m.id = a.message_id
                where m.conversation_id = $1) as files`,
      [made.conversation],
    );
    expect(orphans.rows[0]).toEqual({ messages: 0, files: 0 });
    const content = await t.pool.query<{ request_id: string }>(
      'select request_id from span_content where workspace_id = $1',
      [alpha.id],
    );
    expect(content.rows.map((r) => r.request_id)).not.toContain(made.viaChat);
    expect(content.rows.map((r) => r.request_id)).not.toContain(made.viaKey);
    expect(content.rows.length).toBeGreaterThan(0);

    // The tool audit keeps the call, without its arguments; the colleague's keeps theirs.
    const calls = await t.pool.query<{ acting_user_id: string; arguments: unknown }>(
      'select acting_user_id, arguments from tool_invocations where workspace_id = $1',
      [alpha.id],
    );
    expect(calls.rows).toContainEqual({ acting_user_id: person.principal.id, arguments: null });
    expect(calls.rows).toContainEqual({
      acting_user_id: colleague.principal.id,
      arguments: { query: `args-${theirs}` },
    });
    const credentials = await t.pool.query<{ principal_id: string }>(
      'select principal_id from mcp_credentials where mcp_server_id = $1',
      [mcpServerId],
    );
    expect(credentials.rows.map((r) => r.principal_id)).toEqual([colleague.principal.id]);

    // BG-4, invariant 5: spend stays recorded, so deleting someone lifts no cap.
    const usageAfter = await t.pool.query(
      'select count(*)::int as n from usage where acting_user_id = $1',
      [person.principal.id],
    );
    expect(usageAfter.rows).toEqual(usageBefore.rows);
    expect(await memberSpend()).toBe(spentBefore);
    const budgets = (
      await as(t, root).get(`/api/workspaces/${alpha.id}/budgets`)
    ).json() as WorkspaceBudgetsView;
    expect(budgets.members.find((b) => b.principalId === person.principal.id)?.name).toBe(
      'Deleted person',
    );

    // Gone from the people list, and nothing more to do to them.
    const users = (await as(t, root).get('/api/users')).json() as { users: { id: string }[] };
    expect(users.users.map((u) => u.id)).not.toContain(person.principal.id);
    expect((await as(t, root).get(`/api/users/${person.principal.id}/export`)).statusCode).toBe(
      404,
    );
    expect((await deletePerson(root, person.principal.id, person.email)).statusCode).toBe(404);
    expect(
      (await as(t, root).post(`/api/users/${person.principal.id}/reactivate`, {})).statusCode,
    ).toBe(404);
  });

  it('NF-S5: the log records the export and the deletion by id, with no content or email', () => {
    const lines = t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'principal.exported',
        principal_id: person.principal.id,
        actor_id: root.principal.id,
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'principal.deleted',
        principal_id: person.principal.id,
        actor_id: root.principal.id,
        count: 1,
      }),
    );
    const text = t.logs.join('');
    expect(text).not.toContain(canary);
    expect(text).not.toContain(person.email);
  });

  it('NF-P4: the same address can join again later, as someone new', async () => {
    const again = await createLocalUser(
      { auth: t.auth, db: t.db },
      { email: person.email, password: person.password, name: 'Person again' },
    );
    expect(again.id).not.toBe(person.principal.id);
    expect(await signIn(t, person.email, person.password)).toBeDefined();
  });
});
