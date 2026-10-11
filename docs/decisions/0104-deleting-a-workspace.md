# 0104. Deleting a workspace

Status: accepted. Built as described, with the changes in Implementation notes.

## Context

- The design draws Delete on each row of Admin, Workspaces (`Admin-Workspaces` and
  `Admin-Workspace-Dialogs` boards). ADR 0102 built the page without it.
- The boards say what a delete does:
  - removed: the workspace's conversations and request traces, its API keys ("stop working at
    once"), its routes, tools and provider keys;
  - kept: its people's accounts and their other workspaces, and its spend, which "stays in the
    instance report";
  - confirmed by typing the workspace's name, in an alertdialog whose Delete workspace button
    uses aria-disabled until the name matches. Afterwards focus goes to the table and a status
    says the workspace was deleted.
- No requirement covers deleting a workspace. NF-P4 is about a principal, and ADR 0082 settled
  that case: a tombstone, so spend and audit records stay whole and no cap moves.
- What points at a workspace today (`packages/db/src/schema/`):
  - with a foreign key to `workspaces`: memberships, api_keys, invites, budgets, alert_webhooks,
    provider_configs, routes (and their examples and centroids), mcp_servers (and their
    credentials and OAuth states), workspace_tools, tool_grants, tool_approvals,
    tool_invocations, conversations, reservations;
  - by id only, without a foreign key: usage and spans (both partitioned by month), messages,
    attachments and span_content (through conversations and requests).
- Budget counters in Valkey are keyed by budget id (`budget:<budgetId>:<periodStart>`) and are
  rebuilt from Postgres (invariant 5). Open requests are ended by the revocation event and by a
  recheck against memberships every 2 seconds (AC 6, `findStillAllowed`).

## Scope

This is new scope. Before it is built:

- **Requirement.** ID-8 in `docs/requirements.md`, added with this record.
- **Roadmap.** Later polish on M1 (workspaces) in `docs/roadmap.md`, built next.

## Decision

### Who and how

- Instance admins only, as for creating a workspace (ID-3). A workspace admin, a member or a
  key gets `forbidden`.
- `DELETE /api/workspaces/:workspaceId` with `{ confirmName }`.
  - The name must match the workspace's current name exactly, after trimming surrounding
    spaces. Names are not unique, so the id in the path picks the workspace and the name guards
    against a wrong id, as `confirmEmail` does for people.
  - A mismatch is refused with `confirmation_mismatch` (400), changing nothing.
  - Answers `204`. A deleted or unknown workspace answers `404`, as any hidden workspace does.
- The core function is `deleteWorkspace(ctx, principal, workspaceId, { confirmName })`, beside
  `createWorkspace`. The api route is a thin adapter (invariant 1).

### Tombstone, not removal

The workspace row stays, with `status = 'deleted'`, `deleted_at` and `deleted_by_principal_id`,
checked together as on principals. Its name is kept: a workspace's name is not personal data,
and the instance report needs a label for its spend. Its slug becomes `deleted-<id>`, so the
old one is free to reuse.

Why not delete the row: usage, reservations, spans and tool invocations point at it, and the
instance cap counts its usage for the current period. Removing that usage would lower recorded
spend and could let the instance spend past its cap (the same reasoning as ADR 0082).

Every lookup treats a deleted workspace as missing:

- `findWorkspace` and the workspace lists skip it, so `authorizeWorkspaceAction` answers `404`
  and the switcher, Workspaces page and `/workspaces` list no longer show it;
- `findStillAllowed` refuses requests in it, so open streams end within 2 seconds even if the
  event is lost.

### Step 1: at once, in one transaction

What must stop immediately, so access ends the moment the admin confirms:

- the workspace becomes a tombstone;
- memberships are deleted. People keep their accounts and their other workspaces;
- its keys are revoked: each key principal becomes a tombstone, "Deleted key", as in ADR 0082,
  so its usage still names a principal;
- invites are deleted, so their links stop working;
- provider keys (`provider_configs` for the workspace) are deleted. They are credentials;
- MCP servers are deleted, which cascades to their credentials, OAuth states and the
  workspace's tools, and through them to tool grants;
- pending tool approvals expire;
- its alert webhook is deleted.

After the commit:

- one revocation event per former member and per key, with a new reason `workspace_deleted`
  and the workspace id, so open chat and API streams end (AC 6). Their partial usage is
  reconciled as on any abort (invariant 4);
- the log gets `workspace.deleted` with the workspace id and `actor_id`. Never its name.

A workspace's last admin rule does not apply: the workspace itself is going.

### Step 2: in the background

Content can be large (conversations with attachments, months of spans), so it is removed by a
pg-boss job, `workspace.purge`, queued in the same transaction as step 1:

