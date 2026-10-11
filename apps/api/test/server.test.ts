import { afterEach, describe, expect, it } from 'vitest';
import * as contracts from '@lakka/contracts';
import { apiErrorBody, healthReport, ProviderAuthError } from '@lakka/contracts';
import { createLogger } from '@lakka/core';
import type { HealthCheck } from '@lakka/core';
import { MAPPED_CODES, toOpenAiError } from '../src/openai/errors.ts';
import { buildServer, PROCESS_ONLY_CODES, STATUS_BY_CODE } from '../src/server.ts';
import type { ApiServer } from '../src/server.ts';

const CANARY = 'canary-b41d2e';

let current: ApiServer | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

function setup(healthChecks: Record<string, HealthCheck>, optional?: Record<string, HealthCheck>) {
  const raw: string[] = [];
  const { logger, frameworkLogger } = createLogger({
    level: 'trace',
    service: 'api-test',
    destination: { write: (s: string) => void raw.push(s) },
  });
  current = buildServer({
    logger,
    frameworkLogger,
    healthChecks,
    ...(optional === undefined ? {} : { optionalHealthChecks: async () => optional }),
    healthTimeoutMs: 50,
  });
  return { app: current, logText: () => raw.join('') };
}

const ok: HealthCheck = async () => undefined;
const refused: HealthCheck = async () => {
  throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
};

describe('GET /healthz', () => {
  it('AD-5: returns 200 with database and cache reported separately', async () => {
    const { app } = setup({ database: ok, cache: ok });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = healthReport.parse(res.json());
    expect(body.status).toBe('ok');
    expect(Object.keys(body.checks).toSorted()).toEqual(['cache', 'database']);
  });

  it('NF-O4: returns 503 and names the failing dependency when one is down', async () => {
    const { app } = setup({ database: refused, cache: ok });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    const body = healthReport.parse(res.json());
    expect(body.checks['database']).toMatchObject({ status: 'down', error_code: 'unreachable' });
    expect(body.checks['cache']?.status).toBe('ok');
    expect(res.body).not.toContain('10.0.0.5');
  });
});

describe('GET /healthz with the classifier and providers (ADR 0081)', () => {
  it('NF-O4: a provider down answers 200 and degraded, naming the provider', async () => {
    const { app } = setup(
      { database: ok, cache: ok },
      { classifier: ok, 'provider:openai': refused, 'provider:anthropic': ok },
    );
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = healthReport.parse(res.json());
    expect(body.status).toBe('degraded');
    expect(body.checks['provider:openai']).toMatchObject({
      status: 'down',
      error_code: 'unreachable',
    });
    expect(body.checks['provider:anthropic']?.status).toBe('ok');
    expect(res.body).not.toContain('10.0.0.5');
  });

  it('AD-5: the database down answers 503 even when every provider is up', async () => {
    const { app } = setup({ database: refused, cache: ok }, { 'provider:openai': ok });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(healthReport.parse(res.json()).status).toBe('down');
  });
});

describe('response headers (ADR 0085)', () => {
  it('H6: every api response forbids running, framing and sniffing what it returns', async () => {
    const { app } = setup({ database: ok, cache: ok });
    for (const url of ['/healthz', '/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('H6: a route that sets its own policy keeps it', async () => {
    const { app } = setup({});
    app.get('/file', async (_request, reply) =>
      reply.header('content-security-policy', "default-src 'none'; sandbox").send('x'),
    );
    const res = await app.inject({ method: 'GET', url: '/file' });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });
});

/** One instance of every error class contracts defines, by its code. */
function contractErrors(): Map<string, contracts.LakkaError> {
  const errors = new Map<string, contracts.LakkaError>();
  for (const value of Object.values(contracts)) {
    if (typeof value !== 'function' || !(value.prototype instanceof contracts.LakkaError)) {
      continue;
    }
    // The arguments some constructors need beyond a message; the rest ignore them.
    const error: unknown = Reflect.construct(value, [
      'x',
      { scope: 'workspace', remainingMicroUsd: 0n },
    ]);
    if (error instanceof contracts.LakkaError) errors.set(error.code, error);
  }
  return errors;
}

describe('error statuses (API-5)', () => {
  const errors = contractErrors();

  it('API-5: every error class has an explicit status, or is one only a starting process raises', () => {
    expect(errors.size).toBeGreaterThan(30);
    const unlisted = [...errors.keys()].filter(
      (code) => !(code in STATUS_BY_CODE) && !PROCESS_ONLY_CODES.has(code),
    );
    expect(unlisted).toEqual([]);
  });

  it('API-5: /api and /v1 give each code the same HTTP status', () => {
    const differ = MAPPED_CODES.flatMap((code) => {
      const error = errors.get(code);
      if (error === undefined) return [];
      const statuses = { api: STATUS_BY_CODE[code], v1: toOpenAiError(error).status };
      return statuses.api === statuses.v1 ? [] : [{ code, ...statuses }];
    });
    expect(differ).toEqual([]);
  });

  it('API-5: a provider refusing the key answers 502 with its code, not 500', async () => {
    const { app } = setup({});
    app.get('/provider', async () => {
      throw new ProviderAuthError('the provider refused the key');
    });
    const res = await app.inject({ method: 'GET', url: '/provider' });
    expect(res.statusCode).toBe(502);
    expect(apiErrorBody.parse(res.json()).error.code).toBe('provider_auth_failed');
  });
});

describe('request handling', () => {
  it('returns the documented error body for unknown routes', async () => {
    const { app } = setup({});
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(apiErrorBody.parse(res.json()).error.code).toBe('not_found');
  });

  it('never returns raw error messages to clients', async () => {
    const { app } = setup({});
    app.get('/boom', async () => {
      throw new Error(`driver exploded: ${CANARY}`);
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(apiErrorBody.parse(res.json()).error.code).toBe('internal_error');
    expect(res.body).not.toContain(CANARY);
  });

  it('echoes a well-formed upstream request id and replaces a malformed one', async () => {
    const { app } = setup({});
    const good = await app.inject({
      url: '/healthz',
      headers: { 'x-request-id': 'abcdef12-3456' },
    });
    expect(good.headers['x-request-id']).toBe('abcdef12-3456');
    const bad = await app.inject({ url: '/healthz', headers: { 'x-request-id': 'x y<script>' } });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('log canary', () => {
  it('NF-S5: secrets in headers, cookies, query, body and error messages never reach the log', async () => {
    const { app, logText } = setup({ database: refused, cache: ok });
    app.post('/echo-fail', async () => {
      throw new Error(`upstream rejected prompt ${CANARY}`);
    });
    await app.inject({
      method: 'GET',
      url: `/healthz?api_key=${CANARY}`,
      headers: { authorization: `Bearer ${CANARY}`, cookie: `session=${CANARY}` },
    });
    await app.inject({
      method: 'POST',
      url: `/echo-fail?token=${CANARY}`,
      headers: { authorization: `Bearer ${CANARY}`, 'content-type': 'application/json' },
      payload: { prompt: CANARY, password: CANARY },
    });
    await app.inject({ method: 'GET', url: `/missing/${CANARY}` });

    const text = logText();
    expect(text).toContain('http.request');
    expect(text).toContain('http.unhandled_error');
    expect(text).not.toContain(CANARY);
  });
});
