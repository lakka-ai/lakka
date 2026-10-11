import { spawn } from 'node:child_process';
import { McpFailureError } from '../mcp/client.ts';
import { ToolTimeoutError } from './executor.ts';
import type { ToolExecutor } from './executor.ts';
import {
  callResultFromReply,
  MAX_RUNNER_REPLY_BYTES,
  runnerListRequestFor,
  runnerRequestFor,
  toolsFromReply,
} from './runner.ts';

/*
 * An executor that runs each operation in another process (TL-8, ADR 0073): it starts `command`,
 * which must run a tool runner (`lakka tool-runner`), writes the request to its stdin and
 * reads the reply from its stdout. Anything that starts a runner will do; the out-of-process
 * proof starts one in a locked-down container.
 *
 * The runner's stderr is discarded, as a stdio server's is (invariant 9). A reply that is too
 * large, not JSON, or not a reply is a failure, like a crash; the runner's own words never reach
 * the model or the logs.
 */

/** Time for the runner to start, on top of the operation's own deadline. */
export const RUNNER_START_ALLOWANCE_MS = 15_000;

/** Starts the runner, sends `request`, and resolves with its stdout once it exits. */
function runOnce(
  command: readonly [string, ...string[]],
  request: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const [file, ...args] = command;
  return new Promise<Buffer>((resolve, reject) => {
    const deadline = AbortSignal.timeout(timeoutMs + RUNNER_START_ALLOWANCE_MS);
    const stop = AbortSignal.any([signal, deadline]);
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      stop.removeEventListener('abort', onAbort);
      outcome();
    };
    // Killing the process closes the runner's stdin, which stops a runner in a container too;
    // a container's client does not always pass signals on.
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(() =>
        reject(
          deadline.aborted && !signal.aborted
            ? new ToolTimeoutError('the tool did not finish in time')
            : signal.reason,
        ),
      );
    };
    stop.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish(() => reject(error)));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RUNNER_REPLY_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new McpFailureError('error')));
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', () =>
      finish(() => {
        child.stdin.destroy();
        resolve(Buffer.concat(chunks));
      }),
    );
    // Left open while the operation runs: the runner stops when it ends (runner.ts).
    child.stdin.on('error', () => undefined);
    child.stdin.write(request);
    if (stop.aborted) onAbort();
  });
}

export function commandExecutor(command: readonly [string, ...string[]]): ToolExecutor {
  return {
    async execute(execution, signal) {
      const output = await runOnce(
        command,
        runnerRequestFor(execution),
        execution.timeoutMs,
        signal,
      );
      const result = callResultFromReply(output);
      if (result instanceof Error) throw result;
      return result;
    },
    async list(listing, signal) {
      const output = await runOnce(
        command,
        runnerListRequestFor(listing),
        listing.timeoutMs,
        signal,
      );
      const tools = toolsFromReply(output);
      if (tools instanceof Error) throw tools;
      return tools;
    },
  };
}
