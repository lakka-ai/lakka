import type { FinishReason, GatewayStreamEvent, TokenUsage } from '@lakka/contracts';
import type { ApprovalRequiredEvent, ModelStreamEvent, ToolActivityEvent } from '@lakka/core';

/*
 * Responses in the OpenAI chat-completions shape (API-1, ADR 0059): a stream of
 * chat.completion.chunk events ending in `data: [DONE]`, or one chat.completion object. The
 * `model` field names the model that answered, after any routing, fallback or failover (G3).
 */

export interface CompletionMeta {
  id: string;
  created: number;
  model: string;
}

export function openAiFinishReason(reason: FinishReason): string {
  switch (reason) {
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    case 'tool-calls':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

export function openAiUsage(usage: TokenUsage) {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  };
}

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function chunk(
  meta: CompletionMeta,
  delta: Record<string, unknown>,
  finishReason: string | null,
  lakka?: Record<string, unknown>,
): string {
  return sse({
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(lakka === undefined ? {} : { lakka }),
  });
}

export function usageChunk(meta: CompletionMeta, usage: TokenUsage): string {
  return sse({
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [],
    usage: openAiUsage(usage),
  });
}

type ToolCallEvent = Extract<GatewayStreamEvent, { type: 'tool-call' }>;

/** A call to a tool the client brought, for the client to run (H4). */
export function openAiToolCall(event: ToolCallEvent) {
  return {
    id: event.callId,
    type: 'function',
    function: { name: event.name, arguments: event.arguments },
  };
}

/**
 * What a server-side tool call became, as it happens, for chat to show while the reply streams
 * (TL-6): "Used repo.search". An extension on an otherwise empty chunk, which OpenAI clients
 * ignore. Arguments and results stay out of the stream; the conversation has them.
 */
export function toolActivity(event: ToolActivityEvent) {
  return { call_id: event.callId, name: event.name, status: event.status };
}

/** The call the run stopped for, and how to answer it (H5). */
export function pendingApproval(event: ApprovalRequiredEvent) {
  return { id: event.approvalId, tool: event.name, arguments: event.arguments };
}

export interface Collected {
  text: string;
  toolCalls: ReturnType<typeof openAiToolCall>[];
  pendingApproval: ReturnType<typeof pendingApproval> | null;
  finish: Extract<GatewayStreamEvent, { type: 'finish' }> | null;
}

/** Reads a whole stream into one completion (G8). Reasoning the model showed is not included. */
export async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<Collected> {
  const collected: Collected = {
    text: '',
    toolCalls: [],
    pendingApproval: null,
    finish: null,
  };
  for await (const event of stream) {
    if (event.type === 'text') collected.text += event.text;
    else if (event.type === 'tool-call') collected.toolCalls.push(openAiToolCall(event));
    else if (event.type === 'approval-required') collected.pendingApproval = pendingApproval(event);
    else if (event.type === 'finish') collected.finish = event;
  }
  return collected;
}
