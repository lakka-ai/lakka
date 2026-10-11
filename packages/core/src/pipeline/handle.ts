import {
  AccessRevokedError,
  blendedPrice,
  BudgetExceededError,
  BudgetUnavailableError,
  LakkaError,
  filesOf,
  InvalidRequestError,
  NotFoundError,
  textOf,
  UnknownModelError,
  UpstreamUnavailableError,
} from '@lakka/contracts';
import type { GatewayRequest, ModelView, Principal, Surface } from '@lakka/contracts';
import {
  clearConversationRoute,
  decideToolApproval,
  expirePendingToolApprovals,
  findConversation,
  grantTool,
  hasActiveToolGrant,
  insertAssistantMessage,
  insertUserMessage,
  listUsageForRequest,
  rememberConversationRoute,
} from '@lakka/db';
import type { ConversationRow } from '@lakka/db';
import { context as otelContext, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Tracer } from '@opentelemetry/api';
import {
  chargeLines,
  DEFAULT_RESERVATION_TTL_MS,
  reserveBudget,
  settleReservation,
} from '../budgets/engine.ts';
import type { BudgetEngineContext, Reservation } from '../budgets/engine.ts';
import { estimateAttemptCost, estimateRequestCost } from '../budgets/estimate.ts';
import type { ClassifierRuntime } from '../classifier/runtime.ts';
import type { EventPublisher } from '../events.ts';
import type { LiveRequests } from './live.ts';
import { dispatch } from '../gateway/dispatch.ts';
import type { DispatchContext, DispatchedStream, DispatchSummary } from '../gateway/dispatch.ts';
import { LK } from '../gateway/telemetry.ts';
import { pinCatalogue } from '../models/catalogue.ts';
import { findModelPrices, resolveModel } from '../models/service.ts';
import { compileWorkspacePolicy } from '../routing/compile.ts';
import { resolveRequestModel } from '../routing/resolve.ts';
import type { Resolution, StickyDecision } from '../routing/resolve.ts';
import { centroidStale, DEFAULT_MATCH_MODE, scoreRoutes } from '../routing/score.ts';
import type { PolicySnapshot, RouteScore } from '../routing/score.ts';
import type { PolicySnapshots } from '../routing/snapshot.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';
import { rateLimitedError, rateLimitOn, takeModelRequest } from './rate-limit.ts';
import type { ModelRateLimit } from './rate-limit.ts';
import { resolveTools } from '../mcp/tools.ts';
import type { ToolSnapshot } from '../routing/score.ts';
import type { ToolDispatchContext } from '../tools/dispatch.ts';
import type { ToolExecutor } from '../tools/executor.ts';
import { ToolLoopGuard } from '../tools/guard.ts';
import {
  eventsOnly,
  recordRound,
  runToolCalls,
  storedHistory,
  toolDefinitions,
  toolLoop,
  withToolNote,
} from './tool-loop.ts';
import type {
  CallRunner,
  ModelStream,
  ModelStreamEvent,
  RecordedDecision,
  Round,
} from './tool-loop.ts';

/*
 * The one entry point for a model request (CLAUDE.md invariant 1, API-3; tech spec, The policy
 * pipeline; ADR 0047). Every surface turns its wire format into a ModelRequest and calls this;
 * chat and the API differ only in how they fill it. It runs:
 *
 *   authorize (models.use)  ->  policy snapshot  ->  rate limit  ->  conversation
 *   ->  resolve the model  ->  estimate and reserve (M4)  ->  store or clear the conversation's
 *   decision  ->  dispatch  ->  settle, however the request ends
 *
 * The reservation is settled with the sum of the request's usage rows, which is exactly what
 * was recorded for every attempt: after the stream ends, is abandoned or aborted, or when
 * dispatch fails before streaming (invariant 4, ADR 0051). When a cap has no room, a cheaper
 * model that fits is used instead and reported (BG-7, ADR 0053). When the request names a
 * conversation and the workspace offers tools the caller can use, the model may call them, round
 * by round, through the dispatch seam (stage 6, ADR 0071). Each call takes one token from the
 * acting person's rate limit, after access is checked and before anything is held or sent; a
 * tool loop's later rounds are part of the same call and take none (BG-12, ADR 0113).
 */

/** The longest a request may run, inside the reservation's lifetime so a hold never lapses. */
export const DEFAULT_MAX_REQUEST_MS = 10 * 60 * 1000;

