import { fileURLToPath } from 'node:url';
import { serve } from 'srvx/node';
import { staticMiddleware } from 'srvx/static';

/*
 * Production server for the built TanStack Start app (ADR 0015). Serves the client assets from
 * dist/client and hands everything else to the SSR handler. Caddy sits in front of it.
 */

interface ServerEntry {
  fetch(request: Request): Response | Promise<Response>;
}

function isServerEntry(value: unknown): value is { default: ServerEntry } {
  if (value === null || typeof value !== 'object' || !('default' in value)) return false;
  const entry: unknown = value.default;
  return (
    entry !== null &&
    typeof entry === 'object' &&
    'fetch' in entry &&
    typeof entry.fetch === 'function'
  );
}

function portFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('web: LAKKA_WEB_PORT must be an integer between 1 and 65535\n');
    process.exit(1);
  }
  return port;
}

const port = portFromEnv(process.env['LAKKA_WEB_PORT'], 3000);
const hostname = process.env['LAKKA_WEB_HOST'] || '0.0.0.0';

// The path is built at runtime so typecheck does not need a prior build.
const entryUrl = new URL('./dist/server/server.js', import.meta.url).href;
const entry: unknown = await import(entryUrl);
if (!isServerEntry(entry)) {
  process.stderr.write('web: dist/server/server.js does not export a fetch handler\n');
  process.exit(1);
}

const server = serve({
  port,
  hostname,
  silent: true,
  middleware: [staticMiddleware({ dir: fileURLToPath(new URL('./dist/client', import.meta.url)) })],
  fetch: (request) => entry.default.fetch(request),
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.close(true).finally(() => process.exit(0));
  });
}

process.stdout.write(
  `${JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'web', msg: 'web.started', host: hostname, port })}\n`,
);
