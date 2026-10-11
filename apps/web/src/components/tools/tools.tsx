import { useId, useState } from 'react';
import { Button, Label, ListBox, Select } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  McpServerView,
  McpToolSyncView,
  ToolGrantView,
  WorkspaceToolView,
} from '@lakka/contracts';
import { t, tNodes } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import { formatDay } from '../../lib/format.ts';
import { Icon } from '../icons.tsx';
import { CardInset, CardSection, EmptyList } from '../patterns/card-section.tsx';
import { DataTable } from '../patterns/data-table.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { formatWhen } from '../spend/copy.ts';
import { syncFailure } from './server-dialog.tsx';
import { ToolSwitch } from './tool-switch.tsx';
import { StatusChip } from '../patterns/status-chip.tsx';

/*
 * Tools (TL-1, TL-3, TL-4, TL-5; Tools board). Each server says how it is reached, how it signs
 * in and when it last synced; a shared account is marked and explained. Switches are right here,
 * because turning a tool on or making it ask first applies at once; each names its tool, and a
 * tool that is off has its Asks first switch aria-disabled. Tools are shown as server.tool, as
 * chat shows them. Standing approvals can be revoked, and the tool then asks again.
 */

/** A tool as people see it: "github.search_code". */
export const toolLabel = (server: string, tool: string) => `${server}.${tool}`;

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Add a tool server: in the page header once there are servers, under the empty card's sentence before. */
export function AddServerButton({ onPress }: { onPress: () => void }) {
  return (
    <Button size="lg" variant="primary" onPress={onPress}>
      <Icon name="plus" />
      {t('toolsPage.add')}
    </Button>
  );
}

