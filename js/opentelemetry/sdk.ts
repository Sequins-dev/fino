/**
* fino:opentelemetry/sdk - SDK wiring, exporters, resources, and propagation.
*
* This module contains the cross-signal OpenTelemetry SDK surface. Stable
* application-facing exports are SDK classes, processors, readers, exporters,
* resources, propagation helpers, and runtime instrumentation classes. The
* lower-level runtime topic helpers re-exported here are compatibility support
* for advanced integrations; prefer the task APIs documented in
* `opentelemetry/guide.md` for application code.
*
* Use this module to start telemetry collection, configure processors and
* metric readers, export records to memory or OTLP/HTTP JSON, install runtime
* instrumentations, manage resources, and propagate trace context through
* carriers.
*
* `OtelSDK.start()` is idempotent. `flush()` drains queued span and log
* processors, collects observable metrics, and exports reader batches.
* `shutdown()` flushes first, then disposes instrumentations and readers. The
* OTLP exporter defaults to `http://127.0.0.1:4318` with signal-specific
* `/v1/traces`, `/v1/logs`, and `/v1/metrics` paths.
*
* ```typescript no_run
* import { BatchSpanProcessor, InMemoryExporter, OtelSDK } from 'fino:opentelemetry/sdk';
*
* const memory = new InMemoryExporter();
* const sdk = new OtelSDK({
*   exporters: [memory],
*   spanProcessors: [new BatchSpanProcessor(memory)],
* });
* sdk.start();
* await sdk.flush();
* ```
*
* See OpenTelemetry SDK configuration:
* https://opentelemetry.io/docs/concepts/sdk-configuration/
*/
export { BatchLogRecordProcessor, BatchSpanProcessor, InMemoryExporter, LogRecordProcessor, ManualMetricReader, MetricReader, OtelSDK, PeriodicExportingMetricReader, PeriodicMetricReader, SpanProcessor, metricsSignal } from '../internal/opentelemetry/sdk.ts';
export { DnsInstrumentation, FetchInstrumentation, HttpServerInstrumentation, JobsInstrumentation, OTLPHttpJsonExporter, SocketInstrumentation, TlsInstrumentation, TraceTopicInstrumentation } from '../internal/opentelemetry/sdk.ts';
export { Baggage, BaseProvider, OTEL_SCHEMA_VERSION, OTEL_TOPIC_SUFFIXES, Propagation, Resource, TextMapPropagator, W3CTraceContextPropagator, bytesEqual, carrierApiFor, consumeRequestContext, currentActiveTelemetryContext, defaultCarrierApiFor, encodeSegment, getActiveBaggage, hexToBytes, installRequestContext, limitAttributeEntries, mergeAttributes, normalizeResource, normalizeScope, nowUnixNano, otelRuntimeEvent, otelRuntimeTopic, otelTopic, publishScoped, randomHex, registerActiveSpanContextGetter, requireNonEmptyName, requireRecord, runWithActiveContext, runWithBaggage, scopeSegment, snapshotCarrier, topic, topicNames, truncateAttributeValue } from '../internal/opentelemetry/common.ts';
export type { Attributes, CarrierApi, CarrierLike, Disposable, ExportResult, Instrumentation, OtelExporter, OtelSdkLike, PartialSuccessResult, ProviderOptions, ResourceOptions, RetryOptions, RuntimeDnsEvent, RuntimeHttpRequestEvent, RuntimeSocketEvent, RuntimeTlsEvent, ScopeInfo, SignalName } from '../internal/opentelemetry/common.ts';
