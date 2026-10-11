import { useState } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import type { McpServerView } from '@lakka/contracts';
import { ServerDialog } from '../../../components/tools/server-dialog.tsx';
import {
  AddServerButton,
  ApprovalsCard,
  ServersCard,
  ToolsCard,
} from '../../../components/tools/tools.tsx';
import { t } from '../../../i18n/index.ts';
import {
  mcpServersQuery,
  toolGrantsQuery,
  workspaceQuery,
  workspaceToolsQuery,
} from '../../../lib/queries.ts';
import { isAdminRole } from '../../../lib/roles.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * Tools (TL-1 to TL-5, ADR 0066 to ADR 0071, ADR 0096; Tools and Tools-Add boards), for
 * workspace admins: the tool servers, each server's tools with Enabled and Asks first, and the
 * standing approvals people made. A member who comes here is sent to Your connections, where
 * the tools they can use are listed; the api would refuse them this page's data anyway.
 */

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/tools')({
  loader: async ({ context, params }) => {
    const id = params.workspaceId;
    const { queryClient } = context;
    const workspace = await queryClient.ensureQueryData(workspaceQuery(id));
    if (!isAdminRole(workspace.role)) {
      throw redirect({ to: '/workspaces/$workspaceId/connections', params: { workspaceId: id } });
    }
    await Promise.all([
      queryClient.ensureQueryData(mcpServersQuery(id)),
      queryClient.ensureQueryData(workspaceToolsQuery(id)),
      queryClient.ensureQueryData(toolGrantsQuery(id, 'all')),
    ]);
  },
  component: ToolsPage,
});

function ToolsPage() {
  const { workspaceId } = Route.useParams();
  const { me } = Route.useRouteContext();
  const { data: servers } = useSuspenseQuery(mcpServersQuery(workspaceId));
  const { data: tools } = useSuspenseQuery(workspaceToolsQuery(workspaceId));
  const { data: grants } = useSuspenseQuery(toolGrantsQuery(workspaceId, 'all'));
  const [editing, setEditing] = useState<McpServerView | 'new' | null>(null);
  const [status, setStatus] = useState('');
  return (
    <>
      <PageHeader
        title={t('toolsPage.title')}
        lede={t('toolsPage.intro')}
        {...(servers.length === 0
          ? {}
          : { actions: <AddServerButton onPress={() => setEditing('new')} /> })}
      />
      <div className="flex flex-col gap-6">
        <ServersCard
          workspaceId={workspaceId}
          servers={servers}
          tools={tools}
          onAdd={() => setEditing('new')}
          onEdit={setEditing}
          status={status}
          onStatus={setStatus}
        />
        <ToolsCard workspaceId={workspaceId} servers={servers} tools={tools} />
        <ApprovalsCard workspaceId={workspaceId} grants={grants} />
      </div>
      {editing !== null && (
        <ServerDialog
          key={editing === 'new' ? 'new' : editing.id}
          workspaceId={workspaceId}
          server={editing === 'new' ? null : editing}
          instanceAdmin={me.isInstanceAdmin}
          onClose={() => setEditing(null)}
          onDone={setStatus}
        />
      )}
    </>
  );
}