export function ServersCard({
  workspaceId,
  servers,
  tools,
  onAdd,
  onEdit,
  status,
  onStatus,
}: {
  workspaceId: string;
  servers: readonly McpServerView[];
  tools: readonly WorkspaceToolView[];
  onAdd: () => void;
  onEdit: (server: McpServerView) => void;
  status: string;
  onStatus: (status: string) => void;
}) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: (server: McpServerView) =>
      api<McpToolSyncView>(`/api/workspaces/${workspaceId}/mcp-servers/${server.id}/tools/sync`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (result, server) =>
      onStatus(
        t('toolsPage.synced.result', {
          server: server.displayName,
          added: String(result.added),
          updated: String(result.updated),
          removed: String(result.removed),
        }),
      ),
    onError: (e) =>
      onStatus(
        t('toolsPage.syncFailedNow', {
          reason: e instanceof ApiError ? e.message : t('app.error'),
        }),
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'mcp-servers'] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'tools'] }),
      ]),
  });
  const add = <AddServerButton onPress={onAdd} />;
  return (
    // With servers, Add a tool server sits in the page header, as drawn (AddServerButton).
    <CardSection title={t('toolsPage.servers')} titleId={titleId} flush={servers.length > 0}>
      <p role="status" className="sr-only">
        {status}
      </p>
      {servers.length === 0 ? (
        // Empty, the button follows the sentence that says why, as on Routing.
        <div className="flex flex-col items-start gap-3">
          <EmptyList>{t('toolsPage.empty')}</EmptyList>
          {add}
        </div>
      ) : (
        <ul aria-labelledby={titleId} className="flex flex-col">
          {servers.map((s) => {
            const count = tools.filter((tool) => tool.serverId === s.id).length;
            const failed = s.lastSync?.error ?? null;
            return (
              <li
                key={s.id}
                className="flex flex-col gap-3 border-t border-separator px-5 py-4 sm:flex-row sm:items-start"
              >
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-note bg-surface-secondary text-small font-semibold"
                >
                  {initials(s.displayName)}
                </span>
                <div className="flex min-w-0 grow flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-heading">{s.displayName}</h3>
                    <StatusChip tone={count === 0 ? 'neutral' : 'success'}>
                      {count === 0
                        ? t('toolsPage.noTools')
                        : count === 1
                          ? t('toolsPage.toolCountOne')
                          : t('toolsPage.toolCount', { n: String(count) })}
                    </StatusChip>
                    {s.authMode === 'shared' && (
                      <StatusChip tone="warning" icon="warning">
                        {t('toolsPage.sharedChip')}
                      </StatusChip>
                    )}
                  </div>
                  <p className="text-small break-all text-muted">
                    {s.transport === 'stdio'
                      ? tNodes('toolsPage.reachedCommand', {
                          command: (
                            <span key="command" className="font-mono text-foreground">
                              {[s.command ?? '', ...s.args].join(' ')}
                            </span>
                          ),
                        })
                      : tNodes('toolsPage.reachedHttp', {
                          url: (
                            <span key="url" className="font-mono text-foreground">
                              {s.url ?? ''}
                            </span>
                          ),
                        })}
                  </p>
                  <p className="text-small text-muted">{t(`toolsPage.signsIn.${s.authMode}`)}</p>
                  <p
                    className={`text-small ${failed === null ? 'text-muted' : 'text-danger-soft-foreground'}`}
                  >
                    {s.lastSync === null
                      ? t('toolsPage.notSynced')
                      : failed === null
                        ? t('toolsPage.synced', { when: formatWhen(s.lastSync.at) })
                        : t('toolsPage.syncFailed', {
                            when: formatWhen(s.lastSync.at),
                            reason: syncFailure(failed),
                          })}
                  </p>
                  {s.authMode === 'shared' && (
                    <p className="flex items-start gap-1.5 text-small text-warning-soft-foreground">
                      <Icon name="warning" className="mt-0.5 size-3.5" />
                      {s.hasSharedCredential
                        ? t('toolsPage.sharedWarning')
                        : t('toolsPage.noSharedCredential')}
                    </p>
                  )}
                </div>
                <span className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    variant="outline"
                    aria-label={t('toolsPage.syncFor', { server: s.displayName })}
                    isPending={sync.isPending && sync.variables?.id === s.id}
                    onPress={() => sync.mutate(s)}
                  >
                    {t('toolsPage.sync')}
                  </Button>
                  <Button
                    variant="outline"
                    aria-label={t('toolsPage.editFor', { server: s.displayName })}
                    onPress={() => onEdit(s)}
                  >
                    {t('toolsPage.edit')}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CardSection>
  );
}

export function ToolsCard({
  workspaceId,
  servers,
  tools,
}: {
  workspaceId: string;
  servers: readonly McpServerView[];
  tools: readonly WorkspaceToolView[];
}) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const [serverId, setServerId] = useState(servers[0]?.id ?? '');
  const server = servers.find((s) => s.id === serverId) ?? servers[0];
  const change = useMutation({
    mutationFn: (v: { id: string; body: { enabled?: boolean; approvalRequired?: boolean } }) =>
      api(`/api/workspaces/${workspaceId}/tools/${v.id}`, { method: 'PATCH', body: v.body }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'tools'] }),
  });
  if (server === undefined) return null;
  const shown = tools.filter((tool) => tool.serverId === server.id);
  return (
    <CardSection
      title={t('toolsPage.tools', { server: server.displayName })}
      subtitle={t('toolsPage.toolsSubtitle')}
      titleId={titleId}
      flush
      actions={
        servers.length > 1 ? (
          <Select
            value={server.id}
            onChange={(key) => setServerId(String(key))}
            className="flex w-48 flex-col gap-1"
          >
            <Label className="text-caption">{t('toolsPage.server')}</Label>
            <Select.Trigger className="h-9">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {servers.map((s) => (
                  <ListBox.Item key={s.id} id={s.id} textValue={s.displayName}>
                    {s.displayName}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        ) : undefined
      }
    >
      {change.isError && (
        <CardInset>
          <ErrorNotice
            title={change.error instanceof ApiError ? change.error.message : t('app.error')}
          />
        </CardInset>
      )}
      {shown.length === 0 ? (
        <EmptyList>{t('toolsPage.toolsEmpty')}</EmptyList>
      ) : (
        <>
          <DataTable
            labelledBy={titleId}
            name={t('toolsPage.tools', { server: server.displayName })}
            columns={[
              {
                key: 'tool',
                header: t('toolsPage.col.tool'),
                cell: (tool: WorkspaceToolView) => (
                  <span className="font-mono text-small">
                    {toolLabel(tool.serverName, tool.name)}
                  </span>
                ),
              },
              {
                key: 'what',
                header: t('toolsPage.col.what'),
                cell: (tool: WorkspaceToolView) => (
                  <span className="flex flex-col gap-0.5">
                    <span className="text-small text-muted">
                      {tool.title ?? tool.description ?? ''}
                    </span>
                    {tool.unusable !== null && (
                      <span className="text-caption text-muted">
                        {t(`toolsPage.unusable.${tool.unusable}`)}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'enabled',
                header: t('toolsPage.col.enabled'),
                cell: (tool: WorkspaceToolView) => {
                  const label = toolLabel(tool.serverName, tool.name);
                  return (
                    <ToolSwitch
                      label={t('toolsPage.enabledFor', { tool: label })}
                      isSelected={tool.enabled}
                      {...(tool.unusable === null
                        ? {}
                        : { disabledReason: t(`toolsPage.unusable.${tool.unusable}`) })}
                      onChange={(on) => change.mutate({ id: tool.id, body: { enabled: on } })}
                    />
                  );
                },
              },
              {
                key: 'asks',
                header: t('toolsPage.col.asks'),
                cell: (tool: WorkspaceToolView) => (
                  <ToolSwitch
                    label={t('toolsPage.asksFor', { tool: toolLabel(tool.serverName, tool.name) })}
                    isSelected={tool.approvalRequired}
                    {...(tool.enabled ? {} : { disabledReason: t('toolsPage.asksOff') })}
                    onChange={(on) =>
                      change.mutate({ id: tool.id, body: { approvalRequired: on } })
                    }
                  />
                ),
              },
            ]}
            rows={shown}
            rowKey={(tool) => tool.id}
          />
          <p className="px-5 pb-4 text-small text-muted">{t('toolsPage.toolsNote')}</p>
        </>
      )}
    </CardSection>
  );
}

export function ApprovalsCard({
  workspaceId,
  grants,
}: {
  workspaceId: string;
  grants: readonly ToolGrantView[];
}) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/workspaces/${workspaceId}/tools/grants/${id}`, { method: 'DELETE' }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'tool-grants'] }),
  });
  return (
    <CardSection
      title={t('toolsPage.approvals')}
      subtitle={t('toolsPage.approvalsSubtitle')}
      titleId={titleId}
      flush={grants.length > 0}
    >
      {grants.length === 0 ? (
        <EmptyList>{t('toolsPage.approvalsEmpty')}</EmptyList>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={t('toolsPage.approvals')}
          columns={[
            {
              key: 'person',
              header: t('toolsPage.col.person'),
              cell: (g: ToolGrantView) => g.principalName,
            },
            {
              key: 'tool',
              header: t('toolsPage.col.tool'),
              cell: (g: ToolGrantView) => (
                <span className="font-mono text-small">{toolLabel(g.serverName, g.toolName)}</span>
              ),
            },
            {
              key: 'since',
              header: t('toolsPage.col.since'),
              cell: (g: ToolGrantView) => formatDay(g.grantedAt),
            },
            {
              key: 'actions',
              header: t('toolsPage.col.actions'),
              cell: (g: ToolGrantView) => (
                <Button
                  variant="outline"
                  aria-label={t('toolsPage.revokeFor', {
                    tool: toolLabel(g.serverName, g.toolName),
                    person: g.principalName,
                  })}
                  isPending={revoke.isPending && revoke.variables === g.id}
                  onPress={() => revoke.mutate(g.id)}
                >
                  {t('toolsPage.revoke')}
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
