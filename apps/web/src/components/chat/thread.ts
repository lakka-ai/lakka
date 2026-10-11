import type { AttachmentView, MessageView, ToolUseView } from '@lakka/contracts';
import { modelLabel, NOT_SURE_REASONS } from './copy.ts';
import type { ReplyDecision } from './copy.ts';

/*
 * A conversation as chat shows it (CH-1): each turn the person wrote, and each reply. A reply
 * that called tools is stored as several messages of one request: a round that asked for the
 * tools, one tool message per result, and the round that answered (ADR 0071). Chat shows them as
 * one reply, with its tool calls inside it and its cost once.
 */

export interface ToolUse {
  callId: string;
  /** As people read it: server__tool -> server.tool. */
  name: string;
  arguments: unknown;
  status: ToolUseView['status'];
  durationMs: number;
  asked: boolean;
  /** What the tool returned, as the model was given it; null if it never ran. */
  result: string | null;
  failed: boolean;
}

export interface Reply {
  requestId: string;
  model: string | null;
  modelName: string;
  decision: ReplyDecision;
  text: string;
  tools: ToolUse[];
  state: MessageView['state'];
  costMicroUsd: string | null;
}

export type ThreadItem =
  | { kind: 'turn'; id: string; text: string; attachments: AttachmentView[] }
  | { kind: 'reply'; id: string; reply: Reply };

/** A tool as the model knows it, server__tool, as people read it. */
export const toolLabel = (name: string): string => name.replace('__', '.');

/**
 * What the conversation keeps after this reply, for the sticky replies that follow (RT-7): a
 * route a signal or the classifier chose, or a considered "not sure" that went to the default.
 * Only the "not sure" is worth carrying, since a sticky reply with no route cannot say it alone:
 * a deleted route leaves the same no-route sticky reply behind.
 */
function keeps(decision: ReplyDecision, before: string | null): string | null {
  if (decision.rule === 'classified' || decision.rule === 'signal') return null;
  if (
    decision.rule === 'default' &&
    decision.reason !== null &&
    NOT_SURE_REASONS.has(decision.reason)
  ) {
    return decision.reason;
  }
  return before;
}

/** The "not sure" the conversation keeps after these items, for a reply still arriving. */
export function keptReason(items: readonly ThreadItem[]): string | null {
  let kept: string | null = null;
  for (const item of items) if (item.kind === 'reply') kept = keeps(item.reply.decision, kept);
  return kept;
}

export function threadOf(messages: readonly MessageView[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let kept: string | null = null;
  const results = new Map(
    messages
      .filter((m) => m.role === 'tool' && m.toolCallId !== null)
      .map((m) => [m.toolCallId, m]),
  );
  let open: { requestId: string; reply: Reply } | null = null;

  for (const m of messages) {
    if (m.role === 'user') {
      open = null;
      items.push({ kind: 'turn', id: m.id, text: m.content, attachments: m.attachments });
      continue;
    }
    if (m.role === 'tool') continue;
    const tools = (m.tools ?? []).map((use): ToolUse => {
      const result = results.get(use.callId);
      return {
        callId: use.callId,
        name: toolLabel(use.name),
        arguments: use.arguments,
        status: use.status,
        durationMs: use.durationMs,
        asked: use.asked,
        result: result?.content ?? null,
        failed: result?.toolError === true || use.status === 'failed' || use.status === 'timeout',
      };
    });
    if (open !== null && open.requestId === m.requestId) {
      // A later round of the same reply: its words follow, and it answers for the whole.
      const reply = open.reply;
      reply.text = [reply.text, m.content].filter((part) => part !== '').join('\n\n');
      reply.tools.push(...tools);
      reply.state = m.state;
      reply.model = m.model ?? reply.model;
      reply.modelName = m.modelName ?? reply.modelName;
      reply.costMicroUsd = m.costMicroUsd ?? reply.costMicroUsd;
      continue;
    }
    const reply: Reply = {
      requestId: m.requestId,
      model: m.model,
      modelName: m.modelName ?? (m.model === null ? '' : modelLabel(m.model)),
      decision: {
        rule: m.routingRule,
        route: m.routeName,
        confidence: m.routingConfidence,
        reason: m.routingRule === 'sticky' && m.routeName === null ? kept : m.routingReason,
        fallbackFrom: m.fallbackFrom,
        fallbackFromName: m.fallbackFromName,
      },
      text: m.content,
      tools,
      state: m.state,
      costMicroUsd: m.costMicroUsd,
    };
    kept = keeps(reply.decision, kept);
    open = { requestId: m.requestId, reply };
    items.push({ kind: 'reply', id: m.id, reply });
  }
  return items;
}

/** A reply's text, split into prose and fenced code, which chat shows as code blocks. */
export function segmentsOf(text: string): { code: boolean; text: string }[] {
  const segments: { code: boolean; text: string }[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let at = 0;
  for (const match of text.matchAll(fence)) {
    const before = text.slice(at, match.index).trim();
    if (before !== '') segments.push({ code: false, text: before });
    segments.push({ code: true, text: (match[1] ?? '').replace(/\n$/, '') });
    at = match.index + match[0].length;
  }
  const rest = text.slice(at).trim();
  if (rest !== '') segments.push({ code: false, text: rest });
  return segments;
}

/** A tool's arguments as plain lines, "key: value", as the approval and tool boards show them. */
export function argumentLines(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value, null, 2);
  return Object.entries(value as Record<string, unknown>)
    .map(([key, v]) => `${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}
