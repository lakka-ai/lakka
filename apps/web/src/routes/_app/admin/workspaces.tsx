import { useState } from 'react';
import { Button } from '@heroui/react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { CreateWorkspaceDialog, WorkspacesList } from '../../../components/admin/workspaces.tsx';
import { Icon } from '../../../components/icons.tsx';
import { t } from '../../../i18n/index.ts';
import {
  workspacesCountLine,
  workspacesSpendLine,
  workspaceSummaries,
} from '../../../lib/admin.ts';
import { spendQuery, usersQuery, workspacesQuery } from '../../../lib/queries.ts';
import { rangeDays } from '../../../lib/spend.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * Workspaces (ID-3; Admin-Workspaces board), for instance admins; the api enforces it. The first
 * page of the Admin group. Spend is this month's, from the same report as Instance spend.
 */

const thisMonth = () => rangeDays('this-month', new Date());

export const Route = createFileRoute('/_app/admin/workspaces')({
  beforeLoad: ({ context }) => {
    if (!context.me.isInstanceAdmin) throw redirect({ to: '/' });
  },
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(workspacesQuery),
      context.queryClient.ensureQueryData(usersQuery),
      context.queryClient.ensureQueryData(spendQuery(null, thisMonth())),
    ]),
  component: WorkspacesPage,
});

function WorkspacesPage() {
  const { me } = Route.useRouteContext();
  const { data: workspaces } = useSuspenseQuery(workspacesQuery);
  const { data: people } = useSuspenseQuery(usersQuery);
  const { data: report } = useSuspenseQuery(spendQuery(null, thisMonth()));
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  return (
    <>
      <PageHeader
        title={t('admin.workspaces.title')}
        lede={t('admin.workspaces.intro')}
        actions={
          <Button
            size="lg"
            variant="primary"
            onPress={() => {
              setStatus('');
              setCreating(true);
            }}
          >
            <Icon name="plus" />
            {t('admin.workspaces.create')}
          </Button>
        }
      />
      <WorkspacesList
        rows={workspaceSummaries(workspaces, people, report.byWorkspace)}
        summary={`${workspacesCountLine(workspaces, people)} ${workspacesSpendLine(report.byWorkspace)}`}
        status={status}
        onStatus={setStatus}
      />
      <CreateWorkspaceDialog
        isOpen={creating}
        onOpenChange={setCreating}
        people={people}
        me={me.actingUserId}
        onCreated={(name) => {
          setCreating(false);
          setStatus(t('admin.workspaces.wasCreated', { name }));
        }}
      />
    </>
  );
}
