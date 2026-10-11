import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readState } from '../state.ts';
import type { CompatState } from '../state.ts';
import { CODE, setWorkspaceCap, sseData } from './support.ts';

/*
 * An unmodified Open WebUI pointed at Lakka (AC 14, API-6, ADR 0064). Driven through its own
 * HTTP API, which is what its interface calls: the requests Lakka receives are Open WebUI's,
 * made by its own OpenAI client code.
 */

const OPEN_WEBUI = process.env['LAKKA_COMPAT_OPEN_WEBUI_URL'] ?? 'http://127.0.0.1:8181';

let state: CompatState;
let token: string;

async function chat(body: unknown): Promise<Response> {
  return fetch(`${OPEN_WEBUI}/api/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** A streamed reply through Open WebUI: its text and the model each chunk names. */
async function streamed(res: Response): Promise<{ text: string; models: Set<string> }> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  let text = '';
  const models = new Set<string>();
  for (const chunk of sseData(await res.text()) as {
    model?: string;
    choices?: { delta?: { content?: string } }[];
  }[]) {
    text += chunk.choices?.[0]?.delta?.content ?? '';
    if (chunk.model !== undefined) models.add(chunk.model);
  }
  return { text, models };
}

beforeAll(async () => {
  state = readState();
  // With sign-in off, Open WebUI makes its one local admin on the first sign-in.
  const res = await fetch(`${OPEN_WEBUI}/api/v1/auths/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: '', password: '' }),
  });
  if (!res.ok) throw new Error(`Open WebUI sign-in failed: ${res.status}`);
  token = ((await res.json()) as { token: string }).token;
});

afterAll(async () => {
  await setWorkspaceCap(state, null).catch(() => undefined);
});

describe('Open WebUI (AC 14, API-6)', () => {
  it('AC 14: lists the models Lakka offers the key: auto, the routes and the models', async () => {
    const res = await fetch(`${OPEN_WEBUI}/api/models?refresh=true`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(['auto', `route/${state.route}`, ...Object.values(state.models)]),
    );
  });

  it('AC 14: holds a streaming conversation over two turns', async () => {
    const first = await streamed(
      await chat({
        model: state.models.ok,
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    );
    expect(first.text).toBe('Hello there');
    const second = await streamed(
      await chat({
        model: state.models.ok,
        stream: true,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: first.text },
          { role: 'user', content: 'And again?' },
        ],
      }),
    );
    expect(second.text).toBe('Hello there');
  });

  it("AC 14: Lakka's routing applies: auto sends code to the code route", async () => {
    const reply = await streamed(
      await chat({ model: 'auto', stream: true, messages: [{ role: 'user', content: CODE }] }),
    );
    expect(reply.text).toBe('Hello there');
    expect([...reply.models]).toEqual([state.models.coder]);
  });

  it("AC 14: Lakka's budgets apply: over the cap, the request is refused and says why", async () => {
    await setWorkspaceCap(state, '1');
    try {
      const res = await chat({
        model: state.models.ok,
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      // Open WebUI turns the 402 into an error of its own that carries Lakka's message.
      expect(res.ok).toBe(false);
      expect(await res.text()).toMatch(/budget/i);
    } finally {
      await setWorkspaceCap(state, null);
    }
  });
});
