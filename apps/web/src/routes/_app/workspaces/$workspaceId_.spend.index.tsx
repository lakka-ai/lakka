import { useState } from 'react';
import { Button } from '@heroui/react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CapDialog } from '../../../components/spend/cap-dialog.tsx';
import type { CapTarget } from '../../../components/spend/cap-dialog.tsx';
import { MyCaps } from '../../../components/spend/caps.tsx';
import { NoSpend, ReportSkeleton, ReportView } from '../../../components/spend/report.tsx';
import type { RequestsLink } from '../../../components/spend/report.tsx';
import { t } from '../../../i18n/index.ts';
import {
  keysQuery,
  membersQuery,
  remainingBudgetQuery,
  spendQuery,
  workspaceBudgetsQuery,
  workspaceQuery,
} from '../../../lib/queries.ts';
import { formatDays, rangeDays } from '../../../lib/spend.ts';
import { isAdminRole } from '../../../lib/roles.ts';
import { Icon } from '../../../components/icons.tsx';

/*
 * The Report tab, or a member's Your spend (BG-11, F5). The range comes from the page's date
 * pills. Admins see the workspace; members see their own, with the caps that apply to them.
 */

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/spend/')({
  loaderDeps: ({ search }) => ({ range: search.range, from: search.from, to: search.to }),
  loader: async ({ context, params, deps }) => {
    const id = params.workspaceId;
    const { queryClient } = context;
    const workspace = await queryClient.ensureQueryData(workspaceQuery(id));
    const days = rangeDays(deps.range ?? 'this-month', new Date(), deps);
    await Promise.all([
      queryClient.ensureQueryData(spendQuery(id, days)),
      queryClient.ensureQueryData(workspaceBudgetsQuery(id)),
      queryClient.ensureQueryData(membersQuery(id)),
      ...(isAdminRole(workspace.role)
        ? []
        : [
            queryClient.ensureQueryData(remainingBudgetQuery(id)),
            queryClient.ensureQueryData(keysQuery(id)),
          ]),
    ]);
  },
  pendingComponent: ReportSkeleton,
  pendingMs: 200,
  component: SpendReportPage,
});

function SpendReportPage() {
  const { workspaceId } = Route.useParams();
  const search = Route.useSearch();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const kind = search.range ?? 'this-month';
  const props = {
    workspaceId,
    days: rangeDays(kind, new Date(), search),
    thisMonth: kind === 'this-month',
    link: { workspaceId, dates: kind === 'custom' ? ('all' as const) : kind },
  };
  return isAdminRole(workspace.role) ? <AdminReport {...props} /> : <MemberReport {...props} />;
}

interface ReportProps {
  workspaceId: string;
  days: { from: string; to: string } | null;
  thisMonth: boolean;
  link: RequestsLink;
}

function AdminReport({ workspaceId, days, thisMonth, link }: ReportProps) {
  const { me } = Route.useRouteContext();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: report } = useSuspenseQuery(spendQuery(workspaceId, days));
  const { data: budgets } = useSuspenseQuery(workspaceBudgetsQuery(workspaceId));
  const { data: members } = useSuspenseQuery(membersQuery(workspaceId));
  const [editing, setEditing] = useState<CapTarget | null>(null);
  // The Spent tile reads spend against the cap only for this month, the cap's own period.
  const cap = thisMonth && budgets.workspace?.period === 'monthly' ? budgets.workspace : null;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-small text-muted">{formatDays(report.from, report.to)}</p>
      {report.requests === 0 ? (
        <NoSpend
          thisMonth={thisMonth}
          noCap={budgets.workspace === null}
          {...(budgets.workspace === null && me.isInstanceAdmin
            ? {
                action: (
                  <Button
                    size="lg"
                    variant="primary"
                    onPress={() =>
                      setEditing({
                        kind: 'workspace',
                        path: `/api/workspaces/${workspaceId}/budgets/workspace`,
                        name: workspace.name,
                        current: null,
                        canRemove: true,
                      })
                    }
                  >
                    <Icon name="plus" />
                    {t('spend.caps.setWorkspace')}
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <ReportView report={report} variant="admin" cap={cap} members={members} link={link} />
      )}
      <CapDialog target={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function MemberReport({ workspaceId, days, thisMonth, link }: ReportProps) {
  const { me } = Route.useRouteContext();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: report } = useSuspenseQuery(spendQuery(workspaceId, days));
  const { data: budgets } = useSuspenseQuery(workspaceBudgetsQuery(workspaceId));
  const { data: members } = useSuspenseQuery(membersQuery(workspaceId));
  const { data: remaining } = useSuspenseQuery(remainingBudgetQuery(workspaceId));
  const { data: keys } = useSuspenseQuery(keysQuery(workspaceId));
  const [editing, setEditing] = useState<CapTarget | null>(null);
  const ownKeys = keys.filter((k) => k.owner.principalId === me.actingUserId);
  const admins = members.filter((m) => m.role === 'admin').map((m) => m.displayName);
  return (
    <div className="flex flex-col gap-6">
      <MyCaps
        workspaceName={workspace.name}
        applied={remaining?.caps ?? []}
        smallestScope={remaining?.scope ?? null}
        ownKeys={ownKeys}
        keyBudgets={budgets.keys}
        admins={admins}
        onEditKey={(key, budget) =>
          setEditing({
            kind: 'key',
            path: `/api/workspaces/${workspaceId}/budgets/keys/${key.id}`,
            name: key.name,
            current: budget,
            // An owner may remove a cap they set themselves; the api refuses an admin's.
            canRemove: budget !== null,
          })
        }
      />
      {report.requests === 0 ? (
        <NoSpend thisMonth={thisMonth} noCap={false} />
      ) : (
        <ReportView report={report} variant="member" cap={null} members={[]} link={link} />
      )}
      <CapDialog target={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
