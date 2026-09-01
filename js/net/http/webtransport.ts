/**
 * fino:net/http/webtransport - WebTransport over HTTP/3.
 *
 * The `WebTransport` class mirrors the W3C WebTransport object model while
 * using Fino's HTTP/3 and QUIC implementation underneath. Both `WebTransport`
 * and `WebTransportDatagramDuplexStream` are also installed as globals during
 * bootstrap, so browser-style code that references the bare `WebTransport`
 * constructor works unchanged. Applications may construct it directly with an
 * HTTPS URL or receive an already-connected instance from
 * `HttpClient.webtransport()`, `HttpSession.webtransport()`, or server-side
 * `IncomingWebTransportRequest.accept()`.
 *
 * A directly constructed transport enters its setup flow immediately: it opens
 * an HTTP/3 connection to the URL origin and issues an extended CONNECT
 * request. `ready` resolves with `undefined` after the CONNECT succeeds and
 * any `serverCertificateHashes` pins validate against the peer certificate.
 * `closed` resolves with `{ closeCode, reason }` on clean shutdown and rejects
 * when setup or a transport error aborts the session.
 *
 * Datagrams use the standard `WebTransportDatagramDuplexStream` shape.
 * Outgoing writes are framed as HTTP Datagrams bound to the session's CONNECT
 * stream; incoming datagrams belonging to other sessions on the same QUIC
 * connection are filtered out. Incoming streams arrive with a WebTransport
 * stream-type prefix, are matched to the session, and are exposed as
 * `ReadableStream`s of standard receive/bidirectional stream wrappers.
 *
 * ```ts no_run
 * import { WebTransport } from 'fino:net/http/webtransport';
 *
 * const wt = new WebTransport('https://example.test/session');
 * await wt.ready;
 *
 * const writer = wt.datagrams.createWritable().getWriter();
 * await writer.write(new Uint8Array([1, 2, 3]));
 * writer.releaseLock();
 *
 * const stream = await wt.createBidirectionalStream();
 * await stream.writable.getWriter().write(new Uint8Array([4, 5]));
 *
 * wt.close({ closeCode: 0, reason: 'done' });
 * ```
 *
 * Learn more:
 * - W3C WebTransport: https://w3c.github.io/webtransport/
 * - WebTransport over HTTP/3: https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
 * - HTTP Datagrams: https://www.rfc-editor.org/rfc/rfc9297
 * - QUIC DATAGRAM: https://www.rfc-editor.org/rfc/rfc9221
 */
import {
  decodeHttpDatagram,
  decodeWebTransportStreamPrefix,
  encodeHttpDatagram,
  encodeWebTransportStreamPrefix,
} from '../../internal/net/http/h3/webtransport.ts';
/**
 * Information reported when a WebTransport closes cleanly.
 *
 * This is the resolution value of `WebTransport.closed` and the argument shape
 * accepted by `WebTransport.close()`. On a remote close the values come from
 * the underlying connection's close information; on a local `close()` call
 * they echo the caller's arguments.
 *
 * ```ts no_run
 * const { closeCode, reason } = await wt.closed;
 * console.log(`session ended: ${closeCode} ${reason}`);
 * ```
 */
export interface WebTransportCloseInfo {
  /** Application close code. Defaults to `0`. */
  closeCode?: number;
  /** Human-readable close reason. Defaults to the empty string. */
  reason?: string;
}
/**
 * Server certificate hash pin accepted by the standard constructor options.
 *
 * When one or more hashes are supplied via
 * `WebTransportOptions.serverCertificateHashes`, session setup digests the
 * peer's certificate and requires at least one pin to match before `ready`
 * resolves. Only SHA-256 is supported; other algorithms cause setup to fail
 * with a `TypeError`.
 *
 * ```ts no_run
 * const hash: WebTransportHash = {
 *   algorithm: 'sha-256',
 *   value: await crypto.subtle.digest('SHA-256', certificateDer),
 * };
 * ```
 */
export interface WebTransportHash {
  /** Digest algorithm name. Only `'sha-256'` (case/underscore-insensitive) is accepted. */
  algorithm: string;
  /** Expected digest of the peer's DER-encoded certificate. */
  value: BufferSource;
}
/**
 * Options accepted by `new WebTransport()` and Fino HTTP helpers.
 *
 * This matches the standard `WebTransportOptions` dictionary plus Fino's
 * `headers` extension for the CONNECT request. `serverCertificateHashes` is
 * validated during setup, `congestionControl` is recorded and exposed via the
 * `congestionControl` getter, and `protocols` is sent as the
 * `sec-webtransport-protocol` request header so the server can pick an
 * application protocol. The remaining standard members are accepted for
 * compatibility but are currently advisory: they do not change connection
 * behavior.
 *
 * ```ts no_run
 * const wt = new WebTransport('https://example.test/session', {
 *   protocols: ['chat-v2', 'chat-v1'],
 *   congestionControl: 'low-latency',
 *   serverCertificateHashes: [{ algorithm: 'sha-256', value: pinnedHash }],
 * });
 * ```
 */
