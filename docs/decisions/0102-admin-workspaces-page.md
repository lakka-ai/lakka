# 0102. The Workspaces admin page

Status: accepted; extended by ADR 0104 (deleting a workspace).

## Context

The design adds a Workspaces page as the first item of the Admin group (`Admin-Workspaces` and
`Admin-Workspace-Dialogs` boards), and moves Create workspace there from the workspace list. The
boards disagree with the api in two places:

- **No slug field.** Create workspace asks only for a name. The api needs a name and a slug,
  the name for links, which must be unique.
- **First admin.** The dialog lets the instance admin pick who becomes the first admin. The api
  always made the caller the first admin.

The table also shows each workspace's admins, people and spend this month, which no single
endpoint returns.

## Decision

- **The slug is made from the name** in the browser, as first-run setup already does
  (`apps/web/src/lib/slug.ts`). If it is taken, the dialog says a workspace with a name like
  this exists and asks for a different name.
- **`POST /api/workspaces` takes an optional `adminPrincipalId`.** Without it, the caller is the
  first admin, as before. With it, that person must be an active user, the same check as when an
  instance admin adds a member, and the caller does not join; the response's `role` is then null.
  First-run setup keeps the old body (`newWorkspace`), so it cannot name anyone else.
- **The table is worked out in the browser** (ADR 0097) from what instance admins already read:
  the workspace list, the people list (each person's workspaces and roles) and this month's
  instance spend report. People counts leave out deleted people. No new endpoint.
- **Delete is not built yet.** The boards draw it; it waits for its own spec. The note above the
  table leaves out its sentence about deleting until then.
- **The workspace list** at `/workspaces` stays, for All workspaces in the switcher and for
  people in no workspace. Its create form is replaced by a link to the new page.

## Consequences

- An instance admin can set up a workspace for a team they do not belong to.
- Renaming a workspace changes its name only; its slug stays, so links keep working.
- The page's numbers match People and Instance spend, because they are read from the same
  responses.
