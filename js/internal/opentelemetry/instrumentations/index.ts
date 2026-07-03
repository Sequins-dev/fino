/**
* internal/opentelemetry/instrumentations/index — internal runtime module.
*
* Barrel export for all runtime OpenTelemetry instrumentation classes. The CLI
* bootstrap imports from the public OpenTelemetry facade, while this module
* keeps the internal class set grouped for documentation and direct internal
* wiring.
*
* ```js
* const instrumentations =
*   import 'internal:opentelemetry/instrumentations/index';
* console.log(typeof instrumentations.FetchInstrumentation);
* ```
*
* @internal
*/
/**
* Re-export the HTTP server runtime instrumentation.
*
* ```js
* const { HttpServerInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/index';
* console.log(typeof HttpServerInstrumentation);
* ```
*
* @internal
*/
export { HttpServerInstrumentation } from './http-server.ts';
/**
* Re-export the fetch client runtime instrumentation.
*
* ```js
* const { FetchInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/index';
* console.log(typeof FetchInstrumentation);
* ```
*
* @internal
*/
export { FetchInstrumentation } from './fetch.ts';
/**
* Re-export the trace-topic runtime instrumentation.
*
* ```js
* const { TraceTopicInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/index';
* console.log(typeof TraceTopicInstrumentation);
* ```
*
* @internal
*/
export { TraceTopicInstrumentation } from './trace-topic.ts';
/**
* Re-export the DNS runtime instrumentation.
*
* ```js
* const { DnsInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/index';
* console.log(typeof DnsInstrumentation);
* ```
*
* @internal
*/
export { DnsInstrumentation } from './dns.ts';
/**
* Re-export the socket runtime instrumentation.
*
* ```js
* const { SocketInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/index';
* console.log(typeof SocketInstrumentation);
* ```
*
* @internal
*/
export { SocketInstrumentation } from './socket.ts';
/**
* Re-export the TLS runtime instrumentation.
*
* ```js
* const { TlsInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/index';
* console.log(typeof TlsInstrumentation);
* ```
*
* @internal
*/
export { TlsInstrumentation } from './tls.ts';
/**
* Re-export the jobs runtime instrumentation.
*
* ```js
* const { JobsInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/index';
* console.log(typeof JobsInstrumentation);
* ```
*
* @internal
*/
export { JobsInstrumentation } from './jobs.ts';
