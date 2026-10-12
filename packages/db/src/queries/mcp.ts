import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { principals, workspaces } from '../schema/identity.ts';
import {
  mcpAllowedOrigins,
  mcpCredentials,
  mcpOauthStates,
  mcpServers,
  toolApprovals,
  toolGrants,
  toolInvocations,
  workspaceTools,
} from '../schema/mcp.ts';

/* MCP servers and their credentials (TL-1, TL-2, ADR 0067), always scoped by workspace. */

export type McpServerRow = typeof mcpServers.$inferSelect & { hasSharedCredential: boolean };

export interface NewMcpServer {
  workspaceId: string;
  name: string;
  displayName?: string | null;
  transport: 'stdio' | 'streamable_http';
  url: string | null;
  command: string | null;
  args: string[];
  credentialEnv: string | null;
  authMode: 'none' | 'shared' | 'oauth';
  allowPrivate: boolean;
  oauthScope?: string | null;
  createdByPrincipalId: string;
}

// Qualified by hand: in the fields of a select from one table, Drizzle writes columns bare, and
// a bare "id" inside this subquery would be the credential's own id, so it would never match.
const hasShared = sql<boolean>`exists (
  select 1 from ${mcpCredentials} c
  where c.mcp_server_id = ${mcpServers}.${sql.identifier(mcpServers.id.name)} and c.kind = 'shared'
)`;

function selectServers(db: Db) {
  return db.select({ server: mcpServers, hasSharedCredential: hasShared }).from(mcpServers);
}

const row = (r: { server: typeof mcpServers.$inferSelect; hasSharedCredential: boolean }) => ({
  ...r.server,
  hasSharedCredential: r.hasSharedCredential,
});

/** Inserts a server; undefined when the workspace already has one of that name. */
export async function insertMcpServer(
  db: Db,
  server: NewMcpServer,
): Promise<McpServerRow | undefined> {
  const [inserted] = await db
    .insert(mcpServers)
    .values(server)
    .onConflictDoNothing({ target: [mcpServers.workspaceId, mcpServers.name] })
    .returning();
  return inserted === undefined ? undefined : { ...inserted, hasSharedCredential: false };
}

export async function listMcpServers(db: Db, workspaceId: string): Promise<McpServerRow[]> {
  const rows = await selectServers(db)
    .where(eq(mcpServers.workspaceId, workspaceId))
    .orderBy(asc(mcpServers.name));
  return rows.map(row);
}

export async function findMcpServer(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<McpServerRow | undefined> {
  const [found] = await selectServers(db).where(
    and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)),
  );
  return found === undefined ? undefined : row(found);
}

/** Changes a server; undefined when it does not exist here, 'name_taken' on a name clash. */
export async function updateMcpServer(
  db: Db,
  workspaceId: string,
  id: string,
  change: Partial<
    Omit<NewMcpServer, 'workspaceId' | 'transport' | 'createdByPrincipalId'> & {
      oauthClient: string | null;
      oauthClientSource: 'registered' | 'admin' | null;
      egressGrandfathered: false;
    }
  >,
): Promise<McpServerRow | 'name_taken' | undefined> {
  try {
    const updated = await db.transaction(async (tx) => {
      const [changed] = await tx
        .update(mcpServers)
        .set({ ...change, updatedAt: new Date() })
        .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)))
        .returning({ id: mcpServers.id });
      // A server's name is part of its tools' names in the snapshot.
      if (changed !== undefined) await bumpPolicyVersion(tx, workspaceId);
      return changed;
    });
    return updated === undefined ? undefined : findMcpServer(db, workspaceId, id);
  } catch (error) {
    if ((error as { code?: unknown }).code === '23505') return 'name_taken';
    throw error;
  }
}

/** Deletes a server and, with it, every credential for it. */
export async function deleteMcpServer(db: Db, workspaceId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)))
      .returning({ id: mcpServers.id });
    // Its tools went with it, out of the snapshot too.
    if (deleted.length > 0) await bumpPolicyVersion(tx, workspaceId);
    return deleted.length > 0;
  });
}

