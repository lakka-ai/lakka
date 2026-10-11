import { readFileSync } from 'node:fs';

/** What the compatibility suite's setup leaves for the checks (test/compat/global-setup.ts). */
export interface CompatState {
  /** The stack as a customer reaches it, through Caddy. */
  baseUrl: string;
  /** The OpenAI-compatible base URL clients are configured with. */
  apiBase: string;
  /** A key in a workspace with the fake provider's models and a code route. */
  key: string;
  /** A key in a workspace whose cap refuses every request. */
  poorKey: string;
  /** The main workspace, for changing its cap mid-test. */
  workspaceId: string;
  /** The instance admin's session, for those changes. Test state only, never committed. */
  adminCookie: string;
  route: string;
  models: {
    ok: string;
    slow: string;
    idle: string;
    drop: string;
    vision: string;
    coder: string;
  };
}

export const STATE_FILE = 'test/compat/.state.json';

export function readState(): CompatState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CompatState;
}
