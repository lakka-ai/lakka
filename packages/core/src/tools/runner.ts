import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpToolView } from '@lakka/contracts';
import { classifyMcpFailure, McpFailureError } from '../mcp/client.ts';
import { MAX_ALLOWED_ORIGINS } from '../net/egress-policy.ts';
import { inProcessExecutorWith, TOOL_TIMEOUT_MS, ToolTimeoutError } from './executor.ts';
import type { ToolExecution, ToolListing } from './executor.ts';

/*
 * The wire between a tool executor and a tool runner in another process (TL-8, ADR 0073). The
 * executor writes one request, as JSON on one line, to the runner's stdin; the runner runs it
 * with the in-process executor and writes one reply to stdout: the tool's result or the server's
 * tools, or only the class of failure, never the error itself, which could carry anything a
 * server said. The executor keeps stdin open while it waits, and the runner stops when stdin
 * ends: that reaches a runner in a container when its client is killed, where a signal may not.
 * The credential travels in the request, never in the runner's command line or environment,
 * where process listings and container inspection would show it.
 *
 * Version 2 carried the origins a call may reach (NF-S4, ADR 0117). Version 3 lists tools as
 * well as calling them (`op`), and carries the egress proxy a stdio server must use, its token
 * included, which the sandbox's runner hands to the server (ADR 0118). The api and the runner
 * ship in one image, so a runner refuses any other version rather than run an operation it would
 * read differently.
 */

/** Large enough for any result or tool list: the seam cuts results to 16 KB after this (H6). */
export const MAX_RUNNER_REPLY_BYTES = 4 * 1024 * 1024;

export const RUNNER_PROTOCOL_VERSION = 3;

/** Longer than any request can be, a full allowlist included; a runner stops reading here. */
export const MAX_RUNNER_REQUEST_BYTES = 1024 * 1024;

/** More tools than any real server offers, as the client cuts them off (mcp/client.ts). */
const MAX_TOOLS = 1000;

/** An origin as normaliseOrigin writes it. */
const origin = z
  .string()
  .max(300)
  .regex(/^https?:\/\/[^/]+$/);

const mcpTarget = z.object({
  transport: z.enum(['stdio', 'streamable_http']),
  url: z.string().max(2000).nullable(),
  command: z.string().max(500).nullable(),
  args: z.array(z.string().max(1000)).max(50),
  credentialEnv: z.string().max(64).nullable(),
  allowPrivate: z.boolean(),
  allowedOrigins: z.array(origin).max(MAX_ALLOWED_ORIGINS),
  privateOrigins: z.array(origin).max(MAX_ALLOWED_ORIGINS),
});

/**
 * The proxy URL with its token as the password. An environment variable holds at most 128 KB
 * on Linux, and the token is compressed, so this leaves room for any allowlist.
 */
const egressProxy = z
  .string()
  .max(100_000)
  .regex(/^http:\/\/[^\s/]+$/)
  .nullable();

const secret = z.string().max(8192).nullable();
const timeoutMs = z.int().positive().max(TOOL_TIMEOUT_MS);

export const runnerRequest = z.discriminatedUnion('op', [
  z.object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    op: z.literal('call'),
    egressProxy,
    execution: z.object({
      target: mcpTarget,
      secret,
      toolName: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.unknown()),
      timeoutMs,
    }),
  }),
  z.object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    op: z.literal('list'),
    egressProxy,
    listing: z.object({ target: mcpTarget, secret, timeoutMs }),
  }),
]);
export type RunnerRequest = z.infer<typeof runnerRequest>;

/** What a result must look like to be passed on; its content is shaped by the seam later. */
const callToolResult = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

const hint = z.boolean().nullable();

/** A tool as the runner's client already shaped it (mcp/client.ts toolView). */
const toolView = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.object({
    readOnlyHint: hint,
    destructiveHint: hint,
    idempotentHint: hint,
    openWorldHint: hint,
  }),
});

export const runnerFailure = z.enum([
  'timeout',
  'auth_failed',
  'unreachable',
  'not_allowed',
  'error',
  'invalid_request',
]);

export const runnerReply = z.union([
  z.object({ ok: z.literal(true), result: callToolResult }),
  z.object({ ok: z.literal(true), tools: z.array(toolView).max(MAX_TOOLS) }),
  z.object({ ok: z.literal(false), failure: runnerFailure }),
]);
export type RunnerReply = z.infer<typeof runnerReply>;

