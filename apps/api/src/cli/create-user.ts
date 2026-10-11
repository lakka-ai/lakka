import { parseArgs } from 'node:util';
import { text } from 'node:stream/consumers';
import {
  configureCredentialsFromConfig,
  createAuth,
  createCacheClient,
  createLocalUser,
  createLogger,
  ensureDatabaseReady,
  loadProcessConfig,
} from '@lakka/core';
import { createDb, createPool, setInstanceAdmin } from '@lakka/db';

/*
 * Operator command: create a local account, optionally as an instance admin (ADR 0033). For
 * recovery when no admin can sign in, and for automated tests. First-run setup in the browser
 * is the normal way to create the first admin (AD-1).
 *
 *   echo 'password' | lakka create-user --email ada@example.com --name Ada --instance-admin
 *
 * The password is read from stdin so it never appears in shell history or the process list.
 * Output is the new principal id only.
 */

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    'instance-admin': { type: 'boolean', default: false },
  },
});

if (values.email === undefined || values.name === undefined) {
  process.stderr.write(
    'usage: lakka create-user --email EMAIL --name NAME [--instance-admin] < password\n',
  );
  process.exit(64);
}

const password = (await text(process.stdin)).replace(/\r?\n$/, '');
const config = loadProcessConfig(process.env);
const { logger } = createLogger({ level: config.logLevel, service: 'create-user' });
const pool = createPool(
  { ...config.database, applicationName: 'lakka-create-user', max: 2 },
  () => undefined,
);
const cache = createCacheClient(config.cache, 'lakka-create-user');

let exitCode = 0;
try {
  await ensureDatabaseReady(pool, logger, { mode: 'verify' });
  if (config.credentials.keys.size > 0) await configureCredentialsFromConfig(pool, config);
  const db = createDb(pool);
  const auth = createAuth({ db, cache, logger, config: config.auth });
  const principal = await createLocalUser(
    { auth, db },
    { email: values.email, password, name: values.name },
  );
  if (values['instance-admin']) await setInstanceAdmin(db, principal.id, true);
  process.stdout.write(`${principal.id}\n`);
} catch (error) {
  logger.error('create_user.failed', {}, error);
  exitCode = 1;
} finally {
  cache.close();
  await pool.end();
}
process.exit(exitCode);