export async function recordMcpServerTest(
  db: Db,
  workspaceId: string,
  id: string,
  status: 'ok' | 'auth_failed' | 'unreachable' | 'not_allowed' | 'error',
): Promise<void> {
  await db
    .update(mcpServers)
    .set({ lastTestedAt: new Date(), lastTestStatus: status })
    .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
}

/** Records a sync of the server's tools: when, and what went wrong if anything did. */
export async function recordMcpServerSync(
  db: Db,
  workspaceId: string,
  id: string,
  error: string | null,
): Promise<void> {
  await db
    .update(mcpServers)
    .set({ lastSyncedAt: new Date(), lastSyncError: error })
    .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
}

/**
 * Lists the origins a grandfathered server's OAuth metadata named, and takes the mark off it, in
 * one transaction (NF-S4, ADR 0117): an origin an instance admin removes later stays removed.
 */
export async function listGrandfatheredOrigins(
  db: Db,
  workspaceId: string,
  serverId: string,
  origins: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [server] = await tx
      .update(mcpServers)
      .set({ egressGrandfathered: false })
      .where(
        and(
          eq(mcpServers.workspaceId, workspaceId),
          eq(mcpServers.id, serverId),
          eq(mcpServers.egressGrandfathered, true),
        ),
      )
      .returning({ id: mcpServers.id });
    // Another request got here first, or the server changed: nothing to list.
    if (server === undefined || origins.length === 0) return;
    await tx
      .insert(mcpAllowedOrigins)
      .values(origins.map((origin) => ({ origin, source: 'upgrade' as const })))
      .onConflictDoNothing();
  });
}

/*
 * The instance's allowlist of MCP origins (NF-S4, ADR 0117). Instance configuration, like the
 * retention settings, so these queries are not scoped to a workspace: they are read when
 * connecting to any workspace's server, and changed only by instance admins.
 */

export interface McpAllowedOriginRow {
  origin: string;
  source: 'admin' | 'upgrade';
  addedByName: string | null;
  createdAt: Date;
}

/** Every listed origin, for connecting. */
export async function listMcpAllowedOrigins(db: Db): Promise<string[]> {
  const rows = await db
    .select({ origin: mcpAllowedOrigins.origin })
    .from(mcpAllowedOrigins)
    .orderBy(asc(mcpAllowedOrigins.origin));
  return rows.map((r) => r.origin);
}

/** Every listed origin with who listed it, for the admin page. */
export async function listMcpAllowedOriginRows(db: Db): Promise<McpAllowedOriginRow[]> {
  return db
    .select({
      origin: mcpAllowedOrigins.origin,
      source: mcpAllowedOrigins.source,
      addedByName: principals.displayName,
      createdAt: mcpAllowedOrigins.createdAt,
    })
    .from(mcpAllowedOrigins)
    .leftJoin(principals, eq(principals.id, mcpAllowedOrigins.addedBy))
    .orderBy(asc(mcpAllowedOrigins.origin));
}

export async function countMcpAllowedOrigins(db: Db): Promise<number> {
  const [counted] = await db.select({ n: sql<number>`count(*)::int` }).from(mcpAllowedOrigins);
  return counted?.n ?? 0;
}

/** Lists an origin; false when it was listed already. */
export async function insertMcpAllowedOrigin(
  db: Db,
  origin: string,
  addedBy: string,
): Promise<boolean> {
  const inserted = await db
    .insert(mcpAllowedOrigins)
    .values({ origin, source: 'admin', addedBy })
    .onConflictDoNothing()
    .returning({ origin: mcpAllowedOrigins.origin });
  return inserted.length > 0;
}

/** Takes an origin off the list; false when it was not on it. */
export async function deleteMcpAllowedOrigin(db: Db, origin: string): Promise<boolean> {
  const deleted = await db
    .delete(mcpAllowedOrigins)
    .where(eq(mcpAllowedOrigins.origin, origin))
    .returning({ origin: mcpAllowedOrigins.origin });
  return deleted.length > 0;
}

/**
 * Sets the server's shared credential, replacing any, as the admin who set it. False when the
 * server does not exist in this workspace.
 */
