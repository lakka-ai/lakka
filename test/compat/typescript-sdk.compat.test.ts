import { beforeAll, describe, expect, it } from 'vitest';
import OpenAI, { APIError, AuthenticationError, NotFoundError } from 'openai';
import { readState } from './state.ts';
import type { CompatState } from './state.ts';

/*
 * The official OpenAI TypeScript SDK against the running stack, through Caddy, with nothing but
 * a base URL and a key (AC 15, API-1, API-2, API-4, API-5, ADR 0064). No special handling: every
 * call is the SDK's ordinary API. The streaming checks also replace Spike B's proof that Caddy
 * passes a stream through unbuffered (ADR 0025), now with real completions.
 */

let state: CompatState;
let client: OpenAI;

/** 1 x 1 PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeAll(() => {
  state = readState();
  client = new OpenAI({ baseURL: state.apiBase, apiKey: state.key });
});

describe('the TypeScript SDK (AC 15)', () => {
  it('API-2: lists auto, the routes and the models the key may use', async () => {
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    expect(ids.slice(0, 2)).toEqual(['auto', `route/${state.route}`]);
    expect(ids).toEqual(expect.arrayContaining(Object.values(state.models)));
  });

  it('API-1: a completion, with the routing decision in the headers (G3)', async () => {
    const { data, response } = await client.chat.completions
      .create({ model: state.models.ok, messages: [{ role: 'user', content: 'Hello' }] })
      .withResponse();
    expect(data.choices[0]?.message.content).toBe('Hello there');
    expect(data.choices[0]?.finish_reason).toBe('stop');
    expect(data.model).toBe(state.models.ok);
    expect(data.usage?.total_tokens).toBeGreaterThan(0);
    expect(response.headers.get('x-lakka-routing-rule')).toBe('explicit');
  });

  it('API-1: a streamed completion, with a usage chunk when asked', async () => {
    const stream = await client.chat.completions.create({
      model: state.models.ok,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      finish = chunk.choices[0]?.finish_reason ?? finish;
      usage = chunk.usage ?? usage;
    }
    expect(text).toBe('Hello there');
    expect(finish).toBe('stop');
    expect(usage?.completion_tokens).toBeGreaterThan(0);
  });

  it('invariant 6: chunks reach the client as the model sends them, not buffered by the proxy', async () => {
    // The slow model sends 40 chunks 25 ms apart: about a second from first to last.
    const started = performance.now();
    const arrivals: number[] = [];
    const stream = await client.chat.completions.create({
      model: state.models.slow,
      messages: [{ role: 'user', content: 'Count' }],
      stream: true,
    });
    for await (const chunk of stream) {
      if ((chunk.choices[0]?.delta.content ?? '') !== '')
        arrivals.push(performance.now() - started);
    }
    expect(arrivals.length).toBeGreaterThanOrEqual(30);
    const spread = (arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0);
    // Buffered, they would arrive together at the end; streamed, they arrive over the second.
    expect(spread).toBeGreaterThan(600);
    const firstHalf = arrivals.filter((a) => a < (arrivals[0] ?? 0) + spread / 2).length;
    expect(firstHalf).toBeGreaterThan(arrivals.length / 4);
  });

  it('API-4: "auto" routes code to the code route, and "route/<name>" asks for it', async () => {
    const code = 'Why does this fail?\n```js\nconst a = 1;\na = 2;\n```';
    const routed = await client.chat.completions
      .create({ model: 'auto', messages: [{ role: 'user', content: code }] })
      .withResponse();
    expect(routed.data.model).toBe(state.models.coder);
    expect(routed.response.headers.get('x-lakka-routing-rule')).toBe('signal');
    const named = await client.chat.completions.create({
      model: `route/${state.route}`,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(named.model).toBe(state.models.coder);
  });

  it('CH-5: an image sent inline reaches a model that reads images', async () => {
    const completion = await client.chat.completions.create({
      model: state.models.vision,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL}` } },
          ],
        },
      ],
    });
    expect(completion.choices[0]?.message.content).toBe('Hello there');
  });

  it('API-5, G2: a budget refusal is a 402 of its own, which the SDK does not retry', async () => {
    let calls = 0;
    const counting = new OpenAI({
      baseURL: state.apiBase,
      apiKey: state.poorKey,
      fetch: (input, init) => {
        calls += 1;
        return fetch(input, init);
      },
    });
    const refused = await counting.chat.completions
      .create({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(APIError);
    expect(refused).toMatchObject({
      status: 402,
      type: 'budget_exceeded',
      code: 'budget_exceeded',
    });
    expect(calls).toBe(1);
  });

  it('API-5: a bad key and an unknown model are the errors the SDK knows', async () => {
    const stranger = new OpenAI({ baseURL: state.apiBase, apiKey: 'sk-not-a-real-key' });
    await expect(stranger.models.list()).rejects.toBeInstanceOf(AuthenticationError);
    const unknown = await client.chat.completions
      .create({ model: 'nobody:nothing', messages: [{ role: 'user', content: 'Hello' }] })
      .catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(NotFoundError);
    expect(unknown).toMatchObject({ code: 'model_not_found' });
  });

  it('CH-7: a stream that breaks after it started ends with an error the SDK raises', async () => {
    const stream = await client.chat.completions.create({
      model: state.models.drop,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    let text = '';
    const failure = await (async () => {
      for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
    })().catch((error: unknown) => error);
    expect(text).not.toBe('');
    expect(failure).toBeInstanceOf(APIError);
    expect(String((failure as Error).message)).toMatch(/interrupted/);
  });
});
