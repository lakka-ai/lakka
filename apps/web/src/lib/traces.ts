import type {
  AttemptView,
  RequestOutcome,
  RequestSummaryView,
  SpanView,
  TraceView,
} from '@lakka/contracts';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { formatDuration } from './format.ts';
import { formatCost, formatMicroUsd } from './money.ts';
import { formatCount } from './spend.ts';

/*
 * What the Requests and trace pages say about a request (OB-1; Requests, Trace and
 * Trace-Refused boards; ADR 0095), from what the api sends: the outcome and its reason on each
 * row, the sentence at the top of a trace, and the steps, each with a plain name, how it went
 * and what it decided. Names for models, routes and providers are passed in, so these stay
 * plain functions.
 */

export interface Names {
  model: (ref: string) => string;
  route: (id: string) => string | null;
  provider: (provider: string) => string;
}

type Cap = 'instance' | 'workspace' | 'member' | 'key';

const CAP: Readonly<Record<Cap, MessageKey>> = {
  instance: 'traces.cap.instance',
  workspace: 'traces.cap.workspace',
  member: 'traces.cap.member',
  key: 'traces.cap.key',
};
const CAP_IN: Readonly<Record<Cap, MessageKey>> = {
  instance: 'traces.capIn.instance',
  workspace: 'traces.capIn.workspace',
  member: 'traces.capIn.member',
  key: 'traces.capIn.key',
};

export const OUTCOME: Readonly<Record<RequestOutcome, MessageKey>> = {
  completed: 'traces.outcome.completed',
  cheaper: 'traces.outcome.cheaper',
  refused: 'traces.outcome.refused',
  stopped: 'traces.outcome.stopped',
  failed: 'traces.outcome.failed',
};

const REFUSAL: Readonly<Record<string, MessageKey>> = {
  budget_exceeded: 'traces.reason.budget_exceeded',
  budget_unavailable: 'traces.reason.budget_unavailable',
  rate_limited: 'traces.reason.rate_limited',
  forbidden: 'traces.reason.forbidden',
  no_model: 'traces.reason.no_model',
  unsupported_input: 'traces.reason.unsupported_input',
};

const two = (n: number) => n.toFixed(2);

/** A route's name for people, from its slug: "quick-questions" -> "Quick questions". */
export function routeWords(slug: string): string {
  const words = slug.replaceAll('-', ' ');
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}

/** How the model was picked, in a few words: "Code route, 0.91", "Chosen by the person". */
function decisionReason(r: RequestSummaryView, names: Names): string {
  const { decision } = r;
  const route =
    decision.route === null
      ? null
      : routeWords(decision.route.name ?? names.route(decision.route.id) ?? '');
  switch (decision.rule) {
    case 'classified':
      return route === null
        ? t('traces.reason.default')
        : decision.confidence === null
          ? t('traces.reason.route', { route })
          : t('traces.reason.routeSure', { route, confidence: two(decision.confidence) });
    case 'signal':
    case 'sticky':
      return route === null ? t('traces.reason.default') : t('traces.reason.route', { route });
    case 'explicit':
      return t('traces.reason.chosen');
    case 'pinned':
      return t('traces.reason.pinned');
    default:
      return t('traces.reason.default');
  }
}

/** What happened to a request, as the list's second line under its outcome. */
export function rowReason(r: RequestSummaryView, names: Names): string {
  switch (r.outcomeKind) {
    case 'cheaper':
      return r.budget === null
        ? t('traces.outcome.cheaper')
        : t('traces.reason.cheaper', {
            cap: t(CAP[r.budget.scope]),
            model: r.budget.from === null ? '' : names.model(r.budget.from),
          });
    case 'refused':
      if (r.errorType === 'budget_exceeded' && r.budget !== null) {
        return r.budget.remainingMicroUsd === '0'
          ? t('traces.reason.capUsedUp', { cap: t(CAP[r.budget.scope]) })
          : t('traces.reason.capFull', { cap: t(CAP[r.budget.scope]) });
      }
      return t(REFUSAL[r.errorType ?? ''] ?? 'traces.reason.failed');
    case 'failed':
      if (r.provider !== null) {
        return t('traces.reason.provider', { provider: names.provider(r.provider) });
      }
      return r.outcome === 'interrupted' ? t('traces.reason.brokeOff') : t('traces.reason.failed');
    case 'stopped':
      return t('traces.reason.stopped');
    case 'completed':
      return r.toolDenied ? t('traces.reason.toolDenied') : decisionReason(r, names);
  }
}

