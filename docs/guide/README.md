# What is Lakka?

Lakka is a self-hosted AI control plane for teams of 10 to 50 people. You install it once,
bring your own model keys, and every request, from web chat, the OpenAI-compatible API or MCP, is
checked against one set of people, permissions and budgets. Spend cannot exceed a cap, every
request is attributed and traced, and a tool can never do what the person asking is not allowed
to do.

This guide is everything you need to run it. Read [Install](install.md) first; the rest is for
when you need it.

| Page                                        | For                                                                                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [A tour of Lakka](tour.md)                  | Screenshots of a demo install: routing, caps that hold, traces, spend and tools that ask first.                                                                                                                  |
| [Install](install.md)                       | From nothing to a first answer, the services that start, and serving it on a domain with HTTPS.                                                                                                                  |
| [Administration](administration.md)         | People, sign-in, workspaces, keys, providers and models, price updates, budgets and the rate limit, routing, tool servers and the sandbox, files in chat, content capture, traces, and deleting a person's data. |
| [Example routes](routing-examples.md)       | Routes to copy for code, summaries, translation, contracts, customer replies, data and brainstorming, and how to write your own.                                                                                 |
| [Adding a provider](providers.md)           | Any OpenAI-compatible service or server, such as OpenRouter or Ollama, and pricing its models so budgets stay exact.                                                                                             |
| [The API](api.md)                           | Using Lakka from scripts, the OpenAI SDKs, Open WebUI and LibreChat, the per-person rate limit, and its errors.                                                                                                  |
| [Configuration](configuration.md)           | Every setting, which of them compose reads, the rate limit and the sandbox, the secrets and key files, and the operator commands.                                                                                |
| [Operations](operations.md)                 | Health of each service, logs, the diagnostics bundle, retention, price update checks, trace export and restarts.                                                                                                 |
| [Backup and restore](backup-and-restore.md) | One command each way, and rotating the recovery key.                                                                                                                                                             |
| [Upgrade](upgrade.md)                       | Moving to a new version, and back, and what the allowlist, the sandbox and the rate limit change.                                                                                                                |
| [Troubleshooting](troubleshooting.md)       | The problems people run into, and what to do.                                                                                                                                                                    |
| [Licence and source](license.md)            | The AGPL, the source notice, and what changes if you modify it.                                                                                                                                                  |

To report a security problem, see `SECURITY.md`.

## What it is not

Lakka does not host or serve models; it controls how your people use models from the
providers you choose. It does not do retrieval over your documents, run scheduled agents, or
offer SAML, high availability or several instances in this version. It runs as one install on
one machine, with Postgres and Valkey, both included.
