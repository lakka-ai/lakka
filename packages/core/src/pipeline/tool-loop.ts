import type {
  AttachmentMediaType,
  ChatMessage,
  GatewayRequest,
  GatewayStreamEvent,
  ModelView,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '@lakka/contracts';
import {
  findAttachments,
  findToolCallArguments,
  findToolInvocationId,
  insertAssistantMessage,
  insertToolApproval,
  insertToolMessage,
  listMessages,
} from '@lakka/db';
import type { DispatchedStream, DispatchSummary } from '../gateway/dispatch.ts';
import type { ToolSnapshot } from '../routing/score.ts';
import { dispatchToolCall, recordRefusedToolCall } from '../tools/dispatch.ts';
import type { ToolDispatchContext, ToolDispatchRequest, ToolOutcome } from '../tools/dispatch.ts';
import type { ToolLoopGuard } from '../tools/guard.ts';
import { delimitToolResult, TOOL_RESULTS_ARE_DATA } from '../tools/shape.ts';
import type { Reservation } from '../budgets/engine.ts';

/*
 * Server-side tools in a model request (TL-4, TL-5, TL-9, AC 18, ADR 0071). When a request names
 * a conversation and the workspace offers tools the caller can use, the model may call them:
 *
 *   model round  ->  its tool calls, each through the dispatch seam  ->  the results, framed as
 *   data, back to the model  ->  the next round ... until it answers without calling a tool.
 *
 * Every round reserves and settles its own budget (invariant 4, H8) and is kept in the
 * conversation, round by round. A call that needs approval ends the run: a pending approval is
 * recorded, the caller is told, and a continuation from the same principal resumes it from the
 * stored conversation. The loop guard caps rounds, refuses identical calls, and puts aside a
 * tool that keeps failing (TL-9, H6); past the cap the model answers once more, without tools.
 */

/** What a tool call became, for a surface to show while the reply streams. */
export type ToolActivityEvent = {
  type: 'tool-activity';
  callId: string;
  name: string;
  status: 'ok' | 'error' | 'declined' | 'approval_required';
};

/** The run stopped for the caller's approval of this call (H5). */
export type ApprovalRequiredEvent = {
  type: 'approval-required';
  approvalId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ModelStreamEvent = GatewayStreamEvent | ToolActivityEvent | ApprovalRequiredEvent;

/** A model request's reply: every round's text, the tools it called, and how it ended. */
export interface ModelStream extends AsyncIterable<ModelStreamEvent> {
  readonly model: ModelView;
  readonly attempts: number;
  /** Settles once the reply has ended and everything about it is recorded. */
  readonly done: Promise<DispatchSummary | null>;
}

/** The offered tools as the model is given them: the stored definitions (ADR 0069). */
export function toolDefinitions(
  offered: readonly ToolSnapshot[],
  setAside: (name: string) => boolean = () => false,
): ToolDefinition[] {
  return offered
    .filter((tool) => !setAside(tool.modelName))
    .map((tool) => ({
      name: tool.modelName,
      ...(tool.description === null ? {} : { description: tool.description }),
      inputSchema: { ...tool.inputSchema },
    }));
}

/** The messages with the note that tool results are data first (H7). */
export function withToolNote(messages: readonly ChatMessage[]): ChatMessage[] {
  return [{ role: 'system', content: TOOL_RESULTS_ARE_DATA }, ...messages];
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw === '' ? '{}' : raw);
  } catch {
    return raw;
  }
}

/** Everything running a round's tool calls needs. */
export interface CallRunner {
  ctx: ToolDispatchContext;
  request: Omit<ToolDispatchRequest, 'isApproved'>;
  conversationId: string;
  offered: readonly ToolSnapshot[];
  guard: ToolLoopGuard;
  /** Standing approvals, and the call a continuation approved (TL-5, AC 18). */
  isApproved: ToolDispatchRequest['isApproved'];
  /** For a continuation: the call it declined, answered without running. */
  declinedCallId?: string | null;
  approvedCallId?: string | null;
}

export interface CallsResult {
  /** The tool messages for the model, in call order. */
  messages: ChatMessage[];
  /** Why the loop must stop after these calls, if it must. */
  stop: 'approval' | 'repeated' | null;
}

async function storeToolMessage(
  runner: CallRunner,
  call: ToolCall,
  content: string,
  error: boolean,
): Promise<void> {
  try {
    await insertToolMessage(runner.ctx.db, {
      workspaceId: runner.request.workspaceId,
      conversationId: runner.conversationId,
      requestId: runner.request.requestId,
      toolCallId: call.id,
      toolName: call.name,
      content,
      toolError: error,
    });
  } catch (failure) {
    runner.ctx.logger.error(
      'conversation.record_failed',
      { request_id: runner.request.requestId },
      failure,
    );
  }
}

