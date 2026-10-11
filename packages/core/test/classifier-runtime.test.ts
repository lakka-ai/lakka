import { describe, expect, it } from 'vitest';
import { cachingEmbedder, lazyClassifierRuntime } from '../src/classifier/runtime.ts';
import type { Embedder } from '../src/classifier/embedder.ts';
import { createLogger } from '../src/logger.ts';

const { logger } = createLogger({ level: 'silent', service: 'test' });

function countingEmbedder(): Embedder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    modelId: 'counting@1',
    dimensions: 2,
    embed(text) {
      calls.push(text);
      return Promise.resolve(Float32Array.from([1, 0]));
    },
  };
}

describe('classifier runtime (ADR 0043)', () => {
  it('RT-4: loads the model once, on first use, even for concurrent callers', async () => {
    let loads = 0;
    const runtime = lazyClassifierRuntime({
      load: async () => {
        loads += 1;
        return countingEmbedder();
      },
      logger,
    });
    expect(runtime.status()).toBe('idle');
    const [a, b] = await Promise.all([runtime.embedder(), runtime.embedder()]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    expect(runtime.status()).toBe('ready');
  });

  it('invariant 10: a failed load leaves routing unavailable, and is retried only after a while', async () => {
    let clock = 0;
    let attempts = 0;
    const runtime = lazyClassifierRuntime({
      load: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('model missing');
        return countingEmbedder();
      },
      logger,
      retryAfterMs: 1000,
      now: () => clock,
    });
    expect(await runtime.embedder()).toBeUndefined();
    expect(runtime.status()).toBe('unavailable');
    clock = 500;
    expect(await runtime.embedder()).toBeUndefined();
    expect(attempts).toBe(1);
    clock = 1500;
    expect(await runtime.embedder()).toBeDefined();
    expect(attempts).toBe(2);
  });

  it('caches recent query embeddings by text with whitespace collapsed, least recent out first', async () => {
    const inner = countingEmbedder();
    const cached = cachingEmbedder(inner, 2);
    await cached.embed('write  a poem');
    await cached.embed(' write a poem ');
    expect(inner.calls).toEqual(['write a poem']);
    await cached.embed('b text here');
    await cached.embed('write a poem');
    await cached.embed('c text here');
    // "b text here" was the least recently used, so it is the one evicted.
    await cached.embed('b text here');
    expect(inner.calls).toEqual(['write a poem', 'b text here', 'c text here', 'b text here']);
  });
});