export interface PipelineContext extends DispatchContext, BudgetEngineContext {
  events: EventPublisher;
  classifier: ClassifierRuntime;
  snapshots: PolicySnapshots;
  /** Tests shorten it; production uses DEFAULT_MAX_REQUEST_MS. */
  maxRequestMs?: number;
  /** Tests shorten it; production uses DEFAULT_RESERVATION_TTL_MS. Must exceed maxRequestMs. */
  reservationTtlMs?: number;
  /** Requests in progress, so a revocation can end them (AC 6, ADR 0063). */
  live?: LiveRequests;
  /** Server-side tools (M6): where they run, and what their connections need (ADR 0071). */
  tools?: { executor: ToolExecutor; mcpPrivateOrigins: readonly string[]; publicUrl: string };
  /** How many model requests one person may start (BG-12); unset, or 0 per minute, is off. */
  modelRateLimit?: ModelRateLimit;
}

export interface ModelRequest {
  requestId: string;
  surface: Surface;
  workspaceId: string;
  principal: Principal;
  request: GatewayRequest;
  /** A model the user chose for this request, or null to let the workspace decide. */
  model: string | null;
  /** A route the caller asked for by name instead of a model (API-4, G1). */
  route?: string | null;
  /** The conversation the request belongs to; null for a request that stands alone. */
  conversationId: string | null;
  /** The caller's answer to a tool call their conversation is waiting on (H5, AC 18). */
  approval?: { approvalId: string; decision: 'approve' | 'deny'; always: boolean };
  signal?: AbortSignal;
  traceContext?: Context;
}

export interface ModelResponse {
  resolution: Resolution;
  /** True when this request overrode the conversation's routed model (RT-9). */
  overridden: boolean;
  /** The route that chose the model, by name, for showing why (CH-2); null for none. */
  routeName: string | null;
  /** Set when a cap forced a cheaper model; surfaces tell the user in plain language (BG-7). */
  fallback: BudgetFallback | null;
  /** What was held against the caps for this request, or null when no cap applies. */
  reservedMicroUsd: bigint | null;
  /** Its `done` settles after the budget is settled, and the reply recorded, too. */
  stream: ModelStream;
}

export async function handleModelRequest(
  ctx: PipelineContext,
  req: ModelRequest,
): Promise<ModelResponse> {
  // One trace per request, whatever surface it came from (OB-1, ADR 0076). Every span below is
  // a child of this one, and it ends when the reply has ended and been settled.
  const tracer = ctx.tracer ?? trace.getTracer('lakka.policy');
  const span = tracer.startSpan(
    'request',
    {
      kind: SpanKind.SERVER,
      attributes: {
        [LK.REQUEST_ID]: req.requestId,
        [LK.WORKSPACE_ID]: req.workspaceId,
        [LK.SURFACE]: req.surface,
        [LK.PRINCIPAL_ID]: req.principal.id,
        [LK.ACTING_USER_ID]: req.principal.actingUserId,
        ...(req.conversationId === null ? {} : { [LK.CONVERSATION_ID]: req.conversationId }),
      },
    },
    req.traceContext ?? otelContext.active(),
  );
  const traced: ModelRequest = {
    ...req,
    traceContext: trace.setSpan(req.traceContext ?? otelContext.active(), span),
  };
  // One catalogue for the whole request: a price feed applied meanwhile changes the next
  // request, never this one's estimate, dispatch or usage rows (invariant 4, ADR 0116).
  const pinned: PipelineContext = { ...ctx, catalogue: pinCatalogue(ctx.catalogue) };
  let response: ModelResponse;
  try {
    response = await handle(pinned, traced);
  } catch (error) {
    const refused = refusedWhenStoresDown(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', errorCode(refused));
    // Why, for the request list: which cap and what it had, or which provider (ADR 0095).
    if (refused instanceof BudgetExceededError) {
      span.setAttributes({
        [LK.BUDGET_SCOPE]: refused.scope,
        [LK.BUDGET_REMAINING_MICRO_USD]: Number(refused.remainingMicroUsd),
      });
    }
    if (refused instanceof UpstreamUnavailableError && refused.provider !== null) {
      span.setAttribute(LK.PROVIDER, refused.provider);
    }
    span.end();
    throw refused;
  }
  span.setAttribute(LK.MODEL, response.stream.model.id);
  response.stream.done.then(
    (summary) => {
      if (summary !== null) span.setAttribute(LK.OUTCOME, summary.outcome);
      span.end();
    },
    (error: unknown) => {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('error.type', errorCode(error));
      span.end();
    },
  );
  return response;
}

/**
 * Without Postgres or Valkey nothing can be authorized or metered, so a request is refused with a
 * clear, retryable error rather than a bare internal one (BG-4, AC 9, ADR 0056). Surfaces apply
 * it to everything a model request does before it reaches core, authentication included.
 */
export function refusedWhenStoresDown(error: unknown): unknown {
  if (!(error instanceof LakkaError) && isStoreUnavailable(error)) {
    return new BudgetUnavailableError('budgets cannot be checked right now', { cause: error });
  }
  return error;
}

// Connection failures from the Postgres driver and the network, as codes or messages.
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);
const UNAVAILABLE_MESSAGE =
  /Connection terminated|timeout exceeded when trying to connect|connection error/i;

