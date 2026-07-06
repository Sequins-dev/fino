/**
* internal/opentelemetry/instrumentations/index — internal runtime module.
*
* Barrel export gathering every runtime OpenTelemetry instrumentation class in
* one place. Each instrumentation subscribes to the runtime's internal topic
* bus, converts a subsystem's lifecycle events (HTTP server requests, fetch
* calls, DNS lookups, socket connects, TLS handshakes, user trace topics, and
* `fino:jobs` executions) into spans, and feeds them to an SDK-like object. The
* CLI bootstrap enables the full set from the public OpenTelemetry facade; this
* module keeps the class set grouped for documentation and for direct internal
* wiring that needs to select individual instrumentations.
*
* Every class here shares the same shape: construct it, then call `enable(sdk)`
* to attach its topic subscriptions and receive a `Disposable` that tears them
* down again. Spans are only recorded while the SDK's tracer provider context is
* enabled, so enabling an instrumentation with tracing off is inert until a
* provider is installed. Nothing is registered globally, so the same class can
* be enabled independently against different SDK instances.
*
* ```ts no_run
* import {
*   HttpServerInstrumentation,
*   FetchInstrumentation,
*   JobsInstrumentation,
* } from 'internal:opentelemetry/instrumentations/index';
*
* const disposables = [
*   new HttpServerInstrumentation(),
*   new FetchInstrumentation(),
*   new JobsInstrumentation(),
* ].map((instrumentation) => instrumentation.enable(sdk));
*
* // Later, during shutdown, detach every subscription.
* for (const disposable of disposables) disposable.dispose();
* ```
*
* @internal
*/
/**
* Runtime HTTP server instrumentation: turns incoming request lifecycle topic
* events into server spans and installs request trace context for the handler.
*
* Extract the incoming propagation context from request headers and produce a
* span per request. See `internal:opentelemetry/instrumentations/http-server`
* for the full behavior.
*
* ```ts no_run
* import { HttpServerInstrumentation } from 'internal:opentelemetry/instrumentations/index';
*
* const disposable = new HttpServerInstrumentation().enable(sdk);
* disposable.dispose();
* ```
*
* @internal
*/
export { HttpServerInstrumentation } from './http-server.ts';
/**
* Runtime fetch client instrumentation: turns outgoing fetch request lifecycle
* topic events into client spans and injects propagation headers into the
* request carrier.
*
* Allocates a trace/span id at request start, injects propagation headers
* through the SDK propagator, and records the span on finish. See
* `internal:opentelemetry/instrumentations/fetch` for the full behavior.
*
* ```ts no_run
* import { FetchInstrumentation } from 'internal:opentelemetry/instrumentations/index';
*
* const disposable = new FetchInstrumentation().enable(sdk);
* disposable.dispose();
* ```
*
* @internal
*/
export { FetchInstrumentation } from './fetch.ts';
/**
* Runtime trace-topic instrumentation: bridges user-facing scoped trace topic
* events into OpenTelemetry span records.
*
* Subscribes to all scoped trace topics so user code can start spans, mutate
* attributes, append events and links, update status, rename operations, and
* end spans. Active spans are evicted after five minutes to bound memory if an
* end event never arrives. See
* `internal:opentelemetry/instrumentations/trace-topic` for the full behavior.
*
* ```ts no_run
* import { TraceTopicInstrumentation } from 'internal:opentelemetry/instrumentations/index';
*
* const disposable = new TraceTopicInstrumentation().enable(sdk);
* disposable.dispose();
* ```
*
* @internal
*/
export { TraceTopicInstrumentation } from './trace-topic.ts';
/**
* Runtime DNS lookup instrumentation: turns DNS lookup lifecycle topic events
* into client spans.
*
* Tracks active lookups by lookup id from `dns.lookup.start` until the matching
* end or error event, recording spans only while tracer context is enabled. See
* `internal:opentelemetry/instrumentations/dns` for the full behavior.
*
* ```ts no_run
* import { DnsInstrumentation } from 'internal:opentelemetry/instrumentations/index';
*
* const disposable = new DnsInstrumentation().enable(sdk);
* disposable.dispose();
* ```
*
* @internal
*/
export { DnsInstrumentation } from './dns.ts';
/**
* Runtime socket connect instrumentation: turns socket connect lifecycle topic
* events into client spans.
*
* Tracks active connections by connect id across `socket.connect.start`,
* `socket.connect.end`, and `socket.connect.error`, recording spans only while
* tracer context is enabled. See
* `internal:opentelemetry/instrumentations/socket` for the full behavior.
*
* ```ts no_run
* import { SocketInstrumentation } from 'internal:opentelemetry/instrumentations/index';
*
* const disposable = new SocketInstrumentation().enable(sdk);
* disposable.dispose();
* ```
*
* @internal
*/
export { SocketInstrumentation } from './socket.ts';
/**
* Runtime TLS handshake instrumentation: turns TLS handshake lifecycle topic
* events into client spans.
*
* Tracks active handshakes by handshake id across `tls.handshake.start`,
* `tls.handshake.end`, and `tls.handshake.error`, recording spans only while
* tracer context is enabled. See `internal:opentelemetry/instrumentations/tls`
* for the full behavior.
*
* ```ts no_run
* import { TlsInstrumentation } from 'internal:opentelemetry/instrumentations/index';
*
* const disposable = new TlsInstrumentation().enable(sdk);
* disposable.dispose();
* ```
*
* @internal
*/
export { TlsInstrumentation } from './tls.ts';
/**
* Runtime jobs instrumentation: turns `fino:jobs` job lifecycle topic events
* into spans.
*
* Tracks active job executions by job id from `jobs.job.start` until the
* matching `jobs.job.end`, whose status distinguishes completions, parks, and
* failures. See `internal:opentelemetry/instrumentations/jobs` for the full
* behavior.
*
* ```ts no_run
* import { JobsInstrumentation } from 'internal:opentelemetry/instrumentations/index';
*
* const disposable = new JobsInstrumentation().enable(sdk);
* disposable.dispose();
* ```
*
* @internal
*/
export { JobsInstrumentation } from './jobs.ts';
