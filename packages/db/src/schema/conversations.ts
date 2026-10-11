import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.ts';
import { principals, workspaces } from './identity.ts';
import { routes } from './routing.ts';

/*
 * Conversations (tech spec, Data model: Conversations; RT-7, CH-1; ADR 0047, ADR 0060). A
 * conversation keeps the one routing decision its later messages share, its title, the model its
 * owner picked for it, and its history: messages and their attachments, stored because the user
 * asked the product to keep them (CLAUDE.md invariant 9, ADR 0057).
 *
 * A conversation belongs to a person, never to a key: a key acts for its owner (invariant 2), so
 * a conversation started through a key is the owner's. The routed model is kept even when its
 * route is deleted, since switching models mid-conversation throws away the provider's prompt
 * cache (ADR 0046).
 */

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    principalId: uuid('principal_id').notNull(),
    principalKind: text('principal_kind').generatedAlwaysAs(sql`'user'`),
    /** The route that decided, or null for a considered "not sure" or a deleted route. */
    routeId: uuid('route_id').references(() => routes.id, { onDelete: 'set null' }),
    /** The model the conversation keeps; null until something decided. */
    routedModel: text('routed_model'),
    routeDecidedAt: timestamp('route_decided_at', { withTimezone: true }),
    /** Empty until named; the first message then gives it one. */
    title: text('title').notNull().default(''),
    /** What the owner picked for it (a model or "route/<name>"); null leaves it to routing. */
    modelChoice: text('model_choice'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversations_workspace_principal_idx').on(t.workspaceId, t.principalId),
    foreignKey({
      name: 'conversations_principal_is_user_fkey',
      columns: [t.principalId, t.principalKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('conversations_title_check', sql`char_length(${t.title}) <= 200`),
    check(
      'conversations_decision_check',
      sql`(${t.routedModel} is null) = (${t.routeDecidedAt} is null)
        and (${t.routeId} is null or ${t.routedModel} is not null)`,
    ),
  ],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const MESSAGE_ROLES = ['user', 'assistant', 'tool'] as const;
export const MESSAGE_STATES = ['complete', 'interrupted', 'aborted'] as const;

/**
 * One turn of a conversation (CH-1): what the person asked, or what the model answered. A reply
 * that ended early keeps what arrived, marked interrupted or aborted. The routing decision and
 * the model that answered are kept with the reply, so the history can say why (CH-2).
 *
 * A reply that called tools is kept round by round (ADR 0071): an assistant message with the
 * calls it made, by id and name, then a `tool` message with each result. The calls' arguments are
 * not repeated here; they are in tool_invocations, the one place they are stored (invariant 9).
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    role: text('role', { enum: MESSAGE_ROLES }).notNull(),
    content: text('content').notNull(),
    /** The request this turn belongs to, which links it to usage and traces. */
    requestId: uuid('request_id').notNull(),
    state: text('state', { enum: MESSAGE_STATES }).notNull().default('complete'),
    /** For a reply: the model that answered, and why it was chosen. */
    model: text('model'),
    routingRule: text('routing_rule'),
    routeName: text('route_name'),
    /** How sure the classifier was, 0 to 1, when it chose the route (CH-2). */
    routingConfidence: real('routing_confidence'),
    /** Why the request fell to the workspace default, when it did (RT-6). */
    routingReason: text('routing_reason'),
    fallbackFrom: text('fallback_from'),
    /** Which cap sent the reply to a cheaper model (CH-4). */
    fallbackScope: text('fallback_scope'),
    /** For an assistant message: the tool calls the model made in this round. */
    toolCalls: jsonb('tool_calls').$type<{ callId: string; name: string }[]>(),
    /** For a tool message: the call it answers, the tool, and whether the call failed. */
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),
    toolError: boolean('tool_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    // Usage and traces name a request; this finds its turn (route candidates, ADR 0114).
    index('messages_request_idx').on(t.requestId),
    check('messages_role_check', sql`${t.role} in ('user', 'assistant', 'tool')`),
    check(
      'messages_tool_check',
      sql`(${t.role} = 'tool') = (${t.toolCallId} is not null and ${t.toolName} is not null)
        and (${t.toolCalls} is null or ${t.role} = 'assistant')`,
    ),
    check('messages_state_check', sql`${t.state} in ('complete', 'interrupted', 'aborted')`),
    check(
      'messages_routing_confidence_check',
      sql`${t.routingConfidence} is null or ${t.routingConfidence} between 0 and 1`,
    ),
  ],
);

/** A file sent with a message (CH-5, Q2), kept so later turns can send it again. */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    mediaType: text('media_type').notNull(),
    filename: text('filename'),
    sizeBytes: integer('size_bytes').notNull(),
    data: bytea('data').notNull(),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    check('attachments_size_check', sql`${t.sizeBytes} > 0 and ${t.sizeBytes} <= 10485760`),
  ],
);

export const CANDIDATE_DECISIONS = ['added', 'dismissed'] as const;

/**
 * What an admin did with a route example candidate (RT-10, ADR 0114): a message a conversation
 * was routed on, offered because the person then chose another model. Candidates are derived when
 * read, from usage, messages and captured content, and never copied; this keeps only the decision,
 * with no text, so a candidate added or dismissed is not offered again. It goes with its message,
 * so deleting the conversation, the person or the recorded history leaves nothing behind.
 */
export const routeCandidateDecisions = pgTable(
  'route_candidate_decisions',
  {
    messageId: uuid('message_id')
      .primaryKey()
      .references(() => messages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    decision: text('decision', { enum: CANDIDATE_DECISIONS }).notNull(),
    /** For an addition: the route the example went to, while it exists. */
    routeId: uuid('route_id').references(() => routes.id, { onDelete: 'set null' }),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => principals.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('route_candidate_decisions_workspace_idx').on(t.workspaceId),
    check('route_candidate_decisions_decision_check', sql`${t.decision} in ('added', 'dismissed')`),
  ],
);
