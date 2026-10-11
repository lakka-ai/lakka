import { useId, useState } from 'react';
import { Button, Description, FieldError, Input, Label, TextField } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FIRST_PARTY_KINDS } from '@lakka/contracts';
import type { FirstPartyKind, ProviderConfigView, ProviderTestResult } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import { providerLabel } from '../chat/copy.ts';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';
import { CardInset, CardSection } from '../patterns/card-section.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable, RowActions } from '../patterns/data-table.tsx';
import { WriteOnlyField } from '../patterns/fields.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { formatWhen } from '../spend/copy.ts';
import { StatusChip } from '../patterns/status-chip.tsx';

/*
 * Model providers for the whole server (PR-1, PR-2, PR-3, PR-8; Admin-Providers and
 * Admin-Dialogs boards). One row per first-party provider, set or not, and one per
 * OpenAI-compatible endpoint, online such as OpenRouter or local such as Ollama. The last check is
 * text, with its icon aria-hidden; Check updates it in place and a status line says the result.
 * Replace key opens a dialog that says what the last check found, because saving a new key clears
 * it, then saves and checks. Adding an endpoint and removing one are not drawn; they follow
 * Pattern 13 and Pattern 10 (ADR 0097).
 */

type Row =
  | { kind: 'config'; config: ProviderConfigView }
  | { kind: 'missing'; provider: FirstPartyKind };

type Editing =
  | { kind: 'key'; row: Row }
  | { kind: 'address'; config: ProviderConfigView }
  | { kind: 'local' };

const nameOf = (row: Row) =>
  row.kind === 'missing'
    ? providerLabel(row.provider)
    : row.config.kind === 'openai-compatible'
      ? row.config.name.slice(0, 1).toUpperCase() + row.config.name.slice(1)
      : providerLabel(row.config.kind);

function checkLook(last: ProviderTestResult): { icon: IconName; tone: string; word: string } {
  switch (last.status) {
    case 'ok':
      return { icon: 'check', tone: 'text-success-soft-foreground', word: t('admin.providers.ok') };
    case 'auth_failed':
      return {
        icon: 'error',
        tone: 'text-danger-soft-foreground',
        word: t('admin.providers.refused'),
      };
    case 'unreachable':
      return {
        icon: 'error',
        tone: 'text-danger-soft-foreground',
        word: t('admin.providers.unreachable'),
      };
    case 'error':
      return {
        icon: 'warning',
        tone: 'text-danger-soft-foreground',
        word: t('admin.providers.error'),
      };
  }
}

function checkDetail(last: ProviderTestResult, name: string, local: boolean): string {
  switch (last.status) {
    case 'ok':
      return formatWhen(last.testedAt);
    case 'auth_failed':
      return t('admin.providers.refusedDetail', { provider: name });
    case 'unreachable':
      return local
        ? t('admin.providers.unreachableEndpoint', { provider: name })
        : t('admin.providers.unreachableDetail', { provider: name });
    case 'error':
      return t('admin.providers.errorDetail', { provider: name });
  }
}

/** The check result as one sentence, for the status line. */
export function checkSentence(last: ProviderTestResult | null, name: string, local: boolean) {
  if (last === null) return t('admin.providers.notChecked');
  const look = checkLook(last);
  return `${name}: ${look.word}. ${checkDetail(last, name, local)}`;
}

function LastCheck({ config, name }: { config: ProviderConfigView; name: string }) {
  const last = config.lastTest;
  if (last === null) return <span className="text-muted">{t('admin.providers.notChecked')}</span>;
  const look = checkLook(last);
  return (
    <span className="flex items-start gap-1.5">
      <Icon name={look.icon} className={`mt-0.5 size-3.5 shrink-0 ${look.tone}`} />
      <span className="flex flex-col leading-tight">
        <span className={`font-medium ${look.tone}`}>{look.word}</span>
        <span className="text-caption text-muted">
          {checkDetail(last, name, config.kind === 'openai-compatible')}
        </span>
      </span>
    </span>
  );
}

