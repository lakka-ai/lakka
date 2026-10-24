import { describe, expect, it } from 'vitest';
import { openAiFinishReason } from '../src/openai/response.ts';

describe('openAiFinishReason', () => {
  it('API-6: maps every gateway finish reason to one an OpenAI client knows', () => {
    expect(openAiFinishReason('stop')).toBe('stop');
    expect(openAiFinishReason('length')).toBe('length');
    expect(openAiFinishReason('content-filter')).toBe('content_filter');
    expect(openAiFinishReason('tool-calls')).toBe('tool_calls');
    // OpenAI has no value for these, so they fall back to the default.
    expect(openAiFinishReason('error')).toBe('stop');
    expect(openAiFinishReason('interrupted')).toBe('stop');
    expect(openAiFinishReason('other')).toBe('stop');
  });
});