/**
 * Runs a round's tool calls in order, through the dispatch seam. Stops at the first call that
 * needs approval: its approval is recorded, and the calls after it are left for the
 * continuation to run.
 */
export async function* runToolCalls(
  runner: CallRunner,
  calls: readonly ToolCall[],
): AsyncGenerator<ModelStreamEvent, CallsResult> {
  const messages: ChatMessage[] = [];
  let stop: CallsResult['stop'] = null;
  const dispatchRequest: ToolDispatchRequest = {
    ...runner.request,
    offered: runner.offered,
    isApproved: runner.isApproved,
  };
  for (const call of calls) {
    const seamCall = { callId: call.id, name: call.name, arguments: call.arguments };
    let outcome: ToolOutcome;
    if (runner.declinedCallId === call.id) {
      await recordRefusedToolCall(runner.ctx, dispatchRequest, seamCall, 'denied', 'declined');
      outcome = {
        status: 'error',
        kind: 'terminal',
        tool: null,
        message: 'The user declined to run this call.',
      };
      yield { type: 'tool-activity', callId: call.id, name: call.name, status: 'declined' };
    } else {
      const refusal = runner.guard.check(call.name, parseArguments(call.arguments));
      if (refusal !== null) {
        await recordRefusedToolCall(
          runner.ctx,
          dispatchRequest,
          seamCall,
          'rejected',
          refusal.reason,
        );
        outcome = { status: 'error', kind: 'terminal', tool: null, message: refusal.message };
        if (refusal.reason === 'repeated') stop = 'repeated';
      } else {
        // Only the call a continuation approved counts as approved by it; others ask as usual.
        const approvedHere = runner.approvedCallId === call.id;
        outcome = await dispatchToolCall(
          runner.ctx,
          {
            ...dispatchRequest,
            isApproved: approvedHere ? async () => true : runner.isApproved,
          },
          seamCall,
        );
      }
      if (outcome.status === 'approval_required') {
        const invocationId = await findToolInvocationId(
          runner.ctx.db,
          runner.request.workspaceId,
          runner.request.requestId,
          call.id,
        );
        const approval = await insertToolApproval(runner.ctx.db, {
          workspaceId: runner.request.workspaceId,
          conversationId: runner.conversationId,
          requestId: runner.request.requestId,
          principalId: runner.request.principal.id,
          // The seam recorded the call before returning.
          toolInvocationId: invocationId as string,
          workspaceToolId: outcome.tool.id,
          toolName: call.name,
          callId: call.id,
        });
        yield {
          type: 'tool-activity',
          callId: call.id,
          name: call.name,
          status: 'approval_required',
        };
        yield {
          type: 'approval-required',
          approvalId: approval.id,
          name: call.name,
          arguments: outcome.arguments,
        };
        return { messages, stop: 'approval' };
      }
      yield {
        type: 'tool-activity',
        callId: call.id,
        name: call.name,
        status: outcome.status === 'ok' ? 'ok' : 'error',
      };
    }
    const content = outcome.status === 'ok' ? outcome.content : outcome.message;
    const error = outcome.status !== 'ok';
    await storeToolMessage(runner, call, content, error);
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content: delimitToolResult(call.name, content),
      ...(error ? { isError: true } : {}),
    });
    runner.guard.record(
      call.name,
      outcome.status === 'ok' ? 'ok' : outcome.kind === 'terminal' ? 'terminal' : 'failed',
    );
  }
  return { messages, stop };
}

/** Answers calls the loop will not run any more, so the model can still be asked for a reply. */
function unanswered(calls: readonly ToolCall[], why: string): ChatMessage[] {
  return calls.map((call) => ({
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content: delimitToolResult(call.name, why),
    isError: true,
  }));
}

/** One model call of the loop, with the reservation made for it. */
export interface Round {
  stream: DispatchedStream;
  reservation: Reservation | null;
  /** The number its first attempt was recorded under (ADR 0071). */
  firstAttempt: number;
}

export interface LoopDeps {
  runner: CallRunner;
  /** Whether the model was offered the workspace's tools; if not, it answers in one round. */
  serverTools: boolean;
  /** Round one's request, with the tools and the note. */
  request: GatewayRequest;
  first: Round;
  /** Events a continuation produced before round one, replayed first. */
  prelude: readonly ModelStreamEvent[];
  /** Reserves and dispatches another round, with the model round one used. */
  nextRound: (request: GatewayRequest, firstAttempt: number) => Promise<Round>;
  settle: (round: Round) => Promise<void>;
  /** Records a round's reply: its text, and the tool calls it made. */
  recordReply: (reply: {
    content: string;
    toolCalls: ToolCall[] | null;
    summary: DispatchSummary | null;
  }) => Promise<void>;
  translate: (error: unknown) => unknown;
  onEnd: () => void;
}

