import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { deletePersonBody, instanceAdminBody, principalParams } from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import {
  deleteUser,
  exportPerson,
  listUsers,
  reactivateUser,
  setUserInstanceAdmin,
  suspendUser,
  tarStream,
} from '@lakka/core';
import type { AuthContext, Logger } from '@lakka/core';
import { requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * Instance administration of people (ID-6), including exporting and deleting everything linked
 * to a person (NF-P4, ADR 0082). Instance admins only; core enforces it.
 */

function principalOf(request: FastifyRequest): Principal {
  // requirePrincipal runs as preHandler on every route here and throws if it cannot set this.
  if (request.principal === null) throw new Error('requirePrincipal did not run');
  return request.principal;
}

export const principalRoutes: FastifyPluginAsync<{ context: AuthContext; logger: Logger }> = async (
  app,
  { context, logger },
) => {
  const preHandler = requirePrincipal(context);

  app.get('/api/users', {
    preHandler,
    handler: async (request) => ({ users: await listUsers(context, principalOf(request)) }),
  });

  app.post('/api/users/:principalId/suspend', {
    preHandler,
    handler: async (request) => {
      const { principalId } = parse(principalParams, request.params);
      return { user: await suspendUser(context, principalOf(request), principalId) };
    },
  });

  app.post('/api/users/:principalId/reactivate', {
    preHandler,
    handler: async (request) => {
      const { principalId } = parse(principalParams, request.params);
      return { user: await reactivateUser(context, principalOf(request), principalId) };
    },
  });

  app.put('/api/users/:principalId/instance-admin', {
    preHandler,
    handler: async (request) => {
      const { principalId } = parse(principalParams, request.params);
      const body = parse(instanceAdminBody, request.body);
      const actor = principalOf(request);
      const user = await setUserInstanceAdmin(context, actor, principalId, body);
      logger.info('principal.instance_admin_changed', {
        principal_id: principalId,
        actor_id: actor.actingUserId,
      });
      return { user };
    },
  });

  // A tar.gz of everything linked to the person, streamed as it is read.
  app.get('/api/users/:principalId/export', {
    preHandler,
    handler: async (request, reply) => {
      const { principalId } = parse(principalParams, request.params);
      const actor = principalOf(request);
      const archive = await exportPerson(context, actor, principalId);
      logger.info('principal.exported', {
        principal_id: archive.principalId,
        actor_id: actor.actingUserId,
      });
      const gzip = createGzip();
      pipeline(Readable.from(tarStream(archive.entries())), gzip).catch((error: unknown) => {
        // Headers are gone by now: the download ends short, and the log says why.
        logger.error('principal.export_failed', { principal_id: archive.principalId }, error);
      });
      return reply
        .header('content-type', 'application/gzip')
        .header('content-disposition', `attachment; filename="${archive.filename}"`)
        .header('cache-control', 'no-store')
        .send(gzip);
    },
  });

  app.delete('/api/users/:principalId', {
    preHandler,
    handler: async (request, reply) => {
      const { principalId } = parse(principalParams, request.params);
      const body = parse(deletePersonBody, request.body);
      const actor = principalOf(request);
      const { keyPrincipalIds } = await deleteUser(context, actor, principalId, body);
      logger.info('principal.deleted', {
        principal_id: principalId,
        actor_id: actor.actingUserId,
        count: keyPrincipalIds.length,
      });
      return reply.status(204).send();
    },
  });
};
