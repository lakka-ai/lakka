import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyMcpFailure } from '../src/mcp/client.ts';
import type { McpTarget } from '../src/mcp/client.ts';
import { ToolTimeoutError } from '../src/tools/executor.ts';
import type { ToolExecution } from '../src/tools/executor.ts';
import { commandExecutor } from '../src/tools/remote.ts';
import { runnerListRequestFor, runnerRequestFor, runToolRequest } from '../src/tools/runner.ts';

/*
 * The out-of-process executor and its runner (TL-8, ADR 0073), with the runner as a separate Node
 * process and the dependency-free stdio MCP server as the tool. No network and no database: the
 * container that locks the runner down is proven in CI (pnpm test:out-of-process).
 */

const node = process.execPath;
const runner = fileURLToPath(new URL('./fixtures/tool-runner.ts', import.meta.url));
const stdioServer = fileURLToPath(
  new URL('../../../test/integration/mcp-plain-stdio.ts', import.meta.url),
);

const target: McpTarget = {
  transport: 'stdio',
  url: null,
  command: node,
  args: [stdioServer],
  credentialEnv: null,
  allowPrivate: false,
  allowedOrigins: [],
  privateOrigins: [],
};

const call = (toolName: string, args: Record<string, unknown> = {}, extra = {}): ToolExecution => ({
  target,
  secret: null,
  toolName,
  arguments: args,
  timeoutMs: 10_000,
  ...extra,
});

const live = () => new AbortController().signal;

/** A call to an HTTP server through a real runner, with the allowlist given. */
const httpCall = (allowedOrigins: string[]) =>
  commandExecutor([node, runner])
    .execute(
      call(
        'echo',
        {},
        {
          target: {
            ...target,
            transport: 'streamable_http',
            url: 'https://mcp.example.test/mcp',
            command: null,
            args: [],
            allowedOrigins,
          },
        },
      ),
      live(),
    )
    .catch((e: unknown) => e);

/** A runner that answers with a fixed script instead of running anything. */
const fake = (script: string) => commandExecutor([node, '-e', script]);

