import { APICallError } from '@ai-sdk/provider';
import { EmptyStreamError, FirstChunkTimeoutError } from './commit.ts';
import { ProviderStreamError } from './model-call.ts';

/*
 * What a failed attempt means for the next one (tech spec, Error classification; ADR 0040).
 * The provider's own error text is only matched against, never logged or shown: it can echo
 * request content.
 */

export type FailureKind =
  /** 429. Retry after the provider's delay, or fail over if that is too long. */
  | 'rate_limited'
  /** 5xx, 529, an empty stream, a dropped connection. Retry with backoff, then fail over. */
  | 'overloaded'
  /** No first chunk in time, or the stream went quiet. Retry, then fail over. */
  | 'timeout'
  /** The input does not fit this model. Fail over to one with a larger window. */
  | 'context_overflow'
  /** The provider does not know this model. Fail over. */
  | 'model_not_found'
  /** 401/403: the credential is wrong. Stop; an admin has to fix it. */
  | 'auth'
  /** The provider's content filter refused. Stop; never retry, never fail over. */
  | 'content_filter'
  /** Any other 4xx: the request is malformed for this provider. Stop. */
  | 'bad_request';

export interface Failure {
  kind: FailureKind;
  /** For rate limits: how long the provider asked us to wait, if it said. */
  retryAfterMs: number | null;
  /** The provider's HTTP status, if it answered with one. */
  httpStatus: number | null;
  /**
   * True when the provider accepted the request and may bill for it. HTTP error responses are
   * not billed; anything that fails after the request was accepted may be.
   */
  mayHaveBilled: boolean;
}

const CONTEXT_OVERFLOW =
  /context_length_exceeded|context window|maximum context length|prompt is too long|exceeds the maximum number of tokens|input is too long/i;
const CONTENT_FILTER = /content[_ ]?(policy|filter)|responsible ?ai|safety system/i;
const MODEL_NOT_FOUND =
  /model_not_found|not[_ ]found_error|does not exist|unknown model|is not found/i;

/** Seconds, an HTTP date, or retry-after-ms, as providers send them. */
export function parseRetryAfter(
  headers: Record<string, string> | undefined,
  now: number = Date.now(),
): number | null {
  if (headers === undefined) return null;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const ms = lower['retry-after-ms'];
  if (ms !== undefined && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.ceil(Number(ms));
  const value = lower['retry-after']?.trim();
  if (value === undefined || value === '') return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function fromStatus(error: APICallError): Failure {
  const status = error.statusCode ?? 0;
  const body = error.responseBody ?? '';
  const base = { retryAfterMs: null, httpStatus: status, mayHaveBilled: false };
  if (status === 429)
    return { ...base, kind: 'rate_limited', retryAfterMs: parseRetryAfter(error.responseHeaders) };
  if (status === 401 || status === 403) return { ...base, kind: 'auth' };
  if (status === 408) return { ...base, kind: 'timeout' };
  if (status >= 500) return { ...base, kind: 'overloaded' };
  if (CONTEXT_OVERFLOW.test(body) || status === 413) return { ...base, kind: 'context_overflow' };
  if (CONTENT_FILTER.test(body)) return { ...base, kind: 'content_filter' };
  if (status === 404 || MODEL_NOT_FOUND.test(body)) return { ...base, kind: 'model_not_found' };
  return { ...base, kind: 'bad_request' };
}

export function classifyFailure(error: unknown): Failure {
  // Only a 4xx or 5xx is the provider answering "no". The SDK also reports a stream that broke
  // after a 200 as an API error with status 200; that is a dropped connection, handled below.
  if (APICallError.isInstance(error) && error.statusCode !== undefined && error.statusCode >= 400) {
    return fromStatus(error);
  }
  if (error instanceof FirstChunkTimeoutError || error instanceof IdleTimeoutError) {
    return { kind: 'timeout', retryAfterMs: null, httpStatus: null, mayHaveBilled: true };
  }
  if (error instanceof EmptyStreamError) {
    return { kind: 'overloaded', retryAfterMs: null, httpStatus: null, mayHaveBilled: true };
  }
  if (error instanceof ProviderStreamError) {
    // An error event inside an accepted stream, for example Anthropic's overloaded_error.
    const text = JSON.stringify(error.cause ?? '');
    if (CONTEXT_OVERFLOW.test(text)) {
      return {
        kind: 'context_overflow',
        retryAfterMs: null,
        httpStatus: null,
        mayHaveBilled: true,
      };
    }
    if (CONTENT_FILTER.test(text)) {
      return { kind: 'content_filter', retryAfterMs: null, httpStatus: null, mayHaveBilled: true };
    }
    return { kind: 'overloaded', retryAfterMs: null, httpStatus: null, mayHaveBilled: true };
  }
  // A network failure (connection refused or reset, DNS, TLS) or anything unexpected. The
  // request may have reached the provider, so count it as possibly billed.
  return { kind: 'overloaded', retryAfterMs: null, httpStatus: null, mayHaveBilled: true };
}

/** A committed stream that produced nothing for too long (tech spec, Streaming transport). */
export class IdleTimeoutError extends Error {
  override readonly name = 'IdleTimeoutError';
}
