import { listProviderSecrets } from '@lakka/db';
import type { Db } from '@lakka/db';
import { probeProvider } from '../gateway/probe.ts';
import type { ProbeResult } from '../gateway/probe.ts';
import type { ProviderConnection } from '../gateway/providers.ts';
import { HealthCheckFailure } from '../health.ts';
import type { HealthCheck } from '../health.ts';

/*
 * Provider reachability for /healthz (AD-5, NF-O4, ADR 0081). Each instance credential is probed
 * with the same free model listing a credential test uses, so a health check never spends
 * money. /healthz is polled every few seconds by the container healthcheck, so a result stands
 * for a minute and concurrent checks share one probe: a provider sees at most one listing per
 * credential per minute from this, however often anyone asks.
 *
 * Workspace credentials are not probed: /healthz is unauthenticated, and which workspaces have
 * their own keys, and whether those work, is theirs to see on their provider page.
 */

export interface ProbedCredential {
  name: string;
  /** Changes when the credential does, so an edited one is probed again at once. */
  version: string;
  connection: ProviderConnection;
}

export interface ProviderHealthOptions {
  list: () => Promise<ProbedCredential[]>;
  timeoutMs: number;
  /** How long a probe's result stands. */
  ttlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export const PROVIDER_HEALTH_TTL_MS = 60_000;

/** One check per credential, named `provider:<name>`, listed afresh on every call. */
export function providerHealthChecks(
  options: ProviderHealthOptions,
): () => Promise<Record<string, HealthCheck>> {
  const ttlMs = options.ttlMs ?? PROVIDER_HEALTH_TTL_MS;
  const now = options.now ?? Date.now;
  const probes = new Map<string, { version: string; at: number; result: Promise<ProbeResult> }>();

  const probe = (credential: ProbedCredential): Promise<ProbeResult> => {
    const cached = probes.get(credential.name);
    if (cached !== undefined && cached.version === credential.version) {
      if (now() - cached.at < ttlMs) return cached.result;
    }
    const result = probeProvider(credential.connection, {
      timeoutMs: options.timeoutMs,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    probes.set(credential.name, { version: credential.version, at: now(), result });
    return result;
  };

  return async () => {
    const credentials = await options.list();
    const listed = new Set(credentials.map((c) => c.name));
    for (const name of probes.keys()) if (!listed.has(name)) probes.delete(name);
    return Object.fromEntries(
      credentials.map((credential): [string, HealthCheck] => [
        `provider:${credential.name}`,
        async () => {
          const { status } = await probe(credential);
          if (status !== 'ok') throw new HealthCheckFailure(status);
        },
      ]),
    );
  };
}

/** The instance's own credentials, from Postgres. */
export function instanceProviderHealthChecks(ctx: {
  db: Db;
  timeoutMs: number;
  fetch?: typeof fetch;
}): () => Promise<Record<string, HealthCheck>> {
  return providerHealthChecks({
    timeoutMs: ctx.timeoutMs,
    ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
    list: async () =>
      (await listProviderSecrets(ctx.db, null)).map((row) => ({
        name: row.name,
        version: `${row.id}:${row.updatedAt.toISOString()}`,
        connection: {
          kind: row.kind,
          name: row.name,
          ...(row.apiKey === null ? {} : { apiKey: row.apiKey }),
          ...(row.baseUrl === null ? {} : { baseURL: row.baseUrl }),
        },
      })),
  });
}