export async function setSharedMcpCredential(
  db: Db,
  workspaceId: string,
  serverId: string,
  principalId: string,
  secret: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [server] = await tx
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, serverId)))
      .for('update');
    if (server === undefined) return false;
    await tx
      .delete(mcpCredentials)
      .where(and(eq(mcpCredentials.mcpServerId, serverId), eq(mcpCredentials.kind, 'shared')));
    await tx
      .insert(mcpCredentials)
      .values({ mcpServerId: serverId, principalId, kind: 'shared', secret });
    return true;
  });
}

export async function deleteSharedMcpCredential(
  db: Db,
  workspaceId: string,
  serverId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(mcpCredentials)
    .where(
      and(
        eq(mcpCredentials.mcpServerId, serverId),
        eq(mcpCredentials.kind, 'shared'),
        sql`exists (select 1 from ${mcpServers} where ${mcpServers.id} = ${serverId}
          and ${mcpServers.workspaceId} = ${workspaceId})`,
      ),
    )
    .returning({ id: mcpCredentials.id });
  return deleted.length > 0;
}

/** The server's shared credential and whose it is, for connecting; undefined if none is set. */
export async function findSharedMcpCredential(
  db: Db,
  workspaceId: string,
  serverId: string,
): Promise<{ secret: string; principalId: string } | undefined> {
  const [found] = await db
    .select({ secret: mcpCredentials.secret, principalId: mcpCredentials.principalId })
    .from(mcpCredentials)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpCredentials.mcpServerId))
    .where(
      and(
        eq(mcpServers.workspaceId, workspaceId),
        eq(mcpCredentials.mcpServerId, serverId),
        eq(mcpCredentials.kind, 'shared'),
      ),
    );
  return found;
}

/** Sets how Lakka is registered with an OAuth server's authorization server (ADR 0068). */
export async function setMcpOAuthClient(
  db: Db,
  workspaceId: string,
  serverId: string,
  client: string | null,
  source: 'registered' | 'admin' | null,
): Promise<boolean> {
  const updated = await db
    .update(mcpServers)
    .set({ oauthClient: client, oauthClientSource: source, updatedAt: new Date() })
    .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, serverId)))
    .returning({ id: mcpServers.id });
  return updated.length > 0;
}

/** Records an authorization in progress, clearing any that expired. */
export async function insertMcpOAuthState(
  db: Db,
  state: {
    stateHash: string;
    mcpServerId: string;
    workspaceId: string;
    principalId: string;
    codeVerifier: string;
    expiresAt: Date;
  },
): Promise<void> {
  await db.delete(mcpOauthStates).where(lt(mcpOauthStates.expiresAt, new Date()));
  await db.insert(mcpOauthStates).values(state);
}

/** Takes an unexpired authorization in progress, once: it is deleted as it is read. */
export async function takeMcpOAuthState(
  db: Db,
  stateHash: string,
): Promise<
  | { mcpServerId: string; workspaceId: string; principalId: string; codeVerifier: string }
  | undefined
> {
  const [taken] = await db
    .delete(mcpOauthStates)
    .where(and(eq(mcpOauthStates.stateHash, stateHash), gt(mcpOauthStates.expiresAt, new Date())))
    .returning({
      mcpServerId: mcpOauthStates.mcpServerId,
      workspaceId: mcpOauthStates.workspaceId,
      principalId: mcpOauthStates.principalId,
      codeVerifier: mcpOauthStates.codeVerifier,
    });
  return taken;
}

export interface UserMcpCredential {
  id: string;
  secret: string;
  refreshSecret: string | null;
  expiresAt: Date | null;
}

const userCredentialColumns = {
  id: mcpCredentials.id,
  secret: mcpCredentials.secret,
  refreshSecret: mcpCredentials.refreshSecret,
  expiresAt: mcpCredentials.expiresAt,
};

const inWorkspace = (workspaceId: string) => sql`exists (
  select 1 from ${mcpServers}
  where ${mcpServers.id} = ${mcpCredentials.mcpServerId} and ${mcpServers.workspaceId} = ${workspaceId}
)`;

