import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { RangePills, validateSpendSearch } from '../../../components/spend/range.tsx';
import { NoSpend, ReportSkeleton, ReportView } from '../../../components/spend/report.tsx';
import { t } from '../../../i18n/index.ts';
import { instanceBudgetQuery, spendQuery } from '../../../lib/queries.ts';
import { formatDays, rangeDays } from '../../../lib/spend.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * The full instance report (BG-11; Admin-Spend board, "Same layout as a workspace report, with By
 * workspace added"). Its rows do not lead to Requests, which are listed per workspace.
 */

export const Route = createFileRoute('/_app/admin/spend_/report')({
  validateSearch: validateSpendSearch,
  beforeLoad: ({ context }) => {
    if (!context.me.isInstanceAdmin) throw redirect({ to: '/' });
  },
  loaderDeps: ({ search }) => ({ range: search.range, from: search.from, to: search.to }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(instanceBudgetQuery),
      context.queryClient.ensureQueryData(
        spendQuery(null, rangeDays(deps.range ?? 'this-month', new Date(), deps)),
      ),
    ]),
  pendingComponent: ReportSkeleton,
  pendingMs: 200,
  component: InstanceReport,
});

function InstanceReport() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const kind = search.range ?? 'this-month';
  const { data: budget } = useSuspenseQuery(instanceBudgetQuery);
  const { data: report } = useSuspenseQuery(spendQuery(null, rangeDays(kind, new Date(), search)));
  // The Spent tile reads spend against the cap only for this month, the cap's own period.
  const cap = kind === 'this-month' && budget?.period === 'monthly' ? budget : null;
  return (
    <>
      {/* Laid out as the request trace's header: the breadcrumb in its own row, then the title. */}
      <nav aria-label={t('admin.spend.crumbs')} className="text-body">
        <ol className="flex flex-wrap items-center gap-2">
          <li>
            <Link to="/admin/spend" className="lk-link lk-link-alone">
              {t('admin.spend.title')}
            </Link>
          </li>
        </ol>
      </nav>
      <PageHeader
        title={t('admin.spend.reportTitle')}
        lede={formatDays(report.from, report.to)}
        actions={
          <RangePills search={search} onChange={(next) => void navigate({ search: next })} />
        }
      />
      {report.requests === 0 ? (
        <NoSpend thisMonth={kind === 'this-month'} noCap={false} />
      ) : (
        <ReportView report={report} variant="instance" cap={cap} members={[]} link={null} />
      )}
    </>
  );
}
