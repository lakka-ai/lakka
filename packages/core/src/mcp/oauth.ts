import { createHash, randomBytes } from 'node:crypto';
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  OAuthError,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/client';
import type {
  AuthorizationServerMetadata,
  FetchLike,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import {
  mcpServerDisplayName,
  ForbiddenError,
  InvalidRequestError,
  McpOAuthClientRequiredError,
  McpOAuthFailedError,
  McpOriginNotAllowedError,
  NotFoundError,
} from '@lakka/contracts';
import type {
  McpConnectionView,
  McpConnectStartView,
  McpServerTestView,
  Principal,
} from '@lakka/contracts';
import {
  deleteUserMcpCredential,
  findMcpServer,
  findSharedMcpCredential,
  findUserMcpCredential,
  insertMcpOAuthState,
  listGrandfatheredOrigins,
  listMcpConnections,
  refreshUserMcpCredential,
  saveUserMcpCredential,
  setMcpOAuthClient,
  takeMcpOAuthState,
} from '@lakka/db';
import type { McpServerRow } from '@lakka/db';
import { decideEgress, normaliseOrigin } from '../net/egress-policy.ts';
import type { EgressRule } from '../net/egress-policy.ts';
import { guardedFetch } from '../net/guarded-fetch.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';
import { mcpEgressRule, mcpTargetFor } from './egress.ts';
import { testWith } from './servers.ts';
import type { McpContext } from './servers.ts';

/*
 * Per-user credentials for MCP servers, through the MCP authorization flow (TL-2, ADR 0068):
 *
 * - A person starts from Lakka: the api discovers the server's authorization server,
 *   registers with it if it can and no client is known yet, and sends the person there with a
 *   PKCE challenge, a single-use state, and the server as the `resource` (RFC 8707).
 * - The authorization server sends them back to /api/mcp/oauth/callback. The state must belong
 *   to the same signed-in person; the code is exchanged, and their tokens stored, encrypted,
 *   against the server and them.
 * - A token close to expiry is refreshed under a row lock, so two requests never spend the same
 *   refresh token. A refused refresh deletes the credential: the person connects again.
 *
 * Every request to the authorization server follows the server's own network rule: a server
 * that must be public has an authorization server that must be public, and https. And every
 * origin the server's metadata names, the authorization server, its token, registration and
 * authorization endpoints, must be on the instance's allowlist (NF-S4, ADR 0117): otherwise a
 * server's metadata could send Lakka anywhere. The authorization endpoint is opened by the
 * person's browser, not by Lakka, but is held to the same rule, so there is one rule to know.
 * A server that existed before the allowlist lists the origins it names the first time they are
 * discovered, instead of being refused.
 */

/** How long a person has to finish authorizing. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** A token this close to expiry is refreshed before use. */
const REFRESH_MARGIN_MS = 60 * 1000;

export const MCP_OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';

/** Whether a token can be used as it is, without refreshing it first. */
const fresh = (expiresAt: Date | null) =>
  expiresAt === null || expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;

const redirectUri = (ctx: McpContext) => `${ctx.publicUrl}${MCP_OAUTH_CALLBACK_PATH}`;
const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

function requirePerson(principal: Principal): void {
  if (principal.kind !== 'user') {
    throw new ForbiddenError('connecting an account takes a signed-in person, not a key');
  }
}

async function oauthServer(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<McpServerRow> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'models.use');
  const server = await findMcpServer(ctx.db, workspaceId, serverId);
  if (server === undefined || server.authMode !== 'oauth') {
    throw new NotFoundError('no OAuth MCP server with that id');
  }
  return server;
}

interface Discovered {
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  resource: URL;
  scope: string | undefined;
  /** For every later request to the authorization server: the allowlist, as it now is. */
  fetchFn: FetchLike;
}

function mustBeHttps(server: McpServerRow, url: string | undefined, what: string): void {
  if (!server.allowPrivate && url !== undefined && new URL(url).protocol !== 'https:') {
    throw new McpOAuthFailedError(`the server's ${what} does not use https`);
  }
}

/**
 * A fetch for discovery that keeps to `rule`, and remembers the first origin it refused: the
 * client library swallows some failures and tries elsewhere, and the person needs to hear which
 * origin to have listed, not that discovery failed. For a grandfathered server, an origin that is
 * not listed is let through and remembered instead, to be listed once discovery succeeds.
 */
