import type { FastifyPluginAsync } from 'fastify';
import { ForbiddenError, retentionBody } from '@lakka/contracts';
import type { TraceExportView } from '@lakka/contracts';
import { changeRetention, getRetention, runRetentionNow } from '@lakka/core';
import type { AuthContext, Logger, RetentionContext } from '@lakka/core';
import { principalOf, requirePrincipal } from './auth-routes.ts';
import { parse } from './validate.ts';

/*
 * Retention for the whole instance (OB-6, NF-P5, ADR 0078), for instance admins: the periods,
 * the last enforcement's result, and a way to run it at once rather than wait for the worker's
 * daily job. Core authorizes.
 */

export interface RetentionRoutesOptions {
  auth: AuthContext;
  retention: RetentionContext;
  /** The OTLP endpoint traces also go to, if an operator set one (ADR 0080). */
  otlp: { endpoint: string } | null;
  logger: Logger;
}

export const retentionRoutes: FastifyPluginAsync<RetentionRoutesOptions> = async (
  app,
  { auth, retention, otlp, logger },
) => {
  const preHandler = requirePrincipal(auth);

  // NF-P2: whether anything leaves the instance is visible, not only configured (ADR 0080).
  app.get('/api/observability/export', {
    preHandler,
    handler: async (request) => {
      const principal = principalOf(request);
      if (principal.kind !== 'user' || !principal.isInstanceAdmin) {
        throw new ForbiddenError('only instance admins see where traces go');
      }
      const view: TraceExportView =
        otlp === null
          ? { enabled: false, destination: null }
          : { enabled: true, destination: new URL(otlp.endpoint).origin };
      return { export: view };
    },
  });

  app.get('/api/retention', {
    preHandler,
    handler: async (request) => ({
      retention: await getRetention(retention, principalOf(request)),
    }),
  });

  app.put('/api/retention', {
    preHandler,
    handler: async (request) => ({
      retention: await changeRetention(
        { db: retention.db, logger },
        principalOf(request),
        parse(retentionBody, request.body),
      ),
    }),
  });

  app.post('/api/retention/run', {
    preHandler,
    handler: async (request) => ({
      retention: await runRetentionNow(retention, principalOf(request)),
    }),
  });
};