/** A person's own credential for a server (TL-2). */
export async function findUserMcpCredential(
  db: Db,
  workspaceId: string,
  serverId: string,
  principalId: string,
): Promise<UserMcpCredential | undefined> {
  const [found] = await db
    .select(userCredentialColumns)
    .from(mcpCredentials)
    .where(
      and(
        eq(mcpCredentials.mcpServerId, serverId),
        eq(mcpCredentials.principalId, principalId),
        eq(mcpCredentials.kind, 'user'),
        inWorkspace(workspaceId),
      ),
    );
  return found;
}

/** Stores a person's credential for a server, replacing theirs. */
export async function saveUserMcpCredential(
  db: Db,
  serverId: string,
  principalId: string,
  tokens: { secret: string; refreshSecret: string | null; expiresAt: Date | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(mcpCredentials)
      .where(
        and(
          eq(mcpCredentials.mcpServerId, serverId),
          eq(mcpCredentials.principalId, principalId),
          eq(mcpCredentials.kind, 'user'),
        ),
      );
    await tx
      .insert(mcpCredentials)
      .values({ mcpServerId: serverId, principalId, kind: 'user', ...tokens });
  });
}

/**
 * Runs `refresh` with the credential locked, so two requests never spend the same refresh token;
 * the second sees what the first stored. `refresh` returns new tokens, or null to delete the
 * credential. Resolves to what is stored afterwards.
 */
export async function refreshUserMcpCredential(
  db: Db,
  credentialId: string,
  refresh: (
    current: UserMcpCredential,
  ) => Promise<
    { secret: string; refreshSecret: string | null; expiresAt: Date | null } | null | 'keep'
  >,
): Promise<UserMcpCredential | undefined> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(userCredentialColumns)
      .from(mcpCredentials)
      .where(eq(mcpCredentials.id, credentialId))
      .for('update');
    if (current === undefined) return undefined;
    const next = await refresh(current);
    if (next === 'keep') return current;
    if (next === null) {
      await tx.delete(mcpCredentials).where(eq(mcpCredentials.id, credentialId));
      return undefined;
    }
    await tx
      .update(mcpCredentials)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(mcpCredentials.id, credentialId));
    return { id: credentialId, ...next };
  });
}

export async function deleteUserMcpCredential(
  db: Db,
  workspaceId: string,
  serverId: string,
  principalId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(mcpCredentials)
    .where(
      and(
        eq(mcpCredentials.mcpServerId, serverId),
        eq(mcpCredentials.principalId, principalId),
        eq(mcpCredentials.kind, 'user'),
        inWorkspace(workspaceId),
      ),
    )
    .returning({ id: mcpCredentials.id });
  return deleted.length > 0;
}

/** Deletes a person's own credentials for every server in a workspace they are leaving. */
export async function deleteUserMcpCredentialsInWorkspace(
  db: Db,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  await db
    .delete(mcpCredentials)
    .where(
      and(
        eq(mcpCredentials.principalId, principalId),
        eq(mcpCredentials.kind, 'user'),
        inWorkspace(workspaceId),
      ),
    );
}

/**
 * A workspace's servers, how each signs in, and for an OAuth server whether this person has
 * connected to it (TL-2). No address or command: a member reads this too.
 */
export async function listMcpConnections(
  db: Db,
  workspaceId: string,
  principalId: string,
): Promise<
  {
    serverId: string;
    name: string;
    displayName: string | null;
    authMode: 'none' | 'shared' | 'oauth';
    hasSharedCredential: boolean;
    connected: boolean;
    expiresAt: Date | null;
  }[]
> {
  const rows = await db
    .select({
      serverId: mcpServers.id,
      name: mcpServers.name,
      displayName: mcpServers.displayName,
      authMode: mcpServers.authMode,
      hasSharedCredential: hasShared,
      credentialId: mcpCredentials.id,
      expiresAt: mcpCredentials.expiresAt,
    })
    .from(mcpServers)
    .leftJoin(
      mcpCredentials,
      and(
        eq(mcpCredentials.mcpServerId, mcpServers.id),
        eq(mcpCredentials.principalId, principalId),
        eq(mcpCredentials.kind, 'user'),
      ),
    )
    .where(eq(mcpServers.workspaceId, workspaceId))
    .orderBy(asc(mcpServers.name));
  return rows.map((r) => ({
    serverId: r.serverId,
    name: r.name,
    displayName: r.displayName,
    authMode: r.authMode,
    hasSharedCredential: r.hasSharedCredential,
    connected: r.credentialId !== null,
    expiresAt: r.expiresAt,
  }));
}

