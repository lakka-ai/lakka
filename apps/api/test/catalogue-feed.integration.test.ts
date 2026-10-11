import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiErrorBody } from '@lakka/contracts';
import type {
  CatalogueFeedPayload,
  CatalogueFeedView,
  CatalogueFile,
  IssuedKey,
  CustomModelBody,
  ModelView,
  WorkspaceView,
} from '@lakka/contracts';
import {
  BUNDLED_CATALOGUE_PATH,
  checkCatalogueFeed,
  createLogger,
  DEFAULT_CATALOGUE_FEED_URL,
  estimateAttemptCost,
  feedKeyOf,
  feedRecords,
  handleModelRequest,
  loadCatalogue,
  noClassifier,
  parseCatalogue,
  policySnapshots,
  resolveModel,
  signFeed,
  startCatalogueReloader,
  valkeyEvents,
} from '@lakka/core';
import type { Catalogue, CatalogueReloader, CatalogueStore, ModelResponse } from '@lakka/core';
import { applyCatalogueFeed, listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import { anonymous, as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The signed price feed (PR-6, ADR 0116) against real Postgres and Valkey: off after first-run,
 * only instance admins switch it, the worker's check stores a verified feed in one transaction
 * and the api prices with it after one poll, a stored feed that fails its checks is ignored at
 * startup, an admin's own model wins over a model only the feed lists, and a request keeps the
 * prices it was reserved at when the catalogue changes under it. Keys are generated for the
 * test; none is a production key.
 */

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const { privateKey } = generateKeyPairSync('ed25519');
const keys = [feedKeyOf(privateKey)];
const FEED_URL = 'https://feed.example.test/catalogue-v1.json';
const SONNET = 'anthropic:claude-sonnet-4-5';
const FEED_ONLY = 'openai:gpt-feed-only';

const bundledFile = JSON.parse(readFileSync(BUNDLED_CATALOGUE_PATH, 'utf8')) as CatalogueFile;
const bundled = loadCatalogue();

/** The bundled file one serial on: Sonnet's input price raised a little, and one model added. */
function feedPayload(serial = bundled.serial + 1): CatalogueFeedPayload {
  const sonnet = bundledFile.models.find((m) => m.id === SONNET);
  if (sonnet === undefined) throw new Error(`the catalogue is missing ${SONNET}`);
  return {
    ...bundledFile,
    serial,
    issuedAt: '2026-10-06T08:00:00Z',
    models: [
      ...bundledFile.models.map((m) =>
        m.id === SONNET ? { ...m, prices: { ...m.prices, inputMicroUsdPerMtok: 3_300_000 } } : m,
      ),
      {
        ...sonnet,
        id: FEED_ONLY,
        provider: 'openai',
        model: 'gpt-feed-only',
        tiers: [],
      },
    ],
  };
}

const serving = (file: string) =>
  (async () => new Response(file, { status: 200 })) as unknown as typeof fetch;

let t: TestApp;
let reloader: CatalogueReloader;
let admin: SignedInUser;
let workspaceAdmin: SignedInUser;
let ws: WorkspaceView;
let lines: string[];

beforeAll(async () => {
  t = await createTestApp({
    catalogue: async (db, logger) =>
      (reloader = await startCatalogueReloader({ db, logger, bundled, keys, pollMs: 100 })),
    catalogueFeed: { url: FEED_URL, keys },
  });
  lines = t.logs;
  [admin, workspaceAdmin] = await Promise.all([
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Workspace Admin'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  ws = (
    (
      await as(t, admin).post('/api/workspaces', {
        name: 'Feed',
        slug: `feed-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  await as(t, admin).put(`/api/workspaces/${ws.id}/members/${workspaceAdmin.principal.id}`, {
    role: 'admin',
  });
});

afterAll(async () => {
  reloader.stop();
  await t.close();
});

const view = async (): Promise<CatalogueFeedView> =>
  ((await as(t, admin).get('/api/models/catalogue-feed')).json() as { feed: CatalogueFeedView })
    .feed;

const models = async (): Promise<ModelView[]> =>
  ((await as(t, admin).get('/api/models')).json() as { models: ModelView[] }).models;

describe('price updates (PR-6, ADR 0116)', () => {
  it('NF-P2: the feed is off after first-run, and cannot be turned on without a key', async () => {
    // A fresh instance with the project's address and, as this build ships, no key.
    const fresh = await createTestApp({
      catalogueFeed: { url: DEFAULT_CATALOGUE_FEED_URL, keys: [] },
    });
    try {
      const tag = randomBytes(3).toString('hex');
      const setup = await anonymous(fresh).post('/api/setup', {
        code: fresh.setupCode,
        admin: {
          name: 'First Admin',
          email: `first-${tag}@example.com`,
          password: `first admin password ${tag}`,
        },
        workspace: { name: 'Acme', slug: `acme-${tag}` },
      });
      expect(setup.statusCode).toBe(201);
      const session = setup.cookies.find((c) => c.name === 'lakka.session_token');
      const headers = { cookie: `${session?.name}=${session?.value}`, origin: PUBLIC_URL };
      const res = await fresh.app.inject({
        method: 'GET',
        url: '/api/models/catalogue-feed',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { feed: CatalogueFeedView }).feed).toMatchObject({
        enabled: false,
        unavailable: 'no_key',
        host: 'raw.githubusercontent.com',
        lastCheckedAt: null,
        appliedSerial: null,
        activeSerial: bundled.serial,
      });
      const on = await fresh.app.inject({
        method: 'PUT',
        url: '/api/models/catalogue-feed',
        headers,
        payload: { enabled: true },
      });
      expect(on.statusCode).toBe(409);
      expect(code(on)).toBe('catalogue_feed_no_key');
      const { rows } = await fresh.pool.query<{ enabled: boolean }>(
        'select enabled from catalogue_feed',
      );
      expect(rows).toEqual([{ enabled: false }]);
    } finally {
      await fresh.close();
    }
  });

  it('PR-6, NF-S2: a workspace admin and an instance admin key get 403', async () => {
    for (const [method, url] of [
      ['GET', '/api/models/catalogue-feed'],
      ['PUT', '/api/models/catalogue-feed'],
      ['POST', '/api/models/catalogue-feed/check'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: { cookie: workspaceAdmin.cookie, origin: PUBLIC_URL },
        ...(method === 'GET' ? {} : { payload: { enabled: true } }),
      });
      expect(res.statusCode).toBe(403);
    }
    const issued = (
      await as(t, admin).post(`/api/workspaces/${ws.id}/keys`, { name: 'k' })
    ).json() as IssuedKey;
    for (const [method, url] of [
      ['GET', '/api/models/catalogue-feed'],
      ['PUT', '/api/models/catalogue-feed'],
      ['POST', '/api/models/catalogue-feed/check'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${issued.secret}` },
        ...(method === 'GET' ? {} : { payload: { enabled: true } }),
      });
      expect(res.statusCode).toBe(403);
    }
    expect((await view()).enabled).toBe(false);
  });

  it('PR-6: Check now while the feed is off is refused', async () => {
    const res = await as(t, admin).post('/api/models/catalogue-feed/check', {});
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('catalogue_feed_off');
  });

  it('PR-6: the worker applies a feed in one transaction and the api serves it after one poll', async () => {
    const on = await as(t, admin).put('/api/models/catalogue-feed', { enabled: true });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { feed: CatalogueFeedView }).feed).toMatchObject({
      enabled: true,
      unavailable: null,
      host: 'feed.example.test',
      checkRequested: true,
    });

    const file = signFeed(feedPayload(), privateKey);
    const { logger } = createLogger({ level: 'silent', service: 'worker-test' });
    const outcome = await checkCatalogueFeed({
      records: feedRecords(t.db),
      logger,
      bundled,
      keys,
      url: FEED_URL,
      fetch: serving(file),
    });
    expect(outcome).toBe('applied');
    const { rows } = await t.pool.query<{
      envelope: string;
      applied_serial: number;
      last_result: string;
      check_requested_at: Date | null;
    }>('select envelope, applied_serial, last_result, check_requested_at from catalogue_feed');
    expect(rows).toEqual([
      {
        envelope: file,
        applied_serial: bundled.serial + 1,
        last_result: 'applied',
        check_requested_at: null,
      },
    ]);

    await vi.waitFor(async () => {
      const sonnet = (await models()).find((m) => m.id === SONNET);
      expect(sonnet?.prices.inputMicroUsdPerMtok).toBe(3_300_000);
      expect(sonnet?.priceUpdated).toBe(true);
    });
    const listed = await models();
    expect(listed.find((m) => m.id === FEED_ONLY)).toMatchObject({
      source: 'catalogue',
      priceUpdated: true,
    });
    expect(listed.find((m) => m.id === 'anthropic:claude-haiku-4-5')?.priceUpdated).toBe(false);
    expect((await view()).activeSerial).toBe(bundled.serial + 1);
    expect(lines.some((l) => l.includes('"catalogue.reloaded"'))).toBe(true);

    // A check that started before this one stored its feed stores nothing.
    expect(await applyCatalogueFeed(t.db, file, bundled.serial + 1, new Date(), null)).toBe(false);
  });

  it('PR-6: two checks storing the same new feed at once store it once', async () => {
    const file = signFeed(feedPayload(bundled.serial + 2), privateKey);
    const stored = await Promise.all([
      applyCatalogueFeed(t.db, file, bundled.serial + 2, new Date(), bundled.serial + 1),
      applyCatalogueFeed(t.db, file, bundled.serial + 2, new Date(), bundled.serial + 1),
    ]);
    expect(stored.toSorted()).toEqual([false, true]);
    await reloader.reload();
    expect(reloader.current().serial).toBe(bundled.serial + 2);
  });

  it('PR-6: a custom model wins over a model only the feed lists', async () => {
    await reloader.reload();
    expect(reloader.current().feedOnly.has(FEED_ONLY)).toBe(true);
    const body: CustomModelBody = {
      provider: 'openai',
      model: 'gpt-feed-only',
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
        inputMicroUsdPerMtok: 123_000,
        outputMicroUsdPerMtok: 456_000,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
    };
    const res = await as(t, admin).post('/api/models/custom', body);
    expect(res.statusCode).toBe(201);
    const resolved = await resolveModel({ db: t.db, catalogue: reloader }, FEED_ONLY);
    expect(resolved).toMatchObject({ source: 'custom', priceUpdated: false });
    expect(resolved.prices.inputMicroUsdPerMtok).toBe(123_000);
    const listed = (await models()).filter((m) => m.id === FEED_ONLY);
    expect(listed.map((m) => m.source)).toEqual(['custom']);
    // A bundled id is still refused: the feed never lets an admin override a release price.
    const bundledId = await as(t, admin).post('/api/models/custom', {
      ...body,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(bundledId.statusCode).toBe(409);
    expect(code(bundledId)).toBe('model_exists');
  });

  it('PR-6: switching off goes back to the bundled prices at once and keeps the serial', async () => {
    const off = await as(t, admin).put('/api/models/catalogue-feed', { enabled: false });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { feed: CatalogueFeedView }).feed).toMatchObject({
      enabled: false,
      activeSerial: bundled.serial,
      appliedSerial: bundled.serial + 2,
    });
    expect((await models()).find((m) => m.id === SONNET)?.prices.inputMicroUsdPerMtok).toBe(
      3_000_000,
    );
    // On again: the stored feed applies, and an older one is still a replay.
    await as(t, admin).put('/api/models/catalogue-feed', { enabled: true });
    expect(reloader.current().serial).toBe(bundled.serial + 2);
    const { logger } = createLogger({ level: 'silent', service: 'worker-test' });
    const older = await checkCatalogueFeed({
      records: feedRecords(t.db),
      logger,
      bundled,
      keys,
      url: FEED_URL,
      fetch: serving(signFeed(feedPayload(bundled.serial + 1), privateKey)),
    });
    expect(older).toBe('failed');
    expect((await view()).lastErrorCode).toBe('not_newer');
  });

  it('PR-6: a tampered stored feed is ignored at api start, and bundled prices apply', async () => {
    const file = signFeed(feedPayload(bundled.serial + 3), privateKey);
    const envelope = JSON.parse(file) as { payload: string };
    const bytes = Buffer.from(envelope.payload, 'base64');
    const at = bytes.indexOf('3300000');
    bytes[at] = '1'.charCodeAt(0);
    const tampered = JSON.stringify({ ...envelope, payload: bytes.toString('base64') });
    await t.pool.query(
      'update catalogue_feed set enabled = true, envelope = $1, applied_serial = $2',
      [tampered, bundled.serial + 3],
    );
    const logs: string[] = [];
    const { logger } = createLogger({
      level: 'info',
      service: 'api-start',
      destination: { write: (line: string) => void logs.push(line) },
    });
    const started = await startCatalogueReloader({ db: t.db, logger, bundled, keys });
    try {
      expect(started.current()).toBe(bundled);
      expect(
        logs.some(
          (l) => l.includes('"catalogue_feed.stored_refused"') && l.includes('bad_signature'),
        ),
      ).toBe(true);
      // Nothing of the stored text reaches a log line.
      expect(logs.join('\n')).not.toContain(envelope.payload.slice(0, 40));
    } finally {
      started.stop();
    }
  });
});

