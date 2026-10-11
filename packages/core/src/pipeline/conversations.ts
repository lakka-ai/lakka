import { BUDGET_SCOPES, DEFAULT_REASONS, NotFoundError } from '@lakka/contracts';
import type {
  BudgetScope,
  ConversationChangeBody,
  ConversationSummaryView,
  ConversationView,
  DefaultReason,
  NewConversationBody,
  Principal,
  ToolUseView,
} from '@lakka/contracts';
import {
  deleteConversation,
  findAttachment,
  findAttachments,
  findConversation,
  findPendingToolApproval,
  insertConversation,
  listConversations,
  listMessages,
  requestCosts,
  toolUses,
  updateConversation,
} from '@lakka/db';
import type { ConversationSummary } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import type { CatalogueStore } from '../models/catalogue.ts';
import { modelNames } from '../models/service.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/*
 * Conversations (RT-7, CH-1, CH-3, ADR 0047, ADR 0060). A conversation belongs to the person
 * acting, so one started through a key is its owner's (invariant 2), and only its owner sees it:
 * anyone else, in this workspace or another, is told it does not exist. Its history is written
 * by handleModelRequest; this is the rest: starting, listing, reading, renaming, choosing a
 * model for, and deleting one, and reading back an attachment.
 */

const LIST_LIMIT = 200;

function view(row: ConversationSummary): ConversationSummaryView {
  return {
    id: row.id,
    title: row.title,
    modelChoice: row.modelChoice,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const missing = () => new NotFoundError('conversation not found');

async function authorize(ctx: ServiceContext, principal: Principal, workspaceId: string) {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'models.use');
}

export async function startConversation(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  body: NewConversationBody = {},
): Promise<ConversationSummaryView> {
  await authorize(ctx, principal, workspaceId);
  const row = await insertConversation(ctx.db, {
    workspaceId,
    principalId: principal.actingUserId,
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.modelChoice === undefined ? {} : { modelChoice: body.modelChoice }),
  });
  return view(row);
}

export async function listConversationsFor(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
): Promise<ConversationSummaryView[]> {
  await authorize(ctx, principal, workspaceId);
  return (await listConversations(ctx.db, workspaceId, principal.actingUserId, LIST_LIMIT)).map(
    view,
  );
}

const isReason = (value: string | null): value is DefaultReason =>
  value !== null && (DEFAULT_REASONS as readonly string[]).includes(value);
const isScope = (value: string | null): value is BudgetScope =>
  value !== null && (BUDGET_SCOPES as readonly string[]).includes(value);
const isToolStatus = (value: string): value is ToolUseView['status'] =>
  ['ok', 'rejected', 'denied', 'approval_required', 'failed', 'timeout'].includes(value);

/**
 * A conversation with its history, and what chat shows about each reply (CH-1, CH-2, CH-4):
 * the model's name, how it was chosen, what the request cost (from usage), and what each tool
 * call did (from the audit, TL-6).
 */
