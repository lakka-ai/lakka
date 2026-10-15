import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplyView } from '../src/components/chat/message.tsx';
import type { Reply, ToolUse } from '../src/components/chat/thread.ts';

/* A reply's tool calls as chat lists them (TL-4, Pattern 9). */

const use = (name: string, status: ToolUse['status']): ToolUse => ({
  callId: name,
  name,
  arguments: {},
  status,
  durationMs: 12,
  asked: status !== 'ok',
  result: status === 'ok' ? '[]' : null,
  failed: false,
});

const reply = (tools: ToolUse[]): Reply => ({
  requestId: 'r1',
  model: 'anthropic:claude-sonnet-4-5',
  modelName: 'Claude Sonnet 4.5',
  decision: {
    rule: 'default',
    route: null,
    confidence: null,
    reason: 'routing_off',
    fallbackFrom: null,
    fallbackFromName: null,
  },
  text: '',
  tools,
  state: 'complete',
  costMicroUsd: null,
});

const html = (r: Reply) =>
  renderToStaticMarkup(createElement(ReplyView, { reply: r, workspaceId: 'w1', streaming: true }));

describe('tool calls in a reply (TL-4)', () => {
  it('TL-4: a call that stopped to ask is not listed as used; the approval card stands for it', () => {
    const out = html(
      reply([
        use('helpdesk.search_tickets', 'ok'),
        use('helpdesk.close_ticket', 'approval_required'),
      ]),
    );
    expect(out).toContain('helpdesk.search_tickets');
    expect(out).not.toContain('helpdesk.close_ticket');
  });

  it('TL-4: a call that ran after its approval is listed as used', () => {
    const out = html(reply([use('helpdesk.close_ticket', 'ok')]));
    expect(out).toMatch(/Used .*helpdesk\.close_ticket/);
  });
});
