import type { ModelResponse } from '@lakka/core';

/** Where the request's routing and budget decisions are reported (G3). */
export function decisionHeaders(
  requestId: string,
  response: Pick<ModelResponse, 'resolution' | 'routeName' | 'fallback'> & {
    stream: { model: { id: string } };
  },
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-lakka-request-id': requestId,
    'x-lakka-model': response.stream.model.id,
    'x-lakka-routing-rule': response.resolution.rule,
  };
  if (response.routeName !== null) headers['x-lakka-route'] = response.routeName;
  if (response.resolution.reason !== null) {
    headers['x-lakka-routing-reason'] = response.resolution.reason;
  }
  if (response.resolution.confidence !== null) {
    // How sure the classifier was, 0 to 1 (CH-2): "Confidence 92%" in chat.
    headers['x-lakka-routing-confidence'] = response.resolution.confidence.toFixed(2);
  }
  if (response.fallback !== null) {
    headers['x-lakka-fallback-from'] = response.fallback.from;
    headers['x-lakka-fallback-scope'] = response.fallback.scope;
  }
  return headers;
}
