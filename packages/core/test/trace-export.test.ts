import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import type { Db } from '@lakka/db';
import { LK } from '../src/gateway/telemetry.ts';
import { createLogger } from '../src/logger.ts';
import { outsideExporter } from '../src/observability/tracing.ts';
import { createTracing } from '../src/observability/tracing.ts';

/* What an outside OTLP backend is sent (OB-5, OB-4, ADR 0080): the stored names only, the service named. */

const lines: string[] = [];
const { logger } = createLogger({
  level: 'debug',
  service: 'trace-export-test',
  destination: { write: (line: string) => void lines.push(line) },
});

describe('trace export (OB-5)', () => {
  it('OB-4: an outside backend gets only allowlisted attributes, and the service is lakka', async () => {
    const stored = new InMemorySpanExporter();
    const tracing = createTracing({ db: {} as Db, logger, exporter: stored });
    const span = tracing.tracer.startSpan('request', {
      kind: SpanKind.SERVER,
      attributes: { [LK.SURFACE]: 'chat', 'gen_ai.input.messages': 'a secret prompt' },
    });
    span.addEvent('lakka.candidate_skipped', { [LK.MODEL]: 'x', 'db.statement': 'select 1' });
    span.end();
    await tracing.forceFlush();

    const outside = new InMemorySpanExporter();
    const exporter = outsideExporter(outside, logger);
    await new Promise<void>((resolve) =>
      exporter.export(stored.getFinishedSpans(), () => resolve()),
    );
    const [sent] = outside.getFinishedSpans();
    expect(sent?.attributes).toEqual({ [LK.SURFACE]: 'chat' });
    expect(sent?.events[0]?.attributes).toEqual({ [LK.MODEL]: 'x' });
    expect(sent?.resource.attributes['service.name']).toBe('lakka');
    expect(sent?.spanContext().spanId).toBe(stored.getFinishedSpans()[0]?.spanContext().spanId);
    // The span itself, which the trace store also writes, is unchanged.
    expect(stored.getFinishedSpans()[0]?.attributes['gen_ai.input.messages']).toBe(
      'a secret prompt',
    );
    await tracing.shutdown();
  });

  it('says when a batch did not go, by count, never the error', async () => {
    const failing = {
      export: (_spans: unknown[], done: (r: { code: number }) => void) => done({ code: 1 }),
      shutdown: async () => undefined,
    };
    const tracing = createTracing({ db: {} as Db, logger, exporter: new InMemorySpanExporter() });
    tracing.tracer.startSpan('request').end();
    const before = lines.length;
    await new Promise<void>((resolve) =>
      outsideExporter(failing, logger).export([], () => resolve()),
    );
    const logged = lines.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged).toMatchObject([{ msg: 'tracing.otlp_export_failed', count: 0 }]);
    await tracing.shutdown();
  });
});
