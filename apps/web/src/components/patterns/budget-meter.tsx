import { Button, Meter, Popover } from '@heroui/react';
import { t } from '../../i18n/index.ts';
import { readCap, smallestHeadroom } from '../../lib/budget-meter.ts';
import type { MeterCap, MeterReading, MeterState } from '../../lib/budget-meter.ts';
import { formatMicroUsd } from '../../lib/money.ts';
import { Icon } from '../icons.tsx';

/*
 * Pattern 2, Budget meter (CH-4). What is left on the tightest cap that applies, as a button
 * that opens every cap. Low and used up change the words, the icon and the colors, never the
 * color alone. Hidden when no cap applies.
 *
 * The meter's aria-valuetext says it in full: "$31.20 left of $50.00, your cap, resets Oct 1".
 */

const lowerFirst = (text: string) => text.slice(0, 1).toLowerCase() + text.slice(1);
const capitalized = (text: string) => text.slice(0, 1).toUpperCase() + text.slice(1);

/**
 * How each money state looks (tokens.md, Money states): the meter box, the bar's fill and track,
 * the edge of a card in that state, and the color of an amount said in it.
 */
export const stateLook: Record<
  MeterState,
  { box: string; fill: string; track: string; edge: string; text: string }
> = {
  healthy: {
    box: 'border-border bg-surface',
    fill: 'bg-success',
    track: 'bg-lk-meter-track',
    edge: '',
    text: '',
  },
  low: {
    box: 'border-lk-warning-edge bg-warning-soft text-warning-soft-foreground',
    fill: 'bg-warning',
    track: 'bg-lk-warning-track',
    edge: 'border-lk-warning-edge',
    text: 'text-warning-soft-foreground',
  },
  exhausted: {
    box: 'border-lk-danger-edge bg-danger-soft text-danger-soft-foreground',
    fill: 'bg-danger',
    track: 'bg-lk-danger-track',
    edge: 'border-lk-danger-edge',
    text: 'text-danger-soft-foreground',
  },
};

/** A cap's bar where its words say the same: decorative, aria-hidden. CapMeter is the meter. */
export function CapBar({ reading, className = '' }: { reading: MeterReading; className?: string }) {
  const look = stateLook[reading.state];
  return (
    <span
      aria-hidden="true"
      className={`block h-1.5 overflow-hidden rounded-full ${look.track} ${className}`}
    >
      <span
        className={`block h-full rounded-full ${look.fill}`}
        style={{ width: `${reading.percentLeft}%` }}
      />
    </span>
  );
}

const stateWords = (state: MeterState) =>
  state === 'low' ? `${t('meter.low')} ` : state === 'exhausted' ? `${t('meter.exhausted')} ` : '';
const labelWords = (state: MeterState) =>
  state === 'low'
    ? `${t('meter.label.low')} `
    : state === 'exhausted'
      ? `${t('meter.label.exhausted')} `
      : '';

function valueText(reading: MeterReading) {
  const { cap } = reading;
  return t('meter.valueText', {
    left: formatMicroUsd(String(reading.leftMicro)),
    limit: formatMicroUsd(String(reading.limitMicro)),
    cap: lowerFirst(cap.name),
    resets: cap.resets === undefined ? lowerFirst(cap.period) : lowerFirst(cap.resets),
  }).replace(/\.$/, '');
}

/** One cap's bar: a HeroUI Meter whose value is what is left. Also used on the Spend pages. */
export function CapMeter({ reading }: { reading: MeterReading }) {
  const look = stateLook[reading.state];
  return (
    // react-aria turns valueLabel into aria-valuetext.
    <Meter
      value={reading.percentLeft}
      valueLabel={valueText(reading)}
      aria-label={reading.cap.name}
    >
      <Meter.Track className={`h-1.5 rounded-full ${look.track}`}>
        <Meter.Fill className={`rounded-full ${look.fill}`} />
      </Meter.Track>
    </Meter>
  );
}

type Variant = 'card' | 'header' | 'strip';

/**
 * The button that opens the caps, in three shapes: `card`, as on the Patterns board; `header`,
 * the chat header's box with the amount and the short line on one row; `strip`, the phone's
 * full-width band under the top bar. Its name starts with what the button shows, word for word,
 * so a speech user can say it (WCAG 2.5.3), then adds what it does not show: "$0.40 left.
 * Workspace, Oct 1. Budget low. The workspace cap is $1,000.00. Resets Oct 1. Show all caps"
 * (ADR 0129). The shown parts are separate text nodes, so they are joined by a space.
 */
