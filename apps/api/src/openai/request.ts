import { z } from 'zod';
import {
  ATTACHMENT_MEDIA_TYPES,
  gatewayRequest,
  InvalidRequestError,
  openAiChatRequest,
} from '@lakka/contracts';
import type {
  AttachmentMediaType,
  ChatMessage,
  ContentPart,
  ToolCall,
  ToolDefinition,
  FilePart,
  GatewayRequest,
  OpenAiChatRequest,
} from '@lakka/contracts';

/*
 * Turning an OpenAI chat-completions request into the gateway's normalized request (API-1,
 * ADR 0058). The surface is only an adapter: policy, routing and budgets happen in core, the same
 * for every surface (invariant 1). What this refuses, it refuses with a reason a developer can
 * act on:
 *   - the legacy functions and function_call fields, and tool_choice other than auto or none;
 *     tools themselves are passed to the model, and their calls back to the client (ADR 0071);
 *   - structured output;
 *   - more than one choice (n > 1);
 *   - images or files given by URL, since the server fetches nothing for a user;
 *   - file ids, except those of files already stored in the conversation the request names,
 *     which chat uses to send earlier files again without uploading them again (ADR 0062);
 *   - any message role or content part we do not handle.
 */

/** A stored file of the request's conversation, found by id (ADR 0062). */
export interface StoredFile {
  mediaType: string;
  filename: string | null;
  data: Buffer;
}

/** Finds files of the conversation the request names; null when it names none. */
export type FileLookup = ((ids: readonly string[]) => Promise<Map<string, StoredFile>>) | null;

export interface TranslatedRequest {
  /** The `model` field as sent: a model reference, "auto", or "route/<name>" (G1). */
  model: string;
  stream: boolean;
  /** Whether a streamed response ends with a usage chunk (stream_options.include_usage). */
  includeUsage: boolean;
  request: GatewayRequest;
}

const invalid = (param: string, message: string) =>
  Object.assign(new InvalidRequestError(message), { param });

// Parameters such as charset=utf-8 are allowed and ignored: a text file must be UTF-8 whatever it
// says (ADR 0106).
const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[a-z0-9-]+=[^;,]*)*;base64,(.*)$/is;

function isAttachmentType(type: string): type is AttachmentMediaType {
  return (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(type);
}

function fromDataUrl(
  url: string,
  param: string,
  kind: 'image' | 'file',
): { mediaType: AttachmentMediaType; data: string } {
  const match = DATA_URL.exec(url);
  if (match === null) {
    throw invalid(
      param,
      `${kind === 'image' ? 'Images' : 'Files'} must be sent inline as base64 data URLs; the server fetches nothing by URL.`,
    );
  }
  const mediaType = (match[1] ?? '').toLowerCase();
  // A file part may carry an image too, which keeps its file name; image_url may carry only images.
  if (!isAttachmentType(mediaType) || (kind === 'image' && !mediaType.startsWith('image/'))) {
    throw invalid(
      param,
      `Unsupported ${kind} type ${mediaType}. Send PNG, JPEG, GIF, WebP, PDF or plain text.`,
    );
  }
  return { mediaType, data: match[2] ?? '' };
}

type RawContent = NonNullable<OpenAiChatRequest['messages'][number]['content']>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The file ids a request refers to, checked for shape, before any of them is looked up. */
function fileIdsOf(messages: OpenAiChatRequest['messages']): string[] {
  const ids: string[] = [];
  messages.forEach((m, i) => {
    if (m.content === undefined || m.content === null || typeof m.content === 'string') return;
    m.content.forEach((part, j) => {
      if (part.type !== 'file' || !('file' in part)) return;
      const file = part.file as { file_data?: string; file_id?: string };
      if (file.file_data !== undefined || file.file_id === undefined) return;
      if (!UUID.test(file.file_id)) {
        throw invalid(
          `messages[${i}].content[${j}].file.file_id`,
          'No file with this id is stored in the conversation.',
        );
      }
      ids.push(file.file_id);
    });
  });
  return ids;
}

function fromStored(stored: StoredFile | undefined, param: string): FilePart {
  if (stored === undefined || !isAttachmentType(stored.mediaType)) {
    throw invalid(param, 'No file with this id is stored in the conversation.');
  }
  return {
    type: 'file',
    mediaType: stored.mediaType,
    data: stored.data.toString('base64'),
    ...(stored.filename === null ? {} : { filename: stored.filename }),
  };
}

function content(
  raw: RawContent,
  param: string,
  stored: ReadonlyMap<string, StoredFile> | null,
): string | ContentPart[] {
  if (typeof raw === 'string') return raw;
  return raw.map((part, i): ContentPart => {
    const at = `${param}[${i}]`;
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image_url' && 'image_url' in part) {
      const image = part.image_url as { url: string };
      return { type: 'file', ...fromDataUrl(image.url, `${at}.image_url.url`, 'image') };
    }
    if (part.type === 'file' && 'file' in part) {
      const file = part.file as { file_data?: string; file_id?: string; filename?: string };
      if (file.file_data === undefined) {
        if (file.file_id !== undefined && stored !== null) {
          return fromStored(stored.get(file.file_id), `${at}.file.file_id`);
        }
        throw invalid(
          `${at}.file`,
          file.file_id === undefined
            ? 'Files must be sent inline as file_data.'
            : 'A file id refers to a file stored in the conversation named in x-lakka-conversation. Without one, send the file inline as file_data.',
        );
      }
      return {
        type: 'file',
        ...fromDataUrl(file.file_data, `${at}.file.file_data`, 'file'),
        ...(file.filename === undefined ? {} : { filename: file.filename }),
      };
    }
    throw invalid(at, `Content of type ${part.type} is not supported.`);
  });
}

