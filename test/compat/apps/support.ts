import type { CompatState } from '../state.ts';

/* Shared by the Open WebUI and LibreChat checks (ADR 0064). */

/** The data of each server-sent event in a body, parsed; `[DONE]` is left out. */
export function sseData(body: string): unknown[] {
  return body
    .split(/\r?\n\r?\n/)
    .flatMap((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim()),
    )
    .filter((data) => data !== '' && data !== '[DONE]')
    .map((data) => JSON.parse(data) as unknown);
}

/**
 * Sets the main workspace's cap, or removes it with null, as its instance admin: the products
 * under test hold that workspace's key, so this is how their requests meet a budget.
 */
export async function setWorkspaceCap(state: CompatState, limitMicroUsd: string | null) {
  const res = await fetch(
    `${state.baseUrl}/api/workspaces/${state.workspaceId}/budgets/workspace`,
    {
      method: limitMicroUsd === null ? 'DELETE' : 'PUT',
      headers: {
        origin: state.baseUrl,
        cookie: state.adminCookie,
        ...(limitMicroUsd === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(limitMicroUsd === null
        ? {}
        : { body: JSON.stringify({ limitMicroUsd, period: 'monthly' }) }),
    },
  );
  // Removing a cap that is not there is fine: the workspace is uncapped either way.
  if (!res.ok && !(limitMicroUsd === null && res.status === 404)) {
    throw new Error(`setting the cap failed: ${res.status}`);
  }
}

export const CODE = 'Why does this fail?\n```js\nconst a = 1;\na = 2;\n```';
