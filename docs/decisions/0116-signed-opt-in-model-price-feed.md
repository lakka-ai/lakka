# 0116. Signed, opt-in model price feed

Status: accepted. Builds what ADR 0037 deferred (PR-6); changes ADR 0037's resolution
order (models only the feed lists come after custom models).

## Context

- PR-6 asks for the catalogue to be refreshed from a signed feed, opt-in and off by default. ADR
  0037 shipped the catalogue as a committed file and deferred the feed. Until now a price change
  reached an instance only with a release.
- The feed is the first connection the product itself would open to the internet. NF-P1, NF-P2
  and invariant 8 allow it only once an admin enabled that specific connection, and NF-D5 and
  invariant 12 require that the image start, and price, with no network at all.
- Prices decide what budgets are charged. Whoever can change them can make spend uncapped, which
  is why only instance admins set custom prices (ADR 0037). A feed is a way for someone outside the
  instance to change them, so it has to be authenticated and bounded, and a model with no price is
  still refused (BG-4, invariant 3).
- The catalogue was loaded once by the api and passed around by value, so nothing could change it
  while running. Reservation and dispatch each looked prices up again (invariant 4 wants them to
  agree).
- The project has one maintainer. Nobody else should be able to publish prices.

## Decision

- **The file.** `feed/catalogue-v1.json` on the project's main branch, by default
  `https://raw.githubusercontent.com/lakka-ai/lakka/main/feed/catalogue-v1.json`. It is an
  envelope `{ format: 1, keyId, payload, signature }`; the payload is base64 of the bundled file's
  shape (`catalogueFile`) with `serial` and `issuedAt`. A breaking change gets a new path (`-v2`).
- **The signature.** Ed25519 through `node:crypto`, over the bytes
  `"lakka-catalogue-feed-v1\n"` followed by the payload exactly as decoded, so a signature made
  for anything else never verifies here and nothing is re-serialized before checking. The public
  keys are baked into core (`packages/core/src/models/feed-keys.ts`), each with a key id: the first
  16 hex digits of the SHA-256 of the raw key. The payload is parsed only after the signature
  checks out.
- **Key custody.** The owner generates an offline primary key and a backup key with
  `pnpm catalogue:keygen`, keeps the private halves in a password manager and nowhere else, and
  adds both public halves in a reviewed commit. A build with an empty keyring cannot turn the feed
  on: the api refuses with `catalogue_feed_no_key` and the page says why. A
  compromised key is removed by a release without it and an advisory (SECURITY.md).
- **Serials.** `models.json` gains `serial`, which `pnpm catalogue:update` raises by one. A feed
  applies only with a serial above both the bundled file's and the last feed applied. Below the
  last applied is a replay and refused (`not_newer`); equal to it, or no newer than the release, is
  recorded as unchanged. After an image upgrade the bundled file wins when it is as new. The last
  applied serial counts only while the stored file still verifies with this build's keys, so a
  feed signed with a key a later release removed cannot hold back honest feeds with a huge
  serial.
- **What a signed feed may still not do.** Any of these refuses the whole feed: a provider that is
  not first-party (`FIRST_PARTY_KINDS`), a zero input or output price, a long-context tier that
  lowers a price, more than 2000 models, a file over 1 MB, or a cut of any bundled model's input or
  output price below a quarter of the bundled price. The last is the owner's guard against a
  mistake or a stolen key turning a model nearly free.
- **Merge.** Bundled ids take the feed's entries. Bundled models the feed leaves out keep theirs: a
  feed never removes a model. Models only the feed lists are added after custom models, so the
  resolution order is bundled, custom, feed-only, and an admin's own price for a model wins over
  the feed's. A custom model may still not take a bundled id, and may take a feed-only one.
- **Off by default, and off means off.** One row, `catalogue_feed`, seeded with `enabled = false`.
  Only instance admins read or change it (never a key, even an instance admin's). The worker's
  pg-boss job `catalogue-feed` runs every minute and returns before any network call while it is
  off. On, it checks once a day at a per-instance minute (random, stored in the row) and at once
  when an admin presses Check now. Switching off applies the bundled prices at once and keeps the
  stored feed and its serial, so replay protection survives switching on again.
  `LAKKA_CATALOGUE_FEED_URL` points at a mirror (the signature binds the content, not the host);
  `off` hides the switch and keeps the feed off whatever the row says.
- **The request.** https only, `redirect: 'error'`, 10 s, at most 1 MB read, and one header,
  `user-agent: lakka`: no version and no instance identifiers. The host still sees the server's
  address, and the page says so.
- **Applying it.** The worker stores the verified file in one transaction, under the row lock,
  refusing a serial that is not newer. The api reads the catalogue through a `CatalogueStore`; it
  polls the row every 30 s with one primary-key read and reads the file only when the switch or
  serial changed. It verifies the stored file again on every load against this build's keys and
  bundled catalogue; one that fails is ignored with `catalogue_feed.stored_refused` and the
  bundled prices apply. Nothing about the feed can stop startup.
- **One catalogue per request.** `handleModelRequest` reads the store once and pins that catalogue
  for the request, so its estimate, reservation, every dispatch attempt and the usage rows use the
  same prices even if a feed lands meanwhile. `ModelView` gains `priceUpdated`, true for a price
  that came from the feed and differs from the release's, and for feed-only models.
- **Logs.** `catalogue_feed.applied {serial, models, prices_changed}`, `catalogue_feed.unchanged`,
  `catalogue_feed.check_failed {error_code}` (error for `bad_signature` and `not_newer`, else
  warn), and `catalogue.reloaded {serial}` in the api. Never the file's contents. The diagnostics
  bundle says whether the feed is locked and its origin, whether it is on, and what the last check
  found; never the file.

## Consequences

- An instance that opts in gets new prices within a day of a release's catalogue update, without
  upgrading. One that does not opt in contacts nothing, as before.
- A build without the public keys leaves the feature dormant: the switch is disabled, and
  `pnpm catalogue:sign` refuses to sign with a key the build does not carry. The test that the
  committed feed verifies and equals `models.json` skips in a tree with no feed.
- Publishing prices is now part of the release checklist: `catalogue:update`, review, then
  `catalogue:sign` in the same pull request (docs/releasing.md).
- A feed can raise prices without limit; only cuts are bounded. Raising is the safe direction for
  budgets.
- Not addressed: a release that bundles a model an admin already added as a custom model still
  takes over that model's price, as ADR 0037 orders, without telling the admin.
