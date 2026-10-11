import { AccessRevokedError } from '@lakka/contracts';
import { findStillAllowed } from '@lakka/db';
import type { Db } from '@lakka/db';
import { PRINCIPAL_REVOKED_CHANNEL, principalRevokedEvent } from '../events.ts';
import type { PrincipalRevokedEvent } from '../events.ts';
import type { CacheSubscription } from '../cache.ts';
import type { Logger } from '../logger.ts';

/*
 * Requests in progress, so that revoking someone's access ends theirs within seconds (AC 6, G7,
 * ADR 0063). Authentication already refuses the next request; this ends the ones already
 * streaming. Two ways in, so neither has to be relied on alone:
 *   - a revocation event over Valkey pub/sub ends matching requests at once;
 *   - a periodic check against Postgres ends any whose principal no longer has access, for the
 *     event that was lost (pub/sub is best effort, ADR 0031).
 * Both run in the process that holds the streams. A request is ended by aborting it, which
 * settles its budget with the partial usage like any abort (invariant 4).
 */

export interface LiveRequest {
  requestId: string;
  principalId: string;
  actingUserId: string;
  workspaceId: string;
}

export interface LiveRequests {
  /** Registers a request until the returned function is called; `end` aborts it. */
  track(request: LiveRequest, end: (reason: AccessRevokedError) => void): () => void;
  /** Ends the requests an event names; returns how many. */
  revoke(event: PrincipalRevokedEvent): number;
  /** Ends the requests whose principal lost access, per Postgres; returns how many. */
  recheck(db: Db): Promise<number>;
  readonly size: number;
}

const REVOKED_MESSAGE = 'access to this workspace was revoked';

export function liveRequests(logger: Logger): LiveRequests {
  const tracked = new Map<
    symbol,
    { request: LiveRequest; end: (reason: AccessRevokedError) => void }
  >();

  function endAll(
    matches: (request: LiveRequest) => boolean,
    source: 'valkey' | 'postgres',
    entries = [...tracked.entries()],
  ): number {
    let ended = 0;
    for (const [id, { request, end }] of entries) {
      if (!tracked.has(id) || !matches(request)) continue;
      tracked.delete(id);
      // Which store told us: a Valkey event, or the Postgres check.
      logger.info('request.revoked', {
        request_id: request.requestId,
        principal_id: request.principalId,
        workspace_id: request.workspaceId,
        dependency: source,
      });
      end(new AccessRevokedError(REVOKED_MESSAGE));
      ended += 1;
    }
    return ended;
  }

  return {
    track(request, end) {
      const id = Symbol(request.requestId);
      tracked.set(id, { request, end });
      return () => tracked.delete(id);
    },
    revoke(event) {
      // Suspension names a person; a key's revocation names the key; a removal names a person
      // and a workspace. A key's requests also act as its owner, so they end with the owner's.
      return endAll(
        (r) =>
          (r.principalId === event.principalId || r.actingUserId === event.principalId) &&
          (event.workspaceId === null || r.workspaceId === event.workspaceId),
        'valkey',
      );
    },
    async recheck(db) {
      if (tracked.size === 0) return 0;
      const entries = [...tracked.entries()];
      const allowed = await findStillAllowed(
        db,
        entries.map(([, { request }]) => request),
      );
      const refused = new Set(entries.filter((_, i) => !allowed.has(i)).map(([id]) => id));
      return endAll(
        () => true,
        'postgres',
        entries.filter(([id]) => refused.has(id)),
      );
    },
    get size() {
      return tracked.size;
    },
  };
}

/** How often live requests are checked against Postgres, well inside AC 6's 5 seconds. */
export const DEFAULT_RECHECK_MS = 2000;

/**
 * Listens for revocation events and runs the periodic check, until closed. A subscription that
 * cannot be made is logged, not fatal: the periodic check still ends revoked requests in time.
 */
export async function watchRevocations(options: {
  live: LiveRequests;
  db: Db;
  logger: Logger;
  /** None in a process without Valkey pub/sub; the periodic check still runs. */
  subscribe?: (
    channels: string[],
    onMessage: (channel: string, message: string) => void,
  ) => Promise<CacheSubscription>;
  recheckMs?: number;
}): Promise<{ close(): void }> {
  const { live, db, logger } = options;
  let subscription: CacheSubscription | null = null;
  try {
    subscription =
      options.subscribe === undefined
        ? null
        : await options.subscribe([PRINCIPAL_REVOKED_CHANNEL], (_channel, message) => {
            let event: PrincipalRevokedEvent;
            try {
              event = principalRevokedEvent.parse(JSON.parse(message));
            } catch {
              logger.warn('revocations.bad_event');
              return;
            }
            live.revoke(event);
          });
  } catch (error) {
    logger.warn('revocations.subscribe_failed', {}, error);
  }
  let running = false;
  const timer = setInterval(() => {
    // A slow check is not overlapped by the next one.
    if (running || live.size === 0) return;
    running = true;
    live
      .recheck(db)
      .catch((error: unknown) => logger.warn('revocations.recheck_failed', {}, error))
      .finally(() => {
        running = false;
      });
  }, options.recheckMs ?? DEFAULT_RECHECK_MS);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
      subscription?.close();
    },
  };
}
