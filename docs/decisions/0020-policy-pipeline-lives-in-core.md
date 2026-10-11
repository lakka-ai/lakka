# 0020. The policy pipeline lives in core; Fastify hooks are adapters

Status: accepted

## Context

The tech spec says the policy pipeline is "built as Fastify hooks so that no surface can skip a stage". `CLAUDE.md` invariant 1 says every request enters core through one entry point, and core must not import fastify.

## Decision

`CLAUDE.md` wins. The pipeline stages live in `packages/core` behind a single entry point that takes a normalized request and a Principal. Fastify hooks only do transport work, such as pulling out the credential (cookie or bearer key), and then call core. Authentication in M1 follows this pattern: the api extracts the credential and `core.authenticate` resolves the Principal.

## Consequences

- Chat, the API and MCP all call the same core function, as API-3 requires, and core can be tested without HTTP.
- "No surface can skip a stage" is enforced by core's entry point, not by Fastify's lifecycle. Reconciliation on every exit path (invariant 4) must be guaranteed inside core, for example with try/finally around dispatch, and the api must also call it on client disconnect.