export interface WebTransportOptions {
  /** Standard pooling hint. Accepted for compatibility; currently advisory. */
  allowPooling?: boolean;
  /** Standard requirement that the connection support datagrams. Accepted for compatibility; currently advisory. */
  requireUnreliable?: boolean;
  /** Extra headers to send on the extended CONNECT request. Fino extension. */
  headers?: Headers | Record<string, string>;
  /** Certificate pins checked against the peer certificate before `ready` resolves. */
  serverCertificateHashes?: readonly WebTransportHash[];
  /** Congestion control preference, surfaced through the `congestionControl` getter. */
  congestionControl?: 'default' | 'throughput' | 'low-latency';
  /** Standard concurrency hint. Accepted for compatibility; currently advisory. */
  anticipatedConcurrentIncomingUnidirectionalStreams?: number | null;
  /** Standard concurrency hint. Accepted for compatibility; currently advisory. */
  anticipatedConcurrentIncomingBidirectionalStreams?: number | null;
  /** Application protocols offered via the `sec-webtransport-protocol` header. */
  protocols?: readonly string[];
  /** Standard datagram readable-type selector. Only `'bytes'` exists; currently advisory. */
  datagramsReadableType?: 'bytes';
}
/**
 * Statistics reported by `WebTransportSendStream.getStats()`.
 *
 * ```ts no_run
 * const { bytesWritten } = await sendStream.getStats();
 * ```
 */
export interface WebTransportSendStreamStats {
  /** Total payload bytes written to the stream so far. */
  bytesWritten: number;
}
/**
 * Statistics reported by `WebTransportReceiveStream.getStats()`.
 *
 * ```ts no_run
 * const { bytesRead } = await receiveStream.getStats();
 * ```
 */
export interface WebTransportReceiveStreamStats {
  /** Total payload bytes read from the stream so far. */
  bytesRead: number;
}
/**
 * Session-level statistics reported by `WebTransport.getStats()`.
 *
 * Values come from the underlying QUIC connection when it exposes stats;
 * otherwise they fall back to counters tracked by the transport itself.
 *
 * ```ts no_run
 * const stats = await wt.getStats();
 * console.log(stats.datagramsSent, stats.bytesReceived);
 * ```
 */
export interface WebTransportStats {
  /** Number of datagrams sent on this session. */
  datagramsSent: number;
  /** Number of datagrams received for this session. */
  datagramsReceived: number;
  /** Bytes sent, when the underlying connection reports it; otherwise `0`. */
  bytesSent: number;
  /** Bytes received in datagrams for this session. */
  bytesReceived: number;
}
/**
 * Writable side of a WebTransport stream.
 *
 * A `WritableStream<Uint8Array>` extended with the standard `sendGroup` /
 * `sendOrder` properties (currently always `null`, send-order prioritization
 * is not applied) and a `getStats()` method reporting bytes written. Aborting
 * the stream resets the underlying QUIC stream when the backend supports it
 * and throws otherwise.
 *
 * ```ts no_run
 * const send = await wt.createUnidirectionalStream();
 * const writer = send.getWriter();
 * await writer.write(new TextEncoder().encode('hello'));
 * await writer.close();
 * console.log(await send.getStats());
 * ```
 */
export type WebTransportSendStream = WritableStream<Uint8Array> & {
  sendGroup: string | null;
  sendOrder: number | null;
  getStats(): Promise<WebTransportSendStreamStats>;
};
/**
 * Readable side of a WebTransport stream.
 *
 * A `ReadableStream<Uint8Array>` extended with a `getStats()` method reporting
 * bytes read. The stream closes when the peer finishes the QUIC stream.
 *
 * ```ts no_run
 * for await (const chunk of receiveStream) {
 *   console.log('received', chunk.byteLength, 'bytes');
 * }
 * ```
 */
export type WebTransportReceiveStream = ReadableStream<Uint8Array> & {
  getStats(): Promise<WebTransportReceiveStreamStats>;
};
/**
 * Standard bidirectional stream wrapper.
 *
 * Returned by `createBidirectionalStream()` and enqueued on
 * `incomingBidirectionalStreams`. The readable and writable halves operate
 * independently: closing one direction does not affect the other.
 *
 * ```ts no_run
 * const stream = await wt.createBidirectionalStream();
 * const writer = stream.writable.getWriter();
 * await writer.write(new Uint8Array([1]));
 * const reader = stream.readable.getReader();
 * const { value } = await reader.read();
 * ```
 */
