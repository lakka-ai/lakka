import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody, UnknownModelError } from '@lakka/contracts';
import type { CustomModelBody, IssuedKey, ModelView, WorkspaceView } from '@lakka/contracts';
import { fixedCatalogue, loadCatalogue, resolveModel } from '@lakka/core';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/* The catalogue and custom models (PR-5, PR-7, BG-4, ADR 0037) against real Postgres. */

let t: TestApp;
let admin: SignedInUser;
let member: SignedInUser;
const catalogue = fixedCatalogue(loadCatalogue());

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;

const ollama = (overrides: Partial<CustomModelBody> = {}): CustomModelBody => ({
  provider: 'ollama',
  model: 'llama3.3:70b',
  contextWindow: 131_072,
  maxOutputTokens: 8192,
  capabilities: {
    vision: false,
    pdf: false,
    tools: true,
    structuredOutput: false,
    promptCaching: false,
    reasoning: false,
  },
  // Running a model on your own hardware can be free, but only when an admin says so.
  prices: {
    inputMicroUsdPerMtok: 0,
    outputMicroUsdPerMtok: 0,
    cacheReadMicroUsdPerMtok: null,
    cacheWriteMicroUsdPerMtok: null,
  },
  ...overrides,
});

beforeAll(async () => {
  t = await createTestApp();
  [admin, member] = await Promise.all([signedInUser(t, 'Admin'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
});

afterAll(async () => {
  await t.close();
});

describe('models', () => {
  it('PR-5: an instance admin sees the bundled catalogue with prices', async () => {
    const res = await as(t, admin).get('/api/models');
    expect(res.statusCode).toBe(200);
    const { models } = res.json() as { models: ModelView[] };
    expect(models.filter((m) => m.source === 'catalogue')).toHaveLength(
      catalogue.current().models.size,
    );
    expect(
      models.find((m) => m.id === 'anthropic:claude-sonnet-4-5')?.prices.inputMicroUsdPerMtok,
    ).toBe(3_000_000);
  });

  it('PR-7: an admin adds a model the catalogue does not know, and dispatch can price it', async () => {
    const res = await as(t, admin).post('/api/models/custom', ollama());
    expect(res.statusCode).toBe(201);
    const { model } = res.json() as { model: ModelView };
    expect(model).toMatchObject({ id: 'ollama:llama3.3:70b', source: 'custom' });
    const resolved = await resolveModel({ db: t.db, catalogue }, 'ollama:llama3.3:70b');
    expect(resolved.prices.inputMicroUsdPerMtok).toBe(0);
    const list = (await as(t, admin).get('/api/models')).json() as { models: ModelView[] };
    expect(list.models.map((m) => m.id)).toContain('ollama:llama3.3:70b');
  });

  it('CH-2: every model has a name for people; a custom model can set its own', async () => {
    const list = (await as(t, admin).get('/api/models')).json() as { models: ModelView[] };
    expect(list.models.find((m) => m.id === 'anthropic:claude-sonnet-4-5')?.displayName).toBe(
      'Claude Sonnet 4.5',
    );
    const named = await as(t, admin).post(
      '/api/models/custom',
      ollama({ model: 'mistral-small:24b', displayName: 'Mistral Small (office GPU)' }),
    );
    const { model } = named.json() as { model: ModelView };
    expect(model.displayName).toBe('Mistral Small (office GPU)');
    const id = model.customModelId ?? '';
    // Leaving the name out on a change goes back to one made from the id.
    const cleared = await as(t, admin).put(
      `/api/models/custom/${id}`,
      ollama({ model: 'mistral-small:24b' }),
    );
    expect((cleared.json() as { model: ModelView }).model.displayName).toBe('Mistral Small 24B');
    const tooLong = ollama({ model: 'mistral-small:24b', displayName: 'x'.repeat(81) });
    expect((await as(t, admin).put(`/api/models/custom/${id}`, tooLong)).statusCode).toBe(400);
    await as(t, admin).delete(`/api/models/custom/${id}`);
  });

  it('BG-4: a model that is neither listed nor added has no price and is refused', async () => {
    await expect(
      resolveModel({ db: t.db, catalogue }, 'openai:not-a-real-model'),
    ).rejects.toBeInstanceOf(UnknownModelError);
  });

  it('a custom model cannot take a catalogue id, which would change what that model costs', async () => {
    const res = await as(t, admin).post(
      '/api/models/custom',
      ollama({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
    );
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('model_exists');
    const again = await as(t, admin).post('/api/models/custom', ollama());
    expect(code(again)).toBe('model_exists');
  });

  it('PR-7: an admin changes and removes a custom model', async () => {
    const created = (
      (await as(t, admin).post('/api/models/custom', ollama({ model: 'qwen3:32b' }))).json() as {
        model: ModelView;
      }
    ).model;
    const id = created.customModelId ?? '';
    const priced = ollama({
      model: 'qwen3:32b',
      prices: {
        inputMicroUsdPerMtok: 100_000,
        outputMicroUsdPerMtok: 300_000,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
    });
    const changed = await as(t, admin).put(`/api/models/custom/${id}`, priced);
    expect((changed.json() as { model: ModelView }).model.prices.outputMicroUsdPerMtok).toBe(
      300_000,
    );
    expect((await as(t, admin).delete(`/api/models/custom/${id}`)).statusCode).toBe(204);
    expect((await as(t, admin).delete(`/api/models/custom/${id}`)).statusCode).toBe(404);
    await expect(resolveModel({ db: t.db, catalogue }, 'ollama:qwen3:32b')).rejects.toBeInstanceOf(
      UnknownModelError,
    );
  });

  it('prices must be whole micro-USD and present; fields are validated at the boundary', async () => {
    const fractional = ollama({
      model: 'bad',
      prices: { ...ollama().prices, inputMicroUsdPerMtok: 1.5 },
    });
    expect((await as(t, admin).post('/api/models/custom', fractional)).statusCode).toBe(400);
    const { prices: _prices, ...unpriced } = ollama({ model: 'bad2' });
    expect((await as(t, admin).post('/api/models/custom', unpriced)).statusCode).toBe(400);
  });

  it('NF-S2: people who are not instance admins, and keys, cannot read or change models', async () => {
    expect((await as(t, member).get('/api/models')).statusCode).toBe(403);
    expect(
      (await as(t, member).post('/api/models/custom', ollama({ model: 'x' }))).statusCode,
    ).toBe(403);

    // Even an instance admin's key: prices decide what budgets are charged.
    const ws = (
      (
        await as(t, admin).post('/api/workspaces', { name: 'M', slug: `m-${Date.now()}` })
      ).json() as {
        workspace: WorkspaceView;
      }
    ).workspace;
    const issued = (
      await as(t, admin).post(`/api/workspaces/${ws.id}/keys`, { name: 'k' })
    ).json() as IssuedKey;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/models/custom',
      headers: { authorization: `Bearer ${issued.secret}` },
      payload: ollama({ model: 'y' }),
    });
    expect(res.statusCode).toBe(403);
  });
});
