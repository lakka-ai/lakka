import { useId, useState } from 'react';
import { Button } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ContentCaptureView,
  FirstPartyKind,
  ProviderConfigView,
  ProviderCoverageView,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { api } from '../../lib/api.ts';
import { formatDay } from '../../lib/format.ts';
import { providerLabel } from '../chat/copy.ts';
import { CardInset, CardSection } from '../patterns/card-section.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable, RowActions } from '../patterns/data-table.tsx';
import { UnitField, WriteOnlyField } from '../patterns/fields.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { CheckboxSetting, ReadOnlySetting, SettingsSection } from '../patterns/settings.tsx';
import { formatWhen } from '../spend/copy.ts';
import { StatusChip } from '../patterns/status-chip.tsx';
import { Icon } from '../icons.tsx';

/*
 * Model providers and content capture (PR-2, PR-3, PR-8, OB-4; Workspace board). A workspace key
 * overrides the instance's for one provider; a row says whose is used, never anything of the
 * instance key (ADR 0096). Keys are write-only (Pattern 6): the field stays empty. Removing one
 * asks first, since requests then use the instance key or are refused. Content capture is a
 * settings section (Pattern 12) applied by Save; members read the same two rows.
 */

interface Row {
  kind: FirstPartyKind;
  source: ProviderCoverageView['source'];
  config: ProviderConfigView | undefined;
}

const CHECK: Readonly<Record<string, MessageKey>> = {
  ok: 'home.providers.check.ok',
  auth_failed: 'home.providers.check.auth_failed',
  unreachable: 'home.providers.check.unreachable',
  error: 'home.providers.check.error',
};

export function ProvidersCard({
  workspaceId,
  coverage,
  configs,
}: {
  workspaceId: string;
  coverage: readonly ProviderCoverageView[];
  configs: readonly ProviderConfigView[];
}) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const [key, setKey] = useState('');
  const path = `/api/workspaces/${workspaceId}/providers`;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['providers', workspaceId] });
  const save = useMutation({
    mutationFn: (row: Row) =>
      row.config === undefined
        ? api(path, { method: 'POST', body: { kind: row.kind, apiKey: key } })
        : api(`${path}/${row.config.id}`, { method: 'PUT', body: { apiKey: key } }),
    onSuccess: async () => {
      setEditing(null);
      setKey('');
      await refresh();
    },
  });
  const check = useMutation({
    mutationFn: (id: string) => api(`${path}/${id}/test`, { method: 'POST', body: {} }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${path}/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });
  const rows: Row[] = coverage.map((c) => ({
    ...c,
    config: configs.find((p) => p.kind === c.kind && p.hasKey),
  }));
  const provider = (row: Row) => providerLabel(row.kind);

  return (
    <CardSection
      title={t('home.providers.title')}
      subtitle={t('home.providers.subtitle')}
      titleId={titleId}
      flush
    >
      {(check.isError || remove.isError) && (
        <CardInset>
          <ErrorNotice title={t('app.error')} />
        </CardInset>
      )}
      <DataTable
        labelledBy={titleId}
        name={t('home.providers.title')}
        columns={[
          {
            key: 'provider',
            header: t('home.providers.col.provider'),
            cell: (r: Row) => <span className="font-medium">{provider(r)}</span>,
          },
          {
            key: 'key',
            header: t('home.providers.col.key'),
            cell: (r: Row) =>
              r.source === 'workspace' ? (
                <StatusChip tone="success" icon="lock">
                  {t('home.providers.workspaceKey')}
                </StatusChip>
              ) : r.source === 'instance' ? (
                <StatusChip tone="neutral">{t('home.providers.instanceKey')}</StatusChip>
              ) : (
                <span className="text-muted">{t('home.providers.noKey')}</span>
              ),
          },
          {
            key: 'check',
            header: t('home.providers.col.check'),
            cell: (r: Row) => {
              if (r.config === undefined) {
                return r.source === 'instance' ? (
                  <span className="text-muted">{t('home.providers.notNeeded')}</span>
                ) : (
                  ''
                );
              }
              const last = r.config.lastTest;
              if (last === null) return t('home.providers.notChecked');
              const words = t(CHECK[last.status] ?? 'home.providers.check.error', {
                when: formatWhen(last.testedAt),
              });
              // A check's result in its tone, with an icon as well as words.
              return last.status === 'ok' ? (
                <span className="flex items-center gap-1.5 text-success-soft-foreground">
                  <Icon name="check" className="size-3.5" />
                  {words}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-danger-soft-foreground">
                  <Icon name="error" className="size-3.5" />
                  {words}
                </span>
              );
            },
          },
          {
            key: 'actions',
            header: t('home.col.actions'),
            cell: (r: Row) =>
              r.config === undefined ? (
                <Button
                  variant="outline"
                  aria-label={t('home.providers.addFor', { provider: provider(r) })}
                  onPress={() => setEditing(r)}
                >
                  {t('home.providers.add')}
                </Button>
              ) : (
                <RowActions
                  name={provider(r)}
                  actions={[
                    {
                      id: 'check',
                      label: t('home.providers.checkNow'),
                      name: t('home.providers.checkFor', { provider: provider(r) }),
                      isPending: check.isPending && check.variables === r.config.id,
                      onAction: () => {
                        if (r.config !== undefined) check.mutate(r.config.id);
                      },
                    },
                    {
                      id: 'replace',
                      label: t('home.providers.replace'),
                      name: t('home.providers.replaceFor', { provider: provider(r) }),
                      onAction: () => setEditing(r),
                    },
                    {
                      id: 'remove',
                      label: t('home.providers.remove'),
                      name: t('home.providers.removeFor', { provider: provider(r) }),
                      danger: true,
                      onAction: () => setRemoving(r),
                    },
                  ]}
                />
              ),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.kind}
      />
      {editing !== null && (
        <FormDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) {
              setEditing(null);
              setKey('');
            }
          }}
          title={t('home.providers.dialogTitle', { provider: provider(editing) })}
          submitLabel={t('home.providers.save')}
          isSubmitting={save.isPending}
          {...(save.isError
            ? { error: { title: t('home.providers.saveFailed'), body: t('app.error') } }
            : {})}
          onSubmit={() => save.mutate(editing)}
        >
          <WriteOnlyField
            label={t('home.providers.keyLabel')}
            isSet={editing.config !== undefined}
            value={key}
            onChange={setKey}
            isRequired
          />
        </FormDialog>
      )}
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('home.providers.removeTitle', {
          provider: removing === null ? '' : provider(removing),
        })}
        confirmLabel={t('home.providers.remove')}
        isPending={remove.isPending}
        onConfirm={() => {
          if (removing?.config !== undefined) remove.mutate(removing.config.id);
        }}
      >
        {removing !== null && coverage.find((c) => c.kind === removing.kind)?.instanceKey === true
          ? t('home.providers.removeInstance')
          : t('home.providers.removeNone', {
              provider: removing === null ? '' : provider(removing),
            })}
      </ConfirmDialog>
    </CardSection>
  );
}

