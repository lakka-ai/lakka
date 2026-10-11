# 0081. Health checks and graceful shutdown

Status: accepted

## Context

- Requirements:
  - AD-5: a health endpoint that reports database, cache, classifier and provider reachability separately;
  - NF-O4: failures reported per component, so an operator can tell a provider outage from a database problem;
  - NF-O5: graceful shutdown finishes in-flight streams and releases budget reservations.
- ADR 0017 made the database and cache required, and said the classifier and provider checks would be non-fatal: reported as down, with a 200 and an overall status of `degraded`. It did not say how providers are checked, or which ones.
- ADR 0025 ended every open stream at once on shutdown, with `server_shutting_down`. That settles every reservation, but it does not finish the streams NF-O5 names.
- `/healthz` is unauthenticated (ADR 0017), and the container healthcheck polls it every 5 s.

## Decision

- **Status.** `healthReport.status` is `ok`, `degraded` or `down`. `down` answers 503; `ok` and `degraded` answer 200, so a provider outage never makes compose mark the api unhealthy.
- **Error codes.** A check that is down reports one of `timeout`, `unreachable`, `auth_failed` (a provider refused the credential), `error` (a provider answered with another error status) or `unavailable` (the classifier could not load). Never a driver message or an address.
- **Classifier.** The `classifier` check asks the lazy runtime for its embedder.
  - The first health check after startup is therefore what loads the model, a few seconds after start rather than at the first routed request. Broken or missing weights show up in `/healthz` at once.
  - A failed load reports `unavailable`, and the runtime retries it on its own schedule (ADR 0043).
  - Routing stays optional (invariant 10): the check never blocks startup or a request.
- **Providers.** Each instance credential is its own check, named `provider:<name>`.
  - It is probed with the free model listing a credential test uses (ADR 0038), so a health check never spends money.
  - A result stands for 60 s, and concurrent checks share one probe. A provider sees at most one listing per credential per minute, however often `/healthz` is polled. An edited credential is probed again at once.
  - Workspace credentials are not probed or listed. The endpoint is unauthenticated, and whether a workspace has its own key, and whether that key works, is for its admins to see on the provider page.
  - The endpoint names instance providers. A name is an admin's label (`openai`, or a slug for an OpenAI-compatible server), never a hostname.
- **Listing under the timeout.** The provider list is read from Postgres under the same 2 s timeout as each check. If that read fails or hangs, no provider is listed, and the database check already reports why.
- **Shutdown drain.** On SIGTERM, Fastify answers every new request with 503, `/healthz` included. It stops accepting connections once the drain is over.
  - Requests already in flight, streamed or not, get 20 s to finish. They end and settle their reservations as usual.
  - Whatever is still open after that ends as ADR 0025 describes: with `server_shutting_down`, and with its partial usage settled, not the whole reservation released.
  - The process then waits up to 2 s for those responses to be written, and cuts any connection left 3 s after that.
  - compose gives the api `stop_grace_period: 30s`, since Docker's default of 10 s would kill it mid-drain.
  - This replaces the "at once" in ADR 0025's shutdown bullet. The rest of that ADR stands.
- The drain window is a constant, not a setting. Tests shorten it through `buildServer`.
- Fastify's plugin timeout also bounds `preClose` hooks, so it is set to the drain plus the wait for ended streams plus Fastify's default of 10 s. At the default, the drain fails `close()`.

## Consequences

- An operator reading `/healthz` sees, for example, `provider:anthropic` down with `auth_failed` while the database and cache are ok, and the api stays in service.
- The api holds the classifier in memory from its first health check, whether or not any workspace routes. The image job's benchmark and the NF-D8 limits already assume it is loaded.
- A deploy or `docker compose down` can take up to about 25 s while long generations finish.
- A reservation that shutdown cannot settle, for example because Postgres is already gone, is still settled by the orphan sweep (ADR 0052).
