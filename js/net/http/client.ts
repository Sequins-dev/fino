/**
 * fino:net/http/client — reusable HTTP clients and logical sessions.
 *
 * This module provides a lower-level client API for code that needs more
 * control and observability than global `fetch()`. `HttpClient` owns reusable
 * policy such as a base URL, default headers, protocol preferences, and logical
 * sessions. `HttpSession` represents an origin-scoped relationship that can
 * survive transport replacement. `HttpResponse` wraps a Fetch-compatible
 * `Response` with request, session, connection, protocol, trailer, and timing
 * metadata.
 *
 * The first implementation intentionally layers on Fino's existing fetch,
 * EventSource, and WebSocket transports. That preserves current redirect,
 * abort, decompression, integrity, referrer, TLS, and HTTP/2 pool behavior
 * while establishing the public client/session surface. Sessions own bounded
 * physical transport slots: HTTP/1.1 leases one request at a time and reuses a
 * slot after response EOF, while HTTP/2 and HTTP/3 multiplex bounded streams.
 * HTTP/2 and HTTP/3 WebSocket attempts reject with a clear Extended CONNECT
 * error until those transports support it.
 *
 * ```ts no_run
 * import { HttpClient } from 'fino:net/http/client';
 *
 * const client = new HttpClient({
 *   baseUrl: 'https://api.example.com',
 *   headers: { authorization: 'Bearer token' },
 * });
 *
 * const response = await client.request('/users');
 * console.log(response.status, response.protocol, await response.json());
 *
 * const fetchResponse = await client.fetch('/users');
 * const events = client.sse('/events');
 * const socket = await client.websocket('/chat', { protocols: ['chat.v1'] });
 * ```
 *
 * Learn more:
 * - Fetch: https://fetch.spec.whatwg.org/
 * - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
 * - Server-Sent Events: https://html.spec.whatwg.org/multipage/server-sent-events.html
 * - WebSocket: https://www.rfc-editor.org/rfc/rfc6455
 */
import { Headers, Request, Response, buildWireResponse } from './index.ts';
import {
  fetch as runtimeFetch,
  _closeFetchPoolSlot,
  _getFetchResponseMetadata,
} from '../../globals/fetch.ts';
import { EventSource } from '../../globals/eventsource.ts';
import type { EventSourceInit } from '../../globals/eventsource.ts';
import { WebSocketConnection } from './websocket.ts';
import type { WebSocketConnectOptions } from './websocket.ts';
import { WebTransport } from './webtransport.ts';
import type { WebTransportOptions } from './webtransport.ts';
import type { H3FetchInit } from './h3.ts';
import { QuicEndpoint } from '../quic/index.ts';
import type { QuicConnection } from '../quic/index.ts';
import { H3ClientSession } from '../../internal/net/http/h3/client.ts';
import { resolveH3ConnectAddress } from '../../internal/net/http/h3/resolve.ts';
/**
 * Application-level protocol a client or session may speak.
 *
 * `'http/1.1'` uses persistent, non-pipelined connections and is the default.
 * `'h2'` multiplexes over persistent HTTP/2 slots. `'h3'` multiplexes over
 * persistent QUIC transports until `reconnect()` or `close()`.
 * The value pins how a session behaves; the actual protocol a given response was
 * served on is reported separately by `HttpResponse.protocol`, which may differ
 * if the peer negotiated down.
 *
 * ```ts no_run
 * import type { HttpClientProtocol } from 'fino:net/http/client';
 *
 * const preferred: readonly HttpClientProtocol[] = ['h3', 'h2', 'http/1.1'];
 * ```
 */
export type HttpClientProtocol = 'http/1.1' | 'h2' | 'h3';
/**
 * Physical transport carrying a connection, reported by `HttpConnectionInfo`.
 *
 * `'tcp'` is cleartext HTTP/1.1, `'tls'` is HTTP/1.1 or HTTP/2 over TLS, and
 * `'quic'` is HTTP/3 over a QUIC datagram flow. The transport is derived from
 * the negotiated protocol and the request URL scheme, not chosen directly.
 */
export type HttpClientTransport = 'tcp' | 'tls' | 'quic';
/**
 * Header collection accepted anywhere the client takes headers.
 *
 * Any form the `Headers` constructor understands is allowed: an existing
 * `Headers` instance, an array of `[name, value]` pairs, or a plain object.
 * `null` and `undefined` mean "no headers" so callers can pass an optional
 * value straight through without branching.
 *
 * ```ts no_run
 * import type { HttpHeadersInit } from 'fino:net/http/client';
 *
 * const a: HttpHeadersInit = { authorization: 'Bearer t0ken' };
 * const b: HttpHeadersInit = [['accept', 'application/json']];
 * const c: HttpHeadersInit = new Headers({ 'x-trace': 'abc' });
 * ```
 */
export type HttpHeadersInit = Headers | string[][] | Record<string, string> | null | undefined;
/** Per-phase request deadlines in milliseconds. */
export interface HttpClientTimeouts {
  /** Maximum DNS plus new-connection setup time; ignored for reused connections. */
  connect?: number;
  /** Maximum time spent waiting for scheduler capacity and final headers. */
  headers?: number;
  /** Maximum idle gap between response-body chunks. */
  bodyIdle?: number;
  /** Maximum time from scheduling until the response body is released. */
  total?: number;
}
/** Safe automatic retry policy applied above the selected HTTP transport. */
export interface HttpClientRetryOptions {
  /** Total attempts, including the initial send. Defaults to `1`. */
  attempts?: number;
}
interface MinimalAbortSignal {
  aborted: boolean;
  reason: unknown;
  addEventListener(
    type: string,
    fn: () => void,
    opts?: {
      once?: boolean;
    },
  ): void;
  removeEventListener(type: string, fn: () => void): void;
}
function _quicCaFromTls(ca: string | undefined): { file: string } | undefined {
  return ca === undefined ? undefined : { file: ca };
}
/**
 * Configuration for `new HttpClient()`.
 *
 * Every field is optional; an empty object yields an HTTP/1.1 client with no
 * base URL and no default headers, so requests must pass absolute URLs. The
 * base URL resolves relative paths for `request()`, `sse()`, `websocket()`, and
 * `webtransport()`. Default headers are merged into every request and can be
 * overridden per call. `protocols` lists preferences in priority order.
 * Connection/stream/queue limits bound local capacity, while response
 * buffering, deadlines, retries, and decoding are reusable client policies.
 * `tls` is forwarded to the underlying transports.
 *
 * ```ts no_run
 * import { HttpClient } from 'fino:net/http/client';
 *
 * const client = new HttpClient({
 *   baseUrl: 'https://api.example.com/v1',
 *   headers: { authorization: 'Bearer t0ken', accept: 'application/json' },
 *   protocols: ['h2', 'http/1.1'],
 *   tls: { rejectUnauthorized: true },
 * });
 * ```
 */
