# 0069. Tool allowlists and approval marking

Status: accepted

## Context

- TL-3: an admin chooses which tools are available in which workspace. TL-4: a tool can be marked as needing approval.
- The tech spec's pipeline resolves tools at stage 6, as the allowlist intersected with the principal's permissions, from a policy snapshot that does not change during a request (stage 4).
- ADR 0066 settled tool names (H1) and approval defaults (H2).
- MCP servers describe their tools at runtime, and can change those descriptions at any time. A description is text the model reads: a server that changed a trusted tool's description after an admin approved it could steer the model (a "rug pull").

## Decision

- **Syncing is what makes a tool known.** An admin syncs a server (`POST .../mcp-servers/:id/tools/sync`), and Lakka stores what the server said then in `workspace_tools`: name, title, description, input schema and annotations.
  - The model is offered these stored definitions, never the server's live list.
  - A server that changes a tool changes nothing Lakka offers until an admin syncs again.
  - The sync connects with the admin's own credential: the shared one, or the admin's own OAuth connection.
- **A sync keeps the admin's decisions:**
  - new tools are added off the allowlist, asking first unless the server marks them read-only (H2);
  - known tools take the new definition and keep whether they are enabled and whether they ask;
  - tools the server no longer lists are removed.
- **Limits on what a server can put in the prompt:**
  - descriptions are cut to 4,000 characters, and titles to 200;
  - a tool whose input schema is not an object, or is over 64 KB, is stored as unusable and cannot be enabled.
- **The name the model sees** is `<server>__<tool>` (H1), computed rather than stored, so renaming a server renames its tools with it.
  - Server names have no underscores, so no two tools share a name.
  - A name that would not fit `[a-zA-Z0-9_-]{1,64}` makes the tool unusable. It is listed so the admin can see why, but it cannot be enabled, and it is never offered.
- **The allowlist is part of the policy snapshot.** Enabled tools are read in the same consistent transaction as routes and budgets. The workspace's policy version moves on with every sync, allowlist change, server rename or server deletion, so a request never sees half of a change.
- **Stage 6, the tools a request may offer:**
  - the snapshot's enabled tools;
  - less those on servers the acting person cannot use now: a shared-credential server without its credential, or an OAuth server the person has not connected to.
  - A key sees its owner's (invariant 2).
  - `resolveTools` is what the pipeline calls (ADR 0071). `GET .../tools/available` shows the same list to a member.
- **Who decides:**
  - Workspace admins sync and decide (`tools.manage`) and see the full list with every definition (`tools.read`).
  - Members see only what they can use.
  - Keys manage nothing.

## Consequences

- An admin approves exact tool definitions, and a server cannot change what the model reads behind the admin's back. The cost is that a server's genuine updates wait for someone to sync.
- A tool's description can still be written to mislead, and approving it is the admin's call. Structural defences are elsewhere (ADR 0070, ADR 0071): delimited results, authorization as the end user, and approvals for anything consequential.
