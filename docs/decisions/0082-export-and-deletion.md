# 0082. Exporting and deleting a person

Status: accepted

## Context

- Requirements:
  - NF-P4: an admin can export and delete all data linked to a principal.
  - BG-4 and invariant 5: budgets are enforced from usage in Postgres, and Valkey's counters are rebuilt from it.
  - TL-6: every tool call is audited.
  - Invariant 9: no content or credentials in logs.
- A person spans workspaces, and each of their keys is a principal of its own.
- Deleting a person's usage would lower the spend recorded for the current period. A workspace could then spend past its cap.
- Four questions were settled: a tombstone, instance admins only, a tar.gz archive, and keeping tool audit rows with their arguments dropped.

## Decision

- **Who.** Instance admins only, for anyone but themselves. Keys and members are refused.
  - `GET /api/users/:id/export` returns the archive.
  - `DELETE /api/users/:id` with `{ confirmEmail }` deletes. The email must match the person's, ignoring case and surrounding spaces, so a wrong id cannot delete someone else.
  - The People page offers both. Deleting asks for the email again.
- **Export.** A tar.gz, streamed from Postgres one file at a time. The layout is documented in `packages/core/src/principals/export.ts`.
  - Contents:
    - the profile, memberships, keys, caps on the person or their keys, and the MCP servers they connected;
    - per workspace: conversations with their messages and files, usage, tool calls with arguments, approvals, grants, captured content, and each request's spans.
  - Secrets are never selected: key digests, MCP credentials and sign-in material are out by construction, not redaction.
  - The archive is written by a small ustar writer of our own (`packages/core/src/export/tar.ts`) and Node's zlib. No new dependency.
  - Rows are paged by id, not by timestamp: a JS Date drops the microseconds Postgres keeps, so a page boundary would repeat rows.
- **Deletion.** One transaction.
  - **Deleted:**
    - conversations, which cascade to messages and attachments;
    - captured content for the person's requests;
    - the person's own MCP credentials and OAuth states;
    - memberships;
    - the Better Auth user, with its sessions and accounts, and verification tokens for their address.
  - **Kept, with tool arguments erased:** tool invocations keep who ran what, when and how it ended; `arguments` becomes null (a new migration makes it nullable).
  - **Revoked:** the person's keys, and their active tool grants.
  - **Pending approvals** in their conversations expire.
  - **Kept as a tombstone:** the principal row stays with status `deleted`, name "Deleted person", no email, no sign-in and not an admin, recording when and by whom. Their keys become "Deleted key".
    - Usage, reservations, spans, budgets and the ids on what they set up for a workspace keep pointing at it.
    - Spend reports then show "Deleted person", and no cap moves.
    - A shared MCP credential they set belongs to the workspace and stays.
  - A workspace they alone administer refuses the deletion with `last_workspace_admin`, changing nothing: the same rule as removing a member.
  - Afterwards their open requests end, through the revocation event (AC 6), with a new reason, `deleted`.
  - A deleted person can no longer be suspended, reactivated, exported or listed. Their address is free, so they can join again later as a new person.
- **Audit.** `principal.exported` and `principal.deleted` are logged, with the person's id and the admin's (a new `actor_id` log field). Never names, emails or content.

## Consequences

- An instance can honour a request to delete someone's data without corrupting its budgets or its tool audit.
- Backups taken before a deletion still hold the data until they are replaced. The guide says so.
- Spans keep the tombstone's id in their attributes until retention removes them. Ids are not personal data once the principal has no name or email.
- A large export takes as long as reading the person's history, and holds one file in memory at a time. If the connection breaks, the download ends short and the log says why.
