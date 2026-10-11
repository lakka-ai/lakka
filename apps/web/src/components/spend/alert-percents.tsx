import { t } from '../../i18n/index.ts';
import { ALERT_SUGGESTIONS, MAX_ALERTS, parseAlertPercent } from '../../lib/spend.ts';
import { TagsField } from '../patterns/tags-field.tsx';

/*
 * A cap's alert percentages (BG-10, ADR 0109; Spend-States board, "Set a cap"), up to five. The
 * list suggests every 10 percent from 10 to 100; any other whole percentage from 1 to 100 can be
 * typed, the same rule the api holds.
 */
export function AlertPercentsField({
  value,
  onChange,
}: {
  value: readonly number[];
  onChange: (alerts: number[]) => void;
}) {
  return (
    <TagsField
      label={t('spend.cap.alerts')}
      description={t('spend.cap.alertsHelp')}
      placeholder={t('spend.cap.alertsNone')}
      findLabel={t('spend.cap.findAlert')}
      findPlaceholder={t('spend.cap.findAlertPlaceholder')}
      suggestions={ALERT_SUGGESTIONS.map(String)}
      value={value.map(String)}
      onChange={(values) => onChange(values.map(Number))}
      parse={(text) => {
        const n = parseAlertPercent(text);
        return n === undefined ? undefined : String(n);
      }}
      format={(v) => `${v}%`}
      removeLabel={(v) => t('spend.cap.removeAlert', { percent: v })}
      hint={t('spend.cap.alertInvalid')}
      invalid={t('spend.cap.alertInvalid')}
      max={MAX_ALERTS}
      sort={(a, b) => Number(a) - Number(b)}
      numeric
    />
  );
}