/** Deletes every person's own credential for a server, when what they were issued for changed. */
export async function deleteUserMcpCredentialsForServer(
  db: Db,
  workspaceId: string,
  serverId: string,
): Promise<void> {
  await db
    .delete(mcpCredentials)
    .where(
      and(
        eq(mcpCredentials.mcpServerId, serverId),
        eq(mcpCredentials.kind, 'user'),
        inWorkspace(workspaceId),
      ),
    );
}

/** A tool as a sync records it (ADR 0069). */
export interface SyncedTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | null>;
  unusableReason: 'schema' | null;
  /** Used only for a tool seen for the first time; an admin's choice is kept after that. */
  defaultApprovalRequired: boolean;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Every change to what the snapshot holds moves the workspace's policy version on. */
async function bumpPolicyVersion(tx: Tx | Db, workspaceId: string): Promise<void> {
  await tx
    .update(workspaces)
    .set({ policyVersion: sql`${workspaces.policyVersion} + 1` })
    .where(eq(workspaces.id, workspaceId));
}

/**
 * Records what a server says its tools are: new tools are added off, with their default
 * approval; known ones get the new definition and keep the admin's choices; ones the server no
 * longer offers are removed.
 */
export async function syncWorkspaceTools(
  db: Db,
  workspaceId: string,
  serverId: string,
  tools: readonly SyncedTool[],
): Promise<{ added: number; updated: number; removed: number }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: workspaceTools.id, name: workspaceTools.name })
      .from(workspaceTools)
      .where(
        and(eq(workspaceTools.workspaceId, workspaceId), eq(workspaceTools.mcpServerId, serverId)),
      );
    const known = new Map(existing.map((t) => [t.name, t.id]));
    const seen = new Set(tools.map((t) => t.name));
    const now = new Date();
    let added = 0;
    let updated = 0;
    for (const tool of tools) {
      const definition = {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        unusableReason: tool.unusableReason,
        syncedAt: now,
        updatedAt: now,
      };
      const id = known.get(tool.name);
      if (id === undefined) {
        await tx.insert(workspaceTools).values({
          workspaceId,
          mcpServerId: serverId,
          name: tool.name,
          ...definition,
          approvalRequired: tool.defaultApprovalRequired,
        });
        added += 1;
      } else {
        await tx
          .update(workspaceTools)
          .set({
            ...definition,
            // A tool that became unusable comes off the allowlist.
            ...(tool.unusableReason === null ? {} : { enabled: false }),
          })
          .where(eq(workspaceTools.id, id));
        updated += 1;
      }
    }
    const gone = existing.filter((t) => !seen.has(t.name)).map((t) => t.id);
    if (gone.length > 0) await tx.delete(workspaceTools).where(inArray(workspaceTools.id, gone));
    await bumpPolicyVersion(tx, workspaceId);
    return { added, updated, removed: gone.length };
  });
}

export type WorkspaceToolRow = typeof workspaceTools.$inferSelect & {
  serverName: string;
  serverDisplayName: string | null;
};

export async function listWorkspaceTools(db: Db, workspaceId: string): Promise<WorkspaceToolRow[]> {
  const rows = await db
    .select({
      tool: workspaceTools,
      serverName: mcpServers.name,
      serverDisplayName: mcpServers.displayName,
    })
    .from(workspaceTools)
    .innerJoin(mcpServers, eq(mcpServers.id, workspaceTools.mcpServerId))
    .where(eq(workspaceTools.workspaceId, workspaceId))
    .orderBy(asc(mcpServers.name), asc(workspaceTools.name));
  return rows.map((r) => ({
    ...r.tool,
    serverName: r.serverName,
    serverDisplayName: r.serverDisplayName,
  }));
}

