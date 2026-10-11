/*
 * Pure vector helpers for sentence embeddings. Kept free of onnxruntime so they are unit-tested
 * without the model (core unit tests run with no native model and no network).
 */

export interface TokenizedInput {
  ids: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
}

/**
 * Truncates to `maxTokens`, keeping the final token. For BERT-style tokenizers the final token
 * is [SEP], which the model expects to close the sequence.
 */
export function truncate(input: TokenizedInput, maxTokens: number): TokenizedInput {
  if (maxTokens < 2) throw new RangeError('maxTokens must be at least 2');
  if (input.ids.length <= maxTokens) return input;
  const keep = (values: number[]): number[] => [
    ...values.slice(0, maxTokens - 1),
    values[values.length - 1] ?? 0,
  ];
  return {
    ids: keep(input.ids),
    attentionMask: keep(input.attentionMask),
    tokenTypeIds: keep(input.tokenTypeIds),
  };
}

/**
 * Mean of the token vectors where the attention mask is 1. `hidden` is row-major
 * [tokens, dimensions], as returned for a batch of one.
 */
export function meanPool(
  hidden: Float32Array,
  mask: readonly number[],
  dimensions: number,
): Float32Array {
  const tokens = mask.length;
  if (hidden.length !== tokens * dimensions) {
    throw new RangeError(`expected ${tokens * dimensions} values, got ${hidden.length}`);
  }
  const out = new Float32Array(dimensions);
  let counted = 0;
  for (let t = 0; t < tokens; t += 1) {
    if (mask[t] !== 1) continue;
    counted += 1;
    const offset = t * dimensions;
    for (let d = 0; d < dimensions; d += 1) out[d] = (out[d] ?? 0) + (hidden[offset + d] ?? 0);
  }
  if (counted > 0) for (let d = 0; d < dimensions; d += 1) out[d] = (out[d] ?? 0) / counted;
  return out;
}

/** Scales to unit length, so cosine similarity becomes a dot product. */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError('vectors differ in length');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
