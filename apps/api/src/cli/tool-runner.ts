import { writeFileSync } from 'node:fs';
import { serveToolRunner } from '@lakka/core/runner';

/*
 * The tool runner (TL-8, ADR 0073, ADR 0118): reads one operation from stdin, a tool call or a
 * listing, runs it in this process, and writes one reply to stdout. It stops the operation if
 * stdin ends first. The sandbox's tool host starts one for every operation, under a uid of its
 * own and with limits; the out-of-process proof runs one in a container with no network. Nothing
 * is logged: the operation holds tool arguments and perhaps a credential (invariant 9).
 *
 *   lakka tool-runner < request.json
 */

// When the sandbox runs short of memory, the kernel kills a runner and its server, never the
// tool host that cleans up after them. Raising one's own score needs no privilege; where /proc
// is not writable, the default applies.
try {
  writeFileSync('/proc/self/oom_score_adj', '1000');
} catch {
  // Not Linux, or not allowed: nothing to do.
}

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort(new Error('the runner was stopped')));
}

await serveToolRunner(
  process.stdin,
  (reply) => new Promise((resolve) => process.stdout.write(reply, () => resolve())),
  controller.signal,
);
process.exit(0);