export interface HttpClientOptions {
  /** Maximum physical connections maintained per origin. Defaults to `1`. */
  connections?: number;
  /** Maximum active H2/H3 streams per physical connection. Defaults to `100`. */
  maxConcurrentStreams?: number;
  /** Maximum requests waiting for local capacity. Defaults to `1024`. */
  maxPendingRequests?: number;
  /** Maximum unread response bytes buffered per H2/H3 stream. Defaults to 16 MiB. */
  maxBufferedResponseBytes?: number;
  /** Default request deadlines. */
  timeouts?: HttpClientTimeouts;
  /** Safe transport retry policy. */
  retry?: HttpClientRetryOptions;
  /** Whether response content is transparently decoded. Defaults to `true`. */
  decompress?: boolean;
  /**
   * Base URL used to resolve relative request, SSE, WebSocket, and
   * WebTransport paths.
   *
   * When omitted, calls that take paths must use absolute URLs.
   */
  baseUrl?: string | URL;
  /**
   * Headers applied to every request unless overridden.
   *
   * Per-request headers are merged on top with the same names replacing these
   * defaults.
   */
  headers?: HttpHeadersInit;
  /**
   * Preferred protocols, in priority order.
   *
   * The first entry is used for `request()` and for sessions that do not pass an
   * explicit protocol. Defaults to `['http/1.1']`.
   */
  protocols?: readonly HttpClientProtocol[];
  /**
   * TLS options forwarded to the underlying fetch, EventSource, and QUIC
   * transports.
   */
  tls?: {
    /**
     * Certificate authority file used to verify peers.
     */
    ca?: string;
    /**
     * Set to `false` to skip peer certificate verification.
     */
    rejectUnauthorized?: boolean;
    /**
     * Client certificate file for mutual TLS.
     */
    cert?: string;
    /**
     * Client private key file for mutual TLS.
     */
    key?: string;
  };
}
/**
 * Per-request overrides for `HttpClient.request()` and the underlying send.
 *
 * These mirror the familiar Fetch options — `method`, `headers`, `body`,
 * `signal`, `redirect`, `integrity`, and the referrer controls — and add
 * trailers, deadline/retry/decoding policy, plus transport-specific `tls` and
 * `quic` overrides. Headers merge on top of the client's defaults.
 *
 * ```ts no_run
 * import { HttpClient } from 'fino:net/http/client';
 *
 * const client = new HttpClient({ baseUrl: 'https://api.example.com' });
 * const controller = new AbortController();
 * const res = await client.request('/users', {
 *   method: 'POST',
 *   headers: { 'content-type': 'application/json' },
 *   body: JSON.stringify({ name: 'Ada' }),
 *   signal: controller.signal,
 *   redirect: 'error',
 * });
 * ```
 */
export interface HttpRequestInit {
  /** Per-request deadline overrides. */
  timeouts?: HttpClientTimeouts;
  /** Per-request safe retry override. */
  retry?: HttpClientRetryOptions;
  /** Override transparent content decoding for this request. */
  decompress?: boolean;
  /**
   * HTTP method to send. Defaults to `GET`.
   */
  method?: string;
  /**
   * Headers merged on top of the client's defaults for this request.
   */
  headers?: HttpHeadersInit;
  /**
   * Request body forwarded to the selected transport.
   *
   * Streaming bodies are treated as non-replayable in `HttpRequestInfo`.
   */
  body?: unknown;
  /**
   * Abort signal observed by the underlying transport.
   */
  signal?: MinimalAbortSignal | null;
  /**
   * Redirect mode forwarded to fetch-backed transports.
   */
  redirect?: 'follow' | 'error' | 'manual';
  /**
   * Subresource integrity metadata forwarded to fetch-backed transports.
   */
  integrity?: string;
  /**
   * Referrer policy forwarded to fetch-backed transports.
   */
  referrerPolicy?:
    | 'no-referrer'
    | 'no-referrer-when-downgrade'
    | 'origin'
    | 'origin-when-cross-origin'
    | 'same-origin'
    | 'strict-origin'
    | 'strict-origin-when-cross-origin'
    | 'unsafe-url'
    | '';
  /**
   * Referrer value forwarded to fetch-backed transports.
   */
  referrer?: string;
  /**
   * Trailer headers, or a function producing trailer headers after the body.
   */
  trailers?: Headers | (() => Headers | Promise<Headers>);
  /**
   * TLS overrides for this request.
   */
  tls?: HttpClientOptions['tls'];
  /**
   * QUIC overrides for HTTP/3 requests.
   */
  quic?: H3FetchInit['quic'];
}
/**
 * Request descriptor accepted by `HttpSession.request()`.
 *
 * Extends `HttpRequestInit` with the target location, since a session already
 * knows its origin. Supply `url` (absolute or relative) or `path` (relative to
 * the session origin); `url` wins if both are present, and when neither is
 * given the request targets `/`.
 *
 * ```ts no_run
 * import { HttpClient } from 'fino:net/http/client';
 *
 * const client = new HttpClient();
 * const session = await client.session('https://api.example.com');
 * const res = await session.request({ path: '/users/42', method: 'GET' });
 * ```
 */
export interface HttpSessionRequest extends HttpRequestInit {
  /**
   * Path or URL resolved against the session origin.
   *
   * Ignored when `url` is also provided.
   */
  path?: string | URL;
  /**
   * Absolute or relative URL to request.
   *
   * Wins over `path`; defaults to `/` when both are omitted.
   */
  url?: string | URL;
}
/**
 * Options for `HttpClient.session()`.
 *
 * `protocol` pins the returned session to a single protocol; when omitted the
 * session adopts the client's first configured protocol. Sessions are cached
 * per `protocol:origin`, so requesting the same origin with a different
 * protocol yields a distinct session.
 *
 * ```ts no_run
 * import { HttpClient } from 'fino:net/http/client';
 *
 * const client = new HttpClient({ protocols: ['h3'] });
 * const session = await client.session('https://api.example.com', { protocol: 'h3' });
 * ```
 */
export interface HttpSessionOptions {
  /**
   * Pin the session to one protocol.
   *
   * Defaults to the client's first configured protocol.
   */
  protocol?: HttpClientProtocol;
}
/**
 * Options for `HttpSession.reconnect()`.
 *
 * `reason` is an opaque value recorded on the emitted `reconnecting` lifecycle
 * event so observers can attribute the transport replacement (for example, a
 * caught error or a rotation signal).
 *
 * ```ts no_run
 * await session.reconnect({ reason: 'idle timeout' });
 * ```
 */
export interface ReconnectOptions {
  /**
   * Opaque reason attached to the `reconnecting` lifecycle event.
   */
  reason?: unknown;
}
/**
 * Options for `HttpClient.close()` and `HttpSession.close()`.
 *
 * `reason` is an opaque value attached to the emitted `closed` lifecycle event,
 * useful for logging why a session was torn down.
 *
 * ```ts no_run
 * await session.close({ reason: 'shutdown' });
 * ```
 */
export interface CloseOptions {
  /**
   * Opaque reason attached to the `closed` lifecycle event.
   */
  reason?: unknown;
}
/**
 * Snapshot of the request that produced an `HttpResponse`.
 *
 * `method` and `url` are the final, normalized values actually sent. `headers`
 * is the merged header set after client defaults and per-request overrides.
 * `idempotent` reflects whether the method is safe to retry per HTTP semantics
 * (GET, HEAD, OPTIONS, TRACE, PUT, DELETE). `replayable` is `true` only when
 * the body can be re-sent — it is `false` for streaming bodies such as
 * `ReadableStream` or async iterables, which are consumed once. `attempt` is
 * the 1-based try count.
 *
 * ```ts no_run
 * const res = await client.request('/users');
 * if (res.request.idempotent && res.request.replayable) {
 *   // safe to retry this request
 * }
 * ```
 */
export interface HttpRequestInfo {
  /**
   * Final uppercase HTTP method sent on the wire.
   */
  readonly method: string;
  /**
   * Final absolute request URL.
   */
  readonly url: string;
  /**
   * Merged request headers after client defaults and per-call overrides.
   */
  readonly headers: Headers;
  /**
   * Whether the method is considered idempotent for retry decisions.
   */
  readonly idempotent: boolean;
  /**
   * Whether the request body can be sent again.
   */
  readonly replayable: boolean;
  /**
   * One-based attempt number for this send.
   */
  readonly attempt: number;
}
/**
 * Metadata about the transport connection a response was served on.
 *
 * `id` is assigned when a physical connection is created and remains stable
 * across reuse, distinct from the logical `HttpSession.id`. `protocol` and
 * `transport` describe what was negotiated. `connectedAt` and response timing
 * values use the monotonic high-resolution clock.
 *
 * ```ts no_run
 * const res = await client.request('/users');
 * const conn = res.connection;
 * if (conn !== null) {
 *   console.log(conn.protocol, conn.transport, conn.alpnProtocol);
 * }
 * ```
 */