export async function findWorkspaceTool(
  db: Db,
  workspaceId: string,
  toolId: string,
): Promise<WorkspaceToolRow | undefined> {
  const [found] = await db
    .select({
      tool: workspaceTools,
      serverName: mcpServers.name,
      serverDisplayName: mcpServers.displayName,
    })
    .from(workspaceTools)
    .innerJoin(mcpServers, eq(mcpServers.id, workspaceTools.mcpServerId))
    .where(and(eq(workspaceTools.workspaceId, workspaceId), eq(workspaceTools.id, toolId)));
  return found === undefined
    ? undefined
    : { ...found.tool, serverName: found.serverName, serverDisplayName: found.serverDisplayName };
}

/** Puts a tool on or off the allowlist, or changes whether it asks first (TL-3, TL-4). */
export async function updateWorkspaceTool(
  db: Db,
  workspaceId: string,
  toolId: string,
  change: { enabled?: boolean; approvalRequired?: boolean },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(workspaceTools)
      .set({ ...change, updatedAt: new Date() })
      .where(and(eq(workspaceTools.workspaceId, workspaceId), eq(workspaceTools.id, toolId)))
      .returning({ id: workspaceTools.id });
    if (updated.length === 0) return false;
    await bumpPolicyVersion(tx, workspaceId);
    return true;
  });
}

/**
 * The servers whose tools this person can use now: those needing no credential, those with a
 * shared credential set, and OAuth servers the person has connected to (TL-2).
 */
export async function findUsableMcpServers(
  db: Db,
  workspaceId: string,
  principalId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.workspaceId, workspaceId),
        sql`(${mcpServers.authMode} = 'none'
          or exists (select 1 from ${mcpCredentials} c where c.mcp_server_id = ${mcpServers.id}
            and ((${mcpServers.authMode} = 'shared' and c.kind = 'shared')
              or (${mcpServers.authMode} = 'oauth' and c.kind = 'user' and c.principal_id = ${principalId}))))`,
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export type NewToolInvocation = typeof toolInvocations.$inferInsert;

/** Records one tool call (TL-6). */
export async function insertToolInvocation(db: Db, invocation: NewToolInvocation): Promise<void> {
  await db.insert(toolInvocations).values(invocation);
}

export async function listToolInvocationsForRequest(
  db: Db,
  workspaceId: string,
  requestId: string,
): Promise<(typeof toolInvocations.$inferSelect)[]> {
  return db
    .select()
    .from(toolInvocations)
    .where(
      and(eq(toolInvocations.workspaceId, workspaceId), eq(toolInvocations.requestId, requestId)),
    )
    .orderBy(asc(toolInvocations.createdAt));
}

export type ToolApprovalRow = typeof toolApprovals.$inferSelect;

/**
 * Records a call waiting for approval. A conversation waits on one call at a time: one still
 * pending from a run the person moved on from is expired first.
 */
export async function insertToolApproval(
  db: Db,
  approval: {
    workspaceId: string;
    conversationId: string;
    requestId: string;
    principalId: string;
    toolInvocationId: string;
    workspaceToolId: string;
    toolName: string;
    callId: string;
  },
): Promise<ToolApprovalRow> {
  return db.transaction(async (tx) => {
    await tx
      .update(toolApprovals)
      .set({ status: 'expired' })
      .where(
        and(
          eq(toolApprovals.workspaceId, approval.workspaceId),
          eq(toolApprovals.conversationId, approval.conversationId),
          eq(toolApprovals.status, 'pending'),
        ),
      );
    const [inserted] = await tx.insert(toolApprovals).values(approval).returning();
    if (inserted === undefined) throw new Error('approval insert returned nothing');
    return inserted;
  });
}

export interface PendingToolApprovalRow {
  id: string;
  principalId: string;
  /** The API key's name, when a key made the call (TL-4). */
  keyName: string | null;
  toolName: string;
  toolTitle: string | null;
  arguments: unknown;
  createdAt: Date;
}

