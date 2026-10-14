/*
 * Chat's client for /v1/chat/completions (G5, ADR 0061). Chat is an ordinary client of the
 * OpenAI-compatible endpoint: the same request an SDK sends, with the session cookie, the
 * workspace and the conversation in headers (G4). What routing and budgets decided arrives in the
 * x-lakka-* response headers (G3), before the first word of the reply. Tools the workspace
 * offers run on the server; a run that stops for approval is read back from the stored
 * conversation, and answered with the approval headers (ADR 0071).
 */

/**
 * A piece of a message, in the OpenAI format: text, an image or a PDF sent inline, or a file
 * already stored in the conversation, sent again by id (CH-5, ADR 0062). Chat sends images as
 * file parts, which keep the file name.
 */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'file'; file: { file_data: string; filename: string } }
  | { type: 'file'; file: { file_id: string } };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string | ChatPart[];
}

/**
 * The person's answer to a tool call the conversation is waiting on (TL-4, H5): run it once, run
 * it and every later call to that tool, or decline it.
 */
export type ChatApproval = { id: string; answer: 'once' | 'always' | 'deny' };

function approvalHeaders(approval: ChatApproval | undefined): Record<string, string> {
  if (approval === undefined) return {};
  if (approval.answer === 'deny') return { 'x-lakka-deny': approval.id };
  return {
    'x-lakka-approve': approval.id,
    ...(approval.answer === 'always' ? { 'x-lakka-approve-scope': 'always' } : {}),
  };
}

/** Which model is answering and why, read from the response headers (CH-2, CH-4). */
export interface ChatDecision {
  requestId: string;
  model: string;
  rule: string;
  route: string | null;
  /** How sure the classifier was, 0 to 1, when it chose. */
  confidence: number | null;
  /** Why the default answered, when it did. */
  reason: string | null;
  fallbackFrom: string | null;
  fallbackScope: string | null;
}

/** A server-side tool call as it finishes (TL-6): its name and outcome, never its content. */
export interface ChatToolActivity {
  callId: string;
  name: string;
  status: 'ok' | 'error' | 'declined' | 'approval_required';
}

/**
 * What a refusal or failure said beyond its code (ADR 0092): which cap and by how much, or
 * which provider and how long to wait, or which model its provider did not know (ADR 0127).
 */
export interface ChatErrorDetails {
  scope?: string;
  remainingMicroUsd?: string;
  requiredMicroUsd?: string | null;
  provider?: string;
  /** A model reference, `provider:model`. */
  model?: string;
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
}

/** A refusal or failure, by the error code the endpoint sent (CH-7). */
export class ChatError extends Error {
  readonly code: string;
  /** False when the request was refused before anything was sent to a model. */
  readonly started: boolean;
  readonly details: ChatErrorDetails;

  constructor(code: string, started: boolean, details: ChatErrorDetails = {}) {
    super(code);
    this.name = 'ChatError';
    this.code = code;
    this.started = started;
    this.details = details;
  }
}

