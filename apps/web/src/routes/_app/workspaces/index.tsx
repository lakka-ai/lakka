import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EmptyList } from '../../../components/patterns/card-section.tsx';
import { ErrorNotice } from '../../../components/patterns/notices.tsx';
import { PageHeader } from '../../../components/patterns/page-header.tsx';
import { t } from '../../../i18n/index.ts';
import { roleLabel } from '../../../lib/roles.ts';
import { workspacesQuery } from '../../../lib/queries.ts';

/** Where the MCP authorization flow lands when it cannot tell which workspace it was for. */
interface HomeSearch {
  mcp?: 'denied' | 'failed';
}

export const Route = createFileRoute('/_app/workspaces/')({
  validateSearch: (search: Record<string, unknown>): HomeSearch =>
    search['mcp'] === 'denied' || search['mcp'] === 'failed' ? { mcp: search['mcp'] } : {},
  loader: ({ context }) => context.queryClient.ensureQueryData(workspacesQuery),
  component: Workspaces,
});

function Workspaces() {
  const { me } = Route.useRouteContext();
  const { data: workspaces } = useSuspenseQuery(workspacesQuery);
  const { mcp } = Route.useSearch();

  return (
    <>
      <PageHeader title={t('workspaces.title')} />
      {mcp !== undefined && <ErrorNotice title={t(`connections.outcome.${mcp}`)} />}
      {workspaces.length === 0 ? (
        <EmptyList>{t('workspaces.empty')}</EmptyList>
      ) : (
        // Each workspace is a card with its name, an h2 under the page's h1, and the role.
        <ul className="grid gap-3 sm:grid-cols-2">
          {workspaces.map((w) => (
            <li key={w.id} className="flex flex-col gap-0.5 lk-card p-4">
              <h2 className="text-heading">
                <Link
                  to="/workspaces/$workspaceId"
                  params={{ workspaceId: w.id }}
                  className="lk-link"
                >
                  {w.name}
                </Link>
              </h2>
              <p className="text-small text-muted">{roleLabel(w.role)}</p>
            </li>
          ))}
        </ul>
      )}
      {me.isInstanceAdmin && (
        // Creating and renaming moved to the Admin group (Admin-Workspaces board).
        <p className="text-muted">
          {t('workspaces.manage')}{' '}
          <Link to="/admin/workspaces" className="lk-link lk-link-alone">
            {t('workspaces.manageLink')}
          </Link>
        </p>
      )}
    </>
  );
}
