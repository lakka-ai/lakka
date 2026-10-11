import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  alertWebhookBody,
  budgetBody,
  keyParams,
  memberBudgetParams,
  spendQuery,
  workspaceParams,
} from '@lakka/contracts';
import {
  budgetStatus,
  getAlertWebhook,
  listAlertHistory,
  getInstanceBudget,
  getInstanceSpend,
  getWorkspaceSpend,
  listBudgets,
  remainingBudget,
  removeInstanceBudget,
  removeKeyBudget,
  removeMemberBudget,
  removeWebhook,
  removeWorkspaceBudget,
  rotateWebhookSecret,
  sendTestAlert,
  setInstanceBudget,
  setKeyBudget,
  setMemberBudget,
  setWebhook,
  setWebhookUrl,
  setWorkspaceBudget,
} from '@lakka/core';
import type { AuthContext, CacheClient, CatalogueStore, Logger } from '@lakka/core';
import { principalOf, requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * Budget endpoints (BG-1, BG-9, ADR 0049). Core authorizes; these only validate and translate.
 * Each change is logged with who made it and to which scope.
 */

/** How long Budgets cannot be checked waits for the budget store before saying so. */
const STATUS_TIMEOUT_MS = 2000;

export const budgetRoutes: FastifyPluginAsync<{
  context: AuthContext;
  catalogue: CatalogueStore;
  cache: CacheClient;
  logger: Logger;
}> = async (app, { context: ctx, catalogue, cache, logger }) => {
  const preHandler = requirePrincipal(ctx);
  const audit = (request: FastifyRequest, scope: string, workspaceId: string | null) =>
    logger.info('budget.changed', {
      principal_id: principalOf(request).actingUserId,
      scope,
      ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
    });

  app.get('/api/budgets/instance', {
    preHandler,
    handler: async (request) => ({ budget: await getInstanceBudget(ctx, principalOf(request)) }),
  });
  app.put('/api/budgets/instance', {
    preHandler,
    handler: async (request) => {
      const budget = await setInstanceBudget(
        ctx,
        principalOf(request),
        parse(budgetBody, request.body),
      );
      audit(request, 'instance', null);
      return { budget };
    },
  });
  app.delete('/api/budgets/instance', {
    preHandler,
    handler: async (request, reply) => {
      await removeInstanceBudget(ctx, principalOf(request));
      audit(request, 'instance', null);
      return reply.status(204).send();
    },
  });

  app.get('/api/workspaces/:workspaceId/budgets', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return listBudgets(ctx, principalOf(request), workspaceId);
    },
  });

  // Whether requests can be held against budgets now (BG-4), for the Budgets cannot be checked
  // banner. The store is asked with a short timeout, so the answer comes even when it hangs.
  app.get('/api/workspaces/:workspaceId/budgets/status', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return {
        status: await budgetStatus(ctx, principalOf(request), workspaceId, () =>
          Promise.race([
            cache.ping(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('timed out')), STATUS_TIMEOUT_MS).unref();
            }),
          ]),
        ),
      };
    },
  });

  app.get('/api/workspaces/:workspaceId/budgets/remaining', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { remaining: await remainingBudget(ctx, principalOf(request), workspaceId) };
    },
  });

  app.put('/api/workspaces/:workspaceId/budgets/workspace', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const budget = await setWorkspaceBudget(
        ctx,
        principalOf(request),
        workspaceId,
        parse(budgetBody, request.body),
      );
      audit(request, 'workspace', workspaceId);
      return { budget };
    },
  });
  app.delete('/api/workspaces/:workspaceId/budgets/workspace', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      await removeWorkspaceBudget(ctx, principalOf(request), workspaceId);
      audit(request, 'workspace', workspaceId);
      return reply.status(204).send();
    },
  });

  app.put('/api/workspaces/:workspaceId/budgets/members/:principalId', {
    preHandler,
    handler: async (request) => {
      const { workspaceId, principalId } = parse(memberBudgetParams, request.params);
      const budget = await setMemberBudget(
        ctx,
        principalOf(request),
        workspaceId,
        principalId,
        parse(budgetBody, request.body),
      );
      audit(request, 'member', workspaceId);
      return { budget };
    },
  });
  app.delete('/api/workspaces/:workspaceId/budgets/members/:principalId', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, principalId } = parse(memberBudgetParams, request.params);
      await removeMemberBudget(ctx, principalOf(request), workspaceId, principalId);
      audit(request, 'member', workspaceId);
      return reply.status(204).send();
    },
  });

  app.put('/api/workspaces/:workspaceId/budgets/keys/:keyId', {
    preHandler,
    handler: async (request) => {
      const { workspaceId, keyId } = parse(keyParams, request.params);
      const budget = await setKeyBudget(
        ctx,
        principalOf(request),
        workspaceId,
        keyId,
        parse(budgetBody, request.body),
      );
      audit(request, 'key', workspaceId);
      return { budget };
    },
  });
  app.delete('/api/workspaces/:workspaceId/budgets/keys/:keyId', {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, keyId } = parse(keyParams, request.params);
      await removeKeyBudget(ctx, principalOf(request), workspaceId, keyId);
      audit(request, 'key', workspaceId);
      return reply.status(204).send();
    },
  });

  // Alert webhooks (BG-10, ADR 0054). The signing secret is in the response to PUT only.
  const webhookRoutes = (path: string, workspaceOf: (request: FastifyRequest) => string | null) => {
    app.get(path, {
      preHandler,
      handler: async (request) => ({
        webhook: await getAlertWebhook(ctx, principalOf(request), workspaceOf(request)),
      }),
    });
    app.put(path, {
      preHandler,
      handler: async (request, reply) => {
        const workspaceId = workspaceOf(request);
        const created = await setWebhook(
          ctx,
          principalOf(request),
          workspaceId,
          parse(alertWebhookBody, request.body),
        );
        logger.info('budget.webhook_set', {
          principal_id: principalOf(request).actingUserId,
          ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
        });
        return reply.status(201).header('cache-control', 'no-store').send(created);
      },
    });
    // A new address keeps the secret, so the receiver needs no change.
    app.patch(path, {
      preHandler,
      handler: async (request) => {
        const workspaceId = workspaceOf(request);
        const webhook = await setWebhookUrl(
          ctx,
          principalOf(request),
          workspaceId,
          parse(alertWebhookBody, request.body),
        );
        logger.info('budget.webhook_set', {
          principal_id: principalOf(request).actingUserId,
          ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
        });
        return { webhook };
      },
    });
    app.post(`${path}/secret`, {
      preHandler,
      handler: async (request, reply) => {
        const workspaceId = workspaceOf(request);
        const created = await rotateWebhookSecret(ctx, principalOf(request), workspaceId);
        logger.info('budget.webhook_secret_rotated', {
          principal_id: principalOf(request).actingUserId,
          ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
        });
        return reply.status(201).header('cache-control', 'no-store').send(created);
      },
    });
    app.post(`${path}/test`, {
      preHandler,
      handler: async (request) => ({
        result: await sendTestAlert({ ...ctx, logger }, principalOf(request), workspaceOf(request)),
      }),
    });
    app.delete(path, {
      preHandler,
      handler: async (request, reply) => {
        await removeWebhook(ctx, principalOf(request), workspaceOf(request));
        return reply.status(204).send();
      },
    });
  };
  // Their delivery history (BG-10, ADR 0079).
  app.get('/api/budgets/alerts', {
    preHandler,
    handler: async (request) => ({
      alerts: await listAlertHistory(ctx, principalOf(request), null),
    }),
  });
  app.get('/api/workspaces/:workspaceId/budgets/alerts', {
    preHandler,
    handler: async (request) => ({
      alerts: await listAlertHistory(
        ctx,
        principalOf(request),
        parse(workspaceParams, request.params).workspaceId,
      ),
    }),
  });
  webhookRoutes('/api/budgets/webhook', () => null);
  webhookRoutes(
    '/api/workspaces/:workspaceId/budgets/webhook',
    (request) => parse(workspaceParams, request.params).workspaceId,
  );

  // The spend view (BG-11, ADR 0055).
  app.get('/api/spend', {
    preHandler,
    handler: async (request) =>
      getInstanceSpend(
        { ...ctx, catalogue },
        principalOf(request),
        parse(spendQuery, request.query),
      ),
  });
  app.get('/api/workspaces/:workspaceId/spend', {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return getWorkspaceSpend(
        { ...ctx, catalogue },
        principalOf(request),
        workspaceId,
        parse(spendQuery, request.query),
      );
    },
  });
};
