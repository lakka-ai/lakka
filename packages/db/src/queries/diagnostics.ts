import type { Pool } from '../pool.ts';

/*
 * What the diagnostics bundle reads from Postgres (AD-3, ADR 0083). Every query names the
 * columns it returns, and none reads a secret, a name, an email or anything anyone wrote: the
 * bundle is built from what is listed here, not by redacting a dump (H5, tech spec, Security).
 * Counts are grouped by workspace id, so a support engineer can tell workspaces apart without
 * learning what they are called.
 *
 * These read across workspaces on purpose: they are instance-level facts for an instance admin
 * or the operator, and return no workspace's rows.
 */

type Row = Record<string, unknown>;

async function rows(pool: Pool, text: string, values: unknown[] = []): Promise<Row[]> {
  return (await pool.query<Row>(text, values)).rows;
}

/** Server version and settings that matter for support, the extensions, and connections. */
export async function readDatabaseFacts(pool: Pool) {
  const [settings, extensions, connections, size, migrations] = await Promise.all([
    rows(
      pool,
      `select name, setting, unit from pg_settings
       where name in ('server_version', 'max_connections', 'shared_buffers', 'work_mem',
         'effective_cache_size', 'TimeZone', 'default_transaction_isolation')
       order by name`,
    ),
    rows(pool, 'select extname as name, extversion as version from pg_extension order by extname'),
    rows(
      pool,
      `select coalesce(state, 'background') as state, count(*)::int as count
       from pg_stat_activity where datname = current_database() group by 1 order by 1`,
    ),
    rows(pool, 'select pg_database_size(current_database())::bigint as bytes'),
    rows(
      pool,
      `select count(*)::int as applied, max(created_at)::bigint as last_applied_at_ms
       from drizzle.__drizzle_migrations`,
    ),
  ]);
  return {
    settings,
    extensions,
    connections,
    sizeBytes: size[0]?.['bytes'] ?? null,
    migrations: migrations[0] ?? null,
  };
}

/** Every table and partition in our schema, with its approximate rows and size on disk. */
export async function readTableFacts(pool: Pool) {
  return rows(
    pool,
    `select c.relname as name,
            case c.relkind when 'p' then 'partitioned' else 'table' end as kind,
            parent.relname as partition_of,
            greatest(c.reltuples, 0)::bigint as approximate_rows,
            pg_total_relation_size(c.oid)::bigint as bytes
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_inherits i on i.inhrelid = c.oid
     left join pg_class parent on parent.oid = i.inhparent
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by c.relname`,
  );
}

/** Counts of what the instance holds, by kind and state, and per workspace by id. */
export async function readInstanceFacts(pool: Pool) {
  const [
    principals,
    workspaces,
    providers,
    customModels,
    ssoProviders,
    budgets,
    reservations,
    alerts,
    retention,
    credentialKeys,
    catalogueFeed,
  ] = await Promise.all([
    rows(
      pool,
      `select kind, status, is_instance_admin, count(*)::int as count
       from principals group by 1, 2, 3 order by 1, 2, 3`,
    ),
    rows(
      pool,
      `select w.id, w.routing_enabled, w.content_capture, w.content_retention_days,
              w.pinned_model is not null as pinned, w.default_model is not null as has_default,
              w.created_at,
              (select count(*)::int from memberships m where m.workspace_id = w.id) as members,
              (select count(*)::int from api_keys k
                where k.workspace_id = w.id and k.revoked_at is null) as active_keys,
              (select count(*)::int from routes r where r.workspace_id = w.id) as routes,
              (select count(*)::int from mcp_servers s where s.workspace_id = w.id) as mcp_servers,
              (select count(*)::int from workspace_tools t
                where t.workspace_id = w.id and t.enabled) as enabled_tools,
              (select count(*)::int from conversations c where c.workspace_id = w.id)
                as conversations
       from workspaces w order by w.created_at`,
    ),
    // Never the key or the address: only whether each is set, and the last test's outcome.
    rows(
      pool,
      `select kind, name, workspace_id, api_key is not null as has_key,
              base_url is not null as custom_base_url, last_test_status, last_test_http_status,
              last_tested_at
       from provider_configs order by workspace_id nulls first, name`,
    ),
    rows(pool, 'select count(*)::int as count from custom_models'),
    rows(pool, 'select count(*)::int as count from sso_providers'),
    rows(
      pool,
      `select scope, period, count(*)::int as count from budgets group by 1, 2 order by 1, 2`,
    ),
    rows(
      pool,
      `select state, count(*)::int as count, max(created_at) as newest
       from reservations group by 1 order by 1`,
    ),
    rows(
      pool,
      `select state, count(*)::int as count from budget_alerts
       where created_at > now() - interval '30 days' group by 1 order by 1`,
    ),
    rows(
      pool,
      `select spans_days, usage_months, conversations_days, tool_audit_days,
              budget_alerts_months, reservations_days, last_run_at, last_run_deleted
       from retention_settings`,
    ),
    // Versions and dates only, never a key or its fingerprint (ADR 0115).
    rows(
      pool,
      `select version, created_at, activated_at, retired_at from credential_keys order by version`,
    ),
    // Whether price updates are on and what the last check found, never the feed file (ADR 0116).
    rows(
      pool,
      `select enabled, applied_serial, applied_at, last_checked_at, last_result, last_error_code
       from catalogue_feed`,
    ),
  ]);
  return {
    principals,
    workspaces,
    providers,
    customModels: customModels[0]?.['count'] ?? 0,
    ssoProviders: ssoProviders[0]?.['count'] ?? 0,
    budgets,
    reservations,
    budgetAlertsLast30Days: alerts,
    retention: retention[0] ?? null,
    catalogueFeed: catalogueFeed[0] ?? null,
    credentialKeys: {
      active:
        credentialKeys
          .filter((k) => k['activated_at'] !== null)
          .map((k) => k['version'])
          .at(-1) ?? null,
      versions: credentialKeys,
    },
  };
}

/**
 * Background jobs by queue and state, from pg-boss's own table. Null if pg-boss has not created
 * its schema yet, which is the case until the worker has started once.
 */
export async function readJobFacts(pool: Pool): Promise<Row[] | null> {
  try {
    return await rows(
      pool,
      `select name as queue, state, count(*)::int as count, max(created_on) as newest
       from pgboss.job group by 1, 2 order by 1, 2`,
    );
  } catch (error) {
    // Missing schema or table: pg-boss has not set itself up. Anything else is a real failure.
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code === '3F000' || code === '42P01') return null;
    throw error;
  }
}

/** The newest failed spans, for the bundle to pick its attributes from. */
export async function readRecentErrorSpans(pool: Pool, since: Date, limit: number) {
  return rows(
    pool,
    `select trace_id, span_id, parent_span_id, workspace_id, request_id, name, kind, status,
            error_type, started_at, duration_ms, attributes, events
     from spans where status = 'error' and started_at > $1
     order by started_at desc limit $2`,
    [since, limit],
  );
}
