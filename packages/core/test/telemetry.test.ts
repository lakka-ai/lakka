import * as semconv from '@opentelemetry/semantic-conventions/incubating';
import { describe, expect, it } from 'vitest';
import { ERROR_TYPE, GEN_AI, providerName } from '../src/gateway/telemetry.ts';

describe('span attribute names (OB-2)', () => {
  it('match the OpenTelemetry GenAI semantic conventions', () => {
    expect(GEN_AI).toEqual({
      OPERATION_NAME: semconv.ATTR_GEN_AI_OPERATION_NAME,
      PROVIDER_NAME: semconv.ATTR_GEN_AI_PROVIDER_NAME,
      REQUEST_MODEL: semconv.ATTR_GEN_AI_REQUEST_MODEL,
      REQUEST_MAX_TOKENS: semconv.ATTR_GEN_AI_REQUEST_MAX_TOKENS,
      REQUEST_TEMPERATURE: semconv.ATTR_GEN_AI_REQUEST_TEMPERATURE,
      REQUEST_STREAM: semconv.ATTR_GEN_AI_REQUEST_STREAM,
      RESPONSE_FINISH_REASONS: semconv.ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
      RESPONSE_TIME_TO_FIRST_CHUNK: semconv.ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
      USAGE_INPUT_TOKENS: semconv.ATTR_GEN_AI_USAGE_INPUT_TOKENS,
      USAGE_OUTPUT_TOKENS: semconv.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
      USAGE_CACHE_READ_INPUT_TOKENS: semconv.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
      USAGE_CACHE_CREATION_INPUT_TOKENS: semconv.ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
      USAGE_REASONING_OUTPUT_TOKENS: semconv.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
    });
    expect(ERROR_TYPE).toBe(semconv.ATTR_ERROR_TYPE);
  });

  it('use the conventions provider names, and an endpoint name for compatible servers', () => {
    expect(providerName('anthropic', 'anthropic')).toBe(
      semconv.GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
    );
    expect(providerName('openai', 'openai')).toBe(semconv.GEN_AI_PROVIDER_NAME_VALUE_OPENAI);
    expect(providerName('google', 'google')).toBe(semconv.GEN_AI_PROVIDER_NAME_VALUE_GCP_GEMINI);
    expect(providerName('deepseek', 'deepseek')).toBe(semconv.GEN_AI_PROVIDER_NAME_VALUE_DEEPSEEK);
    // The conventions name none of these, so they keep their own name.
    expect(providerName('zai', 'zai')).toBe('zai');
    expect(providerName('xiaomi-mimo', 'xiaomi-mimo')).toBe('xiaomi-mimo');
    expect(providerName('openai-compatible', 'ollama')).toBe('ollama');
  });
});
