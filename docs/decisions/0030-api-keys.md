# 0030. API keys as delegations

Status: accepted

## Context

ID-5 says a member issues API keys scoped to one workspace that inherit the member's permissions and budget. The tech spec says a key is a principal in its own right for audit, but gets its permissions through `owner_principal_id`, so a key can never exceed its owner. ID-6 requires revocation within seconds. The schema from ADR 0027 already enforces the ownership rules. This record covers the secret format, the lifecycle, and what a key may do.

## Decision

- **Secret:** `lk_` followed by 32 random bytes in base64url (46 characters). Only the SHA-256 hex digest and an 11-character display prefix are stored. The secret is in the issue response alone, which is marked `Cache-Control: no-store`. A slow password hash is unnecessary at 256 bits of entropy, and the digest doubles as the lookup key.
- **Issuing:** any member (workspace admin or member) issues keys for themselves in a workspace they belong to. An instance admin must be a member to issue one, because a key only works while its owner is a member. Issuing creates the key's principal and its `api_keys` row in one transaction.
- **A key acts only in its own workspace** (`Principal.workspaceScope`), even if its owner belongs to others. Anything else answers 404, exactly as for an outsider (AC 16).
- **A key has exactly its owner's current role** in that workspace (NF-S2). The role is read at request time, never copied onto the key, so demoting the owner demotes the key on its next request.
- **A key works only while** it is not revoked, it and its owner are active, and its owner is still a member of the key's workspace. All of this is checked in one query per request with nothing cached, so each change applies to the next request (ID-6). Every refusal reads the same (`invalid API key`), so probing reveals nothing.
- **Keys cannot manage keys.** They cannot issue, list or revoke keys, even for an admin owner, so a leaked key cannot mint more credentials or cancel its owner's other keys.
- **Revoking** sets `revoked_at` and keeps the row for audit. The key's owner, a workspace admin or an instance admin may revoke. Admins see every key in their workspace; members see their own.
- **Transport:** `Authorization: Bearer <secret>`. If an Authorization header is present it alone decides: a bad key is refused and never falls back to the session cookie. Bearer requests skip the origin check because they carry no ambient credential (ADR 0006).
- **Last use** is recorded at most once a minute per key, so authentication does not write on every request.

## Consequences

- A leaked key is bounded by its owner's current role in one workspace, and can be killed by revoking it, suspending the owner, or removing the owner from the workspace.
- Budget inheritance (the other half of ID-5) arrives with the budget engine in M4. The key's principal id already exists for per-key budgets and audit.
- The OpenAI-compatible surface (M5) authenticates with the same bearer path; no new key logic is needed there.
- Keys never expire on their own in v1. Expiry is a small addition if customers ask for it.
