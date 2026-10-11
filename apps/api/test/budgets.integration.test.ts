import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodStart } from '@lakka/contracts';
import type {
  BudgetStatusView,
  BudgetView,
  IssuedKey,
  RemainingBudgetView,
  WorkspaceBudgetsView,
  WorkspaceView,
} from '@lakka/contracts';
import { budgetStatus, createLogger, policySnapshots, valkeyEvents } from '@lakka/core';
import { insertUsage } from '@lakka/db';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Budget management (BG-1, BG-9, Q1, ADR 0049) against real Postgres: who may set which cap, the
 * rules for a key's owner, isolation between workspaces, and limits reaching request snapshots.
 */

let t: TestApp;
let root: SignedInUser;
let wsAdmin: SignedInUser;
let member: SignedInUser;
let colleague: SignedInUser;
let outsider: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let memberKey: IssuedKey;

const monthly = (dollars: number) => ({
  limitMicroUsd: String(dollars * 1_000_000),
  period: 'monthly' as const,
});

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function setRole(ws: WorkspaceView, user: SignedInUser, role: 'admin' | 'member') {
  const res = await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role,
  });
  if (res.statusCode !== 200) throw new Error(res.body);
}

function bearer(secret: string) {
  const headers = { authorization: `Bearer ${secret}` };
  return {
    get: (url: string) => t.app.inject({ method: 'GET', url, headers }),
    put: (url: string, payload: object) => t.app.inject({ method: 'PUT', url, headers, payload }),
  };
}

const list = async (who: SignedInUser, ws = alpha) =>
  (await as(t, who).get(`/api/workspaces/${ws.id}/budgets`)).json() as WorkspaceBudgetsView;

const keyPath = (key: IssuedKey, ws = alpha) =>
  `/api/workspaces/${ws.id}/budgets/keys/${key.key.id}`;
const memberPath = (user: SignedInUser, ws = alpha) =>
  `/api/workspaces/${ws.id}/budgets/members/${user.principal.id}`;

async function versions(): Promise<Record<string, number>> {
  const { rows } = await t.pool.query<{ id: string; policy_version: number }>(
    'select id, policy_version from workspaces where id = any($1)',
    [[alpha.id, bravo.id]],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.policy_version]));
}

beforeAll(async () => {
  t = await createTestApp();
  [root, wsAdmin, member, colleague, outsider] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Colleague'),
    signedInUser(t, 'Outsider'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  await setRole(alpha, wsAdmin, 'admin');
  await setRole(alpha, member, 'member');
  await setRole(alpha, colleague, 'member');
  await setRole(bravo, outsider, 'admin');
  memberKey = (
    await as(t, member).post(`/api/workspaces/${alpha.id}/keys`, { name: 'CI' })
  ).json() as IssuedKey;
});

afterAll(async () => {
  await t.close();
});

describe('the instance and workspace caps (BG-1, Q1)', () => {
  it('BG-1: instance admins set, replace and remove the instance cap; nobody else can', async () => {
    const first = await as(t, root).put('/api/budgets/instance', monthly(1000));
    expect(first.statusCode).toBe(200);
    const created = (first.json() as { budget: BudgetView }).budget;
    expect(created).toMatchObject({
      scope: 'instance',
      workspaceId: null,
      limitMicroUsd: '1000000000',
      period: 'monthly',
      spentMicroUsd: '0',
    });
    const replaced = (
      (
        await as(t, root).put('/api/budgets/instance', { limitMicroUsd: '5', period: 'none' })
      ).json() as {
        budget: BudgetView;
      }
    ).budget;
    expect(replaced).toMatchObject({ id: created.id, limitMicroUsd: '5', periodEnd: null });

    for (const who of [wsAdmin, member]) {
      expect((await as(t, who).get('/api/budgets/instance')).statusCode).toBe(403);
      expect((await as(t, who).put('/api/budgets/instance', monthly(1))).statusCode).toBe(403);
    }
    expect((await as(t, root).delete('/api/budgets/instance')).statusCode).toBe(204);
    expect((await as(t, root).delete('/api/budgets/instance')).statusCode).toBe(404);
    expect(
      ((await as(t, root).get('/api/budgets/instance')).json() as { budget: null }).budget,
    ).toBeNull();
  });

  it('BG-1: setting a cap many times at once leaves exactly one', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => as(t, root).put('/api/budgets/instance', monthly(i + 1))),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array.from({ length: 8 }, () => 200));
    const { rows } = await t.pool.query(
      "select count(*)::int as n from budgets where scope = 'instance'",
    );
    expect(rows[0]).toEqual({ n: 1 });
    await as(t, root).delete('/api/budgets/instance');
  });

  it('Q1: only instance admins set a workspace cap, so no workspace raises its own ceiling', async () => {
    const path = `/api/workspaces/${alpha.id}/budgets/workspace`;
    expect((await as(t, wsAdmin).put(path, monthly(100))).statusCode).toBe(403);
    expect((await as(t, member).put(path, monthly(100))).statusCode).toBe(403);
    // A non-member does not learn that the workspace exists.
    expect((await as(t, outsider).put(path, monthly(100))).statusCode).toBe(404);
    const res = await as(t, root).put(path, monthly(100));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { budget: BudgetView }).budget).toMatchObject({
      scope: 'workspace',
      workspaceId: alpha.id,
    });
    expect((await as(t, wsAdmin).delete(path)).statusCode).toBe(403);
    const missing = '/api/workspaces/00000000-0000-7000-8000-000000000000/budgets/workspace';
    expect((await as(t, root).put(missing, monthly(1))).statusCode).toBe(404);
  });
});

