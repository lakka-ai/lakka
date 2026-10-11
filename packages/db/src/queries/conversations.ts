import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { attachments, conversations, messages } from '../schema/conversations.ts';
import { toolInvocations } from '../schema/mcp.ts';
import { usage } from '../schema/usage.ts';

/*
 * Conversations (RT-7, ADR 0047). Every query is scoped by workspace and by the person who owns
 * the conversation, so one person can never read or steer another's routing state.
 */

export type ConversationRow = typeof conversations.$inferSelect;

export async function insertConversation(
  db: Db,
  row: { workspaceId: string; principalId: string; title?: string; modelChoice?: string | null },
): Promise<ConversationRow> {
  const [inserted] = await db.insert(conversations).values(row).returning();
  if (inserted === undefined) throw new Error('conversation insert returned nothing');
  return inserted;
}

export async function findConversation(
  db: Db,
  workspaceId: string,
  principalId: string,
  id: string,
): Promise<ConversationRow | undefined> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.principalId, principalId),
        eq(conversations.id, id),
      ),
    );
  return row;
}

/**
 * Stores the conversation's routing decision if it has none yet. Two first messages racing each
 * other both resolve, but only the first to write is kept; returns whether this one was.
 */
export async function rememberConversationRoute(
  db: Db,
  workspaceId: string,
  id: string,
  decision: { routeId: string | null; model: string },
): Promise<boolean> {
  const updated = await db
    .update(conversations)
    .set({
      routeId: decision.routeId,
      routedModel: decision.model,
      routeDecidedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.id, id),
        isNull(conversations.routedModel),
      ),
    )
    .returning({ id: conversations.id });
  return updated.length > 0;
}

/** Forgets the conversation's routing decision, after an override (tech spec, Capturing overrides). */
export async function clearConversationRoute(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ routeId: null, routedModel: null, routeDecidedAt: null, updatedAt: sql`now()` })
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, id)));
}

export interface ConversationSummary {
  id: string;
  title: string;
  modelChoice: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const summary = {
  id: conversations.id,
  title: conversations.title,
  modelChoice: conversations.modelChoice,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

const owned = (workspaceId: string, principalId: string, id?: string) =>
  and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.principalId, principalId),
    id === undefined ? undefined : eq(conversations.id, id),
  );

/** A person's conversations in a workspace, most recently active first. */
export async function listConversations(
  db: Db,
  workspaceId: string,
  principalId: string,
  limit: number,
): Promise<ConversationSummary[]> {
  return db
    .select(summary)
    .from(conversations)
    .where(owned(workspaceId, principalId))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

export async function updateConversation(
  db: Db,
  workspaceId: string,
  principalId: string,
  id: string,
  change: { title?: string; modelChoice?: string | null },
): Promise<ConversationSummary | undefined> {
  const [row] = await db
    .update(conversations)
    .set({ ...change, updatedAt: sql`now()` })
    .where(owned(workspaceId, principalId, id))
    .returning(summary);
  return row;
}

/** Deletes a conversation with its messages and attachments. Returns whether there was one. */
export async function deleteConversation(
  db: Db,
  workspaceId: string,
  principalId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(conversations)
    .where(owned(workspaceId, principalId, id))
    .returning({ id: conversations.id });
  return deleted.length > 0;
}

export interface NewAttachment {
  mediaType: string;
  filename: string | null;
  data: Buffer;
}

/**
 * Stores the person's turn with its files, in one transaction, and names the conversation after
 * it if it has no title yet.
 */
export async function insertUserMessage(
  db: Db,
  row: {
    workspaceId: string;
    conversationId: string;
    requestId: string;
    content: string;
    attachments: readonly NewAttachment[];
    title: string;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(messages)
      .values({
        conversationId: row.conversationId,
        workspaceId: row.workspaceId,
        role: 'user',
        content: row.content,
        requestId: row.requestId,
      })
      .returning({ id: messages.id });
    if (message === undefined) throw new Error('message insert returned nothing');
    if (row.attachments.length > 0) {
      await tx.insert(attachments).values(
        row.attachments.map((a, position) => ({
          messageId: message.id,
          workspaceId: row.workspaceId,
          mediaType: a.mediaType,
          filename: a.filename,
          sizeBytes: a.data.length,
          data: a.data,
          position,
        })),
      );
    }
    await tx
      .update(conversations)
      .set({
        updatedAt: sql`now()`,
        title: sql`case when ${conversations.title} = '' then ${row.title} else ${conversations.title} end`,
      })
      .where(
        and(
          eq(conversations.workspaceId, row.workspaceId),
          eq(conversations.id, row.conversationId),
        ),
      );
    return message.id;
  });
}

