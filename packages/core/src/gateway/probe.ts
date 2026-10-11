import type { ProviderTestStatus } from '@lakka/contracts';
import { DEFAULT_BASE_URLS } from './providers.ts';
import type { ProviderConnection } from './providers.ts';

/*
 * Tests a credential by listing the provider's models (PR-1, D4 of the M2 plan). Listing models
 * is free on every provider we support, so a test never spends money. Only the HTTP status is
 * used; the body can contain anything and is discarded unread. Redirects are not followed, so a
 * key is only ever sent to the address the admin configured.
 */

export interface ProbeResult {
  status: ProviderTestStatus;
  httpStatus: number | null;
}

function request(connection: ProviderConnection): { url: string; headers: Record<string, string> } {
  const key = connection.apiKey;
  switch (connection.kind) {
    case 'anthropic':
      return {
        url: `${connection.baseURL ?? DEFAULT_BASE_URLS.anthropic}/models?limit=1`,
        headers: { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' },
      };
    case 'openai':
      return {
        url: `${connection.baseURL ?? DEFAULT_BASE_URLS.openai}/models`,
        headers: { authorization: `Bearer ${key ?? ''}` },
      };
    case 'google':
      return {
        url: `${connection.baseURL ?? DEFAULT_BASE_URLS.google}/models?pageSize=1`,
        headers: { 'x-goog-api-key': key ?? '' },
      };
    case 'deepseek':
    case 'moonshot':
    case 'qwencloud':
    case 'xiaomi-mimo':
    case 'zai':
      return {
        url: `${connection.baseURL ?? DEFAULT_BASE_URLS[connection.kind]}/models`,
        headers: { authorization: `Bearer ${key ?? ''}` },
      };
    case 'openai-compatible':
      return {
        url: `${connection.baseURL ?? ''}/models`,
        headers: key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` },
      };
  }
}

export async function probeProvider(
  connection: ProviderConnection,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const { url, headers } = request(connection);
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    // DNS, refused connection, TLS failure or timeout. The error text is not kept: it can
    // include the address, which is fine, but nothing here needs it.
    return { status: 'unreachable', httpStatus: null };
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status >= 200 && response.status < 300) {
    return { status: 'ok', httpStatus: response.status };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: 'auth_failed', httpStatus: response.status };
  }
  return { status: 'error', httpStatus: response.status };
}
