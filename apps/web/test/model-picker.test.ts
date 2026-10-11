import { describe, expect, it } from 'vitest';
import { alsoFoundBy, AUTO, choiceFor } from '../src/components/chat/model-picker.tsx';

const models = [
  { id: 'anthropic:claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
  { id: 'bedrock:claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
  { id: 'openai:gpt-5-mini', displayName: 'GPT-5 mini' },
];

describe('the chat model picker (CH-3)', () => {
  it('CH-3: search finds a route by the model it sends to, and a model by its id', () => {
    const routes = [
      {
        id: 'route/coding',
        model: 'anthropic:claude-haiku-4-5',
        modelName: 'Claude Haiku 4.5',
      },
    ];
    const extra = alsoFoundBy(routes, models);
    expect(extra.get('route/coding')).toContain('Claude Haiku 4.5');
    expect(extra.get('route/coding')).toContain('anthropic:claude-haiku-4-5');
    expect(extra.get('openai:gpt-5-mini')).toBe('openai:gpt-5-mini');
    // Two models with one name stay apart by id.
    expect(extra.get('bedrock:claude-haiku-4-5')).toBe('bedrock:claude-haiku-4-5');
  });

  it("RT-3, CH-3: with a pinned model, another pick is recorded as the person's choice", () => {
    const pinned = {
      routing: {
        enabled: true,
        defaultModel: null,
        pinnedModel: { id: 'openai:gpt-5-mini', name: 'GPT-5 mini' },
      },
    };
    expect(choiceFor(pinned, 'anthropic:claude-haiku-4-5')).toBe('anthropic:claude-haiku-4-5');
    // Picking the pinned model, or Auto, records nothing: the pin answers on its own.
    expect(choiceFor(pinned, 'openai:gpt-5-mini')).toBeNull();
    expect(choiceFor(pinned, AUTO)).toBeNull();
  });
});
