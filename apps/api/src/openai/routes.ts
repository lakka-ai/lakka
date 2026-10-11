import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ServerResponse } from 'node:http';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AccessRevokedError,
  BudgetExceededError,
  BudgetUnavailableError,
  InvalidRequestError,
  StreamInterruptedError,
} from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import {
  defaultWorkspaceFor,
  handleModelRequest,
  listRequestableModels,
  readConversationFiles,
  refusedWhenStoresDown,
} from '@lakka/core';
import type { AuthContext, Logger, ModelResponse, PipelineContext } from '@lakka/core';
import { decisionHeaders } from './headers.ts';
import { principalOf, requirePrincipal } from '../auth-routes.ts';
import { toOpenAiError } from './errors.ts';
import { translateChatRequest } from './request.ts';
import {
  chunk,
  collect,
  openAiFinishReason,
  openAiToolCall,
  openAiUsage,
  pendingApproval,
  toolActivity,
  sse,
  usageChunk,
} from './response.ts';
import type { Collected, CompletionMeta } from './response.ts';

/*
 * The OpenAI-compatible surface (API-1 to API-5, ADR 0059): /v1/models and /v1/chat/completions.
 * A thin adapter: it translates the wire format, picks the workspace, and calls the same
 * handleModelRequest every surface calls (invariant 1, API-3). A key's requests are the 'api'
 * surface; a signed-in person's, which is how chat calls it (G5), are 'chat'.
 *
 * Streaming follows the commitment window (invariant 6): nothing is sent until the first chunk
 * is in hand, so an error before then is an ordinary JSON error with a real status. After that,
 * an error ends the stream with an error event. A client that goes away aborts the request,
 * which is settled with its partial usage.
 *
 * Tools (ADR 0071): a client's own tools come back as tool_calls for the client to run. In a
 * conversation with the workspace's tools, Lakka runs them itself, and the reply carries only
 * the model's text. A run that stops for approval says so in its last chunk, under `lakka`,
 * the one field the format lacks (H5). The caller answers with x-lakka-approve or
 * x-lakka-deny.
 */

class ShutdownAbort extends Error {}

/** How long shutdown lets in-flight requests finish on their own, by default (NF-O5). */
export const SHUTDOWN_DRAIN_MS = 20_000;

/** How long shutdown then waits for the requests it ended to finish writing (NF-O5). */
export const STREAM_END_WAIT_MS = 2000;

/** Room for 20 MB of files in base64 (ADR 0057), with text around them. */
const BODY_LIMIT = 32 * 1024 * 1024;

const uuidHeader = z.uuid();

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function uuidFrom(request: FastifyRequest, name: string): string | undefined {
  const value = header(request, name);
  if (value === undefined) return undefined;
  const parsed = uuidHeader.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new InvalidRequestError(`${name} must be a UUID`), { param: name });
  }
  return parsed.data;
}

/** A refusal mid-stream that the caller can act on, reported as itself (AC 6, H8). */
function isReportable(error: unknown): boolean {
  return (
    error instanceof AccessRevokedError ||
    error instanceof BudgetExceededError ||
    error instanceof BudgetUnavailableError
  );
}

/** The caller's answer to a tool call their conversation is waiting on (H5). */
function approvalFrom(request: FastifyRequest) {
  const approve = uuidFrom(request, 'x-lakka-approve');
  const deny = uuidFrom(request, 'x-lakka-deny');
  const scope = header(request, 'x-lakka-approve-scope');
  if (approve !== undefined && deny !== undefined) {
    throw Object.assign(new InvalidRequestError('Send either x-lakka-approve or x-lakka-deny.'), {
      param: 'x-lakka-deny',
    });
  }
  if (scope !== undefined && (scope !== 'always' || approve === undefined)) {
    throw Object.assign(
      new InvalidRequestError('x-lakka-approve-scope can only be "always", with an approval.'),
      { param: 'x-lakka-approve-scope' },
    );
  }
  if (approve !== undefined) {
    return { approvalId: approve, decision: 'approve' as const, always: scope === 'always' };
  }
  if (deny !== undefined) return { approvalId: deny, decision: 'deny' as const, always: false };
  return undefined;
}

/** The model field (G1): "auto" runs the resolution order, "route/<name>" names a route. */
function modelChoice(model: string): { model: string | null; route: string | null } {
  if (model === 'auto') return { model: null, route: null };
  if (model.startsWith('route/')) return { model: null, route: model.slice('route/'.length) };
  return { model, route: null };
}