/** The call a conversation is waiting on, with its arguments from the audit, if any. */
export async function findPendingToolApproval(
  db: Db,
  workspaceId: string,
  conversationId: string,
): Promise<PendingToolApprovalRow | undefined> {
  const [pending] = await db
    .select({
      id: toolApprovals.id,
      principalId: toolApprovals.principalId,
      keyName: sql<
        string | null
      >`case when ${principals.kind} = 'key' then ${principals.displayName} end`,
      toolName: toolApprovals.toolName,
      toolTitle: workspaceTools.title,
      arguments: toolInvocations.arguments,
      createdAt: toolApprovals.createdAt,
    })
    .from(toolApprovals)
    .innerJoin(toolInvocations, eq(toolInvocations.id, toolApprovals.toolInvocationId))
    .leftJoin(principals, eq(principals.id, toolApprovals.principalId))
    .leftJoin(workspaceTools, eq(workspaceTools.id, toolApprovals.workspaceToolId))
    .where(
      and(
        eq(toolApprovals.workspaceId, workspaceId),
        eq(toolApprovals.conversationId, conversationId),
        eq(toolApprovals.status, 'pending'),
      ),
    )
    .limit(1);
  return pending;
}

/** Expires whatever a conversation was waiting on, when the person sends something else. */
export async function expirePendingToolApprovals(
  db: Db,
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  await db
    .update(toolApprovals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(toolApprovals.workspaceId, workspaceId),
        eq(toolApprovals.conversationId, conversationId),
        eq(toolApprovals.status, 'pending'),
      ),
    );
}

/**
 * Decides a pending approval, only for the principal it waits on (AC 18). Undefined when there
 * is no such pending approval for them.
 */
export async function decideToolApproval(
  db: Db,
  workspaceId: string,
  conversationId: string,
  approvalId: string,
  principalId: string,
  decision: 'approved' | 'denied',
  answer: { requestId: string; always: boolean },
): Promise<ToolApprovalRow | undefined> {
  const [decided] = await db
    .update(toolApprovals)
    .set({
      status: decision,
      decidedByPrincipalId: principalId,
      decidedAt: new Date(),
      continuedByRequestId: answer.requestId,
      always: decision === 'approved' && answer.always,
    })
    .where(
      and(
        eq(toolApprovals.workspaceId, workspaceId),
        eq(toolApprovals.conversationId, conversationId),
        eq(toolApprovals.id, approvalId),
        eq(toolApprovals.principalId, principalId),
        eq(toolApprovals.status, 'pending'),
      ),
    )
    .returning();
  return decided;
}

/** Whether this principal holds a standing approval for this tool (TL-5). */
export async function hasActiveToolGrant(
  db: Db,
  workspaceId: string,
  principalId: string,
  workspaceToolId: string,
): Promise<boolean> {
  const [grant] = await db
    .select({ id: toolGrants.id })
    .from(toolGrants)
    .where(
      and(
        eq(toolGrants.workspaceId, workspaceId),
        eq(toolGrants.principalId, principalId),
        eq(toolGrants.workspaceToolId, workspaceToolId),
        isNull(toolGrants.revokedAt),
      ),
    );
  return grant !== undefined;
}

/** Gives a principal a standing approval for a tool, if they hold none already. */
export async function grantTool(
  db: Db,
  workspaceId: string,
  principalId: string,
  workspaceToolId: string,
): Promise<void> {
  await db
    .insert(toolGrants)
    .values({ workspaceId, principalId, workspaceToolId })
    .onConflictDoNothing();
}

export interface ToolGrantRow {
  id: string;
  principalId: string;
  principalName: string;
  workspaceToolId: string;
  toolName: string;
  serverName: string;
  serverDisplayName: string | null;
  grantedAt: Date;
}

/** Active standing approvals in a workspace, for one principal or all of them. */
export async function listToolGrants(
  db: Db,
  workspaceId: string,
  principalId: string | null,
): Promise<ToolGrantRow[]> {
  return db
    .select({
      id: toolGrants.id,
      principalId: toolGrants.principalId,
      principalName: principals.displayName,
      workspaceToolId: toolGrants.workspaceToolId,
      toolName: workspaceTools.name,
      serverName: mcpServers.name,
      serverDisplayName: mcpServers.displayName,
      grantedAt: toolGrants.grantedAt,
    })
    .from(toolGrants)
    .innerJoin(principals, eq(principals.id, toolGrants.principalId))
    .innerJoin(workspaceTools, eq(workspaceTools.id, toolGrants.workspaceToolId))
    .innerJoin(mcpServers, eq(mcpServers.id, workspaceTools.mcpServerId))
    .where(
      and(
        eq(toolGrants.workspaceId, workspaceId),
        isNull(toolGrants.revokedAt),
        ...(principalId === null ? [] : [eq(toolGrants.principalId, principalId)]),
      ),
    )
    .orderBy(asc(mcpServers.name), asc(workspaceTools.name));
}