/** Whether an error, or one it was caused by, says a store could not be reached. */
function isStoreUnavailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return true;
    if (current instanceof AggregateError && current.errors.some(isStoreUnavailable)) return true;
    if (UNAVAILABLE_MESSAGE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

async function handle(ctx: PipelineContext, req: ModelRequest): Promise<ModelResponse> {
  const tracer = ctx.tracer ?? trace.getTracer('lakka.policy');
  const parentContext = req.traceContext ?? otelContext.active();
  // The request's own span, where the list reads what was asked for and decided (ADR 0095).
  const root = trace.getSpan(parentContext);
  const authorizing = tracer.startSpan(
    'policy.authorize',
    { attributes: { [LK.REQUEST_ID]: req.requestId, [LK.WORKSPACE_ID]: req.workspaceId } },
    parentContext,
  );
  let policy: PolicySnapshot | undefined;
  try {
    await authorizeWorkspaceAction(ctx, req.principal, req.workspaceId, 'models.use');
    policy = await ctx.snapshots.get(req.workspaceId);
    if (policy === undefined) throw new NotFoundError('workspace not found');
  } catch (error) {
    authorizing.setStatus({ code: SpanStatusCode.ERROR });
    authorizing.setAttribute('error.type', errorCode(error));
    throw error;
  } finally {
    authorizing.end();
  }
  // After access, so a caller who may not use models is told so and drains nothing; before the
  // conversation, routing and the reservation, so a refused request costs nothing (BG-12).
  if (rateLimitOn(ctx.modelRateLimit)) {
    await checkRateLimit(ctx, ctx.modelRateLimit, req, tracer, parentContext);
  }

  const conversation =
    req.conversationId === null ? undefined : await ownConversation(ctx, req, req.conversationId);
  const sticky: StickyDecision | null =
    conversation?.routedModel == null
      ? null
      : { model: conversation.routedModel, routeId: conversation.routeId };

  const requested =
    req.route !== undefined && req.route !== null ? `route/${req.route}` : (req.model ?? 'auto');
  const span = tracer.startSpan(
    'policy.resolve_model',
    {
      attributes: {
        [LK.REQUEST_ID]: req.requestId,
        [LK.WORKSPACE_ID]: req.workspaceId,
        [LK.ROUTING_REQUESTED]: requested,
      },
    },
    parentContext,
  );
  let resolution: Resolution;
  try {
    resolution = await resolveRequestModel({
      policy,
      explicitModel: req.model,
      explicitRoute: req.route ?? null,
      sticky,
      text: latestUserText(req.request),
      classify: (text) => classify(ctx, policy, text),
      priceOf: (model) => findModelPrices(ctx, model),
    });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', errorCode(error));
    span.end();
    throw error;
  }
  // Choosing a different model, or a route with one, in a routed conversation is an override
  // (tech spec, Capturing overrides): recorded against the route that lost, and the
  // conversation's route is cleared.
  const overridden =
    sticky !== null && resolution.rule === 'explicit' && resolution.model !== sticky.model
      ? sticky
      : null;
  const decidedAttributes = {
    [LK.ROUTING_RULE]: resolution.rule,
    ...(resolution.routeId === null ? {} : { [LK.ROUTING_ROUTE_ID]: resolution.routeId }),
    ...(resolution.signal === null ? {} : { [LK.ROUTING_SIGNAL]: resolution.signal }),
    ...(resolution.confidence === null ? {} : { [LK.ROUTING_CONFIDENCE]: resolution.confidence }),
    ...(resolution.reason === null ? {} : { [LK.ROUTING_DEFAULT_REASON]: resolution.reason }),
    ...(resolution.threshold === null ? {} : { [LK.ROUTING_THRESHOLD]: resolution.threshold }),
  };
  span.setAttributes({
    ...decidedAttributes,
    [LK.MODEL]: resolution.model,
    [LK.ROUTING_OVERRIDDEN]: overridden !== null,
  });
  span.end();
  root?.setAttributes({ ...decidedAttributes, [LK.ROUTING_REQUESTED]: requested });

  // Stage 6: the tools this request may offer (ADR 0069, ADR 0071). Only in a conversation,
  // only to a model that can call tools, and never mixed with tools the client brought (H3, H4).
  const toolsCtx: ToolDispatchContext | undefined =
    ctx.tools === undefined
      ? undefined
      : {
          db: ctx.db,
          events: ctx.events,
          mcpPrivateOrigins: ctx.tools.mcpPrivateOrigins,
          publicUrl: ctx.tools.publicUrl,
          executor: ctx.tools.executor,
          logger: ctx.logger,
          ...(ctx.tracer === undefined ? {} : { tracer: ctx.tracer }),
        };
  const clientTools = req.request.tools !== undefined;
  let offered: readonly ToolSnapshot[] = [];
  if (conversation !== undefined && toolsCtx !== undefined) {
    const available = await resolveTools(toolsCtx, policy, req.principal);
    if (clientTools && available.length > 0) {
      throw new InvalidRequestError(
        "This conversation uses the workspace's tools; a request in it cannot bring its own.",
      );
    }
    if (!clientTools && available.length > 0) {
      const chosen = await resolveModel(ctx, resolution.model).catch(() => undefined);
      if (chosen?.capabilities.tools === true) offered = available;
    }
  }
  if (req.approval !== undefined && (conversation === undefined || toolsCtx === undefined)) {
    throw new InvalidRequestError('An approval answers a tool call a conversation is waiting on.');
  }
  if (req.approval?.always === true && req.principal.kind !== 'user') {
    // A standing approval is a person's decision; a key approves one call at a time (TL-5).
    throw new InvalidRequestError('Only a person can approve a tool for good.');
  }

  // A request that runs past its limit is aborted, so its hold is settled before it can lapse.
  const deadline = AbortSignal.timeout(ctx.maxRequestMs ?? DEFAULT_MAX_REQUEST_MS);
  // Revoking the principal's access ends the request too, from any surface (AC 6, ADR 0063).
  const revoked = new AbortController();
  const signal = AbortSignal.any([
    ...(req.signal === undefined ? [] : [req.signal]),
    deadline,
    revoked.signal,
  ]);
  // Whatever an abort surfaced as, a revoked request reports the revocation.
  const asRevoked = (error: unknown): unknown =>
    revoked.signal.aborted && revoked.signal.reason instanceof AccessRevokedError
      ? revoked.signal.reason
      : error;

  const runner: CallRunner | null =
    conversation === undefined || toolsCtx === undefined
      ? null
      : {
          ctx: toolsCtx,
          request: {
            requestId: req.requestId,
            workspaceId: req.workspaceId,
            principal: req.principal,
            conversationId: conversation.id,
            policy,
            offered,
            signal,
            ...(req.traceContext === undefined ? {} : { traceContext: req.traceContext }),
          },
          conversationId: conversation.id,
          offered,
          guard: new ToolLoopGuard(),
          // A standing approval is this principal's own (TL-5).
          isApproved: (tool) =>
            hasActiveToolGrant(ctx.db, req.workspaceId, req.principal.id, tool.id),
        };

  // A continuation: record the caller's answer, then run the calls the paused round left,
  // before any model call (H5, AC 18).
  let base = req.request;
  let prelude: ModelStreamEvent[] = [];
  if (req.approval !== undefined && runner !== null && conversation !== undefined) {
    const decided = await decideToolApproval(
      ctx.db,
      req.workspaceId,
      conversation.id,
      req.approval.approvalId,
      req.principal.id,
      req.approval.decision === 'approve' ? 'approved' : 'denied',
      { requestId: req.requestId, always: req.approval.always === true },
    );
    if (decided === undefined) {
      throw new NotFoundError('no tool call is waiting for your approval with that id');
    }
    root?.setAttribute(LK.CONTINUES_REQUEST_ID, decided.requestId);
    if (
      req.approval.always &&
      req.approval.decision === 'approve' &&
      req.principal.kind === 'user'
    ) {
      await grantTool(ctx.db, req.workspaceId, req.principal.id, decided.workspaceToolId);
    }
    const stored = await storedHistory(runner);
    if (!stored.pending.some((call) => call.id === decided.callId)) {
      throw new InvalidRequestError('That tool call is no longer waiting.');
    }
    runner.guard.startRound();
    runner.approvedCallId = req.approval.decision === 'approve' ? decided.callId : null;
    runner.declinedCallId = req.approval.decision === 'deny' ? decided.callId : null;
    const pending = runToolCalls(runner, stored.pending);
    let step = await pending.next();
    while (step.done !== true) {
      prelude.push(step.value);
      step = await pending.next();
    }
    runner.approvedCallId = null;
    runner.declinedCallId = null;
    const system = req.request.messages.filter((m) => m.role === 'system');
    base = { ...req.request, messages: [...system, ...stored.messages, ...step.value.messages] };
    if (step.value.stop === 'approval') {
      // It stopped again, at the next call that asks: nothing for a model to do yet.
      const model = await resolveModel(ctx, resolution.model);
      prelude.push({
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: 0,
          uncachedInputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      });
      return {
        resolution,
        overridden: false,
        routeName: policy.routes.find((r) => r.id === resolution.routeId)?.name ?? null,
        fallback: null,
        reservedMicroUsd: null,
        stream: eventsOnly(model, prelude),
      };
    }
  } else if (conversation !== undefined) {
    // A new message moves the conversation on from anything it was waiting on.
    await expirePendingToolApprovals(ctx.db, req.workspaceId, conversation.id);
  }
  const request: GatewayRequest =
    offered.length === 0
      ? base
      : { ...base, messages: withToolNote(base.messages), tools: toolDefinitions(offered) };
  const roundReq: ModelRequest = { ...req, request };

  // Reserve before touching the conversation, so a refused request leaves it as it was. The
  // conversation keeps the routing decision even when a cap forced a cheaper model this time.
  const { reservation, fallback } = await reserve(
    ctx,
    roundReq,
    policy,
    resolution,
    tracer,
    parentContext,
  );

  if (conversation !== undefined) {
    if (overridden !== null) {
      await clearConversationRoute(ctx.db, req.workspaceId, conversation.id);
    } else if (resolution.remember) {
      await rememberConversationRoute(ctx.db, req.workspaceId, conversation.id, {
        routeId: resolution.routeId,
        model: resolution.model,
      });
    }
  }

  const untrack =
    ctx.live?.track(
      {
        requestId: req.requestId,
        principalId: req.principal.id,
        actingUserId: req.principal.actingUserId,
        workspaceId: req.workspaceId,
      },
      (reason) => revoked.abort(reason),
    ) ?? (() => undefined);
  const routing = {
    rule: resolution.rule,
    routeId: overridden === null ? resolution.routeId : overridden.routeId,
    confidence: resolution.confidence,
    defaultReason: resolution.reason,
    overriddenModel: overridden === null ? null : overridden.model,
    budgetFallbackFrom: fallback === null ? null : fallback.from,
  };
  const dispatchFields = {
    requestId: req.requestId,
    surface: req.surface,
    workspaceId: req.workspaceId,
    principal: req.principal,
    routing,
    signal,
    ...(req.traceContext === undefined ? {} : { traceContext: req.traceContext }),
    // OB-4: what was said is kept only where the workspace chose to keep it.
    ...(policy.capture.enabled ? { capture: { retentionDays: policy.capture.retentionDays } } : {}),
  };
  let stream: DispatchedStream;
  try {
    stream = await dispatch(ctx, {
      ...dispatchFields,
      request,
      // After a fallback, only the model the reservation was sized for may be tried.
      candidates: fallback === null ? [resolution.model, ...resolution.fallbacks] : [fallback.to],
      allowCrossProvider: fallback === null ? resolution.allowCrossProvider : true,
    });
  } catch (error) {
    // Failed before streaming: attempts that may have cost money are already recorded.
    untrack();
    await settle(ctx, req, reservation);
    throw asRevoked(error);
  }
  const routeName = policy.routes.find((r) => r.id === resolution.routeId)?.name ?? null;
  // The request is committed, so its turn joins the conversation's history (CH-1, ADR 0060). A
  // continuation's turn was stored with the run it continues.
  if (conversation !== undefined && req.approval === undefined) {
    await recordUserTurn(ctx, req, conversation.id);
  }
  const answeredBy = stream.model.id;
  // What each stored reply says about how its model was chosen (CH-2, CH-4).
  const decision = {
    routingRule: resolution.rule,
    routeName,
    routingConfidence: resolution.confidence,
    routingReason: resolution.reason,
    fallbackFrom: fallback?.from ?? null,
    fallbackScope: fallback?.scope ?? null,
  };
  const response = {
    resolution,
    overridden: overridden !== null,
    routeName,
    fallback,
    reservedMicroUsd: reservation === null ? null : reservation.amountMicroUsd,
  };

  if (runner !== null && (offered.length > 0 || prelude.length > 0)) {
    const loopRunner = runner;
    return {
      ...response,
      stream: toolLoop({
        runner: loopRunner,
        serverTools: offered.length > 0,
        request,
        first: { stream, reservation, firstAttempt: 1 },
        prelude,
        // Later rounds use the model that answered the first, sized for it and nothing else.
        nextRound: async (next, firstAttempt): Promise<Round> => {
          const nextReq: ModelRequest = { ...req, request: next };
          const held = await reserveFor(ctx, nextReq, policy, answeredBy);
          try {
            const nextStream = await dispatch(ctx, {
              ...dispatchFields,
              request: next,
              candidates: [answeredBy],
              allowCrossProvider: true,
              firstAttempt,
            });
            return { stream: nextStream, reservation: held, firstAttempt };
          } catch (error) {
            await settle(ctx, req, held, firstAttempt);
            throw error;
          }
        },
        settle: (round) => settle(ctx, req, round.reservation, round.firstAttempt),
        recordReply: ({ content, toolCalls, summary }) =>
          recordRound(loopRunner, {
            content,
            toolCalls,
            state: replyState(summary),
            model: summary?.model ?? answeredBy,
            ...decision,
          }),
        translate: asRevoked,
        onEnd: untrack,
      }),
    };
  }
  return {
    ...response,
    stream: finishedWith(stream, asRevoked, async (summary, text) => {
      untrack();
      await settle(ctx, req, reservation);
      if (conversation !== undefined) {
        await recordReply(ctx, req, conversation.id, {
          content: text,
          state: replyState(summary),
          model: summary?.model ?? answeredBy,
          ...decision,
        });
      }
    }),
  };
}

/** Takes the request's token from the acting person's bucket, or refuses (BG-12, ADR 0113). */
async function checkRateLimit(
  ctx: PipelineContext,
  limit: ModelRateLimit,
  req: ModelRequest,
  tracer: Tracer,
  parentContext: Context,
): Promise<void> {
  const span = tracer.startSpan(
    'policy.rate_limit',
    { attributes: { [LK.REQUEST_ID]: req.requestId, [LK.WORKSPACE_ID]: req.workspaceId } },
    parentContext,
  );
  try {
    // The person, not the key: a key draws on its owner's bucket (invariant 2).
    const decision = await takeModelRequest(ctx.cache, limit, req.principal.actingUserId);
    if (!decision.allowed) {
      span.setAttribute(LK.RATE_LIMIT_RETRY_AFTER_MS, decision.retryAfterMs);
      throw rateLimitedError(decision.retryAfterMs);
    }
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', errorCode(error));
    throw error;
  } finally {
    span.end();
  }
}

/** A conversation's title from its first message: its opening words, or a file's name. */
function titleFrom(text: string, filenames: readonly (string | undefined)[]): string {
  const words = text.replace(/\s+/g, ' ').trim();
  if (words !== '') return words.length > 60 ? `${words.slice(0, 57).trimEnd()}...` : words;
  return filenames.find((f) => f !== undefined) ?? '';
}

/**
 * Stores the person's new turn, the request's last message, with its files. Earlier messages in
 * the request were stored when they were new. A failure is logged, not thrown: the answer is
 * already on its way and should not be lost for the sake of the history.
 */
async function recordUserTurn(
  ctx: PipelineContext,
  req: ModelRequest,
  conversationId: string,
): Promise<void> {
  const last = req.request.messages.at(-1);
  if (last?.role !== 'user') return;
  const files = filesOf(last.content);
  try {
    await insertUserMessage(ctx.db, {
      workspaceId: req.workspaceId,
      conversationId,
      requestId: req.requestId,
      content: textOf(last.content),
      attachments: files.map((f) => ({
        mediaType: f.mediaType,
        filename: f.filename ?? null,
        data: Buffer.from(f.data, 'base64'),
      })),
      title: titleFrom(
        textOf(last.content),
        files.map((f) => f.filename),
      ),
    });
  } catch (error) {
    ctx.logger.error('conversation.record_failed', { request_id: req.requestId }, error);
  }
}

async function recordReply(
  ctx: PipelineContext,
  req: ModelRequest,
  conversationId: string,
  reply: {
    content: string;
    state: 'complete' | 'interrupted' | 'aborted';
    model: string;
  } & RecordedDecision,
): Promise<void> {
  try {
    await insertAssistantMessage(ctx.db, {
      workspaceId: req.workspaceId,
      conversationId,
      requestId: req.requestId,
      ...reply,
    });
  } catch (error) {
    ctx.logger.error('conversation.record_failed', { request_id: req.requestId }, error);
  }
}

/** A cheaper model a cap forced, reported so surfaces can say what happened (BG-7). */
export interface BudgetFallback {
  /** The model the resolution order chose. */
  from: string;
  /** The model the request was sent to instead. */
  to: string;
  /** The cap that had no room for the first choice. */
  scope: BudgetExceededError['scope'];
}

interface Held {
  reservation: Reservation | null;
  fallback: BudgetFallback | null;
}

/**
 * Estimates the request against the candidates it may use and holds that against every cap
 * that applies (BG-2, BG-3). No cap, no hold. When a cap has no room, falls back to the most
 * capable cheaper model that fits (BG-7, Q2); only when none does is the request refused, with
 * the original BudgetExceededError. A model with no price is refused here too (BG-4).
 */
async function reserve(
  ctx: PipelineContext,
  req: ModelRequest,
  policy: PolicySnapshot,
  resolution: Resolution,
  tracer: Tracer,
  parentContext: Context,
): Promise<Held> {
  const now = new Date();
  const lines = chargeLines(policy, req.principal, now);
  if (lines.length === 0) return { reservation: null, fallback: null };
  const span = tracer.startSpan(
    'policy.reserve_budget',
    {
      attributes: {
        [LK.REQUEST_ID]: req.requestId,
        [LK.WORKSPACE_ID]: req.workspaceId,
        [LK.BUDGET_CAPS]: lines.length,
      },
    },
    parentContext,
  );
  const hold = (amountMicroUsd: bigint) =>
    reserveBudget(ctx, {
      requestId: req.requestId,
      workspaceId: req.workspaceId,
      principal: req.principal,
      lines,
      amountMicroUsd,
      ttlMs: ctx.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
      now,
    });
  try {
    const candidates = await pricedCandidates(ctx, [resolution.model, ...resolution.fallbacks]);
    const amount = estimateRequestCost(req.request, candidates);
    span.setAttribute(LK.BUDGET_ESTIMATE_MICRO_USD, Number(amount));
    try {
      const reservation = await hold(amount);
      span.setAttribute(LK.BUDGET_HELD_MICRO_USD, Number(reservation.amountMicroUsd));
      span.end();
      return { reservation, fallback: null };
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      const fallback = await fallBack(ctx, req, policy, resolution, error, hold);
      if (fallback === null) throw error;
      const moved = {
        [LK.BUDGET_SCOPE]: error.scope,
        [LK.BUDGET_REMAINING_MICRO_USD]: Number(error.remainingMicroUsd),
        [LK.BUDGET_FALLBACK_FROM]: fallback.fallback.from,
        [LK.BUDGET_FALLBACK_MODEL]: fallback.fallback.to,
      };
      span.setAttributes({
        ...moved,
        [LK.BUDGET_FALLBACK_ESTIMATE_MICRO_USD]: Number(fallback.reservation.amountMicroUsd),
        [LK.BUDGET_HELD_MICRO_USD]: Number(fallback.reservation.amountMicroUsd),
      });
      span.end();
      trace.getSpan(parentContext)?.setAttributes(moved);
      return fallback;
    }
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', errorCode(error));
    if (error instanceof BudgetExceededError) {
      span.setAttributes({
        [LK.BUDGET_SCOPE]: error.scope,
        [LK.BUDGET_REMAINING_MICRO_USD]: Number(error.remainingMicroUsd),
      });
    }
    span.end();
    throw error;
  }
}

/**
 * The fallback (BG-7, Q2): the route's fallbacks, then the workspace default, whichever are
 * priced and cheaper to run than the headroom left. The most capable of those, by blended price,
 * is tried first; if another request took the room meanwhile, the next is tried. Null when none
 * fits.
 */
async function fallBack(
  ctx: PipelineContext,
  req: ModelRequest,
  policy: PolicySnapshot,
  resolution: Resolution,
  refused: BudgetExceededError,
  hold: (amount: bigint) => Promise<Reservation>,
): Promise<{ reservation: Reservation; fallback: BudgetFallback } | null> {
  const refs = [
    ...new Set([
      ...resolution.fallbacks,
      ...(policy.defaultModel === null ? [] : [policy.defaultModel]),
    ]),
  ].filter((ref) => ref !== resolution.model);
  const options: { model: ModelView; estimate: bigint }[] = [];
  for (const ref of refs) {
    try {
      const model = await resolveModel(ctx, ref);
      const estimate = estimateAttemptCost(req.request, model);
      if (estimate <= refused.remainingMicroUsd) options.push({ model, estimate });
    } catch (error) {
      if (!(error instanceof UnknownModelError)) throw error;
    }
  }
  options.sort((a, b) => blendedPrice(b.model.prices) - blendedPrice(a.model.prices));
  for (const option of options) {
    try {
      return {
        reservation: await hold(option.estimate),
        fallback: { from: resolution.model, to: option.model.id, scope: refused.scope },
      };
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
    }
  }
  return null;
}

/** How a reply ended, as its stored message records it. */
const replyState = (summary: DispatchSummary | null) =>
  summary === null || summary.outcome === 'interrupted'
    ? ('interrupted' as const)
    : summary.outcome === 'aborted'
      ? ('aborted' as const)
      : ('complete' as const);

/**
 * Holds a tool loop's later round against every cap, sized for the one model it will use. No
 * fallback here: a cap with no room ends the run, keeping what was done (H8, ADR 0071).
 */
async function reserveFor(
  ctx: PipelineContext,
  req: ModelRequest,
  policy: PolicySnapshot,
  modelRef: string,
): Promise<Reservation | null> {
  const now = new Date();
  const lines = chargeLines(policy, req.principal, now);
  if (lines.length === 0) return null;
  const model = await resolveModel(ctx, modelRef);
  return reserveBudget(ctx, {
    requestId: req.requestId,
    workspaceId: req.workspaceId,
    principal: req.principal,
    lines,
    amountMicroUsd: estimateAttemptCost(req.request, model),
    ttlMs: ctx.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
    now,
  });
}

/** The candidates that have a price, which are the only ones dispatch will try. */
async function pricedCandidates(
  ctx: PipelineContext,
  refs: readonly string[],
): Promise<ModelView[]> {
  const models: ModelView[] = [];
  for (const ref of refs) {
    try {
      models.push(await resolveModel(ctx, ref));
    } catch (error) {
      if (!(error instanceof UnknownModelError)) throw error;
    }
  }
  if (models.length === 0) {
    throw new UnknownModelError('this model is not in the catalogue and has no price');
  }
  return models;
}

/**
 * Settles the reservation with what the request's attempts actually cost, as recorded in usage.
 * Never throws: if Postgres cannot be reached, the reservation stays active and the sweep
 * settles it later.
 */
async function settle(
  ctx: PipelineContext,
  req: ModelRequest,
  reservation: Reservation | null,
  /** A tool loop's later round settles only its own attempts (ADR 0071). */
  fromAttempt = 1,
): Promise<void> {
  if (reservation === null) return;
  const tracer = ctx.tracer ?? trace.getTracer('lakka.policy');
  const span = tracer.startSpan(
    'policy.reconcile',
    {
      attributes: {
        [LK.REQUEST_ID]: req.requestId,
        [LK.WORKSPACE_ID]: req.workspaceId,
        [LK.BUDGET_RESERVED_MICRO_USD]: Number(reservation.amountMicroUsd),
        [LK.BUDGET_FROM_ATTEMPT]: fromAttempt,
      },
    },
    req.traceContext ?? otelContext.active(),
  );
  try {
    const rows = await listUsageForRequest(ctx.db, req.workspaceId, req.requestId);
    const actual = rows
      .filter((r) => r.attempt >= fromAttempt)
      .reduce((sum, r) => sum + r.costMicroUsd, 0n);
    await settleReservation(ctx, reservation, actual);
    span.setAttributes({
      [LK.BUDGET_ACTUAL_MICRO_USD]: Number(actual),
      [LK.BUDGET_DELTA_MICRO_USD]: Number(reservation.amountMicroUsd - actual),
    });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', errorCode(error));
    ctx.logger.error('budget.settle_failed', { request_id: req.requestId }, error);
  } finally {
    span.end();
  }
}

/**
 * The same stream, keeping the text that passed through it, whose `done` waits for `onEnd` to
 * run after the stream ends: settling the budget, and recording the reply.
 */
function finishedWith(
  stream: DispatchedStream,
  translate: (error: unknown) => unknown,
  onEnd: (summary: DispatchSummary | null, text: string) => Promise<void>,
): DispatchedStream {
  let text = '';
  const done = stream.done.then(
    async (summary) => {
      await onEnd(summary, text);
      return summary;
    },
    async (error: unknown) => {
      await onEnd(null, text);
      throw error;
    },
  );
  // A consumer that never awaits `done` must not cause an unhandled rejection.
  done.catch(() => undefined);
  return {
    model: stream.model,
    attempts: stream.attempts,
    done,
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of stream) {
          if (event.type === 'text') text += event.text;
          yield event;
        }
      } catch (error) {
        throw translate(error);
      }
    },
  };
}

