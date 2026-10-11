import {
  createCacheClient,
  createLogger,
  handleModelRequest,
  fixedCatalogue,
  loadCatalogue,
  noClassifier,
  policySnapshots,
  valkeyEvents,
} from '@lakka/core';
import { configureCredentialKey, createDb, createPool } from '@lakka/db';
import type { PoolOptions } from '@lakka/db';

/*
 * A separate process that sends one model request through the entry point and streams it, for
 * the test that kills a process mid-stream (AC 8). It prints "streaming" once text is flowing,
 * then keeps reading until it is killed.
 */

type Principal = Parameters<typeof handleModelRequest>[1]['principal'];

interface ChildInput {
  database: PoolOptions;
  cache: { host: string; port: number };
  credentialKey: string;
  keyPrefix: string;
  workspaceId: string;
  principal: Principal;
  model: string;
  requestId: string;
  reservationTtlMs: number;
  maxRequestMs: number;
}

const input = JSON.parse(process.env['LAKKA_TEST_CHILD'] ?? '{}') as ChildInput;
configureCredentialKey(input.credentialKey);
const { logger } = createLogger({ level: 'silent', service: 'budget-child' });
const pool = createPool(input.database, () => undefined);
const cache = createCacheClient({ ...input.cache, password: undefined }, 'budget-child');
const db = createDb(pool);

const response = await handleModelRequest(
  {
    db,
    catalogue: fixedCatalogue(loadCatalogue()),
    logger,
    events: valkeyEvents(cache, logger),
    cache,
    keyPrefix: input.keyPrefix,
    classifier: noClassifier,
    snapshots: policySnapshots({ db }),
    reservationTtlMs: input.reservationTtlMs,
    maxRequestMs: input.maxRequestMs,
  },
  {
    requestId: input.requestId,
    surface: 'api',
    workspaceId: input.workspaceId,
    principal: input.principal,
    request: { messages: [{ role: 'user', content: 'Stream for a while' }], maxOutputTokens: 500 },
    model: input.model,
    conversationId: null,
  },
);
let announced = false;
for await (const event of response.stream) {
  if (event.type === 'text' && !announced) {
    announced = true;
    process.stdout.write('streaming\n');
  }
}