/** Revokes a standing approval; `holder` limits it to that principal's own. */
export async function revokeToolGrant(
  db: Db,
  workspaceId: string,
  grantId: string,
  byPrincipalId: string,
  holder: string | null,
): Promise<boolean> {
  const revoked = await db
    .update(toolGrants)
    .set({ revokedAt: new Date(), revokedByPrincipalId: byPrincipalId })
    .where(
      and(
        eq(toolGrants.workspaceId, workspaceId),
        eq(toolGrants.id, grantId),
        isNull(toolGrants.revokedAt),
        ...(holder === null ? [] : [eq(toolGrants.principalId, holder)]),
      ),
    )
    .returning({ id: toolGrants.id });
  return revoked.length > 0;
}

/**
 * The arguments of a conversation's tool calls, by call id, from the audit: where they are
 * stored (invariant 9). The latest row for a call wins.
 */
export async function findToolCallArguments(
  db: Db,
  workspaceId: string,
  conversationId: string,
  callIds: readonly string[],
): Promise<Map<string, unknown>> {
  if (callIds.length === 0) return new Map();
  const rows = await db
    .select({ callId: toolInvocations.callId, arguments: toolInvocations.arguments })
    .from(toolInvocations)
    .where(
      and(
        eq(toolInvocations.workspaceId, workspaceId),
        eq(toolInvocations.conversationId, conversationId),
        inArray(toolInvocations.callId, [...callIds]),
      ),
    )
    .orderBy(asc(toolInvocations.createdAt));
  return new Map(rows.map((r) => [r.callId, r.arguments]));
}

/** The id of the audit row a call was recorded under in a request. */
export async function findToolInvocationId(
  db: Db,
  workspaceId: string,
  requestId: string,
  callId: string,
): Promise<string | undefined> {
  const [found] = await db
    .select({ id: toolInvocations.id })
    .from(toolInvocations)
    .where(
      and(
        eq(toolInvocations.workspaceId, workspaceId),
        eq(toolInvocations.requestId, requestId),
        eq(toolInvocations.callId, callId),
      ),
    )
    .orderBy(asc(toolInvocations.createdAt));
  return found?.id;
}

/** An approval and what became of it, for traces (TL-4, ADR 0095). */
export interface ApprovalTraceRow {
  id: string;
  requestId: string;
  continuedByRequestId: string | null;
  toolName: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  always: boolean;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByPrincipalId: string | null;
}

/** The approvals these requests asked for, oldest first. */
export async function listApprovalsForRequests(
  db: Db,
  workspaceId: string,
  requestIds: readonly string[],
): Promise<ApprovalTraceRow[]> {
  if (requestIds.length === 0) return [];
  return db
    .select({
      id: toolApprovals.id,
      requestId: toolApprovals.requestId,
      continuedByRequestId: toolApprovals.continuedByRequestId,
      toolName: toolApprovals.toolName,
      status: toolApprovals.status,
      always: toolApprovals.always,
      createdAt: toolApprovals.createdAt,
      decidedAt: toolApprovals.decidedAt,
      decidedByPrincipalId: toolApprovals.decidedByPrincipalId,
    })
    .from(toolApprovals)
    .where(
      and(
        eq(toolApprovals.workspaceId, workspaceId),
        inArray(toolApprovals.requestId, [...requestIds]),
      ),
    )
    .orderBy(asc(toolApprovals.createdAt));
}

/** The request this one continued after an approval, if it did. */
export async function findContinuedRequest(
  db: Db,
  workspaceId: string,
  requestId: string,
): Promise<string | undefined> {
  const [found] = await db
    .select({ requestId: toolApprovals.requestId })
    .from(toolApprovals)
    .where(
      and(
        eq(toolApprovals.workspaceId, workspaceId),
        eq(toolApprovals.continuedByRequestId, requestId),
      ),
    )
    .limit(1);
  return found?.requestId;
}
