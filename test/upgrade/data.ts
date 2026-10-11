import { readFileSync, writeFileSync } from 'node:fs';

/*
 * The data the upgrade test (NF-O6, ADR 0075 H7, ADR 0086) puts into the earlier version and
 * checks for after upgrading: an instance admin, a workspace with a cap, a provider and a model,
 * a key, and a request made with it, so there is usage, a trace and spend. And an MCP server,
 * whose origin the upgrade lists when it brings in the allowlist (NF-S4, ADR 0117), so the
 * server keeps working. And a route with examples and a description, whose centroid the upgrade
 * rebuilds with the description among the examples when the earlier version predates that
 * (RT-12, ADR 0125).
 *
 *   node test/upgrade/data.ts fill <base url> <state file>
 *   node test/upgrade/data.ts verify <base url> <state file>
 *
 * The admin account itself is made with the earlier version's operator command, before `fill`.
 * Only this suite's test values are used; the state file stays in the job's temporary directory.
 */

interface State {
  email: string;
  password: string;
  workspaceId: string;
  model: string;
  key: string;
  requestId: string;
  mcpServerId: string;
  /** Whether the earlier version already had the allowlist, so its admin listed the origin. */
  mcpOriginListedBefore: boolean;
  routeId: string;
  /** What the earlier version compiled the route from, or null if it had not. */
  routeSourceBefore: string | null;
}

interface RoutingView {
  routes: { id: string; compiled: { source?: string } | null }[];
}

/** The plain MCP server of the acceptance stack (docker/compose.e2e.yaml). */
const MCP_URL = 'http://fake-provider:4011/mcp';
const MCP_ORIGIN = 'http://fake-provider:4011';

const [mode, base, stateFile] = process.argv.slice(2);
if ((mode !== 'fill' && mode !== 'verify') || base === undefined || stateFile === undefined) {
  process.stderr.write('usage: data.ts fill|verify <base url> <state file>\n');
  process.exit(64);
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`upgrade: ${what}`);
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base ?? '' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith('lakka.session_token='));
  check(res.ok && cookie !== undefined, `sign-in answered ${res.status}`);
  return cookie ?? '';
}

async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin: base ?? '',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  check(res.ok, `${method} ${path} answered ${res.status}`);
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

async function complete(key: string, model: string): Promise<string> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  });
  await res.text();
  check(res.status === 200, `a completion with the key answered ${res.status}`);
  return res.headers.get('x-lakka-request-id') ?? '';
}