export interface HttpConnectionInfo {
  /**
   * Synthetic per-process connection id.
   */
  readonly id: string;
  /**
   * Negotiated application protocol for this connection.
   */
  readonly protocol: HttpClientProtocol;
  /**
   * Physical transport used by the connection.
   */
  readonly transport: HttpClientTransport;
  /**
   * Local address when the transport exposes one, otherwise `null`.
   */
  readonly localAddress: unknown | null;
  /**
   * Remote address when the transport exposes one, otherwise `null`.
   */
  readonly remoteAddress: unknown | null;
  /**
   * Negotiated ALPN protocol when available.
   */
  readonly alpnProtocol: string | null;
  /**
   * Millisecond timestamp recorded when the connection metadata was created.
   */
  readonly connectedAt: number;
  /** Whether this request reused a connection that had carried an earlier request. */
  readonly reused: boolean;
  /** Multiplexed protocol stream id, or `null` for HTTP/1.1. */
  readonly streamId: number | bigint | null;
}
/**
 * Monotonic timing marks captured while scheduling and reading a request.
 *
 * Values are `performance.now()` milliseconds. Queue entry/acquisition, final
 * headers, first delivered body byte, and body release are recorded without
 * retaining per-chunk measurements.
 *
 * ```ts no_run
 * const res = await client.request('/users');
 * const body = await res.text();
 * const total = (res.timing.bodyEnd ?? performance.now()) - res.timing.scheduledTime;
 * console.log(`request took ${total}ms`);
 * ```
 */
export interface HttpResponseTiming {
  /** Monotonic timestamp at which the request entered the local scheduler. */
  readonly scheduledTime: number;
  /**
   * Millisecond timestamp taken immediately before the request is sent.
   */
  readonly startTime: number;
  /** Time local capacity was acquired; queue delay is this minus `scheduledTime`. */
  readonly queueEnd: number;
  /** DNS lookup start, or `null` for reused/opaque transports. */
  readonly dnsStart: number | null;
  /** DNS lookup completion, or `null` for reused/opaque transports. */
  readonly dnsEnd: number | null;
  /** TCP or QUIC connection attempt start, or `null` when unavailable. */
  readonly connectStart: number | null;
  /** TCP or QUIC connection ready, or `null` when unavailable or reused. */
  readonly connectEnd: number | null;
  /** TLS or QUIC secure-handshake start, or `null` when unavailable. */
  readonly secureConnectStart: number | null;
  /** TLS or QUIC secure-handshake completion, or `null` when unavailable. */
  readonly secureConnectEnd: number | null;
  /** Request header flush completion, or `null` when the transport cannot expose it. */
  readonly requestHeadersEnd: number | null;
  /** Request body flush completion, or `null` for streaming/opaque uploads. */
  readonly requestBodyEnd: number | null;
  /**
   * Millisecond timestamp taken after response status and headers arrive.
   */
  readonly responseHeadersEnd?: number;
  /** Timestamp at which the first response body chunk was delivered. */
  readonly firstResponseByte?: number;
  /**
   * Millisecond timestamp set when the body is consumed or closed.
   */
  readonly bodyEnd?: number;
}
/**
 * Discriminated lifecycle event emitted by a logical HTTP session.
 *
 * A session records these as it moves through its life: `connecting` and
 * `connected` (carrying the new `HttpConnectionInfo`) around establishing a
 * transport, `reconnecting` and `reconnected` around a transport replacement,
 * and `closed` on teardown. Fetch-backed HTTP/1.1 and HTTP/2 paths report the
 * physical transport selected for each response; HTTP/3 emits `connected` when
 * a QUIC slot comes up. Consume the stream via
 * `HttpSession.events` and switch on `type`.
 *
 * ```ts no_run
 * for await (const event of session.events) {
 *   switch (event.type) {
 *     case 'connected':
 *       console.log('up on', event.connection.protocol);
 *       break;
 *     case 'closed':
 *       console.log('down:', event.reason);
 *       break;
 *   }
 * }
 * ```
 */
export type HttpSessionEvent =
  | {
      /**
       * A transport connection attempt is starting.
       */
      type: 'connecting';
      /**
       * Logical session that emitted the event.
       */
      session: HttpSession;
    }
  | {
      /**
       * A transport connection is available.
       */
      type: 'connected';
      /**
       * Logical session that emitted the event.
       */
      session: HttpSession;
      /**
       * Connection metadata for the active or just-used transport.
       */
      connection: HttpConnectionInfo;
    }
  | {
      /**
       * The session is about to replace its transport.
       */
      type: 'reconnecting';
      /**
       * Logical session that emitted the event.
       */
      session: HttpSession;
      /**
       * Opaque reason passed to `reconnect()`.
       */
      reason: unknown;
    }
  | {
      /**
       * A replacement transport is available.
       */
      type: 'reconnected';
      /**
       * Logical session that emitted the event.
       */
      session: HttpSession;
      /**
       * Connection metadata for the replacement transport.
       */
      connection: HttpConnectionInfo;
    }
  | {
      /**
       * The session has been closed.
       */
      type: 'closed';
      /**
       * Logical session that emitted the event.
       */
      session: HttpSession;
      /**
       * Opaque reason passed to `close()`, when any.
       */
      reason?: unknown;
    };
/**
 * Options for `HttpClient.sse()` and `HttpSession.sse()`.
 *
 * Extends the standard `EventSourceInit` with a `headers` field so the stream
 * inherits and can extend the client's default headers (for example, an
 * authorization token). TLS falls back to the client's configuration when not
 * set on the options.
 *
 * ```ts no_run
 * const events = client.sse('/events', {
 *   headers: { 'last-event-id': '42' },
 *   withCredentials: true,
 * });
 * events.addEventListener('message', (e) => console.log(e.data));
 * ```
 */
export interface SseOptions extends EventSourceInit {
  /**
   * Headers merged with client or session defaults for the stream request.
   */
  headers?: HttpHeadersInit;
}
/**
 * Options for `HttpClient.websocket()` and `HttpSession.websocket()`.
 *
 * Extends the transport's `WebSocketConnectOptions` (subprotocols, and so on)
 * with extra `headers` merged into the upgrade request. WebSocket is only
 * available over HTTP/1.1; attempting it on an `h2` or `h3` session rejects,
 * because Extended CONNECT is not yet supported.
 *
 * ```ts no_run
 * const socket = await client.websocket('/chat', {
 *   protocols: ['chat.v1'],
 *   headers: { authorization: 'Bearer t0ken' },
 * });
 * socket.send('hello');
 * ```
 */
export interface HttpWebSocketOptions extends WebSocketConnectOptions {
  /**
   * Headers merged with client or session defaults for the WebSocket upgrade.
   */
  headers?: Record<string, string> | Headers;
}
/**
 * Options for `HttpClient.webtransport()` and `HttpSession.webtransport()`.
 *
 * Extends `WebTransportOptions` with request `headers` plus `tls`/`quic`
 * overrides for the underlying QUIC connection. Any `protocols` are sent as the
 * `sec-webtransport-protocol` header. WebTransport requires an `h3` session and
 * an `https:` URL.
 *
 * ```ts no_run
 * const wt = await client.webtransport('https://api.example.com/wt', {
 *   protocols: ['app.v1'],
 * });
 * await wt.ready;
 * ```
 */