export function ModelProviders({ configs }: { configs: readonly ProviderConfigView[] }) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<ProviderConfigView | null>(null);
  const [status, setStatus] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['providers', 'instance'] });
  const instance = configs.filter((c) => c.workspaceId === null);
  const rows: Row[] = [
    ...FIRST_PARTY_KINDS.map((provider): Row => {
      const config = instance.find((c) => c.kind === provider);
      return config === undefined ? { kind: 'missing', provider } : { kind: 'config', config };
    }),
    ...instance
      .filter((c) => c.kind === 'openai-compatible')
      .map((config): Row => ({ kind: 'config', config })),
  ];

  const check = useMutation({
    mutationFn: (config: ProviderConfigView) =>
      api<{ result: ProviderTestResult }>(`/api/providers/${config.id}/test`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: async ({ result }, config) => {
      await refresh();
      const row: Row = { kind: 'config', config };
      setStatus(checkSentence(result, nameOf(row), config.kind === 'openai-compatible'));
    },
    onError: () => setStatus(t('app.error')),
  });
  const remove = useMutation({
    mutationFn: (config: ProviderConfigView) =>
      api(`/api/providers/${config.id}`, { method: 'DELETE' }),
    onSuccess: async (_r, config) => {
      setRemoving(null);
      await refresh();
      setStatus(t('admin.providers.removed', { provider: nameOf({ kind: 'config', config }) }));
    },
  });

  return (
    <>
      <CardSection
        title={t('admin.providers.cardTitle')}
        subtitle={t('admin.providers.cardHelp')}
        titleId={titleId}
        flush
        actions={
          <Button size="lg" variant="primary" onPress={() => setEditing({ kind: 'local' })}>
            <Icon name="plus" />
            {t('admin.providers.addProvider')}
          </Button>
        }
      >
        <p role="status" className="sr-only">
          {status}
        </p>
        {remove.isError && (
          <CardInset>
            <ErrorNotice title={t('app.error')} />
          </CardInset>
        )}
        <DataTable
          labelledBy={titleId}
          name={t('admin.providers.cardTitle')}
          columns={[
            {
              key: 'provider',
              header: t('admin.providers.col.provider'),
              cell: (r: Row) => <span className="font-medium">{nameOf(r)}</span>,
            },
            {
              key: 'key',
              header: t('admin.providers.col.key'),
              cell: (r: Row) =>
                r.kind === 'missing' ? (
                  <span className="text-muted">{t('admin.providers.noKey')}</span>
                ) : r.config.kind === 'openai-compatible' ? (
                  <span className="flex flex-col gap-1">
                    <span className="font-mono text-small">{r.config.baseUrl ?? ''}</span>
                    {r.config.hasKey && (
                      <span className="text-caption text-muted">
                        {t('admin.providers.withKey')}
                      </span>
                    )}
                  </span>
                ) : (
                  <StatusChip tone="success" icon="lock">
                    {t('credential.keySet')}
                  </StatusChip>
                ),
            },
            {
              key: 'check',
              header: t('admin.providers.col.check'),
              cell: (r: Row) =>
                r.kind === 'missing' ? '' : <LastCheck config={r.config} name={nameOf(r)} />,
            },
            {
              key: 'actions',
              header: t('admin.providers.col.actions'),
              cell: (r: Row) => {
                const name = nameOf(r);
                if (r.kind === 'missing') {
                  return (
                    <span className="flex justify-end">
                      <Button
                        variant="outline"
                        aria-label={t('admin.providers.addKeyFor', { provider: name })}
                        onPress={() => setEditing({ kind: 'key', row: r })}
                      >
                        {t('admin.providers.addKey')}
                      </Button>
                    </span>
                  );
                }
                const { config } = r;
                const local = config.kind === 'openai-compatible';
                const refused = config.lastTest?.status === 'auth_failed';
                return (
                  <RowActions
                    name={name}
                    actions={[
                      {
                        id: 'check',
                        label: t('admin.providers.check'),
                        name: t('admin.providers.checkFor', { provider: name }),
                        isPending: check.isPending && check.variables.id === config.id,
                        onAction: () => {
                          setStatus('');
                          check.mutate(config);
                        },
                      },
                      local
                        ? {
                            id: 'address',
                            label: t('admin.providers.changeAddress'),
                            name: t('admin.providers.changeAddressFor', { provider: name }),
                            onAction: () => setEditing({ kind: 'address', config }),
                          }
                        : {
                            id: 'replace',
                            label: t('admin.providers.replace'),
                            name: t('admin.providers.replaceFor', { provider: name }),
                            primary: refused,
                            onAction: () => setEditing({ kind: 'key', row: r }),
                          },
                      {
                        id: 'remove',
                        label: t('admin.providers.remove'),
                        name: t('admin.providers.removeFor', { provider: name }),
                        danger: true,
                        onAction: () => setRemoving(config),
                      },
                    ]}
                  />
                );
              },
            },
          ]}
          rows={rows}
          rowKey={(r) => (r.kind === 'missing' ? r.provider : r.config.id)}
        />
      </CardSection>
      {editing?.kind === 'key' && (
        <KeyDialog row={editing.row} onClose={() => setEditing(null)} onDone={setStatus} />
      )}
      {editing?.kind === 'address' && (
        <LocalDialog config={editing.config} onClose={() => setEditing(null)} onDone={setStatus} />
      )}
      {editing?.kind === 'local' && (
        <LocalDialog config={null} onClose={() => setEditing(null)} onDone={setStatus} />
      )}
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('admin.providers.removeTitle', {
          provider: removing === null ? '' : nameOf({ kind: 'config', config: removing }),
        })}
        confirmLabel={t('admin.providers.remove')}
        isPending={remove.isPending}
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing);
        }}
      >
        {t('admin.providers.removeBody')}
      </ConfirmDialog>
    </>
  );
}

/** Saves, then checks, and says what the check found. */
async function saveAndCheck(
  save: () => Promise<{ provider: ProviderConfigView }>,
): Promise<{ config: ProviderConfigView; result: ProviderTestResult }> {
  const { provider } = await save();
  const { result } = await api<{ result: ProviderTestResult }>(
    `/api/providers/${provider.id}/test`,
    { method: 'POST', body: {} },
  );
  return { config: provider, result };
}

