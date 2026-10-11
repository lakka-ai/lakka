import type {
  JSONSchema7,
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { TEXT_MEDIA_TYPE, textOf } from '@lakka/contracts';
import type { GatewayRequest, GatewayStreamEvent, TokenUsage } from '@lakka/contracts';
import { textDocument } from './text-document.ts';

/*
 * One streaming call to one model: the unit the gateway retries, fails over and accounts for
 * (ADR 0036). It calls the provider's model directly, below the AI SDK's `ai` package, so there
 * are no hidden retries, no tool loops, no telemetry and no URL downloads. Tool calls are passed
 * back as events; running them is the pipeline's business, through the dispatch seam (ADR 0071). Everything the
 * gateway decides (commitment window, retries, failover, cost) happens around this function.
 */

export class ProviderStreamError extends Error {
  override readonly name = 'ProviderStreamError';
}

/**
 * The request as the provider packages take it. Files go as inline data, never as a URL, so no
 * provider package downloads anything on a user's behalf (ADR 0036, ADR 0058).
 */
/** A tool call's arguments as the provider packages take them: an object, never unparsed text. */
function toolInput(args: string): unknown {
  try {
    const parsed: unknown = JSON.parse(args === '' ? '{}' : args);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function toPrompt(request: GatewayRequest): LanguageModelV4Prompt {
  return request.messages.map((m) => {
    if (m.role === 'system') return { role: 'system', content: textOf(m.content) };
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            // The schema guarantees a tool message has both.
            toolCallId: m.toolCallId as string,
            toolName: m.toolName as string,
            output:
              m.isError === true
                ? { type: 'error-text', value: textOf(m.content) }
                : { type: 'text', value: textOf(m.content) },
          },
        ],
      };
    }
    if (m.role === 'assistant') {
      const text = textOf(m.content);
      return {
        role: 'assistant',
        content: [
          ...(text === '' && m.toolCalls !== undefined ? [] : [{ type: 'text' as const, text }]),
          ...(m.toolCalls ?? []).map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.id,
            toolName: call.name,
            input: toolInput(call.arguments),
          })),
        ],
      };
    }
    const parts =
      typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    return {
      role: 'user',
      content: parts.map((p) =>
        p.type === 'text'
          ? { type: 'text', text: p.text }
          : p.mediaType === TEXT_MEDIA_TYPE
            ? { type: 'text', text: textDocument(p) }
            : {
                type: 'file',
                mediaType: p.mediaType,
                data: { type: 'data', data: p.data },
                ...(p.filename === undefined ? {} : { filename: p.filename }),
              },
      ),
    };
  });
}

export function toTokenUsage(usage: LanguageModelV4Usage): TokenUsage {
  return {
    inputTokens: usage.inputTokens.total ?? null,
    uncachedInputTokens: usage.inputTokens.noCache ?? null,
    cacheReadTokens: usage.inputTokens.cacheRead ?? null,
    cacheWriteTokens: usage.inputTokens.cacheWrite ?? null,
    outputTokens: usage.outputTokens.total ?? null,
    reasoningTokens: usage.outputTokens.reasoning ?? null,
  };
}

function toEvent(part: LanguageModelV4StreamPart): GatewayStreamEvent | undefined {
  switch (part.type) {
    case 'text-delta':
      return part.delta === '' ? undefined : { type: 'text', text: part.delta };
    case 'reasoning-delta':
      return part.delta === '' ? undefined : { type: 'reasoning', text: part.delta };
    case 'tool-call':
      // A tool the provider ran itself is not ours to run again.
      return part.providerExecuted === true
        ? undefined
        : {
            type: 'tool-call',
            callId: part.toolCallId,
            name: part.toolName,
            arguments: part.input,
          };
    case 'finish':
      return {
        type: 'finish',
        finishReason: part.finishReason.unified,
        usage: toTokenUsage(part.usage),
      };
    case 'error':
      // The provider's own error, which may echo request content; it is never logged as is.
      throw new ProviderStreamError('the provider reported an error mid-stream', {
        cause: part.error,
      });
    default:
      // Stream metadata, warnings, sources and tool parts carry nothing M2 uses.
      return undefined;
  }
}

/**
 * Streams one model call. Aborting `signal` cancels the provider request. Errors before the
 * stream opens (HTTP status errors) reject from the first `next()`, which is what the
 * commitment window needs to retry them.
 */
export async function* streamModelCall(
  model: LanguageModelV4,
  request: GatewayRequest,
  signal: AbortSignal,
): AsyncGenerator<GatewayStreamEvent> {
  const { stream } = await model.doStream({
    prompt: toPrompt(request),
    abortSignal: signal,
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.stopSequences === undefined ? {} : { stopSequences: request.stopSequences }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema as JSONSchema7,
          })),
          toolChoice: { type: 'auto' as const },
        }),
  });
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      const event = toEvent(value);
      if (event !== undefined) yield event;
    }
  } finally {
    // Stopping early (abort, failover, a caller that quits) must close the provider request.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