export interface WebTransportBidirectionalStream {
  /** Data flowing from the peer to this endpoint. */
  readonly readable: WebTransportReceiveStream;
  /** Data flowing from this endpoint to the peer. */
  readonly writable: WebTransportSendStream;
}
type DatagramSink = (data: Uint8Array) => Promise<unknown>;
const kDatagramPush = Symbol('WebTransportDatagramDuplexStream.push');
const kDatagramClose = Symbol('WebTransportDatagramDuplexStream.close');
const kDatagramError = Symbol('WebTransportDatagramDuplexStream.error');
const kDatagramStats = Symbol('WebTransportDatagramDuplexStream.stats');
/**
 * Standard datagram duplex stream facade.
 *
 * Exposed as `WebTransport.datagrams` (and installed as a global constructor
 * for API-shape compatibility). Incoming session datagrams are enqueued on
 * `readable`; outgoing datagrams are written through writers created with
 * `createWritable()`. Each write is delivered unreliably as a single QUIC
 * DATAGRAM frame, so payloads must fit in `maxDatagramSize` - oversized
 * writes reject with a `RangeError`.
 *
 * When the owning transport closes, `readable` closes and further writes
 * reject; when the transport fails, `readable` errors with the failure.
 *
 * ```ts no_run
 * const writer = wt.datagrams.createWritable().getWriter();
 * await writer.write(new Uint8Array([1, 2, 3]));
 * writer.releaseLock();
 *
 * const reader = wt.datagrams.readable.getReader();
 * const { value } = await reader.read();
 * ```
 */
export class WebTransportDatagramDuplexStream {
  readonly #readable: ReadableStream<Uint8Array>;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #closed = false;
  #send: DatagramSink;
  #maxDatagramSize: number;
  #outgoingCount = 0;
  /** Standard incoming max-age knob in milliseconds. Currently advisory; expiry is not enforced. */
  incomingMaxAge: number | null = null;
  /** Standard outgoing max-age knob in milliseconds. Currently advisory; expiry is not enforced. */
  outgoingMaxAge: number | null = null;
  /** Standard incoming buffer-depth knob. Currently advisory; the queue is not trimmed. */
  incomingMaxBufferedDatagrams = 16;
  /** Standard outgoing buffer-depth knob. Currently advisory; writes are delivered immediately. */
  outgoingMaxBufferedDatagrams = 16;
  /**
   * Create a duplex facade that delivers outgoing datagrams through `send`.
   *
   * Constructed internally by `WebTransport`; applications normally reach an
   * instance through `wt.datagrams` rather than constructing one directly.
   */
  constructor(send: DatagramSink, maxDatagramSize = 65535) {
    this.#send = send;
    this.#maxDatagramSize = maxDatagramSize;
    this.#readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
  }
  /** Stream of incoming datagram payloads for this session, one `Uint8Array` per datagram. */
  get readable(): ReadableStream<Uint8Array> {
    return this.#readable;
  }
  /** Largest payload, in bytes, accepted by a single datagram write. */
  get maxDatagramSize(): number {
    return this.#maxDatagramSize;
  }
  /**
   * Create a writable stream that sends each chunk as one datagram.
   *
   * Writes reject with a `RangeError` when the chunk exceeds
   * `maxDatagramSize`, and with an `Error` after the session has closed. The
   * `sendOrder` option is accepted for standard shape but not currently
   * applied.
   *
   * ```ts no_run
   * const writer = wt.datagrams.createWritable().getWriter();
   * await writer.write(new Uint8Array([0xca, 0xfe]));
   * ```
   */
  createWritable(
    _options: {
      sendOrder?: number;
    } = {},
  ): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.#closed) throw new Error('WebTransport datagrams are closed');
        const bytes = toBytes(chunk);
        if (bytes.byteLength > this.#maxDatagramSize) {
          throw new RangeError(
            `WebTransport datagram size ${bytes.byteLength} exceeds maxDatagramSize ${this.#maxDatagramSize}`,
          );
        }
        this.#outgoingCount++;
        await this.#send(bytes);
      },
    });
  }
  /** Enqueue an incoming datagram payload. Called by the owning transport; not part of the standard surface. */
  [kDatagramPush](data: Uint8Array): void {
    if (this.#closed || this.#controller === null) return;
    this.#controller.enqueue(data);
  }
  /** Close the incoming readable and reject further writes. Called by the owning transport on clean close. */
  [kDatagramClose](): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller?.close();
  }
  /** Error the incoming readable and reject further writes. Called by the owning transport on failure. */
  [kDatagramError](error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller?.error(error);
  }
  /** Report locally counted datagram totals, used as a fallback by `WebTransport.getStats()`. */
  [kDatagramStats](): {
    datagramsSent: number;
    datagramsReceived: number;
  } {
    return {
      datagramsSent: this.#outgoingCount,
      datagramsReceived: 0,
    };
  }
}
/**
 * Wiring needed to bind a `WebTransport` to an established HTTP/3 CONNECT
 * stream: the event-emitting QUIC connection facade, the CONNECT stream id
 * used to route datagrams and incoming streams, and optional response
 * metadata.
 *
 * @internal
 */
