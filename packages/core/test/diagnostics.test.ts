import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { cacheInfoSummary, configSummary, errorSpanSummary } from '../src/diagnostics/bundle.ts';

/*
 * The diagnostics bundle's allowlists (AD-3, AC 17, ADR 0083), with no database: each part is
 * built field by field, so nothing unlisted can reach the bundle.
 */

const secret = (what: string) => `canary-${what}-0123456789abcdef0123456789abcdef`;

describe('diagnostics allowlists (AD-3)', () => {
  it('AC 17: the config says whether each secret is set, and never what it is', () => {
    const config = loadConfig({
      LAKKA_DATABASE_PASSWORD: secret('db'),
      LAKKA_CACHE_PASSWORD: secret('cache'),
      LAKKA_AUTH_SECRET: secret('auth'),
      LAKKA_CREDENTIAL_KEY: secret('credential-key'),
      LAKKA_SETUP_CODE: secret('setup'),
      LAKKA_PUBLIC_URL: 'https://ai.example.com',
      LAKKA_OTLP_ENDPOINT: `https://user:${secret('userinfo')}@otel.example.com/v1/traces?key=${secret('query')}`,
      LAKKA_OTLP_HEADERS: `x-api-key=${secret('otlp-header')}`,
      LAKKA_VERSION: '1.0.0',
      LAKKA_REVISION: 'abc1234',
    });
    const summary = configSummary(config);
    expect(JSON.stringify(summary)).not.toMatch(/canary-/);
    expect(summary).toMatchObject({
      database: { passwordSet: true },
      cache: { passwordSet: true },
      auth: { publicUrl: 'https://ai.example.com', secretSet: true },
      credentials: { masterKeySet: true },
      setup: { codeSet: true },
      otlp: { enabled: true, destination: 'https://otel.example.com', headerCount: 1 },
      catalogueFeed: { locked: false, origin: 'https://raw.githubusercontent.com' },
      build: { version: '1.0.0', revision: 'abc1234' },
    });
    expect(configSummary(loadConfig({ LAKKA_CATALOGUE_FEED_URL: 'off' })).catalogueFeed).toEqual({
      locked: true,
      origin: null,
    });
    expect(configSummary(loadConfig({ LAKKA_TOOL_HOST_URL: 'in-process' })).sandbox).toEqual({
      toolHost: { kind: 'in-process' },
      egressProxy: 'http://egress:3128',
      slots: 8,
    });
    expect(configSummary(loadConfig({}))).toMatchObject({
      sandbox: { toolHost: { kind: 'unix', path: '/run/lakka/tool-host/tool-host.sock' } },
      database: { passwordSet: false },
      auth: { secretSet: false },
      otlp: { enabled: false },
      build: { version: 'dev', revision: 'unknown' },
    });
  });

  it('AD-3: takes only the listed fields from Valkey INFO', () => {
    const info = [
      '# Server',
      'valkey_version:9.0.1',
      'executable:/usr/local/bin/valkey-server',
      'config_file:/etc/valkey/secret-path.conf',
      'uptime_in_seconds:3600',
      '# Memory',
      'used_memory:1048576',
      'maxmemory_policy:noeviction',
      '# Clients',
      'connected_clients:4',
      'client_recent_max_input_buffer:20480',
    ].join('\r\n');
    expect(cacheInfoSummary(info)).toEqual({
      valkey_version: '9.0.1',
      uptime_in_seconds: '3600',
      used_memory: '1048576',
      maxmemory_policy: 'noeviction',
      connected_clients: '4',
    });
  });

  it('AD-3: a failed span keeps what happened and drops who asked and what its events carried', () => {
    const summary = errorSpanSummary({
      trace_id: 't',
      span_id: 's',
      name: 'request',
      status: 'error',
      error_type: 'budget_exceeded',
      attributes: {
        'lakka.request_id': 'r',
        'lakka.model': 'openai:gpt-5',
        'lakka.principal_id': 'p',
        'lakka.acting_user_id': 'u',
        'lakka.conversation_id': 'c',
        'lakka.tool.credential_principal_id': 'k',
        'not.a.stored.attribute': 'x',
      },
      events: [{ name: 'candidate_skipped', atMs: 3, attributes: { reason: 'anything' } }],
    });
    expect(summary.attributes).toEqual({
      'lakka.request_id': 'r',
      'lakka.model': 'openai:gpt-5',
    });
    expect(summary.events).toEqual([{ name: 'candidate_skipped', atMs: 3 }]);
    expect(summary).toMatchObject({ name: 'request', errorType: 'budget_exceeded' });
  });
});
