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

import { Headers, Request, Response, buildWireResponse } from './index.mts';
import { fetch as runtimeFetch } from '../../internal/globals/fetch.mts';
import { EventSource } from './eventsource.mts';
import type { EventSourceInit } from './eventsource.mts';
import { WebSocketConnection } from './websocket.mts';
import type { WebSocketConnectOptions } from './websocket.mts';
import type { H3FetchInit } from './h3.mts';
import { QuicEndpoint } from '../quic.mts';
import { H3ClientSession } from '../../internal/net/http/h3/client.mts';
import { resolveH3ConnectAddress } from '../../internal/net/http/h3/resolve.mts';

/**
 * Protocols selectable by `HttpClient` and `HttpSession`.
 */
export type HttpClientProtocol = 'http/1.1' | 'h2' | 'h3';

/**
 * HTTP transport kind associated with connection metadata.
 */
export type HttpClientTransport = 'tcp' | 'tls' | 'quic';

/**
 * Headers accepted by client and request options.
 */
export type HttpHeadersInit = Headers | string[][] | Record<string, string> | null | undefined;

interface MinimalAbortSignal {
  aborted: boolean;
  reason: unknown;
  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void;
  removeEventListener(type: string, fn: () => void): void;
}

/**
 * Options passed to `new HttpClient()`.
 */
export interface HttpClientOptions {
  /** Base URL used to resolve relative request, SSE, and WebSocket paths. */
  baseUrl?: string | URL;
  /** Headers applied to every request unless overridden. */
  headers?: HttpHeadersInit;
  /** Preferred protocols. The first entry is used for explicit sessions. */
  protocols?: readonly HttpClientProtocol[];
  /** TLS options forwarded to the underlying fetch/EventSource transports. */
  tls?: {
    ca?: string;
    rejectUnauthorized?: boolean;
  };
}

/**
 * Per-request options for `HttpClient.request()` and `HttpSession.request()`.
 */
export interface HttpRequestInit {
  method?: string;
  headers?: HttpHeadersInit;
  body?: unknown;
  signal?: MinimalAbortSignal | null;
  redirect?: 'follow' | 'error' | 'manual';
  integrity?: string;
  referrerPolicy?: 'no-referrer' | 'no-referrer-when-downgrade' | 'origin' | 'origin-when-cross-origin' | 'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url' | '';
  referrer?: string;
  trailers?: Headers | (() => Headers | Promise<Headers>);
  tls?: HttpClientOptions['tls'];
  quic?: H3FetchInit['quic'];
}

/**
 * Request shape accepted by `HttpSession.request()`.
 */
export interface HttpSessionRequest extends HttpRequestInit {
  path?: string | URL;
  url?: string | URL;
}

/**
 * Options for explicit logical sessions.
 */
export interface HttpSessionOptions {
  /** Pin the session to one protocol. Defaults to the client's first protocol. */
  protocol?: HttpClientProtocol;
}

/**
 * Reconnect options for future transport replacement behavior.
 */
export interface ReconnectOptions {
  reason?: unknown;
}

/**
 * Close options for client and session lifecycle operations.
 */
export interface CloseOptions {
  reason?: unknown;
}

/**
 * Request metadata attached to an `HttpResponse`.
 */
export interface HttpRequestInfo {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly idempotent: boolean;
  readonly replayable: boolean;
  readonly attempt: number;
}

/**
 * Transport connection metadata attached to an `HttpResponse`.
 */
export interface HttpConnectionInfo {
  readonly id: string;
  readonly protocol: HttpClientProtocol;
  readonly transport: HttpClientTransport;
  readonly localAddress: unknown | null;
  readonly remoteAddress: unknown | null;
  readonly alpnProtocol: string | null;
  readonly connectedAt: number;
}

/**
 * Basic request/response timing metadata.
 */
export interface HttpResponseTiming {
  readonly startTime: number;
  readonly responseHeadersEnd?: number;
  readonly bodyEnd?: number;
}

/**
 * Lifecycle event surfaced by a logical HTTP session.
 */
