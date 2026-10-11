import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { FastifyPluginAsync } from 'fastify';
import type { HealthReport } from '@lakka/contracts';
import {
  diagnosticsEntries,
  diagnosticsFilename,
  requireInstanceAdmin,
  tarStream,
} from '@lakka/core';
import type {
  AuthContext,
  CacheClient,
  ClassifierRuntime,
  Config,
  Logger,
  SandboxFacts,
} from '@lakka/core';
import type { Pool } from '@lakka/db';
import { requirePrincipal } from './auth-routes.ts';

/* The diagnostics bundle, for instance admins to attach to a support request (AD-3, ADR 0083). */

export interface DiagnosticsRoutesOptions {
  auth: AuthContext;
  pool: Pool;
  cache: CacheClient;
  config: Config;
  classifier: ClassifierRuntime;
  health: () => Promise<HealthReport>;
  /** How the stdio sandbox is, as the api reaches it (ADR 0118). */
  sandbox?: () => Promise<SandboxFacts>;
  logger: Logger;
}

export const diagnosticsRoutes: FastifyPluginAsync<DiagnosticsRoutesOptions> = async (
  app,
  options,
) => {
  app.get('/api/diagnostics', {
    preHandler: requirePrincipal(options.auth),
    handler: async (request, reply) => {
      // requirePrincipal ran as preHandler and throws if it cannot set this.
      if (request.principal === null) throw new Error('requirePrincipal did not run');
      requireInstanceAdmin(request.principal);
      const now = new Date();
      options.logger.info('diagnostics.generated', { actor_id: request.principal.actingUserId });
      const gzip = createGzip();
      pipeline(
        Readable.from(
          tarStream(
            diagnosticsEntries({
              pool: options.pool,
              cache: options.cache,
              config: options.config,
              classifier: options.classifier,
              health: options.health,
              ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
              generatedBy: { via: 'api', principalId: request.principal.actingUserId },
              now,
            }),
          ),
        ),
        gzip,
      ).catch((error: unknown) => {
        // Headers are gone by now: the download ends short, and the log says why.
        options.logger.error('diagnostics.failed', {}, error);
      });
      return reply
        .header('content-type', 'application/gzip')
        .header('content-disposition', `attachment; filename="${diagnosticsFilename(now)}"`)
        .header('cache-control', 'no-store')
        .send(gzip);
    },
  });
};
