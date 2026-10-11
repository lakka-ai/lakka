import { useEffect } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import {
  createFileRoute,
  Outlet,
  redirect,
  useLoaderData,
  useMatches,
  useMatchRoute,
  useParams,
} from '@tanstack/react-router';
import { AppShell } from '../components/shell/app-shell.tsx';
import { currentWorkspace, navItems, navModel } from '../components/shell/nav.ts';
import { t } from '../i18n/index.ts';
import { ApiError } from '../lib/api.ts';
import { meQuery, workspacesQuery } from '../lib/queries.ts';
import { rememberedLayout } from '../lib/layout-memory.ts';
import { rememberedWorkspace, rememberWorkspace } from '../lib/workspace-memory.ts';

/*
 * Layout for everything behind sign-in. The principal and their workspaces are loaded before
 * rendering, on the server during SSR (forwarding the cookie) and in the browser afterwards;
 * without a session the visitor is sent to /sign-in.
 */

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    try {
      const [me] = await Promise.all([
        context.queryClient.ensureQueryData(meQuery),
        context.queryClient.ensureQueryData(workspacesQuery),
      ]);
      return { me, rememberedWorkspaceId: rememberedWorkspace(), layout: rememberedLayout() };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw redirect({ to: '/sign-in' });
      throw error;
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const { me, rememberedWorkspaceId, layout } = Route.useRouteContext();
  const { sourceUrl } = useLoaderData({ from: '__root__' });
  const { data: workspaces } = useSuspenseQuery(workspacesQuery);
  const { workspaceId } = useParams({ strict: false });
  const matchRoute = useMatchRoute();
  const fullPage = useMatches({
    select: (matches) => matches.some((m) => m.staticData.fullPage === true),
  });

  const current = currentWorkspace(workspaces, workspaceId, rememberedWorkspaceId);
  const model = navModel(me, current);
  // Deeper pages, such as a trace under Requests or a page's second tab, belong to their menu
  // item.
  const active = navItems(model).find((item) =>
    matchRoute({ ...item.link, fuzzy: !('activeOptions' in item.link) }),
  );
  const onWorkspaces = matchRoute({ to: '/workspaces' }) !== false;
  const title =
    active !== undefined ? t(active.label) : onWorkspaces ? t('nav.workspaces') : t('app.name');

  useEffect(() => {
    if (current !== null && current.id === workspaceId) rememberWorkspace(current.id);
  }, [current, workspaceId]);

  return (
    <AppShell
      me={me}
      workspaces={workspaces}
      current={current}
      model={model}
      currentKey={active?.key}
      title={title}
      sourceUrl={sourceUrl}
      layout={layout}
      fullPage={fullPage}
    >
      <Outlet />
    </AppShell>
  );
}
