import { useId, useState } from 'react';
import { Button } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { MemberView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import { formatDay } from '../../lib/format.ts';
import { CardInset, CardSection } from '../patterns/card-section.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable, RowActions, TwoLine } from '../patterns/data-table.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { StatusChip } from '../patterns/status-chip.tsx';

/*
 * Members (ID-3; Workspace and Workspace-Member boards). Admins change roles and remove people;
 * members read the same list. Row actions name who they act on. Removing someone and leaving use
 * a plain confirm. Six people show at first, and Show all opens the rest in place.
 */

const PREVIEW = 6;

export function MembersCard({
  workspaceId,
  workspaceName,
  members,
  admin,
  selfId,
}: {
  workspaceId: string;
  workspaceName: string;
  members: readonly MemberView[];
  admin: boolean;
  selfId: string;
}) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'members'] });
  const failed = (e: unknown) =>
    setError(
      e instanceof ApiError && e.code === 'last_workspace_admin'
        ? t('home.lastAdmin')
        : t('app.error'),
    );
  const setRole = useMutation({
    mutationFn: (m: MemberView) =>
      api(`/api/workspaces/${workspaceId}/members/${m.principalId}`, {
        method: 'PUT',
        body: { role: m.role === 'admin' ? 'member' : 'admin' },
      }),
    onSuccess: refresh,
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (m: MemberView) =>
      api(`/api/workspaces/${workspaceId}/members/${m.principalId}`, { method: 'DELETE' }),
    onSuccess: async (_, m) => {
      setRemoving(null);
      if (m.principalId === selfId) {
        await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
        await navigate({ to: '/workspaces' });
        return;
      }
      await refresh();
    },
    onError: (e) => {
      setRemoving(null);
      failed(e);
    },
  });
  // The newest last, as the board lists them.
  const ordered = members.toSorted((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  const shown = all || ordered.length <= PREVIEW + 1 ? ordered : ordered.slice(0, PREVIEW);
  const self = removing?.principalId === selfId;

  return (
    <CardSection
      title={t('home.members.title')}
      subtitle={
        members.length === 1
          ? t('home.members.countOne')
          : t('home.members.count', { n: String(members.length) })
      }
      titleId={titleId}
      flush
    >
      {error !== null && (
        <CardInset>
          <ErrorNotice title={error} />
        </CardInset>
      )}
      <DataTable
        labelledBy={titleId}
        name={t('home.members.title')}
        columns={[
          {
            key: 'person',
            header: t('home.col.person'),
            cell: (m: MemberView) => (
              <TwoLine first={m.displayName} {...(m.email === null ? {} : { second: m.email })} />
            ),
          },
          {
            key: 'role',
            header: t('home.col.role'),
            cell: (m: MemberView) => (
              <StatusChip tone={m.role === 'admin' ? 'outline' : 'neutral'}>
                {m.role === 'admin' ? t('home.role.admin') : t('home.role.member')}
              </StatusChip>
            ),
          },
          {
            key: 'joined',
            header: t('home.col.joined'),
            cell: (m: MemberView) => formatDay(m.joinedAt),
          },
          ...(admin || members.some((m) => m.principalId === selfId)
            ? [
                {
                  key: 'actions',
                  header: t('home.col.actions'),
                  cell: (m: MemberView) =>
                    m.principalId === selfId ? (
                      <Button
                        variant="ghost"
                        className="lk-danger-text"
                        aria-label={t('home.leaveFor', { workspace: workspaceName })}
                        onPress={() => setRemoving(m)}
                      >
                        {t('home.leave')}
                      </Button>
                    ) : admin ? (
                      <RowActions
                        name={m.displayName}
                        actions={[
                          {
                            id: 'role',
                            label: m.role === 'admin' ? t('home.makeMember') : t('home.makeAdmin'),
                            name:
                              m.role === 'admin'
                                ? t('home.makeMemberFor', { name: m.displayName })
                                : t('home.makeAdminFor', { name: m.displayName }),
                            isPending:
                              setRole.isPending && setRole.variables?.principalId === m.principalId,
                            onAction: () => {
                              setError(null);
                              setRole.mutate(m);
                            },
                          },
                          {
                            id: 'remove',
                            label: t('home.remove'),
                            name: t('home.removeFor', { name: m.displayName }),
                            danger: true,
                            onAction: () => setRemoving(m),
                          },
                        ]}
                      />
                    ) : null,
                },
              ]
            : []),
        ]}
        rows={shown}
        rowKey={(m) => m.principalId}
      />
      {ordered.length > PREVIEW + 1 && (
        <div className="px-5 pb-4">
          <Button
            variant="ghost"
            className="lk-link"
            aria-expanded={all}
            onPress={() => setAll((v) => !v)}
          >
            {all ? t('home.showFewer') : t('home.showAll', { n: String(ordered.length) })}
          </Button>
        </div>
      )}
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={
          self
            ? t('home.leaveTitle', { workspace: workspaceName })
            : t('home.removeTitle', { name: removing?.displayName ?? '', workspace: workspaceName })
        }
        confirmLabel={self ? t('home.leave') : t('home.remove')}
        isPending={remove.isPending}
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing);
        }}
      >
        {self ? t('home.leaveBody') : t('home.removeBody')}
      </ConfirmDialog>
    </CardSection>
  );
}
