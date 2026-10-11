import { setTimeout as sleep } from 'node:timers/promises';
import { StreamInterruptedError, UpstreamUnavailableError } from '@lakka/contracts';

/*
 * The streaming commitment window (CLAUDE.md invariant 6, tech spec "The commitment window").
 *
 * Nothing is sent to the client until the first chunk has arrived. Until then a failure, a
 * stream that ends empty, or a first chunk that takes too long can be retried without the client
 * noticing. Once the first chunk is handed over, the stream is committed: later failures are
 * surfaced as StreamInterruptedError and never retried, because switching attempts mid-stream
 * produces output that does not make sense.
 *
 * Framework-free on purpose, so every surface uses the same behaviour and it is unit-tested
 * without HTTP.
 */

/** Starts one attempt. It must stop and reject promptly when `signal` aborts. */
export type StartAttempt<T> = (signal: AbortSignal, attempt: number) => AsyncIterable<T>;

/** What to do after a failed attempt (see CommitOptions.onFailure). */
export type FailureDecision = { retry: true; delayMs: number } | { retry: false; error?: unknown };

export interface CommitOptions {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /**
   * How long an attempt may take to produce its first chunk before it counts as failed. A
   * function gets the attempt number, so each attempt can have its own window.
   */
  firstChunkTimeoutMs: number | ((attempt: number) => number);
  /** Aborts every attempt, e.g. when the client disconnects or the server shuts down. */
  signal?: AbortSignal;
  /** Return false for terminal errors (bad request, content filter) that must not be retried. */
  shouldRetry?: (error: unknown) => boolean;
  /** Delay before attempt n+1. Defaults to exponential backoff with full jitter. */
  backoffMs?: (attempt: number) => number;
  onRetry?: (event: { attempt: number; error: unknown }) => void;
  /**
   * Called after every failed attempt, including the last, and awaited. When given, it replaces
   * shouldRetry and backoffMs: it decides whether to retry and after how long, and can name the
   * error to raise when it stops. Without an error, stopping raises UpstreamUnavailableError.
   */
  onFailure?: (error: unknown, attempt: number) => FailureDecision | Promise<FailureDecision>;
}

export interface CommittedStream<T> extends AsyncIterable<T> {
  /** Which attempt produced the stream (1 when nothing was retried). */
  readonly attempts: number;
}

export class FirstChunkTimeoutError extends Error {
  override readonly name = 'FirstChunkTimeoutError';
}

export class EmptyStreamError extends Error {
  override readonly name = 'EmptyStreamError';
}

export function fullJitterBackoff(baseMs = 100, capMs = 2000): (attempt: number) => number {
  return (attempt) => Math.random() * Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

/**
 * Resolves once some attempt has produced its first chunk, with a stream that yields that chunk
 * and the rest. Rejects with UpstreamUnavailableError when no attempt got that far, or with the
 * abort reason when `signal` aborts first.
 */
export async function commitFirstChunk<T>(
  start: StartAttempt<T>,
  options: CommitOptions,
): Promise<CommittedStream<T>> {
  const { signal } = options;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const backoffMs = options.backoffMs ?? fullJitterBackoff();
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const release = () => {
      signal?.removeEventListener('abort', forwardAbort);
      controller.abort();
    };

    const iterator = start(controller.signal, attempt)[Symbol.asyncIterator]();
    const timeoutMs =
      typeof options.firstChunkTimeoutMs === 'function'
        ? options.firstChunkTimeoutMs(attempt)
        : options.firstChunkTimeoutMs;
    try {
      const first = await firstWithin(iterator, timeoutMs, controller);
      if (first.done === true) throw new EmptyStreamError('stream ended before its first chunk');
      return committed(first.value, iterator, attempt, release, signal);
    } catch (error) {
      release();
      // Do not await: a stuck attempt may never settle. Its signal is already aborted.
      iterator.return?.().catch(() => undefined);
      if (signal?.aborted === true) throw signal.reason;
      lastError = error;
      let delayMs: number;
      if (options.onFailure !== undefined) {
        const decision = await options.onFailure(error, attempt);
        if (!decision.retry) {
          if (decision.error !== undefined) throw decision.error;
          break;
        }
        if (attempt === options.maxAttempts) break;
        delayMs = decision.delayMs;
      } else {
        if (attempt === options.maxAttempts || !shouldRetry(error)) break;
        delayMs = backoffMs(attempt);
      }
      options.onRetry?.({ attempt, error });
      await sleep(delayMs, undefined, signal === undefined ? {} : { signal });
    }
  }
  throw new UpstreamUnavailableError('no attempt produced a first chunk', { cause: lastError });
}

async function firstWithin<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new FirstChunkTimeoutError(`no first chunk within ${timeoutMs} ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function committed<T>(
  first: T,
  iterator: AsyncIterator<T>,
  attempts: number,
  release: () => void,
  signal: AbortSignal | undefined,
): CommittedStream<T> {
  let consumed = false;
  return {
    attempts,
    async *[Symbol.asyncIterator]() {
      if (consumed) throw new Error('a committed stream can only be read once');
      consumed = true;
      try {
        yield first;
        while (true) {
          let next: IteratorResult<T>;
          try {
            next = await iterator.next();
          } catch (error) {
            if (signal?.aborted === true) throw signal.reason;
            throw new StreamInterruptedError('the stream failed after it was committed', {
              cause: error,
            });
          }
          if (next.done === true) return;
          yield next.value;
        }
      } finally {
        release();
        iterator.return?.().catch(() => undefined);
      }
    },
  };
}
