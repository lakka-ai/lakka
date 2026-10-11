# 0118. Stdio MCP servers run in a sandbox with a signed-token egress proxy

Status: accepted. Builds the stdio part of NF-S4; supersedes ADR 0066 H11 (the
out-of-process runner is no longer CI only); extends ADR 0073 (its protocol is now used in
production, as version 3); changes ADR 0067 (a stdio server no longer runs in the api container).

## Context

- NF-S4 asks for outbound network access from tool execution to be blocked by default and allowed
  only by an explicit allowlist. ADR 0117 built it for Lakka's own HTTP traffic to MCP servers.
  A stdio server was still a child of the api: the same uid, the api's network, and the secrets
  volume every app service mounts.
- Every MCP operation opens a fresh connection and closes it (ADR 0067), so a stdio server lives
  for one operation. Nothing needs a long-lived session across a process boundary.
- Testing a server, syncing its tools and testing one's own OAuth connection listed tools by
  connecting directly, bypassing the executor seam (TL-8); only tool calls used it, and the api
  fell back to the in-process executor when none was given.
- The out-of-process runner existed (ADR 0073) and was proven in CI in a container with no
  network. Most real stdio servers need some network, such as a SaaS API, so "no network" alone
  would break them.
- Invariant 11 allows no new stateful dependency. Only instance admins add stdio servers (ADR 0066
  Q2), and they may point one at a private address (ADR 0067).

## Decision

- **Listing goes through the seam.** `ToolExecutor` gains `list()`, and testing, syncing and the
  OAuth connection test call it on the executor in `McpContext`. `byTransport({ stdio, http })`
  picks one per transport. The api requires an executor; nothing falls back to running a server
  in process.
- **Two services on the app image.**
  - `sandbox` runs `lakka tool-host`. It is root in its container only to switch uids: every
    capability is dropped but SETUID and SETGID, `no-new-privileges` is set, the root is
    read-only, `/tmp` is a 512 MB tmpfs, and the container is capped at 512 processes, 2 GB
    (`LAKKA_SANDBOX_MEMORY`) and a low CPU share. It mounts no secrets, only its token and
    the socket volume, and is only on `sandbox`, an internal network.
  - `egress` runs `lakka egress`, an HTTP proxy on 3128, on both networks, read-only, with no
    capabilities and only its key.
- **The api reaches the tool host on a unix socket**, in a shared in-memory volume owned
  root:node with mode 0750, not over the sandbox network. Anything on that network can be reached
  from a stdio server, and the api must not be, so only the sandbox and the proxy are on it. This
  departs from the design's first shape, which put the api on the sandbox network.
- **One operation, one runner, one slot.** The api POSTs a runner request to the tool host with
  a bearer token from a key file only the two of them mount. The tool host takes a free slot, a
  uid from 61000 up (`LAKKA_SANDBOX_SLOTS`, 8 by default), and starts `lakka tool-runner`
  as that uid in the slot's home under prlimit: 64 processes, 1 GiB of data, 120 s of CPU, 256
  open files, 64 MB files, no core dumps. The runner starts the server as its own child, under
  the same uid. The tool host passes the runner's reply back without reading it.
  - Afterwards, or when the api goes away, it runs the cleanup as the slot's uid: `kill -9 -1`,
    the uid's IPC objects, the home. Running it as the uid means the tool host never needs KILL
    or DAC_OVERRIDE. At startup each slot makes its own home, then `/tmp` and `/dev/shm` are
    closed to others, so a slot writes nowhere else. A slot whose processes or files survive the
    cleanup is taken out of use; with none left the tool host exits, and Docker restarts it on a
    fresh tmpfs.
  - An operation waits for a slot until its deadline (its own and the runner's 15 s to start),
    then gets 503; one still running at its deadline is ended and gets 504.
  - The runner raises its own `oom_score_adj` to 1000, so the kernel kills runners before the
    tool host.
- **Runner protocol version 3.** `op: call | list`, the `ToolExecution` or listing, and
  `egressProxy`. No release shipped version 2, but the rule stays simple: a runner refuses any
  version but its own. The runner imports `@lakka/core/runner`, not all of core.
- **The egress proxy.** A stdio server is given `HTTPS_PROXY` and `HTTP_PROXY` (both cases) of
  `http://t:<token>@egress:3128`, and `NODE_USE_ENV_PROXY=1`, which Node 24's fetch and http
  modules honour. The token is HMAC-SHA256, made by the api for each operation over the
  operation's rule (for a stdio server, the instance's allowlist and the operator's private
  origins, with private addresses allowed since only instance admins add one), an operation id,
  and an expiry at most 45 s away; the rule is compressed so a full allowlist fits in an
  environment variable. The proxy:
  - takes CONNECT and absolute-form plain http, the two forms Node sends; answers 407 without a
    good token and 403 for an unlisted origin or port, a private address the rule does not allow,
    or Lakka itself;
  - decides with the same `decideEgress` as the api's guarded fetch. A tunnel is allowed when the
    http or the https origin of its host and port is listed, since Node's fetch tunnels plain
    http too;
  - never reaches Lakka's own services, by name or by any address their names resolve to,
    looked up for every connection, nor its own addresses;
  - resolves the name itself and connects to the address it checked; cuts a tunnel when its token
    expires; keeps no state; logs only what it refused, as host, port and operation id.
