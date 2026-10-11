# 0071. The tool loop, approvals and standing approvals

Status: accepted; followed by ADR 0089 (settling every round).

## Context

- ADR 0066 settled the shape of tool use in v1:
  - H3: server tools only in a conversation;
  - H4: client tools passed through;
  - H5: approvals end the run;
  - H6: limits;
  - H7: delimiting;
  - H8: budgets per round;
  - H9: streaming across rounds;
  - H10: revocation.
- ADR 0069 made the allowlist part of the policy snapshot. ADR 0070 built the seam that runs one call.
- What was left open: how rounds fit the pipeline and the budget engine, where a paused run's state lives, what a continuation replays, and how standing approvals (TL-5) are held and revoked.
- Invariant 9 allows prompt and response text only in `messages` and `span_content`, and tool arguments in `tool_invocations` (ADR 0066 Q3).

## Decision

- **Stage 6 in `handleModelRequest`.** A request is offered the workspace's tools only when all of these hold:
  - it names a conversation;
  - the pipeline has a tool executor;
  - the resolved model has the tools capability;
  - `resolveTools` returns something.
  - A request that brings its own tools into such a conversation is refused with 400 (H4). Elsewhere, a client's tools go to the model, and the calls come back to the client.
- **Round one** gets the stored tool definitions (ADR 0069) and, as a leading system message, a note that results are data (H7).
- **Rounds.** `toolLoop` streams every round's text as one reply (H9). After a round that ends in tool calls:
  1. the calls go through the dispatch seam one at a time;
  2. each result is stored and framed as a tool-role message;
  3. the next round runs with the model that answered round one, and only that model. Its reservation was sized for that model, and a run should not change models mid-way. A later round still gets dispatch's retries; it does not fail over to other models, a narrower reading of H9.
- **Budgets per round (H8, invariant 4).**
  - Round one reserves as any request does, fallback included.
  - Each later round reserves again, for its own prompt, against every cap, with no fallback.
  - Each round settles against only its own usage rows. Usage rows carry attempt numbers that continue across rounds under the one request id. `settle` filters by the round's first attempt.
  - The live-reservation index now covers only `pending` and `active` reservations, so one request can hold several in turn.
  - A refusal mid-loop ends the stream with the budget error in the OpenAI shape. The rounds and results so far stay in the conversation.
- **Limits (H6, TL-9)** come from `ToolLoopGuard`:
  - after 8 rounds of tool calls, or a repeated identical call, the calls left are answered as not run;
  - the model answers once more, without tools;
  - a tool set aside after failures drops out of the offered list.
- **What is stored (invariant 9):**
  - an assistant message per round, with the ids and names of the calls it made, and never their arguments;
  - a `tool` message per result, holding the result text as the tool returned it (capped at 16 KB), with its call id, tool name and whether it failed;
  - the arguments only in `tool_invocations`.
  - A continuation rebuilds the model's view from these: arguments from the audit, results framed again.
  - The audit keeps only a size for arguments over 16 KB, and the seam refuses those calls before approval. So a call waiting for approval always runs with exactly the arguments the caller saw.
- **Approvals (TL-4, AC 18, H5).**
  - A call to a tool that asks first, with no standing approval, stops the run. Nothing runs.
  - A `tool_approvals` row records the request, the principal, the call id and the tool; there is one pending row per conversation.
  - The stream ends with a finish chunk carrying `lakka.pending_approval: {id, tool, arguments}`. A non-streamed reply carries the same field at the top level. The arguments go only to the caller who made the request.
  - Calls in the same round before the stopping one have already run; calls after it wait.
- **The continuation** is a request in the same conversation with `x-lakka-approve: <id>` or `x-lakka-deny: <id>`:
  - The decision is recorded only when it comes from the principal whose request made the call, on a pending row. Anyone else, the owner's own key included, gets 404. That is AC 18: a key is a different principal from its owner.
  - The waiting calls then run: the approved one runs once; a denied one is answered "declined" and audited as `denied`. Then the loop continues from the stored history, with the client's system messages.
  - The body's other messages are ignored, since the conversation already holds the turn, and the user message is not stored again.
  - If a later call asks too, the run stops again, with no model call.
  - Any ordinary message in the conversation expires its pending approval, so a stale approval cannot be used later.
- **Standing approvals (TL-5)** live in `tool_grants`, one active row per principal and tool.
  - A person creates one by approving with `x-lakka-approve-scope: always`. A key cannot, since a standing approval is a person's decision; a key approves one call at a time.
  - The approval check reads the caller's own active grant; a key does not inherit its owner's.
  - `GET` and `DELETE /api/workspaces/:id/tool-grants[/:grantId]` list and revoke the caller's own grants (`models.use`).
  - `GET` and `DELETE /api/workspaces/:id/tools/grants[/:grantId]` list and revoke everyone's (`tools.manage`).
  - Revoking keeps the row, with who revoked it and when. Removing a tool removes its grants.
- **The wire format** stays standard apart from `pending_approval`, the one non-standard field H5 allows. Workspace tool calls are not sent to the client as `tool_calls`, because the client does not run them. They appear in the conversation history and the audit.
- **Revocation (H10):** a loop runs under the request's signal, which a revocation aborts (ADR 0063). An in-flight tool call is aborted with it. Every call opens its own MCP connection and closes it, so no session outlives the request.

## Consequences

- Every model call in a run is held and settled on its own, so spend stays under the caps however many rounds a run takes.
- A paused run needs no state beyond Postgres rows the conversation already has, plus the approval. Any API process can continue it, and a restart loses nothing.
- Earlier turns reach the model from what the client sends, which for chat is each turn's final text. Tool results from earlier runs are in the history but not replayed on a new message. A model that needs them again calls the tool again.
- A live view of tool activity while a reply streams would need another non-standard field. The core yields `tool-activity` events for that, and no surface sends them (ADR 0072).
