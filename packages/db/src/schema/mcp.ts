import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { encryptedText } from '../crypto.ts';
import { uuidv7 } from '../uuid.ts';
import { principals, workspaces } from './identity.ts';

/*
 * MCP servers a workspace's tools come from, and the credentials Lakka uses with them (TL-1,
 * TL-2, ADR 0066, ADR 0067).
 *
 * A stdio server runs a command inside the api container; a Streamable HTTP server is reached at
 * a URL. `allow_private` records, when the server is saved, whether its URL may resolve to a
 * private address: only for an instance admin's server or an origin the operator listed. Every
 * connection to any other server is checked against private addresses, so a DNS change cannot
 * turn it into a way into the customer's network.
 */

export const MCP_TRANSPORTS = ['stdio', 'streamable_http'] as const;
export const MCP_AUTH_MODES = ['none', 'shared', 'oauth'] as const;
export const MCP_TEST_STATUSES = [
  'ok',
  'auth_failed',
  'unreachable',
  'not_allowed',
  'error',
] as const;

export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** Unique in the workspace; the model sees tools as <name>__<tool> (H1). */
    name: text('name').notNull(),
    /** What people see, such as "GitHub"; null for one made from the name (ADR 0096). */
    displayName: text('display_name'),
    transport: text('transport', { enum: MCP_TRANSPORTS }).notNull(),
    url: text('url'),
    command: text('command'),
    args: jsonb('args').$type<string[]>().notNull().default([]),
    /** For a stdio server with a shared credential: the environment variable it is passed in. */
    credentialEnv: text('credential_env'),
    authMode: text('auth_mode', { enum: MCP_AUTH_MODES }).notNull(),
    allowPrivate: boolean('allow_private').notNull().default(false),
    /**
     * A server that existed before the origin allowlist (NF-S4, ADR 0117). Its own origin was
     * listed by the upgrade; the origins its OAuth metadata names are listed the first time they
     * are discovered, and then the mark goes. Changing its URL or how it signs in clears it.
     */
    egressGrandfathered: boolean('egress_grandfathered').notNull().default(false),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestStatus: text('last_test_status', { enum: MCP_TEST_STATUSES }),
    /** When its tools were last synced, and why that failed if it did, as our own code. */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    /**
     * For an OAuth server: the client Lakka is registered as with its authorization server,
     * as JSON (client id, and secret if any), and whether dynamic registration or an admin
     * supplied it (ADR 0068). Encrypted, since it can hold a client secret.
     */
    oauthClient: encryptedText('oauth_client', 'mcp_servers.oauth_client'),
    oauthClientSource: text('oauth_client_source', { enum: ['registered', 'admin'] }),
    /** The scopes to ask for; when null, the server's advertised scopes. */
    oauthScope: text('oauth_scope'),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdByKind: text('created_by_kind').generatedAlwaysAs(sql`'user'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('mcp_servers_workspace_name_key').on(t.workspaceId, t.name),
    index('mcp_servers_workspace_id_idx').on(t.workspaceId),
    foreignKey({
      name: 'mcp_servers_created_by_is_user_fkey',
      columns: [t.createdByPrincipalId, t.createdByKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('mcp_servers_name_check', sql`${t.name} ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'`),
    check('mcp_servers_transport_check', sql`${t.transport} in ('stdio', 'streamable_http')`),
    check('mcp_servers_auth_mode_check', sql`${t.authMode} in ('none', 'shared', 'oauth')`),
    check(
      'mcp_servers_target_check',
      sql`case when ${t.transport} = 'stdio'
        then ${t.command} is not null and ${t.url} is null and ${t.authMode} <> 'oauth'
          and (${t.credentialEnv} is not null) = (${t.authMode} = 'shared')
        else ${t.url} is not null and ${t.command} is null and ${t.credentialEnv} is null
          and ${t.args} = '[]'::jsonb end`,
    ),
    check(
      'mcp_servers_credential_env_check',
      sql`${t.credentialEnv} is null or ${t.credentialEnv} ~ '^[A-Z_][A-Z0-9_]{0,63}$'`,
    ),
    check(
      'mcp_servers_oauth_check',
      sql`(${t.authMode} = 'oauth' or (${t.oauthClient} is null and ${t.oauthScope} is null))
        and (${t.oauthClient} is null) = (${t.oauthClientSource} is null)`,
    ),
    check(
      'mcp_servers_test_check',
      sql`(${t.lastTestedAt} is null) = (${t.lastTestStatus} is null)`,
    ),
  ],
);

