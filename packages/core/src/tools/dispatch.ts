import { context as otelContext, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Tracer } from '@opentelemetry/api';
import { z } from 'zod';
import { McpOriginNotAllowedError } from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import { findMcpServer, insertToolInvocation } from '@lakka/db';
import type { McpServerRow } from '@lakka/db';
import { LK } from '../gateway/telemetry.ts';
import type { Logger } from '../logger.ts';
import { classifyMcpFailure } from '../mcp/client.ts';
import type { McpTarget } from '../mcp/client.ts';
import { mcpTargetFor } from '../mcp/egress.ts';
import { resolveMcpCredential } from '../mcp/oauth.ts';
import type { ResolvedMcpCredential } from '../mcp/oauth.ts';
import type { McpContext } from '../mcp/servers.ts';
import type { PolicySnapshot, ToolSnapshot } from '../routing/score.ts';
import { TOOL_TIMEOUT_MS, ToolTimeoutError } from './executor.ts';
import { shapeToolResult } from './shape.ts';

/*
 * The dispatch seam (invariant 7, TL-1 to TL-9, ADR 0070). Between a model asking for a tool and
 * any code running, these checks happen in this order, each cheap, none skippable:
 *
 *   1. existence      the name is a tool of this workspace; if not, say which exist
 *   2. allowlist      it is one this request may use (ADR 0069)
 *   3. schema         the arguments match its stored schema
 *   4. semantic       the arguments are sane in ways a schema cannot say
 *   5. authorisation  the server's origin is on the instance's allowlist (NF-S4); then as the
 *                     END USER: their own credential, or the shared one, never ours
 *   6. approval       asked for, and given by the caller, when the tool needs it
 *   7. execute        through the executor, under a timeout
 *   8. shape          cut down, and framed as untrusted data, before the model reads it
 *
 * Every call is recorded, whatever happens to it (TL-6). A failure goes back to the model as a
 * short, plain message it can act on, sorted into what it can fix, what is temporary, and what is
 * final; never the server's internals.
 */

/** Arguments bigger than this are refused, and stored only as their size (H6, ADR 0066 Q3). */
const MAX_ARGUMENT_BYTES = 16 * 1024;
/** Nesting deeper than this is refused before it reaches a server. */
const MAX_ARGUMENT_DEPTH = 20;
/** At most this many valid tool names are listed back to a model that named a wrong one. */
const MAX_NAMES_LISTED = 20;

export interface ToolDispatchContext extends McpContext {
  logger: Logger;
  tracer?: Tracer;
}

/** A tool call as the model asked for it. `arguments` is the model's raw JSON. */
export interface ToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ToolDispatchRequest {
  requestId: string;
  workspaceId: string;
  principal: Principal;
  conversationId: string | null;
  policy: PolicySnapshot;
  /** The tools this request may use: resolveTools at stage 6 (ADR 0069). */
  offered: readonly ToolSnapshot[];
  /** Whether the caller approved this call; the tool loop answers it (TL-4, AC 18, ADR 0071). */
  isApproved: (tool: ToolSnapshot, args: Record<string, unknown>) => Promise<boolean>;
  signal: AbortSignal;
  /** The request's span, so each call is part of its trace (OB-1). */
  traceContext?: Context;
}

/**
 * What became of a call:
 * - 'ok': the tool's answer, shaped, for the model;
 * - 'error': a message for the model. 'fixable' means it can try again differently, 'retryable'
 *   that the trouble is temporary, 'terminal' that it should not try this tool again;
 * - 'approval_required': nothing ran; the caller must approve it first.
 */
export type ToolOutcome =
  | { status: 'ok'; tool: ToolSnapshot; content: string }
  | {
      status: 'error';
      kind: 'fixable' | 'retryable' | 'terminal';
      tool: ToolSnapshot | null;
      message: string;
    }
  | { status: 'approval_required'; tool: ToolSnapshot; arguments: Record<string, unknown> };

type Audit = {
  status: 'ok' | 'rejected' | 'denied' | 'approval_required' | 'failed' | 'timeout';
  reason: string | null;
  credentialPrincipalId?: string | null;
};

function depth(value: unknown, level = 0): number {
  if (level > MAX_ARGUMENT_DEPTH) return level;
  if (Array.isArray(value)) return Math.max(level, ...value.map((v) => depth(v, level + 1)));
  if (value !== null && typeof value === 'object') {
    return Math.max(level, ...Object.values(value).map((v) => depth(v, level + 1)));
  }
  return level;
}

/** What the audit keeps of the arguments: them, or only their size when too big (Q3). */
function auditArguments(raw: string, parsed: unknown): unknown {
  const bytes = Buffer.byteLength(raw);
  if (parsed === undefined) return { unparsed: true, bytes };
  return bytes > MAX_ARGUMENT_BYTES ? { truncated: true, bytes } : parsed;
}

