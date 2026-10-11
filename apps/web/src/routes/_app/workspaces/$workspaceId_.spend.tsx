import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { ErrorNotice } from '../../../components/patterns/notices.tsx';
import { PageTabs } from '../../../components/patterns/tabs.tsx';
import { RangePills, validateSpendSearch } from '../../../components/spend/range.tsx';
import { t } from '../../../i18n/index.ts';
import { budgetStatusQuery, workspaceQuery } from '../../../lib/queries.ts';
import { isAdminRole } from '../../../lib/roles.ts';
import { formatDays, rangeDays } from '../../../lib/spend.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * Spend and budgets (BG-1, BG-10, BG-11, F5; Spend-Admin, Spend-Budgets and Spend-Member boards).
 * Admins get two sections as a tablist: Report here, and Budgets and alerts at /spend/budgets.
 * Members get one page, Your spend, with their own numbers only; the api sends nothing else
 * (F5). The date range is a group of toggle buttons with aria-pressed, over the report only.
 * A banner at the top says when budgets cannot be checked, since every request is then refused
 * (BG-4).
 */

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/spend')({
  validateSearch: validateSpendSearch,
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
  },
  component: SpendLayout,
});

function SpendLayout() {
  const { workspaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const matchRoute = useMatchRoute();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  // Read in the browser only: the banner is for an outage now, not when the page was rendered.
  const { data: status } = useQuery(budgetStatusQuery(workspaceId));
  const admin = isAdminRole(workspace.role);
  const onBudgets =
    matchRoute({ to: '/workspaces/$workspaceId/spend/budgets', params: { workspaceId } }) !== false;
  const range = search.range ?? 'this-month';
  const days = rangeDays(range, new Date(), search) ?? rangeDays('this-month', new Date());

  const pills = !onBudgets && (
    <RangePills search={search} onChange={(next) => void navigate({ search: next })} />
  );

  return (
    <>
      <PageHeader
        title={admin ? t('spend.page.title') : t('spend.page.memberTitle')}
        lede={
          !admin && days !== null
            ? t('spend.page.memberIntro', {
                workspace: workspace.name,
                days: formatDays(days.from, days.to),
              })
            : onBudgets
              ? t('spend.page.budgetsIntro')
              : t('spend.page.reportIntro', { workspace: workspace.name })
        }
        actions={pills}
      />
      {status?.available === false && (
        <ErrorNotice title={t('spend.unavailable.title')}>
          {t('spend.unavailable.body')}
        </ErrorNotice>
      )}
      {admin ? (
        <PageTabs
          label={t('spend.page.sections')}
          selected={onBudgets ? 'budgets' : 'report'}
          onSelectionChange={(id) =>
            void navigate({
              to:
                id === 'budgets'
                  ? '/workspaces/$workspaceId/spend/budgets'
                  : '/workspaces/$workspaceId/spend',
              params: { workspaceId },
              search: id === 'budgets' ? {} : (prev) => prev,
            })
          }
          items={[
            { id: 'report', label: t('spend.page.report'), panel: <Outlet /> },
            { id: 'budgets', label: t('spend.page.budgets'), panel: <Outlet /> },
          ]}
        />
      ) : (
        <Outlet />
      )}
    </>
  );
}
