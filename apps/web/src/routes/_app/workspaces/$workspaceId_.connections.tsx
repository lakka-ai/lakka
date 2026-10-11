import { useId, useState } from 'react';
import { Button } from '@heroui/react';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type {
  AvailableToolView,
  McpConnectStartView,
  McpConnectionView,
  ToolGrantView,
} from '@lakka/contracts';
import { CardSection, EmptyList } from '../../../components/patterns/card-section.tsx';
import { ConfirmDialog } from '../../../components/patterns/confirm-dialog.tsx';
import { DataTable } from '../../../components/patterns/data-table.tsx';
import { ErrorNotice, InfoNote } from '../../../components/patterns/notices.tsx';
import { toolLabel } from '../../../components/tools/tools.tsx';
import { t } from '../../../i18n/index.ts';
import { api, ApiError, notAllowedOrigin } from '../../../lib/api.ts';
import { formatDay } from '../../../lib/format.ts';
import {
  availableToolsQuery,
  mcpConnectionsQuery,
  toolGrantsQuery,
  workspaceQuery,
} from '../../../lib/queries.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';
import { StatusChip } from '../../../components/patterns/status-chip.tsx';
import { Icon } from '../../../components/icons.tsx';

/*
 * Your connections (TL-2, TL-4, TL-5, ADR 0068, ADR 0096; Connections board), for everyone in
 * the workspace: the accounts a tool acts as, one row per server saying what it needs; the tools
 * they can use and what happens before each runs; and the standing approvals they gave. The
 * authorization server sends people back here with the outcome in the search string.
 */

const RESULTS = ['connected', 'denied', 'failed'] as const;
type Result = (typeof RESULTS)[number];

interface ConnectionsSearch {
  result?: Result;
}

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/connections')({
  validateSearch: (search: Record<string, unknown>): ConnectionsSearch => {
    const result = RESULTS.find((r) => r === search['result']);
    return result === undefined ? {} : { result };
  },
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const workspace = await queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
    if (workspace.role === null) return;
    await Promise.all([
      queryClient.ensureQueryData(mcpConnectionsQuery(params.workspaceId)),
      queryClient.ensureQueryData(availableToolsQuery(params.workspaceId)),
      queryClient.ensureQueryData(toolGrantsQuery(params.workspaceId, 'mine')),
    ]);
  },
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const { workspaceId } = Route.useParams();
  const { result } = Route.useSearch();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  return (
    <>
      <PageHeader title={t('conns.title')} lede={t('conns.intro')} />
      {workspace.role === null ? (
        <InfoNote>{t('conns.membersOnly')}</InfoNote>
      ) : (
        <>
          {result === 'connected' && <InfoNote announce>{t('conns.result.connected')}</InfoNote>}
          {result !== undefined && result !== 'connected' && (
            <ErrorNotice title={t(`conns.result.${result}`)} />
          )}
          <div className="flex flex-col gap-6">
            <Accounts workspaceId={workspaceId} />
            <Tools workspaceId={workspaceId} />
            <Approvals workspaceId={workspaceId} />
          </div>
        </>
      )}
    </>
  );
}

function accountLine(c: McpConnectionView): string {
  switch (c.authMode) {
    case 'oauth':
      return c.connected
        ? t('conns.connected')
        : t('conns.notConnected', { server: c.displayName });
    case 'shared':
      return c.hasSharedCredential ? t('conns.shared') : t('conns.sharedMissing');
    case 'none':
      return t('conns.none');
  }
}

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2)
  ).toUpperCase();
}