function KeyDialog({
  row,
  onClose,
  onDone,
}: {
  row: Row;
  onClose: () => void;
  onDone: (status: string) => void;
}) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const name = nameOf(row);
  const save = useMutation({
    mutationFn: () =>
      saveAndCheck(() =>
        row.kind === 'missing'
          ? api('/api/providers', { method: 'POST', body: { kind: row.provider, apiKey: key } })
          : api(`/api/providers/${row.config.id}`, { method: 'PUT', body: { apiKey: key } }),
      ),
    onSuccess: async ({ result }) => {
      await queryClient.invalidateQueries({ queryKey: ['providers', 'instance'] });
      onDone(checkSentence(result, name, false));
      onClose();
    },
  });
  const last = row.kind === 'config' ? row.config.lastTest : null;
  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        row.kind === 'missing'
          ? t('admin.providers.addKeyTitle', { provider: name })
          : t('admin.providers.replaceTitle', { provider: name })
      }
      submitLabel={t('admin.providers.saveAndCheck')}
      isSubmitting={save.isPending}
      {...(save.isError ? { error: { title: t('admin.providers.saveFailed') } } : {})}
      {...(key.trim() === '' ? { blockedBy: t('admin.providers.keyNeeded') } : {})}
      onSubmit={() => save.mutate()}
    >
      {last !== null && last.status !== 'ok' && (
        <p>
          {t('admin.providers.lastSaid', {
            what: checkDetail(last, name, false).replace(/\.$/, ''),
          })}
        </p>
      )}
      <WriteOnlyField
        label={t('admin.providers.newKey', { provider: name })}
        isSet={row.kind === 'config' && row.config.hasKey}
        setDetail={t('admin.providers.keyHelp')}
        value={key}
        onChange={setKey}
        isRequired
      />
    </FormDialog>
  );
}

const LOCAL_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

function LocalDialog({
  config,
  onClose,
  onDone,
}: {
  /** Null to add one. */
  config: ProviderConfigView | null;
  onClose: () => void;
  onDone: (status: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(config?.name ?? '');
  const [address, setAddress] = useState(config?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState<'name' | 'address' | 'exists' | null>(null);
  const save = useMutation({
    mutationFn: () =>
      saveAndCheck(() =>
        config === null
          ? api('/api/providers', {
              method: 'POST',
              body: {
                kind: 'openai-compatible',
                name,
                baseUrl: address.trim(),
                ...(key === '' ? {} : { apiKey: key }),
              },
            })
          : api(`/api/providers/${config.id}`, {
              method: 'PUT',
              body: { baseUrl: address.trim(), ...(key === '' ? {} : { apiKey: key }) },
            }),
      ),
    onSuccess: async ({ config: saved, result }) => {
      await queryClient.invalidateQueries({ queryKey: ['providers', 'instance'] });
      onDone(checkSentence(result, nameOf({ kind: 'config', config: saved }), true));
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'provider_exists') setProblem('exists');
    },
  });
  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        config === null
          ? t('admin.providers.addProviderTitle')
          : t('admin.providers.addressTitle', { provider: nameOf({ kind: 'config', config }) })
      }
      submitLabel={t('admin.providers.saveAndCheck')}
      isSubmitting={save.isPending}
      {...(save.isError && problem === null
        ? { error: { title: t('admin.providers.saveFailed') } }
        : {})}
      onSubmit={() => {
        if (config === null && !LOCAL_NAME.test(name)) {
          setProblem('name');
          return;
        }
        if (!/^https?:\/\/\S+$/.test(address.trim())) {
          setProblem('address');
          return;
        }
        setProblem(null);
        save.mutate();
      }}
    >
      {config === null && (
        <TextField
          value={name}
          onChange={setName}
          isInvalid={problem === 'name' || problem === 'exists'}
          isRequired
          validationBehavior="aria"
        >
          <Label>{t('admin.providers.localName')}</Label>
          <Input spellCheck={false} autoCapitalize="none" className="font-mono" />
          {problem === 'name' ? (
            <FieldError>{t('admin.providers.localNameInvalid')}</FieldError>
          ) : problem === 'exists' ? (
            <FieldError>{t('admin.providers.localNameTaken')}</FieldError>
          ) : (
            <Description>{t('admin.providers.localNameHelp')}</Description>
          )}
        </TextField>
      )}
      <TextField
        type="url"
        value={address}
        onChange={setAddress}
        isInvalid={problem === 'address'}
        isRequired
        validationBehavior="aria"
      >
        <Label>{t('admin.providers.address')}</Label>
        <Input spellCheck={false} />
        {problem === 'address' ? (
          <FieldError>{t('admin.providers.addressInvalid')}</FieldError>
        ) : (
          <Description>{t('admin.providers.addressHelp')}</Description>
        )}
      </TextField>
      <WriteOnlyField
        label={t('admin.providers.localKey')}
        isSet={config?.hasKey === true}
        value={key}
        onChange={setKey}
      />
    </FormDialog>
  );
}
