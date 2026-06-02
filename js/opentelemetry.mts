/**
 * fino:opentelemetry - tracing, metrics, logs, and SDK helpers.
 *
 * This module re-exports the public OpenTelemetry surface used by runtime
 * instrumentation and application code. It includes context propagation,
 * span/log/metric model types, exporters, and SDK wiring helpers.
 *
 * Use this facade when configuring telemetry for an application or when
 * creating manual spans, logs, or metrics. Defaults are intentionally local:
 * the SDK exporter targets OTLP/HTTP on `http://127.0.0.1:4318`, trace context
 * uses W3C `traceparent`, and resources default to `unknown_service` until a
 * service name is provided.
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

export * from './internal/opentelemetry/common.mts';
export * from './internal/opentelemetry/traces.mts';
export * from './internal/opentelemetry/logs.mts';
export * from './internal/opentelemetry/metrics.mts';
export * from './internal/opentelemetry/sdk.mts';