export function CaptureCard({
  workspaceId,
  capture,
  admin,
}: {
  workspaceId: string;
  capture: ContentCaptureView;
  admin: boolean;
}) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(capture.enabled);
  const [days, setDays] = useState(String(capture.retentionDays));
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: (retentionDays: number) =>
      api(`/api/workspaces/${workspaceId}/content-capture`, {
        method: 'PUT',
        body: { enabled, retentionDays },
      }),
    onSuccess: async () => {
      setDone(true);
      await queryClient.invalidateQueries({
        queryKey: ['workspaces', workspaceId, 'content-capture'],
      });
    },
  });
  const changed =
    capture.changedBy === null || capture.changedAt === null
      ? null
      : t('home.capture.changed', {
          name: capture.changedBy.displayName,
          date: formatDay(capture.changedAt),
        });
  if (!admin) {
    return (
      <SettingsSection title={t('home.capture.title')}>
        <ReadOnlySetting
          label={t('home.capture.record')}
          description={t('home.capture.memberRecordHelp')}
          value={capture.enabled ? t('home.capture.on') : t('home.capture.off')}
        />
        <ReadOnlySetting
          label={t('home.capture.keptFor')}
          description={t('home.capture.keptForHelp')}
          value={t('home.capture.keptDays', { n: String(capture.retentionDays) })}
        />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection
      title={t('home.capture.title')}
      {...(changed === null ? {} : { subtitle: changed })}
      onSave={() => {
        const n = Number(days);
        if (!/^\d{1,2}$/.test(days.trim()) || n < 1 || n > 90) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        save.mutate(n);
      }}
      isSaving={save.isPending}
      saved={done}
    >
      {save.isError && <ErrorNotice title={t('app.error')} />}
      <CheckboxSetting
        label={t('home.capture.record')}
        description={t('home.capture.recordHelp')}
        isSelected={enabled}
        onChange={(v) => {
          setDone(false);
          setEnabled(v);
        }}
      />
      <UnitField
        setting
        label={t('home.capture.keep')}
        description={
          invalid
            ? t('home.capture.invalid')
            : enabled
              ? t('home.capture.keepHelp')
              : `${t('home.capture.keepHelp')} ${t('home.capture.keepOff')}`
        }
        suffix={t('home.capture.days')}
        alignEnd
        inputMode="numeric"
        value={days}
        onChange={(v) => {
          setDone(false);
          setDays(v);
        }}
        // Kept while recording is off, and used again when it is turned back on. Read-only
        // rather than disabled, so it keeps its contrast and says why it cannot change.
        isReadOnly={!enabled}
        isInvalid={invalid}
        className="lk-setting-row [&_[data-slot=input-group]]:w-37.5"
      />
    </SettingsSection>
  );
}
