import type { FastifyPluginAsync } from 'fastify';
import { passwordResetTokenBody, principalParams, usePasswordResetBody } from '@lakka/contracts';
import { createPasswordReset, previewPasswordReset, usePasswordReset } from '@lakka/core';
import type { AuthContext, Logger, RateLimitStorage } from '@lakka/core';
import { principalOf, requirePrincipal } from './auth-routes.ts';
import { throttle } from './throttle.ts';
import { parse } from './validate.ts';

/*
 * Password reset links (ADR 0098). An instance admin makes one under the person; previewing and
 * using it are public, since the person cannot sign in. The token travels in bodies, never in a
 * URL, so it cannot end up in a log line, and the new password is never logged.
 */

export interface PasswordResetRoutesOptions {
  context: AuthContext;
  rateLimit: RateLimitStorage;
  logger: Logger;
}

export const passwordResetRoutes: FastifyPluginAsync<PasswordResetRoutesOptions> = async (
  app,
  { context, rateLimit, logger },
) => {
  const signedIn = requirePrincipal(context);
  const throttled = throttle(rateLimit, { name: 'password-reset', windowSeconds: 60, max: 10 });

  app.post('/api/users/:principalId/password-reset', {
    preHandler: signedIn,
    handler: async (request, reply) => {
      const { principalId } = parse(principalParams, request.params);
      const actor = principalOf(request);
      const created = await createPasswordReset(context, actor, principalId);
      logger.info('principal.password_reset_created', {
        principal_id: principalId,
        actor_id: actor.actingUserId,
      });
      return reply.status(201).header('cache-control', 'no-store').send(created);
    },
  });

  app.post('/api/password-reset/preview', {
    preHandler: throttled,
    handler: async (request) => {
      const { token } = parse(passwordResetTokenBody, request.body);
      return previewPasswordReset(context, token);
    },
  });

  app.post('/api/password-reset', {
    preHandler: throttled,
    handler: async (request, reply) => {
      const body = parse(usePasswordResetBody, request.body);
      const { principalId } = await usePasswordReset(context, body);
      logger.info('principal.password_reset_used', { principal_id: principalId });
      return reply.status(204).send();
    },
  });
};
