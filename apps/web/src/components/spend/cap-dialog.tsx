import { useState } from 'react';
import { Label, RadioGroup } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_ALERT_PERCENTS } from '@lakka/contracts';
import type { BudgetBody, BudgetPeriod, BudgetView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import { formatMicroUsd, parseDollars } from '../../lib/money.ts';
import { PERIODS } from '../../lib/spend.ts';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { UnitField } from '../patterns/fields.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { RadioOption } from '../patterns/settings.tsx';
import { AlertPercentsField } from './alert-percents.tsx';

/*
 * Set a cap (BG-1, BG-9, BG-10; Spend-States board, "Set a cap"; accessibility.md, Spend and
 * budgets). One dialog for the workspace, a member or a key; the title names which. Focus starts
 * on Amount. Reset period is a radio group. Alert percentages are picked from every 10 percent or
 * typed (AlertPercentsField, ADR 0109). Remove cap sits bottom left and opens a plain confirm. The api
 * decides who may change what.
 *
 * "Already used" is said only for an existing cap whose period is unchanged: a new cap, or a cap
 * given a new period, starts from nothing (ADR 0093).
 */

export interface CapTarget {
  kind: 'instance' | 'workspace' | 'member' | 'key';
  /** The endpoint for this cap, e.g. /api/workspaces/:id/budgets/members/:principalId. */
  path: string;
  name: string;
  current: BudgetView | null;
  /** Whether Remove cap is offered: a key's owner cannot remove an admin's cap. */
  canRemove: boolean;
}

const PERIOD_LABEL: Readonly<Record<BudgetPeriod, { label: MessageKey; help: MessageKey }>> = {
  daily: { label: 'spend.cap.daily', help: 'spend.cap.dailyHelp' },
  monthly: { label: 'spend.cap.monthly', help: 'spend.cap.monthlyHelp' },
  none: { label: 'spend.cap.none', help: 'spend.cap.noneHelp' },
};

/** A limit as the amount field shows it: "100.00", without the sign or separators. */
const dollars = (micro: string) => formatMicroUsd(micro).replace(/^\$/, '').replaceAll(',', '');

function removeCopy(target: CapTarget): { title: string; body: string } {
  switch (target.kind) {
    case 'instance':
      return { title: t('spend.cap.removeInstanceTitle'), body: t('spend.cap.removeInstance') };
    case 'workspace':
      return { title: t('spend.cap.removeWorkspaceTitle'), body: t('spend.cap.removeWorkspace') };
    case 'member':
      return {
        title: t('spend.cap.removeTitle', { name: target.name }),
        body: t('spend.cap.removeMember', { name: target.name }),
      };
    case 'key':
      return {
        title: t('spend.cap.removeTitle', { name: target.name }),
        body: t('spend.cap.removeKey'),
      };
  }
}

export function CapDialog({
  target,
  onClose,
}: {
  /** The cap being set, or null when the dialog is closed. */
  target: CapTarget | null;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (path: string) => api(path, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budgets'] });
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setConfirming(false);
      onClose();
    },
  });
  const copy = target === null ? null : removeCopy(target);
  return (
    <>
      {target !== null && (
        // Keyed by the cap, so opening another starts from its own values.
        <CapForm
          key={target.path}
          target={target}
          onClose={onClose}
          onRemove={() => setConfirming(true)}
        />
      )}
      {target !== null && copy !== null && (
        <ConfirmDialog
          isOpen={confirming}
          onOpenChange={setConfirming}
          title={copy.title}
          confirmLabel={t('spend.cap.remove')}
          isPending={remove.isPending}
          onConfirm={() => remove.mutate(target.path)}
        >
          {copy.body}
        </ConfirmDialog>
      )}
    </>
  );
}

function CapForm({
  target,
  onClose,
  onRemove,
}: {
  target: CapTarget;
  onClose: () => void;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const current = target.current;
  const [period, setPeriod] = useState<BudgetPeriod>(current?.period ?? 'monthly');
  const [alerts, setAlerts] = useState<number[]>(
    current?.alertPercents ?? [...DEFAULT_ALERT_PERCENTS],
  );
  const [error, setError] = useState<{ title: string; body?: string } | null>(null);

  const save = useMutation({
    mutationFn: (body: BudgetBody) => api(target.path, { method: 'PUT', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budgets'] });
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      onClose();
    },
    onError: (e) =>
      setError(
        e instanceof ApiError && e.status === 403
          ? { title: t('spend.cap.saveFailed'), body: t('spend.cap.forbidden') }
          : { title: t('spend.cap.saveFailed'), body: t('app.error') },
      ),
  });

  function submit(form: FormData) {
    setError(null);
    const limitMicroUsd = parseDollars(String(form.get('amount') ?? ''));
    if (limitMicroUsd === undefined) {
      setError({ title: t('spend.cap.saveFailed'), body: t('spend.cap.amountInvalid') });
      return;
    }
    save.mutate({ limitMicroUsd, period, alertPercents: alerts });
  }

  const used =
    current !== null && current.period === period && BigInt(current.spentMicroUsd) > 0n
      ? t('spend.cap.used', { amount: formatMicroUsd(current.spentMicroUsd) })
      : undefined;

  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        target.kind === 'instance'
          ? t('spend.cap.instanceTitle')
          : target.kind === 'workspace'
            ? t('spend.cap.workspaceTitle', { name: target.name })
            : t('spend.cap.title', { name: target.name })
      }
      submitLabel={t('spend.cap.save')}
      onSubmit={submit}
      isSubmitting={save.isPending}
      {...(error === null ? {} : { error })}
      {...(current !== null && target.canRemove
        ? { destructive: { label: t('spend.cap.remove'), onPress: onRemove } }
        : {})}
    >
      <UnitField
        name="amount"
        label={t('spend.cap.amountLabel')}
        prefix="$"
        defaultValue={current === null ? '' : dollars(current.limitMicroUsd)}
        {...(used === undefined ? {} : { description: used })}
        isRequired
      />
      <RadioGroup
        name="period"
        value={period}
        onChange={(value) => setPeriod(value as BudgetPeriod)}
        className="flex flex-col gap-2"
      >
        <Label>{t('spend.cap.period')}</Label>
        {PERIODS.map((p) => (
          <RadioOption
            key={p}
            value={p}
            label={t(PERIOD_LABEL[p].label)}
            description={t(PERIOD_LABEL[p].help)}
          />
        ))}
      </RadioGroup>
      <AlertPercentsField value={alerts} onChange={setAlerts} />
    </FormDialog>
  );
}