export interface HttpWebTransportOptions extends WebTransportOptions {
  /**
   * Headers merged with client or session defaults for the CONNECT request.
   */
  headers?: Record<string, string> | Headers;
  /**
   * TLS overrides for the underlying HTTP/3 transport.
   */
  tls?: HttpClientOptions['tls'];
  /**
   * QUIC overrides for the underlying HTTP/3 transport.
   */
  quic?: H3FetchInit['quic'];
}
interface H3Transport {
  endpoint: QuicEndpoint;
  session: H3ClientSession;
  connection: HttpConnectionInfo;
  requests: number;
}
let sessionSeq = 0;
let connectionSeq = 0;
function nextSessionId(): string {
  return `http-client-session-${++sessionSeq}`;
}
function nextConnectionId(): string {
  return `http-client-connection-${++connectionSeq}`;
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`HttpClient ${name} must be a positive integer`);
  }
  return value;
}
function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`HttpClient ${name} must be a non-negative integer`);
  }
  return value;
}
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  message: string,
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer!: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), Math.max(0, timeoutMs));
    }),
  ]).finally(() => clearTimeout(timer));
}
function normalizeProtocol(protocol: HttpClientProtocol | undefined, url: URL): HttpClientProtocol {
  if (protocol !== undefined) return protocol;
  return url.protocol === 'https:' ? 'http/1.1' : 'http/1.1';
}
function transportFor(url: URL, protocol: HttpClientProtocol): HttpClientTransport {
  if (protocol === 'h3') return 'quic';
  return url.protocol === 'https:' ? 'tls' : 'tcp';
}
function protocolFromResponse(
  response: Response,
  fallback: HttpClientProtocol,
): HttpClientProtocol {
  if (response.version === 'HTTP/2') return 'h2';
  if (response.version === 'HTTP/3') return 'h3';
  return fallback;
}
function isIdempotent(method: string): boolean {
  const upper = method.toUpperCase();
  return (
    upper === 'GET' ||
    upper === 'HEAD' ||
    upper === 'OPTIONS' ||
    upper === 'TRACE' ||
    upper === 'PUT' ||
    upper === 'DELETE'
  );
}
function isReplayable(body: unknown): boolean {
  if (body == null) return true;
  const candidate = body as {
    [Symbol.asyncIterator]?: unknown;
  };
  if (typeof candidate[Symbol.asyncIterator] === 'function') return false;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false;
  return true;
}
function mergeHeaders(base: Headers, override: HttpHeadersInit): Headers {
  const headers = new Headers(base);
  if (override !== undefined && override !== null) {
    const extra = new Headers(override);
    for (const [name, value] of extra) headers.set(name, value);
  }
  return headers;
}
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) out[name] = value;
  return out;
}
function resolveHttpUrl(baseUrl: string | URL | undefined, input: string | URL): URL {
  const url =
    baseUrl === undefined ? new URL(String(input)) : new URL(String(input), String(baseUrl));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`HttpClient: non-HTTP/S URL is not allowed: '${url.href}'`);
  }
  return url;
}
function resolveWebSocketUrl(baseUrl: string | URL | undefined, input: string | URL): URL {
  const base =
    baseUrl === undefined
      ? undefined
      : String(baseUrl)
          .replace(/^http:/, 'ws:')
          .replace(/^https:/, 'wss:');
  const url = base === undefined ? new URL(String(input)) : new URL(String(input), base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError(`HttpClient.websocket: URL must use ws: or wss:, got '${url.href}'`);
  }
  return url;
}
function unsupportedWebSocket(protocol: HttpClientProtocol): Error {
  return new Error(
    `WebSocket over ${protocol} requires Extended CONNECT, which is not supported yet`,
  );
}
function unsupportedWebTransport(protocol: HttpClientProtocol): Error {
  return new Error(`WebTransport over ${protocol} is not supported; use an h3 session`);
}
function resolveWebTransportUrl(baseUrl: string | URL | undefined, input: string | URL): URL {
  const url = resolveHttpUrl(baseUrl, input);
  if (url.protocol !== 'https:') {
    throw new TypeError(`WebTransport requires https: URLs, got '${url.href}'`);
  }
  return url;
}
async function waitForWebSocketOpen(socket: WebSocketConnection): Promise<WebSocketConnection> {
  if (socket.readyState === WebSocketConnection.OPEN) return socket;
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    }
    function onOpen(): void {
      cleanup();
      resolve(socket);
    }
    function onError(event: unknown): void {
      cleanup();
      reject(event instanceof Error ? event : new Error('WebSocket connection failed'));
    }
    function onClose(): void {
      cleanup();
      reject(new Error('WebSocket connection closed before opening'));
    }
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
  });
}
async function* responseBody(
  response: Response,
  markConsumed: () => void,
  timing: { firstResponseByte?: number },
  bodyIdleMs?: number,
): AsyncIterable<Uint8Array> {
  const body = response.body;
  if (body === null) return;
  const iterator = (body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const next = iterator.next();
      const result =
        bodyIdleMs === undefined
          ? await next
          : await Promise.race([
              next,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`HTTP response body idle timeout after ${bodyIdleMs}ms`)),
                  bodyIdleMs,
                );
              }),
            ]).finally(() => {
              if (timer !== null) clearTimeout(timer);
            });
      if (result.done) break;
      if (timing.firstResponseByte === undefined) timing.firstResponseByte = performance.now();
      yield result.value;
    }
  } finally {
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch (_) {}
    }
    markConsumed();
  }
}
/** Policy used by `HttpResponse.discard()`. */
export type HttpResponseDiscardPolicy = 'consume' | 'cancel';
/**
 * Response returned by `HttpClient.request()` and `HttpSession.request()`.
 *
 * Wraps a Fetch-compatible `Response` and augments it with the request that
 * produced it, the logical `session`, the transport `connection`, the actual
 * `protocol` served, incoming `trailers`, and monotonic `timing` marks. The body
 * helpers (`text()`, `json()`, `bytes()`, `arrayBuffer()`) and the streaming
 * `body` iterable are single-consumption: the first that runs marks the body
 * consumed, and any later read — including `toFetchResponse()` — throws
 * `TypeError('Body already consumed')`. `close()` cancels an unread body
 * without throwing; use `discard('consume')` to black-hole it through EOF.
 *
 * Applications rarely construct this directly; obtain one from a request.
 *
 * ```ts no_run
 * import { HttpClient } from 'fino:net/http/client';
 *
 * const client = new HttpClient({ baseUrl: 'https://api.example.com' });
 * const res = await client.request('/users/42');
 * if (res.status === 200) {
 *   const user = await res.json();
 *   console.log(res.protocol, user);
 * } else {
 *   await res.close();
 * }
 * ```
 */
