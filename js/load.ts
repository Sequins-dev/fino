/**
 * fino:load — bounded closed-loop HTTP load generation.
 *
 * Runs repeatable HTTP/1.1, HTTP/2, or HTTP/3 workloads through
 * `fino:net/http/client`. The runner separates physical connections from
 * multiplexed stream concurrency, warms the same client before measurement,
 * streams every response body, and retains only bounded histogram/counter
 * state. Use it for local throughput and latency checks where exercising the
 * Fino client stack is part of the measurement.
 *
 * ## Response lifecycle
 *
 * `consume` is the default response policy. It reads each response chunk,
 * counts its decoded bytes, and immediately drops it; complete bodies are
 * never retained. `cancel` stops after final headers. That closes the current
 * HTTP/1.1 connection or resets only the HTTP/2 or HTTP/3 stream, so results
 * always record the selected policy and never compare the two as equivalent
 * workloads.
 *
 * ## Scheduling and limits
 *
 * Phase 1 uses closed-loop scheduling: each worker starts its next request
 * only after the previous response policy completes. HTTP/1.1 has one worker
 * per connection; HTTP/2 and HTTP/3 use `connections * streams` workers.
 * Exactly one of a measured duration or request count can be selected. The
 * defaults are 10 seconds, 10 connections, one stream per connection, a
 * 30-second per-request total timeout, and a 1 MiB unread response bound.
 * Automatic/open-loop rate scheduling and scripted long-lived protocols are
 * intentionally outside this first API.
 *
 * Latencies use monotonic `performance.now()` timestamps and fixed-size
 * logarithmic histograms. Response byte counts are decoded application bytes
 * when decompression is enabled and encoded bytes when it is disabled.
 *
 * ```ts no_run
 * import { formatLoadResult, runLoad } from 'fino:load';
 *
 * const result = await runLoad({
 *   url: 'https://localhost:3000/health',
 *   protocol: 'h2',
 *   connections: 10,
 *   streams: 20,
 *   durationMs: 30_000,
 *   warmupMs: 5_000,
 * });
 * console.log(formatLoadResult(result));
 * ```
 *
 * Useful references:
 *
 * - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
 * - HTTP/2: https://www.rfc-editor.org/rfc/rfc9113
 * - HTTP/3: https://www.rfc-editor.org/rfc/rfc9114
 * - Fetch bodies: https://fetch.spec.whatwg.org/#concept-body
 */
import type { HttpClientTimeouts, HttpHeadersInit, HttpRequestInit } from './net/http/client.ts';
import { formatLoadResultText, runLoadEngine } from './internal/load.ts';

/** HTTP version pinned for every operation in one load run. */
export type LoadProtocol = 'http/1.1' | 'h2' | 'h3';

/** How each response is released after final headers arrive. */
export type LoadResponsePolicy = 'consume' | 'cancel';

/** Static, replayable request bodies accepted by the load runner. */
export type LoadBody = string | Uint8Array | ArrayBuffer;

/** TLS identity and verification options applied to every connection. */
export interface LoadTlsOptions {
  /** Certificate authority PEM file used to verify the server. */
  ca?: string;
  /** Whether peer certificate verification is required. Defaults to `true`. */
  rejectUnauthorized?: boolean;
  /** Client certificate PEM file for mutual TLS. */
  cert?: string;
  /** Client private-key PEM file for mutual TLS. */
  key?: string;
}

/**
 * Configuration for `runLoad()`.
 *
 * `url` is required. When neither `durationMs` nor `requests` is supplied, the
 * measured phase lasts 10 seconds. Supplying both throws. HTTP/1.1 requires
 * `streams: 1`; stream concurrency greater than one is meaningful only for
 * multiplexed HTTP/2 and HTTP/3 connections. H2 and H3 require `https:` URLs;
 * the current client does not offer h2c load generation.
 */
