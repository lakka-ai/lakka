import { readCatalogueFeedEnvelope, readCatalogueFeedVersion } from '@lakka/db';
import type { Db } from '@lakka/db';
import type { Logger } from '../logger.ts';
import type { Catalogue, CatalogueStore } from './catalogue.ts';
import { mergeFeed, openFeed } from './feed.ts';
import type { FeedKey } from './feed-keys.ts';

/*
 * The api's catalogue (PR-6, ADR 0116): the bundled file, or the bundled file with the stored
 * price feed merged in while the feed is on. Postgres says which (invariant 5); every 30 s one
 * primary-key read asks whether the switch or the stored serial changed, and the feed file is
 * read and checked again only when one did.
 *
 * A stored feed is verified again on every load, against the keys and the bundled catalogue of
 * this build. One that fails, edited in the database or held to a newer release's prices, is
 * ignored with a log line and the bundled prices apply; it never stops startup (NF-D5). After
 * an upgrade, a release whose catalogue is as new as the feed wins over it.
 */

export const DEFAULT_CATALOGUE_POLL_MS = 30_000;

export interface CatalogueReloaderContext {
  db: Db;
  logger: Logger;
  bundled: Catalogue;
  keys: readonly FeedKey[];
  /** Tests shorten it; production uses DEFAULT_CATALOGUE_POLL_MS. */
  pollMs?: number;
}

export interface CatalogueReloader extends CatalogueStore {
  stop(): void;
}

/** The catalogue a stored feed gives, or why it gives none. */
function fromStored(ctx: CatalogueReloaderContext, envelope: string): Catalogue | string {
  const opened = openFeed(envelope, ctx.keys);
  if (!opened.ok) return opened.code;
  if (opened.payload.serial <= ctx.bundled.serial) return 'superseded';
  const merged = mergeFeed(ctx.bundled, opened.payload);
  return merged.ok ? merged.catalogue : merged.code;
}

export async function startCatalogueReloader(
  ctx: CatalogueReloaderContext,
): Promise<CatalogueReloader> {
  let catalogue = ctx.bundled;
  // What the current catalogue was made from, so an unchanged row costs nothing more.
  let loaded: string | null = null;

  const load = async (): Promise<void> => {
    const version = await readCatalogueFeedVersion(ctx.db);
    const key = `${String(version.enabled)}:${String(version.appliedSerial)}`;
    if (key === loaded) return;
    let next = ctx.bundled;
    if (version.enabled && version.appliedSerial !== null) {
      const stored = await readCatalogueFeedEnvelope(ctx.db);
      const made =
        stored.envelope === null || !stored.enabled
          ? ctx.bundled
          : fromStored(ctx, stored.envelope);
      if (typeof made === 'string') {
        if (made !== 'superseded') {
          ctx.logger.error('catalogue_feed.stored_refused', { error_code: made });
        }
      } else {
        next = made;
      }
    }
    loaded = key;
    if (next !== catalogue) {
      catalogue = next;
      ctx.logger.info('catalogue.reloaded', { serial: next.serial });
    }
  };

  // One load at a time: a call during one runs after it.
  let queue: Promise<void> = Promise.resolve();
  const reload = (): Promise<void> => {
    const run = queue.then(load);
    queue = run.catch(() => undefined);
    return run;
  };

  try {
    await reload();
  } catch (error) {
    // Postgres was ready a moment ago; if this read fails, the bundled prices apply until the
    // next poll rather than stopping startup.
    ctx.logger.warn('catalogue.reload_failed', {}, error);
  }
  const timer = setInterval(() => {
    reload().catch((error: unknown) => ctx.logger.warn('catalogue.reload_failed', {}, error));
  }, ctx.pollMs ?? DEFAULT_CATALOGUE_POLL_MS);
  timer.unref();

  return {
    current: () => catalogue,
    bundled: ctx.bundled,
    reload,
    stop: () => clearInterval(timer),
  };
}
