/*
 * Limits on a request's tool loop (TL-9, H6, ADR 0070): how many rounds of tool calls one request
 * may make, how many times in a row a tool may fail before it is put aside for the rest of the
 * request, and no identical call twice, which means the model is stuck rather than progressing.
 */

export const MAX_TOOL_ROUNDS = 8;
export const MAX_CONSECUTIVE_FAILURES = 3;

/** The same arguments however their keys are ordered. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export type GuardRefusal = { reason: 'repeated' | 'set_aside'; message: string };

export class ToolLoopGuard {
  private rounds = 0;
  private readonly seen = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly setAside = new Set<string>();

  private readonly limits: { maxRounds: number; maxConsecutiveFailures: number };

  constructor(
    limits = { maxRounds: MAX_TOOL_ROUNDS, maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES },
  ) {
    this.limits = limits;
  }

  /** Starts another round of tool calls; false when the request has used all it may. */
  startRound(): boolean {
    if (this.rounds >= this.limits.maxRounds) return false;
    this.rounds += 1;
    return true;
  }

  get roundsUsed(): number {
    return this.rounds;
  }

  /** Whether a call may go ahead; a refusal says why, for the model. */
  check(name: string, args: unknown): GuardRefusal | null {
    if (this.setAside.has(name)) {
      return {
        reason: 'set_aside',
        message: `The tool ${name} is not available for the rest of this request.`,
      };
    }
    const key = `${name}:${canonical(args)}`;
    if (this.seen.has(key)) {
      return {
        reason: 'repeated',
        message: `You already called ${name} with these arguments in this request. Use that result.`,
      };
    }
    this.seen.add(key);
    return null;
  }

  /**
   * Records how a call went. A terminal failure puts the tool aside at once; so do a few
   * failures in a row. A success clears the count.
   */
  record(name: string, outcome: 'ok' | 'failed' | 'terminal'): void {
    if (outcome === 'ok') {
      this.failures.delete(name);
      return;
    }
    const count = (this.failures.get(name) ?? 0) + 1;
    this.failures.set(name, count);
    if (outcome === 'terminal' || count >= this.limits.maxConsecutiveFailures) {
      this.setAside.add(name);
    }
  }

  isSetAside(name: string): boolean {
    return this.setAside.has(name);
  }
}
