import { useId, useState } from 'react';
import { Button } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RETENTION_LIMITS } from '@lakka/contracts';
import type {
  RetentionBody,
  RetentionDeleted,
  RetentionView,
  TraceExportView,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import { lastActiveWords, removedWords, runTotal, tookWords } from '../../lib/admin.ts';
import { formatClock, formatDateTime } from '../../lib/format.ts';
import { retentionQuery } from '../../lib/queries.ts';
import { formatCount } from '../../lib/spend.ts';
import { CardSection } from '../patterns/card-section.tsx';
import { DataTable } from '../patterns/data-table.tsx';
import { UnitField } from '../patterns/fields.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { ReadOnlySetting, SettingsSection } from '../patterns/settings.tsx';
import { Icon } from '../icons.tsx';
import { StatusChip } from '../patterns/status-chip.tsx';

/*
 * Retention (OB-6, NF-P5, ADR 0078, ADR 0097; Admin-Retention board). Each row is a labelled
 * field with its unit and a description; Save is under the last row. Usage is kept in months,
 * as ADR 0078 settles, although the board draws days. Conversations are kept until people
 * delete them unless a period is entered. The three records the board leaves out, tool records,
 * budget alerts and settled holds, are rows of the same section. Run now announces what it
 * removed as a status, or that a run is already going.
 */

type Name = keyof RetentionBody;

const ROWS: readonly {
  name: Name;
  label: MessageKey;
  help: MessageKey;
  unit: 'days' | 'months';
}[] = [
  {
    name: 'spansDays',
    label: 'admin.retention.spans',
    help: 'admin.retention.spansHelp',
    unit: 'days',
  },
  {
    name: 'usageMonths',
    label: 'admin.retention.usage',
    help: 'admin.retention.usageHelp',
    unit: 'months',
  },
  {
    name: 'conversationsDays',
    label: 'admin.retention.conversations',
    help: 'admin.retention.conversationsHelp',
    unit: 'days',
  },
  {
    name: 'toolAuditDays',
    label: 'admin.retention.tools',
    help: 'admin.retention.toolsHelp',
    unit: 'days',
  },
  {
    name: 'budgetAlertsMonths',
    label: 'admin.retention.alerts',
    help: 'admin.retention.alertsHelp',
    unit: 'months',
  },
  {
    name: 'reservationsDays',
    label: 'admin.retention.holds',
    help: 'admin.retention.holdsHelp',
    unit: 'days',
  },
];

const REMOVED: readonly { name: keyof RetentionDeleted; label: MessageKey }[] = [
  { name: 'spans', label: 'admin.retention.spans' },
  { name: 'usage', label: 'admin.retention.usage' },
  { name: 'conversations', label: 'admin.retention.conversations' },
  { name: 'spanContent', label: 'admin.retention.content' },
  { name: 'toolRecords', label: 'admin.retention.tools' },
  { name: 'budgetAlerts', label: 'admin.retention.alerts' },
  { name: 'reservations', label: 'admin.retention.holds' },
  { name: 'oauthStates', label: 'admin.retention.oauth' },
  { name: 'passwordResets', label: 'admin.retention.resets' },
];

type Texts = Record<Name, string>;

const textsOf = (r: RetentionView): Texts => ({
  spansDays: String(r.spansDays),
  usageMonths: String(r.usageMonths),
  conversationsDays: r.conversationsDays === null ? '' : String(r.conversationsDays),
  toolAuditDays: String(r.toolAuditDays),
  budgetAlertsMonths: String(r.budgetAlertsMonths),
  reservationsDays: String(r.reservationsDays),
});

/** The body to save, or the fields that are not whole numbers within their limits. */
export function parsePeriods(texts: Texts): { body: RetentionBody } | { wrong: Name[] } {
  const wrong: Name[] = [];
  const whole = (name: Name) => {
    const limits = RETENTION_LIMITS[name];
    const n = Number(texts[name].trim());
    if (!Number.isInteger(n) || n < limits.min || n > limits.max || texts[name].trim() === '') {
      wrong.push(name);
      return 0;
    }
    return n;
  };
  const body: RetentionBody = {
    spansDays: whole('spansDays'),
    usageMonths: whole('usageMonths'),
    conversationsDays: texts.conversationsDays.trim() === '' ? null : whole('conversationsDays'),
    toolAuditDays: whole('toolAuditDays'),
    budgetAlertsMonths: whole('budgetAlertsMonths'),
    reservationsDays: whole('reservationsDays'),
  };
  return wrong.length > 0 ? { wrong } : { body };
}

export function Periods({ retention }: { retention: RetentionView }) {
  const queryClient = useQueryClient();
  const [texts, setTexts] = useState<Texts>(() => textsOf(retention));
  const [wrong, setWrong] = useState<Name[]>([]);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (body: RetentionBody) => api('/api/retention', { method: 'PUT', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: retentionQuery.queryKey });
      setSaved(true);
    },
  });
  return (
    <SettingsSection
      title={t('admin.retention.periods')}
      {...(retention.updatedBy !== null && retention.updatedAt !== null
        ? {
            subtitle: t('admin.retention.changed', {
              name: retention.updatedBy,
              date: formatDateTime(retention.updatedAt),
            }),
          }
        : {})}
      saved={saved}
      isSaving={save.isPending}
      onSave={() => {
        setSaved(false);
        const parsed = parsePeriods(texts);
        if ('wrong' in parsed) {
          setWrong(parsed.wrong);
          document
            .querySelector<HTMLInputElement>(`input[name="${parsed.wrong[0] ?? ''}"]`)
            ?.focus();
          return;
        }
        setWrong([]);
        save.mutate(parsed.body);
      }}
    >
      {save.isError && <ErrorNotice title={t('app.error')} className="mt-3" />}
      {ROWS.map((row) => {
        const limits = RETENTION_LIMITS[row.name];
        const range = t('admin.retention.range', {
          min: String(limits.min),
          max: String(limits.max),
        });
        return (
          <UnitField
            key={row.name}
            setting
            name={row.name}
            label={t(row.label)}
            suffix={t(row.unit === 'days' ? 'admin.retention.days' : 'admin.retention.months')}
            alignEnd
            inputMode="numeric"
            className="[&_[data-slot=input-group]]:w-36"
            value={texts[row.name]}
            onChange={(value) => {
              setSaved(false);
              setTexts((current) => ({ ...current, [row.name]: value }));
            }}
            isInvalid={wrong.includes(row.name)}
            description={
              wrong.includes(row.name)
                ? t('admin.retention.outOfRange', { range })
                : `${t(row.help)} ${range}`
            }
          />
        );
      })}
      <ReadOnlySetting
        label={t('admin.retention.content')}
        description={t('admin.retention.contentHelp')}
        value={<span className="text-small text-muted">{t('admin.retention.perWorkspace')}</span>}
      />
    </SettingsSection>
  );
}

