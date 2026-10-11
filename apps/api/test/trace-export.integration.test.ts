import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelView, TraceExportView, WorkspaceView } from '@lakka/contracts';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { TestApp } from './support.ts';

/*
 * Sending traces to a customer's own backend (OB-5, NF-P1, NF-P2, ADR 0080), against an OTLP/HTTP
 * receiver: only when an operator set an endpoint, with its headers, the stored attribute names
 * only, and the service named; with none set, nothing is sent, whatever OTEL_* says.
 */

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let receiver: Server;
let receiverUrl: string;
const received: Received[] = [];
let fake: FakeProvider;

async function startReceiver(): Promise<void> {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
}

/** An app with one member, a model, and a request made through chat. */
async function appWithARequest(t: TestApp, canary: string) {
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  const [root, member] = await Promise.all([signedInUser(t, 'Root'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  const ws = (
    (
      await as(t, root).post('/api/workspaces', {
        name: 'Alpha',
        slug: `alpha-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  await as(t, root).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
    role: 'member',
  });
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  const model = (
    (
      await as(t, root).post('/api/models/custom', {
        provider: 'fake',
        model: `ok~${randomBytes(3).toString('hex')}`,
        contextWindow: 100_000,
        maxOutputTokens: 4096,
        capabilities: {
          vision: false,
          pdf: false,
          tools: false,
          structuredOutput: false,
          promptCaching: false,
          reasoning: false,
        },
        prices: {
          inputMicroUsdPerMtok: 1_000_000,
          outputMicroUsdPerMtok: 2_000_000,
          cacheReadMicroUsdPerMtok: null,
          cacheWriteMicroUsdPerMtok: null,
        },
      })
    ).json() as { model: ModelView }
  ).model;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: member.cookie,
      origin: PUBLIC_URL,
      'x-lakka-workspace': ws.id,
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: 100,
      messages: [{ role: 'user', content: `Remember ${canary}` }],
    }),
  });
  expect(res.status).toBe(200);
  await res.text();
  return { root, member, requestId: res.headers.get('x-lakka-request-id') ?? '' };
}

/** Every span the receiver got, with its attributes flattened, and the resources. */
function spansIn(bodies: readonly Received[]) {
  const spans: { name: string; attributes: Record<string, unknown> }[] = [];
  const services = new Set<unknown>();
  for (const b of bodies) {
    const payload = JSON.parse(b.body) as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue?: string } }[] };
        scopeSpans: {
          spans: {
            name: string;
            attributes: { key: string; value: Record<string, unknown> }[];
          }[];
        }[];
      }[];
    };
    for (const rs of payload.resourceSpans) {
      services.add(rs.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue);
      for (const ss of rs.scopeSpans) {
        for (const s of ss.spans) {
          spans.push({
            name: s.name,
            attributes: Object.fromEntries(
              s.attributes.map((a) => [a.key, Object.values(a.value)[0]]),
            ),
          });
        }
      }
    }
  }
  return { spans, services };
}

beforeAll(async () => {
  await startReceiver();
  fake = await startFakeProvider();
});

afterAll(async () => {
  await fake.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

describe('trace export (OB-5)', () => {
  it('OB-5: with an endpoint set, traces also go there, with its headers and no content', async () => {
    const t = await createTestApp({
      otlp: {
        endpoint: `${receiverUrl}/v1/traces`,
        headers: { authorization: 'Bearer otlp-test-key' },
      },
    });
    received.length = 0;
    try {
      const canary = `canary-${randomBytes(6).toString('hex')}`;
      const { root, member, requestId } = await appWithARequest(t, canary);
      let exported: ReturnType<typeof spansIn> = { spans: [], services: new Set() };
      for (let i = 0; i < 40; i += 1) {
        await t.tracing.forceFlush();
        exported = spansIn(received);
        if (exported.spans.some((s) => s.name === 'request')) break;
        await sleep(50);
      }
      expect(received.every((r) => r.path === '/v1/traces')).toBe(true);
      expect(received[0]?.headers.authorization).toBe('Bearer otlp-test-key');
      expect(received[0]?.headers['content-type']).toMatch(/json/);
      expect([...exported.services]).toEqual(['lakka']);
      const request = exported.spans.find((s) => s.name === 'request');
      expect(request?.attributes).toMatchObject({
        'lakka.request_id': requestId,
        'lakka.surface': 'chat',
      });
      expect(exported.spans.some((s) => s.name.startsWith('chat '))).toBe(true);
      // What was said never leaves.
      expect(received.map((r) => r.body).join('')).not.toContain(canary);
      expect(received.map((r) => r.body).join('')).not.toContain('Hello there');

      // NF-P2: instance admins can see that traces leave, and to where; members cannot.
      const status = await as(t, root).get('/api/observability/export');
      expect((status.json() as { export: TraceExportView }).export).toEqual({
        enabled: true,
        destination: receiverUrl,
      });
      expect((await as(t, member).get('/api/observability/export')).statusCode).toBe(403);
    } finally {
      await t.close();
    }
  });

  it('NF-P1: with no endpoint set, nothing is sent, even with OTEL_* pointing somewhere', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = receiverUrl;
    process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = `${receiverUrl}/v1/traces`;
    const t = await createTestApp();
    received.length = 0;
    try {
      const { root } = await appWithARequest(t, 'nothing-to-see');
      await t.tracing.forceFlush();
      await sleep(500);
      expect(received).toEqual([]);
      const status = await as(t, root).get('/api/observability/export');
      expect((status.json() as { export: TraceExportView }).export).toEqual({
        enabled: false,
        destination: null,
      });
    } finally {
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      delete process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
      await t.close();
    }
  });
});
