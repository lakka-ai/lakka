import { useId, useState } from 'react';
import { Label, ListBox, Select } from '@heroui/react';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { REQUEST_OUTCOMES } from '@lakka/contracts';
import type { RequestOutcome, RequestSummaryView } from '@lakka/contracts';
import { EmptyList, Pager } from '../../../components/patterns/card-section.tsx';
import { formatTime, OutcomeChip, useNames } from '../../../components/requests/shared.tsx';
import { DataTable, TwoLine } from '../../../components/patterns/data-table.tsx';
import { surfaceName } from '../../../components/spend/copy.ts';
import { t } from '../../../i18n/index.ts';
import { formatDuration } from '../../../lib/format.ts';
import {
  membersQuery,
  requestableQuery,
  requestsQuery,
  workspaceQuery,
} from '../../../lib/queries.ts';
import type { RequestFilters } from '../../../lib/queries.ts';
import { isAdminRole } from '../../../lib/roles.ts';
import { rangeDays } from '../../../lib/spend.ts';
import { OUTCOME, requestCost, rowReason } from '../../../lib/traces.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * A workspace's requests (OB-1, AC 16, ADR 0079, ADR 0095; Requests board): filters in a search
 * landmark, a status line saying how many match, the table newest first, and Newer and Older.
 * Admins see everyone's; members see their own and their keys', with no Person filter, as the
 * api decides. View trace links are named with the person and the time.
 */

const DATES = ['this-month', 'last-month', 'last-7-days', 'all'] as const;
type Dates = (typeof DATES)[number];
const SURFACES = ['chat', 'api', 'mcp'] as const;
const ALL = 'all';

export interface RequestsSearch {
  person?: string;
  surface?: (typeof SURFACES)[number];
  outcome?: RequestOutcome;
  dates?: Dates;
}

const UUID = /^[0-9a-f-]{36}$/i;

/** The api's filters for the page's search: the dates as whole UTC days. */
function filtersOf(search: RequestsSearch, now: Date): RequestFilters {
  const dates = search.dates ?? 'this-month';
  const days = dates === 'all' ? null : rangeDays(dates, now);
  return {
    ...(search.person === undefined ? {} : { person: search.person }),
    ...(search.surface === undefined ? {} : { surface: search.surface }),
    ...(search.outcome === undefined ? {} : { outcome: search.outcome }),
    ...(days === null ? {} : { from: days.from, to: days.to }),
  };
}

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/requests')({
  validateSearch: (search: Record<string, unknown>): RequestsSearch => {
    const person = typeof search['person'] === 'string' && UUID.test(search['person']);
    const surface = SURFACES.find((s) => s === search['surface']);
    const outcome = REQUEST_OUTCOMES.find((o) => o === search['outcome']);
    const dates = DATES.find((d) => d === search['dates']);
    return {
      ...(person ? { person: String(search['person']) } : {}),
      ...(surface === undefined ? {} : { surface }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(dates === undefined || dates === 'this-month' ? {} : { dates }),
    };
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const id = params.workspaceId;
    const { queryClient } = context;
    const workspace = await queryClient.ensureQueryData(workspaceQuery(id));
    await Promise.all([
      queryClient.ensureQueryData(requestsQuery(id, filtersOf(deps, new Date()), null)),
      queryClient.ensureQueryData(requestableQuery(id)),
      ...(isAdminRole(workspace.role) ? [queryClient.ensureQueryData(membersQuery(id))] : []),
    ]);
  },
  component: RequestsPage,
});

