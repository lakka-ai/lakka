import { describe, expect, it } from 'vitest';
import type { RequestSummaryView, SpanView, TraceView } from '@lakka/contracts';
import { leadSentence, requestCost, rowReason, traceSteps } from '../src/lib/traces.ts';
import type { Names } from '../src/lib/traces.ts';

const names: Names = {
  model: (ref) => ({ 'a:sonnet': 'Claude Sonnet 4.5', 'a:haiku': 'Claude Haiku 4.5' })[ref] ?? ref,
  route: (id) => (id === 'r1' ? 'code' : null),
  provider: (p) => (p === 'anthropic' ? 'Anthropic' : p),
};

const summary = (extra: Partial<RequestSummaryView> = {}): RequestSummaryView => ({
  requestId: 'req',
  traceId: 'trace',
  startedAt: '2026-09-28T14:32:07Z',
  durationMs: 23_900,
  status: 'ok',
  errorType: null,
  surface: 'chat',
  model: 'a:haiku',
  outcome: 'completed',
  principal: null,
  person: { id: 'maja', name: 'Maja Lind' },
  conversationId: null,
  costMicroUsd: '7300',
  outcomeKind: 'completed',
  decision: {
    requested: 'auto',
    rule: 'classified',
    route: { id: 'r1', name: 'code' },
    confidence: 0.914,
    threshold: 0.25,
    reason: null,
  },
  budget: null,
  provider: null,
  toolDenied: false,
  ...extra,
});

const span = (
  name: string,
  offsetMs: number,
  durationMs: number,
  extra: Partial<SpanView> = {},
): SpanView => ({
  spanId: name,
  requestId: 'req',
  parentSpanId: 'root',
  depth: 1,
  name,
  kind: 'internal',
  status: 'ok',
  errorType: null,
  offsetMs,
  durationMs,
  attributes: {},
  events: [],
  ...extra,
});

describe('the Requests list and trace (OB-1, ADR 0095)', () => {
  it('OB-1: each row says why, in the words of the Requests board', () => {
    expect(rowReason(summary(), names)).toBe('Code route, 0.91');
    expect(
      rowReason(summary({ decision: { ...summary().decision, rule: 'explicit' } }), names),
    ).toBe('Chosen by the person');
    expect(
      rowReason(
        summary({
          outcomeKind: 'cheaper',
          budget: {
            scope: 'workspace',
            remainingMicroUsd: '400000',
            from: 'a:sonnet',
            to: 'a:haiku',
          },
        }),
        names,
      ),
    ).toBe('Workspace cap would not cover Claude Sonnet 4.5');
    expect(
      rowReason(
        summary({
          outcomeKind: 'refused',
          status: 'error',
          errorType: 'budget_exceeded',
          budget: { scope: 'key', remainingMicroUsd: '0', from: null, to: null },
        }),
        names,
      ),
    ).toBe('Key cap used up');
    expect(
      rowReason(
        summary({ outcomeKind: 'refused', status: 'error', errorType: 'budget_unavailable' }),
        names,
      ),
    ).toBe('Budgets could not be checked');
    expect(rowReason(summary({ outcomeKind: 'failed', provider: 'anthropic' }), names)).toBe(
      'Anthropic did not respond',
    );
    expect(rowReason(summary({ outcomeKind: 'stopped' }), names)).toBe('Stopped by the person');
    expect(rowReason(summary({ toolDenied: true }), names)).toBe('A tool call was denied');
  });

  it('TL-4: a trace across an approval orders the wait between the steps, and says who waited', () => {
    const trace: TraceView = {
      request: summary({
        outcomeKind: 'cheaper',
        budget: {
          scope: 'workspace',
          remainingMicroUsd: '400000',
          from: 'a:sonnet',
          to: 'a:haiku',
        },
      }),
      spans: [
        span('request', 0, 23_900, { parentSpanId: null, depth: 0, spanId: 'root' }),
        span('policy.authorize', 0, 3),
        span('policy.resolve_model', 3, 14, {
          attributes: {
            'lakka.routing.rule': 'classified',
            'lakka.routing.route_id': 'r1',
            'lakka.routing.confidence': 0.86,
            'lakka.routing.threshold': 0.75,
            'lakka.routing.requested': 'auto',
            'lakka.model': 'a:sonnet',
          },
        }),
        span('policy.reserve_budget', 17, 6, {
          attributes: {
            'lakka.budget.estimate_micro_usd': 610_000,
            'lakka.budget.scope': 'workspace',
            'lakka.budget.remaining_micro_usd': 400_000,
            'lakka.budget.fallback_from': 'a:sonnet',
            'lakka.budget.fallback_model': 'a:haiku',
            'lakka.budget.fallback_estimate_micro_usd': 200_000,
            'lakka.budget.held_micro_usd': 200_000,
          },
        }),
        span('execute_tool', 20_900, 1200, {
          attributes: { 'lakka.tool.name': 'github__create_pr', 'lakka.tool.status': 'ok' },
        }),
      ],
      attempts: [],
      approvals: [
        {
          approvalId: 'ap',
          toolName: 'github__create_pr',
          status: 'approved',
          always: false,
          askedOffsetMs: 2900,
          answeredOffsetMs: 20_900,
          answeredBy: { id: 'maja', name: 'Maja Lind' },
        },
      ],
      content: [],
      routes: [{ id: 'r1', name: 'code' }],
    };
    const steps = traceSteps(trace, names);
    expect(steps.map((s) => `${s.name}: ${s.outcome}`)).toEqual([
      'Checking access: Allowed',
      'Choosing the model: Code route',
      'Holding the budget: Moved to a cheaper model',
      'Waiting for approval: Allowed once by Maja Lind',
      'Running a tool github__create_pr: Finished',
    ]);
    const choosing = steps[1];
    expect(choosing?.details).toContainEqual(['Confidence', '0.86. The route needs 0.75.']);
    expect(choosing?.details).toContainEqual(['Asked for', 'Auto']);
    expect(steps[2]?.notes[0]).toBe(
      'Claude Sonnet 4.5 could cost up to $0.61 for this request. The workspace cap had $0.40 left, so Lakka sent it to Claude Haiku 4.5, which could cost up to $0.20.',
    );
    expect(steps[3]).toMatchObject({ waiting: true, durationMs: 18_000 });
    expect(leadSentence(trace, names)).toBe(
      'A cheaper model answered because the workspace cap would not cover Claude Sonnet 4.5. Most of the 23.9 s was spent waiting for Maja Lind to answer a tool approval.',
    );
  });

  it('nothing charged is written $0.00; a request cost keeps four decimals', () => {
    expect(requestCost('0')).toBe('$0.00');
    expect(requestCost('7300')).toBe('$0.0073');
  });
});