export class HttpResponse {
  readonly #response: Response;
  readonly #markBodyEnd: () => void;
  #consumed = false;
  /**
   * HTTP status code copied from the underlying response.
   */
  readonly status: number;
  /**
   * HTTP reason phrase copied from the underlying response.
   */
  readonly statusText: string;
  /**
   * Response headers.
   */
  readonly headers: Headers;
  /**
   * Final response URL after redirect handling.
   */
  readonly url: string;
  /**
   * Whether the underlying transport followed at least one redirect.
   */
  readonly redirected: boolean;
  /**
   * Metadata for the request that produced this response.
   */
  readonly request: HttpRequestInfo;
  /**
   * Logical session used for the request.
   */
  readonly session: HttpSession;
  /**
   * Transport connection metadata, or `null` when unavailable.
   */
  readonly connection: HttpConnectionInfo | null;
  /**
   * Protocol that served this response.
   */
  readonly protocol: HttpClientProtocol;
  /**
   * Incoming trailer headers.
   *
   * The promise resolves after the response body has been read when the
   * transport supports trailers.
   */
  readonly trailers: Promise<Headers>;
  /**
   * Request/response timing metadata.
   */
  readonly timing: HttpResponseTiming;
  /**
   * Streaming response body.
   *
   * Iterating this consumes the body and prevents later use of body helper
   * methods or `toFetchResponse()`.
   */
  readonly body: AsyncIterable<Uint8Array> | null;
  /**
   * Wrap a Fetch-compatible `Response` together with client-level metadata.
   *
   * Called by the client machinery; applications receive ready-made
   * `HttpResponse` values from `request()` and do not build them by hand.
   */
  constructor(init: {
    response: Response;
    request: HttpRequestInfo;
    session: HttpSession;
    connection: HttpConnectionInfo | null;
    protocol: HttpClientProtocol;
    timing: HttpResponseTiming;
    markBodyEnd: () => void;
    bodyIdleMs?: number;
    lifecycleSignal?: MinimalAbortSignal | null;
  }) {
    this.#response = init.response;
    let ended = false;
    const onAbort = () => {
      void this.close();
    };
    this.#markBodyEnd = () => {
      if (ended) return;
      ended = true;
      init.lifecycleSignal?.removeEventListener('abort', onAbort);
      init.markBodyEnd();
    };
    init.lifecycleSignal?.addEventListener('abort', onAbort, { once: true });
    if (init.lifecycleSignal?.aborted) queueMicrotask(onAbort);
    this.status = init.response.status;
    this.statusText = init.response.statusText;
    this.headers = init.response.headers;
    this.url = init.response.url;
    this.redirected = init.response.redirected;
    this.request = init.request;
    this.session = init.session;
    this.connection = init.connection;
    this.protocol = init.protocol;
    this.trailers = init.response.trailers;
    this.timing = init.timing;
    this.body =
      init.response.body === null
        ? null
        : responseBody(init.response, this.#consume.bind(this), init.timing, init.bodyIdleMs);
    if (this.body === null) this.#markBodyEnd();
  }
  #consume(): void {
    this.#consumed = true;
    this.#markBodyEnd();
  }
  #assertUnused(): void {
    if (this.#consumed || this.#response.bodyUsed) throw new TypeError('Body already consumed');
  }
  async #collectBody(): Promise<Uint8Array> {
    this.#assertUnused();
    this.#consumed = true;
    if (this.body === null) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.body) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0]!;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  /**
   * Consume the body and return an `ArrayBuffer`.
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.#collectBody();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  /**
   * Consume the body and return bytes.
   */
  async bytes(): Promise<Uint8Array> {
    return this.#collectBody();
  }
  /**
   * Consume the body and decode it as UTF-8 text.
   */
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.#collectBody());
  }
  /**
   * Consume the body and parse it as JSON.
   *
   * Throws `TypeError('Body already consumed')` if any body helper, `body`
   * iteration, `toFetchResponse()`, or `close()` already ran, and rejects if the
   * payload is not valid JSON.
   */
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
  /**
   * Hand back the underlying Fetch-compatible `Response`.
   *
   * Marks this `HttpResponse` consumed and transfers body ownership to the
   * returned `Response`, so read the body through that object afterward. Throws
   * `TypeError('Body already consumed')` if the body was already read here.
   */
  toFetchResponse(): Response {
    this.#assertUnused();
    this.#consumed = true;
    return buildWireResponse({
      version: this.#response.version,
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
      body: this.body as any,
      url: this.url,
      redirected: this.redirected,
      inTrailers: this.trailers,
    });
  }
  /**
   * Release the response without reading it.
   *
   * Marks the body consumed and cancels the underlying stream if it is still
   * open. Safe to call more than once and never throws, making it the right way
   * to discard a response you do not intend to read (for example, on a status
   * you do not handle).
   */
  async close(): Promise<void> {
    if (this.#consumed) return;
    const body = this.#response.body as unknown as {
      cancel?: () => Promise<void>;
    } | null;
    this.#consume();
    if (body && typeof body.cancel === 'function') {
      try {
        await body.cancel();
      } catch (_) {}
    }
  }
  /**
   * Drop a response with explicit wire semantics.
   *
   * `consume` (the default) reads each chunk, counts its bytes, and immediately
   * releases it so the connection remains reusable. `cancel` stops after
   * headers: HTTP/1 closes its connection while HTTP/2 and HTTP/3 reset only
   * the stream. The returned number is the body bytes consumed in `consume`
   * mode and zero in `cancel` mode.
   */
  async discard(policy: HttpResponseDiscardPolicy = 'consume'): Promise<number> {
    if (policy === 'cancel') {
      await this.close();
      return 0;
    }
    this.#assertUnused();
    this.#consumed = true;
    let bytes = 0;
    if (this.body !== null) {
      for await (const chunk of this.body) bytes += chunk.byteLength;
    }
    return bytes;
  }
}
/** Point-in-time local scheduler state for an HTTP session. */
export interface HttpSessionCapacity {
  /** Number of configured physical connection slots. */
  readonly connections: number;
  /** Requests or streams currently holding a slot. */
  readonly active: number;
  /** Requests waiting for a slot. */
  readonly pending: number;
  /** Maximum simultaneous operations across all slots. */
  readonly limit: number;
}
interface CapacityWaiter {
  resolve(slot: number): void;
  reject(reason: unknown): void;
  signal: MinimalAbortSignal | null;
  onAbort: (() => void) | null;
}
/**
 * Logical, origin-scoped relationship with a server.
 *
 * A session pins one origin and one protocol and carries the client's default
 * headers, giving a stable identity (`id`) that outlives any single transport
 * connection. Each session owns a configured number of transport slots and a
 * bounded FIFO acquisition queue. HTTP/1.1 slots are leased exclusively;
 * HTTP/2 and HTTP/3 slots multiplex configured stream concurrency.
 * Sessions expose their lifecycle through the `events` async iterable and can
 * additionally open SSE streams, WebSockets, and WebTransport bound to the same
 * origin and headers.
 *
 * Obtain sessions from `HttpClient.session()` rather than constructing them.
 *
 * ```ts no_run
 * import { HttpClient } from 'fino:net/http/client';
 *
 * const client = new HttpClient({ protocols: ['h3'] });
 * const session = await client.session('https://api.example.com', { protocol: 'h3' });
 * try {
 *   const a = await session.request({ path: '/a' });
 *   const b = await session.request({ path: '/b' });
 *   console.log(a.session.id === b.session.id); // true — stable identity
 * } finally {
 *   await session.close();
 * }
 * ```
 */