export type HttpSessionEvent =
  | { type: 'connecting'; session: HttpSession }
  | { type: 'connected'; session: HttpSession; connection: HttpConnectionInfo }
  | { type: 'reconnecting'; session: HttpSession; reason: unknown }
  | { type: 'reconnected'; session: HttpSession; connection: HttpConnectionInfo }
  | { type: 'closed'; session: HttpSession; reason?: unknown };

/**
 * Options for `HttpClient.sse()` and `HttpSession.sse()`.
 */
export interface SseOptions extends EventSourceInit {
  headers?: HttpHeadersInit;
}

/**
 * Options for `HttpClient.websocket()` and `HttpSession.websocket()`.
 */
export interface HttpWebSocketOptions extends WebSocketConnectOptions {
  headers?: Record<string, string> | Headers;
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

function protocolFromResponse(response: Response, fallback: HttpClientProtocol): HttpClientProtocol {
  if (response.version === 'HTTP/2') return 'h2';
  if (response.version === 'HTTP/3') return 'h3';
  return fallback;
}

function isIdempotent(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS' || upper === 'TRACE' || upper === 'PUT' || upper === 'DELETE';
}

function isReplayable(body: unknown): boolean {
  if (body == null) return true;
  const candidate = body as { [Symbol.asyncIterator]?: unknown };
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
  const url = baseUrl === undefined ? new URL(String(input)) : new URL(String(input), String(baseUrl));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`HttpClient: non-HTTP/S URL is not allowed: '${url.href}'`);
  }
  return url;
}

function resolveWebSocketUrl(baseUrl: string | URL | undefined, input: string | URL): URL {
  const base = baseUrl === undefined ? undefined : String(baseUrl).replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const url = base === undefined ? new URL(String(input)) : new URL(String(input), base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError(`HttpClient.websocket: URL must use ws: or wss:, got '${url.href}'`);
  }
  return url;
}

