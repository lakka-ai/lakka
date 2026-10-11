import { z } from 'zod';
import type { CacheClient } from './cache.ts';
import type { Logger } from './logger.ts';

/*
 * Events other processes may act on. Postgres stays the source of truth (invariant 5): an event
 * only lets a process react sooner, for example the M5 chat surface closing a revoked person's
 * open streams (AC 6). Authentication never relies on it, since every request re-checks the
 * database, so a lost event cannot let anyone back in (ADR 0031).
 */

export const PRINCIPAL_REVOKED_CHANNEL = 'lakka:events:principal-revoked';

export interface PrincipalRevokedEvent {
  principalId: string;
  reason: 'suspended' | 'deleted' | 'key_revoked' | 'membership_removed' | 'workspace_deleted';
  /** Set when access was removed from one workspace only. */
  workspaceId: string | null;
  at: string;
}

/** The event as it arrives over pub/sub: external input, so checked before it is acted on. */
export const principalRevokedEvent = z.object({
  principalId: z.uuid(),
  reason: z.enum([
    'suspended',
    'deleted',
    'key_revoked',
    'membership_removed',
    'workspace_deleted',
  ]),
  workspaceId: z.uuid().nullable(),
  at: z.string(),
});

export interface EventPublisher {
  principalRevoked(event: Omit<PrincipalRevokedEvent, 'at'>): Promise<void>;
}

export const noEvents: EventPublisher = { principalRevoked: async () => undefined };

/**
 * Publishes on Valkey pub/sub. Best effort: the change it reports is already committed in
 * Postgres, so a failure is logged rather than undoing or failing the admin action.
 */
export function valkeyEvents(cache: CacheClient, logger: Logger): EventPublisher {
  return {
    async principalRevoked(event) {
      const payload: PrincipalRevokedEvent = { ...event, at: new Date().toISOString() };
      try {
        await cache.publish(PRINCIPAL_REVOKED_CHANNEL, JSON.stringify(payload));
      } catch (error) {
        logger.warn('events.publish_failed', { principal_id: event.principalId }, error);
      }
    },
  };
}
