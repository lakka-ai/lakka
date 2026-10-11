import {
  filesOf,
  ContentFilteredError,
  ContextTooLongError,
  OutputTooLongError,
  ProviderAuthError,
  ProviderNotConfiguredError,
  ProviderRequestRejectedError,
  UnknownModelError,
  UnsupportedInputError,
  UpstreamUnavailableError,
} from '@lakka/contracts';
import type {
  GatewayRequest,
  GatewayStreamEvent,
  ModelView,
  Principal,
  Surface,
  TokenUsage,
  UsageOutcome,
} from '@lakka/contracts';
import { insertSpanContent } from '@lakka/db';
import type { Db } from '@lakka/db';
import { context as otelContext, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Span, Tracer } from '@opentelemetry/api';
import { priceUsage } from '../costs/pricing.ts';
import type { PricedUsage } from '../costs/pricing.ts';
import { recordUsage } from '../costs/record.ts';
import type { UsageRouting } from '../costs/record.ts';
import type { Logger } from '../logger.ts';
import { capturedPrompt, capturedResponse } from '../observability/capture.ts';
import type { CapturedReply } from '../observability/capture.ts';
import type { CatalogueStore } from '../models/catalogue.ts';
import { resolveModel } from '../models/service.ts';
import { resolveProviderConnection } from '../providers/service.ts';
import { classifyFailure, IdleTimeoutError } from './classify.ts';
import type { Failure } from './classify.ts';
import { commitFirstChunk, fullJitterBackoff } from './commit.ts';
import type { FailureDecision } from './commit.ts';
import { estimateInputTokens, estimateTextTokens } from './estimate.ts';
import { streamModelCall } from './model-call.ts';
import { languageModel } from './providers.ts';
import type { ProviderConnection } from './providers.ts';
import {
  ERROR_TYPE,
  GEN_AI,
  LK,
  requestAttributes,
  routingAttributes,
  usageAttributes,
} from './telemetry.ts';

/*
 * The provider gateway's one entry point (tech spec, Provider gateway; ADR 0040). Given a
 * request and an ordered list of candidate models (the chosen model, then its fallbacks), it:
 *
 *   1. checks every candidate before sending anything: known price (BG-4), a credential for the
 *      workspace (PR-8), room for the input and the requested output, support for the request's
 *      images and PDFs (CH-5), and the failover scope
 *      (the same provider family unless the caller allows crossing, D9);
 *   2. tries candidates inside the commitment window (invariant 6): a failure before the first
 *      chunk is retried on the same model or failed over to the next, as classified; after the
 *      first chunk nothing is retried and the error reaches the caller;
 *   3. records usage for every attempt that may have cost money, on every exit path: completed,
 *      interrupted, aborted, and abandoned inside the window (BG-8, invariant 4);
 *   4. traces it: a gateway.dispatch span for the request, with a GenAI chat span per attempt
 *      (OB-1, OB-2, ADR 0041). Spans carry counts, cost and outcomes, never content (OB-4).
 *
 * Surfaces call this; it knows nothing about HTTP. Budget reservation (M4) will wrap it.
 */

export interface DispatchTimeouts {
  /** First-chunk window for ordinary models. */
  firstChunkMs: number;
  /** First-chunk window for reasoning models, which think before they write. */
  reasoningFirstChunkMs: number;
  /** Longest silence allowed once a stream is committed. */
  idleMs: number;
  reasoningIdleMs: number;
}

export const DEFAULT_TIMEOUTS: DispatchTimeouts = {
  firstChunkMs: 30_000,
  reasoningFirstChunkMs: 180_000,
  idleMs: 60_000,
  reasoningIdleMs: 180_000,
};