export async function getConversation(
  ctx: ServiceContext & { catalogue: CatalogueStore },
  principal: Principal,
  workspaceId: string,
  conversationId: string,
): Promise<ConversationView> {
  await authorize(ctx, principal, workspaceId);
  const row = await findConversation(ctx.db, workspaceId, principal.actingUserId, conversationId);
  if (row === undefined) throw missing();
  const [history, pending] = await Promise.all([
    listMessages(ctx.db, workspaceId, conversationId),
    findPendingToolApproval(ctx.db, workspaceId, conversationId),
  ]);
  const requestIds = [
    ...new Set(history.filter((m) => m.role === 'assistant').map((m) => m.requestId)),
  ];
  const [costs, uses, names] = await Promise.all([
    requestCosts(ctx.db, workspaceId, requestIds),
    toolUses(ctx.db, workspaceId, conversationId),
    modelNames(
      ctx,
      history.flatMap((m) => [m.model, m.fallbackFrom].filter((r): r is string => r !== null)),
    ),
  ]);
  const useOf = new Map(uses.map((u) => [u.callId, u]));
  // A request's cost goes on its last reply, since a reply that called tools spans several.
  const lastReply = new Map(
    history.filter((m) => m.role === 'assistant').map((m) => [m.requestId, m.id]),
  );
  return {
    ...view(row),
    pendingApproval:
      pending === undefined
        ? null
        : {
            id: pending.id,
            tool: pending.toolName,
            title: pending.toolTitle,
            arguments: isObject(pending.arguments) ? pending.arguments : {},
            yours: pending.principalId === principal.id,
            keyName: pending.principalId === principal.id ? null : pending.keyName,
            createdAt: pending.createdAt.toISOString(),
          },
    messages: history.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      requestId: m.requestId,
      state: m.state,
      model: m.model,
      modelName: m.model === null ? null : (names.get(m.model) ?? null),
      routingRule: m.routingRule,
      routeName: m.routeName,
      routingConfidence: m.routingConfidence,
      routingReason: isReason(m.routingReason) ? m.routingReason : null,
      fallbackFrom: m.fallbackFrom,
      fallbackFromName: m.fallbackFrom === null ? null : (names.get(m.fallbackFrom) ?? null),
      fallbackScope: isScope(m.fallbackScope) ? m.fallbackScope : null,
      costMicroUsd:
        m.role === 'assistant' && lastReply.get(m.requestId) === m.id
          ? (costs.get(m.requestId) ?? null)
          : null,
      toolCalls: m.toolCalls,
      // Only calls the audit knows: server-side tools. A client's own tools run elsewhere.
      tools:
        m.toolCalls === null
          ? null
          : m.toolCalls.flatMap((call) => {
              const use = useOf.get(call.callId);
              if (use === undefined) return [];
              return [
                {
                  callId: call.callId,
                  name: call.name,
                  arguments: use.arguments,
                  status: isToolStatus(use.status) ? use.status : 'failed',
                  durationMs: use.durationMs,
                  asked: use.asked,
                },
              ];
            }),
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      toolError: m.toolError,
      createdAt: m.createdAt.toISOString(),
      attachments: m.attachments,
    })),
  };
}

export async function changeConversation(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  conversationId: string,
  change: ConversationChangeBody,
): Promise<ConversationSummaryView> {
  await authorize(ctx, principal, workspaceId);
  const row = await updateConversation(
    ctx.db,
    workspaceId,
    principal.actingUserId,
    conversationId,
    {
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.modelChoice === undefined ? {} : { modelChoice: change.modelChoice }),
    },
  );
  if (row === undefined) throw missing();
  return view(row);
}

export async function removeConversation(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  await authorize(ctx, principal, workspaceId);
  if (!(await deleteConversation(ctx.db, workspaceId, principal.actingUserId, conversationId))) {
    throw missing();
  }
}

export async function getAttachment(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  conversationId: string,
  attachmentId: string,
): Promise<{ mediaType: string; filename: string | null; data: Buffer }> {
  await authorize(ctx, principal, workspaceId);
  const file = await findAttachment(
    ctx.db,
    workspaceId,
    principal.actingUserId,
    conversationId,
    attachmentId,
  );
  if (file === undefined) throw new NotFoundError('attachment not found');
  return file;
}

/** A stored file, as a request that refers to it by id receives it. */
export interface StoredFile {
  mediaType: string;
  filename: string | null;
  data: Buffer;
}

/**
 * Files of one of the caller's conversations, by id, for a request that sends earlier files
 * again by reference rather than by content (CH-5, ADR 0062). Ids that are not files of this
 * conversation are left out of the map; the caller refuses the request over them.
 */
export async function readConversationFiles(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  conversationId: string,
  attachmentIds: readonly string[],
): Promise<Map<string, StoredFile>> {
  await authorize(ctx, principal, workspaceId);
  const rows = await findAttachments(ctx.db, workspaceId, principal.actingUserId, conversationId, [
    ...new Set(attachmentIds),
  ]);
  return new Map(
    rows.map((r) => [r.id, { mediaType: r.mediaType, filename: r.filename, data: r.data }]),
  );
}
