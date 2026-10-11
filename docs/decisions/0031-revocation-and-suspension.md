# 0031. Revocation and suspension

Status: accepted

## Context

ID-6 requires that an admin can revoke a key or suspend a principal "with effect within seconds". Acceptance criterion 6 says revoking a member's access ends their chat sessions and invalidates their keys within 5 seconds. Session, key and principal state are already re-read on every request with no cache, so the remaining questions were who suspends, what suspension does to sessions and keys, and how processes holding long-lived streams (M5) learn about a revocation.

## Decision

- **Instance admins suspend and reactivate people** (`POST /api/users/:id/suspend`, `/reactivate`) and list them (`GET /api/users`). Principals are instance-wide, so this is not a workspace admin's power. A workspace admin removes a person's access to one workspace by removing their membership (ADR 0029), which also stops that person's keys for that workspace.
- **Suspension** sets `principals.status = 'suspended'`:
  - The person's next request, by session or key, is refused (401).
  - **All their Better Auth sessions are deleted**, so reactivation does not revive an old login; they sign in again.
  - Better Auth's `session.create.before` hook refuses new sessions for a suspended person, so signing in fails (401, `FAILED_TO_CREATE_SESSION`) and leaves no session row.
  - Their keys are not revoked. They stop working while the owner is suspended and work again on reactivation. Revoke keys explicitly to kill them for good.
- **An instance admin cannot suspend themselves** (`cannot_suspend_self`, 409), so no one locks the instance out by accident. Only users can be suspended; key principals are revoked through the key endpoints.
- **Revocation events.** Suspension, key revocation and membership removal publish a `PrincipalRevokedEvent` on the Valkey channel `lakka:events:principal-revoked`, as `{principalId, reason, workspaceId, at}`. M5's chat surface will use it to close open streams at once (AC 6).
  - The events are **best effort**. The change is already committed in Postgres, and authentication always re-reads it, so a lost or unpublishable event never lets anyone back in.
  - A failed publish is logged (`events.publish_failed`); it neither fails nor undoes the admin action.
- **Timing:** measured in the integration tests, from the suspend or revoke call to the next refused request, which is well under the 5-second limit. The refusal does not depend on events or caches.

## Consequences

- AC 6 is met for everything that exists in M1: sessions end, keys stop, new sign-ins fail. What remains for AC 6 is subscribing in the chat surface (M5) to cut streams that are already open.
- Someone who knows a suspended person's correct password can tell the account is suspended rather than the password being wrong, because the error codes differ. They already hold the password, so this reveals little.
- Suspension is reversible and keeps keys. Deleting a person and their data comes with NF-P4.
