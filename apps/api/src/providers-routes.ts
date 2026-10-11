import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  createProviderBody,
  providerParams,
  updateProviderBody,
  workspaceParams,
  workspaceProviderParams,
} from '@lakka/contracts';
import {
  addProvider,
  changeProvider,
  listProviders,
  providerCoverage,
  removeProvider,
  testProvider,
} from '@lakka/core';
import type { AuthContext, Logger, ProvidersContext } from '@lakka/core';
import type { ProviderScope } from '@lakka/db';
import { principalOf, requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * Model provider credentials (PR-1, PR-8, ADR 0038), for the whole instance under
 * /api/providers and for one workspace under /api/workspaces/:id/providers. Both call the same
 * core functions with a different scope; core authorizes. Responses never contain a key, and
 * log lines name who changed what, never the key.
 */

export interface ProvidersRoutesOptions {
  auth: AuthContext;
  providers: ProvidersContext;
  logger: Logger;
}

interface Scoped {
  prefix: string;
  scopeOf: (request: FastifyRequest) => ProviderScope;
  idOf: (request: FastifyRequest) => { scope: ProviderScope; providerId: string };
}

function register(
  app: FastifyInstance,
  { auth, providers, logger }: ProvidersRoutesOptions,
  { prefix, scopeOf, idOf }: Scoped,
): void {
  const preHandler = requirePrincipal(auth);
  const audit = (event: string, request: FastifyRequest, scope: ProviderScope) =>
    logger.info(event, {
      principal_id: principalOf(request).actingUserId,
      workspace_id: scope,
    });

  app.get(prefix, {
    preHandler,
    handler: async (request) => ({
      providers: await listProviders(providers, principalOf(request), scopeOf(request)),
    }),
  });

  app.post(prefix, {
    preHandler,
    handler: async (request, reply) => {
      const scope = scopeOf(request);
      const body = parse(createProviderBody, request.body);
      const provider = await addProvider(providers, principalOf(request), scope, body);
      audit('providers.created', request, scope);
      return reply.status(201).send({ provider });
    },
  });

  app.put(`${prefix}/:providerId`, {
    preHandler,
    handler: async (request) => {
      const { scope, providerId } = idOf(request);
      const body = parse(updateProviderBody, request.body);
      const provider = await changeProvider(
        providers,
        principalOf(request),
        scope,
        providerId,
        body,
      );
      audit('providers.changed', request, scope);
      return { provider };
    },
  });

  app.delete(`${prefix}/:providerId`, {
    preHandler,
    handler: async (request, reply) => {
      const { scope, providerId } = idOf(request);
      await removeProvider(providers, principalOf(request), scope, providerId);
      audit('providers.removed', request, scope);
      return reply.status(204).send();
    },
  });

  app.post(`${prefix}/:providerId/test`, {
    preHandler,
    handler: async (request) => {
      const { scope, providerId } = idOf(request);
      const result = await testProvider(providers, principalOf(request), scope, providerId);
      logger.info('providers.tested', {
        principal_id: principalOf(request).actingUserId,
        workspace_id: scope,
        status: result.status,
        status_code: result.httpStatus,
      });
      return { result };
    },
  });
}

export const providersRoutes: FastifyPluginAsync<ProvidersRoutesOptions> = async (app, options) => {
  register(app, options, {
    prefix: '/api/providers',
    scopeOf: () => null,
    idOf: (request) => ({
      scope: null,
      providerId: parse(providerParams, request.params).providerId,
    }),
  });
  // Whose key each first-party provider uses here (PR-2, ADR 0096). Registered before the
  // workspace routes so its path is not read as a provider id.
  app.get('/api/workspaces/:workspaceId/providers/coverage', {
    preHandler: requirePrincipal(options.auth),
    handler: async (request) => ({
      coverage: await providerCoverage(
        options.providers,
        principalOf(request),
        parse(workspaceParams, request.params).workspaceId,
      ),
    }),
  });
  register(app, options, {
    prefix: '/api/workspaces/:workspaceId/providers',
    scopeOf: (request) => parse(workspaceParams, request.params).workspaceId,
    idOf: (request) => {
      const { workspaceId, providerId } = parse(workspaceProviderParams, request.params);
      return { scope: workspaceId, providerId };
    },
  });
};
