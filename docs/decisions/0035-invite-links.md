# 0035. Invite links

Status: accepted; widened by ADR 0098 (invite links).

## Context

ID-7 asks for inviting a colleague by a link that can be copied, with no outgoing mail server. ADR 0029 left workspace admins without a way to add people, because adding existing users by id would let an admin of one workspace pull in anyone on the instance. The M1 exit criteria include inviting a member.

## Decision

- **An invite is a single-use link into one workspace with one role**, created by a workspace admin (or an instance admin). It works for 7 days and can be withdrawn. It is not bound to an email address: the admin shares it with the person it is for, over a channel they already trust, and the page says so.
- **The token** is 32 random bytes, base64url, returned once. Only its SHA-256 digest is stored, as for API keys (ADR 0030).
- **The link carries the token in its fragment** (`/invite#token`). Browsers never send fragments to servers, so the token cannot reach Caddy, the web server or a Referer header. The invite page reads it, removes it from the address bar, and keeps it in session storage for that tab, so it survives a detour through sign-in.
- **Previewing and accepting are public, with the token in the POST body.** Both are throttled to 20 per client address per minute. An unknown, used, withdrawn or expired token gets the same `invite_invalid` answer.
- **Accepting works in two ways:**
  - The signed-in person joins as themselves. This covers OIDC users and people already in other workspaces. A key cannot accept an invite, so a leaked key cannot add its owner to other workspaces.
  - Someone new creates a local account with the invite. The response signs them in, as setup does (ADR 0034).
- **An invite is a delegation of its creator** (invariant 2). It works only while the creator is active and still an admin of the workspace, or an instance admin. Demoting or suspending the creator stops their open invites. Restoring them brings those invites back if they have not expired.
- **Acceptance is atomic.** One transaction locks the invite row, rechecks it, creates the principal for a new account, adds the membership and marks the invite used. Two people racing for one link cannot both join.
  - A new Better Auth account is created only after a first check, and deleted if the transaction fails.
  - Someone who is already a member gets `already_member`, and the link stays usable.
- **Keys cannot create, list or withdraw invites**, like key management (ADR 0030).
- Creator, acceptor and workspace are foreign keys. Creator and acceptor must be users, enforced with the composite key pattern of ADR 0027.

## Consequences

- Workspace admins can bring people in without a mail server, and without a way to reach users of other workspaces.
- Anyone holding a link can use it once, which is the trade-off ID-7 accepts in exchange for not needing mail. The 7-day lifetime, single use and withdrawal limit the damage.
- An OIDC provider that does not allow new accounts still decides whether someone can sign in the first time. An invite does not create OIDC accounts.
- The lifetime is fixed for now. Making it a workspace setting later needs no schema change.
