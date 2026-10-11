import { healthReport } from '@lakka/contracts';
import {
  classifierHealthCheck,
  HealthCheckFailure,
  instanceProviderHealthChecks,
} from '@lakka/core';
import type { CacheClient, ClassifierRuntime, HealthCheck } from '@lakka/core';
import { pingDatabase } from '@lakka/db';
import type { Db, Pool } from '@lakka/db';
import type { ServerDeps } from './server.ts';

export const HEALTH_TIMEOUT_MS = 2000;

/**
 * What /healthz checks (AD-5, NF-O4, ADR 0017, ADR 0081): the database and the cache are
 * required; the classifier and each instance provider are reported, but one of them down only
 * degrades the api, since chat and the API still work without routing or with another provider.
 */
export function apiHealthChecks(deps: {
  pool: Pool;
  db: Db;
  cache: CacheClient;
  /** The classifier, or, in the operator command, a check that asks the running api. */
  classifier: ClassifierRuntime | HealthCheck;
  timeoutMs?: number;
  /** Replaces global fetch for provider probes. Tests only. */
  fetch?: typeof fetch;
}): Pick<ServerDeps, 'healthChecks' | 'optionalHealthChecks' | 'healthTimeoutMs'> {
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const providers = instanceProviderHealthChecks({
    db: deps.db,
    timeoutMs,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  return {
    healthChecks: {
      database: () => pingDatabase(deps.pool),
      cache: () => deps.cache.ping(),
    },
    optionalHealthChecks: async () => ({
      classifier:
        typeof deps.classifier === 'function'
          ? deps.classifier
          : classifierHealthCheck(deps.classifier),
      ...(await providers()),
    }),
    healthTimeoutMs: timeoutMs,
  };
}

/**
 * The classifier's health as the running api reports it at /healthz, for the operator command
 * (ADR 0083). Loading a second copy of the model to check it would take hundreds of megabytes
 * next to the api's own, enough to have the command killed where memory is tight. Without an
 * answer from the api, the classifier is reported unreachable.
 */
export function liveApiClassifierCheck(
  healthzUrl: string,
  fetchImpl: typeof fetch = fetch,
): HealthCheck {
  return async () => {
    let body: unknown;
    try {
      const response = await fetchImpl(healthzUrl);
      body = await response.json();
    } catch {
      throw new HealthCheckFailure('unreachable');
    }
    const parsed = healthReport.safeParse(body);
    const classifier = parsed.success ? parsed.data.checks['classifier'] : undefined;
    if (classifier === undefined) throw new HealthCheckFailure('unreachable');
    if (classifier.status === 'down') {
      throw new HealthCheckFailure(classifier.error_code ?? 'unavailable');
    }
  };
}
