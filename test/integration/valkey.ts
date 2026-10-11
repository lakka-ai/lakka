import { inject } from 'vitest';
import { createCacheClient } from '@lakka/core';
import type { CacheClient, CacheConfig } from '@lakka/core';
import { VALKEY_HOST, VALKEY_PORT } from './context.ts';

export function valkeyConfig(): CacheConfig {
  return { host: inject(VALKEY_HOST), port: inject(VALKEY_PORT), password: undefined };
}

export function createTestCache(): CacheClient {
  return createCacheClient(valkeyConfig(), 'lakka-tests');
}