function FilterSelect({
  label,
  value,
  options,
  onChange,
  wide = false,
}: {
  label: string;
  value: string;
  options: readonly { id: string; label: string }[];
  onChange: (id: string) => void;
  /** For names, which run longer: 220px instead of 170px, as drawn. */
  wide?: boolean;
}) {
  return (
    <Select
      value={value}
      onChange={(key) => onChange(String(key))}
      className={`flex w-full flex-col gap-1 ${wide ? 'sm:w-55' : 'sm:w-42.5'}`}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function RequestsPage() {
  const { workspaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const admin = isAdminRole(workspace.role);
  const names = useNames(workspaceId);
  const tableId = useId();
  const filters = filtersOf(search, new Date());
  // Earlier pages' cursors, so Newer can go back; they start again when a filter changes.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [seen, setSeen] = useState(JSON.stringify(filters));
  if (seen !== JSON.stringify(filters)) {
    setSeen(JSON.stringify(filters));
    setCursors([null]);
  }
  const before = cursors.at(-1) ?? null;
  const { data: page } = useQuery(requestsQuery(workspaceId, filters, before));
  const { data: members } = useQuery({ ...membersQuery(workspaceId), enabled: admin });
  // A filter set back to All or This month leaves the address.
  const set = (patch: { [K in keyof RequestsSearch]?: RequestsSearch[K] | undefined }) =>
    void navigate({
      search: (prev) =>
        Object.fromEntries(
          Object.entries({ ...prev, ...patch }).filter(([, v]) => v !== undefined),
        ) as RequestsSearch,
    });
  const pageNumber = cursors.length;
  const pageSize = 50;
  const rows = page?.requests ?? [];
  const total = page?.total ?? 0;
  const any = Object.keys(search).length > 0;

  return (
    <>
      <PageHeader
        title={t('traces.title')}
        lede={
          admin
            ? t('traces.introAdmin', { workspace: workspace.name })
            : t('traces.introMember', { workspace: workspace.name })
        }
      />
      <div
        role="search"
        aria-label={t('traces.filters')}
        className="flex flex-wrap items-end gap-3"
      >
        {admin && (
          <FilterSelect
            wide
            label={t('traces.filter.person')}
            value={search.person ?? ALL}
            options={[
              { id: ALL, label: t('traces.filter.everyone') },
              ...(members ?? []).map((m) => ({ id: m.principalId, label: m.displayName })),
            ]}
            onChange={(id) => set({ person: id === ALL ? undefined : id })}
          />
        )}
        <FilterSelect
          label={t('traces.filter.surface')}
          value={search.surface ?? ALL}
          options={[
            { id: ALL, label: t('traces.filter.all') },
            ...SURFACES.map((s) => ({ id: s, label: surfaceName(s) })),
          ]}
          onChange={(id) =>
            set({ surface: id === ALL ? undefined : (id as RequestsSearch['surface']) })
          }
        />
        <FilterSelect
          label={t('traces.filter.outcome')}
          value={search.outcome ?? ALL}
          options={[
            { id: ALL, label: t('traces.filter.all') },
            ...REQUEST_OUTCOMES.map((o) => ({ id: o, label: t(OUTCOME[o]) })),
          ]}
          onChange={(id) => set({ outcome: id === ALL ? undefined : (id as RequestOutcome) })}
        />
        <FilterSelect
          label={t('traces.filter.dates')}
          value={search.dates ?? 'this-month'}
          options={DATES.map((d) => ({ id: d, label: t(`traces.dates.${d}`) }))}
          onChange={(id) => set({ dates: id === 'this-month' ? undefined : (id as Dates) })}
        />
      </div>
      {/* Read out when a filter changes (accessibility.md); the table shows the result. */}
      <p role="status" className="sr-only">
        {page === undefined
          ? ''
          : total === 0
            ? t('traces.matchingNone')
            : total === 1
              ? t('traces.matchingOne')
              : t('traces.matching', { n: new Intl.NumberFormat('en').format(total) })}
      </p>
      {page !== undefined && rows.length === 0 ? (
        <EmptyList>{any ? t('traces.emptyFiltered') : t('traces.empty')}</EmptyList>
      ) : (
        <div className="flex flex-col gap-6">
          <span id={tableId} className="sr-only">
            {t('traces.table', { n: String(pageNumber) })}
          </span>
          <div className="overflow-hidden lk-card">
            <DataTable
              labelledBy={tableId}
              name={t('traces.table', { n: String(pageNumber) })}
              columns={[
                {
                  key: 'time',
                  header: t('traces.col.time'),
                  cell: (r: RequestSummaryView) => (
                    <span className="lk-num whitespace-nowrap">{formatTime(r.startedAt)}</span>
                  ),
                },
                {
                  key: 'person',
                  header: t('traces.col.person'),
                  cell: (r: RequestSummaryView) => (
                    <TwoLine
                      first={r.person?.name ?? t('traces.removedPerson')}
                      {...(r.principal?.kind === 'key'
                        ? { second: t('traces.key', { name: r.principal.name }) }
                        : {})}
                    />
                  ),
                },
                {
                  key: 'surface',
                  header: t('traces.col.surface'),
                  cell: (r: RequestSummaryView) =>
                    r.surface === null ? '' : surfaceName(r.surface),
                },
                {
                  key: 'model',
                  header: t('traces.col.model'),
                  cell: (r: RequestSummaryView) =>
                    r.model === null ? (
                      <span className="text-muted">{t('traces.none')}</span>
                    ) : (
                      names.model(r.model)
                    ),
                },
                {
                  key: 'outcome',
                  header: t('traces.col.outcome'),
                  cell: (r: RequestSummaryView) => (
                    <span className="flex flex-col items-start gap-1">
                      <OutcomeChip kind={r.outcomeKind} />
                      <span className="text-caption text-muted">{rowReason(r, names)}</span>
                    </span>
                  ),
                },
                {
                  key: 'duration',
                  header: t('traces.col.duration'),
                  numeric: true,
                  cell: (r: RequestSummaryView) => formatDuration(r.durationMs).text,
                },
                {
                  key: 'cost',
                  header: t('traces.col.cost'),
                  numeric: true,
                  cell: (r: RequestSummaryView) => (
                    <span className="font-medium">{requestCost(r.costMicroUsd)}</span>
                  ),
                },
                {
                  // The row's action: its header is for screen readers only, as drawn.
                  key: 'actions',
                  header: t('traces.col.trace'),
                  cell: (r: RequestSummaryView) => (
                    <Link
                      to="/workspaces/$workspaceId/requests/$requestId"
                      params={{ workspaceId, requestId: r.requestId }}
                      aria-label={t('traces.viewFor', {
                        person: r.person?.name ?? t('traces.removedPerson'),
                        time: formatTime(r.startedAt),
                      })}
                      className="lk-link lk-link-alone text-small whitespace-nowrap"
                    >
                      {t('traces.view')}
                    </Link>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(r) => r.requestId}
            />
          </div>
          {total > 0 && (
            <Pager
              byTime
              from={(pageNumber - 1) * pageSize + 1}
              to={(pageNumber - 1) * pageSize + rows.length}
              total={total}
              hasPrevious={pageNumber > 1}
              hasNext={page?.nextBefore !== null && page?.nextBefore !== undefined}
              onPrevious={() => setCursors((list) => (list.length > 1 ? list.slice(0, -1) : list))}
              onNext={() => {
                const next = page?.nextBefore;
                if (next !== null && next !== undefined) setCursors((list) => [...list, next]);
              }}
            />
          )}
        </div>
      )}
    </>
  );
}
