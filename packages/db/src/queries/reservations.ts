import { and, asc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { budgetSpend, budgets, reservationLines, reservations } from '../schema/budgets.ts';
import type { RESERVATION_STATES } from '../schema/budgets.ts';

/*
 * Reservation records and spend (BG-3, BG-5, ADR 0050). Postgres is the truth: a reservation row
 * exists before Valkey holds anything, and spend is charged here before Valkey releases the hold.
 */

export type ReservationState = (typeof RESERVATION_STATES)[number];

export interface ReservationLineRow {
  budgetId: string;
  periodStart: Date;
}

export async function insertReservation(
  db: Db,
  row: {
    id: string;
    requestId: string;
    workspaceId: string;
    principalId: string;
    actingUserId: string;
    amountMicroUsd: bigint;
    expiresAt: Date;
    lines: readonly ReservationLineRow[];
  },
): Promise<void> {
  const { lines, ...reservation } = row;
  await db.transaction(async (tx) => {
    await tx.insert(reservations).values({ ...reservation, state: 'pending' });
    await tx.insert(reservationLines).values(lines.map((l) => ({ reservationId: row.id, ...l })));
  });
}

/** Moves a reservation from one of `from` to `to`; returns whether it was in one of `from`. */
export async function transitionReservation(
  db: Db,
  id: string,
  from: readonly ReservationState[],
  to: 'active' | 'denied',
): Promise<boolean> {
  const updated = await db
    .update(reservations)
    .set({ state: to })
    .where(and(eq(reservations.id, id), inArray(reservations.state, [...from])))
    .returning({ id: reservations.id });
  return updated.length > 0;
}

/**
 * Marks a live reservation settled (or abandoned) with its actual cost and charges that cost to
 * each line's period, in one transaction. Returns false, charging nothing, if it was not live:
 * settling twice never charges twice. A line whose budget was deleted meanwhile is skipped.
 */
export async function chargeReservation(
  db: Db,
  id: string,
  actualMicroUsd: bigint,
  outcome: 'settled' | 'abandoned',
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(reservations)
      .set({ state: outcome, actualMicroUsd, settledAt: sql`now()` })
      .where(and(eq(reservations.id, id), inArray(reservations.state, ['pending', 'active'])))
      .returning({ id: reservations.id });
    if (claimed.length === 0) return false;
    if (actualMicroUsd === 0n) return true;
    const lines = await tx
      .select({ budgetId: reservationLines.budgetId, periodStart: reservationLines.periodStart })
      .from(reservationLines)
      .innerJoin(budgets, eq(budgets.id, reservationLines.budgetId))
      .where(eq(reservationLines.reservationId, id));
    for (const line of lines) {
      await tx
        .insert(budgetSpend)
        .values({ ...line, spentMicroUsd: actualMicroUsd })
        .onConflictDoUpdate({
          target: [budgetSpend.budgetId, budgetSpend.periodStart],
          set: {
            spentMicroUsd: sql`${budgetSpend.spentMicroUsd} + ${actualMicroUsd}`,
            updatedAt: sql`now()`,
          },
        });
    }
    // Thresholds this charge crossed, recorded once per budget, period and percentage (BG-10).
    await tx.execute(sql`
      insert into budget_alerts (id, budget_id, period_start, percent, spent_micro_usd, limit_micro_usd)
      select gen_random_uuid(), s.budget_id, s.period_start, p.percent, s.spent_micro_usd, b.limit_micro_usd
      from reservation_lines l
      join budget_spend s on s.budget_id = l.budget_id and s.period_start = l.period_start
      join budgets b on b.id = l.budget_id
      cross join lateral unnest(b.alert_percents) as p(percent)
      where l.reservation_id = ${id}
        and b.limit_micro_usd > 0
        and s.spent_micro_usd * 100 >= p.percent::bigint * b.limit_micro_usd
      on conflict (budget_id, period_start, percent) do nothing`);
    return true;
  });
}

export interface CounterSeed {
  budgetId: string;
  periodStart: Date;
  spentMicroUsd: bigint;
  /** Active reservations holding against this cap and period. */
  holds: { reservationId: string; amountMicroUsd: bigint }[];
}

/**
 * What a Valkey counter should hold, read from Postgres, for rebuilding it (invariant 5): spend
 * for the period, and the holds of reservations in `states`. Rebuilding a missing counter counts
 * active holds only; the periodic rebuild counts pending ones too, whose hold may already be in
 * Valkey (ADR 0052).
 */