function discoveryFetch(rule: EgressRule, grandfathered: boolean) {
  // Read by the guarded fetch on every request, so an origin added here applies from then on.
  const allowed = [...rule.allowedOrigins];
  const guarded = guardedFetch({ ...rule, allowedOrigins: allowed });
  const found = new Set<string>();
  let refused: string | null = null;
  const fetchFn: FetchLike = async (input, init) => {
    const origin = normaliseOrigin(input instanceof URL ? input : String(input));
    if (origin !== null && !allowed.includes(origin) && grandfathered) {
      allowed.push(origin);
      found.add(origin);
    }
    try {
      return await guarded(input, init);
    } catch (error) {
      if (error instanceof McpOriginNotAllowedError) refused ??= error.origin;
      throw error;
    }
  };
  return { fetchFn, found, refused: () => refused };
}

async function discover(ctx: McpContext, server: McpServerRow): Promise<Discovered> {
  // An OAuth server is always an HTTP server with a URL. Its own origin must be listed first.
  const serverUrl = new URL(server.url as string);
  await mcpTargetFor(ctx, server);
  const rule = await mcpEgressRule(ctx, server);
  const grandfathered = server.egressGrandfathered;
  const discovery = discoveryFetch(rule, grandfathered);
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>> | undefined;
  let failure: unknown;
  try {
    info = await discoverOAuthServerInfo(serverUrl, { fetchFn: discovery.fetchFn });
  } catch (error) {
    failure = error;
  }
  const refused = discovery.refused();
  if (refused !== null) throw new McpOriginNotAllowedError(refused);
  const metadata = info?.authorizationServerMetadata;
  if (info === undefined || metadata === undefined) {
    throw new McpOAuthFailedError(
      "the server's authorization server could not be found",
      failure === undefined ? {} : { cause: failure },
    );
  }
  mustBeHttps(server, info.authorizationServerUrl, 'authorization server');
  mustBeHttps(server, metadata.token_endpoint, 'token endpoint');
  mustBeHttps(server, metadata.registration_endpoint, 'registration endpoint');
  // The token is for this server. A resource the metadata names elsewhere is refused.
  const advertised = info.resourceMetadata?.resource;
  const resource = advertised === undefined ? serverUrl : new URL(advertised);
  if (resource.origin !== serverUrl.origin) {
    throw new McpOAuthFailedError('the server names a different resource than itself');
  }
  // Every origin the metadata names, whether Lakka or the person's browser goes there.
  const named = [
    info.authorizationServerUrl,
    metadata.issuer,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ];
  const origins = new Set(rule.allowedOrigins);
  for (const url of named) {
    if (url === undefined) continue;
    const decision = decideEgress(url, { ...rule, allowedOrigins: [...origins] });
    if (decision.allowed || decision.reason !== 'not_listed') continue;
    if (!grandfathered) throw new McpOriginNotAllowedError(decision.origin);
    origins.add(decision.origin);
    discovery.found.add(decision.origin);
  }
  if (grandfathered) {
    await listGrandfatheredOrigins(ctx.db, server.workspaceId, server.id, [...discovery.found]);
  }
  const scopes = info.resourceMetadata?.scopes_supported;
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    resource,
    scope:
      server.oauthScope ??
      (scopes === undefined || scopes.length === 0 ? undefined : scopes.join(' ')),
    fetchFn: guardedFetch({ ...rule, allowedOrigins: [...origins] }),
  };
}

interface StoredClient {
  client: OAuthClientInformationMixed;
  /** The redirect URI it was registered with; a different one means registering again. */
  redirectUri: string | null;
}

function storedClient(server: McpServerRow): StoredClient | undefined {
  if (server.oauthClient === null) return undefined;
  return JSON.parse(server.oauthClient) as StoredClient;
}

function authMethod(metadata: AuthorizationServerMetadata): string {
  const supported = metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  for (const method of ['client_secret_basic', 'client_secret_post']) {
    if (supported.includes(method)) return method;
  }
  return 'none';
}

/**
 * The client Lakka is known as to the authorization server: the one an admin entered, the one
 * registered earlier for this redirect URI, or a new dynamic registration.
 */
