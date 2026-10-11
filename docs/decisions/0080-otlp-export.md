# 0080. OTLP export

Status: accepted

## Context

- Requirements:
  - OB-5: OTLP export, so a customer can send traces to their own backend;
  - NF-P1: no telemetry leaves the instance by default;
  - NF-P2: any optional outbound connection is off by default and switched on individually.
- Invariant 8: nothing leaves the instance unless an admin explicitly enabled that specific connection.
- ADR 0075 Q2 approved `@opentelemetry/exporter-trace-otlp-http` 0.222.0. The trace store (ADR 0076) is the default and stays.

## Decision

- **Two variables, both Lakka's own:**
  - `LAKKA_OTLP_ENDPOINT` is the full OTLP/HTTP traces URL, such as `https://collector.example.com/v1/traces`, over http or https;
  - `LAKKA_OTLP_HEADERS` holds headers for it, such as a key, as comma-separated `name=value` pairs. It can also be read from the secrets directory as `otlp_headers`, like the other secrets.
  - Setting the endpoint is the explicit act that switches export on. Unset, the exporter is not even constructed.
- **The standard `OTEL_*` variables are ignored.** A platform that injects `OTEL_EXPORTER_OTLP_ENDPOINT` into every container must not start sending a customer's traces somewhere. A test sets them, and checks that nothing is sent.
- **What is sent** is what the trace store keeps: the spans with the allowlisted attribute names only (`STORED_ATTRIBUTES`), on spans and events alike. The service is named `lakka`.
  - Captured content lives only in `span_content` and is never exported.
  - The filtering reads each span through a thin wrapper, so the span the trace store writes is unchanged.
  - The service name is set in that wrapper, not through the resources package, so no further dependency is added.
- **Batches go at their own pace,** through a second batch processor beside the Postgres one, with a 10-second timeout. A batch that fails is dropped and logged as `tracing.otlp_export_failed` with its count only. The error itself could carry the endpoint's address or what it replied.
- **It is visible.** Instance admins see on the Retention page whether traces leave the instance, and the endpoint's origin (`GET /api/observability/export`). The page says how to turn it on. Headers are never shown.
- **Compose** passes both variables to the api, empty by default. The worker makes no spans.
- The six packages the exporter brings are OpenTelemetry's own, all Apache-2.0: `exporter-trace-otlp-http`, `otlp-exporter-base`, `otlp-transformer`, `api-logs`, `sdk-logs` and `sdk-metrics`.

## Consequences

- A customer with Grafana Tempo, Jaeger, Honeycomb or any OTLP backend sees Lakka's traces there, under the GenAI conventions (ADR 0041), with no prompt text. The local trace store and its UI keep working either way.
- Changing the endpoint takes a restart of the api, as other connection settings do.
- Only OTLP over HTTP with JSON is supported. A collector speaking only gRPC needs its HTTP receiver turned on.