describe('member and key caps (BG-1, Q1)', () => {
  it('BG-1: a workspace admin caps a member; the target must be a member', async () => {
    expect((await as(t, wsAdmin).put(memberPath(member), monthly(10))).statusCode).toBe(200);
    expect((await as(t, wsAdmin).put(memberPath(outsider), monthly(10))).statusCode).toBe(404);
    expect((await as(t, member).put(memberPath(colleague), monthly(10))).statusCode).toBe(403);
    expect((await as(t, member).put(memberPath(member), monthly(1000))).statusCode).toBe(403);
    // Instance admins may too, without being members.
    expect((await as(t, root).put(memberPath(colleague), monthly(20))).statusCode).toBe(200);
  });

  it("Q1: a key's owner may lower an admin's cap on it, but not raise, re-period or remove it", async () => {
    expect((await as(t, wsAdmin).put(keyPath(memberKey), monthly(5))).statusCode).toBe(200);
    expect((await as(t, member).put(keyPath(memberKey), monthly(6))).statusCode).toBe(403);
    expect(
      (await as(t, member).put(keyPath(memberKey), { limitMicroUsd: '1000000', period: 'daily' }))
        .statusCode,
    ).toBe(403);
    expect((await as(t, member).delete(keyPath(memberKey))).statusCode).toBe(403);
    expect((await as(t, member).put(keyPath(memberKey), monthly(3))).statusCode).toBe(200);
    // The owner now set the cap, so they may raise or remove it.
    expect((await as(t, member).put(keyPath(memberKey), monthly(4))).statusCode).toBe(200);
    expect((await as(t, member).delete(keyPath(memberKey))).statusCode).toBe(204);
    expect((await as(t, member).put(keyPath(memberKey), monthly(2))).statusCode).toBe(200);
  });

  it("ID-5, NF-S2: nobody else's key, and never through a key itself", async () => {
    // Another member does not learn the key exists.
    expect((await as(t, colleague).put(keyPath(memberKey), monthly(1))).statusCode).toBe(404);
    const viaKey = bearer(memberKey.secret);
    expect((await viaKey.put(keyPath(memberKey), monthly(100))).statusCode).toBe(403);
    expect((await viaKey.get(`/api/workspaces/${alpha.id}/budgets`)).statusCode).toBe(403);
    expect((await viaKey.get('/api/budgets/instance')).statusCode).toBe(403);
  });

  it('validates bodies and targets', async () => {
    for (const body of [
      { limitMicroUsd: 5, period: 'monthly' },
      { limitMicroUsd: '-5', period: 'monthly' },
      { limitMicroUsd: '5', period: 'weekly' },
      { limitMicroUsd: '5', period: 'monthly', extra: true },
    ]) {
      expect((await as(t, root).put('/api/budgets/instance', body)).statusCode).toBe(400);
    }
    const unknownKey = `/api/workspaces/${alpha.id}/budgets/keys/00000000-0000-7000-8000-000000000000`;
    expect((await as(t, wsAdmin).put(unknownKey, monthly(1))).statusCode).toBe(404);
  });
});