/** The caller's own conversation in this workspace; anything else does not exist for them. */
async function ownConversation(
  ctx: PipelineContext,
  req: ModelRequest,
  id: string,
): Promise<ConversationRow> {
  const row = await findConversation(ctx.db, req.workspaceId, req.principal.actingUserId, id);
  if (row === undefined) throw new NotFoundError('conversation not found');
  return row;
}

/** What routing reads: the latest user message (E8). */
function latestUserText(request: GatewayRequest): string {
  const last = request.messages.findLast((m) => m.role === 'user');
  return last === undefined ? '' : textOf(last.content);
}

// Workspaces whose centroids are being rebuilt for a new embedding model, so a burst of requests
// starts one rebuild rather than one each.
const recompiling = new Set<string>();

async function classify(
  ctx: PipelineContext,
  policy: PolicySnapshot,
  text: string,
): Promise<readonly RouteScore[] | undefined> {
  const embedder = await ctx.classifier.embedder();
  if (embedder === undefined) return undefined;
  const stale = policy.routes.some((r) => r.enabled && centroidStale(r, embedder.modelId));
  if (stale && !recompiling.has(policy.workspaceId)) {
    // Routes left behind by a model change score nothing until rebuilt (ADR 0043). Rebuilding
    // embeds every example, too slow to wait for, so this request goes on without them. A
    // centroid from the same model but made under an earlier rule (ADR 0125) still scores
    // meanwhile.
    recompiling.add(policy.workspaceId);
    void compileWorkspacePolicy(ctx, policy.workspaceId)
      .catch((error: unknown) => {
        ctx.logger.error('routing.recompile_failed', { workspace_id: policy.workspaceId }, error);
      })
      .finally(() => recompiling.delete(policy.workspaceId));
  }
  return scoreRoutes(policy, await embedder.embed(text), embedder.modelId, DEFAULT_MATCH_MODE);
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'internal';
}