export async function insertAssistantMessage(
  db: Db,
  row: {
    workspaceId: string;
    conversationId: string;
    requestId: string;
    content: string;
    state: 'complete' | 'interrupted' | 'aborted';
    model: string;
    routingRule: string;
    routeName: string | null;
    routingConfidence?: number | null;
    routingReason?: string | null;
    fallbackFrom: string | null;
    fallbackScope?: string | null;
    /** The tool calls the model made in this round, by id and name (ADR 0071). */
    toolCalls?: { callId: string; name: string }[] | null;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(messages).values({ ...row, role: 'assistant' });
    await tx
      .update(conversations)
      .set({ updatedAt: sql`now()` })
      .where(
        and(
          eq(conversations.workspaceId, row.workspaceId),
          eq(conversations.id, row.conversationId),
        ),
      );
  });
}

/** One tool call's result, kept as part of the conversation (ADR 0071). */
export async function insertToolMessage(
  db: Db,
  row: {
    workspaceId: string;
    conversationId: string;
    requestId: string;
    toolCallId: string;
    toolName: string;
    content: string;
    toolError: boolean;
  },
): Promise<void> {
  await db.insert(messages).values({ ...row, role: 'tool' });
}

export interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  requestId: string;
  state: 'complete' | 'interrupted' | 'aborted';
  model: string | null;
  routingRule: string | null;
  routeName: string | null;
  routingConfidence: number | null;
  routingReason: string | null;
  fallbackFrom: string | null;
  fallbackScope: string | null;
  toolCalls: { callId: string; name: string }[] | null;
  toolCallId: string | null;
  toolName: string | null;
  toolError: boolean | null;
  createdAt: Date;
  attachments: { id: string; mediaType: string; filename: string | null; sizeBytes: number }[];
}

