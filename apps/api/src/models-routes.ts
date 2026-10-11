import type { FastifyPluginAsync } from 'fastify';
import { catalogueFeedBody, customModelBody, customModelParams } from '@lakka/contracts';
import {
  changeCatalogueFeed,
  changeCustomModel,
  checkCatalogueFeedNow,
  createCustomModel,
  getCatalogueFeed,
  listModels,
  removeCustomModel,
} from '@lakka/core';
import type { AuthContext, CatalogueFeedContext, Logger, ModelsContext } from '@lakka/core';
import { principalOf, requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * The model catalogue, custom models and price updates from the signed feed (PR-5, PR-6,
 * PR-7). Instance admins only; core decides. Price changes are logged with who made them,
 * never with the values.
 */

export interface ModelsRoutesOptions {
  auth: AuthContext;
  models: ModelsContext;
  feed: CatalogueFeedContext;
  logger: Logger;
}

export const modelsRoutes: FastifyPluginAsync<ModelsRoutesOptions> = async (
  app,
  { auth, models, feed, logger },
) => {
  const preHandler = requirePrincipal(auth);

  app.get('/api/models', {
    preHandler,
    handler: async (request) => ({ models: await listModels(models, principalOf(request)) }),
  });

  app.post('/api/models/custom', {
    preHandler,
    handler: async (request, reply) => {
      const body = parse(customModelBody, request.body);
      const principal = principalOf(request);
      const model = await createCustomModel(models, principal, body);
      logger.info('models.custom_created', { principal_id: principal.actingUserId });
      return reply.status(201).send({ model });
    },
  });

  app.put('/api/models/custom/:customModelId', {
    preHandler,
    handler: async (request) => {
      const { customModelId } = parse(customModelParams, request.params);
      const body = parse(customModelBody, request.body);
      const principal = principalOf(request);
      const model = await changeCustomModel(models, principal, customModelId, body);
      logger.info('models.custom_changed', { principal_id: principal.actingUserId });
      return { model };
    },
  });

  app.delete('/api/models/custom/:customModelId', {
    preHandler,
    handler: async (request, reply) => {
      const { customModelId } = parse(customModelParams, request.params);
      const principal = principalOf(request);
      await removeCustomModel(models, principal, customModelId);
      logger.info('models.custom_removed', { principal_id: principal.actingUserId });
      return reply.status(204).send();
    },
  });

  // Price updates (PR-6, ADR 0116): whether the server fetches the signed price feed.
  app.get('/api/models/catalogue-feed', {
    preHandler,
    handler: async (request) => ({ feed: await getCatalogueFeed(feed, principalOf(request)) }),
  });

  app.put('/api/models/catalogue-feed', {
    preHandler,
    handler: async (request) => {
      const { enabled } = parse(catalogueFeedBody, request.body);
      return { feed: await changeCatalogueFeed(feed, principalOf(request), enabled) };
    },
  });

  // The worker checks at its next run, within a minute.
  app.post('/api/models/catalogue-feed/check', {
    preHandler,
    handler: async (request, reply) =>
      reply.status(202).send({ feed: await checkCatalogueFeedNow(feed, principalOf(request)) }),
  });
};
