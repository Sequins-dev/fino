---
weight: 18
---
# OpenTelemetry

Fino includes a full OpenTelemetry implementation covering traces, metrics, logs, OTLP/HTTP JSON export, W3C propagation, and runtime instrumentations for HTTP servers, outgoing fetch, DNS, socket, and TLS. The subsystem is built as ordinary JS modules on top of fino's async context and topic primitives.

## Public API boundary

All application-facing imports come from the `fino:opentelemetry/*` family:

- `fino:opentelemetry/traces` — tracer providers, tracers, spans, active span context
- `fino:opentelemetry/metrics` — meter providers, instruments, observable instruments
- `fino:opentelemetry/logs` — logger providers, loggers, `LogRecordBuilder`, `SeverityNumber`
- `fino:opentelemetry/sdk` — `OtelSDK`, processors, readers, exporters, instrumentations, `Resource`, `Propagation`, `W3CTraceContextPropagator`, `Baggage`

Modules under `internal:opentelemetry/*` are implementation details. Never import from them in application code.

## How providers work

Providers publish signal records independently of any SDK. A `TracerProvider` publishes span records as spans are created and ended. A `MeterProvider` publishes observations when instruments are used. A `LoggerProvider` publishes log records on each emit. An `OtelSDK` instance is a consumer: it subscribes to those records when `start()` is called, then applies sampling, limits, and exporter fan-out.

Providers work whether or not an SDK is installed. Records published before an SDK is attached are not retroactively processed, but no errors occur.

## Guide set

The remaining guides in this directory cover specific areas in depth:

- `tracing.md` — manual span creation, active span context, nesting, and async propagation
- `metrics.md` — synchronous and observable instruments, collection timing
- `logs.md` — `LogRecordBuilder`, severity levels, trace correlation
- `sdk-setup.md` — `OtelSDK` constructor, lifecycle, processors, readers, sampling
- `exporters.md` — `OTLPHttpJsonExporter`, retry behavior, CLI bootstrap via `--otlp-endpoint`
- `propagation.md` — W3C `traceparent` and `baggage`, inject/extract, cross-process context
- `instrumentations.md` — runtime auto-instrumentation for HTTP server, fetch, DNS, socket, TLS
