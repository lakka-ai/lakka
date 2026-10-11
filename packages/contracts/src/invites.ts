import { z } from 'zod';
import { newAccount } from './accounts.ts';
import { workspaceRole } from './workspaces.ts';
import type { WorkspaceRole } from './workspaces.ts';

/*
 * Invite links (ID-7, ADR 0035). A workspace admin creates a single-use link that works for a
 * limited time, and shares it however they like; no mail server is needed. The token is
 * returned once and only its SHA-256 digest is stored.
 */

/** 32 random bytes, base64url. Travels in the link's fragment, which browsers never send. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const inviteToken = z.string().regex(INVITE_TOKEN_PATTERN);

export const createInviteBody = z.object({ role: workspaceRole }).strict();
export const inviteParams = z.object({ workspaceId: z.uuid(), inviteId: z.uuid() });
export const inviteTokenBody = z.object({ token: inviteToken }).strict();

/** Accepting as the signed-in person (no `account`), or creating a new local account with it. */
export const acceptInviteBody = z
  .object({ token: inviteToken, account: newAccount.optional() })
  .strict();

export interface InviteView {
  id: string;
  workspaceId: string;
  role: WorkspaceRole;
  createdBy: { principalId: string; displayName: string };
  createdAt: string;
  expiresAt: string;
}

export interface CreatedInvite {
  invite: InviteView;
  /** Shown once. The web app builds the link from it. */
  token: string;
}

/** What someone holding a valid link may learn before accepting. */
export interface InvitePreview {
  workspaceName: string;
  role: WorkspaceRole;
  expiresAt: string;
  /** The person who made the link (ADR 0098). */
  invitedBy: string;
  /** Set when the signed-in person is in the workspace already. */
  alreadyMember: { workspaceId: string; role: WorkspaceRole; joinedAt: string } | null;
}

export interface AcceptedInvite {
  workspaceId: string;
}
