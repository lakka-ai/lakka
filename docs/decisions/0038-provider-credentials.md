# 0038. Model provider credentials

Status: accepted; widened by ADR 0096 (what a workspace admin learns of instance credentials); rotation built by ADR 0115 (rotating the credential master key); ADR 0126 adds five first-party kinds.

## Context

- PR-1: provider credentials are added, tested and removed in the web UI.
- PR-2 and NF-S1: they are encrypted at rest with a key from the environment.
- PR-3: they are never shown back to anyone, admins included.
- PR-4: Anthropic, OpenAI, Google and any OpenAI-compatible endpoint are supported.
- PR-8: a credential is scoped to one workspace or to the whole instance, and workspace credentials take priority.

The M2 plan chose the M1 AES-256-GCM column type (ADR 0032) for storage, a free model-list call for testing (D4), and workspace admins managing their own workspace's credentials (D12). The tech spec's data model sketches envelope encryption with per-record data keys and a `key_version` column.

## Decision

- **Storage.** `provider_configs` has one row per credential. `workspace_id` is null for instance-wide rows. The row's `name` is the provider part of model references (ADR 0037): the kind for first-party providers, or an admin-chosen name for an OpenAI-compatible endpoint. A name is unique per scope.
  - The API key is encrypted with the credential master key, with the column bound as associated data.
  - List and view queries select only whether a key is set. The key is decrypted only to test a credential or to use it for a request.
- **Write-only keys.** No response carries a key, a prefix or a hint of it. Replacing a key or address clears the last test result. Log lines name who created, changed, removed or tested a credential, and the test outcome, never the key.
- **Resolution (PR-8).** A request in a workspace uses that workspace's credential for the model's provider if it has one, and otherwise the instance's. With neither, it is refused with `provider_not_configured`.
- **Who manages what:**
  - Instance admins manage instance-wide credentials.
  - Workspace admins manage their own workspace's, and instance admins can too. Members cannot see them.
  - Keys cannot read or change credentials in any scope, like keys and invites (ADR 0030, ADR 0035).
  - Another workspace's credentials answer 404 (AC 16).
- **Workspace credentials are first-party at the standard address only.** A workspace admin who could choose a base URL or add an OpenAI-compatible endpoint could make the server connect to addresses inside the customer's network. So custom addresses and OpenAI-compatible endpoints are instance-wide and set by instance admins, whom we already trust with such addresses (ADR 0032). A Postgres check enforces this as well as core.
- **Testing a credential** lists the provider's models, which is free on every provider we support.
  - Only the HTTP status is used; the body is discarded unread.
  - Redirects are not followed, so a key is only ever sent to the configured address.
  - The outcome is recorded as one of connected, key refused, could not connect, or error with the HTTP status.
  - Tests are not throttled separately. They need admin rights, and a free list call spends nothing.
- **Master-key rotation is deferred to M7.** The stored format keeps its `v1:` prefix, so a second key version can be added without migrating existing rows. The spec's per-record data keys are not adopted: with the master key in the environment, wrapping per-record keys under it adds no protection, only another layer to get wrong.

## Consequences

- An operator can give each workspace its own provider account, and that account's bill, while budgets still price requests from the catalogue.
- A workspace that wants a self-hosted model asks an instance admin to add the endpoint.
- Rotating the master key is not possible yet. The M7 plan must include it: accept an old key alongside the new one, re-encrypt, then drop the old key.
