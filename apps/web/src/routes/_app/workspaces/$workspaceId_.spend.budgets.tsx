import { useState } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { AlertsCard } from '../../../components/spend/alerts.tsx';
import { CapDialog } from '../../../components/spend/cap-dialog.tsx';
import type { CapTarget } from '../../../components/spend/cap-dialog.tsx';
import {
  KeyCapsTable,
  MemberCapsTable,
  WorkspaceCapCard,
} from '../../../components/spend/caps.tsx';
import {
  alertHistoryQuery,
  keysQuery,
  membersQuery,
  webhookQuery,
  workspaceBudgetsQuery,
  workspaceQuery,
} from '../../../lib/queries.ts';
import { isAdminRole } from '../../../lib/roles.ts';

/*
 * Budgets and alerts (BG-1, BG-9, BG-10; Spend-Budgets board), for admins only: the workspace
 * cap, which instance admins set (Q1), member and key caps, and where alerts go. A member who
 * comes here is sent to their own spend; the api would refuse them the webhook anyway.
 */

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/spend/budgets')({
  loader: async ({ context, params }) => {
    const id = params.workspaceId;
    const { queryClient } = context;
    const workspace = await queryClient.ensureQueryData(workspaceQuery(id));
    if (!isAdminRole(workspace.role)) {
      throw redirect({ to: '/workspaces/$workspaceId/spend', params: { workspaceId: id } });
    }
    await Promise.all([
      queryClient.ensureQueryData(workspaceBudgetsQuery(id)),
      queryClient.ensureQueryData(membersQuery(id)),
      queryClient.ensureQueryData(keysQuery(id)),
      queryClient.ensureQueryData(webhookQuery(id)),
      queryClient.ensureQueryData(alertHistoryQuery(id)),
    ]);
  },
  component: BudgetsPage,
});

function BudgetsPage() {
  const { workspaceId } = Route.useParams();
  const { me } = Route.useRouteContext();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: budgets } = useSuspenseQuery(workspaceBudgetsQuery(workspaceId));
  const { data: members } = useSuspenseQuery(membersQuery(workspaceId));
  const { data: keys } = useSuspenseQuery(keysQuery(workspaceId));
  const [editing, setEditing] = useState<CapTarget | null>(null);
  const base = `/api/workspaces/${workspaceId}/budgets`;
  return (
    <div className="flex flex-col gap-6">
      <WorkspaceCapCard
        workspaceName={workspace.name}
        cap={budgets.workspace}
        canEdit={me.isInstanceAdmin}
        onEdit={() =>
          setEditing({
            kind: 'workspace',
            path: `${base}/workspace`,
            name: workspace.name,
            current: budgets.workspace,
            canRemove: true,
          })
        }
      />
      <MemberCapsTable
        members={members}
        budgets={budgets}
        onEdit={(member, budget) =>
          setEditing({
            kind: 'member',
            path: `${base}/members/${member.principalId}`,
            name: member.displayName,
            current: budget,
            canRemove: true,
          })
        }
      />
      <KeyCapsTable
        keys={keys}
        budgets={budgets}
        onEdit={(key, budget) =>
          setEditing({
            kind: 'key',
            path: `${base}/keys/${key.id}`,
            name: key.name,
            current: budget,
            canRemove: true,
          })
        }
      />
      <AlertsCard workspaceId={workspaceId} />
      <CapDialog target={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
