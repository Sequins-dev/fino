/**
 * internal/opentelemetry/core — internal runtime module.
 *
 * Re-export hub for internal OpenTelemetry primitives, SDK pieces, exporters,
 * and runtime instrumentations. This module keeps the runtime-side
 * implementation available under one internal specifier while public modules
 * decide what to expose to application code.
 *
 * ```js
 * import * as otel from 'internal:opentelemetry/core';
 * console.log(typeof otel.TracerProvider);
 * ```
 *
 * @internal
 */

/**
 * Re-export shared OpenTelemetry record and runtime event types.
 *
 * ```js
 * import * as core from 'internal:opentelemetry/core';
 * console.log(typeof core.nowUnixNano);
 * ```
 *
 * @internal
 */
export * from './common.mts';
/**
 * Re-export trace providers, context helpers, and span APIs.
 *
 * ```js
 * import * as core from 'internal:opentelemetry/core';
 * console.log(typeof core.TracerProvider);
 * ```
 *
 * @internal
 */
export * from './traces.mts';
/**
 * Re-export log providers and log record helpers.
 *
 * ```js
 * import * as core from 'internal:opentelemetry/core';
 * console.log(typeof core.LoggerProvider);
 * ```
 *
 * @internal
 */
export * from './logs.mts';
/**
 * Re-export metric providers, readers, and instrument helpers.
 *
 * ```js
 * import * as core from 'internal:opentelemetry/core';
 * console.log(typeof core.MeterProvider);
 * ```
 *
 * @internal
 */
export * from './metrics.mts';
/**
 * Re-export OTLP exporters used by the runtime SDK.
 *
 * ```js
 * import * as core from 'internal:opentelemetry/core';
 * console.log(typeof core.OTLPHttpJsonExporter);
 * ```
 *
 * @internal
 */
export * from './exporters.mts';
/**
 * Re-export runtime instrumentation classes.
 *
 * ```js
 * import * as core from 'internal:opentelemetry/core';
 * console.log(typeof core.FetchInstrumentation);
 * ```
 *
 * @internal
 */
export * from './instrumentations/index.mts';
/**
 * Re-export SDK coordination types and lifecycle helpers.
 *
 * ```js
 * import * as core from 'internal:opentelemetry/core';
 * console.log(typeof core.OtelSDK);
 * ```
 *
 * @internal
 */
export * from './sdk.mts';
