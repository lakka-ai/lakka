import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, AttributeValue, HrTime } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { insertSpans } from '@lakka/db';
import type { Db, NewSpan } from '@lakka/db';
import { ERROR_TYPE, LK, STORED_ATTRIBUTES } from '../gateway/telemetry.ts';
import type { Logger } from '../logger.ts';

/*
 * The default trace exporter: finished spans into Postgres (OB-3, ADR 0076), so traces need no
 * external backend and nothing leaves the instance (NF-P1). Only allowlisted attribute names are
 * kept (STORED_ATTRIBUTES), on spans and on their events, so no content reaches the store even if
 * a span somewhere is given some (OB-4, AC 20). A failed write drops that batch and says so; a
 * trace is never worth failing a request for.
 */

// SDK 2.x export results, as plain numbers: 0 success, 1 failure.
const SUCCESS = 0;
const FAILED = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KINDS: Record<SpanKind, NewSpan['kind']> = {
  [SpanKind.INTERNAL]: 'internal',
  [SpanKind.SERVER]: 'server',
  [SpanKind.CLIENT]: 'client',
  [SpanKind.PRODUCER]: 'producer',
  [SpanKind.CONSUMER]: 'consumer',
};

const STATUSES: Record<SpanStatusCode, NewSpan['status']> = {
  [SpanStatusCode.UNSET]: 'unset',
  [SpanStatusCode.OK]: 'ok',
  [SpanStatusCode.ERROR]: 'error',
};

const toMs = ([seconds, nanos]: HrTime) => seconds * 1000 + nanos / 1e6;

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** The allowlisted attributes, as JSON values. */
export function storedAttributes(attributes: Attributes): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!STORED_ATTRIBUTES.has(name) || value === undefined) continue;
    const plain: AttributeValue = value;
    if (isPrimitive(plain)) kept[name] = plain;
    else if (Array.isArray(plain)) kept[name] = plain.filter((v) => v === null || isPrimitive(v));
  }
  return kept;
}

const uuidOr = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : null);

/** One stored row for a finished span. */
export function spanRow(span: ReadableSpan): NewSpan {
  const started = toMs(span.startTime);
  const errorType = span.attributes[ERROR_TYPE];
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    workspaceId: uuidOr(span.attributes[LK.WORKSPACE_ID]),
    requestId: uuidOr(span.attributes[LK.REQUEST_ID]),
    name: span.name,
    kind: KINDS[span.kind],
    status: STATUSES[span.status.code],
    errorType: typeof errorType === 'string' ? errorType : null,
    startedAt: new Date(started),
    durationMs: Math.max(0, toMs(span.duration)),
    attributes: storedAttributes(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      atMs: Math.max(0, toMs(event.time) - started),
      attributes: storedAttributes(event.attributes ?? {}),
    })),
  };
}

export function postgresSpanExporter(db: Db, logger: Logger): SpanExporter {
  return {
    export(batch, done) {
      insertSpans(db, batch.map(spanRow)).then(
        () => done({ code: SUCCESS }),
        (error: unknown) => {
          logger.warn('tracing.export_failed', { count: batch.length }, error);
          done({ code: FAILED });
        },
      );
    },
    async shutdown() {
      return undefined;
    },
  };
}
