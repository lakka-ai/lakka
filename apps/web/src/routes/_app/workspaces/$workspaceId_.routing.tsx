import { useState } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Overrides, RoutingForMembers } from '../../../components/routing/overrides.tsx';
import { RoutesCard } from '../../../components/routing/routes.tsx';
import { RoutingSettings } from '../../../components/routing/settings.tsx';
import { TryPhrase } from '../../../components/routing/try-phrase.tsx';
import { t } from '../../../i18n/index.ts';
import {
  membersQuery,
  routingCandidatesQuery,
  routingOverridesQuery,
  routingPolicyQuery,
  workspaceModelsQuery,
  workspaceQuery,
} from '../../../lib/queries.ts';
import { isAdminRole } from '../../../lib/roles.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * Routing (RT-1, RT-2, RT-3, RT-5, RT-10, RT-11; Routing, Routing-Edit, Routing-States and
 * Phone-Routing boards). Admins set whether models are chosen automatically, the default and
 * pinned models, and the routes; try a phrase; and see where people chose another model, with
 * the messages they moved away on while the workspace records content (ADR 0114).
 * Members get a note saying who to ask: the api refuses them the policy (ADR 0094).
 */

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/routing')({
  loader: async ({ context, params }) => {
    const id = params.workspaceId;
    const { queryClient } = context;
    const workspace = await queryClient.ensureQueryData(workspaceQuery(id));
    await Promise.all(
      isAdminRole(workspace.role)
        ? [
            queryClient.ensureQueryData(routingPolicyQuery(id)),
            queryClient.ensureQueryData(workspaceModelsQuery(id)),
            queryClient.ensureQueryData(routingOverridesQuery(id)),
            queryClient.ensureQueryData(routingCandidatesQuery(id)),
          ]
        : [queryClient.ensureQueryData(membersQuery(id))],
    );
  },
  component: RoutingPage,
});

function RoutingPage() {
  const { workspaceId } = Route.useParams();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  return (
    <>
      <PageHeader title={t('routing.title')} lede={t('routing.intro')} />
      {isAdminRole(workspace.role) ? (
        <AdminRouting workspaceId={workspaceId} />
      ) : (
        <MemberRouting workspaceId={workspaceId} />
      )}
    </>
  );
}

function AdminRouting({ workspaceId }: { workspaceId: string }) {
  const { data: policy } = useSuspenseQuery(routingPolicyQuery(workspaceId));
  const { data: models } = useSuspenseQuery(workspaceModelsQuery(workspaceId));
  const { data: overrides } = useSuspenseQuery(routingOverridesQuery(workspaceId));
  const { data: candidates } = useSuspenseQuery(routingCandidatesQuery(workspaceId));
  const [routesShown, setRoutesShown] = useState(false);
  const on = policy.settings.routingEnabled;
  return (
    <div className="flex flex-col gap-6">
      <RoutingSettings
        workspaceId={workspaceId}
        policy={policy}
        models={models}
        routesShown={routesShown}
        onShowRoutes={setRoutesShown}
      />
      {(on || routesShown || policy.routes.length === 0) && (
        <RoutesCard workspaceId={workspaceId} policy={policy} models={models} />
      )}
      {on && policy.routes.length > 0 && <TryPhrase workspaceId={workspaceId} models={models} />}
      {on && (
        <Overrides
          workspaceId={workspaceId}
          view={overrides}
          candidates={candidates}
          policy={policy}
          models={models}
        />
      )}
    </div>
  );
}

function MemberRouting({ workspaceId }: { workspaceId: string }) {
  const { data: members } = useSuspenseQuery(membersQuery(workspaceId));
  return (
    <RoutingForMembers
      workspaceId={workspaceId}
      admins={members.filter((m) => m.role === 'admin').map((m) => m.displayName)}
    />
  );
}
