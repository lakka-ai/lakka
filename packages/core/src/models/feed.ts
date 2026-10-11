import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  CATALOGUE_FEED_FORMAT,
  catalogueFeedEnvelope,
  catalogueFeedPayload,
  ConfigError,
  FIRST_PARTY_KINDS,
} from '@lakka/contracts';
import type {
  CatalogueFeedEnvelope,
  CatalogueFeedErrorCode,
  CatalogueFeedPayload,
  CatalogueModel,
  ModelPrices,
} from '@lakka/contracts';
import { modelsById } from './catalogue.ts';
import type { Catalogue } from './catalogue.ts';
import type { FeedKey } from './feed-keys.ts';

/*
 * The signed price feed (PR-6, ADR 0116): checking a feed file and merging it into the bundled
 * catalogue. Pure: no network and no database, so the worker, the api and the tests share it.
 *
 * Any failure refuses the whole feed and the catalogue stays as it was. Past the signature, the
 * content is still checked, so even a correctly signed feed cannot make a model free, add a
 * model for a provider the feed has no business pricing, lower a long-context tier, or cut a
 * bundled price to less than a quarter (BG-4, invariant 3). A feed never removes a model.
 */

export const DEFAULT_CATALOGUE_FEED_URL =
  'https://raw.githubusercontent.com/lakka-ai/lakka/main/feed/catalogue-v1.json';

/** Signed before the payload, so a signature made for anything else never verifies here. */
export const FEED_SIGNING_DOMAIN = 'lakka-catalogue-feed-v1\n';
/** The largest feed file read, in bytes. */
export const FEED_MAX_BYTES = 1024 * 1024;
export const FEED_MAX_MODELS = 2000;
/** A feed may not price a bundled model below 1/4 of the bundled price. */
export const FEED_PRICE_DROP_LIMIT = 4;

export type FeedRefusal = { ok: false; code: CatalogueFeedErrorCode };

const refuse = (code: CatalogueFeedErrorCode): FeedRefusal => ({ ok: false, code });

const signedBytes = (payload: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from(FEED_SIGNING_DOMAIN, 'utf8'), payload]);

/** A key's id and the public half to bake in, from either half of an Ed25519 key pair. */
export function feedKeyOf(key: KeyObject): FeedKey {
  const jwk = (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new ConfigError('a price feed key must be an Ed25519 key');
  }
  const keyId = createHash('sha256')
    .update(Buffer.from(jwk.x, 'base64url'))
    .digest('hex')
    .slice(0, 16);
  return { keyId, publicKey: jwk.x };
}

/** The feed file for a payload, signed with an Ed25519 private key. Release tooling and tests. */
export function signFeed(payload: CatalogueFeedPayload, privateKey: KeyObject): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const envelope: CatalogueFeedEnvelope = {
    format: CATALOGUE_FEED_FORMAT,
    keyId: feedKeyOf(privateKey).keyId,
    payload: bytes.toString('base64'),
    signature: sign(null, signedBytes(bytes), privateKey).toString('base64'),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function publicKeyOf(key: FeedKey): KeyObject | undefined {
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey },
      format: 'jwk',
    });
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The payload of a feed file, once its signature checks out against one of `keys`. The payload
 * is parsed only after that, so nothing unsigned is ever looked at.
 */
