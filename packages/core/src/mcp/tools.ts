import { z } from 'zod';
import {
  InvalidRequestError,
  McpOriginNotAllowedError,
  mcpServerDisplayName,
  NotFoundError,
} from '@lakka/contracts';
import type {
  AvailableToolView,
  McpToolSyncView,
  McpToolView,
  Principal,
  ToolGrantView,
  WorkspaceToolChangeBody,
  WorkspaceToolView,
} from '@lakka/contracts';
import {
  findMcpServer,
  findUsableMcpServers,
  findWorkspaceTool,
  listMcpConnections,
  listToolGrants,
  listWorkspaceTools,
  recordMcpServerSync,
  revokeToolGrant,
  syncWorkspaceTools,
  updateWorkspaceTool,
} from '@lakka/db';
import type { SyncedTool, ToolGrantRow, WorkspaceToolRow } from '@lakka/db';
import type { PolicySnapshot, ToolSnapshot } from '../routing/score.ts';
import type { PolicySnapshots } from '../routing/snapshot.ts';
import { toolModelName } from '../routing/snapshot.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';
import { toolListing } from '../tools/executor.ts';
import { classifyMcpFailure } from './client.ts';
import type { McpTarget } from './client.ts';
import { mcpTargetFor } from './egress.ts';
import { resolveMcpCredential } from './oauth.ts';
import type { ResolvedMcpCredential } from './oauth.ts';
import type { McpContext } from './servers.ts';

/*
 * A workspace's tools and the admin's decisions about them (TL-3, TL-4, ADR 0069):
 *
 * - An admin syncs a server's tools. What the server says then is stored, and that stored
 *   definition is what the model is offered until the next sync.
 * - A new tool starts off the allowlist. It asks before running unless its server marks it
 *   read-only (H2). The hint only sets the default; after that the admin decides.
 * - A request's tools are the enabled ones from the policy snapshot whose server the caller can
 *   use now: no credential needed, a shared one set, or their own OAuth connection (pipeline
 *   stage 6, TL-2).
 */

/** Descriptions and titles past these lengths are cut, so one server cannot flood the prompt. */
const MAX_DESCRIPTION = 4000;
const MAX_TITLE = 200;
/** A schema larger than this cannot be offered: it would cost tokens on every request. */
const MAX_SCHEMA_BYTES = 64 * 1024;

/** A sync is not stopped by anything but its own deadline. */
const UNTIL_DEADLINE = new AbortController().signal;

export interface ToolsContext extends McpContext {
  snapshots: PolicySnapshots;
}

/** Whether arguments can be checked against the schema at dispatch (ADR 0070). */
function checkable(schema: Record<string, unknown>): boolean {
  try {
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    return true;
  } catch {
    return false;
  }
}

const cut = (text: string | null, max: number) =>
  text === null ? null : text.length > max ? `${text.slice(0, max - 3)}...` : text;

/** What a sync records for a tool the server listed. Exported for its unit test. */
export function syncedTool(tool: McpToolView): SyncedTool {
  const schema = tool.inputSchema;
  const usable =
    schema['type'] === 'object' &&
    Buffer.byteLength(JSON.stringify(schema)) <= MAX_SCHEMA_BYTES &&
    checkable(schema);
  return {
    name: tool.name,
    title: cut(tool.title, MAX_TITLE),
    description: cut(tool.description, MAX_DESCRIPTION),
    inputSchema: usable ? schema : {},
    annotations: tool.annotations,
    unusableReason: usable ? null : 'schema',
    // H2: only a tool its server says is read-only runs without asking, by default.
    defaultApprovalRequired: tool.annotations.readOnlyHint !== true,
  };
}