export async function loadCounterSeeds(
  db: Db,
  lines: readonly ReservationLineRow[],
  states: readonly ReservationState[] = ['active'],
): Promise<CounterSeed[]> {
  if (lines.length === 0) return [];
  const ids = lines.map((l) => l.budgetId);
  const [spendRows, holdRows] = await Promise.all([
    db
      .select({
        budgetId: budgetSpend.budgetId,
        periodStart: budgetSpend.periodStart,
        spent: budgetSpend.spentMicroUsd,
      })
      .from(budgetSpend)
      .where(inArray(budgetSpend.budgetId, ids)),
    db
      .select({
        budgetId: reservationLines.budgetId,
        periodStart: reservationLines.periodStart,
        reservationId: reservations.id,
        amount: reservations.amountMicroUsd,
      })
      .from(reservationLines)
      .innerJoin(reservations, eq(reservations.id, reservationLines.reservationId))
      .where(
        and(inArray(reservationLines.budgetId, ids), inArray(reservations.state, [...states])),
      ),
  ]);
  const same = (a: ReservationLineRow, b: { budgetId: string; periodStart: Date }) =>
    a.budgetId === b.budgetId && a.periodStart.getTime() === b.periodStart.getTime();
  return lines.map((line) => ({
    ...line,
    spentMicroUsd: spendRows.find((r) => same(line, r))?.spent ?? 0n,
    holds: holdRows
      .filter((r) => same(line, r))
      .map((r) => ({ reservationId: r.reservationId, amountMicroUsd: r.amount })),
  }));
}

export interface ExpiredReservation {
  id: string;
  requestId: string;
  workspaceId: string;
  amountMicroUsd: bigint;
  lines: ReservationLineRow[];
}

/** Live reservations whose hold has lapsed, oldest first (BG-6). */
export async function listExpiredReservations(
  db: Db,
  now: Date,
  limit: number,
): Promise<ExpiredReservation[]> {
  const rows = await db
    .select({
      id: reservations.id,
      requestId: reservations.requestId,
      workspaceId: reservations.workspaceId,
      amountMicroUsd: reservations.amountMicroUsd,
    })
    .from(reservations)
    .where(and(inArray(reservations.state, ['pending', 'active']), lt(reservations.expiresAt, now)))
    .orderBy(asc(reservations.expiresAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const lines = await db
    .select({
      reservationId: reservationLines.reservationId,
      budgetId: reservationLines.budgetId,
      periodStart: reservationLines.periodStart,
    })
    .from(reservationLines)
    .where(
      inArray(
        reservationLines.reservationId,
        rows.map((r) => r.id),
      ),
    );
  const byReservation = Map.groupBy(lines, (l) => l.reservationId);
  return rows.map((r) => ({
    ...r,
    lines: (byReservation.get(r.id) ?? []).map(({ budgetId, periodStart }) => ({
      budgetId,
      periodStart,
    })),
  }));
}

/**
 * What a request's other reservations have already charged. A tool loop holds one round at a
 * time under one request id (the live-reservation index allows no more), so the request's usage
 * less this is what its lapsed reservation covered (ADR 0089).
 */
export async function sumChargedForRequest(
  db: Db,
  workspaceId: string,
  requestId: string,
  exceptReservationId: string,
): Promise<bigint> {
  const [row] = await db
    .select({
      charged: sql<string>`coalesce(sum(${reservations.actualMicroUsd}), 0)::text`,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.workspaceId, workspaceId),
        eq(reservations.requestId, requestId),
        inArray(reservations.state, ['settled', 'abandoned']),
        ne(reservations.id, exceptReservationId),
      ),
    );
  return BigInt(row?.charged ?? '0');
}

/** Every cap with its period, and the lines of live reservations, for the periodic rebuild. */
export async function listRebuildTargets(db: Db): Promise<{
  budgets: { budgetId: string; period: 'daily' | 'monthly' | 'none' }[];
  liveLines: ReservationLineRow[];
}> {
  const [caps, liveLines] = await Promise.all([
    db.select({ budgetId: budgets.id, period: budgets.period }).from(budgets),
    db
      .selectDistinct({
        budgetId: reservationLines.budgetId,
        periodStart: reservationLines.periodStart,
      })
      .from(reservationLines)
      .innerJoin(reservations, eq(reservations.id, reservationLines.reservationId))
      .where(inArray(reservations.state, ['pending', 'active'])),
  ]);
  return { budgets: caps, liveLines };
}