export function LastRun({ retention }: { retention: RetentionView }) {
  const tableId = useId();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api<{ retention: RetentionView }>('/api/retention/run', { method: 'POST', body: {} }),
    onSuccess: async ({ retention: after }) => {
      await queryClient.invalidateQueries({ queryKey: retentionQuery.queryKey });
      const removed = after.lastRun === null ? 0 : runTotal(after.lastRun.deleted);
      setStatus(
        removed === 1
          ? t('admin.retention.ranOne')
          : t('admin.retention.ran', { n: formatCount(removed) }),
      );
    },
    onError: (e) =>
      setStatus(
        e instanceof ApiError && e.code === 'retention_running'
          ? t('admin.retention.running')
          : t('app.error'),
      ),
  });
  const last = retention.lastRun;
  return (
    <CardSection
      title={t('admin.retention.lastRun')}
      titleId={tableId}
      actions={
        <Button
          size="lg"
          variant="tertiary"
          isPending={run.isPending}
          onPress={() => {
            setStatus('');
            run.mutate();
          }}
        >
          <Icon name="play" />
          {t('admin.retention.runNow')}
        </Button>
      }
    >
      {/* Nothing has run yet: said as the other empty lines are, small and muted. */}
      <p className={last === null ? 'text-small text-muted' : 'lk-num'}>
        {last === null
          ? t('admin.retention.never')
          : [
              t('admin.retention.ranAt', {
                day: lastActiveWords(last.at),
                time: formatClock(last.at),
              }),
              last.durationMs === null
                ? ''
                : t('admin.retention.took', { duration: tookWords(last.durationMs) }),
            ]
              .filter(Boolean)
              .join(' ')}
      </p>
      <p role="status" className="sr-only">
        {status}
      </p>
      {last !== null && (
        <DataTable
          labelledBy={tableId}
          name={t('admin.retention.lastRun')}
          framed
          columns={[
            {
              key: 'kind',
              header: t('admin.retention.removed'),
              cell: (r: (typeof REMOVED)[number]) => t(r.label),
            },
            {
              key: 'count',
              header: t('admin.retention.count'),
              numeric: true,
              cell: (r: (typeof REMOVED)[number]) => removedWords(last.deleted[r.name]),
            },
          ]}
          rows={REMOVED}
          rowKey={(r) => r.name}
        />
      )}
    </CardSection>
  );
}

export function TraceExport({ status }: { status: TraceExportView }) {
  return (
    <CardSection
      title={t('admin.retention.export')}
      badge={
        <StatusChip tone={status.enabled ? 'success' : 'neutral'}>
          {status.enabled ? t('admin.retention.exporting') : t('admin.retention.notExporting')}
        </StatusChip>
      }
    >
      <p>
        {status.enabled ? (
          <>
            {t('admin.retention.exportOn')}{' '}
            <span className="font-mono text-small">{status.destination ?? ''}</span>.{' '}
            {t('admin.retention.exportCopy')}
          </>
        ) : (
          t('admin.retention.exportOff')
        )}
      </p>
      <p className="text-small text-muted">{t('admin.retention.exportWhere')}</p>
    </CardSection>
  );
}