export interface LoadOptions {
  /** Absolute HTTP(S) target URL. */
  url: string | URL;
  /** HTTP version to require. Defaults to `'http/1.1'`. */
  protocol?: LoadProtocol;
  /** Request method. Defaults to `GET`. */
  method?: string;
  /** Headers applied to every request. */
  headers?: HttpHeadersInit;
  /** Static request body replayed for every operation. */
  body?: LoadBody;
  /** Physical connections maintained for the target origin. Defaults to `10`. */
  connections?: number;
  /** Concurrent streams per HTTP/2 or HTTP/3 connection. Defaults to `1`. */
  streams?: number;
  /** Measured phase duration in milliseconds. Mutually exclusive with `requests`. */
  durationMs?: number;
  /** Exact measured operation count. Mutually exclusive with `durationMs`. */
  requests?: number;
  /** Unmeasured warmup duration using the same client and connections. Defaults to `0`. */
  warmupMs?: number;
  /** Response release policy. Defaults to `'consume'`. */
  responsePolicy?: LoadResponsePolicy;
  /** Status code or codes considered successful. Defaults to the 200-399 range. */
  expectedStatus?: number | readonly number[];
  /** Request deadline policy. Total timeout defaults to 30 seconds. */
  timeouts?: HttpClientTimeouts;
  /** Maximum requests queued inside `HttpClient`. Defaults to the worker count. */
  maxPendingRequests?: number;
  /** Maximum unread bytes per multiplexed response. Defaults to 1 MiB. */
  maxBufferedResponseBytes?: number;
  /** Total replay-safe attempts per request. Defaults to `1`. */
  retryAttempts?: number;
  /** Whether to decode compressed responses before counting bytes. Defaults to `true`. */
  decompress?: boolean;
  /** Redirect behavior forwarded to `HttpClient`. Defaults to `follow`. */
  redirect?: HttpRequestInit['redirect'];
  /** TLS policy applied to every physical connection. */
  tls?: LoadTlsOptions;
  /** Optional title included in text and JSON output. */
  title?: string;
  /** Signal that stops scheduling and aborts active requests. */
  signal?: AbortSignal;
}

/** Bounded distribution summary, expressed in milliseconds. */
export interface LoadHistogramSnapshot {
  /** Number of recorded observations. */
  readonly count: number;
  /** Smallest observation, or `null` when empty. */
  readonly min: number | null;
  /** Arithmetic mean, or `null` when empty. */
  readonly mean: number | null;
  /** Population standard deviation, or `null` when empty. */
  readonly stddev: number | null;
  /** 50th percentile, or `null` when empty. */
  readonly p50: number | null;
  /** 75th percentile, or `null` when empty. */
  readonly p75: number | null;
  /** 90th percentile, or `null` when empty. */
  readonly p90: number | null;
  /** 95th percentile, or `null` when empty. */
  readonly p95: number | null;
  /** 99th percentile, or `null` when empty. */
  readonly p99: number | null;
  /** 99.9th percentile, or `null` when empty. */
  readonly p999: number | null;
  /** Largest observation, or `null` when empty. */
  readonly max: number | null;
}

/** Latency distributions captured for completed or partially completed operations. */
export interface LoadLatencySummary {
  /** Time waiting for local client capacity. */
  readonly queue: LoadHistogramSnapshot;
  /** Time from scheduling to final response headers. */
  readonly ttfb: LoadHistogramSnapshot;
  /** Time from final headers to response policy completion. */
  readonly download: LoadHistogramSnapshot;
  /** Time from scheduling to response policy completion. */
  readonly total: LoadHistogramSnapshot;
  /** DNS and new-connection time when exposed by the transport. */
  readonly connect: LoadHistogramSnapshot;
  /** TLS or QUIC secure-handshake time when exposed by the transport. */
  readonly tls: LoadHistogramSnapshot;
}

/** Outcome counters for the measured phase. */
export interface LoadCounters {
  /** Operations offered to the closed-loop scheduler. */
  readonly offered: number;
  /** Operations whose request attempt started. */
  readonly started: number;
  /** Operations that finished the selected response policy. */
  readonly completed: number;
  /** Completed operations whose final status matched the expectation. */
  readonly successful: number;
  /** Completed operations whose final status did not match the expectation. */
  readonly statusFailed: number;
  /** Operations stopped by a request timeout. */
  readonly timedOut: number;
  /** Operations stopped by the run signal or measured-phase deadline. */
  readonly cancelled: number;
  /** Operations rejected by DNS, connection, protocol, or body transport errors. */
  readonly transportFailed: number;
  /** Arrivals dropped before starting; always zero for the Phase 1 closed-loop scheduler. */
  readonly schedulerDropped: number;
  /** Responses deliberately stopped after final headers under `cancel` policy. */
  readonly headersOnly: number;
  /** Body bytes streamed and dropped under `consume` policy. */
  readonly responseBytes: number;
}

