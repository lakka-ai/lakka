# 0044. Forms before hydration

Status: accepted

## Context

The web app renders on the server, and React attaches its event handlers only when the page hydrates in the browser. Until then, a form behaves as plain HTML. The forms rendered with no `method`, so a browser submitting one natively sent every field in the query string of a GET request. A probe with JavaScript off showed `/setup?code=...`.

The same was true of passwords on sign-in, setup and invite acceptance, and of provider API keys. They would land in browser history and in the access logs of any reverse proxy a customer runs, which breaks invariant 9 and NF-S5. A CI run on a slow arm64 runner hit the same race: its sign-in submitted before hydration, and a test failed.

## Decision

- Every form uses `SafeForm` and `SubmitButton` (`apps/web/src/components/safe-form.tsx`):
  - `SafeForm` always sets `method="post"`, so even a native submission keeps fields out of the URL.
  - `SubmitButton` stays disabled until the page has hydrated, detected with `useSyncExternalStore`, which reads false during server rendering and true after hydration. With its only submit button disabled, a form cannot be submitted implicitly by pressing Enter either.
- An e2e test runs with JavaScript disabled. It checks that sign-in and the provider key form post and have disabled submit buttons, and that pressing Enter leaves the URL without a query string.
- **The e2e suite now respects the sign-in throttle** (3 attempts per address per 10 seconds, ADR 0033). With buttons waiting for hydration, test sign-ins reach the api faster and more predictably. So every sign-in attempt first takes a slot from a small helper. The helper records attempt times in a file, which survives Playwright restarting a worker, and waits only as long as the throttle requires. This replaces the fixed 11-second pause in global setup; the suite runs about 15 seconds faster.

## Consequences

- A person on a slow connection sees a disabled button for the moment before hydration instead of a submission that silently fails.
- New forms must use `SafeForm` and `SubmitButton`; a plain HeroUI `Form` with a submit button would reintroduce the leak.

## Fields wait for hydration too

A CI run failed three acceptance tests the same way: text typed before hydration was gone afterwards, and the form submitted empty. React resets controlled inputs to their state as it hydrates, so anything typed earlier silently vanishes. A person on a slow connection would see the same.

- `SafeForm` wraps its fields in a `fieldset` that is disabled until hydration. A disabled fieldset disables every field inside it natively, before any script runs. It uses `display: contents`, so the form's own layout applies to the fields as before.
- Nothing can now be typed that would be lost, or that could leak. The no-JavaScript test checks that the fields are disabled, instead of typing into them.
- Playwright waits for a field to be enabled before filling it, so tests no longer race hydration.
