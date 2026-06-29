/**
 * fino:net/http/webtransport - standards-shaped WebTransport over HTTP/3.
 *
 * The `WebTransport` class mirrors the W3C WebTransport object model while
 * using Fino's HTTP/3 and QUIC implementation underneath. Applications may
 * construct it directly with an HTTPS URL or receive an already-connected
 * instance from `HttpClient.webtransport()`, `HttpSession.webtransport()`, or
 * server-side `IncomingWebTransportRequest.accept()`.
 *
 * A constructed transport enters its setup flow immediately. `ready` resolves
 * with `undefined` after the HTTP/3 extended CONNECT succeeds. `closed`
 * resolves with `{ closeCode, reason }` on clean shutdown and rejects when
 * setup or transport failure aborts the session. Datagrams use the standard
 * `WebTransportDatagramDuplexStream` shape, and incoming streams are exposed as
 * `ReadableStream`s of standard receive/bidirectional stream wrappers.
 *
 * ```ts no_run
 * const wt = new WebTransport('https://example.test/session');
 * await wt.ready;
 *
 * const writer = wt.datagrams.createWritable().getWriter();
 * await writer.write(new Uint8Array([1, 2, 3]));
 * writer.releaseLock();
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

/** Information reported when a WebTransport closes cleanly. */
export interface WebTransportCloseInfo {
  /** Application close code. Defaults to `0`. */
  closeCode?: number;
  /** Human-readable close reason. Defaults to the empty string. */
  reason?: string;
}

/** Server certificate hash pin accepted by the standard constructor options. */
export interface WebTransportHash {
  algorithm: string;
  value: BufferSource;
}

/** Options accepted by `new WebTransport()` and Fino HTTP helpers. */
export interface WebTransportOptions {
  allowPooling?: boolean;
  requireUnreliable?: boolean;
  headers?: Headers | Record<string, string>;
  serverCertificateHashes?: readonly WebTransportHash[];
  congestionControl?: 'default' | 'throughput' | 'low-latency';
  anticipatedConcurrentIncomingUnidirectionalStreams?: number | null;
  anticipatedConcurrentIncomingBidirectionalStreams?: number | null;
  protocols?: readonly string[];
  datagramsReadableType?: 'bytes';
}

export interface WebTransportSendStreamStats {
  bytesWritten: number;
}

export interface WebTransportReceiveStreamStats {
  bytesRead: number;
}

export interface WebTransportStats {
  datagramsSent: number;
  datagramsReceived: number;
  bytesSent: number;
  bytesReceived: number;
}

/** Writable side of a WebTransport stream. */
export type WebTransportSendStream = WritableStream<Uint8Array> & {
  sendGroup: string | null;
  sendOrder: number | null;
  getStats(): Promise<WebTransportSendStreamStats>;
};

/** Readable side of a WebTransport stream. */
export type WebTransportReceiveStream = ReadableStream<Uint8Array> & {
  getStats(): Promise<WebTransportReceiveStreamStats>;
};

/** Standard bidirectional stream wrapper. */
export interface WebTransportBidirectionalStream {
  readonly readable: WebTransportReceiveStream;
  readonly writable: WebTransportSendStream;
}

type DatagramSink = (data: Uint8Array) => Promise<unknown>;

/** Standard datagram duplex stream facade. */
export class WebTransportDatagramDuplexStream {
  readonly #readable: ReadableStream<Uint8Array>;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #closed = false;
  #send: DatagramSink;
  #maxDatagramSize: number;
  #outgoingCount = 0;

  incomingMaxAge: number | null = null;
  outgoingMaxAge: number | null = null;
  incomingMaxBufferedDatagrams = 16;
  outgoingMaxBufferedDatagrams = 16;

  constructor(send: DatagramSink, maxDatagramSize = 65535) {
    this.#send = send;
    this.#maxDatagramSize = maxDatagramSize;
    this.#readable = new ReadableStream<Uint8Array>({
      start: (controller) => { this.#controller = controller; },
    });
  }

  get readable(): ReadableStream<Uint8Array> { return this.#readable; }
  get maxDatagramSize(): number { return this.#maxDatagramSize; }

  createWritable(_options: { sendOrder?: number } = {}): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.#closed) throw new Error('WebTransport datagrams are closed');
        const bytes = toBytes(chunk);
        if (bytes.byteLength > this.#maxDatagramSize) {
          throw new RangeError(`WebTransport datagram size ${bytes.byteLength} exceeds maxDatagramSize ${this.#maxDatagramSize}`);
        }
        this.#outgoingCount++;
        await this.#send(bytes);
      },
    });
  }

  _push(data: Uint8Array): void {
    if (this.#closed || this.#controller === null) return;
    this.#controller.enqueue(data);
  }

  _close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller?.close();
  }

  _error(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller?.error(error);
  }

  _stats(): { datagramsSent: number; datagramsReceived: number } {
    return { datagramsSent: this.#outgoingCount, datagramsReceived: 0 };
  }
}