function view(row: WorkspaceToolRow): WorkspaceToolView {
  const modelName = toolModelName(row.serverName, row.name);
  return {
    id: row.id,
    serverId: row.mcpServerId,
    serverName: row.serverName,
    serverDisplayName: row.serverDisplayName ?? mcpServerDisplayName(row.serverName),
    name: row.name,
    modelName,
    title: row.title,
    description: row.description,
    inputSchema: row.inputSchema,
    annotations: {
      readOnlyHint: row.annotations['readOnlyHint'] ?? null,
      destructiveHint: row.annotations['destructiveHint'] ?? null,
      idempotentHint: row.annotations['idempotentHint'] ?? null,
      openWorldHint: row.annotations['openWorldHint'] ?? null,
    },
    unusable: row.unusableReason ?? (modelName === null ? 'name' : null),
    enabled: row.enabled,
    approvalRequired: row.approvalRequired,
    syncedAt: row.syncedAt.toISOString(),
  };
}

export async function listToolsForAdmin(
  ctx: ToolsContext,
  principal: Principal,
  workspaceId: string,
): Promise<WorkspaceToolView[]> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'tools.read');
  return (await listWorkspaceTools(ctx.db, workspaceId)).map(view);
}

/**
 * Asks the server for its tools, through the executor that runs its calls (TL-8), with the
 * admin's own credential where it takes one, and records them. The server's failure is reported as a status, never in its own words.
 */
export async function syncMcpServerTools(
  ctx: ToolsContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<McpToolSyncView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'tools.manage');
  const server = await findMcpServer(ctx.db, workspaceId, serverId);
  if (server === undefined) throw new NotFoundError('MCP server not found');
  // The origin first, before a credential is refreshed. Said with the origin, so an instance
  // admin can list it from where they are (NF-S4, ADR 0117).
  let target: McpTarget;
  let credential: ResolvedMcpCredential;
  try {
    target = await mcpTargetFor(ctx, server);
    credential = await resolveMcpCredential(ctx, principal, server);
  } catch (error) {
    if (error instanceof McpOriginNotAllowedError) {
      await recordMcpServerSync(ctx.db, workspaceId, serverId, 'not_allowed');
    }
    throw error;
  }
  if (credential === 'missing') {
    await recordMcpServerSync(
      ctx.db,
      workspaceId,
      serverId,
      server.authMode === 'oauth' ? 'not_connected' : 'no_credential',
    );
    throw new InvalidRequestError(
      server.authMode === 'oauth'
        ? 'Connect your own account to this server first.'
        : 'Set the shared credential first.',
    );
  }
  let tools: McpToolView[];
  try {
    tools = await ctx.executor.list(toolListing(target, credential.secret), UNTIL_DEADLINE);
  } catch (error) {
    // Kept as our own code, so the Tools page can say a sync failed and why (ADR 0096).
    const failure = classifyMcpFailure(error);
    await recordMcpServerSync(ctx.db, workspaceId, serverId, failure);
    throw Object.assign(new InvalidRequestError(`The server could not be read (${failure}).`), {
      cause: error,
    });
  }
  const counts = await syncWorkspaceTools(ctx.db, workspaceId, serverId, tools.map(syncedTool));
  await recordMcpServerSync(ctx.db, workspaceId, serverId, null);
  const all = (await listWorkspaceTools(ctx.db, workspaceId)).filter(
    (t) => t.mcpServerId === serverId,
  );
  return { ...counts, tools: all.map(view) };
}

export async function changeWorkspaceTool(
  ctx: ToolsContext,
  principal: Principal,
  workspaceId: string,
  toolId: string,
  body: WorkspaceToolChangeBody,
): Promise<WorkspaceToolView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'tools.manage');
  const current = await findWorkspaceTool(ctx.db, workspaceId, toolId);
  if (current === undefined) throw new NotFoundError('tool not found');
  if (body.enabled === true && view(current).unusable !== null) {
    throw Object.assign(
      new InvalidRequestError(
        view(current).unusable === 'name'
          ? 'This tool has a name models cannot be given, so it cannot be enabled.'
          : 'This tool has no usable input schema, so it cannot be enabled.',
      ),
      { param: 'enabled' },
    );
  }
  await updateWorkspaceTool(ctx.db, workspaceId, toolId, {
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(body.approvalRequired === undefined ? {} : { approvalRequired: body.approvalRequired }),
  });
  const updated = await findWorkspaceTool(ctx.db, workspaceId, toolId);
  if (updated === undefined) throw new NotFoundError('tool not found');
  return view(updated);
}

