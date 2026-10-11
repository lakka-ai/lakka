import { useEffect, useId, useState } from 'react';
import type { SpendReport } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { formatDay } from '../../lib/format.ts';
import { formatMicroUsd } from '../../lib/money.ts';
import { formatCount, formatDays } from '../../lib/spend.ts';
import { CardSection } from '../patterns/card-section.tsx';
import { DataTable } from '../patterns/data-table.tsx';
import { PillToggles } from '../patterns/tabs.tsx';

/*
 * Spend by day (Spend-Admin board; accessibility.md, Spend and budgets). The chart is one image
 * whose name is a text summary; its bars are aria-hidden. Chart and Table is a toggle, and the
 * table lists every day with the amount and the request count. The choice is kept in this
 * browser for next time: a convenience, so it is read after the page has rendered, and a
 * browser that keeps nothing simply starts on the chart.
 */

type View = 'chart' | 'table';
const STORAGE_KEY = 'lakka.spend.dayView';

function remembered(): View | null {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return value === 'chart' || value === 'table' ? value : null;
  } catch {
    return null;
  }
}

function remember(view: View) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, view);
  } catch {
    // Private windows and blocked storage keep nothing; the toggle still works for this visit.
  }
}

/**
 * The scale's step, as the board draws it: three steps of 1, 2 or 5 of a power of ten reach the
 * largest day ($20 steps to $60 for a $53 day). A cent at the least, and a dollar with no spend.
 */
export function scaleStep(largestMicro: bigint): bigint {
  if (largestMicro <= 0n) return 1_000_000n;
  for (let power = 10_000n; ; power *= 10n) {
    for (const m of [1n, 2n, 5n]) if (power * m * 3n >= largestMicro) return power * m;
  }
}

type Day = SpendReport['byDay'][number];

export function SpendByDay({ days }: { days: readonly Day[] }) {
  const titleId = useId();
  const [view, setView] = useState<View>('chart');
  const [hovered, setHovered] = useState<number | null>(null);
  useEffect(() => {
    const stored = remembered();
    if (stored !== null) setView(stored);
  }, []);

  const largest = days.reduce(
    (m, d) => (BigInt(d.costMicroUsd) > m ? BigInt(d.costMicroUsd) : m),
    0n,
  );
  const step = scaleStep(largest);
  const top = step * 3n;
  const most = days.find((d) => BigInt(d.costMicroUsd) === largest);
  const total = days.reduce((sum, d) => sum + BigInt(d.costMicroUsd), 0n);
  const first = days[0]?.date ?? '';
  const last = days.at(-1)?.date ?? '';
  const summary = t('spend.chart.summary', {
    days: formatDays(first, last),
    total: formatMicroUsd(String(total)),
    amount: formatMicroUsd(String(largest)),
    day: most === undefined ? '' : formatDay(most.date),
  });
  // A label under the first bar, then every seventh, then the last.
  const labelled = new Set(
    days.flatMap((_, i) => (i % 7 === 0 || i === days.length - 1 ? [i] : [])),
  );
  const shown = hovered === null ? undefined : days[hovered];

  return (
    <CardSection
      title={t('spend.chart.title')}
      titleId={titleId}
      compact
      actions={
        <PillToggles
          label={t('spend.chart.view')}
          options={[
            { id: 'chart', label: t('spend.chart.chart') },
            { id: 'table', label: t('spend.chart.table') },
          ]}
          value={view}
          onChange={(id) => {
            const next: View = id === 'table' ? 'table' : 'chart';
            setView(next);
            remember(next);
          }}
        />
      }
      flush={view === 'table'}
    >
      {view === 'chart' ? (
        <div className="flex flex-col gap-3">
          <div role="img" aria-label={summary} className="relative flex gap-3">
            <div
              aria-hidden="true"
              className="lk-num flex h-50 shrink-0 flex-col justify-between text-end text-caption text-muted"
            >
              {[3n, 2n, 1n, 0n].map((q) => (
                <span key={String(q)}>{formatMicroUsd(String(step * q)).replace(/\.00$/, '')}</span>
              ))}
            </div>
            <div aria-hidden="true" className="flex min-w-0 grow flex-col gap-1.5">
              <div
                className="relative flex h-50 items-end gap-0.5"
                onMouseLeave={() => setHovered(null)}
              >
                {/* A gridline at each tick, the baseline in the field edge, as drawn. */}
                <span className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                  <span className="border-t border-lk-chart-grid" />
                  <span className="border-t border-lk-chart-grid" />
                  <span className="border-t border-lk-chart-grid" />
                  <span className="border-t border-field-border" />
                </span>
                {days.map((d, i) => (
                  <span
                    key={d.date}
                    onMouseEnter={() => setHovered(i)}
                    className={`relative min-w-0 grow rounded-t-xs bg-lk-chart ${hovered === i ? '' : 'opacity-80'}`}
                    style={{
                      height: `${Number((BigInt(d.costMicroUsd) * 1000n) / top) / 10}%`,
                    }}
                  />
                ))}
                {shown !== undefined && (
                  <span className="pointer-events-none absolute top-0 right-0 rounded-lg border border-border bg-overlay px-2.5 py-1.5 text-caption shadow-overlay">
                    <span className="block font-semibold">{formatDay(shown.date)}</span>
                    <span className="lk-num">
                      {formatMicroUsd(shown.costMicroUsd)}, {formatCount(shown.requests)}{' '}
                      {t('spend.col.requests').toLowerCase()}
                    </span>
                  </span>
                )}
              </div>
              <div className="flex text-caption text-muted">
                {days.map((d, i) => (
                  <span key={d.date} className="min-w-0 grow overflow-visible whitespace-nowrap">
                    {labelled.has(i) ? formatDay(d.date) : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <p className="text-small text-muted">{t('spend.chart.note')}</p>
        </div>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={t('spend.chart.title')}
          columns={[
            { key: 'day', header: t('spend.col.day'), cell: (d: Day) => formatDay(d.date) },
            {
              key: 'requests',
              header: t('spend.col.requests'),
              numeric: true,
              cell: (d: Day) => formatCount(d.requests),
            },
            {
              key: 'spend',
              header: t('spend.col.spend'),
              numeric: true,
              cell: (d: Day) => formatMicroUsd(d.costMicroUsd),
            },
          ]}
          rows={days}
          rowKey={(d) => d.date}
        />
      )}
    </CardSection>
  );
}
