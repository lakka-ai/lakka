# 0098. Setup, sign-in, invites and password reset links

Status: accepted. Widens ADR 0034 on first-run setup and ADR 0035 on invite links. Adds password reset links.

## Context

The Setup, Public, Public-Error, Public-Invite, Public-Member and Public-Expired boards (`docs/design/`) differ from what was built, and in two places from what the specs settle:

- **Addresses:** `screens.md` gives `/invite/:token`. ADR 0035 keeps the token in the link's fragment, because browsers never send it to a server, so it cannot land in a proxy or server log.
- **Password reset:** sign-in says "Forgot your password? Ask an instance admin to reset it", and open-questions.md says reset works by asking an admin. No admin could reset a password, not in the web app and not with the command line.
- **Invite page:** it names who made the link ("Maja Lind invited you"). It also has a page for someone who is in the workspace already ("You joined on Aug 6"). Neither was told by the api.
- **Setup:** it is three addresses (`/setup/code`, `/setup/recovery-key`, `/setup/account`). The board's last step asks for a workspace name only, where the api also wants its name for links.

## Decision

- **Invite links keep the fragment** (the project owner's choice): `/invite#token`, as ADR 0035 has it. The page looks as drawn.
- **Password reset links** (the project owner's choice). There is no email, so an instance admin makes a one-time link for one person and passes it on, as with invites.
  - It is "Make a password reset link" in the row's More actions menu on People. It is shown once, as other one-time secrets are.
  - `POST /api/users/:id/password-reset` makes it. It works for a day, and one made later replaces it (migration 0031 keeps the token's digest, one row per person).
  - It is a delegation: it stops working if its maker is no longer an active instance admin, or the person is no longer active (invariant 2).
  - `/reset#token` says whose password it sets. `POST /api/password-reset` sets the new password, and ends every session of the person. It also gives a password to someone who only used a provider, as Better Auth's own admin plugin does. Their keys are left alone.
  - Previewing and using a link are public and throttled, and the token and password are never logged. Deleting a person removes links for them and by them.
- **Invite previews** name who made the link. For a signed-in person, they also say whether that person is in the workspace already, with their role and since when. The page for them has one action, Open the workspace.
- **Setup** keeps the setup code and the recovery key in memory in a layout around the three steps, never in the browser's storage.
  - Opening a later step without them starts again at `/setup/code`.
  - The workspace's name for links is made from its name, since a fresh server has no other to clash with.
  - The recovery key is shown as it is, not grouped as drawn, so what is pasted back is exactly the key.
  - Download saves it as a text file in the browser; nothing is fetched.
- **Sign-in** shows the host the page was served at, from the request.
  - Providers come first, then "or", then email and password.
  - A failed sign-in keeps the email, moves focus to Password and never says which of the two was wrong.
  - Every password field has a button that says Show while it is hidden and Hide while it is shown. Its name changes, so it carries no aria-pressed, which would announce both.
- **Forms** on these pages are checked on submit, with focus moving to the first field with a problem. Their fields use aria validation, so the browser's own bubbles never pre-empt that.

## Consequences

- An instance admin can get a locked-out person back in without deleting them. Whoever holds the link can set the password until it is used or expires, so it is shown once, with that warning.
- Setup cannot be resumed after a reload in the middle; the operator runs the setup-code command again.
- Invite and reset links look the same and are handled the same way, by `lib/fragment-token.ts`.
