import type { FastifyPluginAsync } from 'fastify';
import { completeSetupBody, setupCodeBody } from '@lakka/contracts';
import { completeFirstRunSetup, getSetupStatus, revealSetupSecrets } from '@lakka/core';
import type { Logger, RateLimitStorage, SetupContext } from '@lakka/core';
import { throttle } from './throttle.ts';
import { parse } from './validate.ts';

/*
 * First-run setup (AD-1, ADR 0034). Public by necessity: nobody can sign in yet. Everything but
 * the status needs the setup code, and attempts are throttled per address.
 */

export interface SetupRoutesOptions {
  context: SetupContext;
  rateLimit: RateLimitStorage;
  logger: Logger;
}

export const setupRoutes: FastifyPluginAsync<SetupRoutesOptions> = async (
  app,
  { context, rateLimit, logger },
) => {
  const preHandler = throttle(rateLimit, { name: 'setup', windowSeconds: 60, max: 10 });

  app.get('/api/setup', async () => getSetupStatus(context));

  app.post('/api/setup/secrets', {
    preHandler,
    handler: async (request, reply) => {
      const { code } = parse(setupCodeBody, request.body);
      const secrets = await revealSetupSecrets(context, code);
      return reply.header('cache-control', 'no-store').send(secrets);
    },
  });

  app.post('/api/setup', {
    preHandler,
    handler: async (request, reply) => {
      const input = parse(completeSetupBody, request.body);
      const { principalId, workspace, sessionCookies } = await completeFirstRunSetup(
        context,
        input,
      );
      logger.info('setup.completed', { principal_id: principalId, workspace_id: workspace.id });
      // The new admin is signed in by this response (ADR 0034).
      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .header('set-cookie', sessionCookies)
        .send({ workspace });
    },
  });
};
