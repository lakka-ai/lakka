# 0097. What the instance admin pages are told

Status: accepted. Widens ADR 0032 on editing identity providers, ADR 0078 on the retention page, and ADR 0027 on who may grant instance admin.

## Context

The Admin, Phone-People, Admin-Signin, Admin-Providers, Admin-Models, Admin-Spend, Admin-Retention, Admin-Diagnostics and Admin-Dialogs boards (`docs/design/`) draw more than the api sent, and in places something other than what the specs settle:

- **People:** each person's workspaces, how they sign in and when they were last active. Nothing stored when someone was last active. Sessions are deleted on suspension and usage rows go with retention, yet the board shows a suspended person's last day.
- **Sign-in providers:** one editable form per provider, with its client ID, a redirect URI and "In use by 27 people". Providers could only be added and removed, and the client ID was only inside the encrypted `oidc_config`.
- **Instance spend:** each workspace's own cap beside its spend.
- **Retention:** usage kept in days, where ADR 0078 keeps it in months. The board's schedule says 03:00, and the job runs at 03:17 UTC. It also draws a run's duration, which was not kept. Run now returned the previous run when another was going.
- **Models:** the Add a model dialog has Images and PDF files, but a model's tool support is a capability too. Left off, a model added by hand could never be offered a tool.
- **Diagnostics:** the board calls the bundle a zip; it is a tar.gz.
- Nothing draws a way to make someone an instance admin, which only the command line could do.

## Decision

- **Last active** (the project owner's choice): `principals.last_active_at` (migration 0028). It is written when a session or a key is authenticated, a key counting for its owner, at most once every five minutes. It survives suspension and retention. It is null until the person is next active.
- **People list:**
  - Each person's workspaces with their role, and how they sign in (password, or a provider by name, "A removed provider" once it is gone).
  - Search and paging are done in the browser, since the list is complete. There are 20 people to a page, with Previous and Next.
  - A row names its first three workspaces, then "And N more".
- **Instance admin from People** (the project owner's choice): `PUT /api/users/:id/instance-admin`, for instance admins, after a confirm.
  - It refuses to leave the instance without an active instance admin (`last_instance_admin`), with the admins locked while it checks.
  - It is not drawn, so it sits in a More actions menu at the end of each row, and the row keeps the board's three buttons.
- **Editing a provider:** `PUT /api/sso/providers/:id` changes the display name, the new-account policy and, when sent, the client secret.
  - The provider ID, issuer and client ID are fixed once added, since they decide who a sign-in is. Better Auth refuses to change them while anyone has signed in.
  - The secret is written into Better Auth's stored settings by us, in the same transaction as the policy. Better Auth's own update route lets only the admin who registered a provider change it.
  - A provider may not be named `credential`, Better Auth's name for a password.
- **Provider details:**
  - The client ID is copied beside the policy (migration 0029), so listings still never decrypt the secret. It is filled in once for providers added before.
  - Listings carry the redirect URI the api serves, how many people have signed in with the provider, and how many of them have no other way in.
- **Removing a provider** (the project owner's choice): when people sign in with nothing else, the admin types the provider ID to confirm, and is told those people cannot sign in until a provider with that ID is added again. Their sign-in rows stay, so adding it back restores them. Otherwise a plain confirm says whether anyone used it.
- **Sign-in provider forms** are safe forms (ADR 0044): the client secret field is on the page before it hydrates.
- **Model providers:**
  - One row for each first-party provider, set or not, and one for each local endpoint.
  - Adding a local endpoint, and removing any provider, are not drawn. They are a dialog and a plain confirm.
  - Replace key and Add key save, then check at once.
- **Models:**
  - A model's status is worked out in the browser from its provider's last check with the instance key.
  - The catalogue has a search and pages of 20.
  - The dialog adds "It can call tools", checked by default.
  - A model's name cannot change once added, since routes point to it.
  - Long-context prices stay under the input price.
- **Instance spend:**
  - Each workspace's row carries its own cap as a budget view, with what it has spent in its current period.
  - The full instance report, at `/admin/spend/report`, is the workspace report with By workspace added. Its rows do not lead to Requests, which are listed per workspace.
- **Retention:**
  - Usage and budget alerts are kept in months, as ADR 0078 settles.
  - An empty Conversations field keeps conversations until people delete them.
  - Tool records, budget alerts and settled holds are rows of the same section.
  - The page says 03:17 UTC, and that budgets are not affected.
  - Each run records how long it took (migration 0030).
  - Run now answers `retention_running` (409) while another run is going.
- **Diagnostics** says .tar.gz, and keeps the command-line alternative under the download.
- **Addresses** follow `screens.md`: `/admin/people`, `/admin/sign-in`, `/admin/model-providers`. The old addresses are gone.

## Consequences

- Authentication now writes to `principals` every few minutes for someone who is active.
- An instance admin can make other people instance admins without the command line, and can never remove the last active one.
- Fixing a provider's issuer or client ID means adding a new provider, even when nobody has used the old one.
- The e2e stack lists its Keycloak as a private identity provider, so the suite adds and removes a real one.