/** The longest wait for a person, and who answered, from the trace's approvals. */
export function longestWait(trace: TraceView): { ms: number; name: string | null } | null {
  let longest: { ms: number; name: string | null } | null = null;
  for (const a of trace.approvals) {
    if (a.answeredOffsetMs === null) continue;
    const ms = a.answeredOffsetMs - a.askedOffsetMs;
    if (longest === null || ms > longest.ms) longest = { ms, name: a.answeredBy?.name ?? null };
  }
  return longest;
}

/** The sentence at the top of a trace. */
export function leadSentence(trace: TraceView, names: Names): string {
  const r = trace.request;
  const total = formatDuration(r.durationMs).text;
  const model = r.model === null ? '' : names.model(r.model);
  let lead: string;
  switch (r.outcomeKind) {
    case 'cheaper':
      lead =
        r.budget === null
          ? t('traces.lead.completed', { model, total })
          : t('traces.lead.cheaper', {
              cap: t(CAP_IN[r.budget.scope]),
              model: r.budget.from === null ? '' : names.model(r.budget.from),
            });
      break;
    case 'refused':
      if (r.errorType === 'budget_unavailable') return t('traces.lead.refusedUnavailable');
      if (r.errorType === 'budget_exceeded' && r.budget !== null) {
        return t('traces.lead.refusedCap', { cap: t(CAP_IN[r.budget.scope]) });
      }
      return t('traces.lead.refused', { reason: rowReason(r, names).toLowerCase() });
    case 'failed':
      return r.provider !== null
        ? t('traces.lead.failed', { provider: names.provider(r.provider) })
        : r.outcome === 'interrupted'
          ? t('traces.lead.brokeOff')
          : t('traces.lead.failedOther');
    case 'stopped':
      lead = t('traces.lead.stopped', { total });
      break;
    case 'completed':
      lead = t('traces.lead.completed', { model, total });
      break;
  }
  const wait = longestWait(trace);
  if (wait !== null && wait.name !== null && wait.ms * 2 > r.durationMs) {
    lead = `${lead} ${t('traces.lead.waited', { total, name: wait.name })}`;
  }
  return lead;
}

const num = (span: SpanView, key: string) => {
  const v = span.attributes[key];
  return typeof v === 'number' ? v : null;
};
const str = (span: SpanView, key: string) => {
  const v = span.attributes[key];
  return typeof v === 'string' ? v : null;
};
/** Integer micro-USD from a span attribute, which the exporter stores as a number. */
const micro = (span: SpanView, key: string) => {
  const v = num(span, key);
  return v === null ? null : String(Math.round(v));
};
/** A cap's amounts, estimates and holds in dollars and cents, as the board writes them. */
const money = (value: string | null) => (value === null ? '' : formatMicroUsd(value));

/** A request's cost: four decimals, as copy.md allows, but nothing is written $0.00. */
export function requestCost(amount: string): string {
  return BigInt(amount) === 0n ? '$0.00' : formatCost(amount);
}

/** A detail's value: words, or a model named with its id, which is set apart in mono. */
export type DetailValue = string | { name: string; id: string };
export type Detail = [string, DetailValue];

export interface Step {
  id: string;
  name: string;
  outcome: string;
  failed: boolean;
  offsetMs: number;
  durationMs: number;
  waiting: boolean;
  /** The budget moved the request to a cheaper model at this step. */
  cheaper?: boolean;
  details: Detail[];
  /** Sentences under the details, such as how the budget was held. */
  notes: string[];
  /** For a model call: its attempts. */
  attempts: AttemptView[];
  /** For a model call: the span ids whose recorded prompt and reply belong to it. */
  callSpanIds: string[];
}

function asked(requested: string | null, names: Names): string {
  if (requested === null || requested === 'auto') return t('traces.detail.auto');
  if (requested.startsWith('route/')) {
    return t('traces.detail.route', { route: routeWords(requested.slice('route/'.length)) });
  }
  return names.model(requested);
}

function resolveStep(span: SpanView, names: Names): Pick<Step, 'outcome' | 'details'> {
  const rule = str(span, 'lakka.routing.rule');
  const routeId = str(span, 'lakka.routing.route_id');
  const route = routeId === null ? null : routeWords(names.route(routeId) ?? '');
  const confidence = num(span, 'lakka.routing.confidence');
  const threshold = num(span, 'lakka.routing.threshold');
  const reason = str(span, 'lakka.routing.default_reason');
  const model = str(span, 'lakka.model');
  const outcome =
    rule === 'explicit'
      ? t('traces.reason.chosen')
      : rule === 'pinned'
        ? t('traces.reason.pinned')
        : rule === 'default'
          ? reason === 'below_threshold' || reason === 'ambiguous'
            ? t('traces.step.defaultNoRoute')
            : t('traces.reason.default')
          : route === null
            ? t('traces.reason.default')
            : t('traces.reason.route', { route });
  const ruleWords =
    rule === 'classified' && route !== null
      ? t('traces.rule.classified', { route })
      : rule === 'signal' && route !== null
        ? t('traces.rule.signal', { route })
        : rule === 'sticky'
          ? t('traces.rule.sticky')
          : rule === 'explicit'
            ? t('traces.rule.explicit')
            : rule === 'pinned'
              ? t('traces.rule.pinned')
              : t(`routing.try.rule.${reason ?? 'no_routes'}` as MessageKey);
  const details: Detail[] = [
    [t('traces.detail.askedFor'), asked(str(span, 'lakka.routing.requested'), names)],
    [t('traces.detail.rule'), ruleWords],
  ];
  if (confidence !== null) {
    details.push([
      t('traces.detail.confidence'),
      threshold === null
        ? two(confidence)
        : t('traces.detail.sure', { confidence: two(confidence), threshold: two(threshold) }),
    ]);
  }
  if (model !== null)
    details.push([t('traces.detail.picked'), { name: names.model(model), id: model }]);
  return { outcome, details };
}

