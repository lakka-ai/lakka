import {
  GlideClient,
  GlideClientConfiguration,
  Logger as GlideLogger,
  Script,
} from '@valkey/valkey-glide';
import type { CacheConfig } from './config.ts';

/** A Lua script run atomically inside Valkey. Sent by SHA after the first call. */
export type CacheScript = Script;

export function cacheScript(source: string): CacheScript {
  return new Script(source);
}

export interface CacheClient {
  ping(): Promise<void>;
  /** Runs a script atomically. Valkey executes it single-threaded, so it cannot interleave. */
  runScript(script: CacheScript, keys: string[], args: string[]): Promise<unknown>;
  /** Publishes to a pub/sub channel; resolves to the number of subscribers that received it. */
  publish(channel: string, message: string): Promise<number>;
  /** The server's INFO text and key count, for the diagnostics bundle to pick from (AD-3). */
  serverInfo(): Promise<{ info: string; keys: number }>;
  close(): void;
}

let glideLoggingDisabled = false;

/**
 * Client for Valkey (ADR 0009, 0016). Connects lazily and reconnects on the next call after a
 * failure, so a process can start while Valkey is still booting and report it as down in
 * /healthz rather than crash. Every error propagates to the caller: anything that depends on
 * Valkey fails closed (CLAUDE.md invariant 3).
 */
export function createCacheClient(config: CacheConfig, clientName: string): CacheClient {
  if (!glideLoggingDisabled) {
    // GLIDE's native logger writes straight to the console and would bypass our field
    // allowlist. Errors still reach us as exceptions and are logged through our Logger.
    GlideLogger.setLoggerConfig('off');
    glideLoggingDisabled = true;
  }
  let client: Promise<GlideClient> | undefined;

  const connect = (): Promise<GlideClient> => {
    client ??= GlideClient.createClient({
      addresses: [{ host: config.host, port: config.port }],
      ...(config.password === undefined ? {} : { credentials: { password: config.password } }),
      clientName,
      requestTimeout: 1000,
      advancedConfiguration: { connectionTimeout: 1000 },
    }).catch((error: unknown) => {
      client = undefined;
      throw error;
    });
    return client;
  };

  return {
    async ping() {
      const c = await connect();
      await c.ping();
    },
    async runScript(script, keys, args) {
      const c = await connect();
      return c.invokeScript(script, { keys, args });
    },
    async publish(channel, message) {
      const c = await connect();
      return c.publish(message, channel);
    },
    async serverInfo() {
      const c = await connect();
      return { info: await c.info(), keys: await c.dbsize() };
    },
    close() {
      void client?.then((c) => c.close()).catch(() => undefined);
      client = undefined;
    },
  };
}

export interface CacheSubscription {
  close(): void;
}

/**
 * Subscribes to channels on a dedicated connection (Valkey requires one for pub/sub). Messages
 * are delivered to `onMessage` as strings. Pub/sub is best effort: a message published while
 * this connection is down is lost, so nothing may depend on it for correctness.
 */
export async function subscribe(
  config: CacheConfig,
  clientName: string,
  channels: string[],
  onMessage: (channel: string, message: string) => void,
): Promise<CacheSubscription> {
  const client = await GlideClient.createClient({
    addresses: [{ host: config.host, port: config.port }],
    ...(config.password === undefined ? {} : { credentials: { password: config.password } }),
    clientName,
    pubsubSubscriptions: {
      channelsAndPatterns: {
        [GlideClientConfiguration.PubSubChannelModes.Exact]: new Set(channels),
      },
      callback: (msg) => onMessage(String(msg.channel), String(msg.message)),
    },
  });
  return { close: () => client.close() };
}
