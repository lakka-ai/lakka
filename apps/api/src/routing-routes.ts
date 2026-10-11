import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  candidateParams,
  candidatesQuery,
  overridesQuery,
  routeBody,
  routeParams,
  routingSettingsBody,
  tryPhraseBody,
  workspaceParams,
} from '@lakka/contracts';
import {
  changeRoute,
  changeRoutingSettings,
  createRoute,
  describeRequestable,
  dismissCandidate,
  getOverrideSummary,
  getRoutingPolicy,
  listCandidates,
  listWorkspaceModels,
  removeRoute,
  tryPhrase,
} from '@lakka/core';
import type { AuthContext, Logger, LogFields, RoutingContext } from '@lakka/core';
import { principalOf, requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * A workspace's routing policy and the models it can use (RT-1, RT-2, RT-11, ADR 0042). Core
 * authorizes; these only validate and translate. Log lines record who changed the policy, never
 * example phrasings, and never a route example candidate's text (ADR 0114): only its id.
 */

export interface RoutingRoutesOptions {
  auth: AuthContext;
  routing: RoutingContext;
  logger: Logger;
}

/** How many candidates a save added (ADR 0114); their ids are in route_candidate_decisions. */
const added = (ids: readonly string[] | undefined): LogFields =>
  ids === undefined || ids.length === 0 ? {} : { candidates_added: new Set(ids).size };

export const routingRoutes: FastifyPluginAsync<RoutingRoutesOptions> = async (
  app,
  { auth, routing, logger },
) => {
  const preHandler = requirePrincipal(auth);
  const audit = (
    event: string,
    request: FastifyRequest,
    workspaceId: string,
    fields: LogFields = {},
  ) =>
    logger.info(event, {
      principal_id: principalOf(request).actingUserId,
      workspace_id: workspaceId,
      ...fields,
    });

  app.get('/api/workspaces/:workspaceId/models', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { models: await listWorkspaceModels(routing, principalOf(request), workspaceId) };
    },
  });

  // What chat may ask for and which files each choice reads (CH-5, ADR 0062).
  app.get('/api/workspaces/:workspaceId/requestable', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return describeRequestable(routing, principalOf(request), workspaceId);
    },
  });

  app.get('/api/workspaces/:workspaceId/routing', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return getRoutingPolicy(routing, principalOf(request), workspaceId);
    },
  });

  app.get('/api/workspaces/:workspaceId/routing/overrides', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const { days } = parse(overridesQuery, request.query);
      return getOverrideSummary(routing, principalOf(request), workspaceId, days);
    },
  });

  // Candidate route examples (RT-10, ADR 0114): read from what is kept, while capture is on.
  app.get('/api/workspaces/:workspaceId/routing/candidates', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const { days } = parse(candidatesQuery, request.query);
      return listCandidates(routing, principalOf(request), workspaceId, days);
    },
  });

  app.post('/api/workspaces/:workspaceId/routing/candidates/:messageId/dismiss', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, messageId } = parse(candidateParams, request.params);
      await dismissCandidate(routing, principalOf(request), workspaceId, messageId);
      audit('routing.candidate_dismissed', request, workspaceId, { message_id: messageId });
      return reply.status(204).send();
    },
  });

  // The phrase is scored and forgotten: not stored, not logged.
  app.post('/api/workspaces/:workspaceId/routing/try', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const { text } = parse(tryPhraseBody, request.body);
      return tryPhrase(routing, principalOf(request), workspaceId, text);
    },
  });

  app.put('/api/workspaces/:workspaceId/routing/settings', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const body = parse(routingSettingsBody, request.body);
      const policy = await changeRoutingSettings(routing, principalOf(request), workspaceId, body);
      audit('routing.settings_changed', request, workspaceId);
      return policy;
    },
  });

  app.post('/api/workspaces/:workspaceId/routes', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const body = parse(routeBody, request.body);
      const route = await createRoute(routing, principalOf(request), workspaceId, body);
      audit('routing.route_created', request, workspaceId, added(body.fromCandidates));
      return reply.status(201).send({ route });
    },
  });

  app.put('/api/workspaces/:workspaceId/routes/:routeId', {
    preHandler,
    handler: async (request) => {
      const { workspaceId, routeId } = parse(routeParams, request.params);
      const body = parse(routeBody, request.body);
      const route = await changeRoute(routing, principalOf(request), workspaceId, routeId, body);
      audit('routing.route_changed', request, workspaceId, added(body.fromCandidates));
      return { route };
    },
  });

  app.delete('/api/workspaces/:workspaceId/routes/:routeId', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, routeId } = parse(routeParams, request.params);
      await removeRoute(routing, principalOf(request), workspaceId, routeId);
      audit('routing.route_removed', request, workspaceId);
      return reply.status(204).send();
    },
  });
};