/** The schema errors, briefly, by field: enough for the model to correct itself (tech spec). */
function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => {
      const field = issue.path.length === 0 ? 'the arguments' : `'${issue.path.join('.')}'`;
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

/** Final: the model should not try a tool whose server an instance admin has not allowed. */
const notAllowedMessage = (tool: ToolSnapshot) =>
  `The tool ${tool.modelName} cannot be used: an administrator has not allowed its server.`;

const fail = (
  kind: 'fixable' | 'retryable' | 'terminal',
  tool: ToolSnapshot | null,
  message: string,
): ToolOutcome => ({ status: 'error', kind, tool, message });

/** Runs one tool call through every check, and records it. */
export async function dispatchToolCall(
  ctx: ToolDispatchContext,
  req: ToolDispatchRequest,
  call: ToolCall,
): Promise<ToolOutcome> {
  const started = Date.now();
  const tracer = ctx.tracer ?? trace.getTracer('lakka.tools');
  const span = tracer.startSpan(
    'execute_tool',
    {
      attributes: {
        [LK.REQUEST_ID]: req.requestId,
        [LK.WORKSPACE_ID]: req.workspaceId,
        [LK.TOOL_NAME]: call.name,
      },
    },
    req.traceContext ?? otelContext.active(),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments === '' ? '{}' : call.arguments);
  } catch {
    parsed = undefined;
  }
  let tool: ToolSnapshot | null = null;
  const record = async (audit: Audit) => {
    span.setAttribute(LK.TOOL_STATUS, audit.status);
    if (audit.credentialPrincipalId != null) {
      span.setAttribute(LK.TOOL_CREDENTIAL_PRINCIPAL, audit.credentialPrincipalId);
    }
    if (audit.status !== 'ok' && audit.status !== 'approval_required') {
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (audit.reason !== null) span.setAttribute('error.type', audit.reason);
    }
    span.end();
    await insertToolInvocation(ctx.db, {
      requestId: req.requestId,
      workspaceId: req.workspaceId,
      principalId: req.principal.id,
      actingUserId: req.principal.actingUserId,
      conversationId: req.conversationId,
      callId: call.callId,
      toolName: call.name,
      workspaceToolId: tool?.id ?? null,
      mcpServerId: tool?.serverId ?? null,
      arguments: auditArguments(call.arguments, parsed),
      status: audit.status,
      reason: audit.reason,
      credentialPrincipalId: audit.credentialPrincipalId ?? null,
      durationMs: Date.now() - started,
    });
  };

  // 1. Existence: a name the workspace has no tool for.
  tool = req.policy.tools.find((t) => t.modelName === call.name) ?? null;
  if (tool === null) {
    await record({ status: 'rejected', reason: 'unknown_tool' });
    const names = req.offered.map((t) => t.modelName).slice(0, MAX_NAMES_LISTED);
    return fail(
      'fixable',
      null,
      names.length === 0
        ? `Unknown tool '${call.name}'. No tools are available.`
        : `Unknown tool '${call.name}'. Valid tools: ${names.join(', ')}.`,
    );
  }

  // 2. Allowlist: a tool of the workspace this request may not use.
  if (!req.offered.some((t) => t.id === tool?.id)) {
    await record({ status: 'denied', reason: 'not_allowed' });
    return fail('terminal', tool, `The tool ${tool.modelName} is not available to you here.`);
  }

  // 3. Schema, against the definition stored when the tool was synced.
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    await record({ status: 'rejected', reason: 'invalid_arguments' });
    return fail('fixable', tool, `Arguments for ${tool.modelName} must be a JSON object.`);
  }
  if (Buffer.byteLength(call.arguments) > MAX_ARGUMENT_BYTES) {
    await record({ status: 'rejected', reason: 'arguments_too_large' });
    return fail('fixable', tool, `Arguments for ${tool.modelName} are too large.`);
  }
  const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    await record({ status: 'rejected', reason: 'invalid_arguments' });
    return fail(
      'fixable',
      tool,
      `Invalid arguments for ${tool.modelName}: ${describeIssues(checked.error.issues)}.`,
    );
  }
  const args = parsed as Record<string, unknown>;

  // 4. Semantic checks a schema cannot express. MCP tools carry no semantics Lakka knows, so
  // only structural sanity is checked here; the stage is where built-in tools add their own.
  if (depth(args) > MAX_ARGUMENT_DEPTH) {
    await record({ status: 'rejected', reason: 'arguments_too_deep' });
    return fail('fixable', tool, `Arguments for ${tool.modelName} are nested too deeply.`);
  }

  // 5. Authorisation. The server's origin must be listed (NF-S4, ADR 0117), checked before any
  // credential is refreshed. Then as the end user: their own credential for an OAuth server, the
  // shared one recorded as whose it is, and never a credential of Lakka's own (NF-S2).
  const server: McpServerRow | undefined = await findMcpServer(
    ctx.db,
    req.workspaceId,
    tool.serverId,
  );
  const notAllowed = async () => {
    await record({ status: 'denied', reason: 'origin_not_allowed' });
    return fail('terminal', tool, notAllowedMessage(tool));
  };
  let target: McpTarget | undefined;
  let credential: ResolvedMcpCredential = 'missing';
  if (server !== undefined) {
    try {
      target = await mcpTargetFor(ctx, server);
      credential = await resolveMcpCredential(ctx, req.principal, server);
    } catch (error) {
      // The server, or the authorization server a refresh needs, is not listed.
      if (error instanceof McpOriginNotAllowedError) return notAllowed();
      throw error;
    }
  }
  if (server === undefined || target === undefined || credential === 'missing') {
    await record({ status: 'denied', reason: 'no_credential' });
    return fail(
      'terminal',
      tool,
      server?.authMode === 'oauth'
        ? `The tool ${tool.modelName} needs the user's own account connected to ${tool.serverName}. Tell the user to connect it.`
        : `The tool ${tool.modelName} cannot be used right now.`,
    );
  }

  // 6. Approval, from the caller, when the tool needs it (TL-4, AC 18).
  if (tool.approvalRequired && !(await req.isApproved(tool, args))) {
    await record({
      status: 'approval_required',
      reason: null,
      credentialPrincipalId: credential.credentialPrincipalId,
    });
    return { status: 'approval_required', tool, arguments: args };
  }

  // 7. Execute, under a timeout. Retried once, only when the server could not be reached and the
  // tool says repeating it is harmless: a call that may have run is never sent twice.
  const execution = {
    target,
    secret: credential.secret,
    toolName: tool.name,
    arguments: args,
    timeoutMs: TOOL_TIMEOUT_MS,
  };
  const safeToRepeat =
    tool.annotations['readOnlyHint'] === true || tool.annotations['idempotentHint'] === true;
  let result;
  for (let attempt = 1; ; attempt += 1) {
    try {
      result = await ctx.executor.execute(execution, req.signal);
      break;
    } catch (error) {
      if (req.signal.aborted) throw error;
      if (error instanceof ToolTimeoutError) {
        await record({
          status: 'timeout',
          reason: 'timeout',
          credentialPrincipalId: credential.credentialPrincipalId,
        });
        return fail(
          'retryable',
          tool,
          `The tool ${tool.modelName} did not finish within ${TOOL_TIMEOUT_MS / 1000} seconds.`,
        );
      }
      const failure = classifyMcpFailure(error);
      if (failure === 'unreachable' && safeToRepeat && attempt === 1) continue;
      await record({
        status: 'failed',
        reason: failure,
        credentialPrincipalId: credential.credentialPrincipalId,
      });
      ctx.logger.warn('tool.failed', { request_id: req.requestId, error_code: failure });
      return failure === 'auth_failed'
        ? fail('terminal', tool, `${tool.serverName} refused the credential for ${tool.modelName}.`)
        : failure === 'not_allowed'
          ? fail('terminal', tool, notAllowedMessage(tool))
          : failure === 'unreachable'
            ? fail('retryable', tool, `The tool ${tool.modelName} is unavailable right now.`)
            : fail('fixable', tool, `The tool ${tool.modelName} failed.`);
    }
  }

  // 8. Shape: what the tool said, cut down. Framing it as data happens where the prompt is built.
  const shaped = shapeToolResult(result);
  if (shaped.isError) {
    await record({
      status: 'failed',
      reason: 'tool_error',
      credentialPrincipalId: credential.credentialPrincipalId,
    });
    return fail('fixable', tool, `The tool reported an error: ${shaped.text}`);
  }
  await record({
    status: 'ok',
    reason: null,
    credentialPrincipalId: credential.credentialPrincipalId,
  });
  return { status: 'ok', tool, content: shaped.text };
}

/**
 * Records a call that never reached the checks, because the loop refused it first (a repeated
 * call, a tool set aside) or its caller declined it (TL-6: every call is recorded).
 */
export async function recordRefusedToolCall(
  ctx: ToolDispatchContext,
  req: ToolDispatchRequest,
  call: ToolCall,
  status: 'rejected' | 'denied',
  reason: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments === '' ? '{}' : call.arguments);
  } catch {
    parsed = undefined;
  }
  const tool = req.policy.tools.find((t) => t.modelName === call.name);
  await insertToolInvocation(ctx.db, {
    requestId: req.requestId,
    workspaceId: req.workspaceId,
    principalId: req.principal.id,
    actingUserId: req.principal.actingUserId,
    conversationId: req.conversationId,
    callId: call.callId,
    toolName: call.name,
    workspaceToolId: tool?.id ?? null,
    mcpServerId: tool?.serverId ?? null,
    arguments: auditArguments(call.arguments, parsed),
    status,
    reason,
    credentialPrincipalId: null,
    durationMs: 0,
  });
}
