import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { StreamInterruptedError, UpstreamUnavailableError } from '@lakka/contracts';
import { commitFirstChunk, FirstChunkTimeoutError } from '../src/gateway/commit.ts';
import type { StartAttempt } from '../src/gateway/commit.ts';

const fast = { firstChunkTimeoutMs: 200, backoffMs: () => 0 };

/** Resolves when the signal aborts, then rejects with its reason. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

interface Script {
  /** Per attempt: 'fail' before the first chunk, 'stall' forever, 'empty', or chunks to yield. */
  attempts: ('fail' | 'stall' | 'empty' | string[])[];
  /** Throw after this many chunks of the last attempt. */
  failAfter?: number;
}

function scripted(script: Script) {
  const log = { started: 0, aborted: [] as number[] };
  const start: StartAttempt<string> = async function* (signal, attempt) {
    log.started += 1;
    signal.addEventListener('abort', () => log.aborted.push(attempt), { once: true });
    const plan = script.attempts[attempt - 1] ?? 'fail';
    if (plan === 'stall') {
      await untilAborted(signal);
      return;
    }
    if (plan === 'fail') throw new Error(`attempt ${attempt} failed`);
    if (plan === 'empty') return;
    for (const [i, chunk] of plan.entries()) {
      if (script.failAfter !== undefined && i >= script.failAfter) throw new Error('mid-stream');
      await sleep(1, undefined, { signal });
      yield chunk;
    }
  };
  return { start, log };
}

describe('commitFirstChunk', () => {
  it('streams every chunk of a healthy first attempt', async () => {
    const { start } = scripted({ attempts: [['a', 'b', 'c']] });
    const stream = await commitFirstChunk(start, { ...fast, maxAttempts: 3 });
    expect(stream.attempts).toBe(1);
    expect(await collect(stream)).toEqual(['a', 'b', 'c']);
  });

  it('invariant 6: retries failures before the first chunk without the client seeing them', async () => {
    const { start, log } = scripted({ attempts: ['fail', 'fail', ['x', 'y']] });
    const retries: number[] = [];
    const stream = await commitFirstChunk(start, {
      ...fast,
      maxAttempts: 3,
      onRetry: ({ attempt }) => retries.push(attempt),
    });
    expect(stream.attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(await collect(stream)).toEqual(['x', 'y']);
    expect(log.started).toBe(3);
  });

  it('invariant 6: a first chunk that takes too long counts as a failure and is aborted', async () => {
    const { start, log } = scripted({ attempts: ['stall', ['ok']] });
    const errors: unknown[] = [];
    const stream = await commitFirstChunk(start, {
      ...fast,
      firstChunkTimeoutMs: 30,
      maxAttempts: 2,
      onRetry: ({ error }) => errors.push(error),
    });
    expect(errors[0]).toBeInstanceOf(FirstChunkTimeoutError);
    expect(log.aborted).toContain(1);
    expect(await collect(stream)).toEqual(['ok']);
  });

  it('treats a stream that ends before its first chunk as a failure', async () => {
    const { start } = scripted({ attempts: ['empty', ['late']] });
    const stream = await commitFirstChunk(start, { ...fast, maxAttempts: 2 });
    expect(stream.attempts).toBe(2);
  });

  it('gives up with UpstreamUnavailableError when every attempt fails before committing', async () => {
    const { start, log } = scripted({ attempts: ['fail', 'fail', 'fail'] });
    await expect(commitFirstChunk(start, { ...fast, maxAttempts: 3 })).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
    expect(log.started).toBe(3);
  });

  it('does not retry errors classified as terminal', async () => {
    const { start, log } = scripted({ attempts: ['fail', ['never']] });
    await expect(
      commitFirstChunk(start, { ...fast, maxAttempts: 3, shouldRetry: () => false }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(log.started).toBe(1);
  });

  it('invariant 6: a failure after the first chunk surfaces and is never retried', async () => {
    const { start, log } = scripted({ attempts: [['a', 'b', 'c', 'd']], failAfter: 2 });
    const stream = await commitFirstChunk(start, { ...fast, maxAttempts: 3 });
    const seen: string[] = [];
    await expect(async () => {
      for await (const chunk of stream) seen.push(chunk);
    }).rejects.toBeInstanceOf(StreamInterruptedError);
    expect(seen).toEqual(['a', 'b']);
    expect(log.started).toBe(1);
  });

  it('stops retrying and rejects with the reason when aborted before committing', async () => {
    const { start, log } = scripted({ attempts: ['stall', ['never']] });
    const controller = new AbortController();
    const pending = commitFirstChunk(start, {
      ...fast,
      firstChunkTimeoutMs: 5000,
      maxAttempts: 3,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('client gone')), 20);
    await expect(pending).rejects.toThrow('client gone');
    expect(log.started).toBe(1);
    expect(log.aborted).toEqual([1]);
  });

  it('aborts the underlying attempt when the client disconnects after committing', async () => {
    const { start, log } = scripted({ attempts: [['a', 'b', 'c', 'd', 'e']] });
    const controller = new AbortController();
    const stream = await commitFirstChunk(start, {
      ...fast,
      maxAttempts: 1,
      signal: controller.signal,
    });
    const seen: string[] = [];
    await expect(async () => {
      for await (const chunk of stream) {
        seen.push(chunk);
        if (seen.length === 2) controller.abort(new Error('client gone'));
      }
    }).rejects.toThrow('client gone');
    expect(seen).toEqual(['a', 'b']);
    expect(log.aborted).toEqual([1]);
  });

  it('can only be read once', async () => {
    const { start } = scripted({ attempts: [['a']] });
    const stream = await commitFirstChunk(start, { ...fast, maxAttempts: 1 });
    await collect(stream);
    await expect(collect(stream)).rejects.toThrow('read once');
  });
});

/** An attempt whose stream fails before its first chunk. */
const failing: StartAttempt<string> = async function* () {
  await Promise.reject(new Error('boom'));
  yield 'never reached';
};

describe('commitFirstChunk decisions (ADR 0040)', () => {
  it('lets onFailure stop with its own error, and waits the delay it asks for', async () => {
    const decisions: number[] = [];
    const stopped = commitFirstChunk(failing, {
      maxAttempts: 3,
      firstChunkTimeoutMs: 100,
      onFailure: (_error, attempt) => {
        decisions.push(attempt);
        return attempt < 2
          ? { retry: true, delayMs: 30 }
          : { retry: false, error: new RangeError('stop here') };
      },
    });
    const started = performance.now();
    await expect(stopped).rejects.toBeInstanceOf(RangeError);
    expect(decisions).toEqual([1, 2]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('consults onFailure on the last attempt too, then gives up', async () => {
    const seen: number[] = [];
    await expect(
      commitFirstChunk(failing, {
        maxAttempts: 2,
        firstChunkTimeoutMs: 100,
        onFailure: (_e, attempt) => {
          seen.push(attempt);
          return { retry: true, delayMs: 0 };
        },
      }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(seen).toEqual([1, 2]);
  });

  it('gives each attempt its own first-chunk window', async () => {
    const windows: number[] = [];
    const { start } = scripted({ attempts: ['stall', ['a']] });
    const committed = await commitFirstChunk(start, {
      maxAttempts: 2,
      firstChunkTimeoutMs: (attempt) => {
        windows.push(attempt === 1 ? 20 : 500);
        return attempt === 1 ? 20 : 500;
      },
      backoffMs: () => 0,
    });
    expect(await collect(committed)).toEqual(['a']);
    expect(windows).toEqual([20, 500]);
  });
});
