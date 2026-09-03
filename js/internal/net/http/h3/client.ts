/**
 * internal:net/http/h3/client - HTTP/3 client session over QUIC.
 *
 * Drives the client half of an HTTP/3 connection: it wraps an
 * already-established `QuicConnection`, binds the three mandatory local
 * unidirectional streams (control + QPACK encoder/decoder), and translates
 * nghttp3's stream callbacks into Fetch-compatible `Response` objects. Request
 * submission, response header/body/trailer assembly, GOAWAY handling, and
 * stream close/error propagation all live here. Public client APIs — `fetch()`
 * and `HttpClient` in `fino:net/http` — reach this module indirectly; callers
 * rarely instantiate an `H3ClientSession` directly.
 *
 * A session is created with `H3ClientSession.create(conn)` after the QUIC
 * handshake completes with ALPN `h3`. Each `request()` opens a fresh
 * bidirectional stream, streams the body, and resolves as soon as the response
 * headers arrive — the body is exposed as a streaming `Response` whose bytes and
 * trailers are pumped in lazily by the nghttp3 callbacks. The session multiplexes
 * any number of concurrent requests over the single connection.
 *
 * Two failure modes are handled beyond ordinary stream resets. A server GOAWAY
 * marks the highest stream id the peer will still service; requests numbered
 * above it (or opened after GOAWAY) are rejected rather than left hanging, and
 * the underlying QUIC connection closing rejects every in-flight request. The
 * session also supports WebTransport over HTTP/3 via `webtransport()`, which
 * performs an Extended CONNECT after confirming the peer advertised the required
 * SETTINGS.
 *
 * The session is disposable: `close()` (or a `using` binding via
 * `Symbol.dispose`) shuts the nghttp3 session down once outstanding streams
 * drain.
 *
 * ```ts no_run
 * import { H3ClientSession } from 'internal:net/http/h3/client';
 * import { QuicEndpoint } from 'fino:net/quic';
 *
 * const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
 * const conn = await endpoint.connect({ address: '203.0.113.5:443', alpnProtocols: ['h3'] });
 * using session = await H3ClientSession.create(conn);
 *
 * const response = await session.request('https://example.com/api', {
 *   method: 'POST',
 *   headers: { 'content-type': 'application/json' },
 *   body: JSON.stringify({ hello: 'world' }),
 * });
 * console.log(response.status, await response.text());
 * await endpoint.close();
 * ```
 *
 * HTTP/3 specification: https://www.rfc-editor.org/rfc/rfc9114
 * Extensible Prioritization Scheme: https://www.rfc-editor.org/rfc/rfc9218
 *
 * @internal
 */
import { DEFAULT_MAX_FIELD_SECTION_SIZE, Nghttp3Session, h3FieldSize } from './session.ts';
import type { H3BodySource, H3SessionCallbacks, H3SessionOptions } from './session.ts';
import { H3BodyQueue } from './body-queue.ts';
import { h3Available, NGHTTP3_ERR_CONN_CLOSING, NGHTTP3_H3_REQUEST_CANCELLED } from './bindings.ts';
import { HttpStreamError } from '../stream.ts';
import { QuicStreamEvent } from 'fino:net/quic';
import type { QuicConnection, QuicStream } from 'fino:net/quic';
import {
  WebTransport,
  _acceptIncomingQuicWebTransportStream,
  _fromHttp3WebTransport,
} from '../../../../net/http/webtransport.ts';
import type { WebTransportOptions } from '../../../../net/http/webtransport.ts';
import { quicIncomingStreamHook } from '../../quic/endpoint.ts';
import { inspectWebTransportStreamPrefix } from './webtransport.ts';
/**
 * Request options for an HTTP/3 request, extending the standard Fetch
 * `RequestInit` with HTTP/3-specific fields.
 *
 * Everything a normal `fetch()` accepts — `method`, `headers`, `body` — is
 * honoured. Pseudo-headers may be supplied through `headers` (for example a
 * `:authority` or `:protocol` entry) and are extracted before the ordinary
 * headers are serialized; regular header names are lowercased to satisfy HTTP/3
 * field-name rules. The extra fields carry request trailers, informational
 * response delivery, and options used when the request is a WebTransport
 * CONNECT.
 *
 * ```ts no_run
 * import type { H3RequestInit } from 'internal:net/http/h3/client';
 *
 * const init: H3RequestInit = {
 *   method: 'POST',
 *   headers: { 'content-type': 'text/plain' },
 *   body: 'streamed payload',
 *   trailers: [['x-checksum', 'a1b2c3']],
 * };
 * ```
 */
