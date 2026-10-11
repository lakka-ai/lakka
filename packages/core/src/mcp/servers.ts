import {
  ForbiddenError,
  InvalidRequestError,
  McpOriginNotAllowedError,
  McpServerExistsError,
  mcpServerDisplayName,
  NotFoundError,
} from '@lakka/contracts';
import type {
  McpServerChangeBody,
  McpServerTestView,
  McpServerView,
  NewMcpServerBody,
  Principal,
} from '@lakka/contracts';
import {
  deleteMcpServer,
  deleteSharedMcpCredential,
  deleteUserMcpCredentialsForServer,
  findMcpServer,
  insertMcpServer,
  listMcpServers,
  recordMcpServerTest,
  setMcpOAuthClient,
  setSharedMcpCredential,
  updateMcpServer,
} from '@lakka/db';
import type { McpServerRow, NewMcpServer } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import { isPrivateHostLiteral } from '../net/public-address.ts';
import { toolListing } from '../tools/executor.ts';
import type { ToolExecutor } from '../tools/executor.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';
import { classifyMcpFailure } from './client.ts';
import type { McpTarget } from './client.ts';
import { mcpTargetFor, requireAllowedOrigin } from './egress.ts';
import { resolveMcpCredential } from './oauth.ts';
import type { ResolvedMcpCredential } from './oauth.ts';

/*
 * Managing a workspace's MCP servers (TL-1, ADR 0066 Q2, ADR 0067):
 *
 * - workspace admins add Streamable HTTP servers to their workspace;
 * - a stdio server runs a command on the host, so adding or changing one takes an instance admin;
 * - a workspace admin's server must be https and public, unless its origin is one the operator
 *   listed in LAKKA_MCP_PRIVATE_ORIGINS; an instance admin's may be anywhere. Which applies is
 *   decided when the server is saved and kept as `allow_private`, and a public-only server is
 *   checked against private addresses on every connection;
 * - whoever adds it, an HTTP server's origin must be on the instance's allowlist (NF-S4,
 *   ADR 0117), and is checked against it again on every connection (egress.ts);
 * - a shared credential is write-only, like a provider key.
 */

export interface McpContext extends ServiceContext {
  /** Private-network origins workspace admins may use (LAKKA_MCP_PRIVATE_ORIGINS). */
  mcpPrivateOrigins: readonly string[];
  /** The instance's public origin, for the OAuth redirect URI (ADR 0068). */
  publicUrl: string;
  /**
   * Where servers are started and called, for tests and syncs as for tool calls (TL-8): a stdio
   * server runs only in the sandbox in production (ADR 0118).
   */
  executor: ToolExecutor;
}

/** Testing and syncing are not stopped by anything but their own deadline. */
const UNTIL_DEADLINE = new AbortController().signal;

const isInstanceAdmin = (principal: Principal) =>
  principal.kind === 'user' && principal.isInstanceAdmin;

const missing = () => new NotFoundError('MCP server not found');

function view(row: McpServerRow): McpServerView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    displayName: row.displayName ?? mcpServerDisplayName(row.name),
    displayNameSet: row.displayName !== null,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args,
    authMode: row.authMode,
    credentialEnv: row.credentialEnv,
    hasSharedCredential: row.hasSharedCredential,
    allowPrivate: row.allowPrivate,
    oauthScope: row.oauthScope,
    oauthClient: row.oauthClientSource,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestStatus: row.lastTestStatus,
    lastSync:
      row.lastSyncedAt === null
        ? null
        : { at: row.lastSyncedAt.toISOString(), error: row.lastSyncError },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const invalid = (param: string, message: string) =>
  Object.assign(new InvalidRequestError(message), { param });

/**
 * Whether this caller may point a server at `url`, and whether it may then reach private
 * addresses. Throws for a URL a workspace admin may not use, and for an origin nobody listed.
 */
async function networkFor(ctx: McpContext, principal: Principal, url: string): Promise<boolean> {
  let allowPrivate: boolean;
  const target = new URL(url);
  if (isInstanceAdmin(principal) || ctx.mcpPrivateOrigins.includes(target.origin)) {
    allowPrivate = true;
  } else if (target.protocol !== 'https:') {
    throw invalid('url', 'The server must use https.');
  } else if (isPrivateHostLiteral(target.hostname)) {
    throw invalid(
      'url',
      'The server must be on a public address. An instance administrator can allow a private one.',
    );
  } else {
    allowPrivate = false;
  }
  await requireAllowedOrigin(ctx, url);
  return allowPrivate;
}

function requireInstanceAdminForStdio(principal: Principal): void {
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('only instance administrators add or change stdio servers');
  }
}

async function authorize(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  action: 'tools.read' | 'tools.manage',
): Promise<void> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, action);
}

