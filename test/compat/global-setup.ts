import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createUser } from '../stack.ts';
import { STATE_FILE } from './state.ts';
import type { CompatState } from './state.ts';

/*
 * Prepares the running stack for the compatibility suite (AC 14, AC 15, API-6, ADR 0064): an
 * instance admin, a workspace whose models are the fake provider's (docker/compose.e2e.yaml), a
 * code route, a key, and a second workspace whose cap refuses everything. Clients under test get
 * only the base URL and a key, as a customer would give them.
 *
 * The state is written to test/compat/.state.json for the steps that are not TypeScript: the
 * Python SDK check, the Open WebUI and LibreChat checks, and CI's shutdown check.
 */

const BASE = process.env['LAKKA_COMPAT_URL'] ?? 'http://127.0.0.1:8080';
/** The fake provider as the api container reaches it. */
const FAKE_PROVIDER_URL = 'http://fake-provider:4010/openai/v1';

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

export default async function globalSetup(): Promise<void> {
  const tag = randomBytes(3).toString('hex');
  const email = `compat-${tag}@example.com`;
  const password = `compat password ${tag}`;
  createUser(email, 'Compat Admin', password, true);
  const cookie = await signIn(email, password);

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  const provider = `compat-${tag}`;
  await call('POST', '/api/providers', {
    kind: 'openai-compatible',
    name: provider,
    baseUrl: FAKE_PROVIDER_URL,
  });
  const model = async (scenario: string, label: string, vision = false) =>
    (
      await call<{ model: { id: string } }>('POST', '/api/models/custom', {
        provider,
        model: `${scenario}~${label}-${tag}`,
        contextWindow: 100_000,
        maxOutputTokens: 4096,
        capabilities: {
          vision,
          pdf: false,
          tools: false,
          structuredOutput: false,
          promptCaching: false,
          reasoning: false,
        },
        prices: {
          inputMicroUsdPerMtok: 1_000_000,
          outputMicroUsdPerMtok: 2_000_000,
          cacheReadMicroUsdPerMtok: null,
          cacheWriteMicroUsdPerMtok: null,
        },
      })
    ).model.id;
  const models = {
    ok: await model('ok', 'general'),
    slow: await model('slow', 'slow'),
    idle: await model('idle-after-1', 'idle'),
    drop: await model('drop-after-2', 'drop'),
    vision: await model('ok', 'vision', true),
    coder: await model('ok', 'coder'),
  };

  const workspace = async (name: string) =>
    (
      await call<{ workspace: { id: string } }>('POST', '/api/workspaces', {
        name,
        slug: `${name.toLowerCase()}-${tag}`,
      })
    ).workspace.id;
  const key = async (workspaceId: string) =>
    (
      await call<{ secret: string }>('POST', `/api/workspaces/${workspaceId}/keys`, {
        name: 'Compatibility',
      })
    ).secret;

  const main = await workspace('Compat');
  await call('POST', `/api/workspaces/${main}/routes`, {
    name: 'code',
    model: models.coder,
    signals: ['code_fence'],
  });
  await call('PUT', `/api/workspaces/${main}/routing/settings`, {
    routingEnabled: true,
    defaultModel: models.ok,
    pinnedModel: null,
  });

  // Every request here is over the cap: one micro-dollar, and no cheaper model to fall back to.
  const poor = await workspace('Poor');
  await call('PUT', `/api/workspaces/${poor}/routing/settings`, {
    routingEnabled: false,
    defaultModel: models.ok,
    pinnedModel: null,
  });
  await call('PUT', `/api/workspaces/${poor}/budgets/workspace`, {
    limitMicroUsd: '1',
    period: 'monthly',
  });

  const state: CompatState = {
    baseUrl: BASE,
    apiBase: `${BASE}/v1`,
    key: await key(main),
    poorKey: await key(poor),
    workspaceId: main,
    adminCookie: cookie,
    route: 'code',
    models,
  };
  mkdirSync('test/compat', { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