/** @internal */
export interface Http3WebTransportInit {
  connection: EventTarget & {
    sendDatagram(data: Uint8Array): Promise<number>;
    openBidirectionalStream?(): Promise<any>;
    openUnidirectionalStream?(): Promise<any>;
    getStats?(): Promise<any>;
    exportKeyingMaterial?(label: string, context: Uint8Array, length: number): ArrayBuffer | Promise<ArrayBuffer>;
    peerCertificate?: Uint8Array | null;
    closeInfo?: { errorCode?: number; reason?: string } | null;
  };
  sessionStreamId: bigint | number;
  responseHeaders?: Headers;
  protocol?: string;
  options?: WebTransportOptions;
  routeIncomingStreams?: boolean;
}

type PromiseState<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): PromiseState<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * WebTransport session over HTTP/3.
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
  #incomingBidirectionalController: ReadableStreamDefaultController<WebTransportBidirectionalStream> | null = null;
  #incomingUnidirectionalController: ReadableStreamDefaultController<WebTransportReceiveStream> | null = null;
  #incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
  #incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;
  #responseHeaders: Headers | null = null;
  #protocol = '';
  #reliability: 'pending' | 'reliable-only' | 'supports-unreliable' = 'supports-unreliable';
  #congestionControl: 'default' | 'throughput' | 'low-latency' = 'default';
  #supportsReliableOnly = false;
  #datagramsReceived = 0;
  #bytesReceived = 0;

  constructor(url: string | URL, options: WebTransportOptions = {}, connect = true) {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') throw new TypeError(`WebTransport requires https: URLs, got '${parsed.href}'`);
    this.#url = parsed.href;
    this.#congestionControl = options.congestionControl ?? 'default';
    this.#datagrams = new WebTransportDatagramDuplexStream((data) => this.#sendDatagram(data));
    this.#incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
      start: (controller) => { this.#incomingBidirectionalController = controller; },
    });
    this.#incomingUnidirectionalStreams = new ReadableStream<WebTransportReceiveStream>({
      start: (controller) => { this.#incomingUnidirectionalController = controller; },
    });
    if (connect) void this.#connect(options);
  }

  /** Create a failed transport object for fail-fast unavailable paths. */
  static unavailable(url: string | URL, reason = 'WebTransport over HTTP/3 is not available'): WebTransport {
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
  static _fromHttp3(url: string | URL, init: Http3WebTransportInit): WebTransport {
    const transport = new WebTransport(String(url), {}, false);
    transport.#attachHttp3(init);
    return transport;
  }

  /** @internal */
  _acceptIncomingQuicStream(stream: any, firstChunk: Uint8Array): void {
    void this.#routeIncomingStream(stream, firstChunk);
  }

  get url(): string { return this.#url; }
  get ready(): Promise<void> { return this.#ready.promise; }
  get closed(): Promise<WebTransportCloseInfo> { return this.#closed.promise; }
  get draining(): Promise<void> { return this.#draining.promise; }
  get datagrams(): WebTransportDatagramDuplexStream { return this.#datagrams; }
  get incomingBidirectionalStreams(): ReadableStream<WebTransportBidirectionalStream> { return this.#incomingBidirectionalStreams; }
  get incomingUnidirectionalStreams(): ReadableStream<WebTransportReceiveStream> { return this.#incomingUnidirectionalStreams; }
  get responseHeaders(): Headers | null { return this.#responseHeaders; }
  get protocol(): string { return this.#protocol; }
  get reliability(): 'pending' | 'reliable-only' | 'supports-unreliable' { return this.#reliability; }
  get congestionControl(): 'default' | 'throughput' | 'low-latency' { return this.#congestionControl; }
  get supportsReliableOnly(): boolean { return this.#supportsReliableOnly; }

  async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    this.#assertConnected();
    if (this.#connection?.openBidirectionalStream === undefined || this.#sessionStreamId === null) {
      throw new Error('WebTransport bidirectional streams are not available on this connection');
    }
    const stream = await this.#connection.openBidirectionalStream();
    await stream.writer.write(encodeWebTransportStreamPrefix('bidirectional', this.#sessionStreamId));
    return wrapBidirectionalStream(stream);
  }

  async createUnidirectionalStream(): Promise<WebTransportSendStream> {
    this.#assertConnected();
    if (this.#connection?.openUnidirectionalStream === undefined || this.#sessionStreamId === null) {
      throw new Error('WebTransport unidirectional streams are not available on this connection');
    }
    const stream = await this.#connection.openUnidirectionalStream();
    await stream.writer.write(encodeWebTransportStreamPrefix('unidirectional', this.#sessionStreamId));
    return wrapSendStream(stream.writer);
  }

  close(info: WebTransportCloseInfo = {}): void {
    this.#finishClose({
      closeCode: info.closeCode ?? 0,
      reason: info.reason ?? '',
    });
  }

  async getStats(): Promise<WebTransportStats> {
    const stats = await this.#connection?.getStats?.();
    const datagramStats = this.#datagrams._stats();
    return {
      datagramsSent: Number(stats?.datagramsSent ?? datagramStats.datagramsSent),
      datagramsReceived: Number(stats?.datagramsReceived ?? this.#datagramsReceived),
      bytesSent: Number(stats?.bytesSent ?? 0),
      bytesReceived: Number(stats?.bytesReceived ?? this.#bytesReceived),
    };
  }

  async exportKeyingMaterial(label: string, context: BufferSource, length: number): Promise<ArrayBuffer> {
    await this.ready;
    if (this.#connection?.exportKeyingMaterial === undefined) {
      throw new Error('WebTransport exportKeyingMaterial() is not supported by this QUIC TLS backend');
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
      const data = (event as Event & { data?: Uint8Array }).data;
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
      this.#datagrams._push(decoded.payload);
    });

    if (init.routeIncomingStreams !== false) {
      init.connection.addEventListener('stream', (event) => {
        if (this.#state !== 'connected' || this.#sessionStreamId === null) return;
        const stream = (event as Event & { stream?: any }).stream;
        if (stream === undefined || stream?.reader?.read === undefined) return;
        void this.#routeIncomingStream(stream);
      });
    }

    init.connection.addEventListener('close', () => {
      const closeInfo = init.connection.closeInfo ?? null;
      this.#finishClose({
        closeCode: closeInfo?.errorCode ?? 0,
        reason: closeInfo?.reason ?? '',
      });
    }, { once: true });

    init.connection.addEventListener('error', (event) => {
      const error = (event as Event & { error?: unknown }).error ?? new Error('WebTransport transport error');
      this.#fail(error);
    }, { once: true });

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
      throw new Error('WebTransport serverCertificateHashes validation failed: peer certificate is unavailable');
    }
    for (const hash of hashes) {
      const algorithm = normalizeHashAlgorithm(hash.algorithm);
      const expected = bufferSourceBytes(hash.value);
      const actual = new Uint8Array(await crypto.subtle.digest(algorithm, cert));
      if (bytesEqual(actual, expected)) return;
    }
    throw new Error('WebTransport serverCertificateHashes validation failed: no certificate hash matched');
  }

  async #routeIncomingStream(stream: any, firstChunk?: Uint8Array): Promise<void> {
    const first = firstChunk ?? await stream.reader.read();
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
    if (this.#state !== 'connected') throw new Error('WebTransport is closed, unavailable, or not ready');
  }

  #finishClose(info: WebTransportCloseInfo = {}): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    const closeInfo = {
      closeCode: info.closeCode ?? 0,
      reason: info.reason ?? '',
    };
    this.#datagrams._close();
    this.#incomingBidirectionalController?.close();
    this.#incomingUnidirectionalController?.close();
    this.#draining.resolve(undefined);
    this.#closed.resolve(closeInfo);
  }

  #fail(reason: unknown): void {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.#state = 'failed';
    this.#datagrams._error(error);
    this.#incomingBidirectionalController?.error(error);
    this.#incomingUnidirectionalController?.error(error);
    this.#ready.reject(error);
    this.#closed.reject(error);
    this.#draining.reject(error);
  }
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

function wrapReceiveStream(reader: { read(): Promise<Uint8Array | null> }, firstChunk?: Uint8Array): WebTransportReceiveStream {
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
      const chunk = await reader.read();
      if (chunk === null) {
        controller.close();
        return;
      }
      bytesRead += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }) as WebTransportReceiveStream;
  stream.getStats = async () => ({ bytesRead });
  return stream;
}

function wrapSendStream(writer: { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }): WebTransportSendStream {
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

function wrapBidirectionalStream(stream: any, firstReadableChunk?: Uint8Array): WebTransportBidirectionalStream {
  return {
    readable: wrapReceiveStream(stream.reader, firstReadableChunk),
    writable: wrapSendStream(stream.writer),
  };
}