export interface Http3WebTransportInit {
  /** QUIC connection facade emitting `datagram`, `stream`, `close`, and `error` events. */
  connection: EventTarget & {
    sendDatagram(data: Uint8Array): Promise<number>;
    openBidirectionalStream?(): Promise<any>;
    openUnidirectionalStream?(): Promise<any>;
    getStats?(): Promise<any>;
    exportKeyingMaterial?(
      label: string,
      context: Uint8Array,
      length: number,
    ): ArrayBuffer | Promise<ArrayBuffer>;
    peerCertificate?: Uint8Array | null;
    closeInfo?: {
      errorCode?: number;
      reason?: string;
    } | null;
  };
  /** Stream id of the extended CONNECT request this session is bound to. */
  sessionStreamId: bigint | number;
  /** Headers from the CONNECT response, surfaced via `responseHeaders`. */
  responseHeaders?: Headers;
  /** Negotiated application protocol; falls back to the `sec-webtransport-protocol` response header. */
  protocol?: string;
  /** Options to validate against the established connection (certificate pins, congestion control). */
  options?: WebTransportOptions;
  /** Set `false` when the owner routes incoming QUIC streams itself through the internal stream-routing hook. */
  routeIncomingStreams?: boolean;
}
type PromiseState<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};
const kFromHttp3 = Symbol('WebTransport.fromHttp3');
const kAcceptIncomingQuicStream = Symbol('WebTransport.acceptIncomingQuicStream');
function deferred<T>(): PromiseState<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
  };
}
/**
 * WebTransport session over HTTP/3.
 *
 * Constructing an instance starts session setup immediately: an HTTP/3 client
 * is opened against the URL origin and an extended CONNECT request is issued
 * for the URL path. `ready` settles when setup completes; `closed` settles
 * when the session ends. Setup failures reject `ready`, `closed`, and
 * `draining` with the same error, and error the datagram and incoming-stream
 * readables, so every consumption path observes the failure.
 *
 * Server code and Fino's HTTP client hand out already-connected instances, so
 * direct construction is mainly for browser-style client code.
 *
 * Throws a `TypeError` from the constructor when the URL is not `https:`.
 *
 * ```ts no_run
 * import { WebTransport } from 'fino:net/http/webtransport';
 *
 * const wt = new WebTransport('https://example.test/session', {
 *   protocols: ['chat-v1'],
 * });
 * await wt.ready;
 * console.log(wt.protocol);
 *
 * const reader = wt.incomingUnidirectionalStreams.getReader();
 * const { value: incoming } = await reader.read();
 *
 * wt.close({ closeCode: 0, reason: 'bye' });
 * ```
 */
