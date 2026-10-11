import { z } from 'zod';

export const dependencyStatus = z.enum(['ok', 'down']);
export type DependencyStatus = z.infer<typeof dependencyStatus>;

/**
 * Why a dependency is down. Never a raw driver message.
 * - timeout, unreachable: no answer in time, or no connection at all
 * - auth_failed: a provider refused the credential (401 or 403)
 * - error: a provider answered with another error status
 * - unavailable: the classifier could not be loaded
 */
export const dependencyErrorCode = z.enum([
  'timeout',
  'unreachable',
  'auth_failed',
  'error',
  'unavailable',
]);
export type DependencyErrorCode = z.infer<typeof dependencyErrorCode>;

export const dependencyCheck = z.object({
  status: dependencyStatus,
  latency_ms: z.number().int().nonnegative(),
  /** Machine-readable reason when status is 'down'. */
  error_code: dependencyErrorCode.optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheck>;

/**
 * AD-5, NF-O4: reachability per component, so an operator can tell a provider outage from a
 * database problem. Database and cache are required: either down makes the status 'down'. The
 * classifier and each instance provider, keyed `provider:<name>`, are not: one of them down
 * makes it 'degraded' (ADR 0017, ADR 0081).
 */
export const healthReport = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.record(z.string(), dependencyCheck),
});
export type HealthReport = z.infer<typeof healthReport>;
