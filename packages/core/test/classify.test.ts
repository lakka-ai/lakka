import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { classifyFailure, IdleTimeoutError, parseRetryAfter } from '../src/gateway/classify.ts';
import { EmptyStreamError, FirstChunkTimeoutError } from '../src/gateway/commit.ts';
import { ProviderStreamError } from '../src/gateway/model-call.ts';

const http = (
  statusCode: number,
  responseBody = '',
  responseHeaders: Record<string, string> = {},
) =>
  new APICallError({
    message: 'x',
    url: 'https://p',
    requestBodyValues: {},
    statusCode,
    responseBody,
    responseHeaders,
  });

describe('failure classification (tech spec, Error classification)', () => {
  it('maps HTTP statuses to what the next attempt should do; HTTP errors are not billed', () => {
    expect(classifyFailure(http(429, '', { 'retry-after': '3' }))).toEqual({
      kind: 'rate_limited',
      retryAfterMs: 3000,
      httpStatus: 429,
      mayHaveBilled: false,
    });
    for (const status of [500, 502, 503, 504, 529])
      expect(classifyFailure(http(status)).kind).toBe('overloaded');
    expect(classifyFailure(http(401)).kind).toBe('auth');
    expect(classifyFailure(http(403)).kind).toBe('auth');
    expect(classifyFailure(http(408)).kind).toBe('timeout');
    expect(classifyFailure(http(404)).kind).toBe('model_not_found');
    expect(
      classifyFailure(http(400, '{"error":{"message":"temperature out of range"}}')).kind,
    ).toBe('bad_request');
  });

  it('CH-7: a provider account out of credit is billing, whatever status it comes with', () => {
    expect(classifyFailure(http(402))).toEqual({
      kind: 'billing',
      retryAfterMs: null,
      httpStatus: 402,
      mayHaveBilled: false,
    });
    // OpenAI: a 429 that waiting will not fix.
    expect(
      classifyFailure(
        http(
          429,
          '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
          { 'retry-after': '1' },
        ),
      ).kind,
    ).toBe('billing');
    // Anthropic: a 400.
    expect(
      classifyFailure(
        http(
          400,
          '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
        ),
      ).kind,
    ).toBe('billing');
    // A 402 is billing even when its text looks like something else.
    expect(classifyFailure(http(402, '{"error":{"code":"model_not_found"}}')).kind).toBe('billing');
    // An overloaded provider is never mistaken for an empty account.
    expect(classifyFailure(http(503, '{"error":{"type":"insufficient_quota"}}')).kind).toBe(
      'overloaded',
    );
  });

  it('recognizes each provider wording for an input that is too long', () => {
    const bodies = [
      '{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
      '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
      '{"error":{"code":400,"message":"The input token count (2000000) exceeds the maximum number of tokens allowed (1048576)."}}',
    ];
    for (const body of bodies)
      expect(classifyFailure(http(400, body)).kind).toBe('context_overflow');
  });

  it('recognizes content filter refusals, which must never be retried', () => {
    expect(classifyFailure(http(400, '{"error":{"code":"content_policy_violation"}}')).kind).toBe(
      'content_filter',
    );
    expect(classifyFailure(http(400, '{"error":{"code":"content_filter"}}')).kind).toBe(
      'content_filter',
    );
  });

  it('treats a stream that broke after a 200 as a dropped connection the provider may bill', () => {
    const broken = new APICallError({
      message: 'Failed to process successful response',
      url: 'https://p',
      requestBodyValues: {},
      statusCode: 200,
      isRetryable: true,
    });
    expect(classifyFailure(broken)).toMatchObject({ kind: 'overloaded', mayHaveBilled: true });
    expect(classifyFailure(new TypeError('fetch failed'))).toMatchObject({
      kind: 'overloaded',
      mayHaveBilled: true,
    });
  });

  it('treats timeouts and empty or erroring streams as retryable and possibly billed', () => {
    expect(classifyFailure(new FirstChunkTimeoutError('t'))).toMatchObject({
      kind: 'timeout',
      mayHaveBilled: true,
    });
    expect(classifyFailure(new IdleTimeoutError('t'))).toMatchObject({
      kind: 'timeout',
      mayHaveBilled: true,
    });
    expect(classifyFailure(new EmptyStreamError('e')).kind).toBe('overloaded');
    const overloaded = new ProviderStreamError('x', {
      cause: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(classifyFailure(overloaded)).toMatchObject({ kind: 'overloaded', mayHaveBilled: true });
  });

  it('reads Retry-After as seconds, milliseconds or an HTTP date', () => {
    expect(parseRetryAfter({ 'retry-after': '2' })).toBe(2000);
    expect(parseRetryAfter({ 'retry-after': '1.5' })).toBe(1500);
    expect(parseRetryAfter({ 'Retry-After-Ms': '250' })).toBe(250);
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(parseRetryAfter({ 'retry-after': 'Fri, 25 Sep 2026 12:00:10 GMT' }, now)).toBe(10_000);
    expect(parseRetryAfter({ 'retry-after': 'soon' })).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});
