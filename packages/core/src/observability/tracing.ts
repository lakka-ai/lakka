import { trace } from '@opentelemetry/api';
import type { Attributes, Context, Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { TracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace';
import type { Db } from '@lakka/db';
import { LK } from '../gateway/telemetry.ts';
import type { Logger } from '../logger.ts';
import { postgresSpanExporter, storedAttributes } from './exporter.ts';

/*
 * Tracing for one process (OB-1, OB-3, ADR 0041, ADR 0076). The provider is handed to the code
 * that makes spans, never registered globally: libraries that also speak the OpenTelemetry API,
 * such as Better Auth and Drizzle, would otherwise start emitting spans of their own, with SQL
 * text or email addresses in them. Spans go to Postgres in batches, and, only when an operator
 * set an endpoint, to their own OTLP backend too (OB-5, ADR 0080).
 */

/** A span knows the request and workspace it belongs to, even one started deep in the gateway. */
const inheritRequest: SpanProcessor = {
  onStart(span: Span, parentContext: Context) {
    const parent = trace.getSpan(parentContext) as (Span & { attributes?: unknown }) | undefined;
    const inherited = parent?.attributes as Record<string, unknown> | undefined;
    if (inherited === undefined) return;
    for (const name of [LK.REQUEST_ID, LK.WORKSPACE_ID]) {
      const value = inherited[name];
      if (span.attributes[name] === undefined && typeof value === 'string') {
        span.setAttribute(name, value);
      }
    }
  },
  onEnd(_span: ReadableSpan) {
    return undefined;
  },
  async forceFlush() {
    return undefined;
  },
  async shutdown() {
    return undefined;
  },
};

// SDK export results, as plain numbers: 1 is failure.
const FAILED = 1;

/**
 * What an outside backend is sent: the stored attribute names only, as the trace store keeps
 * (ADR 0076), with the service named. The span itself is not changed, only how it reads here.
 */
export function exportedSpan(span: ReadableSpan): ReadableSpan {
  const resource = Object.create(span.resource, {
    attributes: { value: { ...span.resource.attributes, 'service.name': 'lakka' } },
  }) as ReadableSpan['resource'];
  return Object.create(span, {
    attributes: { value: storedAttributes(span.attributes) as Attributes },
    events: {
      value: span.events.map((event) => ({
        ...event,
        attributes: storedAttributes(event.attributes ?? {}) as Attributes,
      })),
    },
    resource: { value: resource },
  }) as ReadableSpan;
}

/** Sends spans outside through `inner`, allowlisted, and says when a batch did not go. */
export function outsideExporter(inner: SpanExporter, logger: Logger): SpanExporter {
  return {
    export(spans, done) {
      inner.export(spans.map(exportedSpan), (result) => {
        // Never the error itself: it may carry the endpoint's address or what it replied.
        if (result.code === FAILED)
          logger.warn('tracing.otlp_export_failed', { count: spans.length });
        done(result);
      });
    },
    shutdown: () => inner.shutdown(),
    forceFlush: async () => {
      await inner.forceFlush?.();
    },
  };
}

export interface Tracing {
  tracer: Tracer;
  /** Writes out every span that has ended. */
  forceFlush(): Promise<void>;
  /** Flushes, then stops; for shutdown (NF-O5). */
  shutdown(): Promise<void>;
}

export function createTracing(options: {
  db: Db;
  logger: Logger;
  /** Replaces the Postgres exporter; tests only. */
  exporter?: SpanExporter;
  /** A customer's own OTLP/HTTP backend, when an operator set one (OB-5, ADR 0080). */
  otlp?: { endpoint: string; headers: Record<string, string> } | null;
}): Tracing {
  const batches = { scheduledDelayMillis: 1000, maxExportBatchSize: 256, maxQueueSize: 4096 };
  const otlp = options.otlp ?? null;
  const provider = new TracerProvider({
    spanProcessors: [
      inheritRequest,
      new BatchSpanProcessor({
        exporter: options.exporter ?? postgresSpanExporter(options.db, options.logger),
        ...batches,
      }),
      ...(otlp === null
        ? []
        : [
            new BatchSpanProcessor({
              exporter: outsideExporter(
                new OTLPTraceExporter({
                  url: otlp.endpoint,
                  headers: otlp.headers,
                  timeoutMillis: 10_000,
                }),
                options.logger,
              ),
              ...batches,
            }),
          ]),
    ],
  });
  return {
    tracer: provider.getTracer('lakka'),
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
