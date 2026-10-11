import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RetentionView, WorkspaceView } from '@lakka/contracts';
import { createLogger, enforceRetention, startAlertJobs } from '@lakka/core';
import type { RetentionContext } from '@lakka/core';
import { ensureMonthlyPartitions, insertSpans } from '@lakka/db';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Retention (OB-6, NF-P5, AC 21, ADR 0078), against real Postgres: records older than each
 * period are deleted, and those inside it are kept, for spans (whole months dropped, and the rest
 * of the cutoff's month deleted), usage, captured content, conversations when a period is set,
 * the tool audit, alerts and reservations. Instance admins set the periods and can run it at
 * once; the worker schedules it daily.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let t: TestApp;
let root: SignedInUser;
let member: SignedInUser;
let alpha: WorkspaceView;
let ctx: RetentionContext;

const { logger } = createLogger({
  level: 'fatal',
  service: 'retention-test',
  destination: { write: () => undefined },
});

async function countWhere(table: string, where: string, values: unknown[]): Promise<number> {
  const { rows } = await t.pool.query<{ n: number }>(
    `select count(*)::int as n from ${table} where ${where}`,
    values,
  );
  return rows[0]?.n ?? -1;
}

async function span(startedAt: Date): Promise<string> {
  const traceId = randomBytes(16).toString('hex');
  await insertSpans(t.db, [
    {
      traceId,
      spanId: randomBytes(8).toString('hex'),
      workspaceId: alpha.id,
      requestId: randomUUID(),
      name: 'request',
      kind: 'server',
      status: 'unset',
      startedAt,
      durationMs: 1,
    },
  ]);
  return traceId;
}

async function usage(createdAt: Date): Promise<string> {
  const requestId = randomUUID();
  await t.pool.query(
    `insert into usage (id, created_at, request_id, attempt, outcome, surface, workspace_id, principal_id,
      acting_user_id, model, provider, input_tokens, uncached_input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, usage_estimated, input_micro_usd_per_mtok,
      output_micro_usd_per_mtok, cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok,
      cost_micro_usd, latency_ms, resolution_rule)
     values (gen_random_uuid(), $1, $2, 1, 'completed', 'api', $3, $4, $4, 'm:x', 'm', 1, 1, 0, 0, 1,
      false, 1, 1, 1, 1, 1, 1, 'explicit')`,
    [createdAt, requestId, alpha.id, member.principal.id],
  );
  return requestId;
}

async function conversation(updatedAt: Date): Promise<string> {
  const { rows } = await t.pool.query<{ id: string }>(
    `insert into conversations (id, workspace_id, principal_id, title, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, 'old', $3, $3) returning id`,
    [alpha.id, member.principal.id, updatedAt],
  );
  const id = rows[0]?.id ?? '';
  await t.pool.query(
    `insert into messages (id, workspace_id, conversation_id, role, content, request_id, created_at)
     values (gen_random_uuid(), $1, $2, 'user', 'hello', gen_random_uuid(), $3)`,
    [alpha.id, id, updatedAt],
  );
  return id;
}

async function toolCall(createdAt: Date): Promise<void> {
  await t.pool.query(
    `insert into tool_invocations (id, request_id, workspace_id, principal_id, acting_user_id, call_id,
      tool_name, arguments, status, duration_ms, created_at)
     values (gen_random_uuid(), gen_random_uuid(), $1, $2, $2, 'c1', 'srv__echo', '{}', 'ok', 1, $3)`,
    [alpha.id, member.principal.id, createdAt],
  );
}

async function reservation(state: 'settled' | 'active', createdAt: Date): Promise<string> {
  const { rows } = await t.pool.query<{ id: string }>(
    `insert into reservations (id, request_id, workspace_id, principal_id, acting_user_id,
      amount_micro_usd, state, created_at, expires_at, settled_at, actual_micro_usd)
     values (gen_random_uuid(), gen_random_uuid(), $1, $2, $2, 1, $3::text, $4::timestamptz,
      $4::timestamptz + interval '1 hour',
      case when $3::text = 'settled' then $4::timestamptz else null end,
      case when $3::text = 'settled' then 1 else null end) returning id`,
    [alpha.id, member.principal.id, state, createdAt],
  );
  return rows[0]?.id ?? '';
}

/** An alert at `percent`; one budget has one alert per percent per period, so each call picks its own. */
async function alert(
  state: 'delivered' | 'pending',
  createdAt: Date,
  budgetId: string,
  percent: number,
) {
  await t.pool.query(
    `insert into budget_alerts (id, budget_id, period_start, percent, spent_micro_usd, limit_micro_usd,
      state, created_at, delivered_at)
     values (gen_random_uuid(), $1, $2::timestamptz, $3, 1, 2, $4::text, $2::timestamptz,
      case when $4::text = 'delivered' then $2::timestamptz else null end)`,
    [budgetId, createdAt, percent, state],
  );
}

beforeAll(async () => {
  t = await createTestApp();
  ctx = { db: t.db, pool: t.pool, logger };
  [root, member] = await Promise.all([signedInUser(t, 'Root'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = (
    (
      await as(t, root).post('/api/workspaces', {
        name: 'Alpha',
        slug: `alpha-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  await as(t, root).put(`/api/workspaces/${alpha.id}/members/${member.principal.id}`, {
    role: 'member',
  });
  // Partitions for the months the old records fall in.
  for (const days of [70, 31, 450, 400]) await ensureMonthlyPartitions(t.pool, ago(days));
});

afterAll(async () => {
  await t?.close();
});

describe('retention (OB-6, NF-P5)', () => {
  it('AC 21: deletes records older than each period, and keeps those inside it', async () => {
    // Spans: 30 days. One in a month long past, one just past the cutoff, one inside. Seventy
    // days back is always a month before the cutoff's, which sixty is not at the end of a month.
    const oldSpan = await span(ago(70));
    const justPast = await span(ago(31));
    const keptSpan = await span(ago(29));
    // Usage: 13 months.
    const oldUsage = await usage(ago(450));
    const keptUsage = await usage(ago(360));
    // Captured content: its own expiry.
    await t.pool.query(
      `insert into span_content (trace_id, span_id, workspace_id, request_id, prompt, response,
        created_at, expires_at) values
        ('a', 'a', $1, gen_random_uuid(), '{}', '{}', $2, $3),
        ('b', 'b', $1, gen_random_uuid(), '{}', '{}', $2, $4)`,
      [alpha.id, ago(10), ago(1), new Date(NOW.getTime() + DAY)],
    );
    // Conversations: kept until deleted, by default.
    const oldConversation = await conversation(ago(400));
    // Tool audit: 90 days.
    await toolCall(ago(100));
    await toolCall(ago(10));
    // Reservations: 30 days, and only those that are over.
    const oldSettled = await reservation('settled', ago(40));
    const oldActive = await reservation('active', ago(40));
    // Alerts: 13 months, and only those that are done with.
    await as(t, root).put(`/api/workspaces/${alpha.id}/budgets/workspace`, {
      limitMicroUsd: '1000000',
      period: 'monthly',
    });
    const { rows } = await t.pool.query<{ id: string }>(
      "select id from budgets where workspace_id = $1 and scope = 'workspace'",
      [alpha.id],
    );
    const budgetId = rows[0]?.id ?? '';
    await alert('delivered', ago(420), budgetId, 80);
    await alert('pending', ago(420), budgetId, 100);

    const deleted = await enforceRetention(ctx, NOW);
    expect(deleted).toMatchObject({
      spans: 2,
      usage: 1,
      spanContent: 1,
      conversations: 0,
      toolRecords: 1,
      reservations: 1,
      budgetAlerts: 1,
    });

    const where = 'trace_id = $1';
    expect(await countWhere('spans', where, [oldSpan])).toBe(0);
    expect(await countWhere('spans', where, [justPast])).toBe(0);
    expect(await countWhere('spans', where, [keptSpan])).toBe(1);
    expect(await countWhere('usage', 'request_id = $1', [oldUsage])).toBe(0);
    expect(await countWhere('usage', 'request_id = $1', [keptUsage])).toBe(1);
    expect(await countWhere('span_content', "trace_id in ('a', 'b')", [])).toBe(1);
    expect(await countWhere('conversations', 'id = $1', [oldConversation])).toBe(1);
    expect(await countWhere('reservations', 'id = $1', [oldSettled])).toBe(0);
    expect(await countWhere('reservations', 'id = $1', [oldActive])).toBe(1);
    expect(await countWhere('budget_alerts', 'budget_id = $1', [budgetId])).toBe(1);
    // The month the old span was in is gone as a whole partition, not row by row.
    const d = ago(70);
    const partition = `spans_y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const { rows: present } = await t.pool.query<{ ok: boolean }>(
      'select to_regclass($1) is not null as ok',
      [partition],
    );
    expect(present[0]?.ok).toBe(false);

    // Running again finds nothing more.
    expect(Object.values((await enforceRetention(ctx, NOW)) ?? {}).every((n) => n === 0)).toBe(
      true,
    );
  });

  it('NF-P5: conversations go only when a period is set, with their messages', async () => {
    const old = await conversation(ago(400));
    const recent = await conversation(ago(5));
    const res = await as(t, root).get('/api/retention');
    const current = (res.json() as { retention: RetentionView }).retention;
    const { updatedAt: _u, updatedBy: _b, lastRun: _l, ...periods } = current;
    void _u;
    void _b;
    void _l;
    expect(
      (await as(t, root).put('/api/retention', { ...periods, conversationsDays: 365 })).statusCode,
    ).toBe(200);
    const deleted = await enforceRetention(ctx, NOW);
    expect(deleted?.conversations).toBeGreaterThanOrEqual(1);
    expect(await countWhere('conversations', 'id = $1', [old])).toBe(0);
    expect(await countWhere('messages', 'conversation_id = $1', [old])).toBe(0);
    expect(await countWhere('conversations', 'id = $1', [recent])).toBe(1);
  });

  it('runs take turns: while another run holds the lock, a run does nothing', async () => {
    const other = await t.pool.connect();
    try {
      // The lock enforceRetention takes ("rete").
      await other.query('select pg_advisory_lock($1)', [0x72657465]);
      expect(await enforceRetention(ctx, NOW)).toBeNull();
      await other.query('select pg_advisory_unlock($1)', [0x72657465]);
      expect(await enforceRetention(ctx, NOW)).not.toBeNull();
    } finally {
      other.release();
    }
  });

  it('OB-6: instance admins see the documented defaults, change them, and run it at once', async () => {
    expect((await as(t, member).get('/api/retention')).statusCode).toBe(403);
    expect((await as(t, member).post('/api/retention/run', {})).statusCode).toBe(403);
    const shown = ((await as(t, root).get('/api/retention')).json() as { retention: RetentionView })
      .retention;
    expect(shown).toMatchObject({
      spansDays: 30,
      usageMonths: 13,
      toolAuditDays: 90,
      budgetAlertsMonths: 13,
      reservationsDays: 30,
    });
    const bad = { ...shown, usageMonths: 1, updatedAt: undefined };
    expect((await as(t, root).put('/api/retention', bad)).statusCode).toBe(400);
    const run = await as(t, root).post('/api/retention/run', {});
    expect(run.statusCode).toBe(200);
    const after = (run.json() as { retention: RetentionView }).retention;
    expect(after.lastRun?.at).toBeDefined();
    expect(after.lastRun?.durationMs).toEqual(expect.any(Number));
    expect(after.updatedBy).toBe('Root');
  });

  it('NF-P5: expired password reset links go, and a live one stays', async () => {
    const reset = (principalId: string, expiresAt: Date) =>
      t.pool.query(
        `insert into password_resets (id, principal_id, token_hash, created_by_principal_id, expires_at)
         values (gen_random_uuid(), $1, $2, $3, $4)`,
        [principalId, randomBytes(32).toString('hex'), root.principal.id, expiresAt],
      );
    await reset(member.principal.id, ago(2));
    await reset(root.principal.id, new Date(NOW.getTime() + DAY));
    const deleted = await enforceRetention(ctx, NOW);
    expect(deleted?.passwordResets).toBe(1);
    expect(await countWhere('password_resets', 'principal_id = $1', [member.principal.id])).toBe(0);
    expect(await countWhere('password_resets', 'principal_id = $1', [root.principal.id])).toBe(1);
  });

  it('OB-6: a run recorded before a kind was counted shows no number for it', async () => {
    await t.pool.query(
      `update retention_settings set last_run_deleted = '{"spans": 3}'::jsonb, last_run_at = now()`,
    );
    const shown = ((await as(t, root).get('/api/retention')).json() as { retention: RetentionView })
      .retention;
    expect(shown.lastRun?.deleted.spans).toBe(3);
    expect(shown.lastRun?.deleted.passwordResets).toBeNull();
  });

  it('OB-6: Run now says when a run is already going, rather than returning the last one', async () => {
    const other = await t.pool.connect();
    try {
      await other.query('select pg_advisory_lock($1)', [0x72657465]);
      const res = await as(t, root).post('/api/retention/run', {});
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('retention_running');
    } finally {
      await other.query('select pg_advisory_unlock($1)', [0x72657465]);
      other.release();
    }
  });

  it('NF-P5: the worker schedules it every day, as a pg-boss job', async () => {
    const jobs = await startAlertJobs({ db: t.db, pool: t.pool, logger }, { retention: ctx });
    try {
      const { rows } = await t.pool.query<{ name: string; cron: string; timezone: string }>(
        'select name, cron, timezone from pgboss.schedule',
      );
      expect(rows).toEqual([{ name: 'retention', cron: '17 3 * * *', timezone: 'UTC' }]);
    } finally {
      await jobs.stop();
    }
  });
});