/** A conversation's messages in order, with their attachments described but not loaded. */
export async function listMessages(
  db: Db,
  workspaceId: string,
  conversationId: string,
): Promise<MessageRow[]> {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      requestId: messages.requestId,
      state: messages.state,
      model: messages.model,
      routingRule: messages.routingRule,
      routeName: messages.routeName,
      routingConfidence: messages.routingConfidence,
      routingReason: messages.routingReason,
      fallbackFrom: messages.fallbackFrom,
      fallbackScope: messages.fallbackScope,
      toolCalls: messages.toolCalls,
      toolCallId: messages.toolCallId,
      toolName: messages.toolName,
      toolError: messages.toolError,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const files =
    rows.length === 0
      ? []
      : await db
          .select({
            id: attachments.id,
            messageId: attachments.messageId,
            mediaType: attachments.mediaType,
            filename: attachments.filename,
            sizeBytes: attachments.sizeBytes,
          })
          .from(attachments)
          .where(
            and(
              eq(attachments.workspaceId, workspaceId),
              inArray(
                attachments.messageId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(attachments.position));
  const byMessage = Map.groupBy(files, (f) => f.messageId);
  return rows.map((r) => ({
    ...r,
    attachments: (byMessage.get(r.id) ?? []).map((f) => ({
      id: f.id,
      mediaType: f.mediaType,
      filename: f.filename,
      sizeBytes: f.sizeBytes,
    })),
  }));
}

/** One attachment's bytes, if it belongs to the person's conversation in this workspace. */
export async function findAttachment(
  db: Db,
  workspaceId: string,
  principalId: string,
  conversationId: string,
  attachmentId: string,
): Promise<{ mediaType: string; filename: string | null; data: Buffer } | undefined> {
  const [row] = await db
    .select({
      mediaType: attachments.mediaType,
      filename: attachments.filename,
      data: attachments.data,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(attachments.workspaceId, workspaceId),
        eq(attachments.id, attachmentId),
        owned(workspaceId, principalId, conversationId),
      ),
    );
  return row;
}

/**
 * Several of a conversation's files at once, for a request that refers to them by id (ADR 0062).
 * Only files of the owner's conversation are found; any other id is simply missing.
 */
export async function findAttachments(
  db: Db,
  workspaceId: string,
  principalId: string,
  conversationId: string,
  attachmentIds: readonly string[],
): Promise<{ id: string; mediaType: string; filename: string | null; data: Buffer }[]> {
  if (attachmentIds.length === 0) return [];
  return db
    .select({
      id: attachments.id,
      mediaType: attachments.mediaType,
      filename: attachments.filename,
      data: attachments.data,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(attachments.workspaceId, workspaceId),
        inArray(attachments.id, [...attachmentIds]),
        owned(workspaceId, principalId, conversationId),
      ),
    );
}

/**
 * What each request cost, for the replies in a conversation (CH-4): the sum of its usage
 * records, as micro-USD in a decimal string. A request with no usage, or whose records retention
 * has removed, is absent.
 */
export async function requestCosts(
  db: Db,
  workspaceId: string,
  requestIds: readonly string[],
): Promise<Map<string, string>> {
  if (requestIds.length === 0) return new Map();
  const rows = await db
    .select({
      requestId: usage.requestId,
      cost: sql<string>`sum(${usage.costMicroUsd})::text`,
    })
    .from(usage)
    .where(and(eq(usage.workspaceId, workspaceId), inArray(usage.requestId, [...requestIds])))
    .groupBy(usage.requestId);
  return new Map(rows.map((r) => [r.requestId, r.cost]));
}

export interface ToolUseRow {
  requestId: string;
  callId: string;
  toolName: string;
  arguments: unknown;
  status: string;
  durationMs: number;
  /** Whether the person was asked first: the call waited for an approval before it ran. */
  asked: boolean;
}

/**
 * The tool calls made in a conversation, from the audit (TL-6), each call's last outcome, by
 * call id. A call that waited for approval ran in a later request, which continued the first,
 * so calls are matched by id within the conversation, not by request. Arguments are stored
 * there, capped, and nowhere else (invariant 9, ADR 0066); the conversation's owner may read
 * their own.
 */
export async function toolUses(
  db: Db,
  workspaceId: string,
  conversationId: string,
): Promise<ToolUseRow[]> {
  const rows = await db
    .select({
      requestId: toolInvocations.requestId,
      callId: toolInvocations.callId,
      toolName: toolInvocations.toolName,
      arguments: toolInvocations.arguments,
      status: toolInvocations.status,
      durationMs: toolInvocations.durationMs,
    })
    .from(toolInvocations)
    .where(
      and(
        eq(toolInvocations.workspaceId, workspaceId),
        eq(toolInvocations.conversationId, conversationId),
      ),
    )
    .orderBy(asc(toolInvocations.createdAt), asc(toolInvocations.id));
  const byCall = Map.groupBy(rows, (r) => r.callId);
  return [...byCall.values()].flatMap((calls) => {
    const last = calls.at(-1);
    if (last === undefined) return [];
    return [{ ...last, asked: calls.some((c) => c.status === 'approval_required') }];
  });
}
