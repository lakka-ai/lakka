import { useId } from 'react';
import { Disclosure } from '@heroui/react';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { CapturedContentView, TraceView } from '@lakka/contracts';
import { decisionOf } from '../../../components/chat/copy.ts';
import { Icon } from '../../../components/icons.tsx';
import { DetailList, TraceSteps } from '../../../components/patterns/trace-steps.tsx';
import type { TraceStep } from '../../../components/patterns/trace-steps.tsx';
import { formatTime, OutcomeChip, useNames } from '../../../components/requests/shared.tsx';
import { surfaceName } from '../../../components/spend/copy.ts';
import { t } from '../../../i18n/index.ts';
import type { MessageKey } from '../../../i18n/index.ts';
import { formatDay, formatDuration } from '../../../lib/format.ts';
import { requestableQuery, traceQuery, workspaceQuery } from '../../../lib/queries.ts';
import { formatCount } from '../../../lib/spend.ts';
import {
  attemptDetails,
  leadSentence,
  longestWait,
  requestCost,
  traceSteps,
} from '../../../lib/traces.ts';
import type { Names, Step } from '../../../lib/traces.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';
import { CodeBlock } from '../../../components/patterns/code-block.tsx';

/*
 * One request's trace (OB-1, AC 16, ADR 0079, ADR 0095; Trace and Trace-Refused boards): what
 * happened in one sentence, then the steps as an ordered list of disclosures (Pattern 8), and a
 * summary aside, which comes after the steps in reading order though it sits on the right. A
 * request that paused for a tool approval is shown with the request that carried the answer.
 * Everything a model or a tool produced is shown as plain text, and what was said only where
 * the workspace recorded it (ADR 0077).
 */

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/requests_/$requestId')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId)),
      context.queryClient.ensureQueryData(requestableQuery(params.workspaceId)),
    ]);
    // Started early, but not awaited: a trace just made may take a moment to be written.
    void context.queryClient.prefetchQuery(traceQuery(params.workspaceId, params.requestId));
  },
  component: TracePage,
});

const CHIP: Readonly<Record<TraceView['request']['outcomeKind'], MessageKey>> = {
  completed: 'traces.chip.completed',
  cheaper: 'traces.chip.cheaper',
  refused: 'traces.chip.refused',
  stopped: 'traces.chip.stopped',
  failed: 'traces.chip.failed',
};

/** Recorded content as text, never as markup (NF-S8). */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/**
 * What was recorded for a model call, inside its step's details under a divider, as drawn: a
 * disclosure, then the line that says why it was recorded and until when, always shown.
 */
function Recorded({ content, workspace }: { content: CapturedContentView; workspace: string }) {
  return (
    <div className="flex flex-col gap-2 border-t border-separator pt-2.5">
      <Disclosure>
        <Disclosure.Heading level={4} className="m-0">
          <Disclosure.Trigger className="group lk-inset-focus flex min-h-8 w-full items-center gap-2 rounded-lg text-left text-body">
            <span className="transition-transform group-aria-expanded:rotate-90">
              <Icon name="chevronRight" className="size-3.5 text-muted" />
            </span>
            <span className="font-medium">{t('traces.recorded')}</span>
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <div className="flex flex-col gap-2 pt-2">
            <p className="font-medium">{t('traces.prompt')}</p>
            <CodeBlock capped>{asText(content.prompt)}</CodeBlock>
            <p className="font-medium">{t('traces.reply')}</p>
            <CodeBlock capped>{asText(content.response)}</CodeBlock>
          </div>
        </Disclosure.Content>
      </Disclosure>
      <p className="text-small text-muted">
        {t('traces.recordedHelp', { workspace, date: formatDay(content.expiresAt) })}
      </p>
    </div>
  );
}

/**
 * How long the timeline runs: the request's time, or longer when a step ends after it. Spans and
 * the request are timed apart and rounded to whole milliseconds, so the last one can end a
 * millisecond or two past the request.
 */