export interface DispatchContext {
  db: Db;
  catalogue: CatalogueStore;
  logger: Logger;
  /** Replaces global fetch for provider calls; tests point it at a fake provider. */
  fetch?: typeof fetch;
  timeouts?: Partial<DispatchTimeouts>;
  /** Attempts on one model before failing over. */
  attemptsPerModel?: number;
  /** A Retry-After longer than this fails over instead of waiting. */
  maxRetryAfterMs?: number;
  /** Backoff before retrying the same model. */
  backoffMs?: (attempt: number) => number;
  /** Where spans go. Defaults to the global tracer, which does nothing until one is set up. */
  tracer?: Tracer;
}

export interface DispatchRequest {
  requestId: string;
  surface: Surface;
  workspaceId: string;
  principal: Principal;
  request: GatewayRequest;
  /** Model references in order of preference: the chosen model first, then fallbacks. */
  candidates: readonly string[];
  /** Fail over to other provider families too (D9). Off by default. */
  allowCrossProvider?: boolean;
  /** Which rule chose the candidates, recorded with every attempt's usage (RT-8). */
  routing: UsageRouting;
  /** Aborts the whole request, for a client that went away or a server shutting down. */
  signal?: AbortSignal;
  /** The surface's request span, so dispatch spans nest under it. */
  traceContext?: Context;
  /**
   * The number the first attempt is recorded under. A tool loop calls dispatch once per round
   * under one request id, and numbering continues across rounds (ADR 0071). 1 when omitted.
   */
  firstAttempt?: number;
  /**
   * Set when the workspace records prompts and replies (OB-4, ADR 0077): each attempt's are kept
   * in span_content for this many days. Absent, nothing of what was said is kept anywhere.
   */
  capture?: { retentionDays: number };
}

export interface DispatchSummary {
  model: string;
  attempts: number;
  outcome: UsageOutcome;
  costMicroUsd: bigint;
  finishReason: string | null;
}

/** A committed stream. Read it to the end, stop early, or abort the request's signal. */
export interface DispatchedStream extends AsyncIterable<GatewayStreamEvent> {
  /** The model that produced the stream. */
  readonly model: ModelView;
  /** Attempts it took, across candidates, including the one that committed. */
  readonly attempts: number;
  /** Settles once the stream has ended and its usage is recorded. */
  readonly done: Promise<DispatchSummary>;
}

interface Candidate {
  model: ModelView;
  connection: ProviderConnection;
  providerConfigId: string | null;
  maxOutputTokens: number;
}

/** A candidate that cannot be used, and why. Its provider is known unless the model is not. */
type Skip = { ref: string; error: Error; provider: string | null };

interface AttemptState {
  candidate: Candidate;
  span: Span;
  spanEnded: boolean;
  startedAt: number;
  firstEventAt: number | null;
  outputText: string;
  finish: Extract<GatewayStreamEvent, { type: 'finish' }> | null;
  /** The reply as it arrives, kept only while the workspace records content. */
  captured: CapturedReply | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Checks one candidate; returns it ready to call, or why it cannot be used. */
async function prepare(
  ctx: DispatchContext,
  req: DispatchRequest,
  ref: string,
  inputEstimate: number,
): Promise<Candidate | Skip> {
  let model: ModelView;
  try {
    model = await resolveModel(ctx, ref);
  } catch (error) {
    if (error instanceof UnknownModelError) return { ref, error, provider: null };
    throw error;
  }
  const skip = (error: Error): Skip => ({ ref, error, provider: model.provider });
  if (inputEstimate > model.contextWindow) {
    return skip(new ContextTooLongError('the input does not fit this model'));
  }
  const requested = req.request.maxOutputTokens;
  if (requested !== undefined && requested > model.maxOutputTokens) {
    return skip(new OutputTooLongError('this model cannot produce that much output'));
  }
  // A model that cannot read the request's files is passed over before anything is sent (CH-5).
  const files = req.request.messages.flatMap((m) => filesOf(m.content));
  if (!model.capabilities.vision && files.some((f) => f.mediaType.startsWith('image/'))) {
    return skip(new UnsupportedInputError('this model cannot read images'));
  }
  if (!model.capabilities.pdf && files.some((f) => f.mediaType === 'application/pdf')) {
    return skip(new UnsupportedInputError('this model cannot read PDF files'));
  }
  // A request offering tools needs a model that can call them (ADR 0071).
  if (!model.capabilities.tools && req.request.tools !== undefined) {
    return skip(new UnsupportedInputError('this model cannot call tools'));
  }
  let connection: ProviderConnection;
  try {
    connection = await resolveProviderConnection(ctx, req.workspaceId, model.provider);
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) return skip(error);
    throw error;
  }
  return {
    model,
    connection: ctx.fetch === undefined ? connection : { ...connection, fetch: ctx.fetch },
    providerConfigId: connection.configId ?? null,
    // Always sent explicitly, so the provider never produces more than the budget estimate.
    maxOutputTokens: requested ?? model.maxOutputTokens,
  };
}

