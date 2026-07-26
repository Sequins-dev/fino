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
 * while establishing the public client/session surface. HTTP/1.1 sessions are
 * logical policy containers and still use one connection per request. Explicit
 * HTTP/3 sessions keep one QUIC/H3 transport active until `reconnect()` or
 * `close()`. HTTP/2 and HTTP/3 WebSocket attempts reject with a clear Extended
 * CONNECT error until those transports support it.
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
import { fetch as runtimeFetch, _closeFetchH2PoolEntry } from '../../globals/fetch.ts';
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
 * `'http/1.1'` uses one connection per request and is the default. `'h2'`
 * multiplexes over a shared HTTP/2 pool entry keyed by origin. `'h3'` runs over
 * a persistent QUIC transport that survives until `reconnect()` or `close()`.
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
 * overridden per call. `protocols` lists preferences in priority order — the
 * first entry drives explicit sessions and the default for `request()`. `tls`
 * is forwarded to the underlying fetch, EventSource, and QUIC transports.
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
 * `trailers` (a `Headers` value or a function producing one, applied after the
 * body) plus transport-specific `tls` and `quic` overrides. Headers here are
 * merged on top of the client's defaults. `tls`/`quic` fall back to the
 * client's TLS options when omitted.
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
 * `id` is a per-process synthetic connection identifier, distinct from the
 * logical `HttpSession.id`. `protocol` and `transport` describe what was
 * actually negotiated. `localAddress`/`remoteAddress` and `alpnProtocol` are
 * populated for HTTP/3 (QUIC) connections and left `null` for the HTTP/1.1 and
 * HTTP/2 paths, which layer on the shared fetch pool. `connectedAt` is a
 * `Date.now()` millisecond timestamp.
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
}
/**
 * Coarse timing marks captured while sending a request and reading its body.
 *
 * All values are `Date.now()` millisecond timestamps. `startTime` is recorded
 * just before the request is sent. `responseHeadersEnd` is set once the status
 * line and headers arrive. `bodyEnd` is set when the response body is fully
 * consumed or the response is closed — so it stays `undefined` until you read
 * the body via `text()`, `json()`, `bytes()`, `arrayBuffer()`, iterate `body`,
 * or call `close()`.
 *
 * ```ts no_run
 * const res = await client.request('/users');
 * const body = await res.text();
 * const total = (res.timing.bodyEnd ?? Date.now()) - res.timing.startTime;
 * console.log(`request took ${total}ms`);
 * ```
 */
