import { HealthCheckFailure } from '../health.ts';
import type { HealthCheck } from '../health.ts';
import type { Logger } from '../logger.ts';
import type { Embedder } from './embedder.ts';

/*
 * The classifier's lifecycle in a process (RT-4, invariant 10, ADR 0043). The model loads the
 * first time something needs an embedding, not at startup. If it cannot load, routing is
 * unavailable and every caller falls back as if routing were off; the load is retried after a
 * while, so a transient problem does not disable routing until the next restart. The health
 * check below is the one caller that loads it early.
 */

export type ClassifierStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface ClassifierRuntime {
  /** The embedder, loading it on first use; undefined while routing is unavailable. */
  embedder(): Promise<Embedder | undefined>;
  status(): ClassifierStatus;
}

export interface RuntimeOptions {
  load: () => Promise<Embedder>;
  logger: Logger;
  /** How long to wait after a failed load before trying again. */
  retryAfterMs?: number;
  now?: () => number;
}

export function lazyClassifierRuntime(options: RuntimeOptions): ClassifierRuntime {
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const now = options.now ?? Date.now;
  let status: ClassifierStatus = 'idle';
  let loading: Promise<Embedder | undefined> | undefined;
  let ready: Embedder | undefined;
  let failedAt = 0;

  return {
    status: () => status,
    async embedder() {
      if (ready !== undefined) return ready;
      if (status === 'unavailable' && now() - failedAt < retryAfterMs) return undefined;
      loading ??= (async () => {
        status = 'loading';
        const started = performance.now();
        try {
          ready = await options.load();
          status = 'ready';
          options.logger.info('classifier.loaded', {
            duration_ms: Math.round(performance.now() - started),
          });
          return ready;
        } catch (error) {
          status = 'unavailable';
          failedAt = now();
          options.logger.error('classifier.unavailable', { delay_ms: retryAfterMs }, error);
          return undefined;
        } finally {
          loading = undefined;
        }
      })();
      return loading;
    },
  };
}

/** A runtime that never has a classifier, for processes and tests without one. */
export const noClassifier: ClassifierRuntime = {
  status: () => 'unavailable',
  embedder: () => Promise.resolve(undefined),
};

/**
 * Remembers recent query embeddings (tech spec, Performance and caching). Keyed by the text with
 * whitespace collapsed; held in memory only, never logged or stored.
 */
export function cachingEmbedder(embedder: Embedder, capacity = 1000): Embedder {
  const cache = new Map<string, Float32Array>();
  return {
    modelId: embedder.modelId,
    dimensions: embedder.dimensions,
    async embed(text) {
      const key = text.trim().replace(/\s+/g, ' ');
      const hit = cache.get(key);
      if (hit !== undefined) {
        // Move to the end: Map keeps insertion order, so the first key is the least recent.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const vector = await embedder.embed(key);
      cache.set(key, vector);
      if (cache.size > capacity) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return vector;
    },
  };
}

/**
 * The classifier's entry in /healthz (AD-5, ADR 0081). It loads the model if nothing has yet, so
 * missing or broken weights show on the first health check after startup rather than on the
 * first request that needs routing. A failed load is retried on the runtime's own schedule.
 */
export function classifierHealthCheck(runtime: ClassifierRuntime): HealthCheck {
  return async () => {
    if ((await runtime.embedder()) === undefined) throw new HealthCheckFailure('unavailable');
  };
}
