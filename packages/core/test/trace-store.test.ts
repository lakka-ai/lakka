import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import type { Db } from '@lakka/db';
import { LK } from '../src/gateway/telemetry.ts';
import { createLogger } from '../src/logger.ts';
import { spanRow, storedAttributes } from '../src/observability/exporter.ts';
import { createTracing } from '../src/observability/tracing.ts';

/*
 * What reaches the trace store (OB-1, OB-3, OB-4, ADR 0076): allowlisted attributes only, a row
 * that knows its request and workspace, and a provider that is never the global one.
 */

const REQUEST = '01890000-0000-7000-8000-000000000001';
const WORKSPACE = '01890000-0000-7000-8000-000000000002';

const { logger } = createLogger({
  level: 'fatal',
  service: 'trace-store-test',
  destination: { write: () => undefined },
});

/** Tracing into memory; the Postgres exporter is not used, so no database is needed. */
function inMemory() {
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({ db: {} as Db, logger, exporter });
  return { exporter, tracing };
}

describe('the trace store (OB-1, OB-4)', () => {
  it('OB-4: only allowlisted attributes are kept, so content cannot reach the store', () => {
    expect(
      storedAttributes({
        [LK.MODEL]: 'anthropic:claude-haiku-4-5',
        'gen_ai.usage.input_tokens': 12,
        'gen_ai.response.finish_reasons': ['stop'],
        // Names a library or a careless span might use for content.
        'gen_ai.input.messages': 'my secret prompt',
        'gen_ai.output.messages': 'the reply',
        'db.statement': "select * from users where email = 'a@example.com'",
        'http.url': 'https://example.com/?token=secret',
      }),
    ).toEqual({
      [LK.MODEL]: 'anthropic:claude-haiku-4-5',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.response.finish_reasons': ['stop'],
    });
  });

  it('OB-1: a stored row carries its trace, parent, request, workspace, status and events', async () => {
    const { exporter, tracing } = inMemory();
    const root = tracing.tracer.startSpan('request', {
      kind: SpanKind.SERVER,
      attributes: { [LK.REQUEST_ID]: REQUEST, [LK.WORKSPACE_ID]: WORKSPACE },
    });
    const child = tracing.tracer.startSpan(
      'chat model',
      { kind: SpanKind.CLIENT, attributes: { 'error.type': 'overloaded' } },
      trace.setSpan(context.active(), root),
    );
    child.addEvent('lakka.candidate_skipped', { [LK.MODEL]: 'x', 'secret.text': 'no' });
    child.setStatus({ code: SpanStatusCode.ERROR });
    child.end();
    root.end();
    await tracing.forceFlush();
    const [chat, request] = exporter.getFinishedSpans().map(spanRow);
    expect(request).toMatchObject({
      name: 'request',
      kind: 'server',
      status: 'unset',
      parentSpanId: null,
      requestId: REQUEST,
      workspaceId: WORKSPACE,
    });
    // The child knows its request and workspace from its parent, set by the processor.
    expect(chat).toMatchObject({
      name: 'chat model',
      kind: 'client',
      status: 'error',
      errorType: 'overloaded',
      traceId: request?.traceId,
      parentSpanId: request?.spanId,
      requestId: REQUEST,
      workspaceId: WORKSPACE,
    });
    expect(chat?.events).toEqual([
      {
        name: 'lakka.candidate_skipped',
        atMs: expect.any(Number),
        attributes: { [LK.MODEL]: 'x' },
      },
    ]);
    await tracing.shutdown();
  });

  it('a request or workspace that is not an id is stored as none, not as whatever it was', () => {
    const { tracing } = inMemory();
    const span = tracing.tracer.startSpan('request', {
      attributes: { [LK.REQUEST_ID]: 'not-a-uuid', [LK.WORKSPACE_ID]: "'; drop table spans" },
    });
    span.end();
    const row = spanRow(span as never);
    expect(row).toMatchObject({ requestId: null, workspaceId: null });
  });

  it('ADR 0041: the provider is never the global one, so libraries emit nothing', () => {
    inMemory();
    const global = trace.getTracer('some-library').startSpan('db query');
    expect(global.isRecording()).toBe(false);
    global.end();
  });
});
