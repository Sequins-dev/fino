/**
 * fino:opentelemetry - tracing, metrics, logs, and SDK helpers.
 *
 * This backward-compatible facade re-exports the public OpenTelemetry surface
 * from signal-specific modules and SDK helpers. New code can import narrower
 * surfaces from `fino:opentelemetry/traces`, `fino:opentelemetry/metrics`,
 * `fino:opentelemetry/logs`, and `fino:opentelemetry/sdk`.
 *
 * Use this facade when configuring telemetry for an application or when
 * creating manual spans, logs, or metrics. Defaults are intentionally local:
 * the SDK exporter targets OTLP/HTTP on `http://127.0.0.1:4318`, trace context
 * uses W3C `traceparent`, `tracestate`, and `baggage`, and resources default
 * to `unknown_service` until a service name is provided.
 *
 * The release baseline is Fino-native rather than strict package parity with
 * `@opentelemetry/api` or upstream SDK packages. It covers stable tracing,
 * metrics, logs, resources, propagation, in-memory export, and OTLP/HTTP JSON
 * export. OTLP protobuf, OTLP/gRPC, and full upstream semantic-convention
 * package compatibility are intentionally outside this module's baseline.
 *
 * ## Conformance matrix
 *
 * | Area | Baseline | Coverage |
 * | --- | --- | --- |
 * | Traces | Fino-native tracer/provider/span model with W3C context fields, span events, links, status, limits, and in-memory or OTLP export. | `tests/opentelemetry.test.ts` |
 * | Logs | Log records, severities, attributes, resource/scope metadata, active trace correlation, and export through SDK processors. | `tests/opentelemetry.test.ts` |
 * | Metrics | Counters, up-down counters, histograms, gauges, observable instruments, views, exemplars, and aggregation export. | `tests/opentelemetry.test.ts` |
 * | Resources | Default `unknown_service`, user attributes, merging, schema URL, and resource metadata on exported signals. | `tests/opentelemetry.test.ts` |
 * | W3C Trace Context | `traceparent` and `tracestate` inject/extract propagation for active telemetry contexts. | `tests/opentelemetry.test.ts` |
 * | W3C Baggage | Baggage item parsing, mutation, serialization, and carrier propagation. | `tests/opentelemetry.test.ts` |
 * | OTLP/HTTP JSON | JSON request shape for trace, metric, and log signal export over OTLP/HTTP. | `tests/opentelemetry-http.integration.test.ts` |
 * | Retry | Configurable retry attempts, delay, backoff, jitter, and retryable HTTP failure handling. | `tests/opentelemetry-http.integration.test.ts` |
 * | Compression | OTLP/HTTP JSON gzip request compression. | `tests/opentelemetry-http.integration.test.ts` |
 * | Partial success | OTLP partial-success responses are surfaced without treating the export as a transport failure. | `tests/opentelemetry-http.integration.test.ts` |
 * | Upstream package parity | Intentional limit: module names, constructors, semantic-convention packages, and SDK shape are Fino-native rather than a drop-in upstream package mirror. | Documented release boundary |
 * | OTLP protobuf | Intentional limit: protobuf encoding is outside the current release baseline. | Documented release boundary |
 * | OTLP/gRPC | Intentional limit: gRPC transport is outside the current release baseline. | Documented release boundary |
 *
 * ```typescript no_run
 * import { OtelSDK, InMemoryExporter, getTracerProvider } from 'fino:opentelemetry';
 *
 * const memory = new InMemoryExporter();
 * new OtelSDK({ exporters: [memory] }).start();
 * const span = getTracerProvider().getTracer('app').startSpan('work');
 * span.end();
 * ```
 *
 * See OpenTelemetry concepts:
 * https://opentelemetry.io/docs/concepts/
 */

export * from './opentelemetry/traces.ts';
export * from './opentelemetry/metrics.ts';
export * from './opentelemetry/logs.ts';
export * from './opentelemetry/sdk.ts';