export async function listWorkspaceMcpServers(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
): Promise<McpServerView[]> {
  await authorize(ctx, principal, workspaceId, 'tools.read');
  return (await listMcpServers(ctx.db, workspaceId)).map(view);
}

export async function getMcpServer(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<McpServerView> {
  await authorize(ctx, principal, workspaceId, 'tools.read');
  const row = await findMcpServer(ctx.db, workspaceId, serverId);
  if (row === undefined) throw missing();
  return view(row);
}

export async function addMcpServer(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  body: NewMcpServerBody,
): Promise<McpServerView> {
  await authorize(ctx, principal, workspaceId, 'tools.manage');
  const common = {
    workspaceId,
    name: body.name,
    displayName: body.displayName ?? null,
    authMode: body.authMode,
  };
  let server: NewMcpServer;
  if (body.transport === 'stdio') {
    requireInstanceAdminForStdio(principal);
    server = {
      ...common,
      transport: 'stdio',
      url: null,
      command: body.command,
      args: body.args,
      credentialEnv: body.credentialEnv ?? null,
      allowPrivate: true,
      createdByPrincipalId: principal.actingUserId,
    };
  } else {
    server = {
      ...common,
      transport: 'streamable_http',
      url: body.url,
      command: null,
      args: [],
      credentialEnv: null,
      allowPrivate: await networkFor(ctx, principal, body.url),
      oauthScope: body.oauthScope ?? null,
      createdByPrincipalId: principal.actingUserId,
    };
  }
  const row = await insertMcpServer(ctx.db, server);
  if (row === undefined)
    throw new McpServerExistsError('the workspace has a server with that name');
  return view(row);
}

export async function changeMcpServer(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
  body: McpServerChangeBody,
): Promise<McpServerView> {
  await authorize(ctx, principal, workspaceId, 'tools.manage');
  const current = await findMcpServer(ctx.db, workspaceId, serverId);
  if (current === undefined) throw missing();
  const change: Parameters<typeof updateMcpServer>[3] = {};
  if (body.name !== undefined) change.name = body.name;
  if (body.displayName !== undefined) change.displayName = body.displayName;
  // Tokens people were issued for this server stop fitting it when its URL or auth mode changes.
  let forgetTokens = false;
  if (current.transport === 'stdio') {
    requireInstanceAdminForStdio(principal);
    if (body.url !== undefined) throw invalid('url', 'A stdio server has no URL.');
    if (body.authMode === 'oauth' || body.oauthScope != null) {
      throw invalid('authMode', 'OAuth is for HTTP servers.');
    }
    if (body.command !== undefined) change.command = body.command;
    if (body.args !== undefined) change.args = body.args;
    const authMode = body.authMode ?? current.authMode;
    const credentialEnv =
      body.credentialEnv === undefined ? current.credentialEnv : body.credentialEnv;
    if ((authMode === 'shared') !== (credentialEnv !== null)) {
      throw invalid('credentialEnv', 'Required with a shared credential, and only then.');
    }
    change.authMode = authMode;
    change.credentialEnv = credentialEnv;
  } else {
    if (body.command !== undefined || body.args !== undefined || body.credentialEnv != null) {
      throw invalid('command', 'An HTTP server has no command.');
    }
    const authMode = body.authMode ?? current.authMode;
    if (body.oauthScope != null && authMode !== 'oauth') {
      throw invalid('oauthScope', 'Scopes are only for OAuth.');
    }
    if (authMode !== current.authMode) {
      change.authMode = authMode;
      forgetTokens = current.authMode === 'oauth';
      // Grandfathering covers the server as the upgrade found it (ADR 0117).
      change.egressGrandfathered = false;
    }
    if (authMode !== 'oauth') {
      change.oauthScope = null;
      change.oauthClient = null;
      change.oauthClientSource = null;
    } else if (body.oauthScope !== undefined) {
      change.oauthScope = body.oauthScope;
    }
    // A new URL is judged afresh, by whoever sets it, and may have another authorization
    // server: a client registered for the old one is dropped, one an admin entered is kept.
    if (body.url !== undefined && body.url !== current.url) {
      change.url = body.url;
      change.allowPrivate = await networkFor(ctx, principal, body.url);
      change.egressGrandfathered = false;
      forgetTokens ||= current.authMode === 'oauth';
      if (current.oauthClientSource === 'registered') {
        change.oauthClient = null;
        change.oauthClientSource = null;
      }
    }
  }
  const updated = await updateMcpServer(ctx.db, workspaceId, serverId, change);
  if (updated === 'name_taken') {
    throw new McpServerExistsError('the workspace has a server with that name');
  }
  if (updated === undefined) throw missing();
  if (forgetTokens) await deleteUserMcpCredentialsForServer(ctx.db, workspaceId, serverId);
  return view(updated);
}

/**
 * Enters the client Lakka is registered as with an authorization server that does not
 * register clients itself (ADR 0068). Write-only.
 */
export async function setMcpServerOAuthClient(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
  client: { clientId: string; clientSecret?: string | undefined },
): Promise<McpServerView> {
  await authorize(ctx, principal, workspaceId, 'tools.manage');
  const current = await findMcpServer(ctx.db, workspaceId, serverId);
  if (current === undefined) throw missing();
  if (current.authMode !== 'oauth') {
    throw invalid('authMode', 'This server does not use OAuth.');
  }
  const record = {
    client: {
      client_id: client.clientId,
      ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
    },
    redirectUri: null,
  };
  await setMcpOAuthClient(ctx.db, workspaceId, serverId, JSON.stringify(record), 'admin');
  // Tokens issued to another client may not be refreshable by this one.
  await deleteUserMcpCredentialsForServer(ctx.db, workspaceId, serverId);
  return view({ ...current, oauthClient: '', oauthClientSource: 'admin' });
}

export async function removeMcpServerOAuthClient(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<void> {
  await authorize(ctx, principal, workspaceId, 'tools.manage');
  const current = await findMcpServer(ctx.db, workspaceId, serverId);
  if (current === undefined) throw missing();
  if (current.oauthClientSource === null) throw new NotFoundError('no client is set');
  await setMcpOAuthClient(ctx.db, workspaceId, serverId, null, null);
  await deleteUserMcpCredentialsForServer(ctx.db, workspaceId, serverId);
}

export async function removeMcpServer(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<void> {
  await authorize(ctx, principal, workspaceId, 'tools.manage');
  const current = await findMcpServer(ctx.db, workspaceId, serverId);
  if (current === undefined) throw missing();
  if (current.transport === 'stdio') requireInstanceAdminForStdio(principal);
  await deleteMcpServer(ctx.db, workspaceId, serverId);
}

/** Sets the server's shared credential. Write-only: nothing ever returns it. */
export async function setMcpServerCredential(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
  secret: string,
): Promise<McpServerView> {
  await authorize(ctx, principal, workspaceId, 'tools.manage');
  const current = await findMcpServer(ctx.db, workspaceId, serverId);
  if (current === undefined) throw missing();
  if (current.transport === 'stdio') requireInstanceAdminForStdio(principal);
  if (current.authMode !== 'shared') {
    throw invalid('authMode', 'This server does not use a shared credential.');
  }
  await setSharedMcpCredential(ctx.db, workspaceId, serverId, principal.actingUserId, secret);
  return view({ ...current, hasSharedCredential: true });
}

export async function removeMcpServerCredential(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<void> {
  await authorize(ctx, principal, workspaceId, 'tools.manage');
  const current = await findMcpServer(ctx.db, workspaceId, serverId);
  if (current === undefined) throw missing();
  if (current.transport === 'stdio') requireInstanceAdminForStdio(principal);
  if (!(await deleteSharedMcpCredential(ctx.db, workspaceId, serverId))) {
    throw new NotFoundError('no shared credential is set');
  }
}

/**
 * Connects with the credential `principal` would use, and lists the server's tools, through the
 * executor as a call would be (TL-8). The origin
 * is checked first, before a credential is refreshed: a server, or an authorization server, that
 * is not listed is `not_allowed` (NF-S4). A list that cannot be read stops the test, rather than
 * look like a finding about the server.
 */
export async function testWith(
  ctx: McpContext,
  principal: Principal,
  server: McpServerRow,
): Promise<McpServerTestView> {
  let target: McpTarget;
  let credential: ResolvedMcpCredential;
  try {
    target = await mcpTargetFor(ctx, server);
    credential = await resolveMcpCredential(ctx, principal, server);
  } catch (error) {
    if (error instanceof McpOriginNotAllowedError) return { status: 'not_allowed', tools: [] };
    throw error;
  }
  if (credential === 'missing') {
    return { status: server.authMode === 'oauth' ? 'not_connected' : 'no_credential', tools: [] };
  }
  try {
    return {
      status: 'ok',
      tools: await ctx.executor.list(toolListing(target, credential.secret), UNTIL_DEADLINE),
    };
  } catch (error) {
    return { status: classifyMcpFailure(error), tools: [] };
  }
}

/**
 * Connects to the server as configured, lists its tools, and records whether that worked. The
 * status says what an admin can act on; the error itself is not returned or logged.
 */
export async function testMcpServer(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<McpServerTestView> {
  await authorize(ctx, principal, workspaceId, 'tools.manage');
  const server = await findMcpServer(ctx.db, workspaceId, serverId);
  if (server === undefined) throw missing();
  // An OAuth server is tested with the tester's own account, as anyone else would use it.
  const result = await testWith(ctx, principal, server);
  // Nothing to test with is not a finding about the server; its last real test stands.
  if (result.status !== 'not_connected' && result.status !== 'no_credential') {
    await recordMcpServerTest(ctx.db, workspaceId, serverId, result.status);
  }
  return result;
}
