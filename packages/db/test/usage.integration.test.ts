import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.ts';
import type { Db } from '../src/client.ts';
import { migrate } from '../src/migrate.ts';
import type { Pool } from '../src/pool.ts';
import { ensureMonthlyPartitions, insertUsage } from '../src/queries/usage.ts';
import type { UsageInsert } from '../src/queries/usage.ts';
import { createTestDatabase } from '../../../test/integration/postgres.ts';
import type { TestDatabase } from '../../../test/integration/postgres.ts';

/* Monthly usage partitions (ADR 0039) against real Postgres. */

let database: TestDatabase;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = database.pool(10);
  await migrate(pool);
  db = createDb(pool);
});

afterAll(async () => {
  await database.drop();
});

const row = (overrides: Partial<UsageInsert> = {}): UsageInsert => ({
  requestId: randomUUID(),
  attempt: 1,
  outcome: 'completed',
  surface: 'api',
  workspaceId: randomUUID(),
  principalId: randomUUID(),
  actingUserId: randomUUID(),
  model: 'anthropic:claude-sonnet-4-5',
  provider: 'anthropic',
  providerConfigId: null,
  inputTokens: 10,
  uncachedInputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 5,
  reasoningTokens: null,
  usageEstimated: false,
  inputMicroUsdPerMtok: 3_000_000,
  outputMicroUsdPerMtok: 15_000_000,
  cacheReadMicroUsdPerMtok: 300_000,
  cacheWriteMicroUsdPerMtok: 3_750_000,
  priceTierAboveInputTokens: null,
  costMicroUsd: 105n,
  finishReason: 'stop',
  latencyMs: 120,
  ttftMs: 40,
  resolutionRule: 'explicit',
  ...overrides,
});

const partitions = async (table: 'usage' | 'spans' = 'usage') =>
  (
    await pool.query<{ name: string }>(
      `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = $1::regclass order by 1`,
      [table],
    )
  ).rows.map((r) => r.name);

describe('monthly partitions (ADR 0039, ADR 0076)', () => {
  it('creates this month and the next two for usage and spans, across a year boundary, and only once', async () => {
    const december = new Date('2026-12-15T12:00:00Z');
    expect(await ensureMonthlyPartitions(pool, december)).toBe(6);
    expect(await partitions()).toEqual(['usage_y2026m12', 'usage_y2027m01', 'usage_y2027m02']);
    expect(await partitions('spans')).toEqual([
      'spans_y2026m12',
      'spans_y2027m01',
      'spans_y2027m02',
    ]);
    expect(await ensureMonthlyPartitions(pool, december)).toBe(0);
  });

  it('is safe when several processes run it at once', async () => {
    const june = new Date('2027-06-01T00:00:00Z');
    const created = await Promise.all(
      Array.from({ length: 5 }, () => ensureMonthlyPartitions(pool, june)),
    );
    expect(created.reduce((a, b) => a + b, 0)).toBe(6);
    expect(await partitions()).toContain('usage_y2027m08');
  });

  it('BG-8: a record lands in the partition for its UTC month, with its cost kept exact', async () => {
    await ensureMonthlyPartitions(pool);
    const inserted = await insertUsage(db, row({ costMicroUsd: 9_007_199_254_740_993n }));
    const placed = await db.$client.query<{ partition: string; cost: string }>(
      'select tableoid::regclass::text as partition, cost_micro_usd::text as cost from usage where id = $1',
      [inserted.id],
    );
    const month = new Date().toISOString().slice(0, 7).replace('-', 'm');
    expect(placed.rows[0]?.partition).toBe(`usage_y${month}`);
    expect(placed.rows[0]?.cost).toBe('9007199254740993');
    expect(inserted.costMicroUsd).toBe(9_007_199_254_740_993n);
  });

  it('refuses a record for a month that has no partition, loudly, rather than losing it quietly', async () => {
    const insert = pool.query(
      `insert into usage (id, created_at, request_id, attempt, outcome, surface, workspace_id, principal_id,
        acting_user_id, model, provider, input_tokens, uncached_input_tokens, cache_read_tokens,
        cache_write_tokens, output_tokens, usage_estimated, input_micro_usd_per_mtok,
        output_micro_usd_per_mtok, cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok,
        cost_micro_usd, latency_ms, resolution_rule)
       values (gen_random_uuid(), '2040-01-15', gen_random_uuid(), 1, 'completed', 'api', gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid(), 'm:x', 'm', 1, 1, 0, 0, 1, false, 1, 1, 1, 1, 1, 1, 'explicit')`,
    );
    await expect(insert).rejects.toThrow(/no partition/);
  });

  it('keeps token counts consistent: total input is always uncached plus cached', async () => {
    await expect(insertUsage(db, row({ inputTokens: 11 }))).rejects.toMatchObject({
      cause: { constraint: 'usage_tokens_check' },
    });
  });

  it('RT-8, RT-9: the routing fields of a record always agree with each other', async () => {
    const route = randomUUID();
    await expect(
      insertUsage(db, row({ resolutionRule: 'classified', routeId: route, routeConfidence: 0.42 })),
    ).resolves.toMatchObject({ resolutionRule: 'classified', wasOverridden: false });
    await expect(
      insertUsage(db, row({ resolutionRule: 'default', defaultReason: 'below_threshold' })),
    ).resolves.toMatchObject({ defaultReason: 'below_threshold' });
    await expect(
      insertUsage(
        db,
        row({ routeId: route, wasOverridden: true, overriddenModel: 'anthropic:claude-haiku-4-5' }),
      ),
    ).resolves.toMatchObject({ wasOverridden: true });

    const refused = [
      [row({ resolutionRule: 'default' }), 'usage_default_reason_check'],
      [row({ defaultReason: 'too_short' }), 'usage_default_reason_check'],
      [row({ wasOverridden: true }), 'usage_override_check'],
      [row({ overriddenModel: 'anthropic:claude-haiku-4-5' }), 'usage_override_check'],
      [
        row({ resolutionRule: 'sticky', wasOverridden: true, overriddenModel: 'a:b' }),
        'usage_override_check',
      ],
      [row({ routeConfidence: 1.5 }), 'usage_route_confidence_check'],
    ] as const;
    for (const [bad, constraint] of refused) {
      await expect(insertUsage(db, bad)).rejects.toMatchObject({ cause: { constraint } });
    }
  });
});