/** A call as a request line. `egressProxy` is for a runner in the sandbox (NF-S4). */
export function runnerRequestFor(
  execution: ToolExecution,
  egressProxyUrl: string | null = null,
): string {
  const request: RunnerRequest = {
    version: RUNNER_PROTOCOL_VERSION,
    op: 'call',
    egressProxy: egressProxyUrl,
    execution,
  };
  return `${JSON.stringify(request)}\n`;
}

/** A listing as a request line. */
export function runnerListRequestFor(
  listing: ToolListing,
  egressProxyUrl: string | null = null,
): string {
  const request: RunnerRequest = {
    version: RUNNER_PROTOCOL_VERSION,
    op: 'list',
    egressProxy: egressProxyUrl,
    listing,
  };
  return `${JSON.stringify(request)}\n`;
}

/** The deadline a request asks for, if it can be read: what a tool host queues it by. */
export function runnerRequestTimeoutMs(request: RunnerRequest): number {
  return request.op === 'call' ? request.execution.timeoutMs : request.listing.timeoutMs;
}

function failureOf(reply: z.infer<typeof runnerFailure>): Error {
  if (reply === 'timeout') return new ToolTimeoutError('the tool did not finish in time');
  return new McpFailureError(reply === 'invalid_request' ? 'error' : reply);
}

/**
 * What a runner's reply bytes mean for a call: the result, or the error to throw. Anything that
 * is not a reply, such as a crash's half-written line, is an error like any other crash.
 */
export function callResultFromReply(output: Buffer | string): CallToolResult | Error {
  const reply = parseReply(output);
  if (reply === null || ('tools' in reply && reply.ok)) return new McpFailureError('error');
  if (!reply.ok) return failureOf(reply.failure);
  return reply.result as CallToolResult;
}

/** What a runner's reply bytes mean for a listing. */
export function toolsFromReply(output: Buffer | string): McpToolView[] | Error {
  const reply = parseReply(output);
  if (reply === null || ('result' in reply && reply.ok)) return new McpFailureError('error');
  if (!reply.ok) return failureOf(reply.failure);
  return reply.tools;
}

function parseReply(output: Buffer | string): RunnerReply | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.toString());
  } catch {
    return null;
  }
  const reply = runnerReply.safeParse(parsed);
  return reply.success ? reply.data : null;
}

/**
 * Runs one request in this process and returns the reply to write back. Never throws: a request
 * it cannot read, and every failure, become a reply.
 */
export async function runToolRequest(input: string, signal: AbortSignal): Promise<string> {
  let reply: RunnerReply;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = undefined;
  }
  const request = runnerRequest.safeParse(parsed);
  if (!request.success) {
    reply = { ok: false, failure: 'invalid_request' };
  } else {
    const executor = inProcessExecutorWith({ egressProxy: request.data.egressProxy });
    try {
      if (request.data.op === 'call') {
        const result = await executor.execute(request.data.execution, signal);
        reply = { ok: true, result: callToolResult.parse(result) };
      } else {
        reply = { ok: true, tools: await executor.list(request.data.listing, signal) };
      }
    } catch (error) {
      reply = {
        ok: false,
        failure: error instanceof ToolTimeoutError ? 'timeout' : classifyMcpFailure(error),
      };
    }
  }
  return `${JSON.stringify(reply)}\n`;
}

/**
 * A runner's whole life, on the streams it is given: reads the request line, runs it, writes the
 * reply. Stops the operation when `input` ends before the reply is written, or when `stopped`
 * aborts.
 */
export async function serveToolRunner(
  input: NodeJS.ReadableStream,
  write: (reply: string) => Promise<void>,
  stopped: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, stopped]);
  let buffered = '';
  const line = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const end = buffered.indexOf('\n');
      if (end !== -1 || buffered.length > MAX_RUNNER_REQUEST_BYTES) {
        input.off('data', onData);
        resolve(end === -1 ? buffered : buffered.slice(0, end));
      }
    };
    input.on('data', onData);
    input.once('end', () => resolve(buffered));
  });
  // From here, the end of input means whoever started the runner has gone.
  input.once('end', () => controller.abort(new Error('the executor went away')));
  input.once('close', () => controller.abort(new Error('the executor went away')));
  input.resume();
  await write(await runToolRequest(line, signal));
}