/** Non-secret TLS policy recorded with a load result. */
export interface LoadResultTlsConfig {
  /** Whether peer certificate verification was required. */
  readonly rejectUnauthorized: boolean;
  /** Whether a custom certificate-authority file was configured. */
  readonly customCa: boolean;
  /** Whether a client certificate and key were configured. */
  readonly clientCertificate: boolean;
}

/** Effective, normalized configuration recorded with a load result. */
export interface LoadResultConfig {
  /** Absolute target URL. */
  readonly url: string;
  /** Uppercase request method. */
  readonly method: string;
  /** Request header names, without potentially secret values. */
  readonly headerNames: readonly string[];
  /** Static request body size in bytes. */
  readonly requestBodyBytes: number;
  /** Required HTTP protocol. */
  readonly protocol: LoadProtocol;
  /** Physical connection count. */
  readonly connections: number;
  /** Streams per connection; always `1` for HTTP/1.1. */
  readonly streams: number;
  /** Total closed-loop worker count. */
  readonly concurrency: number;
  /** Requested measured duration, or `null` for an exact request-count run. */
  readonly durationMs: number | null;
  /** Requested operation count, or `null` for a duration run. */
  readonly requests: number | null;
  /** Unmeasured warmup duration. */
  readonly warmupMs: number;
  /** Selected response release policy. */
  readonly responsePolicy: LoadResponsePolicy;
  /** Explicit acceptable status codes, or `null` for the 200-399 default. */
  readonly expectedStatus: readonly number[] | null;
  /** Whether response content was transparently decoded. */
  readonly decompress: boolean;
  /** Maximum unread response bytes per multiplexed stream. */
  readonly maxBufferedResponseBytes: number;
  /** Maximum requests allowed to wait inside `HttpClient`. */
  readonly maxPendingRequests: number;
  /** Total replay-safe attempts allowed per operation. */
  readonly retryAttempts: number;
  /** Redirect policy applied to every request. */
  readonly redirect: NonNullable<HttpRequestInit['redirect']>;
  /** Non-secret TLS identity and verification summary. */
  readonly tls: LoadResultTlsConfig;
  /** Per-request deadline policy after defaults were applied. */
  readonly timeouts: Readonly<HttpClientTimeouts>;
}

/** Physical-connection observations from measured responses. */
export interface LoadConnectionSummary {
  /** Distinct physical connection IDs observed. */
  readonly unique: number;
  /** Responses marked as reusing an established connection. */
  readonly reusedResponses: number;
  /** Connections beyond the configured initial slot count. */
  readonly reconnects: number;
  /** Highest number of simultaneously active operations. */
  readonly maxActiveOperations: number;
}

/** Versioned, JSON-safe output returned by `runLoad()`. */
export interface LoadResult {
  /** Result schema version. Currently `1`. */
  readonly schemaVersion: 1;
  /** Optional user-supplied run title. */
  readonly title: string | null;
  /** Wall-clock ISO timestamp at the beginning of measurement. */
  readonly startedAt: string;
  /** Actual measured elapsed time, including cancellation/drain settlement. */
  readonly durationMs: number;
  /** Effective run configuration. */
  readonly config: LoadResultConfig;
  /** Measured operation and byte counters. */
  readonly counters: LoadCounters;
  /** Completed operations per second. */
  readonly requestsPerSecond: number;
  /** Consumed response body bytes per second. */
  readonly bytesPerSecond: number;
  /** Final HTTP status distribution keyed by decimal status. */
  readonly statusCodes: Readonly<Record<string, number>>;
  /** Negotiated protocol distribution. */
  readonly protocols: Readonly<Record<string, number>>;
  /** Bounded error-class distribution. */
  readonly errors: Readonly<Record<string, number>>;
  /** Physical connection observations. */
  readonly connections: LoadConnectionSummary;
  /** Bounded latency distributions in milliseconds. */
  readonly latency: LoadLatencySummary;
}

/**
 * Run one bounded closed-loop HTTP load test.
 *
 * The promise resolves after warmup, measurement, active-request settlement,
 * and client shutdown. Configuration errors throw before network work begins.
 * Transport errors are counted in the returned result rather than rejecting
 * the whole run. If `signal` aborts, scheduling stops and the partial measured
 * result is returned after active requests settle.
 */
export function runLoad(options: LoadOptions): Promise<LoadResult> {
  return runLoadEngine(options);
}

/** Render a stable human-readable summary for a completed load result. */
export function formatLoadResult(result: LoadResult): string {
  return formatLoadResultText(result);
}
