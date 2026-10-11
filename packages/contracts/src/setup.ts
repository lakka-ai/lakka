import { z } from 'zod';
import { newAccount } from './accounts.ts';
import { newWorkspace } from './workspaces.ts';
import type { WorkspaceView } from './workspaces.ts';

/*
 * First-run setup (AD-1, ADR 0034). Whoever holds the setup code, which only someone with
 * access to the server can read, creates the first instance admin and workspace. Until then
 * the code also unlocks the credential master key, shown once so the operator can save it
 * (ADR 0021).
 */

export const setupCode = z.string().trim().min(1).max(200);

export const setupCodeBody = z.object({ code: setupCode }).strict();

export const completeSetupBody = z
  .object({ code: setupCode, admin: newAccount, workspace: newWorkspace })
  .strict();

export type CompleteSetupInput = z.infer<typeof completeSetupBody>;

export interface SetupStatus {
  /** True until first-run setup has been completed. */
  required: boolean;
}

export interface SetupSecrets {
  /** The key that encrypts stored credentials. Losing it loses every stored credential. */
  credentialMasterKey: string;
}

export interface SetupResult {
  workspace: WorkspaceView;
}
