import { z } from 'zod';

/*
 * API keys (ID-5). A key is a delegation of the person who issued it, scoped to one workspace.
 * Its secret is returned once, at issue time, and never again (PR-3 applied to our own keys).
 */

export const API_KEY_PATTERN = /^lk_[A-Za-z0-9_-]{43}$/;

export const issueKeyBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const keyParams = z.object({ workspaceId: z.uuid(), keyId: z.uuid() });

export interface KeyView {
  id: string;
  name: string;
  /** The first characters of the secret, enough to tell keys apart. */
  prefix: string;
  workspaceId: string;
  owner: { principalId: string; displayName: string };
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IssuedKey {
  key: KeyView;
  /** Shown once. Only its SHA-256 digest is stored. */
  secret: string;
}