export interface HttpResponseTiming {
  /**
   * Millisecond timestamp taken immediately before the request is sent.
   */
  readonly startTime: number;
  /**
   * Millisecond timestamp taken after response status and headers arrive.
   */
  readonly responseHeadersEnd?: number;
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
 * and `closed` on teardown. The HTTP/1.1 and HTTP/2 paths emit `connected` per
 * request since they do not hold a dedicated transport; HTTP/3 sessions emit
 * `connected` once when the QUIC transport comes up. Consume the stream via
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
}
let sessionSeq = 0;
let connectionSeq = 0;
function nextSessionId(): string {
  return `http-client-session-${++sessionSeq}`;
}
function nextConnectionId(): string {
  return `http-client-connection-${++connectionSeq}`;
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
): AsyncIterable<Uint8Array> {
  const body = response.body;
  if (body === null) return;
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      yield chunk;
    }
  } finally {
    markConsumed();
  }
}
/**
 * Response returned by `HttpClient.request()` and `HttpSession.request()`.
 *
 * Wraps a Fetch-compatible `Response` and augments it with the request that
 * produced it, the logical `session`, the transport `connection`, the actual
 * `protocol` served, incoming `trailers`, and coarse `timing` marks. The body
 * helpers (`text()`, `json()`, `bytes()`, `arrayBuffer()`) and the streaming
 * `body` iterable are single-consumption: the first that runs marks the body
 * consumed, and any later read — including `toFetchResponse()` — throws
 * `TypeError('Body already consumed')`. `close()` drains or cancels an unread
 * body without throwing so responses can be discarded safely.
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
  }) {
    this.#response = init.response;
    this.#markBodyEnd = init.markBodyEnd;
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
      init.response.body === null ? null : responseBody(init.response, this.#consume.bind(this));
  }
  #consume(): void {
    this.#consumed = true;
    this.#markBodyEnd();
  }
  #assertUnused(): void {
    if (this.#consumed || this.#response.bodyUsed) throw new TypeError('Body already consumed');
  }
  /**
   * Consume the body and return an `ArrayBuffer`.
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    this.#assertUnused();
    try {
      return await this.#response.arrayBuffer();
    } finally {
      this.#consume();
    }
  }
  /**
   * Consume the body and return bytes.
   */
  async bytes(): Promise<Uint8Array> {
    this.#assertUnused();
    try {
      return await this.#response.bytes();
    } finally {
      this.#consume();
    }
  }
  /**
   * Consume the body and decode it as UTF-8 text.
   */
  async text(): Promise<string> {
    this.#assertUnused();
    try {
      return await this.#response.text();
    } finally {
      this.#consume();
    }
  }
  /**
   * Consume the body and parse it as JSON.
   *
   * Throws `TypeError('Body already consumed')` if any body helper, `body`
   * iteration, `toFetchResponse()`, or `close()` already ran, and rejects if the
   * payload is not valid JSON.
   */
  async json(): Promise<unknown> {
    this.#assertUnused();
    try {
      return await this.#response.json();
    } finally {
      this.#consume();
    }
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
    this.#consume();
    return this.#response;
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
}
/**
 * Logical, origin-scoped relationship with a server.
 *
 * A session pins one origin and one protocol and carries the client's default
 * headers, giving a stable identity (`id`) that outlives any single transport
 * connection. For HTTP/1.1 and HTTP/2 it is a policy container — each request
 * still flows through the shared fetch pool — while an `h3` session keeps one
 * QUIC/H3 transport alive across requests until `reconnect()` or `close()`.
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
  #h3Transport: H3Transport | null = null;
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
  async #closeH3Transport(): Promise<void> {
    const transport = this.#h3Transport;
    if (transport === null) return;
    this.#h3Transport = null;
    transport.session.close();
    await transport.endpoint.close();
  }
  async #ensureH3Transport(
    url: URL,
    init: Pick<HttpRequestInit, 'tls' | 'quic'> = {},
  ): Promise<H3Transport> {
    let transport = this.#h3Transport;
    if (transport !== null) return transport;
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
      const conn = await endpoint.connect({
        ...quic,
        address: target.address,
        alpnProtocols: ['h3'],
        serverName: quic?.serverName ?? target.serverName,
      });
      return await this.#attachH3Connection(conn, endpoint);
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }
  async #attachH3Connection(conn: QuicConnection, endpoint: QuicEndpoint): Promise<H3Transport> {
    const h3 = await H3ClientSession.create(conn);
    const connection: HttpConnectionInfo = {
      id: nextConnectionId(),
      protocol: 'h3',
      transport: 'quic',
      localAddress: conn.localAddress,
      remoteAddress: conn.remoteAddress,
      alpnProtocol: 'h3',
      connectedAt: Date.now(),
    };
    const transport = {
      endpoint,
      session: h3,
      connection,
    };
    this.#h3Transport = transport;
    this.#currentConnection = connection;
    this.#events.push({
      type: 'connected',
      session: this,
      connection,
    });
    return transport;
  }
  async _attachH3TransportForTest(conn: QuicConnection): Promise<void> {
    await this.#closeH3Transport();
    const endpoint = { close: async () => {} } as QuicEndpoint;
    await this.#attachH3Connection(conn, endpoint);
  }
  async #h3Request(
    url: URL,
    method: string,
    headers: Headers,
    init: HttpRequestInit,
  ): Promise<Response> {
    const transport = await this.#ensureH3Transport(url, init);
    const response = await transport.session.request(url.href, {
      method,
      headers,
      body: init.body,
      trailers: init.trailers as any,
    } as H3FetchInit);
    return buildWireResponse({
      version: 'HTTP/3',
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body as any,
      url: url.href,
      redirected: false,
      inTrailers: response.trailers,
    });
  }
  async _request(input: string | URL, init: HttpRequestInit = {}): Promise<HttpResponse> {
    if (this.#state === 'closed') throw new Error('HTTP session closed');
    const url = resolveHttpUrl(this.#baseUrl, input);
    const method = init.method !== undefined ? String(init.method).toUpperCase() : 'GET';
    const headers = mergeHeaders(this.#headers, init.headers);
    const timing: {
      startTime: number;
      responseHeadersEnd?: number;
      bodyEnd?: number;
    } = { startTime: Date.now() };
    const response =
      this.protocol === 'h3'
        ? await this.#h3Request(url, method, headers, init)
        : await runtimeFetch(url.href, {
            method,
            headers,
            body: init.body,
            signal: init.signal ?? null,
            redirect: init.redirect,
            integrity: init.integrity,
            referrer: init.referrer,
            referrerPolicy: init.referrerPolicy,
            trailers: init.trailers,
            tls: init.tls ?? this.#client.tls,
            protocol: this.protocol,
          } as any);
    timing.responseHeadersEnd = Date.now();
    const protocol = protocolFromResponse(response, this.protocol);
    const connection: HttpConnectionInfo =
      this.protocol === 'h3' && this.#h3Transport !== null
        ? this.#h3Transport.connection
        : {
            id: nextConnectionId(),
            protocol,
            transport: transportFor(url, protocol),
            localAddress: null,
            remoteAddress: null,
            alpnProtocol: protocol === 'http/1.1' ? null : protocol,
            connectedAt: timing.startTime,
          };
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
        replayable: isReplayable(init.body),
        attempt: 1,
      },
      session: this,
      connection,
      protocol,
      timing,
      markBodyEnd: () => {
        timing.bodyEnd = Date.now();
      },
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
    const transport = await this.#ensureH3Transport(url, options);
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
    await this.#closeH3Transport();
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
    await this.#closeH3Transport();
    if (this.protocol === 'h2') await _closeFetchH2PoolEntry(this.origin);
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