async function clientFor(
  ctx: McpContext,
  server: McpServerRow,
  discovered: Discovered,
): Promise<OAuthClientInformationMixed> {
  const stored = storedClient(server);
  if (
    stored !== undefined &&
    (server.oauthClientSource === 'admin' || stored.redirectUri === redirectUri(ctx))
  ) {
    return stored.client;
  }
  if (discovered.metadata.registration_endpoint === undefined) {
    throw new McpOAuthClientRequiredError(
      "the server's authorization server does not register clients itself; an administrator needs to enter one",
    );
  }
  let client: OAuthClientInformationMixed;
  try {
    client = await registerClient(discovered.authorizationServerUrl, {
      metadata: discovered.metadata,
      clientMetadata: {
        client_name: 'Lakka',
        redirect_uris: [redirectUri(ctx)],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: authMethod(discovered.metadata),
      },
      ...(discovered.scope === undefined ? {} : { scope: discovered.scope }),
      fetchFn: discovered.fetchFn,
    });
  } catch (error) {
    throw new McpOAuthFailedError("the server's authorization server refused to register Lakka", {
      cause: error,
    });
  }
  const record: StoredClient = { client, redirectUri: redirectUri(ctx) };
  await setMcpOAuthClient(
    ctx.db,
    server.workspaceId,
    server.id,
    JSON.stringify(record),
    'registered',
  );
  return client;
}

