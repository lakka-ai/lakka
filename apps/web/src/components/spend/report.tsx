import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import { Link } from '@tanstack/react-router';
import type {
  BudgetView,
  MemberView,
  ModelSpeedRow,
  SpendPrincipalRow,
  SpendReport,
  SpendRouteRow,
  SpendRow,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { readCap } from '../../lib/budget-meter.ts';
import { CapBar, stateLook } from '../patterns/budget-meter.tsx';
import { formatDay } from '../../lib/format.ts';
import { formatMicroUsd } from '../../lib/money.ts';
import { roleLabel } from '../../lib/roles.ts';
import {
  capReading,
  formatCount,
  formatDays,
  formatSeconds,
  shareOfLargest,
  sharePercent,
  topRows,
} from '../../lib/spend.ts';
import { CardSection, EmptyList } from '../patterns/card-section.tsx';
import { DataTable, TwoLine } from '../patterns/data-table.tsx';
import type { Column } from '../patterns/data-table.tsx';
import { PillTabs } from '../patterns/tabs.tsx';
import { Icon } from '../icons.tsx';
import { CapLeftChip } from './caps.tsx';
import { SpendByDay } from './chart.tsx';
import {
  principalName,
  refusalReason,
  routeLines,
  surfaceHelp,
  surfaceName,
  surfacesSentence,
} from './copy.ts';
import { StatusChip } from '../patterns/status-chip.tsx';
import type { Tone } from '../patterns/status-chip.tsx';
import { EmptyState } from '../patterns/empty-state.tsx';

/*
 * The Report tab (BG-11; Spend-Admin and Spend-Member boards): tiles, spend by day, where the
 * money went, then for admins what went to a cheaper model or was refused, and speed and size
 * by model. Every breakdown is a real table with its bars aria-hidden (Pattern 7); the pills
 * over it are a tablist whose panel is the table (Pattern 15). A member's report is their own,
 * from the api: nobody else's numbers reach this page (F5).
 */

/**
 * Where a report's rows lead: the Requests list filtered to that outcome over the same dates
 * (Spend-Admin board, "Each row links to the matching requests"). Custom dates have no pill
 * there, so they lead to every request kept.
 */
export interface RequestsLink {
  workspaceId: string;
  dates: 'this-month' | 'last-month' | 'last-7-days' | 'all';
}

function RequestsFor({
  to,
  outcome,
  children,
}: {
  /** Null on the instance report, where there is no one list to lead to. */
  to: RequestsLink | null;
  outcome: 'cheaper' | 'refused';
  children: ReactNode;
}) {
  if (to === null) return <>{children}</>;
  return (
    <Link
      to="/workspaces/$workspaceId/requests"
      params={{ workspaceId: to.workspaceId }}
      search={{ outcome, ...(to.dates === 'this-month' ? {} : { dates: to.dates }) }}
      className="lk-link lk-link-alone"
    >
      {children}
    </Link>
  );
}

/** How many people By person shows before "6 others". */
const TOP_PEOPLE = 6;

function Tile({
  label,
  value,
  valueAside,
  children,
  tone = 'plain',
  headline = false,
  className = '',
}: {
  label: string;
  value: string;
  /** Beside the value, on its baseline: "of $1,000.00 workspace cap". */
  valueAside?: ReactNode;
  /** The page's main figure, set in Newsreader: the admin's Spent. */
  headline?: boolean;
  children?: ReactNode;
  tone?: 'plain' | 'low' | 'exhausted';
  className?: string;
}) {
  const box = stateLook[tone === 'plain' ? 'healthy' : tone].edge;
  return (
    <li
      className={`flex min-w-0 flex-col gap-1.5 lk-card px-4 py-3.5 lg:px-5 lg:py-4 ${box} ${className}`}
    >
      <p className="text-small text-muted">{label}</p>
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <p className={`lk-num ${headline ? 'lk-headline' : 'text-stat'}`}>{value}</p>
        {valueAside}
      </div>
      {children}
    </li>
  );
}

/**
 * The Spent tile. With a workspace cap and this month shown, it is read against the cap: the bar
 * shows what is left, and low or used up is said in words (Pattern 2).
 */
function SpentTile({ total, cap }: { total: string; cap: BudgetView | null }) {
  if (cap === null) {
    return (
      <Tile
        label={t('spend.tile.spent')}
        value={formatMicroUsd(total)}
        headline
        className="col-span-2 lg:col-span-1"
      >
        <p className="text-small text-muted">{t('spend.tile.noCap')}</p>
      </Tile>
    );
  }
  const reading = readCap(capReading(cap, { name: t('spend.caps.workspace'), period: '' }));
  const left = formatMicroUsd(String(reading.leftMicro));
  const line =
    reading.state === 'low'
      ? cap.periodEnd === null
        ? t('spend.tile.lowNever', { left })
        : t('spend.tile.low', { left, date: formatDay(cap.periodEnd) })
      : reading.state === 'exhausted'
        ? cap.periodEnd === null
          ? t('spend.tile.exhaustedNever')
          : t('spend.tile.exhausted', { date: formatDay(cap.periodEnd) })
        : null;
  return (
    <Tile
      label={t('spend.tile.spent')}
      value={formatMicroUsd(total)}
      headline
      tone={reading.state === 'healthy' ? 'plain' : reading.state}
      className="col-span-2 lg:col-span-1"
      valueAside={
        <p className="lk-num text-small text-muted">
          {t('spend.tile.ofCap', { limit: formatMicroUsd(cap.limitMicroUsd) })}
        </p>
      }
    >
      <CapBar reading={reading} className="mt-1" />
      {line !== null && (
        <p
          className={`mt-1 flex items-center gap-1.5 text-small font-medium ${stateLook[reading.state].text}`}
        >
          <Icon name={reading.state === 'low' ? 'warning' : 'ban'} className="size-3.5" />
          {line}
        </p>
      )}
    </Tile>
  );
}

function Tiles({
  report,
  variant,
  cap,
  link,
}: {
  report: SpendReport;
  variant: 'admin' | 'member';
  cap: BudgetView | null;
  link: RequestsLink | null;
}) {
  const refused = report.refusals.reduce((sum, r) => sum + r.requests, 0);
  const throughKeys = report.byPerson
    .filter((p) => p.kind === 'key')
    .reduce((sum, p) => sum + BigInt(p.costMicroUsd), 0n);
  const keyCount = report.byPerson.filter((p) => p.kind === 'key').length;
  return (
    <ul
      className={`grid grid-cols-2 gap-4 ${variant === 'admin' ? 'lg:grid-cols-[2fr_repeat(4,1fr)]' : 'lg:grid-cols-4'}`}
    >
      {variant === 'admin' ? (
        <SpentTile total={report.totalMicroUsd} cap={cap} />
      ) : (
        <Tile
          label={t('spend.tile.youSpent')}
          value={formatMicroUsd(report.totalMicroUsd)}
          className="col-span-2 lg:col-span-1"
        >
          {throughKeys > 0n && (
            <p className="text-small text-muted">
              {t(keyCount === 1 ? 'spend.tile.throughKey' : 'spend.tile.throughKeys', {
                amount: formatMicroUsd(String(throughKeys)),
              })}
            </p>
          )}
        </Tile>
      )}
      <Tile label={t('spend.tile.requests')} value={formatCount(report.requests)}>
        <p className="text-small text-muted">
          {surfacesSentence(report.bySurface.map((s) => s.key))}
        </p>
      </Tile>
      {variant === 'admin' && (
        <Tile
          label={t('spend.tile.toolCalls')}
          value={formatCount(report.toolCallsRan + report.toolCallsDenied)}
        >
          <p className="text-small text-muted">
            {t('spend.tile.denied', { n: formatCount(report.toolCallsDenied) })}
          </p>
        </Tile>
      )}
      <Tile label={t('spend.tile.cheaper')} value={formatCount(report.downgradedRequests)}>
        <p className="text-small text-muted">
          {variant === 'member' && report.downgradedRequests > 0 ? (
            <RequestsFor to={link} outcome="cheaper">
              {t('spend.tile.seeThose')}
            </RequestsFor>
          ) : (
            t('spend.tile.cheaperHelp')
          )}
        </p>
      </Tile>
      <Tile label={t('spend.tile.refused')} value={formatCount(refused)}>
        <p className="text-small text-muted">
          {variant === 'member' && refused > 0 ? (
            <RequestsFor to={link} outcome="refused">
              {t('spend.tile.seeWhy')}
            </RequestsFor>
          ) : (
            t('spend.tile.refusedHelp')
          )}
        </p>
      </Tile>
    </ul>
  );
}

interface BreakdownRow {
  key: string;
  first: ReactNode;
  /** By workspace on the instance report: the workspace's own cap. */
  cap?: ReactNode;
  second?: ReactNode;
  requests: number;
  costMicroUsd: string;
  /** "6 others", which ends the list with a Show all button. */
  others?: boolean;
}

function BreakdownTable({
  labelledBy,
  name,
  column,
  rows,
  total,
}: {
  labelledBy: string;
  name: string;
  column: string;
  rows: readonly BreakdownRow[];
  total: string;
}) {
  const largest = rows.reduce(
    (m, r) => (BigInt(r.costMicroUsd) > m ? BigInt(r.costMicroUsd) : m),
    0n,
  );
  const columns: Column<BreakdownRow>[] = [
    {
      key: 'name',
      header: column,
      cell: (r) => (
        <TwoLine first={r.first} {...(r.second === undefined ? {} : { second: r.second })} />
      ),
    },
    ...(rows.some((r) => r.cap !== undefined)
      ? [{ key: 'cap', header: t('spend.col.itsCap'), cell: (r: BreakdownRow) => r.cap ?? '' }]
      : []),
    {
      key: 'requests',
      header: t('spend.col.requests'),
      numeric: true,
      cell: (r) => formatCount(r.requests),
    },
    {
      key: 'spend',
      header: t('spend.col.spend'),
      numeric: true,
      cell: (r) => <span className="font-semibold">{formatMicroUsd(r.costMicroUsd)}</span>,
    },
    {
      key: 'share',
      header: t('spend.col.share'),
      numeric: true,
      cell: (r) => sharePercent(r.costMicroUsd, total),
    },
  ];
  return (
    <DataTable
      labelledBy={labelledBy}
      name={name}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      share={(r) => shareOfLargest(r.costMicroUsd, largest)}
    />
  );
}

function byPersonRows(
  rows: readonly SpendPrincipalRow[],
  members: readonly MemberView[],
  showAll: boolean,
  onShowAll: () => void,
): BreakdownRow[] {
  const role = new Map(members.map((m) => [m.principalId, m.role]));
  const top = showAll ? { shown: [...rows], others: null } : topRows(rows, TOP_PEOPLE);
  const shown: BreakdownRow[] = top.shown.map((r) => ({
    key: r.key,
    first: principalName(r),
    second:
      r.kind === 'key'
        ? t('spend.breakdown.keyOf', { owner: r.owner?.name ?? t('spend.breakdown.removedPerson') })
        : role.has(r.key)
          ? roleLabel(role.get(r.key) ?? null)
          : undefined,
    requests: r.requests,
    costMicroUsd: r.costMicroUsd,
  }));
  if (top.others !== null) {
    shown.push({
      key: 'others',
      first: t('spend.breakdown.others', { n: formatCount(top.others.count) }),
      second: (
        <Button variant="ghost" className="lk-link text-caption" onPress={onShowAll}>
          {t('spend.breakdown.showAll')}
        </Button>
      ),
      requests: top.others.requests,
      costMicroUsd: top.others.costMicroUsd,
      others: true,
    });
  }
  return shown;
}

const plainRows = (rows: readonly SpendRow[], second?: (r: SpendRow) => string): BreakdownRow[] =>
  rows.map((r) => ({
    key: r.key,
    first: r.label,
    ...(second === undefined ? {} : { second: second(r) }),
    requests: r.requests,
    costMicroUsd: r.costMicroUsd,
  }));

export function WhereTheMoneyWent({
  report,
  members,
  variant,
}: {
  report: SpendReport;
  members: readonly MemberView[];
  /** The instance adds By workspace, first, with each workspace's own cap. */
  variant: ReportVariant;
}) {
  const titleId = useId();
  const [showAll, setShowAll] = useState(false);
  const title =
    variant === 'member' ? t('spend.breakdown.memberTitle') : t('spend.breakdown.title');
  const table = (column: string, rows: BreakdownRow[]) => (
    <BreakdownTable
      labelledBy={titleId}
      name={`${title}, ${column}`}
      column={column}
      rows={rows}
      total={report.totalMicroUsd}
    />
  );
  const models = table(
    t('spend.col.model'),
    report.byModel.map((r) => ({
      key: r.key,
      first: r.label,
      second: <span className="font-mono">{r.key}</span>,
      requests: r.requests,
      costMicroUsd: r.costMicroUsd,
    })),
  );
  const surfaces = table(
    t('spend.col.surface'),
    plainRows(
      report.bySurface.map((r) => ({ ...r, label: surfaceName(r.key) })),
      (r) => surfaceHelp(r.key),
    ),
  );
  const workspaces = {
    id: 'workspace',
    label: t('spend.breakdown.workspace'),
    panel: table(
      t('spend.col.workspace'),
      report.byWorkspace.map((r) => ({
        key: r.key,
        // A deleted workspace's spend stays in the instance's records (ID-8, ADR 0104).
        first: r.deleted ? t('spend.workspaceDeleted', { name: r.label }) : r.label,
        cap: <CapLeftChip cap={r.cap} name={t('spend.caps.capOf', { name: r.label })} />,
        requests: r.requests,
        costMicroUsd: r.costMicroUsd,
      })),
    ),
  };
  const items =
    variant !== 'member'
      ? [
          ...(variant === 'instance' ? [workspaces] : []),
          {
            id: 'person',
            label: t('spend.breakdown.person'),
            panel: table(
              t('spend.col.person'),
              byPersonRows(report.byPerson, members, showAll, () => setShowAll(true)),
            ),
          },
          { id: 'model', label: t('spend.breakdown.model'), panel: models },
          { id: 'surface', label: t('spend.breakdown.surface'), panel: surfaces },
          {
            id: 'route',
            label: t('spend.breakdown.route'),
            panel: table(
              t('spend.col.route'),
              report.byRoute.map((r: SpendRouteRow) => {
                const lines = routeLines(r);
                return {
                  key: r.key,
                  first: lines.name,
                  second: lines.help,
                  requests: r.requests,
                  costMicroUsd: r.costMicroUsd,
                };
              }),
            ),
          },
        ]
      : [
          { id: 'model', label: t('spend.breakdown.model'), panel: models },
          { id: 'surface', label: t('spend.breakdown.surface'), panel: surfaces },
        ];
  return (
    <section
      aria-labelledby={titleId}
      className="relative flex flex-col gap-3 overflow-hidden lk-card pt-4"
    >
      <div className="flex flex-col gap-0.5 px-5 lg:pe-96">
        <h2 id={titleId} className="text-heading">
          {title}
        </h2>
        <p className="lk-num text-small text-muted">
          {variant === 'instance'
            ? t('spend.breakdown.subtitleDays', {
                amount: formatMicroUsd(report.totalMicroUsd),
                requests: formatCount(report.requests),
                days: formatDays(report.from, report.to),
              })
            : t('spend.breakdown.subtitle', {
                amount: formatMicroUsd(report.totalMicroUsd),
                requests: formatCount(report.requests),
              })}
        </p>
      </div>
      <PillTabs label={t('spend.breakdown.label')} items={items} className="lk-card-tabs" />
    </section>
  );
}

interface OutcomeRow {
  key: string;
  chip: 'cheaper' | 'refused' | 'tools';
  what: string;
  requests: number;
  spend: string;
}

const CHIP_TONE: Readonly<Record<OutcomeRow['chip'], Tone>> = {
  cheaper: 'cheaper',
  refused: 'refused',
  tools: 'neutral',
};

function Outcomes({ report, link }: { report: SpendReport; link: RequestsLink | null }) {
  const titleId = useId();
  const rows: OutcomeRow[] = [
    ...(report.downgradedRequests > 0
      ? [
          {
            key: 'cheaper',
            chip: 'cheaper' as const,
            what: t('spend.outcomes.cheaper'),
            requests: report.downgradedRequests,
            spend: formatMicroUsd(report.downgradedMicroUsd),
          },
        ]
      : []),
    ...report.refusals.map((r) => ({
      key: `refused-${r.code}`,
      chip: 'refused' as const,
      what: refusalReason(r.code),
      requests: r.requests,
      spend: formatMicroUsd('0'),
    })),
    ...(
      [
        ['ran', report.toolCallsRan, 'spend.outcomes.toolsRan'],
        ['not-allowed', report.toolCallsNotAllowed, 'spend.outcomes.toolsNotAllowed'],
        ['denied', report.toolCallsDenied, 'spend.outcomes.toolsDenied'],
      ] as const
    ).flatMap(([key, n, label]) =>
      n > 0
        ? [
            {
              key: `tools-${key}`,
              chip: 'tools' as const,
              what: t(label),
              requests: n,
              spend: t('spend.outcomes.included'),
            },
          ]
        : [],
    ),
  ];
  const chipWord = (chip: OutcomeRow['chip']) =>
    chip === 'cheaper'
      ? t('spend.outcomes.chip.cheaper')
      : chip === 'refused'
        ? t('spend.outcomes.chip.refused')
        : t('spend.outcomes.chip.tools');
  return (
    <CardSection
      title={t('spend.outcomes.title')}
      subtitle={t('spend.outcomes.subtitle')}
      titleId={titleId}
      flush={rows.length > 0}
    >
      {rows.length === 0 ? (
        <EmptyList>{t('spend.outcomes.none')}</EmptyList>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={t('spend.outcomes.title')}
          columns={[
            {
              key: 'what',
              header: t('spend.outcomes.what'),
              cell: (r: OutcomeRow) => (
                <span className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={CHIP_TONE[r.chip]}>{chipWord(r.chip)}</StatusChip>
                  {r.chip === 'tools' ? (
                    r.what
                  ) : (
                    <RequestsFor to={link} outcome={r.chip}>
                      {r.what}
                    </RequestsFor>
                  )}
                </span>
              ),
            },
            {
              key: 'requests',
              header: t('spend.col.requests'),
              numeric: true,
              cell: (r: OutcomeRow) => formatCount(r.requests),
            },
            {
              key: 'spend',
              header: t('spend.col.spend'),
              numeric: true,
              cell: (r: OutcomeRow) => r.spend,
            },
          ]}
          rows={rows}
          rowKey={(r) => r.key}
        />
      )}
    </CardSection>
  );
}

const pair = (a: string, b: string) => t('spend.speed.pair', { median: a, p95: b });
const tokens = (n: number) => formatCount(Math.round(n));

function Speed({ rows }: { rows: readonly ModelSpeedRow[] }) {
  const titleId = useId();
  if (rows.length === 0) return null;
  return (
    <CardSection
      title={t('spend.speed.title')}
      subtitle={t('spend.speed.subtitle')}
      titleId={titleId}
      flush
    >
      <DataTable
        labelledBy={titleId}
        name={t('spend.speed.title')}
        columns={[
          { key: 'model', header: t('spend.col.model'), cell: (r: ModelSpeedRow) => r.name },
          {
            key: 'requests',
            header: t('spend.col.requests'),
            numeric: true,
            cell: (r: ModelSpeedRow) => formatCount(r.requests),
          },
          {
            key: 'total',
            header: t('spend.speed.total'),
            numeric: true,
            cell: (r: ModelSpeedRow) =>
              pair(formatSeconds(r.latency.p50), formatSeconds(r.latency.p95)),
          },
          {
            key: 'ttft',
            header: t('spend.speed.ttft'),
            numeric: true,
            cell: (r: ModelSpeedRow) =>
              r.timeToFirstToken === null
                ? t('spend.speed.notStreamed')
                : pair(
                    formatSeconds(r.timeToFirstToken.p50),
                    formatSeconds(r.timeToFirstToken.p95),
                  ),
          },
          {
            key: 'in',
            header: t('spend.speed.in'),
            numeric: true,
            cell: (r: ModelSpeedRow) => pair(tokens(r.inputTokens.p50), tokens(r.inputTokens.p95)),
          },
          {
            key: 'out',
            header: t('spend.speed.out'),
            numeric: true,
            cell: (r: ModelSpeedRow) =>
              pair(tokens(r.outputTokens.p50), tokens(r.outputTokens.p95)),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.model}
      />
    </CardSection>
  );
}

/** Nothing spent in the dates shown: what will appear, and the one useful next step. */
export function NoSpend({
  thisMonth,
  noCap,
  action,
}: {
  thisMonth: boolean;
  /** No workspace cap is set, which is worth saying on a new workspace. */
  noCap: boolean;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      icon="spend"
      title={thisMonth ? t('spend.empty.title') : t('spend.empty.rangeTitle')}
      action={action}
    >
      <p>{thisMonth ? t('spend.empty.body') : t('spend.empty.rangeBody')}</p>
      {noCap && <p className="text-small text-muted">{t('spend.empty.noCap')}</p>}
    </EmptyState>
  );
}

/** A workspace admin's report, a member's own, or the whole instance's (By workspace added). */
export type ReportVariant = 'admin' | 'member' | 'instance';

export function ReportView({
  report,
  variant,
  cap,
  members,
  link,
}: {
  report: SpendReport;
  variant: ReportVariant;
  /** The workspace or instance cap, read against the Spent tile when this month is shown. */
  cap: BudgetView | null;
  members: readonly MemberView[];
  /** Null on the instance report: requests are listed per workspace. */
  link: RequestsLink | null;
}) {
  const tilesVariant = variant === 'member' ? 'member' : 'admin';
  return (
    <div className="flex flex-col gap-6">
      <Tiles report={report} variant={tilesVariant} cap={cap} link={link} />
      <SpendByDay days={report.byDay} />
      <WhereTheMoneyWent report={report} members={members} variant={variant} />
      {variant !== 'member' && <Outcomes report={report} link={link} />}
      {variant !== 'member' && <Speed rows={report.speedByModel} />}
    </div>
  );
}

/** The report's shape while it loads, so nothing jumps when it arrives (Spend-States board). */
export function ReportSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label={t('spend.page.loading')}
      role="region"
      className="flex flex-col gap-6"
    >
      {/* Skeleton lines with 4px corners inside the cards they stand for (patterns.md, States). */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-[2fr_repeat(4,1fr)]">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`flex flex-col gap-3 lk-card px-5 py-4 ${i === 0 ? 'col-span-2 lg:col-span-1' : ''}`}
          >
            <span className="h-2.5 w-1/3 animate-pulse rounded-sm bg-surface-tertiary" />
            <span className="h-6 w-2/3 animate-pulse rounded-sm bg-surface-tertiary" />
            <span className="h-2.5 w-1/2 animate-pulse rounded-sm bg-surface-tertiary" />
          </div>
        ))}
      </div>
      {['h-75', 'h-90'].map((height) => (
        <div key={height} className={`flex flex-col gap-3 lk-card p-6 ${height}`}>
          <span className="h-3 w-1/4 animate-pulse rounded-sm bg-surface-tertiary" />
          <span className="w-full grow animate-pulse rounded-sm bg-surface-tertiary" />
        </div>
      ))}
    </div>
  );
}
