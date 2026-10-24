import { z } from 'zod';

/*
 * The normalized request and stream the provider gateway works with (tech spec, Provider
 * gateway). Every surface turns its own wire format into a GatewayRequest, and every provider's
 * stream comes back as GatewayStreamEvents, so policy, budgets and accounting see one shape.
 * A user message may carry files, images and PDFs, as base64 (CH-5, ADR 0058); tools arrive in M6.
 */

/**
 * Hosted providers that speak OpenAI chat completions at their own standard address. They are
 * first-party: named by their kind, priced by the catalogue, and keyed per workspace if wanted.
 */
export const COMPATIBLE_FIRST_PARTY_KINDS = [
  'deepseek',
  'moonshot',
  'qwencloud',
  'xiaomi-mimo',
  'zai',
] as const;

/** The providers we speak to (PR-4). OpenAI-compatible covers Ollama, vLLM, OpenRouter. */
export const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'google',
  ...COMPATIBLE_FIRST_PARTY_KINDS,
  'openai-compatible',
] as const;
export const providerKind = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof providerKind>;

/**
 * The file types models read. Anything else is refused at the edge rather than guessed at. Plain
 * text, UTF-8 only, is every model's: the gateway hands it over as delimited text (ADR 0106).
 */
export const ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
] as const;

export const TEXT_MEDIA_TYPE = 'text/plain';
export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

/** Largest file, and largest total of files in one message, in bytes once decoded (Q2). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const textPart = z.object({ type: z.literal('text'), text: z.string() }).strict();
export const filePart = z
  .object({
    type: z.literal('file'),
    mediaType: z.enum(ATTACHMENT_MEDIA_TYPES),
    /** The file's bytes, base64-encoded. Never a URL: the server fetches nothing for a user. */
    data: z.base64(),
    filename: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine((f) => f.mediaType !== TEXT_MEDIA_TYPE || textOfFile(f.data) !== undefined, {
    message: 'a text/plain file must be UTF-8 text',
    path: ['data'],
  });
export const contentPart = z.discriminatedUnion('type', [textPart, filePart]);
export type ContentPart = z.infer<typeof contentPart>;
export type FilePart = z.infer<typeof filePart>;
/** A message's content: plain text, or parts. */
export type MessageContent = string | ContentPart[];

/** A text/plain file's text, or undefined if its bytes are not UTF-8. */
export function textOfFile(base64: string): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** How many bytes a base64 string decodes to. */
export function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** A tool call a model made: its id, the tool's name, and the arguments as the model wrote them. */
export const toolCall = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    arguments: z.string().max(64 * 1024),
  })
  .strict();
export type ToolCall = z.infer<typeof toolCall>;

/**
 * A message in a conversation (ADR 0058, ADR 0071). An assistant message may carry the tool
 * calls the model made; a `tool` message carries one call's result, as text.
 */
export const chatMessage = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(contentPart).min(1)]),
    toolCalls: z.array(toolCall).min(1).max(64).optional(),
    toolCallId: z.string().min(1).max(200).optional(),
    toolName: z.string().min(1).max(200).optional(),
    /** For a tool result: the call failed, and the content says how. */
    isError: z.boolean().optional(),
  })
  .strict()
  .refine((m) => m.toolCalls === undefined || m.role === 'assistant', {
    path: ['toolCalls'],
    message: 'only assistant messages carry tool calls',
  })
  .refine(
    (m) =>
      (m.role === 'tool') ===
      (m.toolCallId !== undefined && m.toolName !== undefined && typeof m.content === 'string'),
    { path: ['toolCallId'], message: 'a tool message names its call and tool, and is text' },
  )
  .refine(
    (m) =>
      m.role === 'user' ||
      typeof m.content === 'string' ||
      m.content.every((p) => p.type === 'text'),
    {
      path: ['content'],
      message: 'only user messages may carry files',
    },
  )
  .refine((m) => filesOf(m.content).every((f) => decodedBytes(f.data) <= MAX_ATTACHMENT_BYTES), {
    path: ['content'],
    message: 'a file is larger than 10 MB',
  })
  .refine(
    (m) =>
      filesOf(m.content).reduce((sum, f) => sum + decodedBytes(f.data), 0) <=
      MAX_MESSAGE_ATTACHMENT_BYTES,
    { path: ['content'], message: 'the files in one message are larger than 20 MB' },
  );
export type ChatMessage = z.infer<typeof chatMessage>;

/** The text of a message, its text parts joined. */
export function textOf(content: MessageContent): string {
  return typeof content === 'string'
    ? content
    : content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
}

/** The files a message carries. */
export function filesOf(content: MessageContent): FilePart[] {
  return typeof content === 'string' ? [] : content.filter((p): p is FilePart => p.type === 'file');
}

/** A tool the model may call (ADR 0071): its name, what it is for, and its arguments' schema. */
export const toolDefinition = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    description: z.string().max(8000).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ToolDefinition = z.infer<typeof toolDefinition>;

export const gatewayRequest = z
  .object({
    messages: z.array(chatMessage).min(1),
    tools: z.array(toolDefinition).min(1).max(128).optional(),
    maxOutputTokens: z.int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().gt(0).max(1).optional(),
    stopSequences: z.array(z.string().min(1)).max(4).optional(),
  })
  .strict();
export type GatewayRequest = z.infer<typeof gatewayRequest>;

/**
 * Token counts as the provider reported them, split the way pricing needs them. A count the
 * provider did not report is null, never guessed as zero: cost accounting treats a missing
 * split pessimistically.
 */
export interface TokenUsage {
  /** Every input token, cached or not. */
  inputTokens: number | null;
  /** Input tokens billed at the normal input price. */
  uncachedInputTokens: number | null;
  /** Input tokens read from the provider's prompt cache. */
  cacheReadTokens: number | null;
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteTokens: number | null;
  /** Every output token, reasoning included. */
  outputTokens: number | null;
  /** Output tokens spent on reasoning, part of outputTokens. */
  reasoningTokens: number | null;
}

/** `interrupted`: the provider stream ended without a completion signal, so output may be cut short. */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'interrupted'
  | 'other';

export type GatewayStreamEvent =
  | { type: 'text'; text: string }
  /** Reasoning the provider chose to show. Counted in output tokens either way. */
  | { type: 'reasoning'; text: string }
  /** A tool the model wants called, with its arguments as the model wrote them. */
  | { type: 'tool-call'; callId: string; name: string; arguments: string }
  | { type: 'finish'; finishReason: FinishReason; usage: TokenUsage };
