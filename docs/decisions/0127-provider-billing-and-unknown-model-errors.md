# 0127. Errors for a provider account out of credit and for a model id the provider does not know

Status: accepted; amends ADR 0040 (dispatch), its error classification table.

## Context

- CH-7 asks for a clear message the user can act on for any provider error. Two common setup mistakes did not get one. A diagnostics bundle from a beta install showed both, against the same OpenAI-compatible endpoint:
  - The provider answered **402 Payment Required**: the account had no credit. A 402 fell under "any other 4xx", so chat said "could not handle this message, try wording it differently". Rewording never helps.
  - After the account was topped up, the provider answered **404**: the custom model's id was not one it serves. With no fallback, ADR 0040 makes that `upstream_unavailable`, so chat said the provider "is not responding". It was answering, and a retry never helps.
- The provider **Check** passed in both cases. It lists models, which is free and proves the key and address, not the account's credit or any one model id.
- Other providers report an empty account in other ways. OpenAI answers 429 with `insufficient_quota`, which waiting does not fix, and Anthropic answers 400 with "Your credit balance is too low". Today the first is retried as a rate limit and the second is `provider_rejected_request`.

## Decision

- **A new failure kind, `billing`**, for a 402, or a 4xx whose body says the account is out of credit (`insufficient_quota`, "credit balance is too low"). It is checked before every other 4xx rule. The body is only matched against, never logged or returned, as with the other patterns.
- **Billing is terminal**, like a refused key: no retry and no failover. The account is the admin's to fix, and failing over to another provider would hide an empty account until every request fails. It raises `ProviderBillingError` (`provider_billing`), which names the provider.
- **An unknown model with nothing left raises `ProviderModelNotFoundError`** (`provider_model_not_found`) when every candidate tried failed with "model not found". It names the provider and the Lakka model reference of the last one tried. Failover is unchanged: an unknown model still moves to the next candidate at once. If any candidate failed some other way, the request stays `upstream_unavailable`, since a retry may still work. A context overflow still wins, as before.
- **Both are HTTP 502, `server_error`**, like `provider_auth_failed`: the caller cannot fix either. Neither is a 402: API-5 keeps 402 for `budget_exceeded`, so a client can always tell a Lakka budget from a provider's account. `provider_model_not_found` is kept apart from `model_not_found` (404), which means Lakka itself has no such model, and whose remedy (add it on the Models tab) would be wrong here.
- Both errors carry their names in the OpenAI-shaped error's `lakka` block (`provider`, and `model` for the unknown model), and chat says who refused, that nothing was charged, and that an admin has to fix it.

## Consequences

- The two most common setup mistakes with a new provider now say what they are, in chat, in the API and in the guide.
- The official OpenAI SDKs retry a 5xx on their own, as they already do for `provider_auth_failed`. Each retry fails the same way and costs nothing.
- A provider that reports an empty account in yet another way still lands in `provider_rejected_request` or, for a 429, the rate limit path. A pattern can be added when one is seen.
- **Check** still does not test credit or model ids. Checking each custom model against the provider's list is a separate change.