export class WebTransport {
  readonly #url: string;
  #state: 'connecting' | 'connected' | 'closed' | 'failed' = 'connecting';
  #ready = deferred<void>();
  #closed = deferred<WebTransportCloseInfo>();
  #draining = deferred<void>();
  #datagrams: WebTransportDatagramDuplexStream;
  #connection: Http3WebTransportInit['connection'] | null = null;
  #sessionStreamId: bigint | null = null;
  #incomingBidirectionalController: ReadableStreamDefaultController<WebTransportBidirectionalStream> | null =
    null;
  #incomingUnidirectionalController: ReadableStreamDefaultController<WebTransportReceiveStream> | null =
    null;
  #incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
  #incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;
  #responseHeaders: Headers | null = null;
  #protocol = '';
  #reliability: 'pending' | 'reliable-only' | 'supports-unreliable' = 'supports-unreliable';
  #congestionControl: 'default' | 'throughput' | 'low-latency' = 'default';
  #supportsReliableOnly = false;
  #datagramsReceived = 0;
  #bytesReceived = 0;
  /**
   * Create a transport for `url` and begin connecting.
   *
   * The URL must use the `https:` scheme or a `TypeError` is thrown. Passing
   * `connect = false` skips the self-connect flow and leaves the object
   * detached; the internal factories use this to
   * attach state themselves.
   */
  constructor(url: string | URL, options: WebTransportOptions = {}, connect = true) {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:')
      throw new TypeError(`WebTransport requires https: URLs, got '${parsed.href}'`);
    this.#url = parsed.href;
    this.#congestionControl = options.congestionControl ?? 'default';
    this.#datagrams = new WebTransportDatagramDuplexStream((data) => this.#sendDatagram(data));
    this.#incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
      start: (controller) => {
        this.#incomingBidirectionalController = controller;
      },
    });
    this.#incomingUnidirectionalStreams = new ReadableStream<WebTransportReceiveStream>({
      start: (controller) => {
        this.#incomingUnidirectionalController = controller;
      },
    });
    if (connect) void this.#connect(options);
  }
  /**
   * Create a failed transport object for fail-fast unavailable paths.
   *
   * The returned instance is already in the failed state: `ready`, `closed`,
   * and `draining` reject with an `Error` carrying `reason`, and all stream
   * surfaces are errored. Used where WebTransport support is known to be
   * missing (for example, no HTTP/3 stack) but a standards-shaped object must
   * still be returned.
   *
   * ```ts no_run
   * const wt = WebTransport.unavailable('https://example.test/wt', 'no h3 support');
   * await wt.ready; // rejects with 'no h3 support'
   * ```
   */
  static unavailable(
    url: string | URL,
    reason = 'WebTransport over HTTP/3 is not available',
  ): WebTransport {
    const transport = new WebTransport(String(url), {}, false);
    const error = new Error(reason);
    transport.#fail(error);
    return transport;
  }
  /**
   * Create a connected transport bound to an HTTP/3 CONNECT stream.
   *
   * @internal
   */
  static [kFromHttp3](url: string | URL, init: Http3WebTransportInit): WebTransport {
    const transport = new WebTransport(String(url), {}, false);
    transport.#attachHttp3(init);
    return transport;
  }
  /** @internal */
  [kAcceptIncomingQuicStream](stream: any, firstChunk: Uint8Array): void {
    void this.#routeIncomingStream(stream, firstChunk);
  }
  /** Normalized session URL this transport was created for. */
  get url(): string {
    return this.#url;
  }
  /**
   * Resolves with `undefined` once the session is established.
   *
   * Establishment requires the extended CONNECT to succeed and any
   * `serverCertificateHashes` pins to validate. Rejects if setup fails or the
   * transport was created via `unavailable()`.
   */
  get ready(): Promise<void> {
    return this.#ready.promise;
  }
  /**
   * Settles when the session ends.
   *
   * Resolves with `WebTransportCloseInfo` on a clean close - whether initiated
   * locally via `close()` or by the peer - and rejects with the failure error
   * when setup fails or the transport errors.
   *
   * ```ts no_run
   * wt.closed.then(
   *   ({ closeCode, reason }) => console.log('closed', closeCode, reason),
   *   (error) => console.error('failed', error),
   * );
   * ```
   */
  get closed(): Promise<WebTransportCloseInfo> {
    return this.#closed.promise;
  }
  /**
   * Resolves when the session begins shutting down.
   *
   * In the current implementation this settles together with `closed`: it
   * resolves on clean close and rejects on transport failure.
   */
  get draining(): Promise<void> {
    return this.#draining.promise;
  }
  /** Datagram duplex stream for unreliable, unordered messaging on this session. */
  get datagrams(): WebTransportDatagramDuplexStream {
    return this.#datagrams;
  }
  /**
   * Stream of bidirectional streams opened by the peer.
   *
   * Each entry is a `WebTransportBidirectionalStream` whose stream-type prefix
   * matched this session. Closes on clean shutdown; errors on failure.
   *
   * ```ts no_run
   * const reader = wt.incomingBidirectionalStreams.getReader();
   * const { value: stream, done } = await reader.read();
   * ```
   */
  get incomingBidirectionalStreams(): ReadableStream<WebTransportBidirectionalStream> {
    return this.#incomingBidirectionalStreams;
  }
  /**
   * Stream of unidirectional receive streams opened by the peer.
   *
   * Closes on clean shutdown; errors on failure.
   */
  get incomingUnidirectionalStreams(): ReadableStream<WebTransportReceiveStream> {
    return this.#incomingUnidirectionalStreams;
  }
  /**
   * Headers from the CONNECT response, or `null` before the session connects.
   *
   * Fino extension beyond the W3C surface; useful for reading negotiated
   * metadata such as `sec-webtransport-http3-draft`.
   */
  get responseHeaders(): Headers | null {
    return this.#responseHeaders;
  }
  /**
   * Application protocol negotiated via `sec-webtransport-protocol`.
   *
   * Empty string when no protocol was offered or the server chose none.
   */
  get protocol(): string {
    return this.#protocol;
  }
  /** Whether the session can carry unreliable datagrams. Fino's HTTP/3 stack reports `'supports-unreliable'`. */
  get reliability(): 'pending' | 'reliable-only' | 'supports-unreliable' {
    return this.#reliability;
  }
  /** Congestion control preference recorded from the constructor options. */
  get congestionControl(): 'default' | 'throughput' | 'low-latency' {
    return this.#congestionControl;
  }
  /** Standard flag indicating a reliable-only transport; always `false` for HTTP/3 sessions. */
  get supportsReliableOnly(): boolean {
    return this.#supportsReliableOnly;
  }
  /**
   * Open a bidirectional stream to the peer.
   *
   * The WebTransport stream-type prefix carrying this session's id is written
   * before the returned stream is handed out, so callers can write payload
   * bytes immediately. Throws if the session is not connected or the
   * underlying connection cannot open bidirectional streams.
   *
   * ```ts no_run
   * const stream = await wt.createBidirectionalStream();
   * const writer = stream.writable.getWriter();
   * await writer.write(new TextEncoder().encode('ping'));
   * const { value } = await stream.readable.getReader().read();
   * ```
   */
  async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    this.#assertConnected();
    if (this.#connection?.openBidirectionalStream === undefined || this.#sessionStreamId === null) {
      throw new Error('WebTransport bidirectional streams are not available on this connection');
    }
    const stream = await this.#connection.openBidirectionalStream();
    await stream.writer.write(
      encodeWebTransportStreamPrefix('bidirectional', this.#sessionStreamId),
    );
    return wrapBidirectionalStream(stream);
  }
  /**
   * Open a send-only stream to the peer.
   *
   * Like `createBidirectionalStream()`, the session prefix is written before
   * the stream is returned. Throws if the session is not connected or the
   * underlying connection cannot open unidirectional streams.
   *
   * ```ts no_run
   * const send = await wt.createUnidirectionalStream();
   * const writer = send.getWriter();
   * await writer.write(new Uint8Array([1, 2, 3]));
   * await writer.close();
   * ```
   */
  async createUnidirectionalStream(): Promise<WebTransportSendStream> {
    this.#assertConnected();
    if (
      this.#connection?.openUnidirectionalStream === undefined ||
      this.#sessionStreamId === null
    ) {
      throw new Error('WebTransport unidirectional streams are not available on this connection');
    }
    const stream = await this.#connection.openUnidirectionalStream();
    await stream.writer.write(
      encodeWebTransportStreamPrefix('unidirectional', this.#sessionStreamId),
    );
    return wrapSendStream(stream.writer);
  }
  /**
   * Close the session cleanly.
   *
   * Settles the transport's local state: the datagram readable and both
   * incoming stream queues close, `draining` resolves, and `closed` resolves
   * with the provided close info (defaulting to code `0` and an empty reason).
   * Calling `close()` on an already-closed transport is a no-op.
   */
  close(info: WebTransportCloseInfo = {}): void {
    this.#finishClose({
      closeCode: info.closeCode ?? 0,
      reason: info.reason ?? '',
    });
  }
  /**
   * Snapshot session-level statistics.
   *
   * Prefers counters reported by the underlying QUIC connection; when a field
   * is unavailable it falls back to the transport's own datagram counters
   * (`bytesSent` falls back to `0`).
   */
  async getStats(): Promise<WebTransportStats> {
    const stats = await this.#connection?.getStats?.();
    const datagramStats = this.#datagrams[kDatagramStats]();
    return {
      datagramsSent: Number(stats?.datagramsSent ?? datagramStats.datagramsSent),
      datagramsReceived: Number(stats?.datagramsReceived ?? this.#datagramsReceived),
      bytesSent: Number(stats?.bytesSent ?? 0),
      bytesReceived: Number(stats?.bytesReceived ?? this.#bytesReceived),
    };
  }
  /**
   * Derive keying material from the session's TLS exporter.
   *
   * Waits for the session to be ready, then invokes the TLS exporter
   * (RFC 8446 / RFC 5705) on the QUIC connection. Both peers calling this
   * with the same label, context, and length obtain identical bytes, which
   * makes it useful for binding application-level secrets to the connection.
   * Throws if the QUIC TLS backend does not expose an exporter.
   *
   * ```ts no_run
   * const secret = await wt.exportKeyingMaterial(
   *   'my-app token',
   *   new TextEncoder().encode('context'),
   *   32,
   * );
   * ```
   */
  async exportKeyingMaterial(
    label: string,
    context: BufferSource,
    length: number,
  ): Promise<ArrayBuffer> {
    await this.ready;
    if (this.#connection?.exportKeyingMaterial === undefined) {
      throw new Error(
        'WebTransport exportKeyingMaterial() is not supported by this QUIC TLS backend',
      );
    }
    return this.#connection.exportKeyingMaterial(label, bufferSourceBytes(context), length);
  }
  async #connect(options: WebTransportOptions): Promise<void> {
    try {
      const { HttpClient } = await import('./client.ts');
      const parsed = new URL(this.#url);
      const client = new HttpClient({
        baseUrl: parsed.origin,
        protocols: ['h3'],
      });
      const connected = await client.webtransport(parsed.pathname + parsed.search, options as any);
      this.#adopt(connected);
      await connected.ready;
    } catch (error) {
      this.#fail(error);
    }
  }
  #adopt(other: WebTransport): void {
    this.#state = other.#state;
    this.#connection = other.#connection;
    this.#sessionStreamId = other.#sessionStreamId;
    this.#datagrams = other.#datagrams;
    this.#incomingBidirectionalStreams = other.#incomingBidirectionalStreams;
    this.#incomingUnidirectionalStreams = other.#incomingUnidirectionalStreams;
    this.#responseHeaders = other.#responseHeaders;
    this.#protocol = other.#protocol;
    this.#reliability = other.#reliability;
    this.#congestionControl = other.#congestionControl;
    this.#supportsReliableOnly = other.#supportsReliableOnly;
    other.ready.then(
      () => this.#ready.resolve(undefined),
      (error) => this.#ready.reject(error),
    );
    other.closed.then(
      (info) => this.#finishClose(info),
      (error) => this.#fail(error),
    );
    other.draining.then(
      () => this.#draining.resolve(undefined),
      (error) => this.#draining.reject(error),
    );
  }
  #attachHttp3(init: Http3WebTransportInit): void {
    if (this.#state === 'closed' || this.#state === 'failed') return;
    this.#connection = init.connection;
    this.#sessionStreamId = BigInt(init.sessionStreamId);
    this.#responseHeaders = init.responseHeaders ?? null;
    this.#protocol = init.protocol ?? this.#responseHeaders?.get('sec-webtransport-protocol') ?? '';
    init.connection.addEventListener('datagram', (event) => {
      if (this.#state !== 'connected' || this.#sessionStreamId === null) return;
      const data = (
        event as Event & {
          data?: Uint8Array;
        }
      ).data;
      if (!(data instanceof Uint8Array)) return;
      let decoded;
      try {
        decoded = decodeHttpDatagram(data);
      } catch {
        return;
      }
      if (decoded.streamId !== this.#sessionStreamId) return;
      this.#datagramsReceived++;
      this.#bytesReceived += decoded.payload.byteLength;
      this.#datagrams[kDatagramPush](decoded.payload);
    });
    if (init.routeIncomingStreams !== false) {
      init.connection.addEventListener('stream', (event) => {
        if (this.#state !== 'connected' || this.#sessionStreamId === null) return;
        const stream = (
          event as Event & {
            stream?: any;
          }
        ).stream;
        if (stream === undefined || stream?.reader?.read === undefined) return;
        void this.#routeIncomingStream(stream);
      });
    }
    init.connection.addEventListener(
      'close',
      () => {
        const closeInfo = init.connection.closeInfo ?? null;
        this.#finishClose({
          closeCode: closeInfo?.errorCode ?? 0,
          reason: closeInfo?.reason ?? '',
        });
      },
      { once: true },
    );
    init.connection.addEventListener(
      'error',
      (event) => {
        const error =
          (
            event as Event & {
              error?: unknown;
            }
          ).error ?? new Error('WebTransport transport error');
        this.#fail(error);
      },
      { once: true },
    );
    void this.#validateConnectionOptions(init.options ?? {}).then(
      () => {
        if (this.#state === 'closed' || this.#state === 'failed') return;
        this.#state = 'connected';
        this.#ready.resolve(undefined);
      },
      (error) => this.#fail(error),
    );
  }
  async #validateConnectionOptions(options: WebTransportOptions): Promise<void> {
    const hashes = options.serverCertificateHashes;
    if (hashes === undefined || hashes.length === 0) return;
    const cert = this.#connection?.peerCertificate ?? null;
    if (!(cert instanceof Uint8Array)) {
      throw new Error(
        'WebTransport serverCertificateHashes validation failed: peer certificate is unavailable',
      );
    }
    for (const hash of hashes) {
      const algorithm = normalizeHashAlgorithm(hash.algorithm);
      const expected = bufferSourceBytes(hash.value);
      const actual = new Uint8Array(await crypto.subtle.digest(algorithm, cert));
      if (bytesEqual(actual, expected)) return;
    }
    throw new Error(
      'WebTransport serverCertificateHashes validation failed: no certificate hash matched',
    );
  }
  async #routeIncomingStream(stream: any, firstChunk?: Uint8Array): Promise<void> {
    const firstResult = firstChunk === undefined ? await stream.reader.read() : null;
    const first = firstChunk ?? (firstResult?.done ? undefined : firstResult?.value);
    if (!(first instanceof Uint8Array) || this.#sessionStreamId === null) return;
    let decoded;
    try {
      decoded = decodeWebTransportStreamPrefix(first);
    } catch {
      return;
    }
    if (decoded.sessionId !== this.#sessionStreamId) return;
    const remainder = first.subarray(decoded.headerLength);
    if (decoded.kind === 'bidirectional') {
      this.#incomingBidirectionalController?.enqueue(wrapBidirectionalStream(stream, remainder));
    } else {
      this.#incomingUnidirectionalController?.enqueue(wrapReceiveStream(stream.reader, remainder));
    }
  }
  async #sendDatagram(data: Uint8Array): Promise<number> {
    this.#assertConnected();
    if (this.#connection === null || this.#sessionStreamId === null) {
      throw new Error('WebTransport datagrams are not available on this connection');
    }
    return this.#connection.sendDatagram(encodeHttpDatagram(this.#sessionStreamId, data));
  }
  #assertConnected(): void {
    if (this.#state !== 'connected')
      throw new Error('WebTransport is closed, unavailable, or not ready');
  }
  #finishClose(info: WebTransportCloseInfo = {}): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    const closeInfo = {
      closeCode: info.closeCode ?? 0,
      reason: info.reason ?? '',
    };
    this.#datagrams[kDatagramClose]();
    this.#incomingBidirectionalController?.close();
    this.#incomingUnidirectionalController?.close();
    this.#draining.resolve(undefined);
    this.#closed.resolve(closeInfo);
  }
  #fail(reason: unknown): void {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.#state = 'failed';
    this.#datagrams[kDatagramError](error);
    this.#incomingBidirectionalController?.error(error);
    this.#incomingUnidirectionalController?.error(error);
    this.#ready.reject(error);
    this.#closed.reject(error);
    this.#draining.reject(error);
  }
}
/**
 * Create a connected `WebTransport` bound to an established HTTP/3 CONNECT
 * stream.
 *
 * This is used by Fino's HTTP/3 client and server drivers after the extended
 * CONNECT has completed. Application code should use `new WebTransport()`,
 * `HttpClient.webtransport()`, or `IncomingWebTransportRequest.accept()`.
 *
 * @internal
 */
