import { describe, expect, it } from 'vitest';
import type { ConversationSummaryView, MessageView } from '@lakka/contracts';
import {
  decisionOf,
  groupConversations,
  problemOf,
  routeLabel,
} from '../src/components/chat/copy.ts';
import { argumentLines, keptReason, segmentsOf, threadOf } from '../src/components/chat/thread.ts';

const base: MessageView = {
  id: 'm',
  role: 'assistant',
  content: '',
  requestId: 'r1',
  state: 'complete',
  model: 'anthropic:claude-haiku-4-5',
  modelName: 'Claude Haiku 4.5',
  routingRule: 'classified',
  routeName: 'code',
  routingConfidence: 0.92,
  routingReason: null,
  fallbackFrom: null,
  fallbackFromName: null,
  fallbackScope: null,
  costMicroUsd: null,
  toolCalls: null,
  tools: null,
  toolCallId: null,
  toolName: null,
  toolError: null,
  createdAt: '2026-09-28T09:00:00.000Z',
  attachments: [],
};
const msg = (over: Partial<MessageView>): MessageView => ({ ...base, ...over });

describe('chat thread (CH-1, CH-2)', () => {
  it('TL-6: a reply that called tools is one reply, with the calls inside it and its cost once', () => {
    const items = threadOf([
      msg({ id: 'u', role: 'user', content: 'Find fetch_lines', model: null, requestId: 'r1' }),
      msg({
        id: 'a1',
        content: 'Looking.',
        toolCalls: [{ callId: 'c1', name: 'repo__search' }],
        tools: [
          {
            callId: 'c1',
            name: 'repo__search',
            arguments: { query: 'fetch_lines' },
            status: 'ok',
            durationMs: 310,
            asked: false,
          },
        ],
      }),
      msg({
        id: 't',
        role: 'tool',
        content: 'billing/invoices.py line 88',
        toolCallId: 'c1',
        toolName: 'repo__search',
      }),
      msg({ id: 'a2', content: 'It is in billing.', costMicroUsd: '9400' }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['turn', 'reply']);
    const reply = items[1]?.kind === 'reply' ? items[1].reply : undefined;
    expect(reply).toMatchObject({
      text: 'Looking.\n\nIt is in billing.',
      costMicroUsd: '9400',
      tools: [
        { name: 'repo.search', result: 'billing/invoices.py line 88', asked: false, failed: false },
      ],
    });
  });

  it('RT-7: a sticky reply with no route says why when the thread shows an earlier "not sure"', () => {
    const notSure = {
      routingRule: 'default',
      routeName: null,
      routingConfidence: 0.16,
      routingReason: 'below_threshold' as const,
    };
    const sticky = { routingRule: 'sticky', routeName: null, routingConfidence: null };
    const items = threadOf([
      msg({ id: 'u1', role: 'user', model: null, requestId: 'r1' }),
      msg({ id: 'a1', requestId: 'r1', ...notSure }),
      msg({ id: 'u2', role: 'user', model: null, requestId: 'r2' }),
      msg({ id: 'a2', requestId: 'r2', ...sticky }),
    ]);
    const replies = items.flatMap((i) => (i.kind === 'reply' ? [i.reply] : []));
    expect(replies[1]?.decision.reason).toBe('below_threshold');
    expect(keptReason(items)).toBe('below_threshold');

    // A route that chose the model and was deleted since leaves the same no-route sticky reply,
    // which must not claim routing was unsure.
    const routed = threadOf([
      msg({ id: 'u1', role: 'user', model: null, requestId: 'r1' }),
      msg({ id: 'a1', requestId: 'r1', routeName: null }),
      msg({ id: 'u2', role: 'user', model: null, requestId: 'r2' }),
      msg({ id: 'a2', requestId: 'r2', ...sticky }),
    ]);
    const last = routed.at(-1);
    expect(last?.kind === 'reply' ? last.reply.decision.reason : 'missing').toBeNull();
    expect(keptReason(routed)).toBeNull();
  });

  it('splits fenced code out of prose, and shows arguments as plain lines', () => {
    expect(segmentsOf('Try this:\n```python\nx = 1\n```\nDone.')).toEqual([
      { code: false, text: 'Try this:' },
      { code: true, text: 'x = 1' },
      { code: false, text: 'Done.' },
    ]);
    expect(argumentLines({ repo: 'nordlys/billing', draft: false })).toBe(
      'repo: nordlys/billing\ndraft: false',
    );
  });
});

const at = (iso: string, id: string): ConversationSummaryView => ({
  id,
  title: id,
  modelChoice: null,
  createdAt: iso,
  updatedAt: iso,
});

describe('chat copy (CH-2, CH-4, CH-7)', () => {
  it('CH-2: says why each model answered, with the classifier confidence', () => {
    expect(
      decisionOf({
        rule: 'classified',
        route: 'code',
        confidence: 0.92,
        reason: null,
        fallbackFrom: null,
      }),
    ).toEqual({
      kind: 'routed',
      route: 'Code',
      reason: 'Routing matched the message to the Code route. Confidence 92%.',
    });
    expect(
      decisionOf({
        rule: 'default',
        route: null,
        confidence: null,
        reason: 'routing_off',
        fallbackFrom: null,
      }),
    ).toEqual({ kind: 'default', reason: 'This is the workspace default model.' });
    expect(
      decisionOf({
        rule: 'classified',
        route: 'code',
        confidence: 0.9,
        reason: null,
        fallbackFrom: 'anthropic:claude-sonnet-4-5',
        fallbackFromName: 'Claude Sonnet 4.5',
      }),
    ).toMatchObject({
      kind: 'fallback',
      reason: 'Your budget would not cover Claude Sonnet 4.5, so a cheaper one answered.',
    });
    expect(routeLabel('quick-questions')).toBe('Quick questions');
  });

  it('RT-6: a default after the classifier was not sure says so, with its confidence', () => {
    for (const reason of ['below_threshold', 'ambiguous']) {
      expect(
        decisionOf({ rule: 'default', route: null, confidence: 0.164, reason, fallbackFrom: null }),
      ).toEqual({
        kind: 'default',
        reason:
          'Routing was not sure which route fits, so the workspace default model answered. Confidence 16%.',
      });
    }
    expect(
      decisionOf({
        rule: 'sticky',
        route: null,
        confidence: null,
        reason: 'below_threshold',
        fallbackFrom: null,
      }),
    ).toEqual({
      kind: 'default',
      reason:
        'Routing was not sure about an earlier message, so this conversation stays on the default model.',
    });
    expect(
      decisionOf({
        rule: 'sticky',
        route: null,
        confidence: null,
        reason: null,
        fallbackFrom: null,
      }).reason,
    ).toBe('Kept from earlier in this conversation.');
  });

  it('CH-4: a refusal says what the message could cost and what is left', () => {
    expect(
      problemOf('budget_exceeded', {
        scope: 'member',
        remainingMicroUsd: '400000',
        requiredMicroUsd: '1400000',
      }),
    ).toMatchObject({
      title: 'Not sent.',
      body: 'This message could cost up to $1.40 and $0.40 is left on your cap. Remove the long file, or pick a cheaper model.',
    });
    expect(
      problemOf(
        'budget_exceeded',
        { scope: 'workspace', remainingMicroUsd: '0' },
        {
          caps: [
            {
              scope: 'workspace',
              limitMicroUsd: '50000000',
              remainingMicroUsd: '0',
              period: 'monthly',
              periodEnd: '2026-10-01T00:00:00.000Z',
              lowAtPercentLeft: 20,
            },
          ],
        },
      ),
    ).toEqual({
      title: 'Not sent. The workspace cap is used up.',
      body: 'Messages are refused until Oct 1. Ask a workspace admin to raise the cap. Your message is kept below.',
    });
  });

  it('CH-7: names the provider, says how long to wait, and never shows a code', () => {
    expect(
      problemOf('upstream_unavailable', { provider: 'anthropic', rateLimited: false }).title,
    ).toBe('Anthropic is not responding.');
    expect(
      problemOf('upstream_unavailable', {
        provider: 'anthropic',
        rateLimited: true,
        retryAfterSeconds: 20,
      }),
    ).toEqual({
      title: 'Too many requests at once.',
      body: 'Wait about 20 seconds, then send again.',
    });
    expect(problemOf('stream_interrupted', {}, { model: 'openai:gpt-4.1-mini' }).body).toBe(
      'OpenAI stopped sending. What arrived is kept.',
    );
    expect(problemOf('something_new', {}).title).not.toContain('something_new');
  });

  it('BG-12, CH-7: a rate-limited message says how long to wait', () => {
    expect(problemOf('rate_limited', { retryAfterSeconds: 12 })).toEqual({
      title: 'Too many requests at once.',
      body: 'Wait about 12 seconds, then send again.',
    });
    expect(problemOf('rate_limited', { retryAfterSeconds: 1 }).body).toBe(
      'Wait about 1 second, then send again.',
    );
    expect(problemOf('rate_limited', {}).body).toBe('Wait a moment, then send again.');
  });

  it('CH-1: groups conversations as Today, Previous 7 days, then by month', () => {
    const groups = groupConversations(
      [
        at('2026-09-28T08:00:00.000Z', 'a'),
        at('2026-09-25T08:00:00.000Z', 'b'),
        at('2026-08-14T08:00:00.000Z', 'c'),
        at('2025-12-01T08:00:00.000Z', 'd'),
      ],
      new Date('2026-09-28T12:00:00.000Z'),
    );
    expect(groups.map((g) => [g.label, g.conversations.map((c) => c.id)])).toEqual([
      ['Today', ['a']],
      ['Previous 7 days', ['b']],
      ['August', ['c']],
      ['December 2025', ['d']],
    ]);
  });
});
