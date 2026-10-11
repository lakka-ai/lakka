import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  registerSsoProviderBody,
  ssoProviderParams,
  updateSsoProviderBody,
} from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import {
  listPublicSsoProviders,
  listSsoProvidersForAdmin,
  registerSsoProvider,
  removeSsoProvider,
  updateSsoProvider,
} from '@lakka/core';
import type { AuthContext } from '@lakka/core';
import { requirePrincipal, toFetchHeaders } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * Identity provider management (ID-2, AD-1). Instance admins register, edit and remove providers;
 * anyone may see which providers exist, so the sign-in page can offer them. The client secret
 * is accepted on registration and never returned (ADR 0032).
 */

function principalOf(request: FastifyRequest): Principal {
  // requirePrincipal runs as preHandler on every route here and throws if it cannot set this.
  if (request.principal === null) throw new Error('requirePrincipal did not run');
  return request.principal;
}

export const ssoRoutes: FastifyPluginAsync<{ context: AuthContext; publicUrl: string }> = async (
  app,
  { context, publicUrl },
) => {
  const preHandler = requirePrincipal(context);

  app.get('/api/sso/providers/public', {
    handler: async () => ({ providers: await listPublicSsoProviders(context) }),
  });

  app.get('/api/sso/providers', {
    preHandler,
    handler: async (request) => ({
      providers: await listSsoProvidersForAdmin(context, principalOf(request), publicUrl),
    }),
  });

  app.post('/api/sso/providers', {
    preHandler,
    handler: async (request, reply) => {
      const body = parse(registerSsoProviderBody, request.body);
      const provider = await registerSsoProvider(
        context,
        principalOf(request),
        toFetchHeaders(request.headers),
        body,
        publicUrl,
      );
      return reply.status(201).send({ provider });
    },
  });

  app.put('/api/sso/providers/:providerId', {
    preHandler,
    handler: async (request) => {
      const { providerId } = parse(ssoProviderParams, request.params);
      const body = parse(updateSsoProviderBody, request.body);
      return {
        provider: await updateSsoProvider(
          context,
          principalOf(request),
          providerId,
          body,
          publicUrl,
        ),
      };
    },
  });

  app.delete('/api/sso/providers/:providerId', {
    preHandler,
    handler: async (request, reply) => {
      const { providerId } = parse(ssoProviderParams, request.params);
      await removeSsoProvider(context, principalOf(request), providerId);
      return reply.status(204).send();
    },
  });
};
