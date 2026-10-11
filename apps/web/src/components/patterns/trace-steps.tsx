import type { ReactNode } from 'react';
import { Disclosure } from '@heroui/react';
import { t } from '../../i18n/index.ts';
import { formatDuration } from '../../lib/format.ts';
import type { DetailValue } from '../../lib/traces.ts';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';

/*
 * Pattern 8, trace timeline steps (OB-1; Trace and Trace-Refused boards). An ordered list of
 * disclosures, one per step, with plain step names. Each step's button is named with the step,
 * its outcome and its duration, for example "Holding the budget, moved to a cheaper model,
 * 6 milliseconds". A step with nothing to show is a plain row with the same name and a dash for
 * the chevron.
 *
 * From 1024px a row is three columns, as drawn: the name and outcome, the step's bar on the
 * request's 220px timeline, and the time. On a phone the bar runs under the name. The status dot
 * says how the step went (done, moved to a cheaper model, waiting, failed); the dot and the bar
 * are decoration, and the times are text. The step that took most of the request has its time in
 * bold. Details open in a panel with the terms in a 170px column.
 */

export type StepKind = 'ok' | 'cheaper' | 'waiting' | 'failed';

export interface TraceStep {
  id: string;
  name: string;
  durationMs: number;
  /** How it went, when that is more than done: "Provider did not respond". */
  outcome?: string;
  /** How the step went, for its dot, its outcome's color and its bar. Done if absent. */
  kind?: StepKind;
  /** It took most of the request's time, so its time is bold. */
  dominant?: boolean;
  /** What the step decided, as term and value pairs. */
  details?: readonly (readonly [string, DetailValue])[];
  /** More under the details: sentences, a model call's attempts, what was recorded. */
  body?: ReactNode;
  /** Where the step sits on the request's timeline, as shares of its whole duration. */
  timing?: { start: number; length: number; waiting?: boolean };
}

const DOT: Readonly<Record<StepKind, { look: string; icon: IconName }>> = {
  ok: { look: 'bg-success-soft text-success', icon: 'check' },
  cheaper: { look: 'bg-warning-soft text-warning-soft-foreground', icon: 'cheaper' },
  waiting: { look: 'bg-surface-secondary text-muted', icon: 'retention' },
  failed: { look: 'bg-danger-soft text-danger-soft-foreground', icon: 'close' },
};

const OUTCOME: Readonly<Record<StepKind, string>> = {
  ok: 'text-muted',
  cheaper: 'text-warning-soft-foreground',
  waiting: 'text-muted',
  failed: 'text-danger-soft-foreground',
};

/** A detail's value; a model's id follows its name in muted mono. */
export function DetailValueView({ value }: { value: DetailValue }) {
  if (typeof value === 'string') return value;
  return (
    <>
      {value.name} <span className="font-mono text-small text-muted">{value.id}</span>
    </>
  );
}

/** Terms and values in two columns, the terms 170px wide; one column on a phone. */
export function DetailList({ details }: { details: readonly (readonly [string, DetailValue])[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-body sm:grid-cols-[170px_minmax(0,1fr)]">
      {details.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted">{term}</dt>
          <dd className="mb-1 sm:mb-0">
            <DetailValueView value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatusDot({ kind }: { kind: StepKind }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-1 flex size-5.5 shrink-0 items-center justify-center rounded-full ${DOT[kind].look}`}
    >
      <Icon name={DOT[kind].icon} className="size-3" />
    </span>
  );
}

function Bar({ timing, kind }: { timing: NonNullable<TraceStep['timing']>; kind: StepKind }) {
  const fill =
    kind === 'failed'
      ? 'bg-danger'
      : timing.waiting === true
        ? 'bg-lk-trace-wait'
        : 'bg-lk-trace-run';
  return (
    <span aria-hidden="true" className="relative block h-2 rounded-xs bg-surface-secondary">
      <span className={`absolute inset-y-0 rounded-xs ${fill}`} style={barPosition(timing)} />
    </span>
  );
}

function Step({ step, defaultExpanded }: { step: TraceStep; defaultExpanded: boolean }) {
  const duration = formatDuration(step.durationMs);
  const kind = step.kind ?? 'ok';
  const name = [step.name, step.outcome ?? t('trace.outcome.ok'), duration.spoken].join(', ');
  const hasDetails = step.details !== undefined && step.details.length > 0;
  // The row's columns: name and outcome, then the bar and the time from 1024px.
  const row =
    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-0.5 text-left text-body lg:grid-cols-[minmax(0,1fr)_220px_72px]';
  const label = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2">
      <span className="font-semibold">{step.name}</span>
      {step.outcome !== undefined && <span className={OUTCOME[kind]}>{step.outcome}</span>}
    </span>
  );
  const time = (
    <span
      className={`lk-num text-end lg:order-3 ${step.dominant === true ? 'font-semibold text-foreground' : 'text-muted'}`}
    >
      {duration.text}
    </span>
  );
  const bar = step.timing !== undefined && (
    <span className="col-span-2 lg:order-2 lg:col-span-1">
      <Bar timing={step.timing} kind={kind} />
    </span>
  );
  const rowBox =
    'grid grid-cols-[22px_minmax(0,1fr)] gap-3 border-t border-separator py-3 ps-4 pe-5 first:border-t-0';

  // Nothing to open: a plain row with a dash where the chevron would be, not a button.
  if (!hasDetails && step.body === undefined) {
    return (
      <li className={rowBox}>
        <StatusDot kind={kind} />
        <h3 className="m-0">
          <span className="sr-only">{name}</span>
          <span aria-hidden="true" className={row}>
            <span className="flex min-w-0 items-center gap-2">
              <Icon name="minus" className="size-3.5 text-muted" />
              {label}
            </span>
            {time}
            {bar}
          </span>
        </h3>
      </li>
    );
  }

  return (
    <li className={rowBox}>
      <StatusDot kind={kind} />
      <Disclosure defaultExpanded={defaultExpanded} className="min-w-0">
        <Disclosure.Heading className="m-0">
          <Disclosure.Trigger
            aria-label={name}
            className={`group lk-inset-focus rounded-lg ${row}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 transition-transform group-aria-expanded:rotate-90">
                <Icon name="chevronRight" className="size-3.5 text-muted" />
              </span>
              {label}
            </span>
            {time}
            {bar}
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <div
            className={`mt-2.5 flex flex-col gap-3 rounded-note border bg-background px-4 py-3.5 ${kind === 'failed' ? 'border-lk-danger-edge' : 'border-border'}`}
          >
            {hasDetails && step.details !== undefined && <DetailList details={step.details} />}
            {step.body}
          </div>
        </Disclosure.Content>
      </Disclosure>
    </li>
  );
}

export function TraceSteps({
  steps,
  expanded = [],
  labelledBy,
}: {
  steps: readonly TraceStep[];
  /** Ids of the steps open at first. */
  expanded?: readonly string[];
  labelledBy?: string;
}) {
  return (
    <ol
      className="flex flex-col"
      {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
    >
      {steps.map((step) => (
        <Step key={step.id} step={step} defaultExpanded={expanded.includes(step.id)} />
      ))}
    </ol>
  );
}

/** A step's bar, kept inside its track; the 3px floor is drawn back from the end if need be. */
function barPosition({ start, length }: { start: number; length: number }) {
  const from = Math.min(Math.max(start, 0), 1);
  const width = Math.min(Math.max(length, 0), 1 - from);
  return {
    left: `min(${from * 100}%, calc(100% - 3px))`,
    width: `max(3px, ${width * 100}%)`,
  };
}