export interface H3RequestInit extends RequestInit {
  /** Observe each non-final 1xx response before the final `Response` resolves. */
  onInformational?: (response: H3InformationalResponse) => void;
  /**
   * RFC 9218 extensible priority for this request.
   *
   * Urgency ranges from 0 (highest) through 7 (lowest) and defaults to 3.
   * `incremental` asks the peer to interleave delivery with other incremental
   * responses of the same urgency. The value is sent as a `Priority` field for
   * the peer's HTTP/3 scheduler. The standard Fetch `priority` values are also
   * mapped to urgencies 0, 3, and 7; this option provides the full H3 range.
   */
  h3Priority?: H3Priority;
  /**
   * Maximum response-body bytes that may wait unread in memory.
   *
   * Exceeding the limit cancels only this HTTP/3 request stream and leaves the
   * shared QUIC connection available. Defaults to the shared body queue's
   * 16 MiB limit.
   *
   * @internal
   */
  maxBufferedBodyBytes?: number;
  /**
   * Trailing header fields to send after the request body completes.
   *
   * Each entry is a `[name, value]` pair emitted as an HTTP/3 trailer section
   * once the body stream ends. Useful for integrity digests or other metadata
   * that can only be computed after the full body is known.
   */
  trailers?: Array<[string, string]>;
  /**
   * Tuning options forwarded to the `WebTransport` session when this request is
   * an Extended CONNECT initiated through `H3ClientSession.webtransport()`.
   *
   * Ignored for ordinary requests.
   */
  webTransportOptions?: WebTransportOptions;
}
/** Resource limits and QPACK settings for an HTTP/3 client session. */
export type H3ClientSessionOptions = Omit<H3SessionOptions, 'webTransport'>;
/** Immutable envelope delivered for an HTTP/3 informational response. */
export interface H3InformationalResponse {
  readonly status: number;
  readonly headers: Headers;
}
/** RFC 9218 urgency and incremental scheduling hints for an HTTP/3 request. */
export interface H3Priority {
  /** Request urgency from 0 (highest) through 7 (lowest). Defaults to 3. */
  urgency?: number;
  /** Whether the response can be processed incrementally. Defaults to false. */
  incremental?: boolean;
}

function formatPriority(priority: H3Priority): string {
  const urgency = priority.urgency ?? 3;
  if (!Number.isInteger(urgency) || urgency < 0 || urgency > 7) {
    throw new RangeError('priority urgency must be an integer from 0 through 7');
  }
  return priority.incremental ? `u=${urgency}, i` : `u=${urgency}`;
}
/**
 * Per-stream bookkeeping for a request whose response is still being assembled.
 *
 * One entry lives in the session's pending map keyed by QUIC stream id from the
 * moment a request is submitted until the stream is done or errors. It threads
 * the incrementally received `:status`, response headers, streaming body, and
 * trailers together with the resolver/rejecter handles for the response and
 * trailer promises. `inTrailers` tracks whether incoming header callbacks belong
 * to the trailer section; `done` and `responseResolved` guard against
 * double-resolution when several terminal callbacks fire.
 *
 * @internal
 */
interface PendingRequest {
  method: string;
  stream: QuicStream | null;
  abortCleanup: (() => void) | null;
  status: string;
  responseHeaders: Array<[string, string]>;
  body: H3BodyQueue;
  trailerHeaders: Array<[string, string]>;
  inTrailers: boolean;
  fieldSectionSize: number;
  fieldSectionTooLarge: boolean;
  done: boolean;
  responseResolved: boolean;
  resolve: ((response: Response) => void) | null;
  reject: ((e: Error) => void) | null;
  trailers: Promise<Headers>;
  trailerResolve: ((headers: Headers) => void) | null;
  trailerReject: ((reason: unknown) => void) | null;
  onInformational: ((response: H3InformationalResponse) => void) | null;
}
/**
 * Normalizes a request `init.body` into the `H3BodySource` nghttp3 expects.
 *
 * Returns `undefined` for a missing or empty body so no DATA frames are sent.
 * `Uint8Array` and `ArrayBuffer` bodies are passed through as a single buffer;
 * anything else is routed through a throwaway `Request` to obtain a
 * `ReadableStream`, which is streamed frame by frame.
 *
 * @internal
 */
function bodySourceFromInit(url: string | URL, init?: H3RequestInit): H3BodySource | undefined {
  if (init?.body == null) return undefined;
  if (init.body instanceof Uint8Array) return init.body.byteLength > 0 ? init.body : undefined;
  if (init.body instanceof ArrayBuffer) {
    return init.body.byteLength > 0 ? new Uint8Array(init.body) : undefined;
  }
  const stream = new Request(url, init).body;
  return stream === null ? undefined : (stream as any);
}
/** Convert an AbortSignal reason into the error surfaced by a request. @internal */
function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? 'The operation was aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}
/**
 * Looks up a single header value from a request `init` by lowercase name.
 *
 * Handles all three `HeadersInit` shapes — a `Headers` instance, an array of
 * pairs, or a plain object — matching case-insensitively. Used to pull
 * pseudo-headers such as `:authority` and `:protocol` out of caller-supplied
 * headers before the remaining fields are serialized. Returns `null` when the
 * header is absent.
 *
 * @internal
 */
