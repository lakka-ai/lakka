import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { issueKeyBody, keyParams, workspaceParams } from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import { issueKey, listWorkspaceKeys, revokeWorkspaceKey } from '@lakka/core';
import type { AuthContext } from '@lakka/core';
import { requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * API key endpoints (ID-5, ID-6). The secret appears only in the response to POST; lists show the
 * prefix. Responses carrying a secret are marked no-store so no cache keeps them.
 */

function principalOf(request: FastifyRequest): Principal {
  // requirePrincipal runs as preHandler on every route here and throws if it cannot set this.
  if (request.principal === null) throw new Error('requirePrincipal did not run');
  return request.principal;
}

export const keyRoutes: FastifyPluginAsync<{ context: AuthContext }> = async (app, { context }) => {
  const preHandler = requirePrincipal(context);
  const ctx = context;

  app.post('/api/workspaces/:workspaceId/keys', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const body = parse(issueKeyBody, request.body);
      const issued = await issueKey(ctx, principalOf(request), workspaceId, body);
      return reply.status(201).header('cache-control', 'no-store').send(issued);
    },
  });

  app.get('/api/workspaces/:workspaceId/keys', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { keys: await listWorkspaceKeys(ctx, principalOf(request), workspaceId) };
    },
  });

  app.delete('/api/workspaces/:workspaceId/keys/:keyId', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, keyId } = parse(keyParams, request.params);
      await revokeWorkspaceKey(ctx, principalOf(request), workspaceId, keyId);
      return reply.status(204).send();
    },
  });
};
