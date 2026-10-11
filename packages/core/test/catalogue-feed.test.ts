import { existsSync, readFileSync } from 'node:fs';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CatalogueFeedNoKeyError, ForbiddenError } from '@lakka/contracts';
import type {
  CatalogueFeedErrorCode,
  CatalogueFeedPayload,
  CatalogueModel,
  Principal,
} from '@lakka/contracts';
import type { CatalogueFeedSchedule, Db } from '@lakka/db';
import { createLogger } from '../src/logger.ts';
import { fixedCatalogue, loadCatalogue, parseCatalogue } from '../src/models/catalogue.ts';
import type { Catalogue } from '../src/models/catalogue.ts';
import {
  FEED_MAX_BYTES,
  FEED_MAX_MODELS,
  feedKeyOf,
  mergeFeed,
  openFeed,
  signFeed,
} from '../src/models/feed.ts';
import { checkCatalogueFeed, feedCheckDue, nextScheduledCheck } from '../src/models/feed-check.ts';
import type { FeedCheckContext, FeedRecords } from '../src/models/feed-check.ts';
import { PRODUCTION_FEED_KEYS } from '../src/models/feed-keys.ts';
import type { FeedKey } from '../src/models/feed-keys.ts';
import { changeCatalogueFeed } from '../src/models/feed-service.ts';

/*
 * The signed price feed (PR-6, ADR 0116): signatures, the checks on content, the merge, and the
 * worker's check with an injected fetch and fake records. No network, no database. Every key
 * here is generated for the test; none is a production key.
 */

const { logger } = createLogger({ level: 'silent', service: 'test' });

function testKey(): { privateKey: KeyObject; key: FeedKey } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, key: feedKeyOf(privateKey) };
}

const signer = testKey();
const keys = [signer.key];

