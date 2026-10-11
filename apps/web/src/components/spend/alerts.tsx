import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Description, FieldError, Input, Label, TextField } from '@heroui/react';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import type {
  AlertWebhookView,
  BudgetAlertView,
  CreatedAlertWebhook,
  WebhookTestResult,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api } from '../../lib/api.ts';
import { alertHistoryQuery, webhookPath, webhookQuery } from '../../lib/queries.ts';
import { CardSection, EmptyList } from '../patterns/card-section.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable } from '../patterns/data-table.tsx';
import { SecretDialog } from '../patterns/secret-dialog.tsx';
import { alertResult, alertText, deliveryReason, formatWhen } from './copy.ts';
import { StatusChip } from '../patterns/status-chip.tsx';

/*
 * Where budget alerts go (BG-10, NF-P2; Spend-Budgets board, Alerts). Nothing is sent anywhere
 * until an admin saves an address. Saving the first one makes a signing secret, shown once;
 * saving another keeps it; Make a new secret replaces it, after a plain confirm, since the
 * receiver stops trusting alerts until it has the new one (ADR 0093). Send a test alert sends a
 * signed test now and says whether it arrived. Stop sending alerts removes the address.
 */

type Status = { text: string; tone: 'ok' | 'problem' } | null;

export function AlertsCard({
  workspaceId,
}: {
  /** Null for the instance's own alerts, which the instance cap sends. */
  workspaceId: string | null;
}) {
  const titleId = useId();
  const sentId = useId();
  const queryClient = useQueryClient();
  const { data: webhook } = useSuspenseQuery(webhookQuery(workspaceId));
  const { data: alerts } = useSuspenseQuery(alertHistoryQuery(workspaceId));
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [invalid, setInvalid] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'stop' | null>(null);
  const path = webhookPath(workspaceId);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: webhookQuery(workspaceId).queryKey });
  const instance = workspaceId === null;

  const save = useMutation({
    // The first address makes a secret, shown once; a later one keeps it.
    mutationFn: async (next: string): Promise<string | null> =>
      webhook === null
        ? (await api<CreatedAlertWebhook>(path, { method: 'PUT', body: { url: next } })).secret
        : (await api<{ webhook: AlertWebhookView }>(path, { method: 'PATCH', body: { url: next } }),
          null),
    onSuccess: async (made) => {
      await refresh();
      if (made !== null) setSecret(made);
      else setStatus({ text: t('spend.alerts.saved'), tone: 'ok' });
    },
    onError: () => setInvalid(true),
  });
  const rotate = useMutation({
    mutationFn: () => api<CreatedAlertWebhook>(`${path}/secret`, { method: 'POST' }),
    onSuccess: async (result) => {
      setConfirm(null);
      await refresh();
      setSecret(result.secret);
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ result: WebhookTestResult }>(`${path}/test`, { method: 'POST' }),
    onSuccess: ({ result }) =>
      setStatus(
        result.delivered
          ? { text: t('spend.alerts.testDelivered'), tone: 'ok' }
          : {
              text: t('spend.alerts.testFailed', { reason: deliveryReason(result.error) }),
              tone: 'problem',
            },
      ),
  });
  const stop = useMutation({
    mutationFn: () => api(path, { method: 'DELETE' }),
    onSuccess: async () => {
      setConfirm(null);
      setUrl('');
      setStatus(null);
      await refresh();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInvalid(false);
    setStatus(null);
    const next = url.trim();
    if (!/^https:\/\/\S+$/.test(next)) {
      setInvalid(true);
      return;
    }
    save.mutate(next);
  }

  return (
    <CardSection
      title={instance ? t('spend.alerts.instanceTitle') : t('spend.alerts.title')}
      subtitle={instance ? t('spend.alerts.instanceSubtitle') : t('spend.alerts.subtitle')}
      titleId={titleId}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-6 lg:grid-cols-2">
          <TextField name="url" type="url" value={url} onChange={setUrl} isInvalid={invalid}>
            <Label>{t('spend.alerts.address')}</Label>
            <Input placeholder="https://" spellCheck={false} className="font-mono" />
            {invalid ? (
              <FieldError>{t('spend.alerts.invalid')}</FieldError>
            ) : (
              <Description>{t('spend.alerts.addressHelp')}</Description>
            )}
          </TextField>
          <div className="flex flex-col gap-1.5">
            <span className="text-label">{t('spend.alerts.secret')}</span>
            {webhook === null ? (
              <>
                <StatusChip tone="neutral" className="self-start">
                  {t('spend.alerts.noSecret')}
                </StatusChip>
                <p className="text-small text-muted">{t('spend.alerts.noSecretHelp')}</p>
              </>
            ) : (
              <>
                <span className="flex flex-wrap items-center gap-2">
                  <StatusChip tone="success" icon="lock">
                    {t('spend.alerts.secretSet')}
                  </StatusChip>
                  <Button variant="outline" onPress={() => setConfirm('rotate')}>
                    {t('spend.alerts.newSecret')}
                  </Button>
                </span>
                <p className="text-small text-muted">{t('spend.alerts.secretHelp')}</p>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" type="submit" variant="primary" isPending={save.isPending}>
            {t('spend.alerts.save')}
          </Button>
          {webhook !== null && (
            <Button variant="tertiary" isPending={test.isPending} onPress={() => test.mutate()}>
              {t('spend.alerts.test')}
            </Button>
          )}
          {webhook !== null && (
            <Button variant="ghost" className="lk-danger-text" onPress={() => setConfirm('stop')}>
              {t('spend.alerts.stop')}
            </Button>
          )}
        </div>
        <p
          role="status"
          className={`text-small ${status?.tone === 'problem' ? 'text-danger-soft-foreground' : 'text-muted'}`}
        >
          {status?.text ?? ''}
        </p>
      </form>
      <div className="flex flex-col gap-3 border-t border-separator pt-5">
        <h3 id={sentId} className="text-heading">
          {t('spend.alerts.sent')}
        </h3>
        {alerts.length === 0 ? (
          <EmptyList>
            {instance ? t('spend.alerts.instanceSentEmpty') : t('spend.alerts.sentEmpty')}
          </EmptyList>
        ) : (
          <DataTable
            labelledBy={sentId}
            name={t('spend.alerts.sent')}
            framed
            columns={[
              {
                key: 'when',
                header: t('spend.alerts.col.when'),
                cell: (a: BudgetAlertView) => (
                  <span className="lk-num">{formatWhen(a.createdAt)}</span>
                ),
              },
              { key: 'alert', header: t('spend.alerts.col.alert'), cell: alertText },
              {
                key: 'result',
                header: t('spend.alerts.col.result'),
                cell: (a: BudgetAlertView) => {
                  const r = alertResult(a);
                  const tone =
                    r.tone === 'success' ? 'success' : r.tone === 'danger' ? 'danger' : 'neutral';
                  return (
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusChip tone={tone}>{r.word}</StatusChip>
                      {r.why !== '' && <span className="text-small text-muted">{r.why}</span>}
                    </span>
                  );
                },
              },
            ]}
            rows={alerts}
            rowKey={(a) => a.id}
          />
        )}
      </div>
      <SecretDialog
        isOpen={secret !== null}
        onSaved={() => setSecret(null)}
        title={t('spend.alerts.secretDialog')}
        warning={t('spend.alerts.secretWarning')}
        label={t('spend.alerts.secret')}
        secret={secret ?? ''}
      />
      <ConfirmDialog
        isOpen={confirm === 'rotate'}
        onOpenChange={(open) => setConfirm(open ? 'rotate' : null)}
        title={t('spend.alerts.newSecretTitle')}
        confirmLabel={t('spend.alerts.newSecret')}
        isPending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      >
        {t('spend.alerts.newSecretBody')}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === 'stop'}
        onOpenChange={(open) => setConfirm(open ? 'stop' : null)}
        title={t('spend.alerts.stopTitle')}
        confirmLabel={t('spend.alerts.stop')}
        isPending={stop.isPending}
        onConfirm={() => stop.mutate()}
      >
        {t('spend.alerts.stopBody')}
      </ConfirmDialog>
    </CardSection>
  );
}