function timelineMs(trace: TraceView, steps: readonly Step[]): number {
  return Math.max(1, trace.request.durationMs, ...steps.map((s) => s.offsetMs + s.durationMs));
}

function asPatternStep(
  step: Step,
  trace: TraceView,
  names: Names,
  workspace: string,
  total: number,
): TraceStep {
  const recorded = trace.content.filter((c) => step.callSpanIds.includes(c.spanId));
  const hasBody = step.notes.length > 0 || step.attempts.length > 0 || recorded.length > 0;
  return {
    id: step.id,
    name: step.name,
    durationMs: step.durationMs,
    outcome: step.outcome,
    kind: step.failed
      ? 'failed'
      : step.waiting
        ? 'waiting'
        : step.cheaper === true
          ? 'cheaper'
          : 'ok',
    // Most of the request's time went here, as when it waited for an approval.
    dominant: step.durationMs / total >= 0.5,
    details: step.details,
    timing: {
      start: step.offsetMs / total,
      length: step.durationMs / total,
      waiting: step.waiting,
    },
    ...(hasBody
      ? {
          body: (
            <>
              {step.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
              {step.attempts.map((a) => (
                <DetailList
                  key={`${a.requestId}-${a.attempt}`}
                  details={attemptDetails(a, names)}
                />
              ))}
              {recorded.map((c) => (
                <Recorded key={c.spanId} content={c} workspace={workspace} />
              ))}
            </>
          ),
        }
      : {}),
  };
}

function TracePage() {
  const { workspaceId, requestId } = Route.useParams();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: trace, isError } = useQuery(traceQuery(workspaceId, requestId));
  const crumbs = (time?: string) => (
    <nav aria-label={t('traces.crumbs')} className="text-body">
      <ol className="flex flex-wrap items-center gap-2">
        <li>
          <Link
            to="/workspaces/$workspaceId/requests"
            params={{ workspaceId }}
            className="lk-link lk-link-alone"
          >
            {t('traces.title')}
          </Link>
        </li>
        {time !== undefined && (
          <li aria-current="page" className="flex items-center gap-2">
            <span aria-hidden="true" className="text-muted">
              /
            </span>
            <span className="lk-num">{time}</span>
          </li>
        )}
      </ol>
    </nav>
  );
  if (trace === undefined) {
    return (
      <>
        {crumbs()}
        <h1 className="lk-title">{t('traces.traceTitle')}</h1>
        <p role="status" aria-busy={!isError}>
          {isError ? t('traces.notFound') : t('traces.loading')}
        </p>
      </>
    );
  }
  return (
    <Trace trace={trace} workspaceId={workspaceId} workspace={workspace.name} crumbs={crumbs} />
  );
}

