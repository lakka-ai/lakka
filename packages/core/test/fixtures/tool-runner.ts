import { serveToolRunner } from '../../src/tools/runner.ts';

/* The tool runner as the image runs it (apps/api/src/cli/tool-runner.ts), for unit tests. */

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort(new Error('stopped')));
await serveToolRunner(
  process.stdin,
  (reply) => new Promise((resolve) => process.stdout.write(reply, () => resolve())),
  controller.signal,
);
process.exit(0);
