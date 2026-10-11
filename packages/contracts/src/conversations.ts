import { z } from 'zod';
import type { BudgetScope } from './budgets.ts';
import type { DefaultReason } from './routing.ts';

/*
 * Conversations and their history (CH-1, CH-2, CH-3, ADR 0060). A person sees only their own
 * conversations. The model choice is what they picked for the conversation: a model reference or
 * "route/<name>"; null leaves it to routing.
 */

export const conversationParams = z.object({ workspaceId: z.uuid(), conversationId: z.uuid() });
export const attachmentParams = conversationParams.extend({ attachmentId: z.uuid() });

export const newConversationBody = z
  .object({
    title: z.string().trim().max(200).optional(),
    modelChoice: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();
export type NewConversationBody = z.infer<typeof newConversationBody>;

export const conversationChangeBody = z
  .object({
    title: z.string().trim().max(200).optional(),
    modelChoice: z.string().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((b) => b.title !== undefined || b.modelChoice !== undefined, 'nothing to change');
export type ConversationChangeBody = z.infer<typeof conversationChangeBody>;

export interface ConversationSummaryView {
  id: string;
  title: string;
  modelChoice: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentView {
  id: string;
  mediaType: string;
  filename: string | null;
  sizeBytes: number;
}

export interface MessageView {
  id: string;
  /** A tool message is one tool call's result, in a reply that called tools (ADR 0071). */
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** The request that wrote it, as the x-lakka-request-id header names it. */
  requestId: string;
  /** A reply that ended early keeps what arrived. */
  state: 'complete' | 'interrupted' | 'aborted';
  /** For a reply: the model that answered, and why (CH-2). */
  model: string | null;
  /** The model's name for people. */
  modelName: string | null;
  routingRule: string | null;
  routeName: string | null;
  /** How sure the classifier was, 0 to 1, when it chose the route. */
  routingConfidence: number | null;
  /** Why the request fell to the workspace default, when it did. */
  routingReason: DefaultReason | null;
  /** Set when a budget sent the reply to a cheaper model (CH-4), with the cap that did. */
  fallbackFrom: string | null;
  fallbackFromName: string | null;
  fallbackScope: BudgetScope | null;
  /**
   * What the request cost, in micro-USD as a decimal string, on its last reply only: a reply
   * that called tools is several messages of one request. Null while unknown or after retention.
   */
  costMicroUsd: string | null;
  /** For a reply: the tools it called in this round, by call id and name. */
  toolCalls: { callId: string; name: string }[] | null;
  /** For a reply that called tools: what each call did, from the audit (TL-6). */
  tools: ToolUseView[] | null;
  /** For a tool message: the call it answers, the tool, and whether its call failed. */
  toolCallId: string | null;
  toolName: string | null;
  toolError: boolean | null;
  createdAt: string;
  attachments: AttachmentView[];
}

/** One tool call in a reply, as the audit recorded it (TL-6). */
export interface ToolUseView {
  callId: string;
  /** What the model calls the tool: <server>__<tool>. */
  name: string;
  /** The arguments as stored for the audit, capped. */
  arguments: unknown;
  status: 'ok' | 'rejected' | 'denied' | 'approval_required' | 'failed' | 'timeout';
  durationMs: number;
  /** Whether the person was asked before it ran; false when the tool does not ask first. */
  asked: boolean;
}

/** A tool call the conversation is waiting on, for the person to approve or deny (TL-4, H5). */
export interface PendingApprovalView {
  id: string;
  /** What the model calls the tool: <server>__<tool>. */
  tool: string;
  title: string | null;
  arguments: Record<string, unknown>;
  /** Whether the caller made the call, and so may answer it; a key's calls are its own (AC 18). */
  yours: boolean;
  /** The API key that made the call, when a key did: it can be answered only there. */
  keyName: string | null;
  createdAt: string;
}

export interface ConversationView extends ConversationSummaryView {
  messages: MessageView[];
  pendingApproval: PendingApprovalView | null;
}
