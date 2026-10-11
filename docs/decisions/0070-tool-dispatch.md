# 0070. The tool dispatch seam

Status: accepted

## Context

- Invariant 7 fixes the order of checks between a model asking for a tool and any code running:
  1. existence;
  2. allowlist;
  3. schema;
  4. semantic checks;
  5. authorization as the end user;
  6. approval;
  7. execute with a timeout;
  8. shape the result.
- It also requires tool results to be treated as untrusted data, delimited, and never merged into instructions.
- The related requirements:
  - TL-6: record every tool call;
  - TL-7: delimit results;
  - TL-8: run tools through a layer that can move them out of process;
  - TL-9: cap the loop.
- The tech spec's sections on shaping errors, shaping results and prompt injection say how.
- ADR 0066 set the limits (H6) and the delimiting (H7). ADR 0069 made the allowlist part of the policy snapshot.

## Decision

- **`dispatchToolCall`** runs one call through the eight checks, in order, against a request's policy snapshot and the tools resolved for its caller:
  1. **Existence:** a name that is no enabled tool of the workspace is refused, listing up to 20 tools the caller may use. The model can correct itself.
  2. **Allowlist:** a workspace tool this request may not use is refused, as final.
  3. **Schema:** the arguments must be a JSON object of at most 16 KB, and must match the schema stored when the tool was synced. The check uses zod's JSON Schema support, so no new dependency; a schema zod cannot read makes the tool unusable at sync. Errors name the fields.
  4. **Semantic:** Lakka knows nothing of an MCP tool's meaning, so only structural sanity is checked: nesting at most 20 deep. The stage is where built-in tools will add their own checks.
  5. **Authorization as the end user:** the credential is resolved for the acting person (ADR 0068). It is their own for an OAuth server, and the shared one, recorded as its admin's, otherwise. Lakka never uses a credential of its own. A missing credential is final, and tells the model to ask the user to connect.
  6. **Approval:** a tool that asks first runs only when the request's approval check says the caller approved it (TL-4, AC 18). Otherwise nothing runs, and the outcome is `approval_required`. The tool loop (ADR 0071) answers the check from approvals and standing grants.
  7. **Execute,** through a `ToolExecutor`, under a 30-second timeout. A call is retried once only when the server could not be reached and the tool says repeating it is harmless (read-only or idempotent). A call that may have run is never sent twice.
  8. **Shape:**
     - text is kept, binary content is named but not forwarded, and structured content is used when there is no text;
     - the result is cut to 16 KB with a note;
     - a tool's own error goes back as something the model can act on.
- **Outcomes** are `ok` with the shaped text, `approval_required`, or `error`. An error is one of:
  - `fixable`: the model can try differently;
  - `retryable`: the trouble is temporary;
  - `terminal`: the model should not try that tool again in this request.
  - Messages are short and plain, and never pass on a server's internals.
- **Delimiting** (`delimitToolResult`) frames a result as `<tool_result name="...">...</tool_result>`. Anything inside that resembles the delimiters is escaped, so a result cannot close its own frame. The tool loop (ADR 0071) builds prompts with it, as tool-role messages, alongside `TOOL_RESULTS_ARE_DATA`, a note that results are data. The note helps; it is not the defence.
- **The audit (`tool_invocations`)** records every call the model asked for, whatever became of it:
  - request, workspace, principal and acting person, and conversation;
  - the model's call id, and the name it used;
  - the tool and server;
  - the arguments;
  - the status: `ok`, `rejected`, `denied`, `approval_required`, `failed` or `timeout`;
  - the reason, whose credential was used, and the duration.
  - Arguments are stored as given. Arguments over 16 KB, or that were not JSON, are stored only as their size (ADR 0066 Q3). They never go in logs or spans; an `execute_tool` span carries the tool, the status and the credential's principal.
- **The loop guard (`ToolLoopGuard`),** which the tool loop (ADR 0071) uses:
  - at most 8 rounds per request (TL-9);
  - an identical call, by canonical arguments, is refused;
  - three failures in a row, or one terminal failure, put a tool aside for the rest of the request.
- **The executor interface** takes plain data (the server target, the credential, the tool, the arguments, the deadline), so an executor in another process can take the same input (TL-8). `inProcessExecutor` connects, calls and closes; ADR 0073 adds one out of process.

## Consequences

- No path reaches a tool without the checks. The audit answers who called what, with whose credential, and what became of it, including calls that were refused.
- Approval is a question the seam asks and does not answer, so the rules for approvals and standing grants live in one place (ADR 0071).
- The semantic stage is thin for MCP tools, deliberately. The real protection for a tool Lakka cannot understand is the end user's own authorization at the server, plus approval for anything consequential.