export class HttpSession {
  readonly #client: HttpClient;
  readonly #headers: Headers;
  readonly #baseUrl: URL;
  #state: 'connecting' | 'ready' | 'draining' | 'closed' = 'ready';
  #currentConnection: HttpConnectionInfo | null = null;
  #events: HttpSessionEvent[] = [];
  #h3Transports = new Map<number, H3Transport>();
  #activeBySlot: number[];
  #slotEstablished: boolean[];
  #capacityWaiters: CapacityWaiter[] = [];
  /**
   * Stable logical session identity.
   *
   * This differs from `HttpConnectionInfo.id`; it remains stable across
   * reconnects and multiple requests on the same logical session.
   */
  readonly id: string;
  /**
   * Origin URL for the session, such as `https://api.example.com`.
   */
  readonly origin: string;
  /**
   * Protocol pinned for every request sent through this session.
   */
  readonly protocol: HttpClientProtocol;
  /**
   * Bind a session to a client, origin, protocol, and default headers.
   *
   * Applications should call `HttpClient.session()` instead, which caches and
   * reuses sessions per `protocol:origin`.
   */
  constructor(client: HttpClient, origin: URL, protocol: HttpClientProtocol, headers: Headers) {
    this.#client = client;
    this.#baseUrl = origin;
    this.#headers = headers;
    this.id = nextSessionId();
    this.origin = origin.origin;
    this.protocol = protocol;
    this.#activeBySlot = Array.from({ length: client.connections }, () => 0);
    this.#slotEstablished = Array.from({ length: client.connections }, () => false);
  }
  /** Snapshot current local connection/stream capacity and queue depth. */
  get capacity(): HttpSessionCapacity {
    const perConnection = this.protocol === 'http/1.1' ? 1 : this.#client.maxConcurrentStreams;
    return {
      connections: this.#activeBySlot.length,
      active: this.#activeBySlot.reduce((sum, count) => sum + count, 0),
      pending: this.#capacityWaiters.length,
      limit: this.#activeBySlot.length * perConnection,
    };
  }
  /**
   * Current lifecycle state.
   *
   * `ready` sessions can send requests. `closed` sessions reject new requests.
   * `connecting` and `draining` are reserved lifecycle states for transport
   * transitions.
   */
  get state(): 'connecting' | 'ready' | 'draining' | 'closed' {
    return this.#state;
  }
  /**
   * Current transport connection, if one is active or last used.
   *
   * HTTP/3 sessions keep this as the active QUIC connection. HTTP/1.1 and HTTP/2
   * sessions update it with the most recent request's connection metadata.
   */
  get currentConnection(): HttpConnectionInfo | null {
    return this.#currentConnection;
  }
  /**
   * Async iterable replaying the lifecycle events recorded so far.
   *
   * Iterating yields the buffered `HttpSessionEvent` history and completes; it
   * is a snapshot, not a live subscription, so re-iterate to observe events
   * appended after the loop finished.
   */
  get events(): AsyncIterable<HttpSessionEvent> {
    const events = this.#events;
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
  }
  #availableSlot(): number {
    let selected = -1;
    for (let slot = 0; slot < this.#activeBySlot.length; slot++) {
      const limit =
        this.protocol === 'http/1.1' || !this.#slotEstablished[slot]
          ? 1
          : this.#client.maxConcurrentStreams;
      if (this.#activeBySlot[slot]! >= limit) continue;
      if (selected === -1 || this.#activeBySlot[slot]! < this.#activeBySlot[selected]!) {
        selected = slot;
      }
    }
    return selected;
  }
  #acquire(signal: MinimalAbortSignal | null): Promise<number> {
    const slot = this.#availableSlot();
    if (slot !== -1) {
      this.#activeBySlot[slot]!++;
      return Promise.resolve(slot);
    }
    if (this.#capacityWaiters.length >= this.#client.maxPendingRequests) {
      return Promise.reject(new Error('HTTP session pending request queue is full'));
    }
    return new Promise<number>((resolve, reject) => {
      const waiter: CapacityWaiter = { resolve, reject, signal, onAbort: null };
      if (signal !== null) {
        const onAbort = () => {
          const index = this.#capacityWaiters.indexOf(waiter);
          if (index !== -1) this.#capacityWaiters.splice(index, 1);
          reject(signal.reason);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#capacityWaiters.push(waiter);
    });
  }
  #release(slot: number): void {
    if (this.#activeBySlot[slot]! > 0) this.#activeBySlot[slot]!--;
    this.#wakeCapacityWaiter();
  }
  #wakeCapacityWaiter(): boolean {
    while (this.#capacityWaiters.length > 0) {
      const waiter = this.#capacityWaiters.shift()!;
      if (waiter.signal?.aborted) continue;
      const available = this.#availableSlot();
      if (available === -1) {
        this.#capacityWaiters.unshift(waiter);
        return false;
      }
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      this.#activeBySlot[available]!++;
      waiter.resolve(available);
      return true;
    }
    return false;
  }
  async #closeH3Transports(): Promise<void> {
    const transports = [...this.#h3Transports.values()];
    this.#h3Transports.clear();
    await Promise.allSettled(
      transports.map(async (transport) => {
        transport.session.close();
        await transport.endpoint.close();
      }),
    );
  }
  async #ensureH3Transport(
    url: URL,
    slot: number,
    init: Pick<HttpRequestInit, 'tls' | 'quic'> = {},
    connectTimeout?: number,
  ): Promise<H3Transport> {
    let transport = this.#h3Transports.get(slot);
    if (transport !== undefined) return transport;
    const target = await resolveH3ConnectAddress(url);
    const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
    const tls = init.tls ?? this.#client.tls;
    const quic = init.quic ?? {
      ...(tls?.ca !== undefined ? { ca: _quicCaFromTls(tls.ca) } : {}),
      ...(tls?.rejectUnauthorized === false ? { verifyPeer: false } : {}),
      ...(tls?.cert !== undefined ? { certificateFile: tls.cert } : {}),
      ...(tls?.key !== undefined ? { privateKeyFile: tls.key } : {}),
    };
    try {
      const conn = await withDeadline(
        endpoint.connect({
          ...quic,
          address: target.address,
          alpnProtocols: ['h3'],
          serverName: quic?.serverName ?? target.serverName,
        }),
        connectTimeout,
        'HTTP/3 connection timeout',
      );
      return await this.#attachH3Connection(conn, endpoint, slot, url.origin);
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }
  async #attachH3Connection(
    conn: QuicConnection,
    endpoint: QuicEndpoint,
    slot: number,
    origin?: string,
  ): Promise<H3Transport> {
    const h3 = await H3ClientSession.create(conn, { origin });
    const connection: HttpConnectionInfo = {
      id: nextConnectionId(),
      protocol: 'h3',
      transport: 'quic',
      localAddress: conn.localAddress,
      remoteAddress: conn.remoteAddress,
      alpnProtocol: 'h3',
      connectedAt: performance.now(),
      reused: false,
      streamId: null,
    };
    const transport = {
      endpoint,
      session: h3,
      connection,
      requests: 0,
    };
    this.#h3Transports.set(slot, transport);
    this.#currentConnection = connection;
    this.#events.push({
      type: 'connected',
      session: this,
      connection,
    });
    return transport;
  }
  async _attachH3TransportForTest(conn: QuicConnection): Promise<void> {
    await this.#closeH3Transports();
    const endpoint = { close: async () => {} } as QuicEndpoint;
    await this.#attachH3Connection(conn, endpoint, 0);
  }
  async #h3Request(
    url: URL,
    method: string,
    headers: Headers,
    init: HttpRequestInit,
    slot: number,
    signal: MinimalAbortSignal | null,
    connectTimeout?: number,
  ): Promise<{ response: Response; connection: HttpConnectionInfo }> {
    const transport = await this.#ensureH3Transport(url, slot, init, connectTimeout);
    const response = await transport.session.request(url.href, {
      method,
      headers,
      body: init.body,
      trailers: init.trailers as any,
      signal,
      maxBufferedBodyBytes: this.#client.maxBufferedResponseBytes,
    } as H3FetchInit);
    const streamId = (response as any).__h3StreamId as bigint | undefined;
    const built = buildWireResponse({
      version: 'HTTP/3',
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body as any,
      url: url.href,
      redirected: false,
      inTrailers: response.trailers,
    });
    const connection = {
      ...transport.connection,
      reused: transport.requests++ > 0,
      streamId: streamId ?? null,
    };
    return { response: built, connection };
  }
  async _request(input: string | URL, init: HttpRequestInit = {}): Promise<HttpResponse> {
    if (this.#state === 'closed') throw new Error('HTTP session closed');
    const url = resolveHttpUrl(this.#baseUrl, input);
    const method = init.method !== undefined ? String(init.method).toUpperCase() : 'GET';
    const headers = mergeHeaders(this.#headers, init.headers);
    const scheduledTime = performance.now();
    const timeouts = { ...this.#client.timeouts, ...init.timeouts };
    const retry = { ...this.#client.retry, ...init.retry };
    const attempts = positiveInteger(retry.attempts ?? 1, 'retry.attempts');
    const replayable = isReplayable(init.body);
    const controller = new AbortController();
    const userSignal = init.signal ?? null;
    if (userSignal?.aborted) throw userSignal.reason;
    const onUserAbort = () => controller.abort(userSignal!.reason);
    userSignal?.addEventListener('abort', onUserAbort, { once: true });
    let headersTimer: ReturnType<typeof setTimeout> | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;
    if (timeouts.headers !== undefined) {
      headersTimer = setTimeout(
        () =>
          controller.abort(new Error(`HTTP response headers timeout after ${timeouts.headers}ms`)),
        timeouts.headers,
      );
    }
    if (timeouts.total !== undefined) {
      totalTimer = setTimeout(
        () => controller.abort(new Error(`HTTP request total timeout after ${timeouts.total}ms`)),
        timeouts.total,
      );
    }
    const cleanupDeadline = () => {
      if (headersTimer !== null) clearTimeout(headersTimer);
      if (totalTimer !== null) clearTimeout(totalTimer);
      userSignal?.removeEventListener('abort', onUserAbort);
    };
    const timing: {
      scheduledTime: number;
      startTime: number;
      queueEnd: number;
      responseHeadersEnd?: number;
      firstResponseByte?: number;
      bodyEnd?: number;
      dnsStart: number | null;
      dnsEnd: number | null;
      connectStart: number | null;
      connectEnd: number | null;
      secureConnectStart: number | null;
      secureConnectEnd: number | null;
      requestHeadersEnd: number | null;
      requestBodyEnd: number | null;
    } = {
      scheduledTime,
      startTime: scheduledTime,
      queueEnd: scheduledTime,
      dnsStart: null,
      dnsEnd: null,
      connectStart: null,
      connectEnd: null,
      secureConnectStart: null,
      secureConnectEnd: null,
      requestHeadersEnd: null,
      requestBodyEnd: null,
    };
    let response!: Response;
    let connection: HttpConnectionInfo | null = null;
    let slot = -1;
    let attempt = 0;
    for (; attempt < attempts; attempt++) {
      try {
        slot = await this.#acquire(controller.signal);
        timing.queueEnd = performance.now();
        timing.startTime = timing.queueEnd;
        if (this.protocol === 'h3') {
          const h3 = await this.#h3Request(
            url,
            method,
            headers,
            init,
            slot,
            controller.signal,
            timeouts.connect,
          );
          response = h3.response;
          connection = h3.connection;
        } else {
          response = await runtimeFetch(url.href, {
            method,
            headers,
            body: init.body,
            signal: controller.signal,
            redirect: init.redirect,
            integrity: init.integrity,
            referrer: init.referrer,
            referrerPolicy: init.referrerPolicy,
            trailers: init.trailers,
            tls: init.tls ?? this.#client.tls,
            protocol: this.protocol,
            poolSlot: `${this.id}:${slot}`,
            decompress: init.decompress ?? this.#client.decompress,
            maxBufferedBodyBytes: this.#client.maxBufferedResponseBytes,
            connectTimeout: timeouts.connect,
          } as any);
          const metadata = _getFetchResponseMetadata(response);
          const servedProtocol = protocolFromResponse(response, this.protocol);
          connection = {
            id: metadata?.connectionId ?? nextConnectionId(),
            protocol: servedProtocol,
            transport: transportFor(url, servedProtocol),
            localAddress: metadata?.localAddress ?? null,
            remoteAddress: metadata?.remoteAddress ?? null,
            alpnProtocol:
              metadata?.alpnProtocol ?? (servedProtocol === 'http/1.1' ? null : servedProtocol),
            connectedAt: metadata?.connectedAt ?? timing.startTime,
            reused: metadata?.reused ?? false,
            streamId: metadata?.streamId ?? null,
          };
        }
        if (!this.#slotEstablished[slot]) {
          this.#slotEstablished[slot] = true;
          while (this.#wakeCapacityWaiter()) {}
        }
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const connectionFailed =
          /connection|session closed|GOAWAY|going away|transport/i.test(message) &&
          !/body idle|response headers|total timeout/i.test(message);
        if (this.protocol === 'h3' && slot !== -1 && connectionFailed) {
          const transport = this.#h3Transports.get(slot);
          if (transport !== undefined) {
            this.#h3Transports.delete(slot);
            transport.session.close();
            await transport.endpoint.close().catch(() => {});
          }
        }
        if (slot !== -1 && connectionFailed) this.#slotEstablished[slot] = false;
        if (slot !== -1) this.#release(slot);
        slot = -1;
        if (
          controller.signal.aborted ||
          !isIdempotent(method) ||
          !replayable ||
          attempt + 1 >= attempts
        ) {
          cleanupDeadline();
          throw error;
        }
      }
    }
    if (headersTimer !== null) {
      clearTimeout(headersTimer);
      headersTimer = null;
    }
    timing.responseHeadersEnd = performance.now();
    const protocol = protocolFromResponse(response, this.protocol);
    this.#currentConnection = connection;
    if (this.protocol !== 'h3') {
      const event: HttpSessionEvent = {
        type: 'connected',
        session: this,
        connection,
      };
      this.#events.push(event);
    }
    return new HttpResponse({
      response,
      request: {
        method,
        url: url.href,
        headers,
        idempotent: isIdempotent(method),
        replayable,
        attempt: attempt + 1,
      },
      session: this,
      connection,
      protocol,
      timing,
      markBodyEnd: () => {
        if (timing.bodyEnd !== undefined) return;
        timing.bodyEnd = performance.now();
        cleanupDeadline();
        this.#release(slot);
      },
      bodyIdleMs: timeouts.bodyIdle,
      lifecycleSignal: controller.signal,
    });
  }
  /**
   * Send a request over this session and resolve to a rich `HttpResponse`.
   *
   * Resolves the target from `init.url` or `init.path` against the session
   * origin (defaulting to `/`), merges the session's default headers, and sends
   * on the session's pinned protocol. Throws if the session has been closed.
   */
  request(init: HttpSessionRequest = {}): Promise<HttpResponse> {
    return this._request(init.url ?? init.path ?? '/', init);
  }
  /**
   * Open an EventSource pinned to this session's origin and headers.
   *
   * The returned EventSource uses merged session and per-call headers and
   * inherits the client's TLS policy unless `options.tls` overrides it.
   */
  sse(path: string | URL, options: SseOptions = {}): EventSource {
    const url = resolveHttpUrl(this.#baseUrl, path);
    const headers = mergeHeaders(this.#headers, options.headers);
    return new EventSource(url.href, {
      ...options,
      headers,
      tls: options.tls ?? this.#client.tls,
    });
  }
  /**
   * Open a WebSocket pinned to this session's origin and headers.
   *
   * Rewrites the URL scheme to `ws:`/`wss:`, merges session headers into the
   * upgrade request, and resolves once the socket is open. Only HTTP/1.1
   * sessions are supported; an `h2` or `h3` session throws because WebSocket
   * over those protocols needs Extended CONNECT, which is not yet implemented.
   */
  async websocket(
    path: string | URL,
    options: HttpWebSocketOptions = {},
  ): Promise<WebSocketConnection> {
    if (this.protocol !== 'http/1.1') throw unsupportedWebSocket(this.protocol);
    const url = resolveWebSocketUrl(this.#baseUrl, path);
    const headers = mergeHeaders(this.#headers, options.headers);
    const socket = WebSocketConnection.connect(url, {
      ...options,
      headers: headersToRecord(headers),
    });
    return waitForWebSocketOpen(socket);
  }
  /**
   * Open a WebTransport session over this session's QUIC transport.
   *
   * Reuses the session's H3 transport (establishing it on first use), sends any
   * `protocols` as `sec-webtransport-protocol`, and resolves once the transport
   * is ready. Requires an `h3` session and an `https:` URL; other protocols
   * throw.
   */
  async webtransport(
    path: string | URL,
    options: HttpWebTransportOptions = {},
  ): Promise<WebTransport> {
    if (this.protocol !== 'h3') throw unsupportedWebTransport(this.protocol);
    const url = resolveWebTransportUrl(this.#baseUrl, path);
    const headers = mergeHeaders(this.#headers, options.headers);
    if (options.protocols !== undefined && options.protocols.length > 0) {
      headers.set('sec-webtransport-protocol', options.protocols.join(', '));
    }
    const transport = await this.#ensureH3Transport(url, 0, options);
    const webtransport = await transport.session.webtransport(url.href, {
      headers,
      webTransportOptions: options,
    } as H3FetchInit);
    await webtransport.ready;
    return webtransport;
  }
  /**
   * Drop the current transport while keeping the session's logical identity.
   *
   * Emits a `reconnecting` event carrying `options.reason`, tears down any live
   * H3 transport, and clears the current connection so the next request
   * re-establishes one. The session `id` and origin are unchanged. Throws if the
   * session is already closed.
   */
  async reconnect(options: ReconnectOptions = {}): Promise<void> {
    if (this.#state === 'closed') throw new Error('HTTP session closed');
    this.#events.push({
      type: 'reconnecting',
      session: this,
      reason: options.reason,
    });
    await this.#closeH3Transports();
    await Promise.all(
      this.#activeBySlot.map((_, slot) =>
        _closeFetchPoolSlot(this.origin, `${this.id}:${slot}`, this.#client.tls),
      ),
    );
    this.#currentConnection = null;
  }
  /**
   * Close the session and release its transport.
   *
   * Transitions to the `closed` state, tears down any H3 transport, evicts the
   * shared HTTP/2 pool entry for the origin when the session is `h2`, and emits
   * a final `closed` event with `options.reason`. Idempotent: closing an
   * already-closed session is a no-op. After closing, `request()` throws.
   */
  async close(options: CloseOptions = {}): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    for (const waiter of this.#capacityWaiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      waiter.reject(new Error('HTTP session closed'));
    }
    await this.#closeH3Transports();
    await Promise.all(
      this.#activeBySlot.map((_, slot) =>
        _closeFetchPoolSlot(this.origin, `${this.id}:${slot}`, this.#client.tls),
      ),
    );
    this.#events.push({
      type: 'closed',
      session: this,
      reason: options.reason,
    });
  }
}
/**
 * Reusable HTTP client that owns shared policy and logical sessions.
 *
 * An `HttpClient` bundles a base URL, default headers, protocol preferences,
 * and TLS settings, then applies them across `request()`, `fetch()`, `sse()`,
 * `websocket()`, and `webtransport()`. It transparently manages a pool of
 * `HttpSession` objects keyed by `protocol:origin`, creating one on demand and
 * reusing it for subsequent requests to the same origin, which is what lets
 * HTTP/2 and HTTP/3 keep their multiplexed transports warm. Use it instead of
 * global `fetch()` when you want reuse, protocol control, or the request,
 * connection, and timing metadata carried on `HttpResponse`.
 *
 * Close the client when done to release every session and pooled connection.
 *
 * ```ts no_run
 * import { HttpClient } from 'fino:net/http/client';
 *
 * const client = new HttpClient({
 *   baseUrl: 'https://api.example.com',
 *   headers: { authorization: 'Bearer t0ken' },
 *   protocols: ['h2', 'http/1.1'],
 * });
 * try {
 *   const res = await client.request('/users');
 *   console.log(res.status, await res.json());
 * } finally {
 *   await client.close();
 * }
 * ```
 */
export class HttpClient {
  readonly #baseUrl?: URL;
  readonly #headers: Headers;
  readonly #protocols: readonly HttpClientProtocol[];
  readonly #sessions = new Map<string, HttpSession>();
  #closed = false;
  /**
   * TLS options inherited by requests, SSE helpers, and HTTP/3 sessions.
   */
  readonly tls?: HttpClientOptions['tls'];
  /** Configured physical connections per origin. */
  readonly connections: number;
  /** Configured active stream ceiling for each H2/H3 connection. */
  readonly maxConcurrentStreams: number;
  /** Configured local acquisition queue bound. */
  readonly maxPendingRequests: number;
  /** Configured unread response bound for multiplexed streams. */
  readonly maxBufferedResponseBytes: number;
  /** Default request deadlines. */
  readonly timeouts: HttpClientTimeouts;
  /** Default safe retry policy. */
  readonly retry: HttpClientRetryOptions;
  /** Default transparent content decoding policy. */
  readonly decompress: boolean;
  /**
   * Create a client with the given default policy.
   *
   * All options are optional; the defaults are no base URL, no headers, and the
   * single protocol `http/1.1`. Throws `TypeError` if `baseUrl` is not an
   * `http:` or `https:` URL.
   */
  constructor(options: HttpClientOptions = {}) {
    this.#baseUrl =
      options.baseUrl !== undefined ? resolveHttpUrl(undefined, options.baseUrl) : undefined;
    this.#headers = new Headers(options.headers);
    this.#protocols = options.protocols ?? ['http/1.1'];
    this.tls = options.tls;
    this.connections = positiveInteger(options.connections ?? 1, 'connections');
    this.maxConcurrentStreams = positiveInteger(
      options.maxConcurrentStreams ?? 100,
      'maxConcurrentStreams',
    );
    this.maxPendingRequests = nonNegativeInteger(
      options.maxPendingRequests ?? 1024,
      'maxPendingRequests',
    );
    this.maxBufferedResponseBytes = positiveInteger(
      options.maxBufferedResponseBytes ?? 16 * 1024 * 1024,
      'maxBufferedResponseBytes',
    );
    this.timeouts = options.timeouts ?? {};
    this.retry = options.retry ?? { attempts: 1 };
    this.decompress = options.decompress !== false;
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('HTTP client closed');
  }
  async #sessionFor(url: URL, protocol?: HttpClientProtocol): Promise<HttpSession> {
    const selected = normalizeProtocol(protocol ?? this.#protocols[0], url);
    const key = `${selected}:${url.origin}`;
    let session = this.#sessions.get(key);
    if (session === undefined || session.state === 'closed') {
      session = new HttpSession(this, new URL(url.origin + '/'), selected, this.#headers);
      this.#sessions.set(key, session);
    }
    return session;
  }
  /**
   * Send a request and resolve to a rich `HttpResponse`.
   *
   * Accepts a string, `URL`, or Fetch `Request`; a `Request` contributes its
   * method, headers, and body, which `init` can still override. The target is
   * resolved against the client base URL, routed through the pooled session for
   * its origin, and sent on the client's first protocol. Throws `TypeError` for
   * non-HTTP(S) URLs and throws if the client has been closed.
   *
   * ```ts no_run
   * const res = await client.request('/users', { method: 'POST', body: '{}' });
   * console.log(res.status, res.protocol, res.connection?.transport);
   * ```
   */
  async request(input: string | URL | Request, init: HttpRequestInit = {}): Promise<HttpResponse> {
    this.#assertOpen();
    const url =
      input instanceof Request
        ? resolveHttpUrl(this.#baseUrl, input.url)
        : resolveHttpUrl(this.#baseUrl, input);
    const requestInit =
      input instanceof Request
        ? {
            ...init,
            method: input.method,
            headers: mergeHeaders(input.headers, init.headers),
            body: init.body !== undefined ? init.body : input.hasBody ? input.body : undefined,
          }
        : init;
    const session = await this.#sessionFor(url);
    return session._request(url, requestInit);
  }
  /**
   * Send a request and return a plain Fetch-compatible `Response`.
   *
   * A convenience wrapper over `request()` for code that only wants the standard
   * `Response` and none of the extra client metadata. The returned `Response`
   * owns the body, so read it from that object.
   *
   * ```ts no_run
   * const res = await client.fetch('/health');
   * console.log(await res.text());
   * ```
   */
  async fetch(input: string | URL | Request, init: HttpRequestInit = {}): Promise<Response> {
    const response = await this.request(input, init);
    return response.toFetchResponse();
  }
  /**
   * Get the pooled logical session for an origin, creating it if needed.
   *
   * The origin is resolved against the base URL and the session is cached per
   * `protocol:origin`; passing an explicit `options.protocol` selects (and keys)
   * a distinct session. Reuse the returned session to send correlated requests
   * and to observe lifecycle events. Throws for non-HTTP(S) URLs or if the
   * client is closed.
   */
  async session(origin: string | URL, options: HttpSessionOptions = {}): Promise<HttpSession> {
    this.#assertOpen();
    const url = resolveHttpUrl(this.#baseUrl, origin);
    return this.#sessionFor(url, options.protocol);
  }
  /**
   * Open an EventSource using this client's base URL and default headers.
   *
   * The stream is not pooled as an `HttpSession`, but it shares client headers
   * and TLS options.
   */
  sse(input: string | URL, options: SseOptions = {}): EventSource {
    this.#assertOpen();
    const url = resolveHttpUrl(this.#baseUrl, input);
    const headers = mergeHeaders(this.#headers, options.headers);
    return new EventSource(url.href, {
      ...options,
      headers,
      tls: options.tls ?? this.tls,
    });
  }
  /**
   * Open a WebSocket using this client's base URL and default headers.
   *
   * Resolves once the socket reaches `OPEN`. Client-level WebSockets use the
   * HTTP/1.1 WebSocket transport; use session helpers when protocol pinning is
   * important.
   */
  async websocket(
    input: string | URL,
    options: HttpWebSocketOptions = {},
  ): Promise<WebSocketConnection> {
    this.#assertOpen();
    const url = resolveWebSocketUrl(this.#baseUrl, input);
    const headers = mergeHeaders(this.#headers, options.headers);
    const socket = WebSocketConnection.connect(url, {
      ...options,
      headers: headersToRecord(headers),
    });
    return waitForWebSocketOpen(socket);
  }
  /**
   * Open a WebTransport session using this client's base URL and default
   * headers.
   *
   * This uses or creates an HTTP/3 session for the target origin and rejects
   * non-HTTPS URLs.
   */
  async webtransport(
    input: string | URL,
    options: HttpWebTransportOptions = {},
  ): Promise<WebTransport> {
    this.#assertOpen();
    const url = resolveWebTransportUrl(this.#baseUrl, input);
    const session = await this.#sessionFor(url, 'h3');
    return session.webtransport(url, options);
  }
  /**
   * Close pooled sessions and drop them from the cache.
   *
   * Currently closes every logical session the client holds, releasing their
   * transports. The client itself stays usable and will lazily recreate sessions
   * on the next request.
   */
  async closeIdleSessions(): Promise<void> {
    for (const session of this.#sessions.values()) await session.close();
    this.#sessions.clear();
  }
  /**
   * Close the client and every session it owns.
   *
   * Idempotent. After closing, `request()`, `session()`, and the SSE/WebSocket/
   * WebTransport helpers throw. Always call this when finished to avoid leaking
   * pooled HTTP/2 and HTTP/3 connections.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.closeIdleSessions();
  }
}
