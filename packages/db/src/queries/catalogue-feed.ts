import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { principals } from '../schema/identity.ts';
import { catalogueFeed } from '../schema/models.ts';

/*
 * The signed price feed's one row (PR-6, ADR 0116). Instance settings, like retention: no
 * workspace owns them, so there is nothing to scope these queries to. The feed file itself is
 * read only when its serial or the switch changed, since it can be up to a megabyte.
 */

export interface CatalogueFeedSettingsRow {
  enabled: boolean;
  changedBy: string | null;
  changedAt: Date | null;
  appliedSerial: number | null;
  appliedAt: Date | null;
  lastCheckedAt: Date | null;
  lastResult: string | null;
  lastErrorCode: string | null;
  checkRequestedAt: Date | null;
}

/** What the admin page shows, without the feed file. */
export async function findCatalogueFeedSettings(
  db: Db,
): Promise<CatalogueFeedSettingsRow | undefined> {
  const [row] = await db
    .select({
      enabled: catalogueFeed.enabled,
      changedBy: principals.displayName,
      changedAt: catalogueFeed.enabledAt,
      appliedSerial: catalogueFeed.appliedSerial,
      appliedAt: catalogueFeed.appliedAt,
      lastCheckedAt: catalogueFeed.lastCheckedAt,
      lastResult: catalogueFeed.lastResult,
      lastErrorCode: catalogueFeed.lastErrorCode,
      checkRequestedAt: catalogueFeed.checkRequestedAt,
    })
    .from(catalogueFeed)
    .leftJoin(principals, eq(principals.id, catalogueFeed.enabledBy))
    .limit(1);
  return row;
}

export interface CatalogueFeedVersion {
  enabled: boolean;
  appliedSerial: number | null;
}

/** Whether the feed is on and which serial is stored: the api's poll, one primary-key read. */
export async function readCatalogueFeedVersion(db: Db): Promise<CatalogueFeedVersion> {
  const [row] = await db
    .select({ enabled: catalogueFeed.enabled, appliedSerial: catalogueFeed.appliedSerial })
    .from(catalogueFeed)
    .where(eq(catalogueFeed.id, true));
  // A database migrated without the row has the feed off, as a fresh one does.
  return row ?? { enabled: false, appliedSerial: null };
}

/** The stored feed file, with the switch and serial it goes with. */
export async function readCatalogueFeedEnvelope(
  db: Db,
): Promise<CatalogueFeedVersion & { envelope: string | null }> {
  const [row] = await db
    .select({
      enabled: catalogueFeed.enabled,
      appliedSerial: catalogueFeed.appliedSerial,
      envelope: catalogueFeed.envelope,
    })
    .from(catalogueFeed)
    .where(eq(catalogueFeed.id, true));
  return row ?? { enabled: false, appliedSerial: null, envelope: null };
}

export interface CatalogueFeedSchedule extends CatalogueFeedVersion {
  lastCheckedAt: Date | null;
  checkRequestedAt: Date | null;
  checkMinute: number;
}

/** What the worker needs to decide whether a check is due. */
export async function readCatalogueFeedSchedule(db: Db): Promise<CatalogueFeedSchedule> {
  const [row] = await db
    .select({
      enabled: catalogueFeed.enabled,
      appliedSerial: catalogueFeed.appliedSerial,
      lastCheckedAt: catalogueFeed.lastCheckedAt,
      checkRequestedAt: catalogueFeed.checkRequestedAt,
      checkMinute: catalogueFeed.checkMinute,
    })
    .from(catalogueFeed)
    .where(eq(catalogueFeed.id, true));
  return (
    row ?? {
      enabled: false,
      appliedSerial: null,
      lastCheckedAt: null,
      checkRequestedAt: null,
      checkMinute: 0,
    }
  );
}

/** Turns the feed on or off. Turning it on asks for a check at once. */
export async function setCatalogueFeedEnabled(
  db: Db,
  enabled: boolean,
  byPrincipalId: string,
  at: Date,
): Promise<void> {
  await db
    .update(catalogueFeed)
    .set({
      enabled,
      enabledBy: byPrincipalId,
      enabledAt: at,
      checkRequestedAt: enabled ? at : null,
    })
    .where(eq(catalogueFeed.id, true));
}

/** Asks the worker to check at its next run; false when the feed is off. */
export async function requestCatalogueFeedCheck(db: Db, at: Date): Promise<boolean> {
  const rows = await db
    .update(catalogueFeed)
    .set({ checkRequestedAt: at })
    .where(sql`${catalogueFeed.id} and ${catalogueFeed.enabled}`)
    .returning({ id: catalogueFeed.id });
  return rows.length > 0;
}

// A check asked for after this one started is left for the next run.
const clearRequest = (at: Date) =>
  sql`case when ${catalogueFeed.checkRequestedAt} <= ${at} then null
    else ${catalogueFeed.checkRequestedAt} end`;

/**
 * Stores a verified feed and records the check, in one transaction, if the stored serial is
 * still the one the check started from. False, and nothing stored, when another check stored a
 * feed meanwhile: a slower check never replaces a newer feed.
 */
export async function applyCatalogueFeed(
  db: Db,
  envelope: string,
  serial: number,
  at: Date,
  expectedSerial: number | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ appliedSerial: catalogueFeed.appliedSerial })
      .from(catalogueFeed)
      .where(eq(catalogueFeed.id, true))
      .for('update');
    if (row === undefined || row.appliedSerial !== expectedSerial) return false;
    await tx
      .update(catalogueFeed)
      .set({
        envelope,
        appliedSerial: serial,
        appliedAt: at,
        lastCheckedAt: at,
        lastResult: 'applied',
        lastErrorCode: null,
        checkRequestedAt: clearRequest(at),
      })
      .where(eq(catalogueFeed.id, true));
    return true;
  });
}

/** Records a check that applied nothing: the same feed again, or why it was refused. */
export async function recordCatalogueFeedCheck(
  db: Db,
  at: Date,
  result: 'unchanged' | 'failed',
  errorCode: string | null,
): Promise<void> {
  await db
    .update(catalogueFeed)
    .set({
      lastCheckedAt: at,
      lastResult: result,
      lastErrorCode: errorCode,
      checkRequestedAt: clearRequest(at),
    })
    .where(eq(catalogueFeed.id, true));
}
