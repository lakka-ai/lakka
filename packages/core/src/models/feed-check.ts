import type { CatalogueFeedErrorCode } from '@lakka/contracts';
import {
  applyCatalogueFeed,
  readCatalogueFeedEnvelope,
  readCatalogueFeedSchedule,
  recordCatalogueFeedCheck,
} from '@lakka/db';
import type { CatalogueFeedSchedule, Db } from '@lakka/db';
import type { Logger } from '../logger.ts';
import type { Catalogue } from './catalogue.ts';
import { FEED_MAX_BYTES, mergeFeed, openFeed } from './feed.ts';
import type { FeedKey } from './feed-keys.ts';

/*
 * Fetching the signed price feed (PR-6, ADR 0116), in the worker, as a pg-boss job that runs
 * every minute. While the feed is off it returns before anything else: no request leaves the
 * instance (NF-P1, NF-P2, invariant 8). On, it checks once a day at the instance's own minute,
 * and at once when an admin asks.
 *
 * The request carries nothing about the instance: no version, no identifiers, a plain
 * `user-agent: lakka`. The host still sees the server's address, which the admin page says.
 * The fetch is https only, follows no redirect, gives up after 10 s and reads at most 1 MB.
 * A verified feed is stored in one transaction; the api picks it up on its next poll.
 */

export const CATALOGUE_FEED_QUEUE = 'catalogue-feed';
export const CATALOGUE_FEED_SCHEDULE = '* * * * *';

export const FEED_FETCH_TIMEOUT_MS = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The feed's row, and recording what a check found. The worker's is Postgres; tests fake it. */
export interface FeedRecords {
  schedule(): Promise<CatalogueFeedSchedule>;
  /** The stored feed file, read only when a fetched one verified. */
  stored(): Promise<string | null>;
  /**
   * Stores a verified feed in one transaction, if the stored serial is still `expected`; false
   * when another check stored one meanwhile.
   */
  apply(envelope: string, serial: number, at: Date, expected: number | null): Promise<boolean>;
  record(
    at: Date,
    result: 'unchanged' | 'failed',
    errorCode: CatalogueFeedErrorCode | null,
  ): Promise<void>;
}

export function feedRecords(db: Db): FeedRecords {
  return {
    schedule: () => readCatalogueFeedSchedule(db),
    stored: async () => (await readCatalogueFeedEnvelope(db)).envelope,
    apply: (envelope, serial, at, expected) =>
      applyCatalogueFeed(db, envelope, serial, at, expected),
    record: (at, result, errorCode) => recordCatalogueFeedCheck(db, at, result, errorCode),
  };
}

export interface FeedCheckContext {
  records: FeedRecords;
  logger: Logger;
  /** The release's catalogue: its serial is the floor, and its prices what a feed is held to. */
  bundled: Catalogue;
  keys: readonly FeedKey[];
  /** Where the feed is fetched from; null when an operator locked it off. */
  url: string | null;
  /** Replaces global fetch. Tests only. */
  fetch?: typeof fetch;
  /** Tests shorten it; production uses FEED_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type FeedCheckOutcome = 'off' | 'not_due' | 'applied' | 'unchanged' | 'failed';

/** The first time at the instance's minute of the day after `last`. */
export function nextScheduledCheck(last: Date, checkMinute: number): Date {
  const day = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  let at = day + checkMinute * 60_000;
  if (at <= last.getTime()) at += DAY_MS;
  return new Date(at);
}

export function feedCheckDue(schedule: CatalogueFeedSchedule, now: Date): boolean {
  if (schedule.checkRequestedAt !== null || schedule.lastCheckedAt === null) return true;
  return now >= nextScheduledCheck(schedule.lastCheckedAt, schedule.checkMinute);
}

type Fetched = { ok: true; text: string } | { ok: false; code: CatalogueFeedErrorCode };

/** The body of an https GET, read up to FEED_MAX_BYTES, or why there is none. */
async function fetchFeed(ctx: FeedCheckContext, url: string): Promise<Fetched> {
  if (new URL(url).protocol !== 'https:') return { ok: false, code: 'unreachable' };
  const signal = AbortSignal.timeout(ctx.timeoutMs ?? FEED_FETCH_TIMEOUT_MS);
  const timedOut = () => signal.aborted;
  try {
    const response = await (ctx.fetch ?? fetch)(url, {
      method: 'GET',
      // A redirect could send the request, and the server's address, to a host nobody chose.
      redirect: 'error',
      signal,
      headers: { 'user-agent': 'lakka' },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, code: 'http_status' };
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > FEED_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, code: 'too_large' };
    }
    if (response.body === null) return { ok: true, text: '' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FEED_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: 'too_large' };
      }
      chunks.push(value);
    }
    return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
  } catch {
    return { ok: false, code: timedOut() ? 'timeout' : 'unreachable' };
  }
}