function unsupportedWebSocket(protocol: HttpClientProtocol): Error {
  return new Error(`WebSocket over ${protocol} requires Extended CONNECT, which is not supported yet`);
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

async function* responseBody(response: Response, markConsumed: () => void): AsyncIterable<Uint8Array> {
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
 * Rich HTTP response returned by `HttpClient.request()`.
 */
export class HttpResponse {
  readonly #response: Response;
  readonly #markBodyEnd: () => void;
  #consumed = false;

  /** HTTP status code. */
  readonly status: number;
  /** HTTP reason phrase. */
  readonly statusText: string;
  /** Response headers. */
  readonly headers: Headers;
  /** Final response URL. */
  readonly url: string;
  /** Whether redirects were followed. */
  readonly redirected: boolean;
  /** Request metadata. */
  readonly request: HttpRequestInfo;
  /** Logical session used for the request. */
  readonly session: HttpSession;
  /** Current transport connection metadata. */
  readonly connection: HttpConnectionInfo | null;
  /** Protocol used for this response. */
  readonly protocol: HttpClientProtocol;
  /** Incoming trailer headers. */
  readonly trailers: Promise<Headers>;
  /** Request/response timing metadata. */
  readonly timing: HttpResponseTiming;
  /** Streaming response body. */
  readonly body: AsyncIterable<Uint8Array> | null;

  /**
   * Construct an `HttpResponse` around a Fetch-compatible `Response`.
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
    this.body = init.response.body === null ? null : responseBody(init.response, this.#consume.bind(this));
  }

  #consume(): void {
    this.#consumed = true;
    this.#markBodyEnd();
  }

  #assertUnused(): void {
    if (this.#consumed || this.#response.bodyUsed) throw new TypeError('Body already consumed');
  }

  /** Consume the body and return an `ArrayBuffer`. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    this.#assertUnused();
    try {
      return await this.#response.arrayBuffer();
    } finally {
      this.#consume();
    }
  }

  /** Consume the body and return bytes. */
  async bytes(): Promise<Uint8Array> {
    this.#assertUnused();
    try {
      return await this.#response.bytes();
    } finally {
      this.#consume();
    }
  }

  /** Consume the body and decode it as UTF-8 text. */
  async text(): Promise<string> {
    this.#assertUnused();
    try {
      return await this.#response.text();
    } finally {
      this.#consume();
    }
  }

  /** Consume the body and parse it as JSON. */
  async json(): Promise<unknown> {
    this.#assertUnused();
    try {
      return await this.#response.json();
    } finally {
      this.#consume();
    }
  }

  /** Adapt this response into a Fetch-compatible `Response`. */
  toFetchResponse(): Response {
    this.#assertUnused();
    this.#consume();
    return this.#response;
  }

  /** Cancel or drain response resources and mark the body consumed. */
  async close(): Promise<void> {
    if (this.#consumed) return;
    const body = this.#response.body as unknown as { cancel?: () => Promise<void> } | null;
    this.#consume();
    if (body && typeof body.cancel === 'function') {
      try { await body.cancel(); } catch (_) {}
    }
  }
}

/**
 * Logical origin-scoped HTTP session.
 */
export class HttpSession {
  readonly #client: HttpClient;
  readonly #headers: Headers;
  readonly #baseUrl: URL;
  #state: 'connecting' | 'ready' | 'draining' | 'closed' = 'ready';
  #currentConnection: HttpConnectionInfo | null = null;
  #events: HttpSessionEvent[] = [];
  #h3Transport: H3Transport | null = null;

  /** Stable logical session identity. */
  readonly id: string;
  /** Origin URL for the session. */
  readonly origin: string;
  /** Pinned protocol. */
  readonly protocol: HttpClientProtocol;

  /**
   * Construct a logical session. Applications should use
   * `HttpClient.session()` instead.
   */
  constructor(client: HttpClient, origin: URL, protocol: HttpClientProtocol, headers: Headers) {
    this.#client = client;
    this.#baseUrl = origin;
    this.#headers = headers;
    this.id = nextSessionId();
    this.origin = origin.origin;
    this.protocol = protocol;
  }

  /** Current lifecycle state. */
  get state(): 'connecting' | 'ready' | 'draining' | 'closed' { return this.#state; }

  /** Current transport connection, if one is active or last used. */
  get currentConnection(): HttpConnectionInfo | null { return this.#currentConnection; }

  /** Async iterable of lifecycle events emitted so far. */
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

  async #h3Request(url: URL, method: string, headers: Headers, init: HttpRequestInit): Promise<Response> {
    let transport = this.#h3Transport;
    if (transport === null) {
      const target = await resolveH3ConnectAddress(url);
      const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
      const tls = init.tls ?? this.#client.tls;
      const quic = init.quic ?? {
        ...(tls?.ca !== undefined ? { ca: tls.ca } : {}),
        ...(tls?.rejectUnauthorized === false ? { verifyPeer: false } : {}),
      };
      try {
        const conn = await endpoint.connect({
          ...quic,
          address: target.address,
          alpnProtocols: ['h3'],
          serverName: quic?.serverName ?? target.serverName,
        });
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
        transport = { endpoint, session: h3, connection };
        this.#h3Transport = transport;
        this.#currentConnection = connection;
        this.#events.push({ type: 'connected', session: this, connection });
      } catch (error) {
        await endpoint.close();
        throw error;
      }
    }

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
    const timing: { startTime: number; responseHeadersEnd?: number; bodyEnd?: number } = { startTime: Date.now() };
    const response = this.protocol === 'h3'
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
    const connection: HttpConnectionInfo = this.protocol === 'h3' && this.#h3Transport !== null
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
      const event: HttpSessionEvent = { type: 'connected', session: this, connection };
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
      markBodyEnd: () => { timing.bodyEnd = Date.now(); },
    });
  }

  /** Send a request over this logical session. */
  request(init: HttpSessionRequest = {}): Promise<HttpResponse> {
    return this._request(init.url ?? init.path ?? '/', init);
  }

  /** Open an EventSource pinned to this session's origin and headers. */
  sse(path: string | URL, options: SseOptions = {}): EventSource {
    const url = resolveHttpUrl(this.#baseUrl, path);
    const headers = mergeHeaders(this.#headers, options.headers);
    return new EventSource(url.href, {
      ...options,
      headers,
      tls: options.tls ?? this.#client.tls,
    });
  }

  /** Open a WebSocket pinned to this session. */
  async websocket(path: string | URL, options: HttpWebSocketOptions = {}): Promise<WebSocketConnection> {
    if (this.protocol !== 'http/1.1') throw unsupportedWebSocket(this.protocol);
    const url = resolveWebSocketUrl(this.#baseUrl, path);
    const headers = mergeHeaders(this.#headers, options.headers);
    const socket = WebSocketConnection.connect(url, {
      ...options,
      headers: headersToRecord(headers),
    });
    return waitForWebSocketOpen(socket);
  }

  /** Reconnect this logical session while preserving identity. */
  async reconnect(options: ReconnectOptions = {}): Promise<void> {
    if (this.#state === 'closed') throw new Error('HTTP session closed');
    this.#events.push({ type: 'reconnecting', session: this, reason: options.reason });
    await this.#closeH3Transport();
    this.#currentConnection = null;
  }

  /** Close the logical session. */
  async close(options: CloseOptions = {}): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    await this.#closeH3Transport();
    this.#events.push({ type: 'closed', session: this, reason: options.reason });
  }
}

/**
 * Reusable HTTP client with default policy and logical sessions.
 */
export class HttpClient {
  readonly #baseUrl?: URL;
  readonly #headers: Headers;
  readonly #protocols: readonly HttpClientProtocol[];
  readonly #sessions = new Map<string, HttpSession>();
  #closed = false;

  /** TLS options inherited by requests and SSE helpers. */
  readonly tls?: HttpClientOptions['tls'];

  /** Construct a reusable client. */
  constructor(options: HttpClientOptions = {}) {
    this.#baseUrl = options.baseUrl !== undefined ? resolveHttpUrl(undefined, options.baseUrl) : undefined;
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

  /** Send a request and return rich response metadata. */
  async request(input: string | URL | Request, init: HttpRequestInit = {}): Promise<HttpResponse> {
    this.#assertOpen();
    const url = input instanceof Request
      ? resolveHttpUrl(this.#baseUrl, input.url)
      : resolveHttpUrl(this.#baseUrl, input);
    const requestInit = input instanceof Request
      ? {
          ...init,
          method: input.method,
          headers: mergeHeaders(input.headers, init.headers),
          body: init.body !== undefined ? init.body : (input.hasBody ? input.body : undefined),
        }
      : init;
    const session = await this.#sessionFor(url);
    return session._request(url, requestInit);
  }

  /** Send a request and adapt the result into a standard `Response`. */
  async fetch(input: string | URL | Request, init: HttpRequestInit = {}): Promise<Response> {
    const response = await this.request(input, init);
    return response.toFetchResponse();
  }

  /** Create or retrieve a logical session for an origin. */
  async session(origin: string | URL, options: HttpSessionOptions = {}): Promise<HttpSession> {
    this.#assertOpen();
    const url = resolveHttpUrl(this.#baseUrl, origin);
    return this.#sessionFor(url, options.protocol);
  }

  /** Open an EventSource using this client's base URL and default headers. */
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

  /** Open a WebSocket using this client's base URL and default headers. */
  async websocket(input: string | URL, options: HttpWebSocketOptions = {}): Promise<WebSocketConnection> {
    this.#assertOpen();
    const url = resolveWebSocketUrl(this.#baseUrl, input);
    const headers = mergeHeaders(this.#headers, options.headers);
    const socket = WebSocketConnection.connect(url, {
      ...options,
      headers: headersToRecord(headers),
    });
    return waitForWebSocketOpen(socket);
  }

  /** Close idle sessions. Currently closes all logical sessions. */
  async closeIdleSessions(): Promise<void> {
    for (const session of this.#sessions.values()) await session.close();
    this.#sessions.clear();
  }

  /** Close this client and all sessions. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.closeIdleSessions();
  }
}