describe('reading budgets (BG-1, BG-9, F5)', () => {
  it('BG-9: admins see every cap in the chain, with the current period and its spend', async () => {
    await as(t, root).put('/api/budgets/instance', monthly(1000));
    const now = new Date();
    const view = await list(wsAdmin);
    expect(view.instance).toMatchObject({ scope: 'instance', limitMicroUsd: '1000000000' });
    expect(view.workspace).toMatchObject({ scope: 'workspace', limitMicroUsd: '100000000' });
    expect(view.members.map((m) => m.name).toSorted()).toEqual(['Colleague', 'Member']);
    expect(view.keys).toEqual([
      expect.objectContaining({ name: 'CI', keyId: memberKey.key.id, limitMicroUsd: '2000000' }),
    ]);
    const memberCap = view.members.find((m) => m.name === 'Member');
    expect(memberCap?.periodStart).toBe(periodStart('monthly', now).toISOString());

    // Spend is read for the current period only.
    await t.pool.query(
      `insert into budget_spend (budget_id, period_start, spent_micro_usd)
       values ($1, $2, 1234567), ($1, '2020-01-01T00:00:00Z', 999)`,
      [memberCap?.id, periodStart('monthly', now)],
    );
    const after = await list(wsAdmin);
    expect(after.members.find((m) => m.name === 'Member')?.spentMicroUsd).toBe('1234567');
  });

  it('F5: a member sees only their own cap and their own keys', async () => {
    const colleagueKey = (
      await as(t, colleague).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Theirs' })
    ).json() as IssuedKey;
    await as(t, wsAdmin).put(keyPath(colleagueKey), monthly(1));
    const view = await list(member);
    expect(view.instance).toBeNull();
    expect(view.workspace).toBeNull();
    expect(view.members.map((m) => m.name)).toEqual(['Member']);
    expect(view.keys.map((k) => k.name)).toEqual(['CI']);
  });

  it('AC 16: other workspaces cannot read or change these budgets', async () => {
    expect((await as(t, outsider).get(`/api/workspaces/${alpha.id}/budgets`)).statusCode).toBe(404);
    expect((await as(t, outsider).put(memberPath(member), monthly(1000))).statusCode).toBe(404);
    // The instance cap is visible from every workspace; alpha's caps never are.
    const theirs = await list(outsider, bravo);
    expect(theirs.instance?.scope).toBe('instance');
    expect([theirs.workspace, ...theirs.members, ...theirs.keys]).toEqual([null]);
  });
});

