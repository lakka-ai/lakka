import { describe, expect, it } from 'vitest';
import { MAX_TOOL_ROUNDS, ToolLoopGuard } from '../src/tools/guard.ts';

/* Limits on a request's tool loop (TL-9, H6, ADR 0070). */

describe('the tool loop guard', () => {
  it('TL-9: allows a fixed number of rounds per request', () => {
    const guard = new ToolLoopGuard();
    for (let i = 0; i < MAX_TOOL_ROUNDS; i += 1) expect(guard.startRound()).toBe(true);
    expect(guard.startRound()).toBe(false);
    expect(guard.roundsUsed).toBe(MAX_TOOL_ROUNDS);
  });

  it('H6: refuses an identical call, however its keys are ordered', () => {
    const guard = new ToolLoopGuard();
    expect(guard.check('s__search', { q: 'x', page: 1 })).toBeNull();
    expect(guard.check('s__search', { page: 1, q: 'x' })).toMatchObject({ reason: 'repeated' });
    expect(guard.check('s__search', { q: 'y', page: 1 })).toBeNull();
  });

  it('H6: puts a tool aside after three failures in a row, or one terminal failure; a success resets the count', () => {
    const guard = new ToolLoopGuard();
    guard.record('a', 'failed');
    guard.record('a', 'failed');
    guard.record('a', 'ok');
    guard.record('a', 'failed');
    guard.record('a', 'failed');
    expect(guard.isSetAside('a')).toBe(false);
    guard.record('a', 'failed');
    expect(guard.isSetAside('a')).toBe(true);
    expect(guard.check('a', { n: 1 })).toMatchObject({ reason: 'set_aside' });

    guard.record('b', 'terminal');
    expect(guard.isSetAside('b')).toBe(true);
  });
});