function getPseudoHeader(init: H3RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === name) return value;
    }
    return null;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === name) return value;
    }
    return null;
  }
  const value = (headers as Record<string, string>)[name];
  return value === undefined ? null : String(value);
}
/**
 * An HTTP/3 client session multiplexed over a single QUIC connection.
 *
 * Construct instances with the async `create()` factory rather than `new` — the
 * constructor is private because setup requires opening streams and installing
 * connection callbacks. Once created, the session lets you issue any number of
 * concurrent requests with `request()`, each of which opens its own
 * bidirectional QUIC stream and resolves to a streaming `Response`. WebTransport
 * sessions are established with `webtransport()`.
 *
 * The session listens for the connection's `close` event and for server GOAWAY:
 * both reject every affected in-flight request with a descriptive error rather
 * than leaving promises pending. Call `close()` when finished, or bind the
 * session with `using` so `Symbol.dispose` closes it automatically.
 *
 * ```ts no_run
 * import { H3ClientSession } from 'internal:net/http/h3/client';
 * import { QuicEndpoint } from 'fino:net/quic';
 *
 * const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
 * const conn = await endpoint.connect({ address: '203.0.113.5:443', alpnProtocols: ['h3'] });
 * using session = await H3ClientSession.create(conn);
 *
 * const [a, b] = await Promise.all([
 *   session.request('https://example.com/a'),
 *   session.request('https://example.com/b'),
 * ]);
 * console.log(a.status, b.status);
 * await endpoint.close();
 * ```
 */
