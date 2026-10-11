import { describe, expect, it } from 'vitest';
import type { GatewayStreamEvent, ModelView, TokenUsage } from '@lakka/contracts';
import type { DispatchedStream, DispatchSummary } from '../src/gateway/dispatch.ts';
import { toolLoop } from '../src/pipeline/tool-loop.ts';
import type { CallRunner, LoopDeps, ModelStreamEvent, Round } from '../src/pipeline/tool-loop.ts';
import { ToolLoopGuard } from '../src/tools/guard.ts';

/*
 * Every round of a tool loop settles its reservation exactly once, however the reply ends, and
 * before the loop's `done` settles (invariant 4, BG-5, H8, ADR 0071). The fake rounds behave like
 * a dispatched stream: their usage is recorded, and their `done` settles, only once they have been
 * read to an end or closed.
 */

const model = { id: 'fake:m' } as ModelView;
const usage: TokenUsage = {
  inputTokens: 10,
  uncachedInputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 5,
  reasoningTokens: 0,
};
const text = (t: string): GatewayStreamEvent => ({ type: 'text', text: t });
const finish = (reason: 'stop' | 'tool-calls'): GatewayStreamEvent => ({
  type: 'finish',
  finishReason: reason,
  usage,
});
const toolCall: GatewayStreamEvent = {
  type: 'tool-call',
  callId: 'c1',
  name: 'srv__echo',
  arguments: '{}',
};
/** A round that asks for a tool, so the loop goes on to another. */
const callsATool = [text('Let me check. '), toolCall, finish('tool-calls')];
const answers = [text('Here it is.'), finish('stop')];

interface Script {
  events: readonly GatewayStreamEvent[];
  /** Throw after this many events. */
  failAfter?: number;
  /** Recording the round's usage fails, so its `done` rejects. */
  doneRejects?: boolean;
}

function fakeRound(n: number, script: Script, log: string[]): Round {
  const { promise: done, resolve, reject } = Promise.withResolvers<DispatchSummary>();
  done.catch(() => undefined);
  const stream: DispatchedStream = {
    model,
    attempts: 1,
    done,
    async *[Symbol.asyncIterator]() {
      let outcome: DispatchSummary['outcome'] | undefined;
      try {
        for (const [i, event] of script.events.entries()) {
          if (script.failAfter === i) throw new Error('the provider went away');
          yield event;
        }
        outcome = 'completed';
      } catch (error) {
        outcome = 'interrupted';
        throw error;
      } finally {
        const ended = outcome ?? 'aborted';
        log.push(`round ${n} ${ended}`);
        if (script.doneRejects === true) reject(new Error('usage could not be recorded'));
        else {
          resolve({
            model: model.id,
            attempts: 1,
            outcome: ended,
            costMicroUsd: 1n,
            finishReason: null,
          });
        }
      }
    },
  };
  return { stream, reservation: null, firstAttempt: n };
}

function loop(rounds: Script[], options: { prelude?: ModelStreamEvent[] } = {}) {
  const log: string[] = [];
  const made = rounds.map((script, i) => fakeRound(i + 1, script, log));
  const runner = {
    // No tool call may run, so a later round is reached without a database.
    guard: new ToolLoopGuard({ maxRounds: 0, maxConsecutiveFailures: 3 }),
    offered: [],
  } as unknown as CallRunner;
  const deps: LoopDeps = {
    runner,
    serverTools: true,
    request: { messages: [{ role: 'user', content: 'hi' }] },
    first: made[0] as Round,
    prelude: options.prelude ?? [],
    nextRound: async (_request, firstAttempt) => {
      const next = made[firstAttempt - 1];
      if (next === undefined) throw new Error('no more rounds scripted');
      return next;
    },
    settle: async (round) => {
      log.push(`settle ${round.firstAttempt}`);
    },
    recordReply: async () => undefined,
    translate: (error) => error,
    onEnd: () => log.push('end'),
  };
  const stream = toolLoop(deps);
  void stream.done.then(() => log.push('done'));
  return { stream, log };
}

async function readAll(stream: AsyncIterable<ModelStreamEvent>): Promise<unknown> {
  const events: ModelStreamEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
    return null;
  } catch (error) {
    return error;
  }
}

const settles = (log: string[]) => log.filter((line) => line.startsWith('settle'));

describe('a tool loop settles every round (invariant 4, BG-5, H8)', () => {
  it('H8: a reply that completes settles each round once, before done', async () => {
    const { stream, log } = loop([{ events: callsATool }, { events: answers }]);
    expect(await readAll(stream)).toBeNull();
    await stream.done;
    expect(settles(log)).toEqual(['settle 1', 'settle 2']);
    expect(log.indexOf('settle 2')).toBeLessThan(log.indexOf('done'));
  });

  it('BG-5: a stream that breaks in the only round is settled', async () => {
    const { stream, log } = loop([{ events: answers, failAfter: 1 }]);
    expect(await readAll(stream)).toBeInstanceOf(Error);
    await stream.done;
    expect(settles(log)).toEqual(['settle 1']);
    expect(log.indexOf('settle 1')).toBeLessThan(log.indexOf('done'));
  });

  it('BG-5: a stream that breaks in a later round settles that round too, and each once', async () => {
    const { stream, log } = loop([{ events: callsATool }, { events: answers, failAfter: 1 }]);
    expect(await readAll(stream)).toBeInstanceOf(Error);
    await stream.done;
    expect(settles(log)).toEqual(['settle 1', 'settle 2']);
    expect(log.indexOf('settle 2')).toBeLessThan(log.indexOf('done'));
  });

  it('BG-5: a round whose usage could not be recorded is still settled', async () => {
    const { stream, log } = loop([{ events: answers, doneRejects: true }]);
    await readAll(stream);
    await stream.done;
    expect(settles(log)).toEqual(['settle 1']);
  });

  it('BG-5: a reader that stops in the middle of a round leaves it settled', async () => {
    const { stream, log } = loop([{ events: callsATool }, { events: answers }]);
    for await (const event of stream) {
      if (event.type === 'text' && event.text === 'Here it is.') break;
    }
    await stream.done;
    expect(log).toContain('round 2 aborted');
    expect(settles(log)).toEqual(['settle 1', 'settle 2']);
    expect(log.indexOf('settle 2')).toBeLessThan(log.indexOf('done'));
  });

  it('BG-5: a reader that stops before round one is read closes it, and settles it', async () => {
    const prelude: ModelStreamEvent[] = [
      { type: 'tool-activity', callId: 'c0', name: 'srv__echo', status: 'ok' },
    ];
    const { stream, log } = loop([{ events: answers }], { prelude });
    for await (const event of stream) if (event.type === 'tool-activity') break;
    await stream.done;
    expect(log).toContain('round 1 aborted');
    expect(settles(log)).toEqual(['settle 1']);
    expect(log.indexOf('settle 1')).toBeLessThan(log.indexOf('done'));
  });
});
