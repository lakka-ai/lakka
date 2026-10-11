import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { InfoNote } from '../../../components/patterns/notices.tsx';
import { InvitesCard, KeysCard } from '../../../components/workspace/invites-keys.tsx';
import { MembersCard } from '../../../components/workspace/members.tsx';
import { CaptureCard, ProvidersCard } from '../../../components/workspace/providers-capture.tsx';
import { t } from '../../../i18n/index.ts';
import {
  contentCaptureQuery,
  invitesQuery,
  keysQuery,
  membersQuery,
  providerCoverageQuery,
  providersQuery,
  workspaceBudgetsQuery,
  workspaceQuery,
} from '../../../lib/queries.ts';
import { isAdminRole } from '../../../lib/roles.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * Workspace settings (ID-3 to ID-7, PR-8, OB-4; Workspace and Workspace-Member boards): the people,
 * invites, API keys, model provider keys and content capture of one workspace. Members get the
 * same page without the admin sections, and the admin-only data is never fetched for them.
 */

export const Route = createFileRoute('/_app/workspaces/$workspaceId')({
  loader: async ({ context, params }) => {
    const id = params.workspaceId;
    const { queryClient } = context;
    const workspace = await queryClient.ensureQueryData(workspaceQuery(id));
    await Promise.all([
      queryClient.ensureQueryData(membersQuery(id)),
      queryClient.ensureQueryData(keysQuery(id)),
      queryClient.ensureQueryData(workspaceBudgetsQuery(id)),
      queryClient.ensureQueryData(contentCaptureQuery(id)),
      ...(isAdminRole(workspace.role)
        ? [
            queryClient.ensureQueryData(invitesQuery(id)),
            queryClient.ensureQueryData(providersQuery(id)),
            queryClient.ensureQueryData(providerCoverageQuery(id)),
          ]
        : []),
    ]);
  },
  component: WorkspacePage,
});

function WorkspacePage() {
  const { workspaceId } = Route.useParams();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const admin = isAdminRole(workspace.role);
  return (
    <>
      <PageHeader title={t('home.title')} lede={t('home.intro', { workspace: workspace.name })} />
      {!admin && <InfoNote>{t('home.memberNote')}</InfoNote>}
      <div className="flex flex-col gap-6">
        <Members workspaceId={workspaceId} />
        {admin && <Invites workspaceId={workspaceId} />}
        <Keys workspaceId={workspaceId} />
        {admin && <Providers workspaceId={workspaceId} />}
        <Capture workspaceId={workspaceId} admin={admin} />
      </div>
    </>
  );
}

function Members({ workspaceId }: { workspaceId: string }) {
  const { me } = Route.useRouteContext();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: members } = useSuspenseQuery(membersQuery(workspaceId));
  return (
    <MembersCard
      workspaceId={workspaceId}
      workspaceName={workspace.name}
      members={members}
      admin={isAdminRole(workspace.role)}
      selfId={me.actingUserId}
    />
  );
}

function Invites({ workspaceId }: { workspaceId: string }) {
  const { data: invites } = useSuspenseQuery(invitesQuery(workspaceId));
  return <InvitesCard workspaceId={workspaceId} invites={invites} />;
}

function Keys({ workspaceId }: { workspaceId: string }) {
  const { me } = Route.useRouteContext();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: keys } = useSuspenseQuery(keysQuery(workspaceId));
  const { data: budgets } = useSuspenseQuery(workspaceBudgetsQuery(workspaceId));
  return (
    <KeysCard
      workspaceId={workspaceId}
      keys={keys}
      caps={budgets.keys}
      admin={isAdminRole(workspace.role)}
      selfId={me.actingUserId}
      canCreate={workspace.role !== null}
    />
  );
}

function Providers({ workspaceId }: { workspaceId: string }) {
  const { data: configs } = useSuspenseQuery(providersQuery(workspaceId));
  const { data: coverage } = useSuspenseQuery(providerCoverageQuery(workspaceId));
  return <ProvidersCard workspaceId={workspaceId} coverage={coverage} configs={configs} />;
}

function Capture({ workspaceId, admin }: { workspaceId: string; admin: boolean }) {
  const { data: capture } = useSuspenseQuery(contentCaptureQuery(workspaceId));
  return <CaptureCard workspaceId={workspaceId} capture={capture} admin={admin} />;
}