async function write(res: ServerResponse, frame: string, signal: AbortSignal): Promise<void> {
  if (!res.write(frame)) await once(res, 'drain', { signal });
}

export interface OpenAiRoutesOptions {
  auth: AuthContext;
  pipeline: PipelineContext;
  logger: Logger;
  shutdownDrainMs?: number;
}

export const openAiRoutes: FastifyPluginAsync<OpenAiRoutesOptions> = async (
  app,
  { auth, pipeline, logger, shutdownDrainMs = SHUTDOWN_DRAIN_MS },
) => {
  app.setErrorHandler(async (error, request, reply) => {
    // A store outage during authentication or listing is refused like one in core (ADR 0056).
    const { status, body, headers } = toOpenAiError(refusedWhenStoresDown(error));
    if (status >= 500) logger.error('openai.request_failed', { request_id: request.id }, error);
    if (headers !== undefined) void reply.headers(headers);
    return reply.status(status).send(body);
  });

  const preHandler = requirePrincipal(auth);
  const workspaceOf = async (request: FastifyRequest, principal: Principal) =>
    uuidFrom(request, 'x-lakka-workspace') ?? (await defaultWorkspaceFor(pipeline, principal));

  // NF-O5, ADR 0081: on shutdown, Fastify answers new requests with 503 before this hook runs.
  // Requests already in flight get the drain window to finish, and their budgets are settled as
  // usual; whatever is still open after it ends with an error event, and its partial usage is
  // settled, rather than holding close() up.
  // Each open request, with a promise that settles once its response is fully written, which is
  // after its reservation is settled.
  const active = new Map<AbortController, Promise<void>>();
  app.addHook('preClose', async () => {
    if (active.size > 0) {
      logger.info('api.draining', { count: active.size, delay_ms: shutdownDrainMs });
      await Promise.race([Promise.allSettled(active.values()), sleep(shutdownDrainMs)]);
    }
    if (active.size === 0) return;
    logger.warn('api.drain_ended', { count: active.size });
    for (const controller of active.keys()) {
      controller.abort(new ShutdownAbort('server shutting down'));
    }
    // Wait until those responses are written, so their connections are idle when the server
    // closes idle connections. A keep-alive connection that goes idle later would hold the
    // server open until Node's keep-alive timeout.
    await Promise.race([Promise.allSettled(active.values()), sleep(STREAM_END_WAIT_MS)]);
  });

  app.get('/v1/models', {
    preHandler,
    handler: async (request) => {
      const principal = principalOf(request);
      const { routes, models } = await listRequestableModels(
        pipeline,
        principal,
        await workspaceOf(request, principal),
      );
      const created = Math.floor(Date.now() / 1000);
      const entry = (id: string, ownedBy: string) => ({
        id,
        object: 'model',
        created,
        owned_by: ownedBy,
      });
      return {
        object: 'list',
        data: [
          entry('auto', 'lakka'),
          ...routes.map((r) => entry(`route/${r}`, 'lakka')),
          ...models.map((m) => entry(m.id, m.provider)),
        ],
      };
    },
  });

  app.post('/v1/chat/completions', {
    preHandler,
    bodyLimit: BODY_LIMIT,
    handler: async (request, reply) => {
      const principal = principalOf(request);
      const workspaceId = await workspaceOf(request, principal);
      const conversationId = uuidFrom(request, 'x-lakka-conversation') ?? null;
      const approval = approvalFrom(request);
      // Files sent again by id come from the named conversation, for its owner only (ADR 0062).
      const translated = await translateChatRequest(
        request.body,
        conversationId === null
          ? null
          : (ids) => readConversationFiles(pipeline, principal, workspaceId, conversationId, ids),
      );
      const requestId = randomUUID();
      // On refusals too, so the request's trace can be found from what the client saw.
      void reply.header('x-lakka-request-id', requestId);

      const controller = new AbortController();
      const res = reply.raw;
      const onClose = () => {
        if (!res.writableEnded) controller.abort(new Error('client disconnected'));
      };
      res.on('close', onClose);
      const writing = Promise.withResolvers<void>();
      active.set(controller, writing.promise);
      const cleanup = () => {
        active.delete(controller);
        writing.resolve();
        res.off('close', onClose);
      };

      let response: ModelResponse;
      try {
        response = await handleModelRequest(pipeline, {
          requestId,
          surface: principal.kind === 'key' ? 'api' : 'chat',
          workspaceId,
          principal,
          request: translated.request,
          ...modelChoice(translated.model),
          conversationId,
          ...(approval === undefined ? {} : { approval }),
          signal: controller.signal,
        });
      } catch (error) {
        cleanup();
        if (controller.signal.aborted) {
          reply.hijack();
          res.destroy();
          return;
        }
        // Nothing has been sent: an ordinary JSON error with a real status.
        throw error;
      }

      const meta: CompletionMeta = {
        id: `chatcmpl-${requestId}`,
        created: Math.floor(Date.now() / 1000),
        model: response.stream.model.id,
      };
      const headers = decisionHeaders(requestId, response);

      if (!translated.stream) {
        let collected: Collected;
        try {
          collected = await collect(response.stream);
          await response.stream.done.catch(() => undefined);
        } catch (error) {
          await response.stream.done.catch(() => undefined);
          cleanup();
          if (controller.signal.aborted) {
            reply.hijack();
            res.destroy();
            return;
          }
          if (isReportable(error)) throw error;
          throw new StreamInterruptedError('The response was interrupted. Try again.', {
            cause: error,
          });
        }
        cleanup();
        if (collected.finish === null) {
          throw new StreamInterruptedError('The response was interrupted. Try again.');
        }
        const called = collected.toolCalls.length > 0;
        return reply.headers(headers).send({
          id: meta.id,
          object: 'chat.completion',
          created: meta.created,
          model: meta.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: called && collected.text === '' ? null : collected.text,
                refusal: null,
                ...(called ? { tool_calls: collected.toolCalls } : {}),
              },
              logprobs: null,
              finish_reason: openAiFinishReason(collected.finish.finishReason),
            },
          ],
          usage: openAiUsage(collected.finish.usage),
          ...(collected.pendingApproval === null
            ? {}
            : { lakka: { pending_approval: collected.pendingApproval } }),
        });
      }

      // Committed: only now do headers go out.
      reply.hijack();
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        // Tells nginx-style proxies in front of us not to buffer.
        'x-accel-buffering': 'no',
        ...headers,
      });
      try {
        await write(res, chunk(meta, { role: 'assistant', content: '' }, null), controller.signal);
        let finish: Extract<Collected['finish'], object> | null = null;
        let pending: ReturnType<typeof pendingApproval> | null = null;
        let callIndex = 0;
        for await (const event of response.stream) {
          if (event.type === 'text') {
            await write(res, chunk(meta, { content: event.text }, null), controller.signal);
          } else if (event.type === 'tool-call') {
            const call = { index: callIndex, ...openAiToolCall(event) };
            callIndex += 1;
            await write(res, chunk(meta, { tool_calls: [call] }, null), controller.signal);
          } else if (event.type === 'tool-activity') {
            await write(
              res,
              chunk(meta, {}, null, { tool_activity: toolActivity(event) }),
              controller.signal,
            );
          } else if (event.type === 'approval-required') {
            pending = pendingApproval(event);
          } else if (event.type === 'finish') {
            finish = event;
          }
        }
        if (finish === null) throw new StreamInterruptedError('the stream ended without finishing');
        await write(
          res,
          chunk(
            meta,
            {},
            openAiFinishReason(finish.finishReason),
            pending === null ? undefined : { pending_approval: pending },
          ),
          controller.signal,
        );
        if (translated.includeUsage)
          await write(res, usageChunk(meta, finish.usage), controller.signal);
        await write(res, 'data: [DONE]\n\n', controller.signal);
      } catch (error) {
        const reason: unknown = controller.signal.reason;
        if (reason instanceof ShutdownAbort) {
          res.write(
            sse({
              error: {
                message: 'The server is restarting. Try again.',
                type: 'server_error',
                param: null,
                code: 'server_shutting_down',
              },
            }),
          );
        } else if (isReportable(error)) {
          // The person or key lost access mid-stream (AC 6), or a later tool round found no
          // room under a cap (H8): say so rather than "interrupted".
          res.write(sse(toOpenAiError(error).body));
        } else if (!controller.signal.aborted) {
          logger.warn('openai.stream_interrupted', { request_id: request.id }, error);
          res.write(
            sse({
              error: {
                message: 'The response was interrupted. Try again.',
                type: 'server_error',
                param: null,
                code: 'stream_interrupted',
              },
            }),
          );
        }
      } finally {
        await response.stream.done.catch(() => undefined);
        active.delete(controller);
        res.off('close', onClose);
        // Settled once the last bytes are flushed, for the shutdown wait above.
        res.end(() => writing.resolve());
      }
    },
  });
};
