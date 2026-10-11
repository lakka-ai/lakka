import { fileSecretReader } from '@lakka/core';

/*
 * Where the sandbox's two keys live (ADR 0118). init writes each into a volume of its own, owned
 * root:node with mode 0440, so a slot's uid in the sandbox can read neither:
 *
 *   sandbox-keys  tool_host_token   the api's bearer token for the tool host; api and sandbox
 *   egress-keys   egress_token_key  signs and checks egress tokens; api and egress
 *
 * Neither is backed up: init makes new ones when they are missing, and nothing is encrypted with
 * them.
 */

export const SANDBOX_KEYS_DIR = '/run/lakka/sandbox';
export const TOOL_HOST_TOKEN_FILE = 'tool_host_token';
export const EGRESS_KEYS_DIR = '/run/lakka/egress';
export const EGRESS_KEY_FILE = 'egress_token_key';

/** A key file, read each time: init may make it anew, and a missing one is not fatal. */
function keyFile(dir: string, name: string): () => string | undefined {
  const read = fileSecretReader(dir);
  return () => {
    try {
      return read(name);
    } catch {
      return undefined;
    }
  };
}

/** The api's readers for both keys. */
export const sandboxKeys = {
  toolHostToken: keyFile(SANDBOX_KEYS_DIR, TOOL_HOST_TOKEN_FILE),
  egressKey: keyFile(EGRESS_KEYS_DIR, EGRESS_KEY_FILE),
};
