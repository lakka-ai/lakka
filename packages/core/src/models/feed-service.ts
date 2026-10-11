import {
  CATALOGUE_FEED_ERROR_CODES,
  CATALOGUE_FEED_RESULTS,
  CatalogueFeedLockedError,
  CatalogueFeedNoKeyError,
  CatalogueFeedOffError,
  ForbiddenError,
} from '@lakka/contracts';
import type {
  CatalogueFeedErrorCode,
  CatalogueFeedResult,
  CatalogueFeedView,
  Principal,
} from '@lakka/contracts';
import {
  findCatalogueFeedSettings,
  requestCatalogueFeedCheck,
  setCatalogueFeedEnabled,
} from '@lakka/db';
import type { Db } from '@lakka/db';
import type { Logger } from '../logger.ts';
import type { CatalogueStore } from './catalogue.ts';
import type { FeedKey } from './feed-keys.ts';
import { mayManageModels } from './service.ts';

/*
 * Price updates on the Models page (PR-6, ADR 0116). Only instance admins see or change them,
 * as with custom models: prices decide what budgets are charged (ADR 0037). A key never can,
 * not even an instance admin's.
 *
 * The switch cannot be turned on when an operator locked the feed off, or when this build has
 * no public key to check a feed with. Turning it off applies the bundled prices at once in this
 * process; the stored feed and its serial are kept, so replay protection survives switching it
 * on again.
 */

export interface CatalogueFeedContext {
  db: Db;
  catalogue: CatalogueStore;
  logger: Logger;
  feed: {
    /** Where the feed is fetched from; null when an operator set it to off. */
    url: string | null;
    keys: readonly FeedKey[];
  };
}

function requireManager(principal: Principal): void {
  if (!mayManageModels(principal)) {
    throw new ForbiddenError('only instance admins manage price updates');
  }
}

function unavailable(ctx: CatalogueFeedContext): CatalogueFeedView['unavailable'] {
  if (ctx.feed.url === null) return 'locked';
  if (ctx.feed.keys.length === 0) return 'no_key';
  return null;
}

function refuseUnavailable(ctx: CatalogueFeedContext): void {
  const reason = unavailable(ctx);
  if (reason === 'locked') {
    throw new CatalogueFeedLockedError('the operator turned price updates off for this server');
  }
  if (reason === 'no_key') {
    throw new CatalogueFeedNoKeyError('this build has no key to check a price feed with');
  }
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

const isResult = (value: string | null): value is CatalogueFeedResult =>
  value !== null && (CATALOGUE_FEED_RESULTS as readonly string[]).includes(value);
const isErrorCode = (value: string | null): value is CatalogueFeedErrorCode =>
  value !== null && (CATALOGUE_FEED_ERROR_CODES as readonly string[]).includes(value);

export async function getCatalogueFeed(
  ctx: CatalogueFeedContext,
  principal: Principal,
): Promise<CatalogueFeedView> {
  requireManager(principal);
  const row = await findCatalogueFeedSettings(ctx.db);
  const result = row?.lastResult ?? null;
  const errorCode = row?.lastErrorCode ?? null;
  return {
    enabled: row?.enabled ?? false,
    unavailable: unavailable(ctx),
    host: ctx.feed.url === null ? null : new URL(ctx.feed.url).host,
    changedBy: row?.changedBy ?? null,
    changedAt: iso(row?.changedAt),
    lastCheckedAt: iso(row?.lastCheckedAt),
    lastResult: isResult(result) ? result : null,
    lastErrorCode: isErrorCode(errorCode) ? errorCode : null,
    appliedSerial: row?.appliedSerial ?? null,
    appliedAt: iso(row?.appliedAt),
    bundledSerial: ctx.catalogue.bundled.serial,
    activeSerial: ctx.catalogue.current().serial,
    checkRequested: row?.checkRequestedAt != null,
  };
}

export async function changeCatalogueFeed(
  ctx: CatalogueFeedContext,
  principal: Principal,
  enabled: boolean,
): Promise<CatalogueFeedView> {
  requireManager(principal);
  if (enabled) refuseUnavailable(ctx);
  await setCatalogueFeedEnabled(ctx.db, enabled, principal.actingUserId, new Date());
  // Off takes effect at once here, not at the next poll.
  await ctx.catalogue.reload();
  ctx.logger.info(enabled ? 'catalogue_feed.enabled' : 'catalogue_feed.disabled', {
    principal_id: principal.actingUserId,
  });
  return getCatalogueFeed(ctx, principal);
}

export async function checkCatalogueFeedNow(
  ctx: CatalogueFeedContext,
  principal: Principal,
): Promise<CatalogueFeedView> {
  requireManager(principal);
  refuseUnavailable(ctx);
  if (!(await requestCatalogueFeedCheck(ctx.db, new Date()))) {
    throw new CatalogueFeedOffError('price updates are off');
  }
  return getCatalogueFeed(ctx, principal);
}