function reserveStep(
  span: SpanView,
  r: RequestSummaryView,
  names: Names,
  /** The model the routing step picked: a request refused here never reached one to answer. */
  picked: string | null,
): Pick<Step, 'outcome' | 'notes' | 'cheaper'> {
  const held = micro(span, 'lakka.budget.held_micro_usd');
  const scope = str(span, 'lakka.budget.scope') as Cap | null;
  const left = micro(span, 'lakka.budget.remaining_micro_usd');
  const estimate = micro(span, 'lakka.budget.estimate_micro_usd');
  const to = str(span, 'lakka.budget.fallback_model');
  const cap = scope === null ? '' : t(CAP_IN[scope]);
  if (span.status === 'error') {
    if (span.errorType === 'budget_exceeded') {
      return {
        outcome: t('traces.step.noRoom'),
        notes: [
          t('traces.budget.noRoom', {
            model: modelName(r, names, picked),
            estimate: money(estimate),
            cap,
            left: money(left),
          }),
        ],
      };
    }
    return {
      outcome: t('traces.step.couldNotCheck'),
      notes: [t('traces.budget.unavailable'), t('traces.budget.check')],
    };
  }
  if (to !== null) {
    const from = str(span, 'lakka.budget.fallback_from');
    return {
      cheaper: true,
      outcome: t('traces.step.movedCheaper'),
      notes: [
        t('traces.budget.moved', {
          from: from === null ? '' : names.model(from),
          estimate: money(estimate),
          cap,
          left: money(left),
          to: names.model(to),
          fallback: money(micro(span, 'lakka.budget.fallback_estimate_micro_usd')),
        }),
        ...(held === null ? [] : [t('traces.budget.held', { amount: money(held) })]),
      ],
    };
  }
  return {
    outcome: t('traces.step.held'),
    notes: held === null ? [] : [t('traces.budget.held', { amount: money(held) })],
  };
}

function dispatchOutcome(span: SpanView, attempts: readonly AttemptView[]): string {
  if (span.status === 'error') return t('traces.step.noAnswer');
  const last = attempts.at(-1);
  if (last === undefined) return t('traces.step.finished');
  if (last.outcome === 'aborted') return t('traces.step.stopped');
  if (last.outcome === 'interrupted') return t('traces.step.brokeOff');
  if (last.finishReason === 'tool-calls') return t('traces.step.askedTool');
  if (last.finishReason === 'length') return t('traces.step.lengthLimit');
  return t('traces.step.finished');
}

const TOOL: Readonly<Record<string, MessageKey>> = {
  ok: 'traces.step.toolOk',
  failed: 'traces.step.toolFailed',
  timeout: 'traces.step.toolTimeout',
  denied: 'traces.step.toolNotAllowed',
  approval_required: 'traces.step.toolAsked',
  rejected: 'traces.step.toolRejected',
};

/** What every step built from a span starts from. */
const base = (span: SpanView): Omit<Step, 'name' | 'outcome'> => ({
  id: span.spanId,
  failed: span.status === 'error',
  offsetMs: span.offsetMs,
  durationMs: span.durationMs,
  waiting: false,
  details: [],
  notes: [],
  attempts: [],
  callSpanIds: [],
});

/** What a refusal names: the model that answered, else the one routing picked. */
function modelName(r: RequestSummaryView, names: Names, picked: string | null): string {
  const ref = r.model ?? picked;
  return r.decision.rule === null || ref === null ? '' : names.model(ref);
}

/** The model the request's routing step chose, whether or not it was ever called. */
const pickedModel = (trace: TraceView): string | null => {
  const resolve = trace.spans.find((s) => s.depth === 1 && s.name === 'policy.resolve_model');
  return resolve === undefined ? null : str(resolve, 'lakka.model');
};

