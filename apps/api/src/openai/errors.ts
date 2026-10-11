import {
  BudgetExceededError,
  LakkaError,
  RateLimitedError,
  UpstreamUnavailableError,
} from '@lakka/contracts';

/*
 * Errors in the shape OpenAI clients expect: {error: {message, type, param, code}} (API-5,
 * CH-7, ADR 0059). A budget refusal is its own type and a 402, so a client can tell it from a
 * provider's failure, and the official SDKs do not retry it the way they retry a 429 (G2).
 * Provider trouble becomes a message the caller can act on, never a raw upstream body.
 */

export interface OpenAiErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
  /** What chat needs to say it plainly (CH-4, CH-7); OpenAI clients ignore it. */
  lakka?: Record<string, unknown>;
}

/**
 * Details some errors carry for the person who sent the request: which cap refused and by how
 * much, which provider did not answer and how long it asked to wait, or how long their own rate
 * limit asks them to wait (BG-12). Amounts are their own headroom, which /budgets/remaining
 * already shows them.
 */
function details(error: LakkaError): Record<string, unknown> | undefined {
  if (error instanceof BudgetExceededError) {
    return {
      scope: error.scope,
      remaining_micro_usd: String(error.remainingMicroUsd),
      required_micro_usd: error.requiredMicroUsd === null ? null : String(error.requiredMicroUsd),
    };
  }
  if (error instanceof RateLimitedError) {
    return { retry_after_seconds: error.retryAfterSeconds };
  }
  if (error instanceof UpstreamUnavailableError && error.provider !== null) {
    return {
      provider: error.provider,
      rate_limited: error.rateLimited,
      retry_after_seconds: error.retryAfterSeconds,
    };
  }
  return undefined;
}

const MAPPING: Readonly<Record<string, { status: number; type: string; code?: string }>> = {
  invalid_request: { status: 400, type: 'invalid_request_error' },
  unauthenticated: { status: 401, type: 'invalid_request_error', code: 'invalid_api_key' },
  forbidden: { status: 403, type: 'permission_error' },
  access_revoked: { status: 403, type: 'permission_error' },
  // A missing workspace or conversation; an unknown model or route is unknown_model.
  not_found: { status: 404, type: 'invalid_request_error' },
  unknown_model: { status: 404, type: 'invalid_request_error', code: 'model_not_found' },
  budget_exceeded: { status: 402, type: 'budget_exceeded' },
  budget_unavailable: { status: 503, type: 'server_error' },
  rate_limited: { status: 429, type: 'rate_limit_error' },
  no_model: { status: 422, type: 'invalid_request_error' },
  unsupported_input: { status: 422, type: 'invalid_request_error' },
  provider_not_configured: { status: 422, type: 'invalid_request_error' },
  context_too_long: { status: 400, type: 'invalid_request_error', code: 'context_length_exceeded' },
  output_too_long: { status: 400, type: 'invalid_request_error' },
  content_filtered: { status: 400, type: 'invalid_request_error', code: 'content_filter' },
  provider_rejected_request: { status: 400, type: 'invalid_request_error' },
  provider_auth_failed: { status: 502, type: 'server_error' },
  upstream_unavailable: { status: 502, type: 'server_error' },
  stream_interrupted: { status: 502, type: 'server_error' },
};

/** The codes given their own status, for the test that each is a code we really raise. */
export const MAPPED_CODES: readonly string[] = Object.keys(MAPPING);

/**
 * How long a refused caller should wait: Retry-After, which every HTTP client knows, and
 * retry-after-ms, which the official OpenAI SDKs read first when they retry a 429 on their own.
 */
function headersOf(error: LakkaError): Record<string, string> | undefined {
  if (!(error instanceof RateLimitedError)) return undefined;
  return {
    'retry-after': String(error.retryAfterSeconds),
    'retry-after-ms': String(error.retryAfterSeconds * 1000),
  };
}

export function toOpenAiError(error: unknown): {
  status: number;
  body: OpenAiErrorBody;
  headers?: Record<string, string>;
} {
  if (error instanceof LakkaError) {
    const mapped = MAPPING[error.code] ?? { status: 500, type: 'server_error' };
    const param = (error as { param?: unknown }).param;
    const lakka = details(error);
    const headers = headersOf(error);
    return {
      status: mapped.status,
      ...(headers === undefined ? {} : { headers }),
      body: {
        error: {
          message: error.message,
          type: mapped.type,
          param: typeof param === 'string' ? param : null,
          code: mapped.code ?? error.code,
        },
        ...(lakka === undefined ? {} : { lakka }),
      },
    };
  }
  // Fastify's own errors (a body that is not JSON, one that is too large) carry a 4xx status.
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return {
      status,
      body: {
        error: {
          message: status === 413 ? 'The request is too large.' : 'The request could not be read.',
          type: 'invalid_request_error',
          param: null,
          code: status === 413 ? 'request_too_large' : 'invalid_request',
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        message: 'Something went wrong on our side. Try again.',
        type: 'server_error',
        param: null,
        code: 'internal_error',
      },
    },
  };
}
