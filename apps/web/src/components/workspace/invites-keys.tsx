import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, FieldError, Input, Label, ListBox, Select, TextField } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BudgetView,
  CreatedInvite,
  InviteView,
  IssuedKey,
  KeyView,
  WorkspaceRole,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api } from '../../lib/api.ts';
import { formatDay } from '../../lib/format.ts';
import { formatMicroUsd } from '../../lib/money.ts';
import { CardInset, CardSection, EmptyList } from '../patterns/card-section.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable, RowActions, TwoLine } from '../patterns/data-table.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { SecretDialog } from '../patterns/secret-dialog.tsx';
import { CapDialog } from '../spend/cap-dialog.tsx';
import type { CapTarget } from '../spend/cap-dialog.tsx';
import { formatWhen } from '../spend/copy.ts';

/*
 * Invites and API keys (ID-4, ID-5, ID-7; Workspace and Workspace-Member boards). An invite link
 * and a new key are shown once, in the one-time secret dialog (Pattern 5). Withdraw and Revoke
 * use a plain confirm, and every row action names its target. A key's cap is set with the same
 * dialog as on Spend and budgets.
 */

const roleWord = (r: WorkspaceRole) =>
  r === 'admin' ? t('home.role.admin') : t('home.role.member');

export function InvitesCard({
  workspaceId,
  invites,
}: {
  workspaceId: string;
  invites: readonly InviteView[];
}) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<WorkspaceRole>('member');
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [withdrawing, setWithdrawing] = useState<InviteView | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'invites'] });
  const create = useMutation({
    mutationFn: () =>
      api<CreatedInvite>(`/api/workspaces/${workspaceId}/invites`, {
        method: 'POST',
        body: { role },
      }),
    onSuccess: async (result) => {
      setCreated(result);
      await refresh();
    },
  });
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      api(`/api/workspaces/${workspaceId}/invites/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setWithdrawing(null);
      await refresh();
    },
  });
  // The token goes in the fragment, which browsers never send to a server.
  const link =
    created === null ? '' : `${globalThis.location?.origin ?? ''}/invite#${created.token}`;
  const ordered = invites.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <CardSection
      title={t('home.invites.title')}
      subtitle={t('home.invites.subtitle')}
      titleId={titleId}
      flush
      actions={
        <span className="flex flex-wrap items-end gap-2">
          <Select
            value={role}
            onChange={(key) => setRole(key === 'admin' ? 'admin' : 'member')}
            className="flex w-32.5 flex-col gap-1"
          >
            <Label>{t('home.invites.role')}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {(['member', 'admin'] as const).map((r) => (
                  <ListBox.Item key={r} id={r} textValue={roleWord(r)}>
                    {roleWord(r)}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Button
            size="lg"
            variant="primary"
            isPending={create.isPending}
            onPress={() => create.mutate()}
          >
            {t('home.invites.create')}
          </Button>
        </span>
      }
    >
      {(create.isError || withdraw.isError) && (
        <CardInset>
          <ErrorNotice title={t('app.error')} />
        </CardInset>
      )}
      {ordered.length === 0 ? (
        <EmptyList>{t('home.invites.empty')}</EmptyList>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={t('home.invites.title')}
          columns={[
            { key: 'role', header: t('home.col.role'), cell: (i: InviteView) => roleWord(i.role) },
            {
              key: 'by',
              header: t('home.invites.madeBy'),
              cell: (i: InviteView) => i.createdBy.displayName,
            },
            {
              key: 'made',
              header: t('home.invites.made'),
              cell: (i: InviteView) => formatDay(i.createdAt),
            },
            {
              key: 'expires',
              header: t('home.invites.expires'),
              cell: (i: InviteView) => formatDay(i.expiresAt),
            },
            {
              key: 'actions',
              header: t('home.col.actions'),
              cell: (i: InviteView) => (
                <Button
                  variant="ghost"
                  className="lk-danger-text"
                  aria-label={t('home.invites.withdrawFor', {
                    role: roleWord(i.role).toLowerCase(),
                    date: formatDay(i.createdAt),
                  })}
                  onPress={() => setWithdrawing(i)}
                >
                  {t('home.invites.withdraw')}
                </Button>
              ),
            },
          ]}
          rows={ordered}
          rowKey={(i) => i.id}
        />
      )}
      <SecretDialog
        isOpen={created !== null}
        onSaved={() => setCreated(null)}
        title={t('home.invites.secretTitle')}
        warning={t('home.invites.secretWarning')}
        label={t('home.invites.secretLabel')}
        secret={link}
      />
      <ConfirmDialog
        isOpen={withdrawing !== null}
        onOpenChange={(open) => {
          if (!open) setWithdrawing(null);
        }}
        title={t('home.invites.withdrawTitle')}
        confirmLabel={t('home.invites.withdraw')}
        isPending={withdraw.isPending}
        onConfirm={() => {
          if (withdrawing !== null) withdraw.mutate(withdrawing.id);
        }}
      >
        {t('home.invites.withdrawBody')}
      </ConfirmDialog>
    </CardSection>
  );
}

export function KeysCard({
  workspaceId,
  keys,
  caps,
  admin,
  selfId,
  canCreate,
}: {
  workspaceId: string;
  keys: readonly KeyView[];
  caps: readonly BudgetView[];
  admin: boolean;
  selfId: string;
  /** Only members make keys here; an instance admin who is not one cannot (ID-5). */
  canCreate: boolean;
}) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [revoking, setRevoking] = useState<KeyView | null>(null);
  const [editing, setEditing] = useState<CapTarget | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] }),
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'budgets'] }),
    ]);
  const create = useMutation({
    mutationFn: (keyName: string) =>
      api<IssuedKey>(`/api/workspaces/${workspaceId}/keys`, {
        method: 'POST',
        body: { name: keyName },
      }),
    onSuccess: async (result) => {
      setIssued(result);
      setName('');
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/workspaces/${workspaceId}/keys/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRevoking(null);
      await refresh();
    },
  });
  const live = keys.filter(
    (k) => k.revokedAt === null && (admin || k.owner.principalId === selfId),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 100) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(trimmed);
  }

  const capOf = (k: KeyView) => caps.find((c) => c.keyId === k.id) ?? null;
  return (
    <CardSection
      title={admin ? t('home.keys.title') : t('home.keys.memberTitle')}
      subtitle={admin ? t('home.keys.subtitle') : t('home.keys.memberSubtitle')}
      titleId={titleId}
      flush
      actions={
        canCreate ? (
          // The button shares the field's row, so it lines up with the input whatever the label's
          // height, and an error under the input does not move it.
          <form
            onSubmit={submit}
            noValidate
            className="grid grid-cols-[minmax(0,13.75rem)_auto] items-center gap-x-2 gap-y-1"
          >
            <TextField value={name} onChange={setName} isInvalid={invalid} className="contents">
              <Label className="col-start-1">{t('home.keys.name')}</Label>
              <Input
                className="col-start-1 row-start-2"
                placeholder={t('home.keys.namePlaceholder')}
              />
              {invalid && (
                <FieldError className="col-start-1 row-start-3">
                  {t('home.keys.nameInvalid')}
                </FieldError>
              )}
            </TextField>
            <Button
              size="lg"
              type="submit"
              variant="primary"
              className="col-start-2 row-start-2"
              isPending={create.isPending}
            >
              {t('home.keys.create')}
            </Button>
          </form>
        ) : undefined
      }
    >
      {!canCreate && <p className="px-5 text-small text-muted">{t('home.keys.noKeysHere')}</p>}
      {(create.isError || revoke.isError) && (
        <CardInset>
          <ErrorNotice title={t('app.error')} />
        </CardInset>
      )}
      {live.length === 0 ? (
        <EmptyList>{admin ? t('home.keys.empty') : t('home.keys.memberEmpty')}</EmptyList>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={admin ? t('home.keys.title') : t('home.keys.memberTitle')}
          columns={[
            {
              key: 'key',
              header: t('home.keys.col.key'),
              cell: (k: KeyView) => (
                <TwoLine
                  first={k.name}
                  second={<span className="font-mono">{`${k.prefix}...`}</span>}
                />
              ),
            },
            ...(admin
              ? [
                  {
                    key: 'owner',
                    header: t('home.keys.col.owner'),
                    cell: (k: KeyView) =>
                      k.owner.principalId === selfId ? t('home.you') : k.owner.displayName,
                  },
                ]
              : []),
            {
              key: 'cap',
              header: t('home.keys.col.cap'),
              numeric: true,
              cell: (k: KeyView) => {
                const cap = capOf(k);
                return cap === null ? (
                  <span className="text-muted">{t('home.keys.noCap')}</span>
                ) : (
                  formatMicroUsd(cap.limitMicroUsd)
                );
              },
            },
            {
              key: 'used',
              header: t('home.keys.col.lastUsed'),
              cell: (k: KeyView) =>
                k.lastUsedAt === null ? t('home.keys.never') : formatWhen(k.lastUsedAt),
            },
            {
              key: 'actions',
              header: t('home.col.actions'),
              cell: (k: KeyView) => {
                const cap = capOf(k);
                return (
                  <RowActions
                    name={k.name}
                    actions={[
                      {
                        id: 'cap',
                        label: cap === null ? t('spend.caps.set') : t('spend.caps.edit'),
                        name:
                          cap === null
                            ? t('spend.caps.setFor', { name: k.name })
                            : t('spend.caps.editFor', { name: k.name }),
                        onAction: () =>
                          setEditing({
                            kind: 'key',
                            path: `/api/workspaces/${workspaceId}/budgets/keys/${k.id}`,
                            name: k.name,
                            current: cap,
                            canRemove: cap !== null,
                          }),
                      },
                      {
                        id: 'revoke',
                        label: t('home.keys.revoke'),
                        name: t('home.keys.revokeFor', { name: k.name }),
                        danger: true,
                        onAction: () => setRevoking(k),
                      },
                    ]}
                  />
                );
              },
            },
          ]}
          rows={live}
          rowKey={(k) => k.id}
        />
      )}
      <SecretDialog
        isOpen={issued !== null}
        onSaved={() => setIssued(null)}
        title={t('home.keys.secretTitle')}
        warning={t('home.keys.secretWarning')}
        label={t('home.keys.secretLabel')}
        secret={issued?.secret ?? ''}
      />
      <ConfirmDialog
        isOpen={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('home.keys.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('home.keys.revoke')}
        isPending={revoke.isPending}
        onConfirm={() => {
          if (revoking !== null) revoke.mutate(revoking.id);
        }}
      >
        {t('home.keys.revokeBody')}
      </ConfirmDialog>
      <CapDialog target={editing} onClose={() => setEditing(null)} />
    </CardSection>
  );
}