- conversations, cascading to messages and attachments;
- span_content and spans for the workspace, the request traces the board names;
- routes, cascading to their examples and centroids;
- tool invocations stay, with `arguments` set to null (see Kept);
- caps (workspace, member and key budgets for it), once no reservation for the workspace is
  still open. This ordering matters: `reservation_lines` cascade from budgets, and a line
  removed under an open request would leave its hold unreleased in Valkey until the orphan
  sweep. Their Valkey counters are deleted with them.

The job works in batches by id and is safe to run twice. If it fails, pg-boss retries it, and
nothing it has not yet removed is reachable, because every lookup already treats the workspace
as missing.

### Kept

- **Usage rows**, so the instance cap and the instance report do not move. The instance report
  lists the workspace by its kept name with "(deleted)", for as long as retention keeps its
  usage (OB-6, NF-P5). Instance spend's By workspace tab shows it the same way.
- **Reservations** that are already settled, as part of the spend record.
- **Tool invocations (TL-6)**, with `arguments` set to null, as ADR 0082 does for a deleted
  person, so the audit of who ran which tool, when and how it ended survives until retention
  removes it.
- **The tombstone row**, for good. Retention could remove it once no usage points at it; that
  is left for later.

### What the page does

As drawn: Delete on each row opens the alertdialog, focus on the confirm field, Delete workspace
aria-disabled until the typed name matches. The dialog's list says how many people keep their
accounts, from the same people list the table uses. On success the dialog closes, focus moves
to the table, and the status line says "Support was deleted." The note above the table gets back
its sentence about deleting.

If the admin was looking at that workspace in another tab, its next request answers `404` and
the app falls back to another workspace, as it already does for one it can no longer see.

### Settled with the project owner

1. **A tombstone, not removal.** Removing the row would mean deleting its usage and lowering
   recorded spend.
2. **The tool audit stays**, with arguments erased (Kept, above). The board's list of what is
   removed does not mention it, and TL-6 asks for it.
3. **Access ends in one transaction; content goes in a background job.** One transaction for
   everything would be simpler, but a large workspace would hold locks for a long time.
4. **The last workspace can be deleted.** Its members then land on the "not in any workspace"
   list, and an instance admin can create another.
5. **No workspace export.** NF-P4 covers exporting a person. The dialog does not offer one.

## Testing

Budget and isolation tests use real Postgres and Valkey (CLAUDE.md).

- `ID-8: only an instance admin deletes a workspace, and only with its exact name`
- `ID-8: a deleted workspace answers 404 everywhere, to its former members and to admins`
- `ID-8: its keys stop working at once, and open chat and API streams end within 5 seconds`
- `ID-8, BG-3: an open request still reconciles its partial usage; the instance cap holds`
- `ID-8: members keep their accounts and their other workspaces`
- `ID-8: the purge removes conversations, attachments, spans and captured content in batches`
- `ID-8: running the purge twice is safe`
- `ID-8: caps are removed only after the workspace's last open reservation settles`
- `ID-8: the instance report keeps its spend, labelled as deleted`
- `ID-8: its slug is free again`
- `ID-8: the last workspace can be deleted, and its members see the empty list`
- `ID-8, TL-6: tool invocations stay with their arguments erased`
- Isolation: deleting workspace A leaves workspace B's rows untouched, checked through the api.
- E2E: delete from Admin, Workspaces, with the button aria-disabled until the name matches,
  focus on the table and the status after, and axe in light and dark.

## Consequences

- An instance admin can remove a team's workspace without corrupting budgets or spend history.
- Backups taken before a delete still hold its content until they are replaced. The admin guide
  says so, as it does for deleting a person.
- Until the purge job finishes, deleted content is still in the database but unreachable.
- Two new pieces of state: the workspace tombstone columns (a forward-only migration) and the
  `workspace.purge` queue.

## Implementation notes

Settled while building it, with the project owner:

- **Keys are revoked, not tombstoned.** Their `revoked_at` is set, as revoking a key does. Their
  owners still exist and a key's name is not personal data, so the instance report keeps naming
  which key spent what. This replaces "each key principal becomes a tombstone" above.
- **No status column.** `deleted_at` marks a deleted workspace, with `deleted_by_principal_id`
  set with it and `purged_at` once the purge finishes (migration 0032), checked together.
- **The purge is a sweep.** pg-boss sends on its own connection, so a job cannot be queued
  inside the delete's transaction. Instead the worker runs `workspace-purge` every minute and
  purges every deleted workspace whose `purged_at` is still empty. A failed run, or a workspace
  deleted during one, is picked up by the next. This replaces "queued in the same transaction".
- **The instance report** still reads every workspace's usage, deleted ones included, and marks
  their rows `deleted`. A person's data export also still walks deleted workspaces, since their
  usage there is still linked to them (NF-P4).