/**
 * The tools a request may offer the model (pipeline stage 6): the snapshot's allowlist, less
 * those whose server the acting person cannot use now. A key's are its owner's (invariant 2).
 */
export async function resolveTools(
  ctx: McpContext,
  policy: PolicySnapshot,
  principal: Principal,
): Promise<readonly ToolSnapshot[]> {
  if (policy.tools.length === 0) return [];
  const usable = await findUsableMcpServers(ctx.db, policy.workspaceId, principal.actingUserId);
  return policy.tools.filter((tool) => usable.has(tool.serverId));
}

export async function listAvailableTools(
  ctx: ToolsContext,
  principal: Principal,
  workspaceId: string,
): Promise<AvailableToolView[]> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'models.use');
  const policy = await ctx.snapshots.get(workspaceId);
  if (policy === undefined) throw new NotFoundError('workspace not found');
  // Every enabled tool, and whether the caller can use it now: a server may wait for them to
  // connect their own account, or for its admin to set the shared credential (TL-2).
  const [usable, servers, grants] = await Promise.all([
    findUsableMcpServers(ctx.db, workspaceId, principal.actingUserId),
    listMcpConnections(ctx.db, workspaceId, principal.actingUserId),
    listToolGrants(ctx.db, workspaceId, principal.id),
  ]);
  const serverOf = new Map(servers.map((s) => [s.serverId, s]));
  const granted = new Set(grants.map((g) => g.workspaceToolId));
  return policy.tools.map((tool) => {
    const server = serverOf.get(tool.serverId);
    return {
      modelName: tool.modelName,
      name: tool.name,
      serverId: tool.serverId,
      serverName: tool.serverName,
      serverDisplayName: server?.displayName ?? mcpServerDisplayName(tool.serverName),
      title: tool.title,
      description: tool.description,
      approvalRequired: tool.approvalRequired,
      blockedBy: usable.has(tool.serverId)
        ? null
        : server?.authMode === 'oauth'
          ? 'not_connected'
          : 'no_credential',
      standingApproval: granted.has(tool.id),
    };
  });
}

function grantView(row: ToolGrantRow): ToolGrantView {
  return {
    id: row.id,
    principalId: row.principalId,
    principalName: row.principalName,
    modelName: `${row.serverName}__${row.toolName}`,
    toolName: row.toolName,
    serverName: row.serverName,
    serverDisplayName: row.serverDisplayName ?? mcpServerDisplayName(row.serverName),
    grantedAt: row.grantedAt.toISOString(),
  };
}

const noGrant = () => new NotFoundError('standing approval not found');

/**
 * Standing approvals (TL-5, ADR 0071). A person creates one by approving a call "always"; they
 * see and revoke their own, and a workspace admin sees and revokes everyone's.
 */
export async function listMyToolGrants(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
): Promise<ToolGrantView[]> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'models.use');
  return (await listToolGrants(ctx.db, workspaceId, principal.id)).map(grantView);
}

export async function revokeMyToolGrant(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  grantId: string,
): Promise<void> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'models.use');
  if (!(await revokeToolGrant(ctx.db, workspaceId, grantId, principal.id, principal.id))) {
    throw noGrant();
  }
}

export async function listWorkspaceToolGrants(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
): Promise<ToolGrantView[]> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'tools.manage');
  return (await listToolGrants(ctx.db, workspaceId, null)).map(grantView);
}

export async function revokeWorkspaceToolGrant(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  grantId: string,
): Promise<void> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'tools.manage');
  if (!(await revokeToolGrant(ctx.db, workspaceId, grantId, principal.id, null))) {
    throw noGrant();
  }
}
