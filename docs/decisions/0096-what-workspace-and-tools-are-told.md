# 0096. What the Workspace, Tools and Your connections screens are told

Status: accepted. Widens ADR 0038 on what a workspace admin learns of instance credentials, and ADR 0067 on server names.

## Context

The Workspace, Workspace-Member, Tools, Tools-Add and Connections boards (`docs/design/`) draw more than the api sent:

- **Model providers:** "Anthropic, Uses the instance key" in the workspace's list. Workspace admins could not read anything about instance credentials.
- **Tool servers:** names like "GitHub". Names are slugs, because the model calls tools `<name>__<tool>` (H1).
- **Syncs:** "Synced: Sep 27, 16:20" per server. Only each tool kept a sync time, and a failed sync was not recorded.
- **Your connections:** a shared server ("Uses one shared account set by your admin"), and tools marked "Connect Jira first". The page listed OAuth servers only, and tools it could not use were left out.
- **Connected as:** "Connected as erik-holm". The OAuth flow does not learn an account name, and servers say it in different ways, or not at all.

## Decision

- **Provider coverage** (chosen by the project owner): `GET /workspaces/:id/providers/coverage` says, for each first-party provider, whether the workspace's key, the instance's or none is used. It says nothing else of the instance key. Workspace admins and instance admins may read it, members may not.
- **Display names for servers** (the project owner's choice): an optional `display_name` (migration 0027), set on add and edit and cleared with null. Without one, a name is made from the slug ("jira-cloud" becomes "Jira cloud"). The slug stays what the model sees. Tool, available-tool and approval views carry the server's display name.
- **Sync record**: each server keeps `last_synced_at`, and `last_sync_error` as our own code (for example `not_connected`, `no_credential`, `unreachable`), written on success and on failure.
- **Your connections lists every server**:
  - how each signs in;
  - for a shared server, whether its credential is set;
  - for an OAuth server, whether the caller has connected.
  - It gives no address or command, since members read it.
- **Available tools lists every enabled tool**, with `blockedBy` (`not_connected` or `no_credential`) when the caller cannot use it yet, and whether the caller always allows it. Stage 6 of the pipeline still offers a model only the usable ones. Approvals name the tool's own name.
- **No account name** on a connection (the project owner's choice). A connection says it is connected and when it expires.
- **On the screens**, where the boards do not settle it:
  - Workspace addresses stay under `/workspaces/$id`.
  - Keys show the stored prefix, and invites have no token label.
  - The member list previews six people and Show all opens the rest in place.
  - Remove, Revoke, Withdraw, removing a workspace provider key and removing a tool server each get a plain confirm.
  - The shared-account agreement only enables Add; it is not stored.
  - With recording off, "Keep recorded text for" is read-only rather than disabled, as open-questions.md recommends keeping its value. It says to turn recording on to change it, and keeps its contrast.
  - A member can leave the workspace from their own row, after a confirm.
  - A command-line server offers only no sign-in or a shared credential, with the environment variable it reads it from, as the api requires.
  - The Tools page says that a shared credential lets anyone who may use the tool act as that account. The claim that a tool never does more than the person may do holds for per-person sign-in.

## Consequences

- A workspace admin learns which first-party providers the instance has a key for. Before, they did not.
- Renaming a server's display name does not change its tools' names for the model. Renaming its slug still does.