describe('a request keeps its prices (BG-3, PR-6, invariant 4)', () => {
  it('BG-3, PR-6: a request reserved before a catalogue swap dispatches and settles at its pinned price', async () => {
    const fake = await startFakeProvider();
    try {
      const provider = await as(t, admin).post('/api/providers', {
        kind: 'openai-compatible',
        name: 'fakefeed',
        baseUrl: `${fake.url}/openai/v1`,
      });
      expect(provider.statusCode).toBe(201);
      const pinnedModel = {
        id: 'fakefeed:ok~pinned',
        provider: 'fakefeed',
        model: 'ok~pinned',
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
        tiers: [],
      };
      const head = { ...bundledFile, models: [pinnedModel] };
      const before = parseCatalogue({ ...head, serial: 10 });
      const after = parseCatalogue({
        ...head,
        serial: 11,
        models: [
          {
            ...pinnedModel,
            prices: { ...pinnedModel.prices, inputMicroUsdPerMtok: 9_000_000 },
          },
        ],
      });
      // The first read is the catalogue the request pins; every later read sees the swap.
      let reads = 0;
      const swapping: CatalogueStore = {
        current: (): Catalogue => (reads++ === 0 ? before : after),
        bundled: before,
        reload: async () => undefined,
      };
      const member = await signedInUser(t, 'Pinned Member');
      await as(t, admin).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
        role: 'member',
      });
      await as(t, admin).put(`/api/workspaces/${ws.id}/budgets/members/${member.principal.id}`, {
        limitMicroUsd: '100000000',
        period: 'monthly',
      });
      const { logger } = createLogger({ level: 'silent', service: 'pinned-test' });
      const requestId = randomUUID();
      const request = {
        messages: [{ role: 'user' as const, content: 'Price me' }],
        maxOutputTokens: 1000,
      };
      const response: ModelResponse = await handleModelRequest(
        {
          db: t.db,
          catalogue: swapping,
          logger,
          events: valkeyEvents(t.cache, logger),
          cache: t.cache,
          keyPrefix: `feed-pinned-${randomBytes(4).toString('hex')}:`,
          classifier: noClassifier,
          snapshots: policySnapshots({ db: t.db }),
        },
        {
          requestId,
          surface: 'api',
          workspaceId: ws.id,
          principal: member.principal,
          request,
          model: pinnedModel.id,
          conversationId: null,
        },
      );
      for await (const event of response.stream) void event;
      await response.stream.done;

      const pinned = await resolveModel(
        { db: t.db, catalogue: { ...swapping, current: () => before } },
        pinnedModel.id,
      );
      expect(response.reservedMicroUsd).toBe(estimateAttemptCost(request, pinned));
      const rows = await listUsageForRequest(t.db, ws.id, requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.inputMicroUsdPerMtok).toBe(1_000_000);
      const { rows: held } = await t.pool.query<{ amount: string; actual: string; state: string }>(
        `select amount_micro_usd::text as amount, actual_micro_usd::text as actual, state
         from reservations where request_id = $1`,
        [requestId],
      );
      expect(held).toEqual([
        {
          amount: String(response.reservedMicroUsd),
          actual: String(rows[0]?.costMicroUsd),
          state: 'settled',
        },
      ]);
      // The swap happened: anyone reading the store now gets the new price.
      expect(swapping.current().models.get(pinnedModel.id)?.prices.inputMicroUsdPerMtok).toBe(
        9_000_000,
      );
    } finally {
      await fake.close();
    }
  });
});
