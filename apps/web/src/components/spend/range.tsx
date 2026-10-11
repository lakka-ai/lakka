import { useState } from 'react';
import { t } from '../../i18n/index.ts';
import { RANGES, rangeDays } from '../../lib/spend.ts';
import type { RangeKind } from '../../lib/spend.ts';
import { UnitField } from '../patterns/fields.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { PillToggles } from '../patterns/tabs.tsx';

/*
 * The dates a spend report covers (BG-11; Spend-Admin board): a group of toggle buttons with
 * aria-pressed, and Custom opening a dialog for two dates. The range lives in the address, so a
 * report can be shared and reloaded.
 */

export interface SpendSearch {
  range?: RangeKind;
  from?: string;
  to?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The search part of a report's address, with anything unusable dropped. */
export function validateSpendSearch(search: Record<string, unknown>): SpendSearch {
  const range = RANGES.find((r) => r === search['range']);
  const from =
    typeof search['from'] === 'string' && DAY.test(search['from']) ? search['from'] : undefined;
  const to = typeof search['to'] === 'string' && DAY.test(search['to']) ? search['to'] : undefined;
  return {
    ...(range === undefined || range === 'this-month' ? {} : { range }),
    ...(range === 'custom' && from !== undefined && to !== undefined ? { from, to } : {}),
  };
}

function CustomRange({
  isOpen,
  onOpenChange,
  initial,
  onChoose,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { from: string; to: string };
  onChoose: (days: { from: string; to: string }) => void;
}) {
  const [error, setError] = useState(false);
  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('spend.range.customTitle')}
      submitLabel={t('spend.range.show')}
      {...(error ? { error: { title: t('spend.range.invalid') } } : {})}
      onSubmit={(form) => {
        const from = String(form.get('from') ?? '');
        const to = String(form.get('to') ?? '');
        const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
        if (!DAY.test(from) || !DAY.test(to) || !(days >= 1 && days <= 366)) {
          setError(true);
          return;
        }
        setError(false);
        onChoose({ from, to });
      }}
    >
      <UnitField
        name="from"
        type="date"
        label={t('spend.range.from')}
        defaultValue={initial.from}
      />
      <UnitField
        name="to"
        type="date"
        label={t('spend.range.to')}
        defaultValue={initial.to}
        description={t('spend.range.help')}
      />
    </FormDialog>
  );
}

export function RangePills({
  search,
  onChange,
}: {
  search: SpendSearch;
  onChange: (next: SpendSearch) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const range = search.range ?? 'this-month';
  const days = rangeDays(range, new Date(), search) ?? rangeDays('this-month', new Date());
  return (
    <>
      <PillToggles
        label={t('spend.range.label')}
        options={RANGES.map((r) => ({ id: r, label: t(`spend.range.${r}`) }))}
        value={range}
        onChange={(id) => {
          if (id === 'custom') {
            setChoosing(true);
            return;
          }
          onChange(id === 'this-month' ? {} : { range: id as RangeKind });
        }}
      />
      {days !== null && (
        <CustomRange
          isOpen={choosing}
          onOpenChange={setChoosing}
          initial={days}
          onChoose={(chosen) => {
            setChoosing(false);
            onChange({ range: 'custom', ...chosen });
          }}
        />
      )}
    </>
  );
}
