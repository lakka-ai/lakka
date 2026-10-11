import { z } from 'zod';

/*
 * Request and response shapes for workspaces and memberships (ID-3, ID-4). Shared by the api,
 * which validates with them at the boundary, and the web app, which will call these endpoints.
 */

export const workspaceRole = z.enum(['admin', 'member']);
export type WorkspaceRole = z.infer<typeof workspaceRole>;

export const workspaceSlug = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'lowercase letters, digits and hyphens');
export const workspaceName = z.string().trim().min(1).max(100);

export const newWorkspace = z.object({ name: workspaceName, slug: workspaceSlug }).strict();
/**
 * An instance admin may name someone else as the first admin (Admin-Workspace-Dialogs board).
 * Without one, the caller is its first admin.
 */
export const createWorkspaceBody = newWorkspace
  .extend({ adminPrincipalId: z.uuid().optional() })
  .strict();
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceBody>;
export const updateWorkspaceBody = z.object({ name: workspaceName }).strict();
/** ID-8, ADR 0104: the workspace's current name, typed again, guards against a wrong id. */
export const deleteWorkspaceBody = z.object({ confirmName: z.string().max(200) }).strict();
export type DeleteWorkspaceBody = z.infer<typeof deleteWorkspaceBody>;
export const setMemberBody = z.object({ role: workspaceRole }).strict();

export const workspaceParams = z.object({ workspaceId: z.uuid() });
export const memberParams = z.object({ workspaceId: z.uuid(), principalId: z.uuid() });

export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  /** The caller's role, or null when they see it only as an instance admin. */
  role: WorkspaceRole | null;
  createdAt: string;
}

export interface MemberView {
  principalId: string;
  displayName: string;
  email: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}
