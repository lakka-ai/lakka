import { createLogger, fileSecretReader, loadProcessConfig } from '@lakka/core';
import { createEgressProxy, EGRESS_PORT } from '../sandbox/egress-proxy.ts';
import { EGRESS_KEY_FILE, EGRESS_KEYS_DIR } from '../sandbox/keys.ts';

/*
 * The egress proxy (NF-S4, ADR 0118), the `egress` service: the sandbox's only way out. It
 * mounts the egress-keys volume and nothing else, and needs no database.
 *
 *   lakka egress
 */

const config = loadProcessConfig(process.env);
const { logger } = createLogger({ level: config.logLevel, service: 'egress' });
const readKey = fileSecretReader(EGRESS_KEYS_DIR);

let key: string | undefined;
try {
  key = readKey(EGRESS_KEY_FILE);
} catch (error) {
  logger.fatal('egress.start_failed', { error_code: 'key_unreadable' }, error);
  process.exit(1);
}
if (key === undefined) {
  // init writes it before this starts; without it every token would be refused.
  logger.fatal('egress.start_failed', { error_code: 'key_missing' });
  process.exit(1);
}

const server = createEgressProxy({
  // Read for every connection, so a key init made anew applies without a restart.
  key: () => {
    try {
      return readKey(EGRESS_KEY_FILE);
    } catch {
      return undefined;
    }
  },
  logger,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info('egress.stopping', { signal });
    server.close();
    // Tunnels end with their tokens; nothing is worth waiting for.
    server.closeAllConnections();
    process.exit(0);
  });
}

server.listen(EGRESS_PORT, '0.0.0.0', () => {
  logger.info('egress.started', { port: EGRESS_PORT, node_version: process.version });
});
