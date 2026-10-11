import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  contentCaptureBody,
  createWorkspaceBody,
  deleteWorkspaceBody,
  memberParams,
  requestListQuery,
  requestParams,
  setMemberBody,
  updateWorkspaceBody,
  workspaceParams,
} from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import {
  changeContentCapture,
  createWorkspace,
  deleteWorkspace,
  getContentCapture,
  getRequestTrace,
  getWorkspace,
  listRequests,
  listWorkspaceMembers,
  listWorkspaces,
  removeWorkspaceMember,
  setWorkspaceMember,
  updateWorkspace,
} from '@lakka/core';
import type { AuthContext, Logger } from '@lakka/core';
import { requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * Workspace and membership endpoints (ID-3, ID-4). Thin adapters: validate at the boundary,
 * then call core, which authorizes (CLAUDE.md invariant 1). The workspace always comes from the
 * path, never from a body field. Also the workspace's content capture setting (OB-4, ADR 0077):
 * everyone in it may see it, and only its admins may change it.
 */

function principalOf(request: FastifyRequest): Principal {
  // requirePrincipal runs as preHandler on every route here and throws if it cannot set this.
  if (request.principal === null) throw new Error('requirePrincipal did not run');
  return request.principal;
}

export const workspaceRoutes: FastifyPluginAsync<{ context: AuthContext; logger: Logger }> = async (
  app,
  { context, logger },
) => {
  const preHandler = requirePrincipal(context);
  const ctx = context;

  app.get('/api/workspaces', {
    preHandler,
    handler: async (request) => ({ workspaces: await listWorkspaces(ctx, principalOf(request)) }),
  });

  app.post('/api/workspaces', {
    preHandler,
    handler: async (request, reply) => {
      const body = parse(createWorkspaceBody, request.body);
      const workspace = await createWorkspace(ctx, principalOf(request), body);
      return reply.status(201).send({ workspace });
    },
  });

  app.get('/api/workspaces/:workspaceId', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { workspace: await getWorkspace(ctx, principalOf(request), workspaceId) };
    },
  });

  app.patch('/api/workspaces/:workspaceId', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const body = parse(updateWorkspaceBody, request.body);
      return { workspace: await updateWorkspace(ctx, principalOf(request), workspaceId, body) };
    },
  });

  // ID-8, ADR 0104: instance admins only, with the workspace's name typed again.
  app.delete('/api/workspaces/:workspaceId', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const body = parse(deleteWorkspaceBody, request.body);
      const actor = principalOf(request);
      const { memberIds, keyPrincipalIds } = await deleteWorkspace(ctx, actor, workspaceId, body);
      logger.info('workspace.deleted', {
        workspace_id: workspaceId,
        actor_id: actor.actingUserId,
        count: memberIds.length + keyPrincipalIds.length,
      });
      return reply.status(204).send();
    },
  });

  app.get('/api/workspaces/:workspaceId/content-capture', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { capture: await getContentCapture(ctx, principalOf(request), workspaceId) };
    },
  });

  app.put('/api/workspaces/:workspaceId/content-capture', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const body = parse(contentCaptureBody, request.body);
      return {
        capture: await changeContentCapture(
          { ...ctx, logger },
          principalOf(request),
          workspaceId,
          body,
        ),
      };
    },
  });

  // Traces (OB-1, ADR 0079): the request list, and one request's trace.
  app.get('/api/workspaces/:workspaceId/requests', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const query = parse(requestListQuery, request.query);
      return listRequests(ctx, principalOf(request), workspaceId, query);
    },
  });

  app.get('/api/workspaces/:workspaceId/requests/:requestId', {
    preHandler,
    handler: async (request) => {
      const { workspaceId, requestId } = parse(requestParams, request.params);
      return { trace: await getRequestTrace(ctx, principalOf(request), workspaceId, requestId) };
    },
  });

  app.get('/api/workspaces/:workspaceId/members', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { members: await listWorkspaceMembers(ctx, principalOf(request), workspaceId) };
    },
  });

  app.put('/api/workspaces/:workspaceId/members/:principalId', {
    preHandler,
    handler: async (request) => {
      const { workspaceId, principalId } = parse(memberParams, request.params);
      const { role } = parse(setMemberBody, request.body);
      return {
        members: await setWorkspaceMember(
          ctx,
          principalOf(request),
          workspaceId,
          principalId,
          role,
        ),
      };
    },
  });

  app.delete('/api/workspaces/:workspaceId/members/:principalId', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, principalId } = parse(memberParams, request.params);
      await removeWorkspaceMember(ctx, principalOf(request), workspaceId, principalId);
      return reply.status(204).send();
    },
  });
};