interface OpenAiErrorBody {
  error?: { code?: unknown; type?: unknown };
  lakka?: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The api's details on an error body, read field by field: it is outside input. */
function detailsOf(body: unknown): ChatErrorDetails {
  const raw = (body as OpenAiErrorBody | null)?.lakka;
  if (raw === undefined || raw === null || typeof raw !== 'object') return {};
  const details: ChatErrorDetails = {};
  const scope = text(raw['scope']);
  if (scope !== undefined) details.scope = scope;
  const remaining = text(raw['remaining_micro_usd']);
  if (remaining !== undefined && /^\d+$/.test(remaining)) details.remainingMicroUsd = remaining;
  const required = text(raw['required_micro_usd']);
  if (required !== undefined && /^\d+$/.test(required)) details.requiredMicroUsd = required;
  const provider = text(raw['provider']);
  if (provider !== undefined) details.provider = provider;
  const model = text(raw['model']);
  if (model !== undefined) details.model = model;
  if (typeof raw['rate_limited'] === 'boolean') details.rateLimited = raw['rate_limited'];
  const wait = raw['retry_after_seconds'];
  if (typeof wait === 'number' && Number.isFinite(wait) && wait >= 0) {
    details.retryAfterSeconds = wait;
  }
  return details;
}

/** The most specific code an error body names; "unknown" if it names none. */
function errorCode(body: unknown, status: number): string {
  const error = (body as OpenAiErrorBody | null)?.error;
  if (typeof error?.code === 'string') return error.code;
  if (typeof error?.type === 'string') return error.type;
  return status === 401 ? 'invalid_api_key' : 'unknown';
}

function decisionFrom(headers: Headers): ChatDecision {
  const confidence = Number.parseFloat(headers.get('x-lakka-routing-confidence') ?? '');
  return {
    requestId: headers.get('x-lakka-request-id') ?? '',
    model: headers.get('x-lakka-model') ?? '',
    rule: headers.get('x-lakka-routing-rule') ?? '',
    route: headers.get('x-lakka-route'),
    confidence: Number.isFinite(confidence) ? confidence : null,
    reason: headers.get('x-lakka-routing-reason'),
    fallbackFrom: headers.get('x-lakka-fallback-from'),
    fallbackScope: headers.get('x-lakka-fallback-scope'),
  };
}

const isToolStatus = (value: string): value is ChatToolActivity['status'] =>
  value === 'ok' || value === 'error' || value === 'declined' || value === 'approval_required';

function toolActivityOf(raw: unknown): ChatToolActivity | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const activity = raw as Record<string, unknown>;
  const callId = text(activity['call_id']);
  const name = text(activity['name']);
  const status = text(activity['status']);
  if (callId === undefined || name === undefined || status === undefined) return undefined;
  return isToolStatus(status) ? { callId, name, status } : undefined;
}

/** One server-sent event's data, or undefined when the event carries none. */
function dataOf(event: string): string | undefined {
  const lines = event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * Sends one turn and streams the reply. `onDecision` runs once, when the reply starts; `onText`
 * for every piece of text. Resolves when the reply is complete. Rejects with a ChatError for a
 * refusal or a broken stream, or with the signal's reason when the person stops it.
 */
export async function streamChat(options: {
  workspaceId: string;
  conversationId: string;
  model: string;
  messages: readonly ChatTurn[];
  /** Continues a run that stopped for approval, instead of sending a new message. */
  approval?: ChatApproval;
  signal: AbortSignal;
  onDecision: (decision: ChatDecision) => void;
  onText: (text: string) => void;
  onToolActivity?: (activity: ChatToolActivity) => void;
}): Promise<void> {
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-lakka-workspace': options.workspaceId,
      'x-lakka-conversation': options.conversationId,
      ...approvalHeaders(options.approval),
    },
    body: JSON.stringify({ model: options.model, messages: options.messages, stream: true }),
    signal: options.signal,
  });
  if (!response.ok || response.body === null) {
    const body: unknown = await response.json().catch(() => null);
    throw new ChatError(errorCode(body, response.status), false, detailsOf(body));
  }
  options.onDecision(decisionFrom(response.headers));

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value.replaceAll('\r\n', '\n');
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const data = dataOf(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf('\n\n');
      if (data === undefined) continue;
      if (data === '[DONE]') return;
      const event = JSON.parse(data) as {
        error?: unknown;
        choices?: { delta?: { content?: unknown } }[];
        lakka?: { tool_activity?: unknown };
      };
      if (event.error !== undefined) {
        throw new ChatError(errorCode(event, 502), true, detailsOf(event));
      }
      const activity = toolActivityOf(event.lakka?.tool_activity);
      if (activity !== undefined) options.onToolActivity?.(activity);
      const piece = event.choices?.[0]?.delta?.content;
      if (typeof piece === 'string' && piece !== '') options.onText(piece);
    }
  }
  // The connection closed without [DONE]: what arrived is kept, but the reply is not whole.
  throw new ChatError('stream_interrupted', true);
}
