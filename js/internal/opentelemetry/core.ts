/**
* internal:opentelemetry/core — aggregation hub for the runtime OpenTelemetry SDK.
*
* This module is a barrel: it re-exports every runtime-side OpenTelemetry
* primitive — shared record and event types, the trace/log/metric provider
* trees, OTLP exporters, runtime instrumentations, and the SDK lifecycle
* coordinator — under a single internal specifier. Nothing new is defined here;
* each symbol lives in a sibling file (`common.ts`, `traces.ts`, `logs.ts`,
* `metrics.ts`, `exporters.ts`, `sdk.ts`, and `instrumentations/index.ts`) and
* is surfaced through the `export * from` statements below.
*
* The bootstrap layer and the public `fino:opentelemetry` facades import from
* here rather than reaching into individual files, so the runtime has one place
* to assemble a working telemetry pipeline while the public modules stay free to
* decide which pieces application code is allowed to see. Because it is an
* `internal:*` specifier, only other built-ins may import it; application code
* uses the curated `fino:opentelemetry` surface instead.
*
* ```ts no_run
*   import { TracerProvider, OtelSDK, BatchSpanProcessor, OTLPHttpJsonExporter } from 'internal:opentelemetry/core';
*
*   const tracer = new TracerProvider().getTracer('runtime');
*   const sdk = new OtelSDK({
*     spanProcessors: [new BatchSpanProcessor(new OTLPHttpJsonExporter())],
*   });
*   sdk.start();
* ```
*
* OpenTelemetry specification: https://opentelemetry.io/docs/specs/otel/
*
* @internal
*/
/**
* Re-exports the shared record shapes, propagators, and runtime primitives.
*
* This is the foundation layer every other signal builds on: the `Resource`
* and `Baggage` types, W3C context propagation (`W3CTraceContextPropagator`,
* `TextMapPropagator`, `Propagation`), attribute helpers (`mergeAttributes`,
* `limitAttributeEntries`, `truncateAttributeValue`), active-context helpers
* (`runWithActiveContext`, `getActiveBaggage`), topic naming
* (`otelTopic`, `otelRuntimeTopic`), monotonic timing (`nowUnixNano`), and the
* wire-facing record interfaces (`SpanRecord`, `LogRecord`, `MetricRecord`,
* `ExportResult`, and friends) shared across exporters and processors.
*
* ```ts no_run
*   import { nowUnixNano, mergeAttributes, W3CTraceContextPropagator } from 'internal:opentelemetry/core';
*
*   const start = nowUnixNano();
*   const attrs = mergeAttributes({ 'http.method': 'GET' }, { 'http.route': '/users/:id' });
*   const propagator = new W3CTraceContextPropagator();
* ```
*
* @internal
*/
export * from './common.ts';
/**
* Re-exports the tracing provider tree, span API, and samplers.
*
* Includes `TracerProvider`, `Tracer`, and `Span`, the sampling contract
* (`Sampler`, `AlwaysOnSampler`), the active-span accessors
* (`getActiveSpan`, `getActiveSpanContext`, `runWithActiveSpan`), and the
* ambient-provider plumbing (`getTracerProvider`, `setTracerProvider`,
* `runWithTracerProvider`, `runWithoutTracerProvider`) that lets instrumentation
* find the current provider without threading it through every call.
*
* ```ts no_run
*   import { TracerProvider, runWithActiveSpan } from 'internal:opentelemetry/core';
*
*   const tracer = new TracerProvider().getTracer('db');
*   const span = tracer.startSpan('query');
*   await runWithActiveSpan(span, async () => {
*     // work performed inside the span's active context
*   });
*   span.end();
* ```
*
* @internal
*/
export * from './traces.ts';
/**
* Re-exports the logs provider tree and log-record builders.
*
* Surfaces `LoggerProvider`, `Logger`, `LogRecordBuilder`, the standard
* `SeverityNumber` enum, and the ambient-provider helpers
* (`getLoggerProvider`, `setLoggerProvider`, `runWithLoggerProvider`,
* `runWithoutLoggerProvider`) mirroring the tracing surface.
*
* ```ts no_run
*   import { LoggerProvider, SeverityNumber } from 'internal:opentelemetry/core';
*
*   const logger = new LoggerProvider().getLogger('app');
*   logger.emit('started', { severityNumber: SeverityNumber.INFO });
* ```
*
* @internal
*/
export * from './logs.ts';
/**
* Re-exports the metrics provider tree, instruments, and aggregation helpers.
*
* Includes `MeterProvider` and `Meter`, the synchronous instruments
* (`Counter`, `UpDownCounter`, `Gauge`, `HistogramInstrument`), their
* observable counterparts (`ObservableCounter`, `ObservableUpDownCounter`,
* `ObservableGauge`), the `Histogram` factory, and the ambient-provider helpers
* (`getMeterProvider`, `setMeterProvider`, `runWithMeterProvider`).
*
* ```ts no_run
*   import { MeterProvider } from 'internal:opentelemetry/core';
*
*   const meter = new MeterProvider().getMeter('http');
*   const requests = meter.createCounter('http.server.requests');
*   requests.add(1, { 'http.route': '/health' });
* ```
*
* @internal
*/
export * from './metrics.ts';
/**
* Re-exports the OTLP exporters used by the runtime SDK.
*
* Currently `OTLPHttpJsonExporter`, which serializes spans, logs, and metrics
* to the OTLP/HTTP JSON protocol and POSTs them to a collector endpoint.
*
* ```ts no_run
*   import { OTLPHttpJsonExporter } from 'internal:opentelemetry/core';
*
*   const exporter = new OTLPHttpJsonExporter({ endpoint: 'http://localhost:4318' });
* ```
*
* @internal
*/
export * from './exporters.ts';
/**
* Re-exports the runtime instrumentation classes.
*
* A barrel of auto-instrumentations the runtime can install to emit spans and
* metrics for built-in subsystems without application code: `HttpServerInstrumentation`,
* `FetchInstrumentation`, `TraceTopicInstrumentation`, `DnsInstrumentation`,
* `SocketInstrumentation`, `TlsInstrumentation`, and `JobsInstrumentation`.
*
* ```ts no_run
*   import { OtelSDK, HttpServerInstrumentation, FetchInstrumentation } from 'internal:opentelemetry/core';
*
*   const sdk = new OtelSDK({
*     instrumentations: [new HttpServerInstrumentation(), new FetchInstrumentation()],
*   });
*   sdk.start();
* ```
*
* @internal
*/
export * from './instrumentations/index.ts';
/**
* Re-exports the SDK coordination types and lifecycle helpers.
*
* The top-level `OtelSDK` wires providers, processors, readers, and exporters
* into a single startable/shutdownable unit. This block also surfaces the
* processor contracts (`SpanProcessor`, `BatchSpanProcessor`,
* `LogRecordProcessor`, `BatchLogRecordProcessor`), the metric readers
* (`MetricReader`, `PeriodicMetricReader`, `ManualMetricReader`,
* `PeriodicExportingMetricReader`), and the test-friendly `InMemoryExporter`.
*
* ```ts no_run
*   import { OtelSDK, BatchSpanProcessor, OTLPHttpJsonExporter } from 'internal:opentelemetry/core';
*
*   const sdk = new OtelSDK({
*     spanProcessors: [new BatchSpanProcessor(new OTLPHttpJsonExporter())],
*   });
*   sdk.start();
*   await sdk.shutdown();
* ```
*
* @internal
*/
export * from './sdk.ts';