function Accounts({ workspaceId }: { workspaceId: string }) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const { data: connections } = useSuspenseQuery(mcpConnectionsQuery(workspaceId));
  const [disconnecting, setDisconnecting] = useState<McpConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/workspaces/${workspaceId}/mcp-connections`;
  const connect = useMutation({
    mutationFn: (serverId: string) =>
      api<McpConnectStartView>(`${path}/${serverId}`, { method: 'POST', body: {} }),
    // The authorization server takes it from here, and sends the person back to this page.
    onSuccess: ({ authorizationUrl }) => globalThis.location.assign(authorizationUrl),
    onError: (e) => {
      // The server, or the sign-in service it names, is not on the instance's allowlist (NF-S4).
      const origin = notAllowedOrigin(e);
      setError(
        origin !== null
          ? t('conns.originNotAllowed', { origin })
          : e instanceof ApiError && e.code === 'mcp_oauth_client_required'
            ? t('conns.clientRequired')
            : e instanceof ApiError && e.code === 'mcp_oauth_failed'
              ? t('conns.oauthFailed')
              : t('conns.connectFailed'),
      );
    },
  });
  const disconnect = useMutation({
    mutationFn: (serverId: string) => api(`${path}/${serverId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setDisconnecting(null);
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] });
    },
  });
  return (
    <CardSection title={t('conns.accounts')} titleId={titleId}>
      {error !== null && <ErrorNotice title={error} />}
      {connections.length === 0 ? (
        <EmptyList>{t('conns.empty')}</EmptyList>
      ) : (
        <ul aria-labelledby={titleId} className="flex flex-col">
          {connections.map((c) => (
            <li
              key={c.serverId}
              className="flex flex-wrap items-center gap-3 border-t border-separator py-3 first:border-t-0 first:pt-0 last:pb-0"
            >
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-caption font-semibold"
              >
                {initials(c.displayName)}
              </span>
              <span className="flex min-w-0 grow flex-col">
                <span className="font-semibold">{c.displayName}</span>
                <span
                  className={`flex items-center gap-1.5 text-small ${c.authMode === 'oauth' && c.connected ? 'text-success-soft-foreground' : 'text-muted'}`}
                >
                  {c.authMode === 'oauth' && c.connected && (
                    <Icon name="check" className="size-3.5" />
                  )}
                  {accountLine(c)}
                </span>
              </span>
              {c.authMode === 'oauth' &&
                (c.connected ? (
                  <Button
                    variant="outline"
                    aria-label={t('conns.disconnectFor', { server: c.displayName })}
                    onPress={() => setDisconnecting(c)}
                  >
                    {t('conns.disconnect')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    aria-label={t('conns.connectFor', { server: c.displayName })}
                    isPending={connect.isPending && connect.variables === c.serverId}
                    onPress={() => {
                      setError(null);
                      connect.mutate(c.serverId);
                    }}
                  >
                    {t('conns.connect')}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        isOpen={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        title={t('conns.disconnectTitle', { server: disconnecting?.displayName ?? '' })}
        confirmLabel={t('conns.disconnect')}
        isPending={disconnect.isPending}
        onConfirm={() => {
          if (disconnecting !== null) disconnect.mutate(disconnecting.serverId);
        }}
      >
        {t('conns.disconnectBody')}
      </ConfirmDialog>
    </CardSection>
  );
}

/** What happens before a tool runs: a chip, as drawn, or muted words while it cannot run. */
function Before({ tool }: { tool: AvailableToolView }) {
  if (tool.blockedBy === 'not_connected') {
    return (
      <span className="text-muted">
        {t('conns.connectFirst', { server: tool.serverDisplayName })}
      </span>
    );
  }
  if (tool.blockedBy === 'no_credential') {
    return <span className="text-muted">{t('conns.waitingShared')}</span>;
  }
  if (tool.standingApproval)
    return <StatusChip tone="success">{t('conns.alwaysAllow')}</StatusChip>;
  return tool.approvalRequired ? (
    <StatusChip tone="warning">{t('conns.asksFirst')}</StatusChip>
  ) : (
    <StatusChip tone="neutral">{t('conns.runsFreely')}</StatusChip>
  );
}

function Tools({ workspaceId }: { workspaceId: string }) {
  const titleId = useId();
  const { data: tools } = useSuspenseQuery(availableToolsQuery(workspaceId));
  return (
    <CardSection
      title={t('conns.tools')}
      subtitle={t('conns.toolsSubtitle')}
      titleId={titleId}
      flush={tools.length > 0}
    >
      {tools.length === 0 ? (
        <EmptyList>{t('conns.toolsEmpty')}</EmptyList>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={t('conns.tools')}
          columns={[
            {
              key: 'tool',
              header: t('conns.col.tool'),
              cell: (tool: AvailableToolView) => (
                <span className="font-mono text-small">
                  {toolLabel(tool.serverName, tool.name)}
                </span>
              ),
            },
            {
              key: 'server',
              header: t('conns.col.server'),
              cell: (tool: AvailableToolView) => tool.serverDisplayName,
            },
            {
              key: 'before',
              header: t('conns.col.before'),
              cell: (tool: AvailableToolView) => <Before tool={tool} />,
            },
          ]}
          rows={tools}
          rowKey={(tool) => tool.modelName}
        />
      )}
    </CardSection>
  );
}

function Approvals({ workspaceId }: { workspaceId: string }) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const { data: grants } = useSuspenseQuery(toolGrantsQuery(workspaceId, 'mine'));
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/workspaces/${workspaceId}/tool-grants/${id}`, { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] }),
  });
  return (
    <CardSection
      title={t('conns.approvals')}
      subtitle={t('conns.approvalsSubtitle')}
      titleId={titleId}
      flush={grants.length > 0}
    >
      {grants.length === 0 ? (
        <EmptyList>{t('conns.approvalsEmpty')}</EmptyList>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={t('conns.approvals')}
          columns={[
            {
              key: 'tool',
              header: t('conns.col.tool'),
              cell: (g: ToolGrantView) => (
                <span className="font-mono text-small">{toolLabel(g.serverName, g.toolName)}</span>
              ),
            },
            {
              key: 'since',
              header: t('conns.col.since'),
              cell: (g: ToolGrantView) => formatDay(g.grantedAt),
            },
            {
              key: 'actions',
              header: t('conns.col.actions'),
              cell: (g: ToolGrantView) => (
                <Button
                  variant="outline"
                  aria-label={t('conns.revokeFor', { tool: toolLabel(g.serverName, g.toolName) })}
                  isPending={revoke.isPending && revoke.variables === g.id}
                  onPress={() => revoke.mutate(g.id)}
                >
                  {t('conns.revoke')}
                </Button>
              ),
            },
          ]}
          rows={grants}
          rowKey={(g) => g.id}
        />
      )}
    </CardSection>
  );
}
