import type { FastifyPluginAsync } from 'fastify';
import {
  attachmentParams,
  conversationChangeBody,
  conversationParams,
  newConversationBody,
  workspaceParams,
} from '@lakka/contracts';
import {
  changeConversation,
  getAttachment,
  getConversation,
  listConversationsFor,
  removeConversation,
  startConversation,
} from '@lakka/core';
import type { AuthContext, CatalogueStore } from '@lakka/core';
import { principalOf, requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * Conversation endpoints (CH-1, CH-3, ADR 0060). Core authorizes and scopes to the conversation's
 * owner; these only validate and translate. Messages are written by /v1/chat/completions when a
 * request names a conversation (G4), not here.
 */

export const conversationRoutes: FastifyPluginAsync<{
  context: AuthContext;
  catalogue: CatalogueStore;
}> = async (app, { context: ctx, catalogue }) => {
  const preHandler = requirePrincipal(ctx);
  const base = '/api/workspaces/:workspaceId/conversations';

  app.post(base, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      const body = parse(newConversationBody, request.body ?? {});
      const conversation = await startConversation(ctx, principalOf(request), workspaceId, body);
      return reply.status(201).send({ conversation });
    },
  });

  app.get(base, {
    preHandler,
    handler: async (request) => {
      const { workspaceId } = parse(workspaceParams, request.params);
      return { conversations: await listConversationsFor(ctx, principalOf(request), workspaceId) };
    },
  });

  app.get(`${base}/:conversationId`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, conversationId } = parse(conversationParams, request.params);
      return {
        conversation: await getConversation(
          { ...ctx, catalogue },
          principalOf(request),
          workspaceId,
          conversationId,
        ),
      };
    },
  });

  app.patch(`${base}/:conversationId`, {
    preHandler,
    handler: async (request) => {
      const { workspaceId, conversationId } = parse(conversationParams, request.params);
      const change = parse(conversationChangeBody, request.body);
      return {
        conversation: await changeConversation(
          ctx,
          principalOf(request),
          workspaceId,
          conversationId,
          change,
        ),
      };
    },
  });

  app.delete(`${base}/:conversationId`, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, conversationId } = parse(conversationParams, request.params);
      await removeConversation(ctx, principalOf(request), workspaceId, conversationId);
      return reply.status(204).send();
    },
  });

  // The bytes a person uploaded, served from our origin: typed as stored, never sniffed,
  // sandboxed, and a PDF downloaded rather than opened in the page.
  app.get(`${base}/:conversationId/attachments/:attachmentId`, {
    preHandler,
    handler: async (request, reply) => {
      const { workspaceId, conversationId, attachmentId } = parse(attachmentParams, request.params);
      const file = await getAttachment(
        ctx,
        principalOf(request),
        workspaceId,
        conversationId,
        attachmentId,
      );
      const name = (file.filename ?? 'attachment').replace(/[^\w.-]/g, '_');
      return reply
        .header('content-type', file.mediaType)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=0')
        .header(
          'content-disposition',
          `${file.mediaType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${name}"`,
        )
        .send(file.data);
    },
  });
};