/**
 * The origins Lakka may reach for MCP servers and their authorization servers, for the whole
 * instance (NF-S4, ADR 0117). Exact origins, lowercase, with no default port: what
 * `normaliseOrigin` in core makes. Instance admins list them; the upgrade that introduced the
 * list seeded it from the servers that existed then (`source = 'upgrade'`).
 */
export const mcpAllowedOrigins = pgTable(
  'mcp_allowed_origins',
  {
    origin: text('origin').primaryKey(),
    source: text('source', { enum: ['admin', 'upgrade'] }).notNull(),
    // Null for the upgrade's rows. People are never deleted, only marked (ADR 0082).
    addedBy: uuid('added_by').references(() => principals.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('mcp_allowed_origins_origin_check', sql`${t.origin} ~ '^https?://[^/]+$'`),
    check('mcp_allowed_origins_source_check', sql`${t.source} in ('admin', 'upgrade')`),
  ],
);

/**
 * One row per server for its shared credential, set by an admin, or per person for their own
 * (TL-2). `principal_id` is the person whose credential it is: for a shared one, the admin who
 * set it, which is what `tool_invocations.credential_principal_id` records for calls made with it.
 */
export const mcpCredentials = pgTable(
  'mcp_credentials',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    mcpServerId: uuid('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    principalId: uuid('principal_id').notNull(),
    principalKind: text('principal_kind').generatedAlwaysAs(sql`'user'`),
    kind: text('kind', { enum: ['shared', 'user'] }).notNull(),
    secret: encryptedText('secret', 'mcp_credentials.secret').notNull(),
    refreshSecret: encryptedText('refresh_secret', 'mcp_credentials.refresh_secret'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'mcp_credentials_principal_is_user_fkey',
      columns: [t.principalId, t.principalKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('mcp_credentials_kind_check', sql`${t.kind} in ('shared', 'user')`),
    uniqueIndex('mcp_credentials_shared_key')
      .on(t.mcpServerId)
      .where(sql`${t.kind} = 'shared'`),
    uniqueIndex('mcp_credentials_user_key')
      .on(t.mcpServerId, t.principalId)
      .where(sql`${t.kind} = 'user'`),
  ],
);

/**
 * An authorization a person has started and not finished (TL-2, ADR 0068): single use, ten
 * minutes at most. Only a hash of the `state` sent to the authorization server is stored, so the
 * table cannot be used to complete someone else's authorization.
 */
export const mcpOauthStates = pgTable(
  'mcp_oauth_states',
  {
    stateHash: text('state_hash').primaryKey(),
    mcpServerId: uuid('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    principalId: uuid('principal_id').notNull(),
    principalKind: text('principal_kind').generatedAlwaysAs(sql`'user'`),
    codeVerifier: encryptedText('code_verifier', 'mcp_oauth_states.code_verifier').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'mcp_oauth_states_principal_is_user_fkey',
      columns: [t.principalId, t.principalKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('mcp_oauth_states_state_hash_check', sql`${t.stateHash} ~ '^[0-9a-f]{64}$'`),
    index('mcp_oauth_states_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * A workspace's tools, as its MCP servers last described them when an admin synced them, with
 * the admin's decisions (TL-3, TL-4, ADR 0069). The model is offered these stored definitions,
 * not whatever the server says later, so a server cannot change a tool's description or schema
 * after an admin enabled it without the admin syncing again.
 */
export const workspaceTools = pgTable(
  'workspace_tools',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    mcpServerId: uuid('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    /** The tool's name on its server. */
    name: text('name').notNull(),
    title: text('title'),
    description: text('description'),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull(),
    annotations: jsonb('annotations').$type<Record<string, boolean | null>>().notNull(),
    /** Why the tool cannot be offered, whatever the admin decides; null when it can. */
    unusableReason: text('unusable_reason', { enum: ['schema'] }),
    /** On the allowlist (TL-3). Off until an admin turns it on. */
    enabled: boolean('enabled').notNull().default(false),
    /** Asks the caller before it runs (TL-4). Defaults from the server's hints (H2). */
    approvalRequired: boolean('approval_required').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('workspace_tools_server_name_key').on(t.mcpServerId, t.name),
    index('workspace_tools_workspace_id_idx').on(t.workspaceId),
    check('workspace_tools_unusable_check', sql`${t.unusableReason} is null or not ${t.enabled}`),
    check('workspace_tools_unusable_reason_check', sql`${t.unusableReason} in ('schema')`),
  ],
);

export const TOOL_INVOCATION_STATUSES = [
  'ok',
  'rejected',
  'denied',
  'approval_required',
  'failed',
  'timeout',
] as const;

/**
 * Every tool call a model asked for, whatever happened to it (TL-6, ADR 0070): who asked, what
 * with, what became of it, and whose credential was used. Arguments are stored here, capped, as
 * the audit needs them, and nowhere else (invariant 9, ADR 0066 Q3).
 */
export const toolInvocations = pgTable(
  'tool_invocations',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    requestId: uuid('request_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** The principal that made the request: a person, or a key. */
    principalId: uuid('principal_id').notNull(),
    /** The person it acted as: the principal, or the key's owner. */
    actingUserId: uuid('acting_user_id').notNull(),
    conversationId: uuid('conversation_id'),
    /** The model's id for this call, which ties it to the tool result in the conversation. */
    callId: text('call_id').notNull(),
    /** The name the model used, which may be no tool at all. */
    toolName: text('tool_name').notNull(),
    /** The tool it named, when it named one; kept after the tool is removed. */
    workspaceToolId: uuid('workspace_tool_id'),
    mcpServerId: uuid('mcp_server_id'),
    /** Null once erased with the person who made the call (NF-P4, ADR 0082). */
    arguments: jsonb('arguments').$type<unknown>(),
    status: text('status', { enum: TOOL_INVOCATION_STATUSES }).notNull(),
    /** Which check refused it, or how it failed; null when it succeeded. */
    reason: text('reason'),
    /** Whose credential was used: a person's own, the admin who set a shared one, or none. */
    credentialPrincipalId: uuid('credential_principal_id'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tool_invocations_workspace_created_idx').on(t.workspaceId, t.createdAt),
    index('tool_invocations_request_id_idx').on(t.requestId),
    // Chat reads a conversation's calls back, to show what each did (TL-6).
    index('tool_invocations_conversation_idx').on(t.conversationId),
    check(
      'tool_invocations_status_check',
      sql`${t.status} in ('ok', 'rejected', 'denied', 'approval_required', 'failed', 'timeout')`,
    ),
  ],
);

/**
 * A tool call waiting for its caller's approval (TL-4, AC 18, ADR 0071). The run that asked
 * ended there; a continuation from the same principal approves or denies it. The call's
 * arguments are in its tool_invocations row, which this points to.
 */
export const toolApprovals = pgTable(
  'tool_approvals',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    conversationId: uuid('conversation_id').notNull(),
    requestId: uuid('request_id').notNull(),
    /** Who made the call, and so who alone may approve it. */
    principalId: uuid('principal_id').notNull(),
    toolInvocationId: uuid('tool_invocation_id').notNull(),
    workspaceToolId: uuid('workspace_tool_id').notNull(),
    toolName: text('tool_name').notNull(),
    callId: text('call_id').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'expired'] })
      .notNull()
      .default('pending'),
    decidedByPrincipalId: uuid('decided_by_principal_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /**
     * The request that carried the answer and ran what the first one paused, so its trace is
     * read as one with the first (OB-1, ADR 0095). Null while pending or when expired.
     */
    continuedByRequestId: uuid('continued_by_request_id'),
    /** An approval given for always, which also left a standing grant (TL-5). */
    always: boolean('always').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tool_approvals_continued_idx').on(t.continuedByRequestId),
    // A run stops at the first call it needs an answer for, so a conversation waits on one.
    uniqueIndex('tool_approvals_pending_key')
      .on(t.conversationId)
      .where(sql`${t.status} = 'pending'`),
    index('tool_approvals_workspace_idx').on(t.workspaceId),
    check(
      'tool_approvals_status_check',
      sql`${t.status} in ('pending', 'approved', 'denied', 'expired')`,
    ),
    check(
      'tool_approvals_decided_check',
      sql`(${t.status} in ('approved', 'denied')) = (${t.decidedAt} is not null)`,
    ),
  ],
);

/**
 * A standing approval (TL-5, ADR 0071): this principal's calls to this tool run without asking
 * each time, until the principal or an admin revokes it. Kept after revoking, so "why did this
 * run without asking?" always has an answer.
 */
export const toolGrants = pgTable(
  'tool_grants',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    principalId: uuid('principal_id').notNull(),
    workspaceToolId: uuid('workspace_tool_id')
      .notNull()
      .references(() => workspaceTools.id, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByPrincipalId: uuid('revoked_by_principal_id'),
  },
  (t) => [
    uniqueIndex('tool_grants_active_key')
      .on(t.principalId, t.workspaceToolId)
      .where(sql`${t.revokedAt} is null`),
    index('tool_grants_workspace_idx').on(t.workspaceId),
    check(
      'tool_grants_revoked_check',
      sql`(${t.revokedAt} is null) = (${t.revokedByPrincipalId} is null)`,
    ),
  ],
);