describe('limits reach requests (ADR 0049)', () => {
  it("BG-1: a workspace cap bumps only that workspace's policy version; the instance cap bumps all", async () => {
    const before = await versions();
    await as(t, root).put(`/api/workspaces/${alpha.id}/budgets/workspace`, monthly(200));
    const afterWorkspace = await versions();
    expect(afterWorkspace[alpha.id]).toBe((before[alpha.id] ?? 0) + 1);
    expect(afterWorkspace[bravo.id]).toBe(before[bravo.id]);
    await as(t, root).put('/api/budgets/instance', monthly(2000));
    const afterInstance = await versions();
    expect(afterInstance[alpha.id]).toBe((afterWorkspace[alpha.id] ?? 0) + 1);
    expect(afterInstance[bravo.id]).toBe((afterWorkspace[bravo.id] ?? 0) + 1);
  });

  it('BG-1: the policy snapshot carries every cap that can apply in the workspace, and nothing else', async () => {
    const keys = (await list(wsAdmin)).keys;
    const keyPrincipal = (name: string) => keys.find((k) => k.name === name)?.principalId ?? '';
    const snapshot = await policySnapshots({ db: t.db }).get(alpha.id);
    const caps = Object.fromEntries(
      (snapshot?.budgets ?? []).map((b) => [
        `${b.scope}:${b.principalId ?? '-'}`,
        `${b.limitMicroUsd}/${b.period}`,
      ]),
    );
    expect(caps).toEqual({
      'instance:-': '2000000000/monthly',
      'workspace:-': '200000000/monthly',
      [`member:${member.principal.id}`]: '10000000/monthly',
      [`member:${colleague.principal.id}`]: '20000000/monthly',
      [`key:${keyPrincipal('CI')}`]: '2000000/monthly',
      [`key:${keyPrincipal('Theirs')}`]: '1000000/monthly',
    });
    const other = await policySnapshots({ db: t.db }).get(bravo.id);
    expect(other?.budgets.map((b) => b.scope)).toEqual(['instance']);
  });
});

const remaining = async (res: { statusCode: number; json: () => unknown }) => {
  expect(res.statusCode).toBe(200);
  return (res.json() as { remaining: unknown }).remaining;
};
const spend = async (budgetId: string | undefined, micro: number) => {
  await t.pool.query(
    `insert into budget_spend (budget_id, period_start, spent_micro_usd) values ($1, $2, $3)
     on conflict (budget_id, period_start) do update set spent_micro_usd = excluded.spent_micro_usd`,
    [budgetId, periodStart('monthly', new Date()), micro],
  );
};

describe('what is left to spend (CH-4, ADR 0061)', () => {
  it('CH-4: the least headroom among the caps a person counts against, and which cap it is', async () => {
    const charlie = await workspace('Charlie');
    await setRole(charlie, member, 'member');
    await setRole(charlie, colleague, 'member');
    const path = `/api/workspaces/${charlie.id}/budgets/remaining`;
    await as(t, root).delete('/api/budgets/instance');
    expect(await remaining(await as(t, member).get(path))).toBeNull();

    await as(t, root).put('/api/budgets/instance', monthly(1000));
    const workspaceCap = (
      (
        await as(t, root).put(`/api/workspaces/${charlie.id}/budgets/workspace`, monthly(50))
      ).json() as {
        budget: BudgetView;
      }
    ).budget;
    const memberCap = (
      (await as(t, root).put(memberPath(member, charlie), monthly(10))).json() as {
        budget: BudgetView;
      }
    ).budget;
    await spend(memberCap.id, 9_500_000);
    expect(await remaining(await as(t, member).get(path))).toEqual({
      remainingMicroUsd: '500000',
      scope: 'member',
      periodEnd: memberCap.periodEnd,
      // ADR 0092: every cap that applies, with its size and what is left, narrowest first.
      caps: [
        {
          scope: 'member',
          limitMicroUsd: '10000000',
          remainingMicroUsd: '500000',
          period: 'monthly',
          periodEnd: memberCap.periodEnd,
          lowAtPercentLeft: 20,
        },
        expect.objectContaining({
          scope: 'workspace',
          limitMicroUsd: '50000000',
          remainingMicroUsd: '50000000',
        }),
        expect.objectContaining({ scope: 'instance', limitMicroUsd: '1000000000' }),
      ],
    });
    // A colleague has no cap of their own: the workspace's headroom is theirs, and the member's
    // cap is not among theirs.
    const colleagues = (await remaining(await as(t, colleague).get(path))) as RemainingBudgetView;
    expect(colleagues).toMatchObject({ remainingMicroUsd: '50000000', scope: 'workspace' });
    expect(colleagues.caps.map((c) => c.scope)).toEqual(['workspace', 'instance']);

    // An alert set earlier than 80 percent used makes the meter turn low earlier.
    await as(t, root).put(`/api/workspaces/${charlie.id}/budgets/workspace`, {
      ...monthly(50),
      alertPercents: [50, 90],
    });
    const alerted = (await remaining(await as(t, colleague).get(path))) as RemainingBudgetView;
    expect(alerted.caps[0]).toMatchObject({ scope: 'workspace', lowAtPercentLeft: 50 });
    expect(JSON.stringify(alerted)).not.toContain('alertPercents');

    // Keys read no budgets (ADR 0049); chat asks with the person's session.
    const key = (
      await as(t, member).post(`/api/workspaces/${charlie.id}/keys`, { name: 'Script' })
    ).json() as IssuedKey;
    expect((await bearer(key.secret).get(path)).statusCode).toBe(403);

    // Spend past a cap shows as nothing left, never a negative amount.
    await spend(workspaceCap.id, 50_000_001);
    expect(await remaining(await as(t, colleague).get(path))).toMatchObject({
      remainingMicroUsd: '0',
      scope: 'workspace',
    });
    expect((await as(t, outsider).get(path)).statusCode).toBe(404);
  });
});