function Trace({
  trace,
  workspaceId,
  workspace,
  crumbs,
}: {
  trace: TraceView;
  workspaceId: string;
  workspace: string;
  crumbs: (time?: string) => React.ReactNode;
}) {
  const stepsId = useId();
  const summaryId = useId();
  const names = useNames(workspaceId, trace.routes);
  const { me } = Route.useRouteContext();
  const r = trace.request;
  const steps = traceSteps(trace, names);
  const timeline = timelineMs(trace, steps);
  // Every step with something to show starts open, as drawn.
  const expanded = steps
    .filter((s) => s.details.length > 0 || s.notes.length > 0 || s.attempts.length > 0)
    .map((s) => s.id);
  const wait = longestWait(trace);
  const tokens = trace.attempts.reduce(
    (sum, a) => ({ in: sum.in + a.inputTokens, out: sum.out + a.outputTokens }),
    { in: 0, out: 0 },
  );
  const decision = decisionOf({
    rule: r.decision.rule,
    route: r.decision.route?.name ?? null,
    confidence: r.decision.confidence,
    reason: r.decision.reason,
    fallbackFrom: r.budget?.from ?? null,
    ...(r.budget?.from == null ? {} : { fallbackFromName: names.model(r.budget.from) }),
  });
  const total = formatDuration(r.durationMs).text;
  const timelineEnd = formatDuration(timeline).text;
  const summary: [string, React.ReactNode][] = [
    [
      t('traces.summary.person'),
      `${r.person?.name ?? t('traces.removedPerson')}${r.principal?.kind === 'key' ? `, ${t('traces.key', { name: r.principal.name })}` : ''}`,
    ],
    [t('traces.summary.surface'), r.surface === null ? '' : surfaceName(r.surface)],
    ...(r.model === null
      ? []
      : ([[t('traces.summary.answeredBy'), names.model(r.model)]] as [string, string][])),
    ...(r.decision.rule === null
      ? []
      : ([[t('traces.summary.why'), decision.reason]] as [string, string][])),
    [
      t('traces.summary.total'),
      wait === null
        ? total
        : t('traces.summary.totalWaiting', { total, wait: formatDuration(wait.ms).text }),
    ],
    [t('traces.summary.cost'), requestCost(r.costMicroUsd)],
    ...(tokens.in + tokens.out === 0
      ? []
      : ([
          [
            t('traces.summary.tokens'),
            t('traces.detail.tokenCount', {
              in: formatCount(tokens.in),
              out: formatCount(tokens.out),
            }),
          ],
        ] as [string, string][])),
    [
      t('traces.summary.requestId'),
      <code key="id" className="break-all text-caption">
        {r.requestId}
      </code>,
    ],
  ];
  const own = r.person?.id === me.actingUserId && r.conversationId !== null;
  return (
    <>
      {crumbs(formatTime(r.startedAt))}
      {/* The outcome chip sits at the top right, as drawn; on a phone it drops under the sentence. */}
      <PageHeader
        title={t('traces.traceTitle')}
        lede={leadSentence(trace, names)}
        alignActions="start"
        actions={
          <span className="shrink-0">
            <OutcomeChip kind={r.outcomeKind} words={t(CHIP[r.outcomeKind])} withIcon />
          </span>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section aria-labelledby={stepsId} className="flex flex-col lk-card">
          {/* The same columns as a step's row: the timeline's scale sits over the bars. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border pt-3.5 pe-5 pb-2.5 ps-14 text-caption text-muted lg:grid-cols-[minmax(0,1fr)_220px_72px]">
            <h2 id={stepsId} className="font-medium">
              {t('traces.steps')}
            </h2>
            <span aria-hidden="true" className="hidden justify-between lg:flex">
              <span className="lk-num">0 s</span>
              <span className="lk-num">{timelineEnd}</span>
            </span>
            <span className="text-end">{t('traces.time')}</span>
          </div>
          <TraceSteps
            labelledBy={stepsId}
            steps={steps.map((s) => asPatternStep(s, trace, names, workspace, timeline))}
            expanded={expanded}
          />
          <div
            aria-hidden="true"
            className="flex gap-4 border-t border-separator px-5 py-3 text-caption text-muted"
          >
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-4 rounded-xs bg-lk-trace-run" />
              {t('traces.legend.working')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-4 rounded-xs bg-lk-trace-wait" />
              {t('traces.legend.waiting')}
            </span>
          </div>
        </section>
        <aside aria-labelledby={summaryId} className="flex flex-col gap-3 lk-card p-6">
          <h2 id={summaryId} className="text-heading">
            {t('traces.summary')}
          </h2>
          <dl className="flex flex-col gap-2.5 text-body">
            {summary.map(([term, value]) => (
              <div key={term} className="flex flex-col gap-0.5">
                <dt className="text-small text-muted">{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {own && r.conversationId !== null && (
            <Link
              to="/workspaces/$workspaceId/chat"
              params={{ workspaceId }}
              search={{ c: r.conversationId }}
              className="lk-link lk-link-alone"
            >
              {t('traces.openConversation')}
            </Link>
          )}
        </aside>
      </div>
    </>
  );
}