if (mode === 'fill') {
  const email = process.env['UPGRADE_EMAIL'] ?? '';
  const password = process.env['UPGRADE_PASSWORD'] ?? '';
  const cookie = await signIn(email, password);
  const { workspace } = (await call(cookie, 'POST', '/api/workspaces', {
    name: 'Upgrade',
    slug: 'upgrade',
  })) as { workspace: { id: string } };
  await call(cookie, 'POST', '/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: 'http://fake-provider:4010/openai/v1',
  });
  const { model } = (await call(cookie, 'POST', '/api/models/custom', {
    provider: 'fake',
    model: 'ok~upgrade',
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
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
  })) as { model: { id: string } };
  await call(cookie, 'PUT', `/api/workspaces/${workspace.id}/budgets/workspace`, {
    limitMicroUsd: '5000000',
    period: 'monthly',
  });
  const { secret } = (await call(cookie, 'POST', `/api/workspaces/${workspace.id}/keys`, {
    name: 'Upgrade key',
  })) as { secret: string };
  const requestId = await complete(secret, model.id);
  // A version with the allowlist needs the origin listed first; one without has no such route.
  const listing = await fetch(`${base}/api/admin/mcp-origins`, {
    method: 'POST',
    headers: { cookie, origin: base ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ origin: MCP_ORIGIN }),
  });
  await listing.text();
  check(listing.ok || listing.status === 404, `listing the MCP origin answered ${listing.status}`);
  const { server } = (await call(cookie, 'POST', `/api/workspaces/${workspace.id}/mcp-servers`, {
    transport: 'streamable_http',
    name: 'upgrade-tools',
    url: MCP_URL,
    authMode: 'none',
  })) as { server: { id: string } };
  const { route } = (await call(cookie, 'POST', `/api/workspaces/${workspace.id}/routes`, {
    name: 'legal',
    description: 'Contracts, NDAs, privacy law and other legal questions.',
    model: model.id,
    examples: [
      'Is the non-compete clause in my employment contract enforceable?',
      'What should a mutual NDA with a supplier cover?',
    ],
  })) as { route: { id: string } };
  const before = (await call(
    cookie,
    'GET',
    `/api/workspaces/${workspace.id}/routing`,
  )) as unknown as RoutingView;
  const state: State = {
    email,
    password,
    workspaceId: workspace.id,
    model: model.id,
    key: secret,
    requestId,
    mcpServerId: server.id,
    mcpOriginListedBefore: listing.ok,
    routeId: route.id,
    routeSourceBefore: before.routes.find((r) => r.id === route.id)?.compiled?.source ?? null,
  };
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  process.stdout.write('upgrade: filled the earlier version\n');
} else {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as State;
  // The account, its password and the secrets that sign sessions survived.
  const cookie = await signIn(state.email, state.password);
  const { workspaces } = (await call(cookie, 'GET', '/api/workspaces')) as {
    workspaces: { id: string }[];
  };
  check(
    workspaces.some((w) => w.id === state.workspaceId),
    'the workspace is gone',
  );
  const budgets = (await call(cookie, 'GET', `/api/workspaces/${state.workspaceId}/budgets`)) as {
    workspace: { limitMicroUsd: string; spentMicroUsd: string } | null;
  };
  check(budgets.workspace?.limitMicroUsd === '5000000', 'the cap is gone');
  check(BigInt(budgets.workspace?.spentMicroUsd ?? '0') > 0n, 'the spend against it is gone');
  const spend = (await call(cookie, 'GET', `/api/workspaces/${state.workspaceId}/spend`)) as {
    requests: number;
  };
  check(spend.requests >= 1, 'the usage is gone');
  const requests = (await call(cookie, 'GET', `/api/workspaces/${state.workspaceId}/requests`)) as {
    requests: { requestId: string }[];
  };
  check(
    requests.requests.some((r) => r.requestId === state.requestId),
    "the earlier request's trace is gone",
  );
  // The key, the provider and the model still work together, and the cap still counts.
  await complete(state.key, state.model);
  // The MCP server's origin is listed, by the upgrade if the earlier version had no list, and
  // the server is still reached.
  const { allowlist } = (await call(cookie, 'GET', '/api/admin/mcp-origins')) as {
    allowlist: { origins: { origin: string; source: string }[] };
  };
  const entry = allowlist.origins.find((o) => o.origin === MCP_ORIGIN);
  check(entry !== undefined, "the MCP server's origin is not on the allowlist");
  check(
    state.mcpOriginListedBefore || entry?.source === 'upgrade',
    "the MCP server's origin was not listed by the upgrade",
  );
  const tested = (await call(
    cookie,
    'POST',
    `/api/workspaces/${state.workspaceId}/mcp-servers/${state.mcpServerId}/test`,
    {},
  )) as { status: string };
  check(tested.status === 'ok', `the MCP server tested ${tested.status} after upgrading`);
  // A trained route with a description, compiled from its examples alone by a version before
  // ADR 0125, is stale now. Try a phrase rebuilds stale routes before it scores.
  const tried = (await call(cookie, 'POST', `/api/workspaces/${state.workspaceId}/routing/try`, {
    text: 'Review the indemnification clause in this vendor contract',
  })) as { status: string; scores: { route: string; source: string }[] };
  check(tried.status === 'scored', `Try a phrase answered ${tried.status} after upgrading`);
  check(
    tried.scores.find((x) => x.route === 'legal')?.source === 'examples_and_description',
    'Try a phrase did not score the route from its examples and description',
  );
  const after = (await call(
    cookie,
    'GET',
    `/api/workspaces/${state.workspaceId}/routing`,
  )) as unknown as RoutingView;
  const source = after.routes.find((r) => r.id === state.routeId)?.compiled?.source;
  check(
    source === 'examples_and_description',
    `the route compiled ${state.routeSourceBefore ?? 'nothing'} before upgrading is compiled from ${source ?? 'nothing'} now`,
  );
  process.stdout.write(
    `upgrade: the route compiled from ${state.routeSourceBefore ?? 'nothing'} before is compiled from ${source} now\n`,
  );
  process.stdout.write('upgrade: the data survived, and the instance still works\n');
}
