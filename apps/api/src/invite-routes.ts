import type { FastifyPluginAsync } from 'fastify';
import {
  acceptInviteBody,
  createInviteBody,
  inviteParams,
  inviteTokenBody,
  workspaceParams,
} from '@lakka/contracts';
import {
  acceptInviteAsPrincipal,
  acceptInviteWithNewAccount,
  authenticate,
  createInvite,
  listWorkspaceInvites,
  previewInvite,
  revokeWorkspaceInvite,
} from '@lakka/core';
import type { AuthContext, Logger, RateLimitStorage } from '@lakka/core';
import { credentialOf, principalOf, requirePrincipal } from './auth-routes.ts';
import { throttle } from './throttle.ts';
import { parse } from './validate.ts';

/*
 * Invite links (ID-7, ADR 0035). Workspace admins manage them under the workspace. Previewing
 * and accepting are public, because the person accepting may not have an account yet; the token
 * travels in the body, never in a URL, so it cannot end up in a log line.
 */

export interface InviteRoutesOptions {
  context: AuthContext;
  rateLimit: RateLimitStorage;
  logger: Logger;
}

export const inviteRoutes: FastifyPluginAsync<InviteRoutesOptions> = async (
  app,
  { context, rateLimit, logger },
) => {
  const signedIn = requirePrincipal(context);
  const throttled = throttle(rateLimit, { name: 'invite', windowSeconds: 60, max: 20 });

  app.post('/api/workspaces/:workspaceId/invites', {
    preHandler: signedIn,
    handler: async (request, reply) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const body = parse(createInviteBody, request.body);
      const created = await createInvite(context, principalOf(request), workspaceId, body);
      return reply.status(201).header('cache-control', 'no-store').send(created);
    },
  });

  app.get('/api/workspaces/:workspaceId/invites', {
    preHandler: signedIn,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { invites: await listWorkspaceInvites(context, principalOf(request), workspaceId) };
    },
  });

  app.delete('/api/workspaces/:workspaceId/invites/:inviteId', {
    preHandler: signedIn,
    handler: async (request, reply) => {
      const { workspaceId, inviteId } = parse(inviteParams, request.params);
      await revokeWorkspaceInvite(context, principalOf(request), workspaceId, inviteId);
      return reply.status(204).send();
    },
  });

  app.post('/api/invites/preview', {
    preHandler: throttled,
    handler: async (request) => {
      const { token } = parse(inviteTokenBody, request.body);
      // Signed in or not: a signed-in person is told if they are in the workspace already.
      const principal =
        request.headers.cookie === undefined
          ? null
          : await authenticate(context, credentialOf(request)).catch(() => null);
      return previewInvite(context, token, principal);
    },
  });

  // With an account in the body, a new local account is created for it. Without one, the
  // signed-in person joins; that needs a valid session or key, and keys are refused in core.
  app.post('/api/invites/accept', {
    preHandler: throttled,
    handler: async (request, reply) => {
      const { token, account } = parse(acceptInviteBody, request.body);
      let accepted: { workspaceId: string; principalId: string };
      if (account === undefined) {
        const principal = await authenticate(context, credentialOf(request));
        const { workspaceId } = await acceptInviteAsPrincipal(context, principal, token);
        accepted = { workspaceId, principalId: principal.actingUserId };
      } else {
        const created = await acceptInviteWithNewAccount(context, token, account);
        accepted = created;
        // The new account is signed in by this response (ADR 0035).
        void reply.header('cache-control', 'no-store').header('set-cookie', created.sessionCookies);
      }
      logger.info('invite.accepted', {
        workspace_id: accepted.workspaceId,
        principal_id: accepted.principalId,
      });
      return { workspaceId: accepted.workspaceId };
    },
  });
};