- **The api's own HTTP MCP traffic does not go through the proxy.** It keeps the guarded fetch
  (ADR 0117). One policy function, two places that enforce it.
- **Keys.** init writes the tool host token into `sandbox-keys` and the egress signing key into
  `egress-keys`, root:node, mode 0440, so a slot's uid cannot read either. They are not backed
  up: nothing is encrypted with them, and init makes new ones when they are missing.
- **The sandbox is optional for everything but stdio.** The api does not depend on it. While the
  tool host is down, busy past an operation's deadline, or a key is missing, stdio operations
  fail closed as `unreachable`, and nothing else is affected.
- **Development.** `pnpm dev` has no sandbox: `docker/dev.env` sets
  `LAKKA_TOOL_HOST_URL=in-process` and the api warns at startup. A process with
  `NODE_ENV=production`, as the image sets, refuses that value. Below root the tool host runs
  slots under its own uid with no limits and says so.
- **Docker Engine 26 or later.** Older engines forward outside names to a container on an
  internal network, so a stdio server could resolve names it should not. The stack test proves
  the behaviour.
- **Proof.** `pnpm test:sandbox` runs a dependency-free probe server in the stack's sandbox and
  checks what it can and cannot do, and stops and kills the sandbox and the proxy under it. It
  runs in CI's stack job and in `pnpm ci:local`. `pnpm test:out-of-process` stays the TL-8 proof.
- **Still v2.** A code interpreter, or any built-in tool that runs code, stays in v2 (theme 5).

## Consequences

- A stdio server cannot read Lakka's secrets or keys, reach Postgres, Valkey or the api, or
  reach anything an instance admin did not list. A concurrent operation runs under another uid
  and cannot read its environment; nothing it starts outlives its operation.
- A stdio server that needs network works only once its origins are listed, and only if it
  honours the proxy variables; one that ignores them has no network at all. The upgrade guide
  says so.
- Commands and files a stdio server needs are mounted into `sandbox`, not `api`, and must be
  readable by any uid. An image override that added them to the api moves to the sandbox.
- Each operation starts a runner and a server: about 370 ms end to end to list a small server's
  tools on a laptop. Runners are not kept warm.
- Under rootless Docker or userns-remap, the slots' uids must be inside the container's mapped
  range, which the default 65,536 covers. If they are not, the tool host cannot switch to them:
  it logs `sandbox.start_failed` with `uid_switch_failed` and exits, the sandbox never turns
  healthy, and stdio servers are unreachable until the range is widened or the setting fixed.
- Two more services, two more volumes of keys and one in memory, and nine services in all.

## Amendment: 1 GiB of data, not 512 MB

The runner's data limit was 512 MB, and Node does not start under it on amd64. RLIMIT_DATA also
counts private writable memory that is reserved and not yet used, and V8 on x86_64 reserves its
code range at startup ("Failed to reserve virtual memory for CodeRange"). The runner is Node, so
no stdio server could start there; arm64 starts under 512 MB, which is why the limit went unseen
until the stack test ran on amd64.

- The limit is 1 GiB on both architectures. `LAKKA_SANDBOX_MEMORY` still caps all slots
  together, and the stack test checks the limit each runner gets.
- A runner that dies on its own is logged as `sandbox.runner_exited`, with its exit code and
  signal and nothing it wrote. Before, its stderr was discarded and nothing said it had failed.