export class H3ClientSession {
  #conn: QuicConnection;
  #session: Nghttp3Session;
  #pending = new Map<bigint, PendingRequest>();
  #webTransports = new Map<bigint, WebTransport>();
  #closed = false;
  #maxFieldSectionSize: number;
  #goawayStreamId: bigint | null = null;
  #goawayReceived: Promise<void>;
  #resolveGoawayReceived: (() => void) | null = null;
  #peerSettingsReceived: Promise<void>;
  #resolvePeerSettingsReceived: (() => void) | null = null;
  private constructor(conn: QuicConnection, session: Nghttp3Session, maxFieldSectionSize: number) {
    this.#conn = conn;
    this.#session = session;
    this.#maxFieldSectionSize = maxFieldSectionSize;
    this.#goawayReceived = new Promise((resolve) => {
      this.#resolveGoawayReceived = resolve;
    });
    this.#peerSettingsReceived = new Promise((resolve) => {
      this.#resolvePeerSettingsReceived = resolve;
    });
  }
  /**
   * Creates a client session over an established QUIC connection.
   *
   * Wires up the nghttp3 client callbacks, installs the connection's
   * incoming-stream hook (so remote control, QPACK, and WebTransport streams are
   * captured immediately), and opens and binds the three mandatory local
   * unidirectional streams: the HTTP/3 control stream and the QPACK
   * encoder/decoder streams. The connection must already have completed its
   * handshake with ALPN `h3`.
   *
   * Throws if libnghttp3 is unavailable, or if opening/binding the local
   * unidirectional streams fails (in which case the nghttp3 session is closed
   * before the error propagates).
   *
   * ```ts no_run
   * import { H3ClientSession } from 'internal:net/http/h3/client';
   *
   * const session = await H3ClientSession.create(conn);
   * ```
   */
  static async create(
    conn: QuicConnection,
    options: H3ClientSessionOptions = {},
  ): Promise<H3ClientSession> {
    if (!h3Available) throw new Error('libnghttp3 is not available');
    let session: Nghttp3Session;
    let instance: H3ClientSession;
    const callbacks: H3SessionCallbacks = {
      onBeginHeaders(streamId) {
        const existing = instance.#pending.get(streamId);
        if (existing) {
          // 1xx interim response — reset header state but keep promise handles and body.
          existing.status = '';
          existing.responseHeaders = [];
          existing.trailerHeaders = [];
          existing.inTrailers = false;
          existing.fieldSectionSize = 0;
          existing.fieldSectionTooLarge = false;
        } else {
          instance.#pending.set(streamId, {
            method: 'GET',
            stream: null,
            abortCleanup: null,
            status: '',
            responseHeaders: [],
            body: new H3BodyQueue(),
            trailerHeaders: [],
            inTrailers: false,
            fieldSectionSize: 0,
            fieldSectionTooLarge: false,
            done: false,
            responseResolved: false,
            resolve: null,
            reject: null,
            trailers: Promise.resolve(new Headers()),
            trailerResolve: null,
            trailerReject: null,
            onInformational: null,
          });
        }
      },
      onRecvHeader(streamId, _token, name, value) {
        const req = instance.#pending.get(streamId);
        if (!req) return;
        req.fieldSectionSize += h3FieldSize(name, value);
        if (req.fieldSectionSize > instance.#maxFieldSectionSize) {
          req.fieldSectionTooLarge = true;
          return;
        }
        if (req.inTrailers) {
          req.trailerHeaders.push([name, value]);
          return;
        }
        if (name === ':status') req.status = value;
        else if (!name.startsWith(':')) req.responseHeaders.push([name, value]);
      },
      onEndHeaders(streamId, fin) {
        const pending = instance.#pending.get(streamId);
        if (pending?.fieldSectionTooLarge) {
          instance.#rejectOversizedFieldSection(streamId);
          return;
        }
        const status = Number(pending?.status);
        if (pending && Number.isInteger(status) && status >= 100 && status < 200) {
          const callback = pending.onInformational;
          if (callback !== null) {
            const information: H3InformationalResponse = Object.freeze({
              status,
              headers: new Headers(pending.responseHeaders as HeadersInit),
            });
            queueMicrotask(() => {
              try {
                callback(information);
              } catch (error) {
                reportError(error);
              }
            });
          }
          pending.status = '';
          pending.responseHeaders = [];
          return;
        }
        instance.#resolveResponse(streamId);
        if (fin) instance.#markDone(streamId);
      },
      onBeginTrailers(streamId) {
        const req = instance.#pending.get(streamId);
        if (req) {
          req.inTrailers = true;
          req.fieldSectionSize = 0;
          req.fieldSectionTooLarge = false;
        }
      },
      onRecvTrailer(streamId, _token, name, value) {
        const req = instance.#pending.get(streamId);
        if (!req) return;
        req.fieldSectionSize += h3FieldSize(name, value);
        if (req.fieldSectionSize > instance.#maxFieldSectionSize) {
          req.fieldSectionTooLarge = true;
          return;
        }
        if (!name.startsWith(':')) req.trailerHeaders.push([name, value]);
      },
      onEndTrailers(streamId) {
        const req = instance.#pending.get(streamId);
        if (req?.fieldSectionTooLarge) {
          instance.#rejectOversizedFieldSection(streamId);
          return;
        }
        instance.#markDone(streamId);
      },
      onRecvData(streamId, data) {
        const req = instance.#pending.get(streamId);
        if (req && !req.body.push(data)) {
          queueMicrotask(() => {
            instance.#cancelRequest(
              streamId,
              new HttpStreamError(
                'flow-control',
                'HTTP/3 response body buffer exceeded its limit',
                {
                  streamId,
                  protocolCode: NGHTTP3_H3_REQUEST_CANCELLED,
                },
              ),
            );
          });
        }
      },
      onEndStream(streamId) {
        if (instance.#pending.get(streamId)?.fieldSectionTooLarge) {
          instance.#rejectOversizedFieldSection(streamId);
          return;
        }
        instance.#markDone(streamId);
      },
      onStreamClose(streamId, appErrorCode) {
        const req = instance.#pending.get(streamId);
        if (req && !req.done) {
          const error = new Error(`H3 stream closed with error 0x${appErrorCode.toString(16)}`);
          req.body.error(error);
          req.trailerReject?.(error);
          req.reject?.(error);
          req.abortCleanup?.();
          instance.#pending.delete(streamId);
        }
      },
      onResetStream(streamId, appErrorCode) {
        const req = instance.#pending.get(streamId);
        if (req) {
          const error = new Error(`H3 stream reset with error 0x${appErrorCode.toString(16)}`);
          req.body.error(error);
          req.trailerReject?.(error);
          req.reject?.(error);
          req.abortCleanup?.();
          instance.#pending.delete(streamId);
        }
      },
      onAckedStreamData() {},
      onShutdown(streamId: bigint) {
        if (instance.#goawayStreamId === null || streamId < instance.#goawayStreamId) {
          instance.#goawayStreamId = streamId;
        }
        instance.#resolveGoawayReceived?.();
        instance.#resolveGoawayReceived = null;
        for (const [sid, req] of instance.#pending) {
          if (sid >= streamId) {
            if (!req.done) {
              req.done = true;
              const error = new Error(
                `H3 stream rejected: server GOAWAY (first rejected: ${streamId})`,
              );
              req.body.error(error);
              req.trailerReject?.(error);
              req.reject?.(error);
              req.abortCleanup?.();
            }
            instance.#pending.delete(sid);
          }
        }
      },
      onRecvSettings() {
        instance.#markPeerSettingsReceived();
      },
    };
    const maxFieldSectionSize = options.maxFieldSectionSize ?? DEFAULT_MAX_FIELD_SECTION_SIZE;
    session = Nghttp3Session.createClient(callbacks, { ...options, webTransport: true });
    instance = new H3ClientSession(conn, session, maxFieldSectionSize);
    conn.addEventListener(
      'close',
      () => {
        for (const [, req] of instance.#pending) {
          if (!req.done) {
            req.done = true;
            const error = new Error('H3 stream closed: connection closed');
            req.body.error(error);
            req.trailerReject?.(error);
            req.reject?.(error);
            req.abortCleanup?.();
          }
        }
        instance.#pending.clear();
        void instance.#session.closeWhenIdle();
      },
      { once: true },
    );
    // Install the incoming-stream hook early so remote control/QPACK and
    // WebTransport streams are captured as soon as they arrive. The hook bypasses
    // the QuicStreamEvent/EventTarget/#streamQueue path (the session is the sole
    // consumer of incoming streams here) and drains any pre-installation backlog.
    conn[quicIncomingStreamHook] = (stream) => {
      const sid = BigInt(stream.id);
      void (async () => {
        try {
          if (instance.#webTransports.size === 0) {
            if (stream.direction === 'bidirectional') session.addQuicStream(sid, stream.writer);
            while (true) {
              const result = await stream.reader.read();
              if (result.done) {
                session.endStream(sid);
                break;
              }
              session.receiveStreamData(sid, result.value);
            }
            return;
          }
          const routed = await readWebTransportPrefix(stream.reader);
          if (routed.buffer === null) {
            session.endStream(sid);
            return;
          }
          if (routed.prefix?.kind === stream.direction && routed.prefix.sessionId !== undefined) {
            const wt = instance.#webTransports.get(routed.prefix.sessionId);
            if (wt !== undefined) {
              _acceptIncomingQuicWebTransportStream(wt, stream, routed.buffer);
              return;
            }
          }
          if (stream.direction === 'bidirectional') session.addQuicStream(sid, stream.writer);
          session.receiveStreamData(sid, routed.buffer);
          while (true) {
            const result = await stream.reader.read();
            if (result.done) {
              session.endStream(sid);
              break;
            }
            session.receiveStreamData(sid, result.value);
          }
        } catch {}
      })();
    };
    // Bind the 3 mandatory local unidirectional streams.
    try {
      const [controlStream, qencStream, qdecStream] = (await Promise.all([
        conn.openUnidirectionalStream(),
        conn.openUnidirectionalStream(),
        conn.openUnidirectionalStream(),
      ])) as QuicStream[];
      for (const s of [controlStream, qencStream, qdecStream]) {
        session.addQuicStream(BigInt(s.id), s.writer);
      }
      session.bindControlStream(BigInt(controlStream.id));
      session.bindQpackStreams(BigInt(qencStream.id), BigInt(qdecStream.id));
      session.drainWrites();
    } catch (e) {
      session.close();
      throw e;
    }
    return instance;
  }
  /**
   * Sends an HTTP/3 request and resolves once the response headers arrive.
   *
   * Opens a fresh bidirectional QUIC stream, builds the pseudo-header block
   * (`:method`, `:path`, `:scheme`, `:authority`, and an optional `:protocol`)
   * plus the caller's lowercased headers, and submits the request. The body is
   * derived from `init.body` and any `init.trailers` are appended after it. The
   * returned `Response` streams: its status and headers are final on resolution,
   * but body bytes and trailers continue to be filled in by the connection's
   * read loop, so read the body (for example with `response.text()` or
   * `.arrayBuffer()`) before closing the connection.
   *
   * The response is rejected — and the body/trailers errored — if the stream is
   * reset or closed with an error, if the connection closes, or if the peer
   * returns a missing or out-of-range `:status`. Throws synchronously if the
   * session is already closed, or immediately rejects if a server GOAWAY has
   * arrived and this request would use or exceed the first rejected stream id.
   *
   * ```ts no_run
   * const res = await session.request('https://example.com/upload', {
   *   method: 'PUT',
   *   headers: { 'content-type': 'application/octet-stream' },
   *   body: new Uint8Array([1, 2, 3]),
   * });
   * if (res.ok) console.log(await res.text());
   * ```
   */
  async request(url: string | URL, init?: H3RequestInit): Promise<Response> {
    if (this.#closed) throw new Error('H3 session is closed');
    if (init?.signal?.aborted) throw abortError(init.signal.reason);
    if (this.#goawayStreamId !== null) {
      throw new Error(
        `H3 stream rejected: server GOAWAY (first rejected: ${this.#goawayStreamId})`,
      );
    }
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const method = init?.method ?? 'GET';
    const authority = getPseudoHeader(init, ':authority') ?? parsed.host;
    const reqHeaders: Array<[string, string]> = [
      [':method', method],
      [':path', parsed.pathname + parsed.search],
      [':scheme', parsed.protocol.replace(':', '')],
      [':authority', authority],
    ];
    const protocol = getPseudoHeader(init, ':protocol');
    if (protocol !== null) reqHeaders.push([':protocol', protocol]);
    const headers = init?.headers;
    if (headers instanceof Headers) {
      headers.forEach((value, name) => {
        if (!name.startsWith(':')) reqHeaders.push([name.toLowerCase(), value]);
      });
    } else if (Array.isArray(headers)) {
      for (const [name, value] of headers) {
        if (!name.startsWith(':')) reqHeaders.push([name.toLowerCase(), value]);
      }
    } else if (headers !== undefined) {
      for (const [name, value] of Object.entries(headers as Record<string, string>)) {
        if (!name.startsWith(':')) reqHeaders.push([name.toLowerCase(), String(value)]);
      }
    }
    const priorityValue =
      init?.h3Priority !== undefined
        ? formatPriority(init.h3Priority)
        : init?.priority === 'high'
          ? 'u=0'
          : init?.priority === 'low'
            ? 'u=7'
            : init?.priority === 'auto'
              ? 'u=3'
              : null;
    if (priorityValue !== null) {
      for (let index = reqHeaders.length - 1; index >= 0; index--) {
        if (reqHeaders[index]![0] === 'priority') reqHeaders.splice(index, 1);
      }
      reqHeaders.push(['priority', priorityValue]);
    }
    const quicStream = await this.#conn.openBidirectionalStream();
    const sid = BigInt(quicStream.id);
    if (init?.signal?.aborted) {
      quicStream.stopSending(Number(NGHTTP3_H3_REQUEST_CANCELLED));
      quicStream.reset(Number(NGHTTP3_H3_REQUEST_CANCELLED));
      throw abortError(init.signal.reason);
    }
    // If a GOAWAY arrived while we were waiting to open the stream, reject it
    // immediately rather than letting it linger until connection close.
    if (this.#goawayStreamId !== null && sid >= this.#goawayStreamId) {
      void quicStream.writer.close();
      throw new Error(
        `H3 stream rejected: server GOAWAY (first rejected: ${this.#goawayStreamId})`,
      );
    }
    this.#session.addQuicStream(sid, quicStream.writer);
    // Start reading the response on this stream.
    void (async () => {
      try {
        while (true) {
          const result = await quicStream.reader.read();
          // A local body cancellation removes the pending request before QUIC's
          // STOP_SENDING completion wakes this read. Do not feed that terminal
          // event back into nghttp3 after its stream state was deliberately
          // closed; nghttp3 would report STREAM_NOT_FOUND as a connection error.
          if (!this.#pending.has(sid)) break;
          if (result.done) {
            this.#session.endStream(sid);
            break;
          }
          this.#session.receiveStreamData(sid, result.value);
        }
      } catch {
        // Connection was closed with an error before the response arrived.
        const pending = this.#pending.get(sid);
        if (pending && !pending.done) {
          pending.done = true;
          const error = new Error('H3 stream closed: connection error');
          pending.body.error(error);
          pending.trailerReject?.(error);
          pending.reject?.(error);
          pending.abortCleanup?.();
          this.#pending.delete(sid);
        }
      }
    })();
    const body = bodySourceFromInit(url, init);
    const responsePromise = new Promise<Response>((resolve, reject) => {
      let trailerResolve!: (headers: Headers) => void;
      let trailerReject!: (reason: unknown) => void;
      const trailers = new Promise<Headers>((trResolve, trReject) => {
        trailerResolve = trResolve;
        trailerReject = trReject;
      });
      void trailers.catch(() => {});
      const pending: PendingRequest = {
        method: method.toUpperCase(),
        stream: quicStream,
        abortCleanup: null,
        status: '',
        responseHeaders: [],
        body: new H3BodyQueue({
          maxBufferedBytes: init?.maxBufferedBodyBytes,
          onCancel: (reason) => this.#cancelRequest(sid, reason),
        }),
        trailerHeaders: [],
        inTrailers: false,
        fieldSectionSize: 0,
        fieldSectionTooLarge: false,
        done: false,
        responseResolved: false,
        resolve: null,
        reject: null,
        trailers,
        trailerResolve,
        trailerReject,
        onInformational: init?.onInformational ?? null,
      };
      pending.resolve = (response) => resolve(response);
      pending.reject = reject;
      if (init?.signal !== undefined && init.signal !== null) {
        const onAbort = () => this.#cancelRequest(sid, abortError(init.signal!.reason));
        init.signal.addEventListener('abort', onAbort, { once: true });
        pending.abortCleanup = () => init.signal!.removeEventListener('abort', onAbort);
      }
      this.#pending.set(sid, pending);
    });
    try {
      this.#session.submitRequest(sid, reqHeaders, body, init?.trailers);
      this.#session.drainWrites();
    } catch (e) {
      const pending = this.#pending.get(sid);
      this.#pending.delete(sid);
      const message =
        typeof (
          e as {
            message?: unknown;
          }
        )?.message === 'string'
          ? (
              e as {
                message: string;
              }
            ).message
          : String(e);
      if (message.includes(`failed: ${NGHTTP3_ERR_CONN_CLOSING}`)) {
        const error = new Error(
          `H3 stream rejected: server GOAWAY (first rejected: ${this.#goawayStreamId ?? 'unknown'})`,
        );
        pending?.body.error(error);
        pending?.trailerReject?.(error);
        pending?.reject?.(error);
        pending?.abortCleanup?.();
        throw error;
      }
      pending?.abortCleanup?.();
      pending?.body.error(e);
      pending?.trailerReject?.(e);
      pending?.reject?.(e);
      throw e;
    }
    return responsePromise;
  }
  /**
   * Opens a WebTransport session over this HTTP/3 connection.
   *
   * Waits for the peer's SETTINGS, then performs an Extended CONNECT with
   * `:protocol` set to `webtransport-h3` at the given URL. On a 2xx response it
   * wraps the CONNECT stream in a `WebTransport` object that shares this
   * connection and routes its own incoming streams; a non-2xx status is treated
   * as a rejection. The returned session is tracked until its `closed` promise
   * settles.
   *
   * Throws if the session is closed, if the peer did not advertise the SETTINGS
   * required for Extended CONNECT / H3 DATAGRAM / WebTransport, or if the server
   * rejects the CONNECT (non-2xx status) or fails to expose the CONNECT stream
   * id.
   *
   * ```ts no_run
   * const wt = await session.webtransport('https://example.com/wt', {
   *   webTransportOptions: { allowPooling: false },
   * });
   * const stream = await wt.createBidirectionalStream();
   * ```
   */
  async webtransport(url: string | URL, init: H3RequestInit = {}): Promise<WebTransport> {
    if (this.#closed) throw new Error('H3 session is closed');
    await this.#waitForPeerSettings();
    if (!this.#session.peerWebTransportReady) {
      throw new Error(
        'WebTransport over HTTP/3 requires peer SETTINGS for Extended CONNECT, H3 DATAGRAM, and WebTransport readiness',
      );
    }
    const headers: Array<[string, string]> = [];
    const sourceHeaders = init.headers;
    if (sourceHeaders instanceof Headers) {
      sourceHeaders.forEach((value, name) => headers.push([name, value]));
    } else if (Array.isArray(sourceHeaders)) {
      headers.push(...sourceHeaders);
    } else if (sourceHeaders !== undefined) {
      for (const [name, value] of Object.entries(sourceHeaders as Record<string, string>)) {
        headers.push([name, String(value)]);
      }
    }
    headers.push([':protocol', 'webtransport-h3']);
    const response = await this.request(url, {
      ...init,
      method: 'CONNECT',
      headers,
    } as H3RequestInit);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`WebTransport over HTTP/3 rejected with status ${response.status}`);
    }
    const streamId = (response as any).__h3StreamId as bigint | undefined;
    if (streamId === undefined)
      throw new Error('WebTransport over HTTP/3 response did not expose a CONNECT stream id');
    const wt = _fromHttp3WebTransport(String(url), {
      connection: this.#conn,
      sessionStreamId: streamId,
      responseHeaders: response.headers,
      protocol: response.headers.get('sec-webtransport-protocol') ?? '',
      options: init.webTransportOptions,
      routeIncomingStreams: false,
    });
    this.#webTransports.set(streamId, wt);
    wt.closed.finally(() => this.#webTransports.delete(streamId)).catch(() => {});
    return wt;
  }
  #markPeerSettingsReceived(): void {
    this.#resolvePeerSettingsReceived?.();
    this.#resolvePeerSettingsReceived = null;
  }
  async #waitForPeerSettings(): Promise<void> {
    if (this.#session.peerSettingsReceived) return;
    await this.#peerSettingsReceived;
  }
  /**
   * Resolves once a server GOAWAY has been observed on this session.
   *
   * A test-only helper: it resolves immediately if a GOAWAY has already been
   * recorded, otherwise it awaits the next one. Not part of the public client
   * surface.
   *
   * @internal
   */
  _waitForGoawayForTest(): Promise<void> {
    if (this.#goawayStreamId !== null) return Promise.resolve();
    return this.#goawayReceived;
  }
  #resolveResponse(streamId: bigint): void {
    const pending = this.#pending.get(streamId);
    if (!pending || pending.responseResolved) return;
    pending.responseResolved = true;
    const statusNum = Number(pending.status);
    if (!pending.status || !Number.isInteger(statusNum) || statusNum < 100 || statusNum > 999) {
      pending.reject?.(
        new Error(`H3: missing or invalid :status pseudo-header (got: "${pending.status}")`),
      );
      this.#pending.delete(streamId);
      return;
    }
    const headers = new Headers(pending.responseHeaders as HeadersInit);
    const body =
      pending.method === 'HEAD' || statusNum === 204 || statusNum === 205 || statusNum === 304
        ? null
        : (pending.body as any);
    const response = new Response(body, {
      status: statusNum,
      headers,
      trailers: () => pending.trailers,
    } as any);
    (response as any).__h3StreamId = streamId;
    pending.resolve?.(response);
  }
  #markDone(streamId: bigint): void {
    const req = this.#pending.get(streamId);
    if (!req || req.done) return;
    req.done = true;
    this.#resolveResponse(streamId);
    req.body.close();
    req.trailerResolve?.(new Headers(req.trailerHeaders as HeadersInit));
    req.abortCleanup?.();
    this.#pending.delete(streamId);
  }
  #cancelRequest(streamId: bigint, reason: unknown): void {
    const req = this.#pending.get(streamId);
    if (req === undefined || req.done) return;
    req.done = true;
    const error =
      reason instanceof Error
        ? reason
        : new HttpStreamError('cancelled', 'HTTP/3 request was cancelled', {
            streamId,
            protocolCode: NGHTTP3_H3_REQUEST_CANCELLED,
          });
    req.body.error(error);
    req.trailerReject?.(error);
    if (!req.responseResolved) req.reject?.(error);
    req.abortCleanup?.();
    this.#pending.delete(streamId);
    this.#session.cancelStream(streamId);
    try {
      req.stream?.stopSending(Number(NGHTTP3_H3_REQUEST_CANCELLED));
    } catch {}
    try {
      req.stream?.reset(Number(NGHTTP3_H3_REQUEST_CANCELLED));
    } catch {}
  }
  #rejectOversizedFieldSection(streamId: bigint): void {
    queueMicrotask(() => {
      this.#cancelRequest(
        streamId,
        new Error(`HTTP/3 response field section exceeds ${this.#maxFieldSectionSize} bytes`),
      );
    });
  }
  /**
   * Marks the session closed and shuts down nghttp3 once streams drain.
   *
   * Idempotent — a second call is a no-op. New `request()` and `webtransport()`
   * calls after this throw, but requests already in flight are allowed to finish
   * as the underlying session closes when idle.
   *
   * ```ts no_run
   * const session = await H3ClientSession.create(conn);
   * try {
   *   await session.request('https://example.com/');
   * } finally {
   *   session.close();
   * }
   * ```
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#session.closeWhenIdle();
  }
  /**
   * Disposes the session by delegating to `close()`, enabling `using` bindings.
   *
   * ```ts no_run
   * using session = await H3ClientSession.create(conn);
   * // session.close() runs automatically at end of scope
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
}
/**
 * Concatenates byte chunks into a single contiguous `Uint8Array`.
 *
 * Returns the sole chunk unchanged when there is only one, avoiding a copy.
 *
 * @internal
 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
/**
 * Reads from an incoming stream until its WebTransport routing prefix is known.
 *
 * Buffers chunks until `inspectWebTransportStreamPrefix` can classify the
 * stream (resolving with the accumulated buffer and parsed prefix), or until the
 * stream ends first (resolving with a `null` prefix, and a `null` buffer if no
 * bytes were seen). Used by the incoming-stream hook to decide whether a new
 * QUIC stream belongs to a WebTransport session or to the HTTP/3 session itself.
 *
 * @internal
 */
async function readWebTransportPrefix(reader: QuicStream['reader']): Promise<{
  buffer: Uint8Array | null;
  prefix: ReturnType<typeof inspectWebTransportStreamPrefix> | null;
}> {
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done)
      return {
        buffer: chunks.length === 0 ? null : concatBytes(chunks),
        prefix: null,
      };
    chunks.push(result.value);
    const buffer = concatBytes(chunks);
    const prefix = inspectWebTransportStreamPrefix(buffer);
    if (prefix.state !== 'incomplete')
      return {
        buffer,
        prefix,
      };
  }
}
