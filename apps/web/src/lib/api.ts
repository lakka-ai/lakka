import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';
import { apiErrorBody } from '@lakka/contracts';

/*
 * The only way the web app reaches the api: over HTTP (ADR 0006). In the browser, requests are
 * relative, so they go to our own origin and carry the session cookie. During server-side
 * rendering, requests go to the api's internal address and forward only the incoming Cookie.
 */

const transport = createIsomorphicFn()
  .server(() => {
    const cookie = getRequestHeader('cookie');
    return {
      base: process.env['LAKKA_API_INTERNAL_URL'] ?? 'http://127.0.0.1:3000',
      headers: cookie === undefined ? {} : { cookie },
    };
  })
  .client(() => ({ base: '', headers: {} }));

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** What a few errors carry to be acted on, such as the origin to allow. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The origin an mcp_origin_not_allowed error names, or null for any other error (NF-S4). */
export function notAllowedOrigin(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'mcp_origin_not_allowed') return null;
  const origin = error.details['origin'];
  return typeof origin === 'string' ? origin : null;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const { base, headers } = transport();
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...headers,
      ...options.headers,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 204) return undefined as T;
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorBody.safeParse(json);
    const code = parsed.success ? parsed.data.error.code : 'unknown';
    throw new ApiError(
      response.status,
      code,
      parsed.success ? parsed.data.error.message : response.statusText,
      parsed.success ? (parsed.data.error.details ?? {}) : {},
    );
  }
  return json as T;
}