/** Starts connecting the caller's account; the result is where to send them. */
export async function startMcpConnection(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<McpConnectStartView> {
  requirePerson(principal);
  const server = await oauthServer(ctx, principal, workspaceId, serverId);
  const discovered = await discover(ctx, server);
  const clientInformation = await clientFor(ctx, server, discovered);
  const state = randomBytes(32).toString('base64url');
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    discovered.authorizationServerUrl,
    {
      metadata: discovered.metadata,
      clientInformation,
      redirectUrl: redirectUri(ctx),
      state,
      resource: discovered.resource,
      ...(discovered.scope === undefined ? {} : { scope: discovered.scope }),
    },
  );
  await insertMcpOAuthState(ctx.db, {
    stateHash: hashState(state),
    mcpServerId: server.id,
    workspaceId,
    principalId: principal.actingUserId,
    codeVerifier,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return { authorizationUrl: authorizationUrl.toString() };
}

const expiry = (tokens: OAuthTokens) =>
  tokens.expires_in === undefined ? null : new Date(Date.now() + tokens.expires_in * 1000);

/**
 * The authorization server sent the person back with an error, such as a declined consent: the
 * authorization in progress is dropped, and its workspace returned so the person lands back where
 * they started. Nothing is returned for a state that is not theirs or no longer pending.
 */
export async function abandonMcpConnection(
  ctx: McpContext,
  principal: Principal,
  state: string,
): Promise<{ workspaceId: string; serverId: string } | undefined> {
  requirePerson(principal);
  const pending = await takeMcpOAuthState(ctx.db, hashState(state));
  if (pending === undefined || pending.principalId !== principal.actingUserId) return undefined;
  return { workspaceId: pending.workspaceId, serverId: pending.mcpServerId };
}

/**
 * Finishes connecting, from the authorization server's redirect. Resolves to the workspace and
 * server, for sending the person back to the right page.
 */
export async function completeMcpConnection(
  ctx: McpContext,
  principal: Principal,
  callback: { state: string; code: string; iss: string | undefined },
): Promise<{ workspaceId: string; serverName: string }> {
  requirePerson(principal);
  const pending = await takeMcpOAuthState(ctx.db, hashState(callback.state));
  // Someone else's authorization, or an expired or replayed one, is the same as none.
  if (pending === undefined || pending.principalId !== principal.actingUserId) {
    throw new InvalidRequestError('this authorization is not yours, or has expired; start again');
  }
  const server = await oauthServer(ctx, principal, pending.workspaceId, pending.mcpServerId);
  const discovered = await discover(ctx, server);
  const stored = storedClient(server);
  if (stored === undefined)
    throw new McpOAuthFailedError('the client registration was removed; start again');
  let tokens: OAuthTokens;
  try {
    tokens = await exchangeAuthorization(discovered.authorizationServerUrl, {
      metadata: discovered.metadata,
      clientInformation: stored.client,
      authorizationCode: callback.code,
      ...(callback.iss === undefined ? {} : { iss: callback.iss }),
      codeVerifier: pending.codeVerifier,
      redirectUri: redirectUri(ctx),
      resource: discovered.resource,
      fetchFn: discovered.fetchFn,
    });
  } catch (error) {
    throw new McpOAuthFailedError("the server's authorization server refused the authorization", {
      cause: error,
    });
  }
  await saveUserMcpCredential(ctx.db, server.id, principal.actingUserId, {
    secret: tokens.access_token,
    refreshSecret: tokens.refresh_token ?? null,
    expiresAt: expiry(tokens),
  });
  return { workspaceId: server.workspaceId, serverName: server.name };
}

/** Forgets the caller's credential for a server. */
export async function disconnectMcpServer(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<void> {
  requirePerson(principal);
  await oauthServer(ctx, principal, workspaceId, serverId);
  if (!(await deleteUserMcpCredential(ctx.db, workspaceId, serverId, principal.actingUserId))) {
    throw new NotFoundError('you have not connected to this server');
  }
}

export async function listMyMcpConnections(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
): Promise<McpConnectionView[]> {
  requirePerson(principal);
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'models.use');
  return (await listMcpConnections(ctx.db, workspaceId, principal.actingUserId)).map((c) => ({
    serverId: c.serverId,
    name: c.name,
    displayName: c.displayName ?? mcpServerDisplayName(c.name),
    authMode: c.authMode,
    hasSharedCredential: c.hasSharedCredential,
    connected: c.connected,
    expiresAt: c.expiresAt?.toISOString() ?? null,
  }));
}

/** The credential a request uses with a server, and whose it is (TL-2, TL-6). */
export type ResolvedMcpCredential =
  | { secret: string | null; credentialPrincipalId: string | null }
  | 'missing';

/**
 * Which credential to use with `server` for a request by `principal`: none, the shared one (as
 * the admin who set it), or the acting person's own, refreshed if it is about to expire. A key
 * uses its owner's (invariant 2). 'missing' when the credential the server needs is not there.
 */
export async function resolveMcpCredential(
  ctx: McpContext,
  principal: Principal,
  server: McpServerRow,
): Promise<ResolvedMcpCredential> {
  if (server.authMode === 'none') return { secret: null, credentialPrincipalId: null };
  if (server.authMode === 'shared') {
    const shared = await findSharedMcpCredential(ctx.db, server.workspaceId, server.id);
    return shared === undefined
      ? 'missing'
      : { secret: shared.secret, credentialPrincipalId: shared.principalId };
  }
  const own = await findUserMcpCredential(
    ctx.db,
    server.workspaceId,
    server.id,
    principal.actingUserId,
  );
  if (own === undefined) return 'missing';
  if (fresh(own.expiresAt))
    return { secret: own.secret, credentialPrincipalId: principal.actingUserId };
  if (own.refreshSecret === null) {
    await deleteUserMcpCredential(ctx.db, server.workspaceId, server.id, principal.actingUserId);
    return 'missing';
  }
  const refreshed = await refreshUserMcpCredential(ctx.db, own.id, async (current) => {
    // Another request may have refreshed it while this one waited for the lock.
    if (fresh(current.expiresAt)) return 'keep';
    if (current.refreshSecret === null) return null;
    const discovered = await discover(ctx, server);
    const stored = storedClient(server);
    if (stored === undefined) return null;
    try {
      const tokens = await refreshAuthorization(discovered.authorizationServerUrl, {
        metadata: discovered.metadata,
        clientInformation: stored.client,
        refreshToken: current.refreshSecret,
        resource: discovered.resource,
        fetchFn: discovered.fetchFn,
      });
      return {
        secret: tokens.access_token,
        // Servers that do not rotate refresh tokens keep the old one working.
        refreshSecret: tokens.refresh_token ?? current.refreshSecret,
        expiresAt: expiry(tokens),
      };
    } catch (error) {
      // A refused refresh token will not start working again: the person reconnects.
      if (error instanceof OAuthError) return null;
      throw error;
    }
  });
  return refreshed === undefined
    ? 'missing'
    : { secret: refreshed.secret, credentialPrincipalId: principal.actingUserId };
}

/** Connects with the caller's own credential and lists the server's tools (TL-2). */
export async function testMyMcpConnection(
  ctx: McpContext,
  principal: Principal,
  workspaceId: string,
  serverId: string,
): Promise<McpServerTestView> {
  requirePerson(principal);
  const server = await oauthServer(ctx, principal, workspaceId, serverId);
  return testWith(ctx, principal, server);
}
