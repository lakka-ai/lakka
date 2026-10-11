# 0029. Workspace authorization

Status: accepted

## Context

ID-3 defines three roles (instance admin, workspace admin, member) and ID-4 lets one person hold a different role in each workspace. The docs do not say what each role may do, how an outsider is answered, whether the last admin can leave, or who adds people to a workspace. Acceptance criterion 16 requires isolation between workspaces, checked by calling the API directly.

## Decision

- **One pure policy function** in core (`authz/policy.ts`) decides `allow`, `deny` or `hidden` from the principal, the action and the acting user's role. Surfaces never decide permissions. The core workspace service authorizes first, then calls workspace-scoped queries in db.
- **The role that applies is the acting user's**: a key's owner, or the user itself (NF-S2). Only users can be instance admins; the policy ignores the flag on anything else, and the schema forbids it anyway (ADR 0027).
- **Permissions:**

  | Action                             | Member          | Workspace admin | Instance admin              |
  | ---------------------------------- | --------------- | --------------- | --------------------------- |
  | Read the workspace and its members | yes             | yes             | yes                         |
  | Rename it                          | no              | yes             | yes                         |
  | Change a member's role             | no              | yes             | yes                         |
  | Remove a member                    | only themselves | yes             | yes                         |
  | Add an existing user directly      | no              | no              | yes                         |
  | Create a workspace                 | no              | no              | yes (and becomes its admin) |

- **Outsiders get 404, not 403.** A principal with no membership receives exactly the response a nonexistent workspace gives, so ids from other workspaces reveal nothing (AC 16). Members acting beyond their role get 403.
- **Workspace admins cannot add arbitrary users by id.** They bring people in through invites. Otherwise an admin of one workspace could pull any user of the instance into theirs by guessing or learning an id. Instance admins can add existing users directly.
- **Every workspace keeps at least one admin.** Demoting or removing the last admin fails with `last_workspace_admin` (409). The check runs in a transaction that locks the workspace row, so two admins demoting each other at the same moment cannot both succeed.
- **Instance admins list every workspace**, with their own role where they have one. Whether an instance admin may read a workspace's content (conversations, traces) is left open until that content exists (M5, M7). In M1 there is no content to read.
- **The workspace always comes from the URL path.** Request bodies are validated with strict schemas, so an extra `workspaceId` field is rejected, not ignored.

## Consequences

- Isolation holds by structure: the only way to workspace data is a core function that authorizes, then a db helper that takes the workspace id.
- The isolation suite checks every endpoint against an outsider and against an admin of a different workspace. It was confirmed to fail when the policy is deliberately broken to allow non-members.
- Keys go through the same policy. A key is also held to its own workspace, on top of its owner's role.
- Workspace admins add people only through invites (ADR 0035).