const openAiTool = z.object({
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const openAiToolCall = z.looseObject({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
});

/** The tools the client offers the model; their calls come back to the client to run (H4). */
function toolsOf(r: OpenAiChatRequest): ToolDefinition[] | undefined {
  const choice = r.tool_choice ?? 'auto';
  if (choice !== 'auto' && choice !== 'none') {
    throw invalid('tool_choice', 'Only tool_choice "auto" and "none" are supported.');
  }
  if (r.tools === undefined || r.tools === null || r.tools.length === 0 || choice === 'none') {
    return undefined;
  }
  return r.tools.map((raw, i) => {
    const parsed = openAiTool.safeParse(raw);
    if (!parsed.success) {
      throw invalid(`tools[${i}]`, 'Only tools of type function, with a name, are supported.');
    }
    const fn = parsed.data.function;
    return {
      name: fn.name,
      ...(fn.description === undefined ? {} : { description: fn.description }),
      inputSchema: fn.parameters ?? { type: 'object', properties: {} },
    };
  });
}

function toolCallsOf(raw: readonly unknown[], param: string): ToolCall[] {
  return raw.map((call, i) => {
    const parsed = openAiToolCall.safeParse(call);
    if (!parsed.success) {
      throw invalid(
        `${param}[${i}]`,
        'A tool call needs an id, the type function, a name and its arguments.',
      );
    }
    return {
      id: parsed.data.id,
      name: parsed.data.function.name,
      arguments: parsed.data.function.arguments,
    };
  });
}

function textOnly(raw: RawContent | null | undefined, param: string): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  return raw
    .map((part, i) => {
      if (part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text;
      throw invalid(`${param}[${i}]`, 'A tool result can only be text.');
    })
    .join('');
}

export async function translateChatRequest(
  body: unknown,
  lookUpFiles: FileLookup = null,
): Promise<TranslatedRequest> {
  const parsed = openAiChatRequest.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(
      issue?.path.join('.') ?? '',
      `Invalid request: ${issue?.message ?? 'malformed body'}`,
    );
  }
  const r = parsed.data;
  if ((r.functions ?? []).length > 0 || (r.function_call ?? null) !== null) {
    throw invalid('functions', 'The legacy functions field is not supported; use tools.');
  }
  const tools = toolsOf(r);
  if (r.n !== undefined && r.n !== null && r.n !== 1) {
    throw invalid('n', 'Only one choice per request is supported (n = 1).');
  }
  if (
    r.response_format !== undefined &&
    r.response_format !== null &&
    r.response_format.type !== 'text'
  ) {
    throw invalid('response_format', 'Structured output is not supported yet.');
  }

  const ids = lookUpFiles === null ? [] : fileIdsOf(r.messages);
  const stored =
    lookUpFiles === null ? null : ids.length === 0 ? new Map() : await lookUpFiles(ids);

  // A tool message names only its call; the tool's name comes from the reply that made the call.
  const calledTools = new Map<string, string>();
  const messages: ChatMessage[] = r.messages.map((m, i): ChatMessage => {
    const param = `messages[${i}]`;
    const role = m.role === 'developer' ? 'system' : m.role;
    if (role === 'tool') {
      const name = m.tool_call_id === undefined ? undefined : calledTools.get(m.tool_call_id);
      if (m.tool_call_id === undefined || name === undefined) {
        throw invalid(
          `${param}.tool_call_id`,
          'A tool message must answer a tool call made by an earlier assistant message.',
        );
      }
      return {
        role: 'tool',
        content: textOnly(m.content, `${param}.content`),
        toolCallId: m.tool_call_id,
        toolName: name,
      };
    }
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw invalid(`${param}.role`, `Messages with the role ${m.role} are not supported.`);
    }
    const parts =
      m.content === undefined || m.content === null
        ? ''
        : content(m.content, `${param}.content`, stored);
    const calls = m.tool_calls ?? [];
    if (calls.length === 0) return { role, content: parts };
    if (role !== 'assistant') {
      throw invalid(`${param}.tool_calls`, 'Only assistant messages carry tool calls.');
    }
    const toolCalls = toolCallsOf(calls, `${param}.tool_calls`);
    for (const call of toolCalls) calledTools.set(call.id, call.name);
    return { role, content: parts, toolCalls };
  });

  const maxOutputTokens = r.max_completion_tokens ?? r.max_tokens ?? undefined;
  const stop =
    r.stop === undefined || r.stop === null
      ? undefined
      : typeof r.stop === 'string'
        ? [r.stop]
        : r.stop;
  const candidate = {
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(r.temperature === undefined || r.temperature === null
      ? {}
      : { temperature: r.temperature }),
    ...(r.top_p === undefined || r.top_p === null ? {} : { topP: r.top_p }),
    ...(stop === undefined || stop.length === 0
      ? {}
      : { stopSequences: stop.filter((s) => s !== '') }),
  };
  const normalized = gatewayRequest.safeParse(candidate);
  if (!normalized.success) {
    const issue = normalized.error.issues[0];
    throw invalid(
      issue?.path.join('.') ?? '',
      `Invalid request: ${issue?.message ?? 'malformed body'}`,
    );
  }
  return {
    model: r.model,
    stream: r.stream === true,
    includeUsage: r.stream_options?.include_usage === true,
    request: normalized.data,
  };
}
