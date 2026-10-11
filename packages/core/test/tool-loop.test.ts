import { describe, expect, it } from 'vitest';
import { estimateInputTokens } from '../src/gateway/estimate.ts';
import { toolDefinitions, withToolNote } from '../src/pipeline/tool-loop.ts';
import type { ToolSnapshot } from '../src/routing/score.ts';
import { TOOL_RESULTS_ARE_DATA } from '../src/tools/shape.ts';

/* The pure parts of the tool loop (TL-7, H7, ADR 0071). */

const tool = (modelName: string, description: string | null = null): ToolSnapshot => ({
  id: modelName,
  serverId: 's1',
  serverName: 'srv',
  name: modelName.split('__')[1] ?? modelName,
  modelName,
  title: null,
  description,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: {},
  approvalRequired: false,
});

describe('offering tools', () => {
  it('ADR 0069: the model gets the stored definitions, less any tool put aside', () => {
    const offered = [tool('srv__echo', 'Returns its text.'), tool('srv__delete')];
    expect(toolDefinitions(offered)).toEqual([
      {
        name: 'srv__echo',
        description: 'Returns its text.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      {
        name: 'srv__delete',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]);
    expect(toolDefinitions(offered, (name) => name === 'srv__echo').map((d) => d.name)).toEqual([
      'srv__delete',
    ]);
  });

  it('H7: the note that results are data comes first, before any system message', () => {
    expect(
      withToolNote([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ]),
    ).toEqual([
      { role: 'system', content: TOOL_RESULTS_ARE_DATA },
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('invariant 4: tool definitions and calls count toward the estimate a round reserves', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const bare = estimateInputTokens({ messages }, 'upper');
    const withTools = estimateInputTokens(
      { messages, tools: toolDefinitions([tool('srv__echo', 'x'.repeat(4000))]) },
      'upper',
    );
    const withCalls = estimateInputTokens(
      {
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'srv__echo', arguments: 'y'.repeat(4000) }],
          },
        ],
      },
      'upper',
    );
    expect(withTools).toBeGreaterThan(bare + 900);
    expect(withCalls).toBeGreaterThan(bare + 900);
  });
});