/** A request costing `cost` this month, by `principalId` acting for `actingUserId`. */
async function spent(principalId: string, actingUserId: string, cost: bigint) {
  await insertUsage(t.db, {
    requestId: randomUUID(),
    attempt: 1,
    outcome: 'completed',
    surface: 'api',
    workspaceId: alpha.id,
    principalId,
    actingUserId,
    model: 'p:m',
    provider: 'p',
    providerConfigId: null,
    inputTokens: 1,
    uncachedInputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    reasoningTokens: null,
    usageEstimated: false,
    inputMicroUsdPerMtok: 0,
    outputMicroUsdPerMtok: 0,
    cacheReadMicroUsdPerMtok: 0,
    cacheWriteMicroUsdPerMtok: 0,
    priceTierAboveInputTokens: null,
    costMicroUsd: cost,
    finishReason: 'stop',
    latencyMs: 1,
    ttftMs: 1,
    resolutionRule: 'explicit',
  });
}

/** Each row of month spend, in a fixed order. */
const spendOf = (view: WorkspaceBudgetsView) =>
  view.monthSpend
    .map((r) => [r.principalId, r.keyId, r.spentMicroUsd])
    .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));

describe('spend with no cap, and whether budgets can be checked (ADR 0093)', () => {
  it("BG-9, F5: this month's spend of every person and key, capped or not, and a member sees their own", async () => {
    const { rows } = await t.pool.query<{ principal_id: string }>(
      'select principal_id from api_keys where id = $1',
      [memberKey.key.id],
    );
    const keyPrincipal = rows[0]?.principal_id ?? '';
    await spent(colleague.principal.id, colleague.principal.id, 700n);
    await spent(member.principal.id, member.principal.id, 300n);
    await spent(keyPrincipal, member.principal.id, 200n);
    // The member's own includes their key's, as their cap counts it; the key has its own row.
    expect(spendOf(await list(wsAdmin))).toEqual(
      [
        [colleague.principal.id, null, '700'],
        [member.principal.id, null, '500'],
        [keyPrincipal, memberKey.key.id, '200'],
      ].toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(spendOf(await list(member))).toEqual(
      [
        [member.principal.id, null, '500'],
        [keyPrincipal, memberKey.key.id, '200'],
      ].toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(spendOf(await list(outsider, bravo))).toEqual([]);
  });

  it('BG-4: says whether budgets can be checked, to anyone who reads budgets here', async () => {
    const res = await as(t, member).get(`/api/workspaces/${alpha.id}/budgets/status`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: BudgetStatusView }).status).toEqual({ available: true });
    expect(
      (await as(t, outsider).get(`/api/workspaces/${alpha.id}/budgets/status`)).statusCode,
    ).toBe(404);
    const events = valkeyEvents(t.cache, createLogger({ level: 'silent', service: 'b' }).logger);
    const down = await budgetStatus({ db: t.db, events }, member.principal, alpha.id, () =>
      Promise.reject(new Error('connection refused')),
    );
    expect(down).toEqual({ available: false });
  });
});
