import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LakkaError,
  mcpAllowedOriginBody,
  mcpOAuthClientBody,
  mcpServerChangeBody,
  mcpServerParams,
  mcpSharedCredentialBody,
  newMcpServerBody,
  toolGrantParams,
  workspaceParams,
  workspaceToolChangeBody,
  workspaceToolParams,
} from '@lakka/contracts';
import {
  abandonMcpConnection,
  addMcpServer,
  allowMcpOrigin,
  disallowMcpOrigin,
  listMcpOriginAllowlist,
  authenticate,
  changeMcpServer,
  changeWorkspaceTool,
  listAvailableTools,
  listMyToolGrants,
  listToolsForAdmin,
  listWorkspaceToolGrants,
  revokeMyToolGrant,
  revokeWorkspaceToolGrant,
  syncMcpServerTools,
  completeMcpConnection,
  disconnectMcpServer,
  listMyMcpConnections,
  MCP_OAUTH_CALLBACK_PATH,
  removeMcpServerOAuthClient,
  setMcpServerOAuthClient,
  startMcpConnection,
  testMyMcpConnection,
  getMcpServer,
  listWorkspaceMcpServers,
  removeMcpServer,
  removeMcpServerCredential,
  setMcpServerCredential,
  testMcpServer,
} from '@lakka/core';
import type { AuthContext, Logger, ToolsContext } from '@lakka/core';
import { credentialOf, principalOf, requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * A workspace's MCP servers (TL-1, ADR 0067) under /api/workspaces/:id/mcp-servers, and each
 * person's own connections to its OAuth servers (TL-2, ADR 0068) under
 * /api/workspaces/:id/mcp-connections, with the authorization servers' redirect coming back to
 * /api/mcp/oauth/callback. Core authorizes, including the instance-admin rule for stdio servers
 * (ADR 0066 Q2). Responses never contain a credential, and log lines name who changed which
 * server, never the credential. The instance's allowlist of MCP origins (NF-S4, ADR 0117) is
 * under /api/admin/mcp-origins, for instance admins.
 */

/** What the authorization server sends back: a code and our state, or an error. */
const callbackQuery = z.looseObject({
  state: z.string().max(200).optional(),
  code: z.string().max(4000).optional(),
  iss: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});

/** The web page a person lands on after authorizing, told only the outcome. */
function landing(workspaceId: string | null, result: string, server?: string): string {
  const query = new URLSearchParams({ result, ...(server === undefined ? {} : { server }) });
  return workspaceId === null
    ? `/?mcp=${result}`
    : `/workspaces/${workspaceId}/connections?${query.toString()}`;
}

export interface McpRoutesOptions {
  auth: AuthContext;
  mcp: ToolsContext;
  logger: Logger;
}

export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (
  app,
  { auth, mcp, logger },
) => {
  const preHandler = requirePrincipal(auth);
  const base = '/api/workspaces/:workspaceId/mcp-servers';
  const audit = (event: string, request: FastifyRequest, workspaceId: string) =>
    logger.info(event, {
      principal_id: principalOf(request).actingUserId,
      workspace_id: workspaceId,
    });

  app.get(base, {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { servers: await listWorkspaceMcpServers(mcp, principalOf(request), workspaceId) };
    },
  });

  app.post(base, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const server = await addMcpServer(
        mcp,
        principalOf(request),
        workspaceId,
        parse(newMcpServerBody, request.body),
      );
      audit('mcp.server_added', request, workspaceId);
      return reply.status(201).send({ server });
    },
  });

  app.get(`${base}/:serverId`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      return { server: await getMcpServer(mcp, principalOf(request), workspaceId, serverId) };
    },
  });

  app.patch(`${base}/:serverId`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      const server = await changeMcpServer(
        mcp,
        principalOf(request),
        workspaceId,
        serverId,
        parse(mcpServerChangeBody, request.body),
      );
      audit('mcp.server_changed', request, workspaceId);
      return { server };
    },
  });

  app.delete(`${base}/:serverId`, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      await removeMcpServer(mcp, principalOf(request), workspaceId, serverId);
      audit('mcp.server_removed', request, workspaceId);
      return reply.status(204).send();
    },
  });

  app.put(`${base}/:serverId/credential`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      const { secret } = parse(mcpSharedCredentialBody, request.body);
      const server = await setMcpServerCredential(
        mcp,
        principalOf(request),
        workspaceId,
        serverId,
        secret,
      );
      audit('mcp.credential_set', request, workspaceId);
      return { server };
    },
  });

  app.delete(`${base}/:serverId/credential`, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      await removeMcpServerCredential(mcp, principalOf(request), workspaceId, serverId);
      audit('mcp.credential_removed', request, workspaceId);
      return reply.status(204).send();
    },
  });

  app.post(`${base}/:serverId/test`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      return testMcpServer(mcp, principalOf(request), workspaceId, serverId);
    },
  });

  app.put(`${base}/:serverId/oauth-client`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      const server = await setMcpServerOAuthClient(
        mcp,
        principalOf(request),
        workspaceId,
        serverId,
        parse(mcpOAuthClientBody, request.body),
      );
      audit('mcp.oauth_client_set', request, workspaceId);
      return { server };
    },
  });

  app.delete(`${base}/:serverId/oauth-client`, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      await removeMcpServerOAuthClient(mcp, principalOf(request), workspaceId, serverId);
      audit('mcp.oauth_client_removed', request, workspaceId);
      return reply.status(204).send();
    },
  });

  const connections = '/api/workspaces/:workspaceId/mcp-connections';

  app.get(connections, {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { connections: await listMyMcpConnections(mcp, principalOf(request), workspaceId) };
    },
  });

  app.post(`${connections}/:serverId`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      return startMcpConnection(mcp, principalOf(request), workspaceId, serverId);
    },
  });

  app.delete(`${connections}/:serverId`, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      await disconnectMcpServer(mcp, principalOf(request), workspaceId, serverId);
      return reply.status(204).send();
    },
  });

  app.post(`${connections}/:serverId/test`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      return testMyMcpConnection(mcp, principalOf(request), workspaceId, serverId);
    },
  });

  // A top-level navigation from the authorization server: every outcome is a redirect to a page
  // that explains it, never an error body or the authorization server's own words.
  app.get(MCP_OAUTH_CALLBACK_PATH, async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    if (!query.success || query.data.state === undefined)
      return reply.redirect(landing(null, 'failed'));
    if (query.data.error !== undefined || query.data.code === undefined) {
      const result = query.data.error === 'access_denied' ? 'denied' : 'failed';
      // Back to the connections page the person started from, when the state is theirs.
      const abandoned = await authenticate(auth, credentialOf(request))
        .then((principal) => abandonMcpConnection(mcp, principal, query.data.state ?? ''))
        .catch(() => undefined);
      return reply.redirect(landing(abandoned?.workspaceId ?? null, result));
    }
    try {
      const principal = await authenticate(auth, credentialOf(request));
      const done = await completeMcpConnection(mcp, principal, {
        state: query.data.state,
        code: query.data.code,
        iss: query.data.iss,
      });
      logger.info('mcp.connected', {
        principal_id: principal.actingUserId,
        workspace_id: done.workspaceId,
      });
      return reply.redirect(landing(done.workspaceId, 'connected', done.serverName));
    } catch (error) {
      if (!(error instanceof LakkaError)) logger.warn('mcp.connect_failed', {}, error);
      return reply.redirect(landing(null, 'failed'));
    }
  });

  // The allowlist (TL-3, TL-4, ADR 0069).
  const tools = '/api/workspaces/:workspaceId/tools';

  app.get(tools, {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { tools: await listToolsForAdmin(mcp, principalOf(request), workspaceId) };
    },
  });

  app.get(`${tools}/available`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { tools: await listAvailableTools(mcp, principalOf(request), workspaceId) };
    },
  });

  app.patch(`${tools}/:toolId`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, toolId } = parse(workspaceToolParams, request.params);
      const tool = await changeWorkspaceTool(
        mcp,
        principalOf(request),
        workspaceId,
        toolId,
        parse(workspaceToolChangeBody, request.body),
      );
      audit('mcp.tool_changed', request, workspaceId);
      return { tool };
    },
  });

  app.post(`${base}/:serverId/tools/sync`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, serverId } = parse(mcpServerParams, request.params);
      const result = await syncMcpServerTools(mcp, principalOf(request), workspaceId, serverId);
      audit('mcp.tools_synced', request, workspaceId);
      return result;
    },
  });

  // Standing approvals (TL-5, ADR 0071): a person's own, and every one in the workspace for its
  // admins. Each is created by approving a call "always".
  const grants = '/api/workspaces/:workspaceId/tool-grants';
  app.get(grants, {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { grants: await listMyToolGrants(mcp, principalOf(request), workspaceId) };
    },
  });

  app.delete(`${grants}/:grantId`, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, grantId } = parse(toolGrantParams, request.params);
      await revokeMyToolGrant(mcp, principalOf(request), workspaceId, grantId);
      audit('mcp.tool_grant_revoked', request, workspaceId);
      return reply.status(204).send();
    },
  });

  app.get(`${tools}/grants`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { grants: await listWorkspaceToolGrants(mcp, principalOf(request), workspaceId) };
    },
  });

  app.delete(`${tools}/grants/:grantId`, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, grantId } = parse(toolGrantParams, request.params);
      await revokeWorkspaceToolGrant(mcp, principalOf(request), workspaceId, grantId);
      audit('mcp.tool_grant_revoked', request, workspaceId);
      return reply.status(204).send();
    },
  });

  const origins = '/api/admin/mcp-origins';
  const adminAudit = (event: string, request: FastifyRequest) =>
    logger.info(event, { principal_id: principalOf(request).actingUserId });

  app.get(origins, {
    preHandler,
    handler: async (request) => ({
      allowlist: await listMcpOriginAllowlist(mcp, principalOf(request)),
    }),
  });

  app.post(origins, {
    preHandler,
    handler: async (request, reply) => {
      const { origin } = parse(mcpAllowedOriginBody, request.body);
      const added = await allowMcpOrigin(mcp, principalOf(request), origin);
      if (added) adminAudit('mcp.origin_allowed', request);
      return reply
        .status(added ? 201 : 200)
        .send({ allowlist: await listMcpOriginAllowlist(mcp, principalOf(request)) });
    },
  });

  // The origin is in the query: it is an address with slashes in it, not a path segment.
  app.delete(origins, {
    preHandler,
    handler: async (request, reply) => {
      const { origin } = parse(mcpAllowedOriginBody, request.query);
      await disallowMcpOrigin(mcp, principalOf(request), origin);
      adminAudit('mcp.origin_removed', request);
      return reply.status(204).send();
    },
  });
};