const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

function addUsage(total: TokenUsage | null, next: TokenUsage): TokenUsage {
  if (total === null) return next;
  return {
    inputTokens: sum(total.inputTokens, next.inputTokens),
    uncachedInputTokens: sum(total.uncachedInputTokens, next.uncachedInputTokens),
    cacheReadTokens: sum(total.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(total.cacheWriteTokens, next.cacheWriteTokens),
    outputTokens: sum(total.outputTokens, next.outputTokens),
    reasoningTokens: sum(total.reasoningTokens, next.reasoningTokens),
  };
}

/**
 * Ends a round the loop left early and returns how it ended, or null if its usage could not be
 * recorded. A dispatched stream records its usage only when it is read to an end or closed, so a
 * round never opened (its reader stopped during a continuation's prelude) is opened and closed
 * here; closing it ends the provider's stream and records the attempt as aborted.
 */
async function closeRound(round: Round, opened: boolean): Promise<DispatchSummary | null> {
  if (!opened) {
    const reader = round.stream[Symbol.asyncIterator]();
    try {
      await reader.next();
      await reader.return?.();
    } catch {
      // A stream that fails here has recorded how it ended; `done` says so.
    }
  }
  return round.stream.done.catch(() => null);
}

/** The reply of a request with server tools: every round, as one stream. */
export function toolLoop(deps: LoopDeps): ModelStream {
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<DispatchSummary | null>();
  let consumed = false;
  let attempts = deps.first.stream.attempts;

  async function* run(): AsyncGenerator<ModelStreamEvent> {
    const { runner } = deps;
    let round = deps.first;
    // Whether the current round's stream was opened, and whether its reservation was settled:
    // however the reply ends, the round in hand is settled exactly once (invariant 4).
    let opened = false;
    let settled = false;
    let messages = [...deps.request.messages];
    let tools = deps.serverTools;
    let usage: TokenUsage | null = null;
    let last: DispatchSummary | null = null;
    let text = '';
    let recorded = true;
    try {
      yield* deps.prelude;
      for (;;) {
        text = '';
        recorded = false;
        const calls: ToolCall[] = [];
        let finish: Extract<GatewayStreamEvent, { type: 'finish' }> | null = null;
        opened = true;
        for await (const event of round.stream) {
          if (event.type === 'text') {
            text += event.text;
            yield event;
          } else if (event.type === 'reasoning') {
            yield event;
          } else if (event.type === 'tool-call') {
            calls.push({ id: event.callId, name: event.name, arguments: event.arguments });
            // A tool the client brought is the client's to run (H4); pass the call on.
            if (!deps.serverTools) yield event;
          } else {
            finish = event;
          }
        }
        last = await round.stream.done;
        settled = true;
        await deps.settle(round);
        if (finish !== null) usage = addUsage(usage, finish.usage);
        const more = tools && calls.length > 0 && finish?.finishReason === 'tool-calls';
        await deps.recordReply({ content: text, toolCalls: more ? calls : null, summary: last });
        recorded = true;
        if (!more) {
          if (finish !== null) yield { ...finish, usage: usage ?? finish.usage };
          return;
        }
        let answers: ChatMessage[];
        let stop: CallsResult['stop'] = null;
        if (runner.guard.startRound()) {
          const result = yield* runToolCalls(runner, calls);
          if (result.stop === 'approval') {
            yield {
              type: 'finish',
              finishReason: 'stop',
              usage: usage ?? (finish as { usage: TokenUsage }).usage,
            };
            return;
          }
          answers = result.messages;
          stop = result.stop;
        } else {
          answers = unanswered(calls, 'Not run: this request has used all the tool calls it may.');
          stop = 'repeated';
        }
        messages = [
          ...messages,
          { role: 'assistant', content: text, toolCalls: calls },
          ...answers,
        ];
        // After a stuck or exhausted loop, or with every tool put aside, the model answers
        // without tools.
        const remaining = toolDefinitions(runner.offered, (name) => runner.guard.isSetAside(name));
        if (stop !== null || remaining.length === 0) tools = false;
        const { tools: _drop, ...rest } = deps.request;
        void _drop;
        const request: GatewayRequest = tools
          ? { ...rest, messages, tools: remaining }
          : { ...rest, messages };
        // A round that fails to start settles its own hold; the one before is settled already.
        round = await deps.nextRound(request, round.firstAttempt + (last?.attempts ?? 1));
        opened = false;
        settled = false;
        attempts += round.stream.attempts;
      }
    } catch (error) {
      throw deps.translate(error);
    } finally {
      // The loop left a round early: it broke, was aborted, or its reader stopped.
      let ended: DispatchSummary | null = null;
      if (!settled) {
        ended = await closeRound(round, opened);
        if (ended !== null) last = ended;
        await deps.settle(round);
      }
      if (!recorded) {
        // What arrived of the round that ended early is kept, with how it ended.
        await deps
          .recordReply({ content: text, toolCalls: null, summary: ended })
          .catch(() => undefined);
      }
      deps.onEnd();
      resolveDone(last);
    }
  }

  return {
    model: deps.first.stream.model,
    get attempts() {
      return attempts;
    },
    done,
    [Symbol.asyncIterator]() {
      if (consumed) throw new Error('a model stream can only be read once');
      consumed = true;
      return run();
    },
  };
}

/** A reply that is only events, with no model call: a continuation that stopped again. */
export function eventsOnly(model: ModelView, events: readonly ModelStreamEvent[]): ModelStream {
  return {
    model,
    attempts: 0,
    done: Promise.resolve(null),
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

/**
 * A conversation's history as the model is given it, from what is stored (ADR 0071): the
 * people's messages with their files, the replies with the tool calls they made (arguments from
 * the audit, where they are kept), and each result framed as data. `pending` is the last reply's
 * calls that have no result yet.
 */
export async function storedHistory(
  runner: CallRunner,
): Promise<{ messages: ChatMessage[]; pending: ToolCall[] }> {
  const { db } = runner.ctx;
  const { workspaceId, principal } = runner.request;
  const rows = await listMessages(db, workspaceId, runner.conversationId);
  const callIds = rows.flatMap((r) => (r.toolCalls ?? []).map((c) => c.callId));
  const args = await findToolCallArguments(db, workspaceId, runner.conversationId, callIds);
  const fileIds = rows.flatMap((r) => r.attachments.map((a) => a.id));
  const files = new Map(
    (
      await findAttachments(db, workspaceId, principal.actingUserId, runner.conversationId, fileIds)
    ).map((f) => [f.id, f]),
  );
  const messages: ChatMessage[] = [];
  const answered = new Set(rows.flatMap((r) => (r.toolCallId === null ? [] : [r.toolCallId])));
  let pending: ToolCall[] = [];
  for (const row of rows) {
    if (row.role === 'tool') {
      messages.push({
        role: 'tool',
        toolCallId: row.toolCallId as string,
        toolName: row.toolName as string,
        content: delimitToolResult(row.toolName as string, row.content),
        ...(row.toolError === true ? { isError: true } : {}),
      });
    } else if (row.role === 'assistant') {
      const toolCalls = (row.toolCalls ?? []).map((c) => ({
        id: c.callId,
        name: c.name,
        arguments: JSON.stringify(args.get(c.callId) ?? {}),
      }));
      if (row.content === '' && toolCalls.length === 0) continue;
      messages.push({
        role: 'assistant',
        content: row.content,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      });
      pending = toolCalls.filter((c) => !answered.has(c.id));
    } else {
      const parts = row.attachments.flatMap((a) => {
        const file = files.get(a.id);
        return file === undefined
          ? []
          : [
              {
                type: 'file' as const,
                mediaType: file.mediaType as AttachmentMediaType,
                data: file.data.toString('base64'),
                ...(file.filename === null ? {} : { filename: file.filename }),
              },
            ];
      });
      messages.push({
        role: 'user',
        content: parts.length === 0 ? row.content : [{ type: 'text', text: row.content }, ...parts],
      });
      pending = [];
    }
  }
  return { messages, pending };
}

/** How a reply's model was chosen, as its stored message keeps it (CH-2, CH-4). */
export interface RecordedDecision {
  routingRule: string;
  routeName: string | null;
  routingConfidence: number | null;
  routingReason: string | null;
  fallbackFrom: string | null;
  fallbackScope: string | null;
}

/** The reply a round made, kept in the conversation (ADR 0060, ADR 0071). */
export async function recordRound(
  runner: CallRunner,
  reply: {
    content: string;
    toolCalls: ToolCall[] | null;
    state: 'complete' | 'interrupted' | 'aborted';
    model: string;
  } & RecordedDecision,
): Promise<void> {
  try {
    await insertAssistantMessage(runner.ctx.db, {
      workspaceId: runner.request.workspaceId,
      conversationId: runner.conversationId,
      requestId: runner.request.requestId,
      content: reply.content,
      state: reply.state,
      model: reply.model,
      routingRule: reply.routingRule,
      routeName: reply.routeName,
      routingConfidence: reply.routingConfidence,
      routingReason: reply.routingReason,
      fallbackFrom: reply.fallbackFrom,
      fallbackScope: reply.fallbackScope,
      toolCalls: reply.toolCalls?.map((c) => ({ callId: c.id, name: c.name })) ?? null,
    });
  } catch (error) {
    runner.ctx.logger.error(
      'conversation.record_failed',
      { request_id: runner.request.requestId },
      error,
    );
  }
}