const model = (id: string, input: number, output: number, extra: Partial<CatalogueModel> = {}) => {
  const [provider = '', name = ''] = id.split(':');
  return {
    id,
    provider,
    model: name,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    capabilities: {
      vision: true,
      pdf: false,
      tools: true,
      structuredOutput: true,
      promptCaching: false,
      reasoning: false,
    },
    prices: {
      inputMicroUsdPerMtok: input,
      outputMicroUsdPerMtok: output,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
    tiers: [],
    ...extra,
  } satisfies CatalogueModel;
};

const head = {
  source: 'https://example.com/prices.json',
  sourceCommit: 'b'.repeat(40),
  license: 'MIT',
  generatedAt: '2026-10-01',
};

const bundled: Catalogue = parseCatalogue({
  serial: 5,
  ...head,
  models: [
    model('anthropic:claude-test', 3_000_000, 15_000_000),
    model('openai:gpt-test', 1_000_000, 4_000_000),
  ],
});

const payload = (patch: Partial<CatalogueFeedPayload> = {}): CatalogueFeedPayload => ({
  serial: 6,
  ...head,
  issuedAt: '2026-10-06T08:00:00Z',
  models: [
    model('anthropic:claude-test', 2_500_000, 12_500_000),
    model('openai:gpt-test', 1_000_000, 4_000_000),
  ],
  ...patch,
});

const refusedWith = (code: CatalogueFeedErrorCode) => ({ ok: false, code });

/** Rewrites one field of a signed file's envelope, keeping it well formed. */
function tamper(file: string, change: (envelope: Record<string, string | number>) => void) {
  const envelope = JSON.parse(file) as Record<string, string | number>;
  change(envelope);
  return JSON.stringify(envelope);
}

describe('signed price feed: signatures (PR-6, ADR 0116)', () => {
  it('PR-6: a feed signed by a known key verifies, and one changed byte is refused', () => {
    const file = signFeed(payload(), signer.privateKey);
    const opened = openFeed(file, keys);
    expect(opened).toMatchObject({ ok: true, payload: { serial: 6 } });

    const changedPayload = tamper(file, (e) => {
      const bytes = Buffer.from(String(e['payload']), 'base64');
      // "2500000" becomes "2500001" somewhere in the prices: still valid JSON, still a price.
      const at = bytes.indexOf('2500000');
      bytes[at + 6] = '1'.charCodeAt(0);
      e['payload'] = bytes.toString('base64');
    });
    expect(openFeed(changedPayload, keys)).toEqual(refusedWith('bad_signature'));

    const changedSignature = tamper(file, (e) => {
      const bytes = Buffer.from(String(e['signature']), 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      e['signature'] = bytes.toString('base64');
    });
    expect(openFeed(changedSignature, keys)).toEqual(refusedWith('bad_signature'));
  });

  it('PR-6: a feed from an unknown key, or signed without the domain line, is refused', () => {
    const stranger = testKey();
    expect(openFeed(signFeed(payload(), stranger.privateKey), keys)).toEqual(
      refusedWith('unknown_key'),
    );
    // The same key, over the payload alone: a signature made for anything else never verifies.
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8');
    const bare = JSON.stringify({
      format: 1,
      keyId: signer.key.keyId,
      payload: bytes.toString('base64'),
      signature: sign(null, bytes, signer.privateKey).toString('base64'),
    });
    expect(openFeed(bare, keys)).toEqual(refusedWith('bad_signature'));
  });

  it('PR-6: a malformed file, another format or an unsigned payload field is refused', () => {
    const file = signFeed(payload(), signer.privateKey);
    expect(openFeed('not json', keys)).toEqual(refusedWith('invalid_feed'));
    expect(
      openFeed(
        tamper(file, (e) => (e['format'] = 2)),
        keys,
      ),
    ).toEqual(refusedWith('invalid_feed'));
    expect(
      openFeed(
        tamper(file, (e) => (e['extra'] = 'x')),
        keys,
      ),
    ).toEqual(refusedWith('invalid_feed'));
    // Signed, but not a catalogue: refused after the signature, never trusted.
    const notCatalogue = { ...payload(), models: [] } as CatalogueFeedPayload;
    expect(openFeed(signFeed(notCatalogue, signer.privateKey), keys)).toEqual(
      refusedWith('invalid_feed'),
    );
  });

  it('PR-6: a file over 1 MB is refused before it is parsed', () => {
    expect(openFeed(' '.repeat(FEED_MAX_BYTES + 1), keys)).toEqual(refusedWith('too_large'));
  });
});

describe('signed price feed: what it may change (PR-6, ADR 0116)', () => {
  it('PR-6: bundled ids take the feed prices and the changed ones are marked', () => {
    const merged = mergeFeed(bundled, payload());
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.catalogue.serial).toBe(6);
    expect(merged.catalogue.models.get('anthropic:claude-test')?.prices.inputMicroUsdPerMtok).toBe(
      2_500_000,
    );
    expect([...merged.catalogue.priceUpdated]).toEqual(['anthropic:claude-test']);
  });

  it('PR-6: a feed never removes a bundled model; models it adds are feed-only', () => {
    const merged = mergeFeed(
      bundled,
      payload({ models: [model('google:gemini-test', 500_000, 2_000_000)] }),
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect([...merged.catalogue.models.keys()]).toEqual([
      'anthropic:claude-test',
      'openai:gpt-test',
    ]);
    expect(merged.catalogue.models.get('openai:gpt-test')?.prices.inputMicroUsdPerMtok).toBe(
      1_000_000,
    );
    expect([...merged.catalogue.feedOnly.keys()]).toEqual(['google:gemini-test']);
    expect(merged.catalogue.priceUpdated.has('google:gemini-test')).toBe(true);
  });

  it('PR-6, BG-4: a zero price refuses the whole feed', () => {
    for (const [input, output] of [
      [0, 1_000_000],
      [1_000_000, 0],
    ] as const) {
      expect(
        mergeFeed(
          bundled,
          payload({
            models: [
              model('anthropic:claude-test', 3_000_000, 15_000_000),
              model('google:gemini-free', input, output),
            ],
          }),
        ),
      ).toEqual(refusedWith('zero_price'));
    }
  });

  it('PR-6: a provider that is not first-party refuses the whole feed', () => {
    expect(mergeFeed(bundled, payload({ models: [model('ollama:llama-test', 1, 1)] }))).toEqual(
      refusedWith('untrusted_provider'),
    );
  });

  it('PR-6: every first-party provider is trusted, compatible ones included', () => {
    const merged = mergeFeed(
      bundled,
      payload({ models: [model('deepseek:deepseek-test', 300_000, 1_200_000)] }),
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect([...merged.catalogue.feedOnly.keys()]).toEqual(['deepseek:deepseek-test']);
  });

  it('PR-6: a long-context tier that lowers a price refuses the whole feed', () => {
    const lowering = model('anthropic:claude-test', 3_000_000, 15_000_000, {
      tiers: [
        {
          aboveInputTokens: 100_000,
          prices: {
            inputMicroUsdPerMtok: 2_000_000,
            outputMicroUsdPerMtok: 20_000_000,
            cacheReadMicroUsdPerMtok: null,
            cacheWriteMicroUsdPerMtok: null,
          },
        },
      ],
    });
    expect(mergeFeed(bundled, payload({ models: [lowering] }))).toEqual(
      refusedWith('tier_lowers_price'),
    );
  });

  it('PR-6: a cut below a quarter of a bundled price refuses the whole feed', () => {
    // A quarter is allowed; less is not, for input or output.
    expect(
      mergeFeed(bundled, payload({ models: [model('anthropic:claude-test', 750_000, 3_750_000)] }))
        .ok,
    ).toBe(true);
    expect(
      mergeFeed(
        bundled,
        payload({ models: [model('anthropic:claude-test', 749_999, 15_000_000)] }),
      ),
    ).toEqual(refusedWith('price_drop'));
    expect(
      mergeFeed(bundled, payload({ models: [model('openai:gpt-test', 1_000_000, 999_999)] })),
    ).toEqual(refusedWith('price_drop'));
  });

  it('PR-6: more than 2000 models, or one listed twice, refuses the whole feed', () => {
    const many = Array.from({ length: FEED_MAX_MODELS + 1 }, (_, i) =>
      model(`openai:gpt-many-${i}`, 1_000_000, 1_000_000),
    );
    expect(mergeFeed(bundled, payload({ models: many }))).toEqual(refusedWith('too_many_models'));
    const twice = model('openai:gpt-test', 1_000_000, 4_000_000);
    expect(mergeFeed(bundled, payload({ models: [twice, twice] }))).toEqual(
      refusedWith('invalid_feed'),
    );
  });
});

/** The feed's row in memory, recording what the job did to it. */
function fakeRecords(initial: Partial<CatalogueFeedSchedule> = {}, stored?: string) {
  const applied = initial.appliedSerial ?? null;
  const state = {
    schedule: {
      enabled: true,
      appliedSerial: null,
      lastCheckedAt: null,
      checkRequestedAt: null,
      checkMinute: 600,
      ...initial,
    } as CatalogueFeedSchedule,
    // The stored file for the stored serial, signed by the test key unless given.
    envelope:
      stored ??
      (applied === null ? null : signFeed(payload({ serial: applied }), signer.privateKey)),
    results: [] as { result: string; errorCode: string | null }[],
  };
  const records: FeedRecords = {
    schedule: async () => ({ ...state.schedule }),
    stored: async () => state.envelope,
    apply: async (envelope, serial, at, expected) => {
      if (state.schedule.appliedSerial !== expected) return false;
      state.envelope = envelope;
      state.schedule = { ...state.schedule, appliedSerial: serial, lastCheckedAt: at };
      state.results.push({ result: 'applied', errorCode: null });
      return true;
    },
    record: async (at, result, errorCode) => {
      state.schedule = { ...state.schedule, lastCheckedAt: at, checkRequestedAt: null };
      state.results.push({ result, errorCode });
    },
  };
  return { state, records };
}

/** A fetch that answers with `file` and counts its calls. */
function serving(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const FEED_URL = 'https://feed.example.com/catalogue-v1.json';
const NOW = new Date('2026-10-06T10:00:00Z');

function context(records: FeedRecords, fetch: typeof globalThis.fetch): FeedCheckContext {
  return { records, logger, bundled, keys, url: FEED_URL, fetch, timeoutMs: 200 };
}

describe('signed price feed: the worker check (PR-6, ADR 0116)', () => {
  it('NF-P2: with the feed off the job makes no network call', async () => {
    const { records } = fakeRecords({ enabled: false, checkRequestedAt: NOW });
    const net = serving(async () => new Response(signFeed(payload(), signer.privateKey)));
    expect(await checkCatalogueFeed(context(records, net.fetch), NOW)).toBe('off');
    // Locked off by the operator, or no key in this build: no call either.
    const on = fakeRecords().records;
    expect(await checkCatalogueFeed({ ...context(on, net.fetch), url: null }, NOW)).toBe('off');
    expect(await checkCatalogueFeed({ ...context(on, net.fetch), keys: [] }, NOW)).toBe('off');
    expect(net.calls).toHaveLength(0);
  });

  it('PR-6: applies a newer verified feed, sending nothing about the instance', async () => {
    const { state, records } = fakeRecords();
    const file = signFeed(payload(), signer.privateKey);
    const net = serving(async () => new Response(file));
    expect(await checkCatalogueFeed(context(records, net.fetch), NOW)).toBe('applied');
    expect(state.envelope).toBe(file);
    expect(state.schedule.appliedSerial).toBe(6);
    expect(net.calls).toHaveLength(1);
    const init = net.calls[0]?.init;
    expect(net.calls[0]?.url).toBe(FEED_URL);
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ 'user-agent': 'lakka' });
  });

  it('PR-6: an equal serial is unchanged; an older one is a replay and refused', async () => {
    const same = fakeRecords({ appliedSerial: 6 });
    const file = signFeed(payload(), signer.privateKey);
    expect(
      await checkCatalogueFeed(
        context(same.records, serving(async () => new Response(file)).fetch),
        NOW,
      ),
    ).toBe('unchanged');
    expect(same.state.results).toEqual([{ result: 'unchanged', errorCode: null }]);

    const newer = fakeRecords({ appliedSerial: 7 });
    expect(
      await checkCatalogueFeed(
        context(newer.records, serving(async () => new Response(file)).fetch),
        NOW,
      ),
    ).toBe('failed');
    expect(newer.state.results).toEqual([{ result: 'failed', errorCode: 'not_newer' }]);
    expect(newer.state.schedule.appliedSerial).toBe(7);
  });

  it('PR-6: a stored feed whose key is no longer trusted does not block newer feeds', async () => {
    // After a key compromise: a feed with a huge serial, signed by a key a release removed.
    const removed = testKey();
    const { state, records } = fakeRecords(
      { appliedSerial: 1_000_000 },
      signFeed(payload({ serial: 1_000_000 }), removed.privateKey),
    );
    const file = signFeed(payload(), signer.privateKey);
    expect(
      await checkCatalogueFeed(
        context(records, serving(async () => new Response(file)).fetch),
        NOW,
      ),
    ).toBe('applied');
    expect(state.schedule.appliedSerial).toBe(6);
  });

  it('PR-6: a feed no newer than the bundled catalogue is ignored', async () => {
    for (const serial of [4, 5]) {
      const { state, records } = fakeRecords();
      const file = signFeed(payload({ serial }), signer.privateKey);
      const net = serving(async () => new Response(file));
      expect(await checkCatalogueFeed(context(records, net.fetch), NOW)).toBe('unchanged');
      expect(state.envelope).toBeNull();
    }
  });

  it('PR-6: a refused feed records why and stores nothing', async () => {
    const { state, records } = fakeRecords();
    const file = signFeed(
      payload({ models: [model('anthropic:claude-test', 1, 15_000_000)] }),
      signer.privateKey,
    );
    expect(
      await checkCatalogueFeed(
        context(records, serving(async () => new Response(file)).fetch),
        NOW,
      ),
    ).toBe('failed');
    expect(state.results).toEqual([{ result: 'failed', errorCode: 'price_drop' }]);
    expect(state.envelope).toBeNull();
  });

  it('PR-6: a redirect, non-200, over 1 MB or a timeout keeps the previous catalogue', async () => {
    const cases: [() => Promise<Response>, CatalogueFeedErrorCode][] = [
      // What fetch does with redirect: 'error' when the server redirects.
      [async () => Promise.reject(new TypeError('fetch failed')), 'unreachable'],
      [
        async () => new Response(null, { status: 302, headers: { location: 'https://x' } }),
        'http_status',
      ],
      [async () => new Response('gone', { status: 404 }), 'http_status'],
      [async () => new Response('x'.repeat(FEED_MAX_BYTES + 1)), 'too_large'],
      [
        async () =>
          new Response('{}', { headers: { 'content-length': String(FEED_MAX_BYTES + 1) } }),
        'too_large',
      ],
    ];
    for (const [answer, code] of cases) {
      const { state, records } = fakeRecords({ appliedSerial: 6 });
      state.envelope = 'previous';
      expect(await checkCatalogueFeed(context(records, serving(answer).fetch), NOW)).toBe('failed');
      expect(state.results).toEqual([{ result: 'failed', errorCode: code }]);
      expect(state.envelope).toBe('previous');
      expect(state.schedule.appliedSerial).toBe(6);
    }

    // A server that never answers is given up on.
    const { state, records } = fakeRecords();
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    expect(await checkCatalogueFeed(context(records, hanging), NOW)).toBe('failed');
    expect(state.results).toEqual([{ result: 'failed', errorCode: 'timeout' }]);
  });

  it('PR-6: checks once a day at the instance minute, or at once when asked', () => {
    const base = {
      enabled: true,
      appliedSerial: null,
      checkRequestedAt: null,
      checkMinute: 600,
    };
    const checkedAt = new Date('2026-10-06T10:00:30Z');
    expect(nextScheduledCheck(checkedAt, 600).toISOString()).toBe('2026-10-07T10:00:00.000Z');
    expect(nextScheduledCheck(new Date('2026-10-06T09:00:00Z'), 600).toISOString()).toBe(
      '2026-10-06T10:00:00.000Z',
    );
    const schedule = { ...base, lastCheckedAt: checkedAt };
    expect(feedCheckDue(schedule, new Date('2026-10-07T09:59:00Z'))).toBe(false);
    expect(feedCheckDue(schedule, new Date('2026-10-07T10:00:05Z'))).toBe(true);
    expect(feedCheckDue({ ...schedule, checkRequestedAt: checkedAt }, checkedAt)).toBe(true);
    expect(feedCheckDue({ ...base, lastCheckedAt: null }, checkedAt)).toBe(true);
  });
});

describe('signed price feed: switching it on (PR-6, ADR 0116)', () => {
  const admin: Principal = {
    kind: 'user',
    id: '00000000-0000-7000-8000-000000000001',
    actingUserId: '00000000-0000-7000-8000-000000000001',
    isInstanceAdmin: true,
  } as Principal;

  // Refused before Postgres is touched, so no database is needed to show it.
  const noDb = {} as Db;
  const ctx = (feedKeys: readonly FeedKey[]) => ({
    db: noDb,
    catalogue: fixedCatalogue(bundled),
    logger,
    feed: { url: FEED_URL, keys: feedKeys },
  });

  it('PR-6: with an empty production keyring the feed cannot be enabled', async () => {
    // This build ships with an empty keyring until the owner adds the keys (feed-keys.ts).
    await expect(changeCatalogueFeed(ctx([]), admin, true)).rejects.toBeInstanceOf(
      CatalogueFeedNoKeyError,
    );
  });

  it('PR-6: a key, even an instance admin key, cannot switch it', async () => {
    const key = { ...admin, kind: 'key' } as Principal;
    await expect(changeCatalogueFeed(ctx(keys), key, true)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('the production feed keys and the committed feed (PR-6, ADR 0116)', () => {
  it('PR-6: every baked-in key is an Ed25519 key whose id matches it', () => {
    for (const key of PRODUCTION_FEED_KEYS) {
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey },
        format: 'jwk',
      });
      expect(feedKeyOf(publicKey)).toEqual(key);
    }
    expect(new Set(PRODUCTION_FEED_KEYS.map((k) => k.keyId)).size).toBe(
      PRODUCTION_FEED_KEYS.length,
    );
  });

  const feedPath = fileURLToPath(new URL('../../../feed/catalogue-v1.json', import.meta.url));
  // Skipped in a tree with no signed feed, such as a fork that has not published one.
  it.skipIf(!existsSync(feedPath))(
    'PR-6: the committed feed verifies and equals models.json',
    () => {
      const opened = openFeed(readFileSync(feedPath, 'utf8'), PRODUCTION_FEED_KEYS);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const { issuedAt: _issuedAt, ...catalogue } = opened.payload;
      const release = JSON.parse(
        readFileSync(new URL('../catalogue/models.json', import.meta.url), 'utf8'),
      ) as unknown;
      expect(catalogue).toEqual(release);
      expect(loadCatalogue().serial).toBe(opened.payload.serial);
    },
  );
});
