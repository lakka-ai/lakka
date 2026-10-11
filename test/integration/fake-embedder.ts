import { createHash } from 'node:crypto';

/*
 * A deterministic stand-in for the ONNX embedder, for routing tests that need no real model:
 * each word is hashed into one of 64 buckets and the counts are normalized. Texts that share
 * words come out similar, texts that share none come out orthogonal, and nothing loads.
 */

export interface FakeEmbedder {
  modelId: string;
  dimensions: number;
  embed(text: string): Promise<Float32Array>;
}

const DIMENSIONS = 64;

export function fakeEmbedder(modelId = 'fake-embedder@1'): FakeEmbedder {
  return {
    modelId,
    dimensions: DIMENSIONS,
    embed(text) {
      const vector = new Float32Array(DIMENSIONS);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const bucket = createHash('sha256').update(word).digest().readUInt32BE(0) % DIMENSIONS;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      const norm = Math.hypot(...vector);
      return Promise.resolve(norm === 0 ? vector : vector.map((v) => v / norm));
    },
  };
}