export function openFeed(
  file: string,
  keys: readonly FeedKey[],
): { ok: true; payload: CatalogueFeedPayload } | FeedRefusal {
  if (Buffer.byteLength(file, 'utf8') > FEED_MAX_BYTES) return refuse('too_large');
  const envelope = catalogueFeedEnvelope.safeParse(parseJson(file));
  if (!envelope.success) return refuse('invalid_feed');
  const key = keys.find((k) => k.keyId === envelope.data.keyId);
  const publicKey = key === undefined ? undefined : publicKeyOf(key);
  if (publicKey === undefined) return refuse('unknown_key');
  const bytes = Buffer.from(envelope.data.payload, 'base64');
  let valid: boolean;
  try {
    valid = verify(
      null,
      signedBytes(bytes),
      publicKey,
      Buffer.from(envelope.data.signature, 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return refuse('bad_signature');
  const payload = catalogueFeedPayload.safeParse(parseJson(bytes.toString('utf8')));
  if (!payload.success) return refuse('invalid_feed');
  return { ok: true, payload: payload.data };
}

const below = (a: number | null, b: number | null) => a !== null && b !== null && a < b;

function lowers(tier: ModelPrices, base: ModelPrices): boolean {
  return (
    tier.inputMicroUsdPerMtok < base.inputMicroUsdPerMtok ||
    tier.outputMicroUsdPerMtok < base.outputMicroUsdPerMtok ||
    below(tier.cacheReadMicroUsdPerMtok, base.cacheReadMicroUsdPerMtok) ||
    below(tier.cacheWriteMicroUsdPerMtok, base.cacheWriteMicroUsdPerMtok)
  );
}

const pricesKey = (m: CatalogueModel) =>
  JSON.stringify([
    m.prices.inputMicroUsdPerMtok,
    m.prices.outputMicroUsdPerMtok,
    m.prices.cacheReadMicroUsdPerMtok,
    m.prices.cacheWriteMicroUsdPerMtok,
    m.tiers.map((t) => [
      t.aboveInputTokens,
      t.prices.inputMicroUsdPerMtok,
      t.prices.outputMicroUsdPerMtok,
      t.prices.cacheReadMicroUsdPerMtok,
      t.prices.cacheWriteMicroUsdPerMtok,
    ]),
  ]);

/** Why one model of a feed is refused, if it is. */
function refusalFor(model: CatalogueModel, bundled: CatalogueModel | undefined) {
  if (!(FIRST_PARTY_KINDS as readonly string[]).includes(model.provider)) {
    return 'untrusted_provider';
  }
  if (model.prices.inputMicroUsdPerMtok === 0 || model.prices.outputMicroUsdPerMtok === 0) {
    return 'zero_price';
  }
  if (model.tiers.some((tier) => lowers(tier.prices, model.prices))) return 'tier_lowers_price';
  if (
    bundled !== undefined &&
    (model.prices.inputMicroUsdPerMtok * FEED_PRICE_DROP_LIMIT <
      bundled.prices.inputMicroUsdPerMtok ||
      model.prices.outputMicroUsdPerMtok * FEED_PRICE_DROP_LIMIT <
        bundled.prices.outputMicroUsdPerMtok)
  ) {
    return 'price_drop';
  }
  return undefined;
}

/**
 * The bundled catalogue with a feed's payload merged in, or why the feed is refused. Bundled
 * ids take the feed's entries; bundled models the feed leaves out keep theirs; models only the
 * feed lists are added below custom models. The serial is the caller's to check first.
 */
export function mergeFeed(
  bundled: Catalogue,
  payload: CatalogueFeedPayload,
): { ok: true; catalogue: Catalogue } | FeedRefusal {
  if (payload.models.length > FEED_MAX_MODELS) return refuse('too_many_models');
  let listed: Map<string, CatalogueModel>;
  try {
    listed = modelsById(payload.models);
  } catch {
    return refuse('invalid_feed');
  }
  const models = new Map(bundled.models);
  const feedOnly = new Map<string, CatalogueModel>();
  const priceUpdated = new Set<string>();
  for (const model of listed.values()) {
    const release = bundled.models.get(model.id);
    const refusal = refusalFor(model, release);
    if (refusal !== undefined) return refuse(refusal);
    if (release === undefined) {
      feedOnly.set(model.id, model);
      priceUpdated.add(model.id);
    } else {
      models.set(model.id, model);
      if (pricesKey(model) !== pricesKey(release)) priceUpdated.add(model.id);
    }
  }
  const { serial, source, sourceCommit, generatedAt } = payload;
  return {
    ok: true,
    catalogue: {
      source: { source, sourceCommit, generatedAt },
      serial,
      models,
      feedOnly,
      priceUpdated,
    },
  };
}
