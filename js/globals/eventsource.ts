/**
* EventSource global for Server-Sent Events (SSE) clients.
*
* Implements the browser-shaped EventSource client over Fino's server-side
* networking stack. The global handles connection management, automatic
* reconnection with Last-Event-ID resumption, and EventTarget-based event
* dispatch. It extends EventTarget so `addEventListener()` /
* `removeEventListener()` work as expected.
*
* The client opens direct HTTP/1 socket or TLS connections and parses the SSE
* wire stream itself. It intentionally does not share the `fetch()` connection
* pool or provide HTTP/2 or HTTP/3 transport behavior in this release baseline.
* Transport-agnostic SSE parser and formatter primitives are documented in
* `fino:net/http/eventstream`.
*
* EventSource / SSE specification:
* https://html.spec.whatwg.org/multipage/server-sent-events.html
*
*
* ## Example
*
* ```ts no_run
*   const es = new EventSource('http://localhost:3000/events');
*   es.onopen    = () => { ... };
*   es.onmessage = (e) => { console.log(e.data); };
*   es.onerror   = (e) => { ... };
*   es.addEventListener('update', (e) => { ... });
*   // later:
*   es.close();
* ```
*
*
* ## SSE wire format
*
* Each event is one or more field lines followed by a blank line:
*   event: <type>\n       ← optional; defaults to "message"
*   data: <line1>\n
*   data: <line2>\n       ← multi-line data: joined with "\n"
*   id: <id>\n            ← optional; updates lastEventId buffer
*   retry: <ms>\n         ← optional; integer ms reconnection interval
*   \n                    ← blank line dispatches the event
*
* Lines starting with `:` are comments (ignored). Unknown field names are
* ignored. Line terminators: LF, CRLF, or bare CR (per W3C spec).
*
*
* ## Parser behavior
*
* - `id:` field value must not contain null (U+0000); otherwise ignored.
* - `retry:` value must be all ASCII digits; otherwise ignored.
* - An empty `id:` field (i.e. `id:\n`) sets lastEventId to "".
* - Events without any `data:` lines are not dispatched.
* - A field name with no colon means the entire line is the field name and
*   the value is empty string.
* - A single leading space after the colon is stripped from field values.
*
*
* ## EventSource reconnection (W3C spec + pragmatic additions)
*
* - Reconnects on: EOF (stream ended normally), network errors, and HTTP
*   status codes 429, 500, 502, 503, 504 (retriable errors).
* - Follows local HTTP redirects for 301, 302, 303, 307, and 308 responses,
*   resolving relative `Location` values against the current request URL.
*   Redirects always remain GET requests and are capped to prevent loops.
* - Does NOT reconnect on: wrong Content-Type, other HTTP error statuses.
* - HTTP 204 closes the stream gracefully without reconnecting.
* - Reconnection uses a configurable retry interval (default: 3000ms),
*   updated dynamically by `retry:` fields in the event stream.
* - The `Last-Event-ID` header is sent on every reconnect attempt once any
*   `id:` field has been seen — including an empty `id:` field, which is sent
*   as an empty header value per the WHATWG spec rather than omitted.
*
* ## Credentials, CORS, and TLS
*
* This is a server-side EventSource implementation. It supports explicit
* caller-provided headers for credentials such as bearer tokens, but it does
* not implement browser cookie credential modes, an implicit cookie jar, or
* browser CORS enforcement. `Set-Cookie` response headers are ignored; callers
* that need cookies must provide a `Cookie` header explicitly. TLS verification
* is enabled by default for `https:` URLs. Tests and private deployments may
* pass a pinned CA path through `tls.ca`; disabling certificate verification
* with `tls.rejectUnauthorized: false` should be limited to local development.
*/
import { encodeUtf8 } from 'internal:encoding';
import { Headers, parseResponse } from '../net/http/index.ts';
import type { SseEvent } from '../net/http/eventstream.ts';
import { EventSourceReader } from '../net/http/eventstream.ts';
import { Socket } from '../net/socket.ts';
import { TlsSocket } from '../net/tls.ts';
import { lookup } from '../net/dns.ts';
import * as loop from '../internal/runtime/loop.ts';
import { EventTarget, Event } from './eventtarget.ts';
import { MessageEvent } from './messaging.ts';
import { URL } from './url.ts';
import { DOMException } from './encoding.ts';
import type { Address, IPv4Address, IPv6Address } from '../net/socket.ts';
/**
* Options for the EventSource client connection.
*
* Headers are sent on the initial request and reconnect attempts. The client
* also adds `Last-Event-ID` during reconnect when an ID has been seen.
*
* ```ts no_run
* const es = new EventSource('https://example.com/events', {
*   headers: { authorization: 'Bearer token' },
* });
* ```
*/
export interface EventSourceInit {
  /** Reflects the HTML EventSource credential mode flag.
  *
  * Fino does not maintain a browser cookie jar or enforce browser CORS policy;
  * this option is exposed for standards-shaped API compatibility.
  *
  * ```ts no_run
  * new EventSource(url, { withCredentials: true }).withCredentials; // true
  * ```
  */
  withCredentials?: boolean;
  /** Extra HTTP headers for the SSE request.
  *
  * ```ts no_run
  * new EventSource(url, { headers: new Headers({ authorization: 'Bearer t' }) });
  * ```
  */
  headers?: Record<string, string> | Headers;
  /** TLS trust options for `https:` EventSource connections.
  *
  * `rejectUnauthorized` defaults to `true`; `ca` points at a PEM CA file.
  * These options are ignored for `http:` URLs.
  *
  * ```ts no_run
  * new EventSource('https://localhost/events', { tls: { ca: '/tmp/test-ca.pem' } });
  * ```
  */
  tls?: {
    ca?: string;
    rejectUnauthorized?: boolean;
  };
}
/**
* Shape of the reader half of a split socket: an async byte stream that can be
* closed to abort an in-flight read.
*/
interface ClosableAsyncByteReader extends AsyncIterable<Uint8Array | ArrayBuffer> {
  close(): void;
}
// ---------------------------------------------------------------------------
// EventSource — spec-compliant SSE client
// ---------------------------------------------------------------------------
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
/**
*  HTTP status codes that trigger reconnection rather than permanent failure. */
const RETRIABLE_STATUSES = new Set([
  429,
  500,
  502,
  503,
  504
]);
/**
*  HTTP redirect statuses followed by the client before opening the stream. */
const REDIRECT_STATUSES = new Set([
  301,
  302,
  303,
  307,
  308
]);
/**
*  Redirect cap for one connection attempt. */
const MAX_REDIRECTS = 20;
/**
*  Default reconnection interval per W3C spec (3 seconds). */
const DEFAULT_RETRY_MS = 3e3;
/**
* Base URL for resolving relative EventSource URLs, taken from
* `globalThis.location` when a host embedder defines one.
*/
function eventSourceBaseUrl(): string | undefined {
  const location = (globalThis as {
    location?: unknown;
  }).location;
  if (location === undefined || location === null) return undefined;
  return String(location);
}
/**
* Resolve and validate the constructor URL against the optional base.
*
* Throws a `SyntaxError` DOMException when the URL cannot be parsed or its
* authority contains control characters or spaces.
*/
function resolveEventSourceUrl(url: string): string {
  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*[\u0000-\u0020]/.test(url)) {
      throw new Error('invalid URL authority');
    }
    return new URL(url, eventSourceBaseUrl()).href;
  } catch {
    throw new DOMException(`EventSource URL is invalid: ${url}`, 'SyntaxError');
  }
}
/**
* W3C EventSource — a spec-compliant SSE client.
*
* Manages its own HTTP/1.1 connection (plain or TLS), reconnects after stream
* EOF, network errors, and retriable HTTP statuses, resumes from the last
* event ID, and dispatches events through the EventTarget interface. The
* reconnection delay is a fixed interval — 3000ms by default, updated when the
* server sends a `retry:` field — not an exponential backoff.
*
* Instances begin connecting as soon as they are constructed. Named events
* (`event: update`) are delivered to `addEventListener('update', ...)`
* listeners; events without an `event:` field dispatch as `message`. Call
* `close()` to stop the stream and suppress any further reconnection.
*
* ```ts no_run
* const es = new EventSource('http://localhost:3000/events');
* es.onopen = () => console.log('connected');
* es.onmessage = (e) => console.log('message:', e.data);
* es.onerror = () => console.log('disconnected; will retry');
* es.addEventListener('update', (e) => console.log('update:', e.data));
* // later:
* es.close();
* ```
*/
export class EventSource extends EventTarget {
  /** Ready state value while connecting or reconnecting.
  *
  * ```ts no_run
  * if (es.readyState === EventSource.CONNECTING) console.log('connecting');
  * ```
  */
  static CONNECTING = CONNECTING;
  /** Ready state value while the stream is open.
  *
  * ```ts no_run
  * if (es.readyState === EventSource.OPEN) console.log('open');
  * ```
  */
  static OPEN = OPEN;
  /** Ready state value after `close()` or terminal failure.
  *
  * ```ts no_run
  * if (es.readyState === EventSource.CLOSED) console.log('closed');
  * ```
  */
  static CLOSED = CLOSED;
  /**
  * Resolved absolute URL the client connects to; backs the `url` getter.
  *
  * @internal
  */
  #url: string;
  /**
  * Current lifecycle state — CONNECTING (0), OPEN (1), or CLOSED (2); backs
  * the `readyState` getter. The connection loop checks it after every await
  * so `close()` takes effect at the next suspension point.
  *
  * @internal
  */
  #readyState: number;
  // null = no id: field ever received; '' = empty id: field received.
  // The distinction matters for Last-Event-ID: an empty id should still be
  // sent on reconnect (with an empty value) per the WHATWG EventSource spec.
  /**
  * Most recent `id:` field value, or `null` if no `id:` field has ever been
  * received. When non-null (including the empty string) it is sent as the
  * `Last-Event-ID` request header on reconnect; backs the `lastEventId`
  * getter, which coalesces `null` to `''`.
  *
  * @internal
  */
  #lastEventId: string | null;
  /**
  * Reconnection delay in milliseconds. Starts at the spec default (3000ms)
  * and is replaced whenever the server sends a valid `retry:` field.
  *
  * @internal
  */
  #retryInterval: number;
  /**
  * Caller-provided headers from `EventSourceInit.headers`, sent on the
  * initial request and on every reconnect attempt.
  *
  * @internal
  */
  #extraHeaders: Headers;
  /** TLS trust options from `EventSourceInit.tls`, applied on `https:` connects. */
  #tlsOptions: EventSourceInit['tls'] | undefined;
  /** Reflected `EventSourceInit.withCredentials` flag; carries no cookie or CORS behavior. */
  #withCredentials: boolean;
  /**
  * Reader half of the active socket, retained so `close()` can cancel an
  * in-flight read and unwind the connection loop.
  *
  * @internal
  */
  #currentReader: {
    close(): void;
  } | null;
  /** Pending reconnect timer, retained so `close()` can cancel the wait. */
  #retryTimer: loop.CancelablePromise | null;
  /**
  * Backing store for the `onopen` handler property, registered with the
  * EventTarget machinery by the setter.
  *
  * @internal
  */
  #onopen: ((e: Event) => void) | null;
  /**
  * Backing store for the `onmessage` handler property, registered with the
  * EventTarget machinery by the setter.
  *
  * @internal
  */
  #onmessage: ((e: MessageEvent) => void) | null;
  /**
  * Backing store for the `onerror` handler property, registered with the
  * EventTarget machinery by the setter.
  *
  * @internal
  */
  #onerror: ((e: Event) => void) | null;
  /**
  * Create and immediately start an SSE client.
  *
  * Only `http:` and `https:` URLs are supported. Connection errors dispatch
  * `error` and reconnect for retriable statuses unless `close()` is called.
  *
  * Throws a `SyntaxError` DOMException if the URL cannot be parsed (relative
  * URLs resolve against `globalThis.location` when a host defines one).
  *
  * ```ts no_run
  * const es = new EventSource('https://example.com/events', {
  *   headers: { authorization: 'Bearer token' },
  * });
  * es.onmessage = (event) => console.log(event.data);
  * ```
  */
  constructor(url: string, init?: EventSourceInit) {
    super();
    this.#url = resolveEventSourceUrl(String(url));
    this.#readyState = CONNECTING;
    this.#lastEventId = null;
    this.#retryInterval = DEFAULT_RETRY_MS;
    this.#extraHeaders = init?.headers ? new Headers(init.headers) : new Headers();
    this.#tlsOptions = init?.tls;
    this.#withCredentials = init?.withCredentials === true;
    this.#currentReader = null;
    this.#retryTimer = null;
    this.#onopen = null;
    this.#onmessage = null;
    this.#onerror = null;
    // Kick off the connection loop. Errors are handled internally.
    this.#run().catch(function swallowEvtSrcErr() {});
  }
  /** Current ready state: CONNECTING (0), OPEN (1), or CLOSED (2).
  *
  * ```ts no_run
  * console.log(es.readyState);
  * ```
  */
  get readyState() {
    return this.#readyState;
  }
  /** The URL passed to the constructor.
  *
  * ```ts no_run
  * console.log(es.url);
  * ```
  */
  get url() {
    return this.#url;
  }
  /** The last event ID received from the server.
  *
  * Sent as `Last-Event-ID` on reconnect. Returns an empty string before any
  * `id:` field is received.
  *
  * ```ts no_run
  * console.log(es.lastEventId);
  * ```
  */
  get lastEventId() {
    return this.#lastEventId ?? '';
  }
  /** Whether the constructor was created with `withCredentials: true`.
  *
  * Fino exposes the standards-shaped reflected property, but does not add
  * browser-managed cookies or CORS enforcement.
  *
  * ```ts no_run
  * const es = new EventSource('/events', { withCredentials: true });
  * console.log(es.withCredentials);
  * ```
  */
  get withCredentials() {
    return this.#withCredentials;
  }
  /** Callback for `open` events (connection established).
  *
  * ```ts no_run
  * es.onopen = () => console.log('open');
  * ```
  */
  get onopen() {
    return this.#onopen;
  }
  /** Set the `open` event callback, or `null` to clear it.
  *
  * ```ts no_run
  * es.onopen = null;
  * ```
  */
  set onopen(fn: ((e: Event) => void) | null) {
    if (this.#onopen !== null) this.removeEventListener('open', this.#onopen as any);
    this.#onopen = typeof fn === 'function' ? fn : null;
    if (this.#onopen !== null) this.addEventListener('open', this.#onopen as any);
  }
  /** Callback for `message` events (default-type SSE events).
  *
  * ```ts no_run
  * es.onmessage = (event) => console.log(event.data);
  * ```
  */
  get onmessage() {
    return this.#onmessage;
  }
  /** Set the `message` event callback, or `null` to clear it.
  *
  * ```ts no_run
  * es.onmessage = null;
  * ```
  */
  set onmessage(fn: ((e: MessageEvent) => void) | null) {
    if (this.#onmessage !== null) this.removeEventListener('message', this.#onmessage as any);
    this.#onmessage = typeof fn === 'function' ? fn : null;
    if (this.#onmessage !== null) this.addEventListener('message', this.#onmessage as any);
  }
  /** Callback for `error` events (connection errors and fatal failures).
  *
  * ```ts no_run
  * es.onerror = () => console.log('stream error');
  * ```
  */
  get onerror() {
    return this.#onerror;
  }
  /** Set the `error` event callback, or `null` to clear it.
  *
  * ```ts no_run
  * es.onerror = null;
  * ```
  */
  set onerror(fn: ((e: Event) => void) | null) {
    if (this.#onerror !== null) this.removeEventListener('error', this.#onerror as any);
    this.#onerror = typeof fn === 'function' ? fn : null;
    if (this.#onerror !== null) this.addEventListener('error', this.#onerror as any);
  }
  /**
  * Close the connection and prevent any further reconnection.
  * Idempotent — safe to call multiple times.
  *
  * ```ts no_run
  * es.close();
  * ```
  */
  close() {
    if (this.#readyState === CLOSED) return;
    this.#readyState = CLOSED;
    if (this.#retryTimer !== null) {
      this.#retryTimer.cancel();
      this.#retryTimer = null;
    }
    // Closing the reader (if active) causes the next read() to return null,
    // which terminates the body iterator and unwinds the connection loop.
    if (this.#currentReader) {
      try {
        this.#currentReader.close();
      } catch (_) {}
      this.#currentReader = null;
    }
  }
  /**
  * Closes the source when disposed, enabling `using` declarations.
  *
  * ```ts no_run
  * {
  *   using es = new EventSource('http://localhost:3000/events');
  *   es.onmessage = (e) => console.log(e.data);
  *   // ...
  * } // closed automatically at end of block
  * ```
  */
  [Symbol.dispose](): void {
    this.close();
  }
  // ---------------------------------------------------------------------------
  // Internal: connection and reconnection loop
  // ---------------------------------------------------------------------------
  /**
  * Connection and reconnection loop, started by the constructor.
  *
  * Each iteration resolves DNS, connects (TCP or TLS), sends the GET request,
  * follows local redirects, validates the response status and content type,
  * then feeds the body through `EventSourceReader` and dispatches events
  * until the stream ends. Retriable failures wait `#retryInterval` and loop;
  * fatal ones (or `close()`) end the loop with readyState CLOSED.
  *
  * @internal
  */
  async #run() {
    while (this.#readyState !== CLOSED) {
      this.#readyState = CONNECTING;
      let sock: Socket | TlsSocket | null = null;
      let reader: ClosableAsyncByteReader | null = null;
      try {
        let requestUrl = this.#url;
        let redirectCount = 0;
        let response: Awaited<ReturnType<typeof parseResponse>>;
        let origin = '';
        while (true) {
          // ---- Parse URL ------------------------------------------------------
          const parsed = new URL(requestUrl);
          const isHttps = parsed.protocol === 'https:';
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('EventSource URL must use http: or https:');
          }
          const hostname = parsed.hostname;
          const port = parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80;
          const path = parsed.pathname + parsed.search || '/';
          origin = parsed.origin;
          // ---- DNS lookup -----------------------------------------------------
          const { address, family } = await lookup(hostname);
          if (this.#readyState === CLOSED) return;
          const addr: IPv4Address | IPv6Address = family === 6 ? {
            family: 'ipv6',
            ip: address,
            port
          } : {
            family: 'ipv4',
            ip: address,
            port
          };
          // ---- TCP / TLS connect ----------------------------------------------
          if (isHttps) {
            sock = await TlsSocket.connect(addr, {
              hostname,
              ca: this.#tlsOptions?.ca,
              rejectUnauthorized: this.#tlsOptions?.rejectUnauthorized
            });
          } else {
            sock = await Socket.connect(addr);
          }
          if (this.#readyState === CLOSED) {
            _closeSocket(sock);
            return;
          }
          // ---- Split and register reader for close() cancellation -------------
          const [r, writer] = sock.split();
          reader = r;
          this.#currentReader = reader;
          // ---- Build and send HTTP request ------------------------------------
          const headers = new Headers(this.#extraHeaders);
          headers.set('accept', 'text/event-stream');
          headers.set('cache-control', 'no-store');
          if (this.#lastEventId !== null) {
            headers.set('last-event-id', this.#lastEventId);
          }
          const hostHeader = parsed.port ? `${hostname}:${parsed.port}` : hostname;
          let reqStr = `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\n`;
          for (const [name, value] of headers) {
            reqStr += `${name}: ${value}\r\n`;
          }
          reqStr += '\r\n';
          await _writeToSocket(writer, encodeUtf8(reqStr));
          if (this.#readyState === CLOSED) return;
          // ---- Parse HTTP response headers -----------------------------------
          response = await parseResponse(reader);
          if (this.#readyState === CLOSED) return;
          if (!REDIRECT_STATUSES.has(response.status)) break;
          const location = response.headers.get('location');
          if (location === null) {
            this.#readyState = CLOSED;
            this.#fireError();
            return;
          }
          if (++redirectCount > MAX_REDIRECTS) {
            this.#readyState = CLOSED;
            this.#fireError();
            return;
          }
          requestUrl = new URL(location, parsed.href).href;
          if (this.#currentReader === reader) this.#currentReader = null;
          reader = null;
          _closeSocket(sock);
          sock = null;
        }
        const status = response.status;
        const ct = response.headers.get('content-type') ?? '';
        // ---- HTTP 204: graceful server-side close ----------------------------
        if (status === 204) {
          this.#readyState = CLOSED;
          return;
        }
        // ---- Retriable server error (429, 5xx) --------------------------------
        if (RETRIABLE_STATUSES.has(status)) {
          this.#fireError();
          if (this.#readyState === CLOSED) return;
          if (!await this.#waitForRetry()) return;
          continue;
        }
        // ---- Fatal: wrong status or content-type -----------------------------
        if (status !== 200 || !ct.includes('text/event-stream')) {
          this.#readyState = CLOSED;
          this.#fireError();
          return;
        }
        // ---- Connection established — begin reading events -------------------
        this.#readyState = OPEN;
        this.#fireOpen(origin);
        if (this.#readyState === CLOSED) return;
        // Feed the response body through the SSE parser. The body is an async
        // iterable of byte chunks from the socket (EOF-delimited per HTTP rules).
        if (response.body === null) {
          this.#readyState = CONNECTING;
          this.#fireError();
          if (!await this.#waitForRetry()) return;
          continue;
        }
        const esReader = new EventSourceReader(response.body);
        for await (const event of esReader) {
          if (this.#readyState === CLOSED) return;
          // Server-side retry interval update
          if (event.retry !== null) this.#retryInterval = event.retry;
          // Persist last event ID (EventSourceReader already validated it)
          if (event.id !== null) this.#lastEventId = event.id;
          this.#fireMessage(event, origin);
        }
        // ---- Normal EOF: server closed the stream — reconnect per spec -------
        if (this.#readyState === CLOSED) return;
        this.#readyState = CONNECTING;
        this.#fireError();
        if (!await this.#waitForRetry()) return;
      } catch (_err) {
        // ---- Network / connection error: reconnect ---------------------------
        if (this.#readyState === CLOSED) return;
        this.#readyState = CONNECTING;
        this.#fireError();
        if (!await this.#waitForRetry()) return;
      } finally {
        // Clean up the current reader reference; close socket if still open.
        if (this.#currentReader === reader) this.#currentReader = null;
        if (sock !== null) {
          try {
            _closeSocket(sock);
          } catch (_) {}
        }
      }
    }
  }
  /**
  * Sleeps for the current retry interval before a reconnect attempt. Returns
  * `false` when the source was closed while waiting, telling the caller to
  * stop reconnecting.
  */
  async #waitForRetry(): Promise<boolean> {
    const timer = loop.timeout(this.#retryInterval);
    this.#retryTimer = timer;
    try {
      await timer;
    } finally {
      if (this.#retryTimer === timer) this.#retryTimer = null;
    }
    return this.#readyState !== CLOSED;
  }
  // ---------------------------------------------------------------------------
  // Internal: event dispatching
  // ---------------------------------------------------------------------------
  /**
  * Dispatches an `open` event after a 200 `text/event-stream` response is
  * accepted.
  *
  * @internal
  */
  #fireOpen(origin: string) {
    const e = new Event('open');
    this.dispatchEvent(e);
  }
  /**
  * Wraps a parsed SSE event in a `MessageEvent` — typed by its `event:` field
  * (default `message`) and carrying the current lastEventId and origin — and
  * dispatches it.
  *
  * @internal
  */
  #fireMessage(event: SseEvent, origin: string) {
    const e = new MessageEvent(event.type, {
      data: event.data,
      lastEventId: this.#lastEventId,
      origin
    });
    this.dispatchEvent(e);
  }
  /**
  * Dispatches an `error` event; fired for retriable failures (before a
  * reconnect wait) and terminal failures alike.
  *
  * @internal
  */
  #fireError() {
    const e = new Event('error');
    this.dispatchEvent(e);
  }
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
* Write bytes to a socket writer and flush the coalesce buffer so the request
* reaches the wire immediately.
*/
async function _writeToSocket(writer: {
  write(data: Uint8Array): Promise<void>;
  flush(): Promise<void>;
}, bytes: Uint8Array): Promise<void> {
  await writer.write(bytes);
  await writer.flush();
}
/**
* Close a Socket or TlsSocket if it is not already closed.
*/
function _closeSocket(sock: {
  closed: boolean;
  close(): void;
}): void {
  if (sock && !sock.closed) sock.close();
}
