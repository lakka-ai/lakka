# 0008. Published port and TLS for docker compose

Status: accepted

## Context

NF-S6 requires session and key material to travel only over TLS in any documented deployment. First run should need no certificate setup, and a browser warning on first open is a poor start.

## Decision

- Caddy is published on `127.0.0.1:8080` over plain HTTP by default, with site address `:80`. HTTPS publishes on `127.0.0.1:8443`.
- Setting `LAKKA_DOMAIN` in a `.env` file next to the root `compose.yaml` makes the site address that hostname. Caddy then gets a certificate and serves HTTPS.
- Bind addresses and ports are set through `LAKKA_HTTP_BIND`, `LAKKA_HTTP_PORT`, `LAKKA_HTTPS_BIND` and `LAKKA_HTTPS_PORT`, so the compose file is never edited.
- The Caddy admin API is off.

## Consequences

- The default install can only be reached from the machine it runs on, so cleartext never crosses a network. Exposing it requires a domain, and a domain gets TLS.
- Setting a domain turns on outbound ACME traffic to the certificate authority. That is the explicit opt-in NF-P2 requires.
- Access from other machines without a public domain (LAN only) needs a documented `tls internal` option later.