const isSkip = (c: Candidate | Skip): c is Skip => 'error' in c;

const errorCode = (error: unknown): string =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : error instanceof Error
      ? error.name
      : 'unknown';

function endSpan(span: Span, errorType: string | null): void {
  if (errorType === null) {
    span.setStatus({ code: SpanStatusCode.OK });
  } else {
    span.setAttribute(ERROR_TYPE, errorType);
    // The status message stays generic: provider error text can echo request content.
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

function terminalError(failure: Failure, cause: unknown): Error | undefined {
  switch (failure.kind) {
    case 'auth':
      return new ProviderAuthError('the provider refused the configured credential', { cause });
    case 'content_filter':
      return new ContentFilteredError("the provider's content filter refused this request", {
        cause,
      });
    case 'bad_request':
      return new ProviderRequestRejectedError('the provider rejected this request', { cause });
    default:
      return undefined;
  }
}

/** Stops waiting for the next chunk after `ms` of silence and aborts the attempt. */
async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  ms: number,
  abort: (reason: Error) => void,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let first = true;
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const next = first
        ? iterator.next()
        : Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const error = new IdleTimeoutError(`no chunk for ${ms} ms`);
                abort(error);
                reject(error);
              }, ms);
            }),
          ]);
      first = false;
      try {
        const result = await next;
        if (result.done === true) return;
        yield result.value;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

export async function dispatch(
  ctx: DispatchContext,
  req: DispatchRequest,
): Promise<DispatchedStream> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...ctx.timeouts };
  const attemptsPerModel = ctx.attemptsPerModel ?? 2;
  const maxRetryAfterMs = ctx.maxRetryAfterMs ?? 10_000;
  const backoffMs = ctx.backoffMs ?? fullJitterBackoff(250, 4_000);
  const typicalInput = estimateInputTokens(req.request, 'typical');
  const upperInput = estimateInputTokens(req.request, 'upper');
  const tracer = ctx.tracer ?? trace.getTracer('lakka.gateway');
  const parentContext = req.traceContext ?? otelContext.active();
  const dispatchSpan = tracer.startSpan(
    'gateway.dispatch',
    {
      attributes: {
        [LK.REQUEST_ID]: req.requestId,
        [LK.WORKSPACE_ID]: req.workspaceId,
        [LK.SURFACE]: req.surface,
        ...routingAttributes(req.routing),
      },
    },
    parentContext,
  );
  const attemptContext = trace.setSpan(parentContext, dispatchSpan);
  try {
    return await dispatchWithin();
  } catch (error) {
    endSpan(dispatchSpan, errorCode(error));
    throw error;
  }

  async function dispatchWithin(): Promise<DispatchedStream> {
    // 1. Every candidate is checked before anything is sent.
    const [firstRef, ...fallbackRefs] = req.candidates;
    if (firstRef === undefined) throw new UnknownModelError('no model was chosen');
    const first = await prepare(ctx, req, firstRef, typicalInput);
    if (isSkip(first) && first.error instanceof UnknownModelError) throw first.error;
    const skipped: Skip[] = isSkip(first) ? [first] : [];
    const usable: Candidate[] = isSkip(first) ? [] : [first];
    // The failover scope is the preferred model's provider, even when that model itself is out.
    const family = isSkip(first) ? first.provider : first.model.provider;
    for (const ref of fallbackRefs) {
      const prepared = await prepare(ctx, req, ref, typicalInput);
      if (isSkip(prepared)) {
        skipped.push(prepared);
      } else if (req.allowCrossProvider === true || prepared.model.provider === family) {
        usable.push(prepared);
      }
    }
    for (const skip of skipped) {
      dispatchSpan.addEvent('lakka.candidate_skipped', {
        [LK.MODEL]: skip.ref,
        [ERROR_TYPE]: errorCode(skip.error),
      });
    }
    if (usable.length === 0) {
      // Nothing can take the request; say why the preferred model could not.
      throw skipped[0]?.error ?? new UnknownModelError('no usable model');
    }

    // 2. Attempts, inside the commitment window.
    const attempts = new Map<number, AttemptState>();
    const recorded = new Set<number>();
    let index = 0;
    let triesOnCurrent = 0;
    let sawContextOverflow = false;
    // Set in onFailure, which the compiler cannot see run, so it lives in an object.
    const last: {
      failure: { kind: Failure['kind']; retryAfterMs: number | null; provider: string } | null;
    } = { failure: null };
    const current = () => usable[index] as Candidate; // index never passes usable.length: see onFailure
    const isReasoning = (c: Candidate) => c.model.capabilities.reasoning;

    const record = async (
      state: AttemptState,
      attempt: number,
      outcome: UsageOutcome,
      usage: TokenUsage | null,
    ): Promise<PricedUsage> => {
      recorded.add(attempt);
      const c = state.candidate;
      const visibleOutput = estimateTextTokens(state.outputText, 'upper');
      // A reasoning model may have thought without showing it; without a usage report the only
      // safe reading is everything it was allowed to produce.
      const outputEstimate =
        isReasoning(c) && outcome !== 'abandoned' ? c.maxOutputTokens : visibleOutput;
      const priced = priceUsage(usage, c.model, {
        inputTokens: upperInput,
        outputTokens: outputEstimate,
      });
      const now = performance.now();
      await recordUsage(ctx, {
        requestId: req.requestId,
        attempt: attempt + (req.firstAttempt ?? 1) - 1,
        outcome,
        surface: req.surface,
        workspaceId: req.workspaceId,
        principal: req.principal,
        model: c.model.id,
        provider: c.model.provider,
        providerConfigId: c.providerConfigId,
        priced,
        finishReason: state.finish?.finishReason ?? null,
        latencyMs: now - state.startedAt,
        ttftMs: state.firstEventAt === null ? null : state.firstEventAt - state.startedAt,
        routing: req.routing,
      });
      state.span.setAttributes({ ...usageAttributes(priced), [LK.OUTCOME]: outcome });
      if (req.capture !== undefined && state.captured !== null) {
        const spanContext = state.span.spanContext();
        try {
          await insertSpanContent(ctx.db, {
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
            workspaceId: req.workspaceId,
            requestId: req.requestId,
            prompt: capturedPrompt(req.request),
            response: capturedResponse(state.captured, state.finish?.finishReason ?? null),
            expiresAt: new Date(Date.now() + req.capture.retentionDays * DAY_MS),
          });
        } catch (error) {
          // Troubleshooting data is not worth failing a request for; the reply goes on.
          ctx.logger.warn('tracing.capture_failed', { request_id: req.requestId }, error);
        }
      }
      return priced;
    };

    const start = (signal: AbortSignal, attempt: number): AsyncIterable<GatewayStreamEvent> => {
      const candidate = current();
      triesOnCurrent += 1;
      const span = tracer.startSpan(
        `chat ${candidate.model.model}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            ...requestAttributes(
              candidate.model,
              candidate.connection.kind,
              candidate.maxOutputTokens,
              req.request.temperature,
              attempt,
            ),
            ...routingAttributes(req.routing),
          },
        },
        attemptContext,
      );
      const state: AttemptState = {
        candidate,
        span,
        spanEnded: false,
        startedAt: performance.now(),
        firstEventAt: null,
        outputText: '',
        finish: null,
        captured: req.capture === undefined ? null : { text: '', reasoning: '', toolCalls: [] },
      };
      attempts.set(attempt, state);
      const inner = new AbortController();
      const forward = () => inner.abort(signal.reason);
      if (signal.aborted) inner.abort(signal.reason);
      else signal.addEventListener('abort', forward, { once: true });
      const model = languageModel(candidate.connection, candidate.model.model);
      const request = { ...req.request, maxOutputTokens: candidate.maxOutputTokens };
      const idleMs = isReasoning(candidate) ? timeouts.reasoningIdleMs : timeouts.idleMs;
      return (async function* () {
        try {
          for await (const event of withIdleTimeout(
            streamModelCall(model, request, inner.signal),
            idleMs,
            (reason) => inner.abort(reason),
          )) {
            if (state.firstEventAt === null) {
              state.firstEventAt = performance.now();
              span.setAttribute(
                GEN_AI.RESPONSE_TIME_TO_FIRST_CHUNK,
                (state.firstEventAt - state.startedAt) / 1000,
              );
            }
            if (event.type === 'text' || event.type === 'reasoning') state.outputText += event.text;
            // A tool call's arguments are output the model produced, and cost the same.
            if (event.type === 'tool-call') state.outputText += event.name + event.arguments;
            if (event.type === 'finish') state.finish = event;
            if (state.captured !== null) {
              if (event.type === 'text') state.captured.text += event.text;
              if (event.type === 'reasoning') state.captured.reasoning += event.text;
              if (event.type === 'tool-call') {
                state.captured.toolCalls.push({ name: event.name, arguments: event.arguments });
              }
            }
            yield event;
          }
        } catch (error) {
          // An idle timeout surfaces as the abort it caused; report the timeout itself.
          throw inner.signal.reason instanceof IdleTimeoutError ? inner.signal.reason : error;
        } finally {
          signal.removeEventListener('abort', forward);
        }
      })();
    };

    const onFailure = async (error: unknown, attempt: number): Promise<FailureDecision> => {
      const failure = classifyFailure(error);
      last.failure = {
        kind: failure.kind,
        retryAfterMs: failure.retryAfterMs,
        provider: current().model.provider,
      };
      const state = attempts.get(attempt);
      if (state !== undefined && failure.mayHaveBilled) {
        await record(state, attempt, 'abandoned', null);
      }
      if (state !== undefined) {
        if (failure.httpStatus !== null)
          state.span.setAttribute(LK.HTTP_STATUS, failure.httpStatus);
        state.spanEnded = true;
        endSpan(state.span, failure.kind);
      }
      ctx.logger.warn('dispatch.attempt_failed', {
        request_id: req.requestId,
        attempt,
        error_code: failure.kind,
        status_code: failure.httpStatus,
      });
      const terminal = terminalError(failure, error);
      if (terminal !== undefined) return { retry: false, error: terminal };
      if (failure.kind === 'context_overflow') sawContextOverflow = true;

      const retrySame =
        triesOnCurrent < attemptsPerModel &&
        (failure.kind === 'overloaded' ||
          failure.kind === 'timeout' ||
          (failure.kind === 'rate_limited' && (failure.retryAfterMs ?? 0) <= maxRetryAfterMs));
      if (retrySame) {
        const delayMs =
          failure.kind === 'rate_limited' && failure.retryAfterMs !== null
            ? failure.retryAfterMs
            : backoffMs(triesOnCurrent);
        return { retry: true, delayMs };
      }
      if (index + 1 < usable.length) {
        index += 1;
        triesOnCurrent = 0;
        return { retry: true, delayMs: 0 };
      }
      return sawContextOverflow
        ? {
            retry: false,
            error: new ContextTooLongError('the input does not fit any candidate model', {
              cause: error,
            }),
          }
        : { retry: false };
    };

    let committed;
    try {
      committed = await commitFirstChunk(start, {
        maxAttempts: usable.length * attemptsPerModel,
        firstChunkTimeoutMs: () =>
          isReasoning(current()) ? timeouts.reasoningFirstChunkMs : timeouts.firstChunkMs,
        onFailure,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
    } catch (error) {
      // Aborted before any first chunk: the attempt in flight never reached onFailure, but the
      // provider may already bill its prompt.
      if (req.signal?.aborted === true) {
        for (const [attempt, state] of attempts) {
          if (!recorded.has(attempt)) await record(state, attempt, 'aborted', null);
        }
      }
      for (const state of attempts.values()) {
        if (!state.spanEnded) endSpan(state.span, 'aborted');
      }
      dispatchSpan.setAttribute(LK.ATTEMPTS, attempts.size);
      // Say which provider did not answer, and how long it asked to wait (CH-7).
      const failure = last.failure;
      if (error instanceof UpstreamUnavailableError && failure !== null) {
        throw new UpstreamUnavailableError(error.message, {
          cause: error.cause,
          provider: failure.provider,
          rateLimited: failure.kind === 'rate_limited',
          retryAfterSeconds:
            failure.kind === 'rate_limited' && failure.retryAfterMs !== null
              ? Math.ceil(failure.retryAfterMs / 1000)
              : null,
        });
      }
      throw error;
    }

    // 3. The committed stream records its own usage however it ends.
    const committedState = attempts.get(committed.attempts);
    if (committedState === undefined) throw new Error('committed attempt has no state');
    const {
      promise: done,
      resolve: settle,
      reject: fail,
    } = Promise.withResolvers<DispatchSummary>();
    // A consumer that never awaits `done` must not cause an unhandled rejection.
    done.catch(() => undefined);

    const finish = async (outcome: UsageOutcome) => {
      try {
        const priced = await record(
          committedState,
          committed.attempts,
          outcome,
          committedState.finish?.usage ?? null,
        );
        const reason = committedState.finish?.finishReason;
        if (reason !== undefined) {
          committedState.span.setAttribute(GEN_AI.RESPONSE_FINISH_REASONS, [reason]);
        }
        endSpan(committedState.span, outcome === 'completed' ? null : outcome);
        dispatchSpan.setAttributes({
          [LK.MODEL]: committedState.candidate.model.id,
          [LK.ATTEMPTS]: committed.attempts,
          [LK.OUTCOME]: outcome,
          [LK.COST_MICRO_USD]: Number(priced.costMicroUsd),
        });
        endSpan(dispatchSpan, outcome === 'completed' ? null : outcome);
        settle({
          model: committedState.candidate.model.id,
          attempts: committed.attempts,
          outcome,
          costMicroUsd: priced.costMicroUsd,
          finishReason: committedState.finish?.finishReason ?? null,
        });
      } catch (error) {
        ctx.logger.error('dispatch.usage_record_failed', { request_id: req.requestId }, error);
        endSpan(committedState.span, 'usage_record_failed');
        endSpan(dispatchSpan, 'usage_record_failed');
        fail(error);
      }
    };

    let consumed = false;
    return {
      model: committedState.candidate.model,
      attempts: committed.attempts,
      done,
      async *[Symbol.asyncIterator]() {
        if (consumed) throw new Error('a dispatched stream can only be read once');
        consumed = true;
        let outcome: UsageOutcome | undefined;
        try {
          for await (const event of committed) yield event;
          outcome = committedState.finish === null ? 'interrupted' : 'completed';
        } catch (error) {
          outcome = req.signal?.aborted === true ? 'aborted' : 'interrupted';
          throw error;
        } finally {
          // Reaching here without an outcome means the reader stopped early.
          await finish(outcome ?? 'aborted');
        }
      },
    };
  }
}