/**
 * The trace's steps in time order: the request's own steps, each model call with its attempts,
 * and each wait for an approval between the request that asked and the one that answered.
 */
export function traceSteps(trace: TraceView, names: Names): Step[] {
  const steps: Step[] = [];
  // Each model call's attempts: its chat spans name the attempt, within their request.
  const children = new Map<string, SpanView[]>();
  for (const s of trace.spans) {
    if (s.parentSpanId === null) continue;
    children.set(s.parentSpanId, [...(children.get(s.parentSpanId) ?? []), s]);
  }
  const attemptsOf = (dispatch: SpanView): AttemptView[] =>
    (children.get(dispatch.spanId) ?? []).flatMap((call) => {
      const n = num(call, 'lakka.attempt');
      const found = trace.attempts.find((a) => a.requestId === call.requestId && a.attempt === n);
      return found === undefined ? [] : [found];
    });
  for (const span of trace.spans) {
    if (span.depth !== 1) continue;
    switch (span.name) {
      case 'policy.authorize':
        steps.push({
          ...base(span),
          name: t('traces.step.authorize'),
          outcome: span.status === 'error' ? t('traces.step.notAllowed') : t('traces.step.allowed'),
        });
        break;
      case 'policy.resolve_model':
        steps.push({ ...base(span), name: t('traces.step.resolve'), ...resolveStep(span, names) });
        break;
      case 'policy.reserve_budget':
        steps.push({
          ...base(span),
          name: t('traces.step.reserve'),
          ...reserveStep(span, trace.request, names, pickedModel(trace)),
        });
        break;
      case 'gateway.dispatch': {
        const attempts = attemptsOf(span);
        steps.push({
          ...base(span),
          name: t('traces.step.dispatch'),
          outcome: dispatchOutcome(span, attempts),
          attempts,
          callSpanIds: (children.get(span.spanId) ?? []).map((c) => c.spanId),
        });
        break;
      }
      case 'execute_tool': {
        const status = str(span, 'lakka.tool.status');
        steps.push({
          ...base(span),
          name: t('traces.step.tool', { name: str(span, 'lakka.tool.name') ?? '' }),
          outcome: t(TOOL[status ?? ''] ?? 'traces.step.toolOk'),
          failed: span.status === 'error' || status === 'failed' || status === 'timeout',
        });
        break;
      }
      case 'policy.reconcile': {
        const actual = micro(span, 'lakka.budget.actual_micro_usd') ?? '0';
        const delta = micro(span, 'lakka.budget.delta_micro_usd') ?? '0';
        steps.push({
          ...base(span),
          name: t('traces.step.reconcile'),
          outcome: t('traces.step.charged', { amount: requestCost(actual) }),
          notes: [
            t('traces.settle', { actual: requestCost(actual), released: requestCost(delta) }),
          ],
        });
        break;
      }
      default:
        break;
    }
  }
  for (const a of trace.approvals) {
    const by = a.answeredBy?.name ?? '';
    const outcome =
      a.status === 'pending'
        ? t('traces.step.stillWaiting')
        : a.status === 'expired'
          ? t('traces.step.expired')
          : a.status === 'denied'
            ? t('traces.step.deniedBy', { name: by })
            : a.always
              ? t('traces.step.allowedAlways', { name: by })
              : t('traces.step.allowedOnce', { name: by });
    steps.push({
      id: a.approvalId,
      name: t('traces.step.wait'),
      outcome,
      failed: a.status === 'denied' || a.status === 'expired',
      offsetMs: a.askedOffsetMs,
      durationMs: (a.answeredOffsetMs ?? trace.request.durationMs) - a.askedOffsetMs,
      waiting: true,
      details: [
        [t('traces.detail.tool'), a.toolName],
        [t('traces.detail.whyAsked'), t('traces.detail.whyAskedValue')],
        [t('traces.detail.askedIn'), trace.request.surface ?? ''],
      ],
      notes: [],
      attempts: [],
      callSpanIds: [],
    });
  }
  return steps.toSorted((a, b) => a.offsetMs - b.offsetMs);
}

/** An attempt's details: model, time to first token, tokens and cost. */
export function attemptDetails(a: AttemptView, names: Names): Detail[] {
  return [
    [
      t('traces.detail.attempt', { n: String(a.attempt) }),
      { name: names.model(a.model), id: a.model },
    ],
    ...(a.ttftMs === null
      ? []
      : [[t('traces.detail.ttft'), formatDuration(a.ttftMs).text] satisfies Detail]),
    [
      t('traces.detail.tokens'),
      t('traces.detail.tokenCount', {
        in: formatCount(a.inputTokens),
        out: formatCount(a.outputTokens),
      }),
    ],
    [t('traces.detail.cost'), requestCost(a.costMicroUsd)],
  ];
}