describe('running a tool in another process (TL-8)', () => {
  it('TL-8: the runner runs the call and sends back the tool result', async () => {
    const result = await commandExecutor([node, runner]).execute(
      call('echo', { text: 'hi' }),
      live(),
    );
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('TL-8: the credential reaches the tool through the request, not the command line', async () => {
    const command = [node, runner] as const;
    const secret = 'runner-secret-0123456789';
    const result = await commandExecutor(command).execute(
      call(
        'credential',
        {},
        {
          secret,
          target: { ...target, credentialEnv: 'FIXTURE_TOKEN' },
        },
      ),
      live(),
    );
    expect(result.content).toEqual([{ type: 'text', text: `set, ${secret.length} characters` }]);
    expect(command.join(' ')).not.toContain(secret);
  });

  it('H6: a tool past its deadline in the runner is a timeout', async () => {
    await expect(
      commandExecutor([node, runner]).execute(
        call('sleep', { ms: 5000 }, { timeoutMs: 300 }),
        live(),
      ),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it('a runner that never answers is stopped at the deadline, or when the request ends', async () => {
    const hang = 'setInterval(() => {}, 1000)';
    const controller = new AbortController();
    const pending = fake(hang).execute(call('echo'), controller.signal);
    controller.abort(new Error('client went away'));
    await expect(pending).rejects.toThrow('client went away');
  });

  it("a runner's failure comes back as its class only, and anything else as an error", async () => {
    const replyWith = (reply: unknown) =>
      fake(`process.stdout.write(${JSON.stringify(`${JSON.stringify(reply)}\n`)})`).execute(
        call('echo'),
        live(),
      );
    const unreachable = await replyWith({ ok: false, failure: 'unreachable' }).catch((e) => e);
    expect(classifyMcpFailure(unreachable)).toBe('unreachable');
    await expect(replyWith({ ok: false, failure: 'timeout' })).rejects.toBeInstanceOf(
      ToolTimeoutError,
    );
    for (const reply of [{ ok: true, result: { content: 'not a list' } }, { hello: 'x' }]) {
      const failure = await replyWith(reply).catch((e) => e);
      expect(classifyMcpFailure(failure)).toBe('error');
    }
    const garbage = await fake("process.stdout.write('not json')")
      .execute(call('echo'), live())
      .catch((e) => e);
    expect(classifyMcpFailure(garbage)).toBe('error');
    const crash = await fake('process.exit(3)')
      .execute(call('echo'), live())
      .catch((e) => e);
    expect(classifyMcpFailure(crash)).toBe('error');
  });

  it('NF-S4: the runner keeps to the allowlist the request carries', async () => {
    // Refused before any connection is tried, so no network is needed to tell.
    expect(classifyMcpFailure(await httpCall([]))).toBe('not_allowed');
    expect(classifyMcpFailure(await httpCall(['https://other.example.test']))).toBe('not_allowed');
  });

  it("NF-S4: a runner's not_allowed comes back as its class", async () => {
    const reply = `${JSON.stringify({ ok: false, failure: 'not_allowed' })}\n`;
    const failure = await fake(`process.stdout.write(${JSON.stringify(reply)})`)
      .execute(call('echo'), live())
      .catch((e: unknown) => e);
    expect(classifyMcpFailure(failure)).toBe('not_allowed');
  });

  it('NF-S4: the runner refuses an older request, which it would read differently', async () => {
    const current = JSON.parse(runnerRequestFor(call('echo'))) as {
      version: number;
      op: string;
      egressProxy: unknown;
      execution: { target: Record<string, unknown> };
    };
    expect(current.version).toBe(3);
    const { op, egressProxy, ...v2 } = current;
    void op;
    void egressProxy;
    const { allowedOrigins, privateOrigins, ...v1Target } = current.execution.target;
    void allowedOrigins;
    void privateOrigins;
    for (const old of [
      { ...v2, version: 2 },
      { ...current, version: 2 },
      { version: 1, execution: { ...current.execution, target: v1Target } },
    ]) {
      expect(JSON.parse(await runToolRequest(JSON.stringify(old), live()))).toEqual({
        ok: false,
        failure: 'invalid_request',
      });
    }
    // The same request as version 3 runs.
    expect(JSON.parse(await runToolRequest(JSON.stringify(current), live()))).toMatchObject({
      ok: true,
    });
  });

  it("TL-8: the runner lists a server's tools, as testing and syncing need", async () => {
    const tools = await commandExecutor([node, runner]).list(
      { target, secret: null, timeoutMs: 10_000 },
      live(),
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      'echo',
      'delete',
      'sandbox',
      'sleep',
      'credential',
      'environment',
    ]);
    expect(tools[0]).toMatchObject({ annotations: { readOnlyHint: true } });
  });

  it("TL-8: a listing's failure comes back as its class, and a call's reply is not a listing", async () => {
    const reply = `${JSON.stringify({ ok: false, failure: 'unreachable' })}\n`;
    const failure = await fake(`process.stdout.write(${JSON.stringify(reply)})`)
      .list({ target, secret: null, timeoutMs: 10_000 }, live())
      .catch((e: unknown) => e);
    expect(classifyMcpFailure(failure)).toBe('unreachable');
    const result = `${JSON.stringify({ ok: true, result: { content: [] } })}\n`;
    const mixed = await fake(`process.stdout.write(${JSON.stringify(result)})`)
      .list({ target, secret: null, timeoutMs: 10_000 }, live())
      .catch((e: unknown) => e);
    expect(classifyMcpFailure(mixed)).toBe('error');
    const listing = runnerListRequestFor({ target, secret: null, timeoutMs: 10_000 });
    expect(JSON.parse(listing)).toMatchObject({ version: 3, op: 'list', egressProxy: null });
  });

  it('NF-S4: the runner gives a stdio server the egress proxy, and nothing of its own', async () => {
    const proxy = 'http://t:token-value@egress:3128';
    const reply = JSON.parse(
      await runToolRequest(runnerRequestFor(call('environment'), proxy), live()),
    ) as { ok: true; result: { content: { text: string }[] } };
    const seen = JSON.parse(reply.result.content[0]?.text ?? '{}') as {
      names: string[];
      httpsProxy: string | null;
      nodeUseEnvProxy: string | null;
    };
    expect(seen.httpsProxy).toBe(proxy);
    expect(seen.nodeUseEnvProxy).toBe('1');
    expect(seen.names).toEqual(expect.arrayContaining(['HTTP_PROXY', 'http_proxy', 'https_proxy']));
    // Nothing from this process beyond what the client passes on to any server.
    const allowed = new Set([
      'HOME',
      'LOGNAME',
      'PATH',
      'SHELL',
      'TERM',
      'USER',
      'TMPDIR',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'https_proxy',
      'http_proxy',
      'NODE_USE_ENV_PROXY',
    ]);
    // macOS gives every process __CF_USER_TEXT_ENCODING itself.
    expect(seen.names.filter((name) => !allowed.has(name) && !name.startsWith('__CF_'))).toEqual(
      [],
    );
    // Without a proxy, a server is told of none.
    const plain = JSON.parse(
      await runToolRequest(runnerRequestFor(call('environment')), live()),
    ) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(plain.result.content[0]?.text ?? '{}')).toMatchObject({
      httpsProxy: null,
      nodeUseEnvProxy: null,
    });
  });

  it('the runner answers a request it cannot read with a failure, not an exception', async () => {
    for (const input of ['not json', '{}', JSON.stringify({ version: 1, execution: {} })]) {
      expect(JSON.parse(await runToolRequest(input, live()))).toEqual({
        ok: false,
        failure: 'invalid_request',
      });
    }
  });
});
