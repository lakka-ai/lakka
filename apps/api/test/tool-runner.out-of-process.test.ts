import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ConversationView,
  McpServerView,
  McpToolSyncView,
  ModelView,
  WorkspaceView,
} from '@lakka/contracts';
import { classifyMcpFailure, commandExecutor, ToolTimeoutError } from '@lakka/core';
import type { McpTarget } from '@lakka/core';
import { listToolInvocationsForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The out-of-process proof (TL-8, M6 exit, ADR 0073). A tool call from chat goes through the
 * same dispatch seam as always, but the executor starts `lakka tool-runner` from the app image
 * in a locked-down container for each call: no network, a read-only root, every capability
 * dropped, no privilege gain, and CPU, memory and process limits. The tool is a stdio MCP server,
 * the only kind a runner with no network can reach, and it reports where it ran.
 */

const IMAGE = process.env['LAKKA_RUNNER_IMAGE'];
if (IMAGE === undefined || IMAGE === '') {
  throw new Error('Set LAKKA_RUNNER_IMAGE to the app image, e.g. lakka/app:ci.');
}

// Mounted at the same path in the container, so the command the api stores works in there: the
// sync, like each call, runs in a runner container (TL-8).
const FIXTURES = fileURLToPath(new URL('../../../test/integration', import.meta.url));
const STDIO_SERVER = `${FIXTURES}/mcp-plain-stdio.ts`;
const LABEL = `lakka.test=tool-runner-${randomBytes(3).toString('hex')}`;
const MEMORY_BYTES = 256 * 1024 * 1024;

const RUNNER: [string, ...string[]] = [
  'docker',
  'run',
  '--rm',
  '--interactive',
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '64',
  '--memory',
  String(MEMORY_BYTES),
  '--cpus',
  '1',
  '--user',
  'node',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=16m',
  '--label',
  LABEL,
  '--volume',
  `${FIXTURES}:${FIXTURES}:ro`,
  IMAGE,
  'tool-runner',
];

const TARGET: McpTarget = {
  transport: 'stdio',
  url: null,
  command: 'node',
  args: [STDIO_SERVER],
  credentialEnv: null,
  allowPrivate: false,
  allowedOrigins: [],
  privateOrigins: [],
};

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let member: SignedInUser;
let alpha: WorkspaceView;
let server: McpServerView;

const suffix = () => randomBytes(3).toString('hex');
const ws = () => `/api/workspaces/${alpha.id}`;

function runningRunners(): string[] {
  return execFileSync('docker', ['ps', '--quiet', '--filter', `label=${LABEL}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((id) => id !== '');
}

async function noRunnersLeft(): Promise<void> {
  for (let i = 0; i < 40 && runningRunners().length > 0; i += 1) await sleep(250);
  expect(runningRunners()).toEqual([]);
}

beforeAll(async () => {
  t = await createTestApp({ toolExecutor: commandExecutor(RUNNER) });
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, member] = await Promise.all([signedInUser(t, 'Root'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = (
    (
      await as(t, root).post('/api/workspaces', { name: 'Alpha', slug: `alpha-${suffix()}` })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  await as(t, root).put(`${ws()}/members/${member.principal.id}`, { role: 'member' });
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  // Only instance admins add stdio servers (ADR 0066 Q2).
  const added = await as(t, root).post(`${ws()}/mcp-servers`, {
    transport: 'stdio',
    name: `local${suffix()}`,
    command: 'node',
    args: [STDIO_SERVER],
    authMode: 'none',
  });
  if (added.statusCode !== 201) throw new Error(added.body);
  server = (added.json() as { server: McpServerView }).server;
  const synced = await as(t, root).post(`${ws()}/mcp-servers/${server.id}/tools/sync`, {});
  if (synced.statusCode !== 200) throw new Error(synced.body);
  for (const tool of (synced.json() as McpToolSyncView).tools) {
    await as(t, root).patch(`${ws()}/tools/${tool.id}`, { enabled: true });
  }
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('a tool out of process (TL-8)', () => {
  it('TL-8: a tool call from chat runs in a container with no network, a read-only root and limits', async () => {
    const created = await as(t, root).post('/api/models/custom', {
      provider: 'fake',
      model: `tool-sandbox~${suffix()}`,
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      capabilities: {
        vision: false,
        pdf: false,
        tools: true,
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
    const model = (created.json() as { model: ModelView }).model;
    const conversation = await as(t, member).post(`${ws()}/conversations`, {});
    const conversationId = (conversation.json() as { conversation: { id: string } }).conversation
      .id;

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: member.cookie,
        origin: PUBLIC_URL,
        'x-lakka-workspace': alpha.id,
        'x-lakka-conversation': conversationId,
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Where do tools run?' }],
      }),
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-lakka-request-id') ?? '';
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toContain(`${server.name}__sandbox`);

    // Through the seam, audited as any call is.
    expect(await listToolInvocationsForRequest(t.db, alpha.id, requestId)).toMatchObject([
      { status: 'ok', toolName: `${server.name}__sandbox` },
    ]);

    // Where it ran, as the tool itself saw it.
    const view = await as(t, member).get(`${ws()}/conversations/${conversationId}`);
    const result = (view.json() as { conversation: ConversationView }).conversation.messages.find(
      (m) => m.role === 'tool',
    );
    const report = JSON.parse(result?.content ?? '{}') as Record<string, unknown>;
    expect(report).toEqual({
      interfaces: ['lo'],
      rootWritable: false,
      uid: 1000,
      memoryMax: String(MEMORY_BYTES),
      pidsMax: '64',
      cpuMax: '100000 100000',
    });
    await noRunnersLeft();
  });

  it('H6: a tool past its deadline is a timeout, and its container stops', async () => {
    await expect(
      commandExecutor(RUNNER).execute(
        {
          target: TARGET,
          secret: null,
          toolName: 'sleep',
          arguments: { ms: 60_000 },
          timeoutMs: 2000,
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
    await noRunnersLeft();
  });

  it('NF-S4: the runner in its container keeps to the allowlist the request carries', async () => {
    // No network in there, so a call that reached for one would be unreachable, not refused.
    const failure = await commandExecutor(RUNNER)
      .execute(
        {
          target: {
            ...TARGET,
            transport: 'streamable_http',
            url: 'https://mcp.example.test/mcp',
            command: null,
            args: [],
            allowedOrigins: ['https://other.example.test'],
          },
          secret: null,
          toolName: 'echo',
          arguments: {},
          timeoutMs: 10_000,
        },
        new AbortController().signal,
      )
      .catch((e: unknown) => e);
    expect(classifyMcpFailure(failure)).toBe('not_allowed');
    await noRunnersLeft();
  });

  it('a request that ends stops its runner container', async () => {
    const controller = new AbortController();
    const pending = commandExecutor(RUNNER).execute(
      {
        target: TARGET,
        secret: null,
        toolName: 'sleep',
        arguments: { ms: 60_000 },
        timeoutMs: 30_000,
      },
      controller.signal,
    );
    // Long enough for the container to start and the call to be under way.
    for (let i = 0; i < 40 && runningRunners().length === 0; i += 1) await sleep(250);
    expect(runningRunners()).toHaveLength(1);
    controller.abort(new Error('client went away'));
    await expect(pending).rejects.toThrow('client went away');
    await noRunnersLeft();
  });
});