function Trigger({
  reading,
  variant,
  shortLine,
  className,
}: {
  reading: MeterReading;
  variant: Variant;
  shortLine: string | undefined;
  className: string;
}) {
  const look = stateLook[reading.state];
  const amount = formatMicroUsd(String(reading.leftMicro));
  const resets = reading.cap.resets ?? reading.cap.period.replace(/\.$/, '');
  const limit = formatMicroUsd(String(reading.limitMicro));
  const capLine = `${stateWords(reading.state)}${reading.cap.name}. ${resets}`;
  const icon =
    reading.state === 'low' ? (
      <Icon name="warning" className="size-3.5" />
    ) : reading.state === 'exhausted' ? (
      <Icon name="ban" className="size-3.5" />
    ) : null;
  const bar = <CapBar reading={reading} />;
  // On the phone strip the state is in the words: "Budget low: $0.40 left".
  const stripAmount =
    reading.state === 'low'
      ? t('meter.strip.low', { amount })
      : reading.state === 'exhausted'
        ? t('meter.strip.exhausted', { amount })
        : t('meter.left', { amount });
  const amountLine = variant === 'strip' ? stripAmount : t('meter.left', { amount });

  if (variant === 'card') {
    return (
      <Button
        variant="ghost"
        aria-label={t('meter.button.card', { shown: `${amountLine}. ${capLine}`, limit })}
        className={`flex h-auto w-full min-w-44 flex-col items-stretch gap-1.5 rounded-note border px-3 py-2.5 text-left font-normal ${look.box} ${className}`}
      >
        <span className="lk-num flex items-center gap-1.5 text-small font-semibold">
          {icon}
          {amountLine}
        </span>{' '}
        {bar}
        <span className={`text-caption ${reading.state === 'healthy' ? 'text-muted' : ''}`}>
          {capLine}
        </span>
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      aria-label={t('meter.button', {
        shown: shortLine === undefined ? amountLine : `${amountLine}. ${shortLine}`,
        // The strip says the state in words; the header only with its icon.
        state: variant === 'header' ? labelWords(reading.state) : '',
        // The short line names the cap already.
        cap:
          shortLine === undefined
            ? capitalized(reading.cap.inSentence ?? reading.cap.name)
            : t('meter.theCap'),
        limit,
        resets,
      })}
      className={`flex flex-col items-stretch gap-1.5 text-left font-normal ${
        variant === 'header'
          ? // As tall as the model picker beside it (--lk-chat-control-height), its rows centred.
            `lk-chat-control w-52 justify-center rounded-note border px-3 xl:w-68 ${look.box}`
          : `h-auto w-full rounded-none border-b px-4 py-2 ${look.box} border-x-0 border-t-0`
      } ${className}`}
    >
      <span className="flex items-center justify-between gap-3 text-small">
        <span className="lk-num flex items-center gap-1.5 font-semibold">
          {icon}
          {amountLine}
        </span>{' '}
        {shortLine !== undefined && (
          <span className={`text-caption ${reading.state === 'healthy' ? 'text-muted' : ''}`}>
            {shortLine}
          </span>
        )}
      </span>
      {!(variant === 'strip' && reading.state === 'exhausted') && bar}
    </Button>
  );
}

export function BudgetMeter({
  caps,
  className = '',
  defaultOpen = false,
  variant = 'card',
  shortLine,
}: {
  caps: readonly MeterCap[];
  className?: string;
  /** Opens the popover on first render, for stories and tests. */
  defaultOpen?: boolean;
  variant?: Variant;
  /** For `header` and `strip`: which cap and when it resets, "Workspace, Oct 1". */
  shortLine?: string;
}) {
  const tightest = smallestHeadroom(caps);
  if (tightest === null) return null;

  return (
    <Popover defaultOpen={defaultOpen}>
      <Trigger reading={tightest} variant={variant} shortLine={shortLine} className={className} />
      <Popover.Content placement="bottom end" className="lk-popover-fit w-136">
        <Popover.Dialog className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-0.5">
            <Popover.Heading className="text-small font-medium">
              {t('meter.popover.title')}
            </Popover.Heading>
            <p className="text-caption text-muted">{t('meter.popover.subtitle')}</p>
          </div>
          <ul className="flex flex-col gap-4">
            {caps.map((cap) => {
              const reading = readCap(cap);
              return (
                <li key={cap.name} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-small">
                    <span className="font-medium">{cap.name}</span>
                    <span className="lk-num">
                      {t('meter.leftOf', {
                        left: formatMicroUsd(String(reading.leftMicro)),
                        limit: formatMicroUsd(String(reading.limitMicro)),
                      })}
                    </span>
                  </div>
                  <CapMeter reading={reading} />
                  <span className="text-caption text-muted">
                    {cap.period}
                    {cap.resets === undefined ? '' : ` ${cap.resets}.`}
                  </span>
                </li>
              );
            })}
          </ul>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