export function _fromHttp3WebTransport(
  url: string | URL,
  init: Http3WebTransportInit,
): WebTransport {
  return WebTransport[kFromHttp3](url, init);
}
/**
 * Route an incoming QUIC stream into an existing WebTransport session.
 *
 * This is the HTTP/3 driver's hook for streams whose WebTransport prefix was
 * already read while routing by session id.
 *
 * @internal
 */
export function _acceptIncomingQuicWebTransportStream(
  transport: WebTransport,
  stream: any,
  firstChunk: Uint8Array,
): void {
  transport[kAcceptIncomingQuicStream](stream, firstChunk);
}
function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}
function bufferSourceBytes(source: BufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}
function normalizeHashAlgorithm(algorithm: string): string {
  const normalized = algorithm.toLowerCase().replace(/_/g, '-');
  if (normalized === 'sha-256' || normalized === 'sha256') return 'SHA-256';
  throw new TypeError(`Unsupported WebTransport serverCertificateHashes algorithm: ${algorithm}`);
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
function wrapReceiveStream(
  reader: {
    read(): Promise<{ done: false; value: Uint8Array } | { done: true; value: undefined }>;
  },
  firstChunk?: Uint8Array,
): WebTransportReceiveStream {
  let bytesRead = 0;
  let pending = firstChunk !== undefined && firstChunk.byteLength > 0 ? firstChunk : null;
  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (pending !== null) {
        const chunk = pending;
        pending = null;
        bytesRead += chunk.byteLength;
        controller.enqueue(chunk);
        return;
      }
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      const chunk = result.value;
      bytesRead += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }) as WebTransportReceiveStream;
  stream.getStats = async () => ({ bytesRead });
  return stream;
}
function wrapSendStream(writer: {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}): WebTransportSendStream {
  let bytesWritten = 0;
  const stream = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      const bytes = toBytes(chunk);
      bytesWritten += bytes.byteLength;
      await writer.write(bytes);
    },
    close: () => writer.close(),
    abort: async (reason) => {
      if (typeof (writer as any).resetAt === 'function') {
        await (writer as any).resetAt(0, reason);
        return;
      }
      throw new Error('WebTransport stream abort/reset is not supported by this QUIC stream');
    },
  }) as WebTransportSendStream;
  stream.sendGroup = null;
  stream.sendOrder = null;
  stream.getStats = async () => ({ bytesWritten });
  return stream;
}
function wrapBidirectionalStream(
  stream: any,
  firstReadableChunk?: Uint8Array,
): WebTransportBidirectionalStream {
  return {
    readable: wrapReceiveStream(stream.reader, firstReadableChunk),
    writable: wrapSendStream(stream.writer),
  };
}