/**
 * The serial of the stored feed, if it still verifies with this build's keys. A feed signed by
 * a key a later release removed, as after a key compromise, no longer counts: otherwise one
 * signed with a huge serial would block every honest feed after it.
 */
async function trustedSerial(
  ctx: FeedCheckContext,
  schedule: CatalogueFeedSchedule,
): Promise<number | null> {
  if (schedule.appliedSerial === null) return null;
  const stored = await ctx.records.stored();
  const opened = stored === null ? undefined : openFeed(stored, ctx.keys);
  return opened?.ok === true ? opened.payload.serial : null;
}

/**
 * One run of the job: nothing while the feed is off or not due; otherwise fetch, verify, check
 * against the bundled catalogue and the last applied serial, and store or record the outcome.
 * A failure of any kind keeps the catalogue as it was.
 */
export async function checkCatalogueFeed(
  ctx: FeedCheckContext,
  now: Date = new Date(),
): Promise<FeedCheckOutcome> {
  if (ctx.url === null || ctx.keys.length === 0) return 'off';
  const schedule = await ctx.records.schedule();
  if (!schedule.enabled) return 'off';
  if (!feedCheckDue(schedule, now)) return 'not_due';

  const failed = async (code: CatalogueFeedErrorCode): Promise<FeedCheckOutcome> => {
    const fields = { error_code: code };
    // A bad signature, or an older feed passed off as new, is someone's doing, not the network.
    if (code === 'bad_signature' || code === 'not_newer') {
      ctx.logger.error('catalogue_feed.check_failed', fields);
    } else {
      ctx.logger.warn('catalogue_feed.check_failed', fields);
    }
    await ctx.records.record(now, 'failed', code);
    return 'failed';
  };

  const fetched = await fetchFeed(ctx, ctx.url);
  if (!fetched.ok) return failed(fetched.code);
  const opened = openFeed(fetched.text, ctx.keys);
  if (!opened.ok) return failed(opened.code);
  const serial = opened.payload.serial;
  const applied = await trustedSerial(ctx, schedule);
  // Older than a feed already applied is a replay. No newer than the release is only a feed
  // this release already has, which the release's own prices cover.
  if (applied !== null && serial < applied) return failed('not_newer');
  if (serial <= Math.max(applied ?? 0, ctx.bundled.serial)) {
    ctx.logger.info('catalogue_feed.unchanged', { serial });
    await ctx.records.record(now, 'unchanged', null);
    return 'unchanged';
  }
  const merged = mergeFeed(ctx.bundled, opened.payload);
  if (!merged.ok) return failed(merged.code);
  if (!(await ctx.records.apply(fetched.text, serial, now, schedule.appliedSerial))) {
    // Another check stored this serial or a newer one first.
    ctx.logger.info('catalogue_feed.unchanged', { serial });
    await ctx.records.record(now, 'unchanged', null);
    return 'unchanged';
  }
  ctx.logger.info('catalogue_feed.applied', {
    serial,
    models: merged.catalogue.models.size + merged.catalogue.feedOnly.size,
    prices_changed: merged.catalogue.priceUpdated.size,
  });
  return 'applied';
}
