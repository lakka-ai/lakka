import type { Principal, WorkspaceRole } from '@lakka/contracts';

/*
 * Who may do what inside a workspace (ID-3, ADR 0029). A pure function, so the whole table is
 * unit-tested without a database.
 *
 * - Instance admins may manage every workspace. Only users can be instance admins; the schema
 *   forbids the flag on keys.
 * - Otherwise the role that applies is the one held by the acting user: a key's owner, or the
 *   user itself (NF-S2). A key never gets a role its owner does not have.
 * - Someone who is not a member is told the workspace does not exist ('hidden', so 404), which
 *   keeps other workspaces from leaking (AC 16).
 * - A key acts only in its own workspace (workspaceScope), and never manages keys or invites: a
 *   leaked key must not be able to mint more credentials, let people in, or cancel the owner's
 *   other keys (ADR 0030, ADR 0035).
 * - Workspace admins bring people in with invites; only instance admins add users by id.
 * - Sending requests to models (models.use) takes membership, for keys and instance admins too:
 *   spend is attributed to a member of the workspace, and an instance admin's power to manage a
 *   workspace does not extend to spending its budget (ADR 0047).
 * - Workspace admins manage member and key budgets; the workspace's own cap is set by instance
 *   admins, so no workspace can raise its own ceiling (ADR 0049).
 * - Workspace admins manage the workspace's MCP servers and tools; a stdio server, which runs a
 *   command on the host, also takes an instance admin, checked where servers are managed
 *   (ADR 0066 Q2). Keys manage none of it.
 */

export type WorkspaceAction =
  | 'workspace.read'
  | 'workspace.update'
  | 'members.read'
  | 'members.add'
  | 'members.change_role'
  | 'members.remove'
  | 'keys.issue'
  | 'keys.list'
  | 'keys.revoke'
  | 'invites.create'
  | 'invites.list'
  | 'invites.revoke'
  | 'providers.read'
  | 'providers.manage'
  | 'policy.read'
  | 'policy.manage'
  | 'models.use'
  | 'budgets.read'
  | 'budgets.manage'
  | 'tools.read'
  | 'tools.manage'
  | 'capture.manage';

export type Decision = 'allow' | 'deny' | 'hidden';

export interface DecisionInput {
  principal: Principal;
  action: WorkspaceAction;
  /** The acting user's role in the workspace, or null if not a member. */
  role: WorkspaceRole | null;
  /** The workspace the action targets. */
  workspaceId: string;
  /** For member and key actions: whose membership or key is affected. */
  targetPrincipalId?: string;
}

const ADMIN_ACTIONS: ReadonlySet<WorkspaceAction> = new Set([
  'workspace.read',
  'workspace.update',
  'members.read',
  'members.change_role',
  'members.remove',
  'keys.issue',
  'keys.list',
  'keys.revoke',
  'invites.create',
  'invites.list',
  'invites.revoke',
  'providers.read',
  'providers.manage',
  'policy.read',
  'policy.manage',
  'models.use',
  'budgets.read',
  'budgets.manage',
  'tools.read',
  'tools.manage',
  'capture.manage',
]);

const MEMBER_ACTIONS: ReadonlySet<WorkspaceAction> = new Set([
  'workspace.read',
  'members.read',
  'keys.issue',
  'keys.list',
  'models.use',
  // A member reads their own budgets; the service filters out everyone else's (ADR 0049).
  'budgets.read',
]);

// Actions that hand out or withdraw access, or touch provider credentials, routing policy or
// budgets. A leaked key must not be able to use them.
const KEY_ACTIONS: ReadonlySet<WorkspaceAction> = new Set([
  'keys.issue',
  'keys.list',
  'keys.revoke',
  'invites.create',
  'invites.list',
  'invites.revoke',
  'providers.read',
  'providers.manage',
  'policy.read',
  'policy.manage',
  'budgets.read',
  'budgets.manage',
  'tools.read',
  'tools.manage',
  // Recording what people say is a person's decision, never a key's (NF-P3).
  'capture.manage',
]);

export function decide(input: DecisionInput): Decision {
  const { principal, action, role, workspaceId, targetPrincipalId } = input;
  if (principal.kind === 'key') {
    if (principal.workspaceScope !== workspaceId || role === null) return 'hidden';
    if (KEY_ACTIONS.has(action)) return 'deny';
  } else if (principal.isInstanceAdmin) {
    // A key only works while its owner is a member, so issuing one requires membership; so does
    // spending the workspace's money.
    if ((action === 'keys.issue' || action === 'models.use') && role === null) return 'deny';
    return 'allow';
  }
  if (role === null) return 'hidden';
  if (role === 'admin' && ADMIN_ACTIONS.has(action)) return 'allow';
  if (MEMBER_ACTIONS.has(action)) return 'allow';
  // Anyone may leave, or revoke their own keys; removing the last admin is refused in db.
  if (
    (action === 'members.remove' || action === 'keys.revoke') &&
    targetPrincipalId === principal.actingUserId
  ) {
    return 'allow';
  }
  return 'deny';
}

/** Only instance admins create workspaces (ID-3). */
export function mayCreateWorkspace(principal: Principal): boolean {
  return principal.isInstanceAdmin && principal.kind === 'user';
}
