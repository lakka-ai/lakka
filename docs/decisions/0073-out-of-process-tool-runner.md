# 0073. The out-of-process tool runner

Status: accepted; the wire is version 2 since ADR 0117 (it carries the allowed
origins); extended by ADR 0118 (version 3 lists tools too, and the sandbox runs it in production).

## Context

- TL-8 requires tool execution to run through a dispatch layer that can run tools out of process, even though v1 runs them in process.
- M6's exit criteria ask for that to be proven by running one tool out of process.
- ADR 0070 made the seam's executor take plain data for this reason. ADR 0066 H11 settled that the out-of-process runner is CI only:
  - `compose.yaml` does not change;
  - no stateful dependency is added (invariant 11).

## Decision

- **`commandExecutor(command)`** in core is a `ToolExecutor` that starts a process for each call. It writes the call to the process's stdin and reads the reply from its stdout. The dispatch seam is unchanged: the same eight checks, audit and shaping apply, and only where the tool runs differs.
- **The runner is `lakka tool-runner`**, a command of the app image. It runs the call with the in-process executor.
- **The wire** (`tools/runner.ts`):
  - one JSON request line: the `ToolExecution`, checked with zod on arrival;
  - one JSON reply: the tool's result, checked for its shape, or only the class of failure (`timeout`, `auth_failed`, `unreachable`, `error`). A server's own error text never crosses back, as in ADR 0070.
  - The runner's stderr is discarded (invariant 9).
  - The credential travels in the request, never in the command line or the environment, where process listings and `docker inspect` would show it.
  - A reply that is too large (4 MB), not JSON or not a reply is treated as a crash.
- **Stopping.** The executor keeps the runner's stdin open while it waits, and the runner stops the call when stdin ends.
  - On a deadline or an abort, the executor kills the process it started. For a container, that is the `docker` client, whose death closes the container's stdin.
  - A SIGTERM to the client was tried first. It did not reach the container, which kept running; the test for this failed until stdin was used.
  - The deadline is the tool's own 30 seconds plus 15 seconds for the runner to start.
- **The proof** (`pnpm test:out-of-process`, a CI job of its own, also in `pnpm ci:local`) builds the app image, then starts each runner with:

  ```
  docker run --rm -i --network none --read-only --cap-drop ALL
    --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1
    --user node --tmpfs /tmp:rw,noexec,nosuid,size=16m <image> tool-runner
  ```

  - A chat request in a conversation reaches a tool of a stdio MCP server through the whole pipeline. That tool reports where it ran: only the loopback interface, a root it cannot write, uid 1000, and the memory, process and CPU limits above.
  - The same test checks that a call past its deadline times out and its container stops, and that an aborted request stops its container.

- **Why a stdio tool:** a runner with no network can reach only a tool inside its own container. The dependency-free fixture server is mounted read-only at the same path on the host and in the container, so the api syncs its tools on the host and the runner runs them in the container.
- **Unit tests** run a real runner as a separate Node process against the same stdio fixture, and fake runners for every failure path, with no network or container.

## Consequences

- The seam is shown to hold across a process boundary, with no change to dispatch, and the image already carries the runner if a later version wants to use it.
- An HTTP tool in a runner would need a network. This decision gives the runner none. Giving it an egress-limited network is left to whoever turns the runner on in production.
- The app image gains one command that v1 does not use outside CI.
