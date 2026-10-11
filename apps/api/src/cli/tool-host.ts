import { chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger, fileSecretReader, loadProcessConfig } from '@lakka/core';
import { SANDBOX_KEYS_DIR, TOOL_HOST_TOKEN_FILE } from '../sandbox/keys.ts';
import { SlotPool } from '../sandbox/slots.ts';
import { createToolHost } from '../sandbox/tool-host.ts';

/*
 * The tool host (NF-S4, ADR 0118), the `sandbox` service: runs stdio MCP servers for the api,
 * one runner per operation, each in a slot of its own. It mounts the sandbox-keys volume for
 * the api's token, and the tool-host volume for the socket the api connects to; no secrets, no
 * database, and a network whose only way out is the egress proxy.
 *
 *   lakka tool-host
 */

const config = loadProcessConfig(process.env);
const { logger } = createLogger({ level: config.logLevel, service: 'sandbox' });
const address = config.sandbox.toolHost;
if (address.kind === 'in-process') {
  logger.fatal('sandbox.start_failed', { error_code: 'config_invalid' });
  process.exit(1);
}

const readToken = fileSecretReader(SANDBOX_KEYS_DIR);
const token = () => {
  try {
    return readToken(TOOL_HOST_TOKEN_FILE);
  } catch {
    return undefined;
  }
};
if (token() === undefined) {
  // init writes it before this starts; without it the api could never be let in.
  logger.fatal('sandbox.start_failed', { error_code: 'token_missing' });
  process.exit(1);
}

// Only root, with SETUID and SETGID, can give each slot a uid of its own. Below root, in
// development, slots share this process's uid and have no limits: no isolation at all.
const switchUser = process.getuid?.() === 0;
if (!switchUser) logger.warn('sandbox.no_isolation', { status: 'not_root' });

const slots = new SlotPool({
  count: config.sandbox.slots,
  root: '/tmp',
  switchUser,
  logger,
  // Every slot kept something it should not have: a fresh container starts clean.
  onExhausted: () => {
    logger.fatal('sandbox.exhausted', { count: 0 });
    process.exit(1);
  },
});
try {
  await slots.prepare();
} catch (error) {
  // Typically a user namespace with too few uids for the slots (rootless Docker, userns-remap).
  logger.fatal('sandbox.start_failed', { error_code: 'uid_switch_failed' }, error);
  process.exit(1);
}

const host = createToolHost({
  token,
  slots,
  runner: [process.execPath, fileURLToPath(new URL('./tool-runner.ts', import.meta.url))],
  logger,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info('sandbox.stopping', { signal });
    host.server.close();
    host.server.closeAllConnections();
    void host.stop().finally(() => process.exit(0));
  });
}

const started = () =>
  logger.info('sandbox.started', {
    count: config.sandbox.slots,
    status: switchUser ? 'isolated' : 'not_isolated',
    node_version: process.version,
  });
if (address.kind === 'unix') {
  // A socket left by an earlier start would stop this one from listening.
  rmSync(address.path, { force: true });
  host.server.listen(address.path, () => {
    // The directory, root:node 0750, is what keeps slots out; the api's uid needs to write.
    chmodSync(address.path, 0o666);
    started();
  });
} else {
  host.server.listen(Number(new URL(address.url).port), '0.0.0.0', started);
}
