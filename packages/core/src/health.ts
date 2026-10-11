import type { DependencyCheck, DependencyErrorCode, HealthReport } from '@lakka/contracts';
import type { Logger } from './logger.ts';

/** Resolves when the dependency is reachable; rejects otherwise. */
export type HealthCheck = () => Promise<void>;

/** Thrown by a check to report why it failed; any other error reports as `unreachable`. */
export class HealthCheckFailure extends Error {
  readonly code: DependencyErrorCode;
  constructor(code: DependencyErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface CheckHealthOptions {
  timeoutMs: number;
  /**
   * Reported like the others, but one of these down only degrades the status (ADR 0017). Listed
   * on each call, since the providers configured change; a listing that fails or outlasts the
   * timeout lists none, and the database check already says why.
   */
  optional?: () => Promise<Readonly<Record<string, HealthCheck>>>;
  logger?: Logger;
  now?: () => number;
}

class CheckTimeout extends Error {}

const allUp = (entries: [string, DependencyCheck][]) => entries.every(([, c]) => c.status === 'ok');

/**
 * Runs every check concurrently, each under its own timeout (AD-5, NF-O4). A check that fails
 * reports only a machine-readable code; the underlying error goes to the log, filtered.
 */
export async function checkHealth(
  checks: Readonly<Record<string, HealthCheck>>,
  options: CheckHealthOptions,
): Promise<HealthReport> {
  const now = options.now ?? (() => performance.now());
  const run = async ([name, check]: [string, HealthCheck]): Promise<[string, DependencyCheck]> => {
    const started = now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CheckTimeout()), options.timeoutMs);
        }),
      ]);
      return [name, { status: 'ok', latency_ms: elapsed(started, now) }];
    } catch (error) {
      const errorCode: DependencyErrorCode =
        error instanceof CheckTimeout
          ? 'timeout'
          : error instanceof HealthCheckFailure
            ? error.code
            : 'unreachable';
      options.logger?.warn(
        'health.dependency_down',
        { dependency: name, error_code: errorCode },
        error instanceof CheckTimeout || error instanceof HealthCheckFailure ? undefined : error,
      );
      return [name, { status: 'down', latency_ms: elapsed(started, now), error_code: errorCode }];
    } finally {
      clearTimeout(timer);
    }
  };
  const listOptional = async (): Promise<[string, DependencyCheck][]> => {
    if (options.optional === undefined) return [];
    let timer: NodeJS.Timeout | undefined;
    const listed = await Promise.race([
      options.optional(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), options.timeoutMs);
      }),
    ])
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    return Promise.all(Object.entries(listed ?? {}).map(run));
  };
  const [required, optional] = await Promise.all([
    Promise.all(Object.entries(checks).map(run)),
    listOptional(),
  ]);
  const status = !allUp(required) ? 'down' : allUp(optional) ? 'ok' : 'degraded';
  return { status, checks: Object.fromEntries([...required, ...optional]) };
}

function elapsed(started: number, now: () => number): number {
  return Math.max(0, Math.round(now() - started));
}
