/**
 * internal:net/http/pool - per-realm H2 connection pool.
 *
 * One `H2PoolEntry` per origin (scheme://host:port). Each entry holds a live
 * nghttp2 client session that multiplexes concurrent streams. A background
 * recv loop drives the session; `send()` submits new streams and awaits their
 * individual response deferreds.
 *
 * Responses resolve as soon as their final header block is complete. DATA is
 * delivered through a bounded `HttpBodyQueue`, trailers settle independently
 * at stream completion, and early body cancellation resets only the affected
 * stream. Request bodies are pulled one chunk at a time and pause at nghttp2's
 * flow-control boundary, so uploads remain bounded and observable before EOF.
 *
 * ## drainWrite serialization
 *
 * As in the per-request driver, concurrent `nghttp2_session_mem_send2` calls
 * on the same session are a data race. A FIFO serializes all drainWrite calls
 * across both the recv loop and concurrent `send()` calls.
 *
 * ## GOAWAY handling
 *
 * When the peer sends GOAWAY (or we get a transport error), the pool entry is
 * marked `goingAway = true`. New streams are refused; in-flight streams for
 * IDs <= lastStreamId run to completion; remaining pending streams are rejected.
 * The entry is evicted from the pool on the next `acquire()` check. Refused or
 * GOAWAY-affected streams are not automatically retried by this pool entry;
 * callers that own replay safety must issue a new request through a fresh pool
 * acquisition.
 *
 * ## Idle timeout
 *
 * If no streams are active for IDLE_MS milliseconds, the entry sends GOAWAY
 * and is evicted. The timer is reset on every new send().
 *
 * ## Example
 *
 * ```ts no_run
 * import {
 *   H2ConnectionPool,
 *   createPoolEntry,
 * } from 'internal:net/http/pool';
 *
 * const pool = new H2ConnectionPool();
 * const entry = createPoolEntry(reader, writer);
 *
 * pool.add('https://example.test:443', entry);
 * pool.get('https://example.test:443')?.activeStreams;
 * ```
 *
 * Learn more:
 * - HTTP/2 streams, flow control, resets, and response messages:
 *   https://www.rfc-editor.org/rfc/rfc9113
 *
 * @internal
 */
import { buildWireResponse, Headers, Request, Response } from 'internal:net/http/wire';
import { Nghttp2Session } from './h2/session.ts';
import type { H2StreamCallbacks } from './h2/session.ts';
import { HttpBodyQueue, HttpStreamError } from './stream.ts';
import {
  NGHTTP2_FLAG_END_HEADERS,
  NGHTTP2_FLAG_END_STREAM,
  NGHTTP2_FRAME_TYPE_DATA,
  NGHTTP2_FRAME_TYPE_GOAWAY,
  NGHTTP2_FRAME_TYPE_HEADERS,
} from './h2/bindings.ts';
import { Channel, type BufferedBytesReader, type BytesWriter } from '../../stream.ts';
/**
 * Default idle timeout in milliseconds (60s) before an idle entry self-evicts.
 *
 * @internal
 */
const IDLE_MS = 6e4;
/** HTTP/2 `CANCEL` error code used for consumer-initiated stream resets. */
const H2_CANCEL = 0x08;
const FETCH_RESPONSE_METADATA = Symbol.for('fino.fetch.response-metadata');
let h2ConnectionSeq = 0;
/**
 * Optional tuning for a pool entry.
 *
 * `idleMs` overrides the default idle-eviction timeout; omit it to inherit
 * `IDLE_MS`. A short value is useful in tests to force idle teardown quickly.
 *
 * @internal
 */
interface H2PoolEntryOptions {
  idleMs?: number;
  /** Maximum unread response bytes buffered for each stream. Defaults to 16 MiB. */
  maxBufferedBodyBytes?: number;
}
// ---------------------------------------------------------------------------
// Per-stream state inside a pool entry
// ---------------------------------------------------------------------------
/**
 * Mutable state accumulated for one in-flight HTTP/2 stream.
 *
 * The receive-loop callbacks build up response headers and feed DATA directly
 * into `body`. `responseResolved` separates final-header arrival from stream
 * completion, while the trailer deferred settles only when END_STREAM arrives.
 *
 * @internal
 */
interface StreamDeferred {
  streamId: number;
  status: number;
  headers: Headers;
  trailerHeaders: Headers;
  inTrailers: boolean;
  method: string;
  body: HttpBodyQueue;
  done: boolean;
  responseResolved: boolean;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  trailers: Promise<Headers>;
  trailerResolve: (headers: Headers) => void;
  trailerReject: (reason: unknown) => void;
  uploadIterator: AsyncIterator<Uint8Array> | null;
  abortCleanup: (() => void) | null;
  reused: boolean;
}
// ---------------------------------------------------------------------------
// H2PoolEntry - one live H2 connection
// ---------------------------------------------------------------------------
/**
 * One reusable HTTP/2 client connection for a single origin.
 *
 * The entry owns an nghttp2 client session, a background receive loop, and all
 * in-flight stream deferreds. New requests are refused once the connection is
 * going away or closed. Responses stream through a bounded queue and may be
 * cancelled independently. Request uploads are pulled incrementally under
 * nghttp2 flow control.
 *
 * ```ts no_run
 * import { createPoolEntry } from 'internal:net/http/pool';
 * const entry = createPoolEntry(reader, writer);
 * entry.activeStreams;
 * ```
 *
 * @internal
 */
export class H2PoolEntry {
  /** Stable identity assigned when this physical HTTP/2 connection is created. */
  readonly id = `h2-connection-${++h2ConnectionSeq}`;
  /** Monotonic timestamp recorded when this physical connection is created. */
  readonly connectedAt = performance.now();
  /**
   * The live nghttp2 client session multiplexing all streams on this connection.
   *
   * @internal
   */
  readonly #session: Nghttp2Session;
  /**
   * Write half of the connected socket; receives serialized nghttp2 output.
   *
   * @internal
   */
  readonly #writer: BytesWriter;
  /**
   * Read half of the connected socket; drained by the background receive loop.
   *
   * @internal
   */
  readonly #reader: BufferedBytesReader;
  /**
   * In-flight streams keyed by nghttp2 stream identifier.
   *
   * Each `StreamDeferred` owns response headers, trailers, and a bounded live
   * body queue. Entries are removed on stream close, finish, cancellation, or
   * teardown.
   *
   * @internal
   */
  #streams = new Map<number, StreamDeferred>();
  /**
   * Whether the connection is refusing new streams.
   *
   * Set on idle timeout, explicit close, peer GOAWAY, or transport failure.
   * Backs the public `goingAway` getter.
   *
   * @internal
   */
  #goingAway = false;
  /**
   * Advisory ceiling on concurrent streams for this connection.
   *
   * @internal
   */
  #maxConcurrent = 100;
  #requestCount = 0;
  /**
   * Whether the nghttp2 session and I/O halves have been closed.
   *
   * Once set, `drainWrite`, `send`, and the receive loop become no-ops.
   *
   * @internal
   */
  #closed = false;
  /**
   * Rendezvous channel serializing every `drainWrite` call.
   *
   * Concurrent `nghttp2_session_mem_send2` calls on one session are a data race,
   * so all flushes from the receive loop and from `send()` pass through one
   * channel consumer.
   *
   * @internal
   */
  #drains = new Channel<() => Promise<void>>();
  /**
   * Memoized promise for the in-progress or completed graceful close.
   *
   * Non-null once `close()` has started, making repeated calls idempotent.
   *
   * @internal
   */
  #closePromise: Promise<void> | null = null;
  /**
   * Handle for the idle-eviction timer, or `null` when disarmed.
   *
   * @internal
   */
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Idle timeout in milliseconds before an idle connection self-evicts.
   *
   * @internal
   */
  readonly #idleMs: number;
  /** Maximum unread response bytes buffered by any one stream. */
  readonly #maxBufferedBodyBytes: number;
  /**
   * Create a pool entry around a client nghttp2 session and split streams.
   *
   * The constructor starts a background receive loop immediately and arms the
   * idle timer. The reader and writer must belong to the same connected socket.
   *
   * ```ts no_run
   * import { H2PoolEntry } from 'internal:net/http/pool';
   * const entry = new H2PoolEntry(session, reader, writer);
   * entry.goingAway;
   * ```
   */
  constructor(
    session: Nghttp2Session,
    reader: BufferedBytesReader,
    writer: BytesWriter,
    options: H2PoolEntryOptions = {},
  ) {
    this.#session = session;
    this.#reader = reader;
    this.#writer = writer;
    this.#idleMs = options.idleMs ?? IDLE_MS;
    this.#maxBufferedBodyBytes = options.maxBufferedBodyBytes ?? 16 * 1024 * 1024;
    void (async () => {
      for await (const drain of this.#drains.reader) await drain();
    })();
    // Start the background recv loop (fire and forget - errors are handled inside).
    this.#recvLoop(reader).catch(() => {});
    this.#resetIdleTimer();
  }
  /**
   * Whether this connection is refusing new streams.
   *
   * The value becomes `true` after idle timeout, explicit close, GOAWAY-style
   * teardown, or transport failure. Existing in-flight streams may still settle.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.goingAway;
   * ```
   */
  get goingAway(): boolean {
    return this.#goingAway;
  }
  /**
   * Number of active stream deferreds tracked by this entry.
   *
   * The count includes streams awaiting headers, body, trailers, or close
   * callbacks. It returns `0` when no requests are in flight.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.activeStreams;
   * ```
   */
  get activeStreams(): number {
    return this.#streams.size;
  }
  // -------------------------------------------------------------------------
  // drainWrite (serialized)
  // -------------------------------------------------------------------------
  /**
   * Serialize and flush all pending nghttp2 output to the writer.
   *
   * Calls pass through a single channel consumer because concurrent
   * `nghttp2_session_mem_send2` calls on the same session would race. The
   * promise resolves after writer flush, or rejects if the writer fails.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * await entry.drainWrite();
   * ```
   */
  drainWrite(): Promise<void> {
    const drainH2PoolWrites = async () => {
      if (this.#closed) return;
      while (this.#session.wantWrite()) {
        const bytes = this.#session.flush();
        if (bytes && bytes.byteLength > 0) await this.#writer.write(bytes);
      }
      await this.#writer.flush();
    };
    return new Promise<void>((resolve, reject) => {
      const accepted = this.#drains.writer.write(async () => {
        try {
          await drainH2PoolWrites();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      void accepted.catch(reject);
    });
  }
  // -------------------------------------------------------------------------
  // send() - submit a new request stream
  // -------------------------------------------------------------------------
  /**
   * Submit an HTTP request on a new HTTP/2 stream.
   *
   * Request and response bodies both stream. The upload producer is pulled one
   * chunk at a time and pauses until nghttp2 consumes that chunk under the
   * peer's flow-control window. The returned promise resolves when final
   * response headers are complete.
   *
   * ```ts no_run
   * import { Request } from 'internal:net/http/wire';
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * const res = await entry.send(new Request('https://example.test/'));
   * res.status;
   * ```
   */
  async send(req: Request): Promise<Response> {
    if (this.#goingAway || this.#closed) {
      throw new Error('H2PoolEntry: connection is going away');
    }
    this.#resetIdleTimer();
    // Build request HEADERS: pseudo-headers first, then regular.
    const url = new URL(req.url);
    const requestHeaders: Array<[string, string]> = [
      [':method', req.method],
      [':path', url.pathname + url.search],
      [':scheme', url.protocol.replace(':', '')],
      [':authority', url.host],
    ];
    for (const [k, v] of req.headers.entries()) {
      if (
        k === 'host' ||
        k === 'connection' ||
        k === 'keep-alive' ||
        k === 'transfer-encoding' ||
        k === 'upgrade'
      )
        continue;
      requestHeaders.push([k, v]);
    }
    const requestBody = req.body;
    const hasTrailers = req._hasOutTrailers();
    const hasBody = requestBody !== null || hasTrailers;
    const streamId = this.#session.submitRequest(requestHeaders, hasBody);
    const reused = this.#requestCount++ > 0;
    let trailerResolve!: (headers: Headers) => void;
    let trailerReject!: (reason: unknown) => void;
    const trailers = new Promise<Headers>((resolve, reject) => {
      trailerResolve = resolve;
      trailerReject = reject;
    });
    void trailers.catch(() => {});
    const body = new HttpBodyQueue({
      maxBufferedBytes: this.#maxBufferedBodyBytes,
      onCancel: (reason) => this.#cancelStream(streamId, reason),
    });
    // Register the stream before flushing because recv callbacks may arrive as
    // soon as the first write yields to the socket.
    const responsePromise = new Promise<Response>((resolve, reject) => {
      this.#streams.set(streamId, {
        streamId,
        status: 0,
        headers: new Headers(),
        trailerHeaders: new Headers(),
        inTrailers: false,
        method: req.method,
        body,
        done: false,
        responseResolved: false,
        resolve,
        reject,
        trailers,
        trailerResolve,
        trailerReject,
        uploadIterator: null,
        abortCleanup: null,
        reused,
      });
    });
    const stream = this.#streams.get(streamId)!;
    const signal = req.signal;
    if (signal.aborted) {
      await this.#cancelStream(streamId, signal.reason);
      throw signal.reason;
    }
    const onAbort = () => {
      void this.#cancelStream(streamId, signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    stream.abortCleanup = () => signal.removeEventListener('abort', onAbort);
    await this.drainWrite();
    if (hasBody) void this.#pumpUpload(stream, requestBody, req).catch(() => {});
    return responsePromise;
  }
  async #pumpUpload(
    stream: StreamDeferred,
    body: ReadableStream | null,
    req: Request,
  ): Promise<void> {
    try {
      if (body !== null) {
        const iterator = (body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
        stream.uploadIterator = iterator;
        while (!stream.done) {
          const result = await iterator.next();
          if (result.done) break;
          const bytes =
            result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
          if (bytes.byteLength === 0) continue;
          for (let offset = 0; offset < bytes.byteLength && !stream.done; offset += 64 * 1024) {
            this.#session.setStreamData(
              stream.streamId,
              bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.byteLength)),
            );
            await this.drainWrite();
            await this.#session.waitForStreamDataConsumed(stream.streamId);
          }
        }
        stream.uploadIterator = null;
      }
      if (stream.done) return;
      const rawTrailers = req._getRawOutTrailers();
      if (rawTrailers !== null) {
        const trailers =
          rawTrailers instanceof Headers ? rawTrailers : await Promise.resolve(rawTrailers());
        const fields: Array<[string, string]> = [];
        for (const [name, value] of trailers) fields.push([name, value]);
        this.#session.setStreamData(stream.streamId, null, { noEndStream: true });
        await this.drainWrite();
        if (fields.length > 0) this.#session.submitTrailer(stream.streamId, fields);
      } else {
        this.#session.setStreamData(stream.streamId, null);
      }
      await this.drainWrite();
    } catch (reason) {
      if (stream.done) return;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.#failStream(stream, error);
      this.#streams.delete(stream.streamId);
      this.#session.submitRstStream(stream.streamId, H2_CANCEL);
      await this.drainWrite().catch(() => {});
    }
  }
  // -------------------------------------------------------------------------
  // Background recv loop
  // -------------------------------------------------------------------------
  /**
   * Background loop that feeds inbound socket bytes into the nghttp2 session.
   *
   * Each chunk is passed to `session.recv` and any resulting output is flushed
   * through `drainWrite`. The loop exits when the reader ends, the entry closes,
   * or an error occurs, and always runs `#teardown` in its `finally` block so
   * pending streams are rejected once the transport is gone.
   *
   * @internal
   */
  async #recvLoop(reader: BufferedBytesReader): Promise<void> {
    try {
      for await (const chunk of reader) {
        if (this.#closed) break;
        this.#session.recv(chunk);
        await this.drainWrite();
      }
    } catch {
    } finally {
      this.#teardown(new Error('H2 connection closed'));
    }
  }
  // -------------------------------------------------------------------------
  // Callbacks (wired in H2ConnectionPool.createEntry)
  // -------------------------------------------------------------------------
  /**
   * Mark a stream as receiving trailers when nghttp2 begins a trailer block.
   *
   * Unknown streams are ignored because callbacks may arrive after local
   * teardown. Initial header blocks leave the stream in normal header mode.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.handleBeginHeaders(1, true);
   * ```
   *
   * @internal
   */
  handleBeginHeaders(streamId: number, isTrailers: boolean): void {
    const s = this.#streams.get(streamId);
    if (!s) return;
    s.inTrailers = isTrailers;
    // RFC 9113 permits one or more informational responses before the final
    // response. Discard their fields when the next response block begins.
    if (!isTrailers && s.status >= 100 && s.status < 200) {
      s.status = 0;
      s.headers = new Headers();
    }
  }
  /**
   * Handle one decoded HTTP/2 response header.
   *
   * `:status` updates the response status. Regular headers are appended to
   * either response headers or trailer headers depending on callback state.
   * Unknown streams are ignored.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.handleHeader(1, ':status', '200');
   * ```
   *
   * @internal
   */
  handleHeader(streamId: number, name: string, value: string): void {
    const s = this.#streams.get(streamId);
    if (!s) return;
    if (s.inTrailers) {
      if (!name.startsWith(':')) s.trailerHeaders.append(name, value);
      return;
    }
    if (name === ':status') {
      s.status = parseInt(value, 10);
    } else if (!name.startsWith(':')) {
      s.headers.append(name, value);
    }
  }
  /**
   * Handle a received frame notification from nghttp2.
   *
   * Final response HEADERS resolve `send()` as soon as `END_HEADERS` arrives.
   * HEADERS or DATA carrying `END_STREAM` then close the live body and settle
   * trailers. Unknown streams are ignored.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.handleFrameRecv(1, 0x01, 0x05);
   * ```
   *
   * @internal
   */
  handleFrameRecv(streamId: number, frameType: number, frameFlags: number): void {
    if (frameType === NGHTTP2_FRAME_TYPE_GOAWAY) {
      this.handleGoaway(0, 0);
      return;
    }
    const s = this.#streams.get(streamId);
    if (!s) return;
    const endStream = (frameFlags & NGHTTP2_FLAG_END_STREAM) !== 0;
    if (frameType === NGHTTP2_FRAME_TYPE_HEADERS) {
      if ((frameFlags & NGHTTP2_FLAG_END_HEADERS) === 0) return;
      if (!s.inTrailers && s.status >= 200) this.#resolveResponse(s);
      if (endStream) this.#finishStream(s);
    }
    if (frameType === NGHTTP2_FRAME_TYPE_DATA && endStream) this.#finishStream(s);
  }
  /**
   * Deliver one response DATA chunk to the stream's bounded body queue.
   *
   * Unknown or completed streams are ignored. If the application has stopped
   * consuming and the queue exceeds its byte bound, the body errors and a
   * stream-local cancellation reset is scheduled after the nghttp2 callback
   * returns.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.handleDataChunk(1, new Uint8Array([65]));
   * ```
   *
   * @internal
   */
  handleDataChunk(streamId: number, data: Uint8Array): void {
    const s = this.#streams.get(streamId);
    if (!s || s.done) return;
    if (!s.body.push(data)) {
      queueMicrotask(() => {
        void this.#cancelStream(
          streamId,
          new HttpStreamError('flow-control', `H2 stream ${streamId} exceeded its body buffer`, {
            streamId,
          }),
        ).catch(() => {});
      });
    }
  }
  /**
   * Handle nghttp2 stream close notification.
   *
   * A clean close finishes the body if END_STREAM was not observed separately.
   * An error faults the live body and trailers; if final headers have not yet
   * arrived it also rejects the promise returned by `send()`.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.handleStreamClose(1, 0);
   * ```
   *
   * @internal
   */
  handleStreamClose(streamId: number, errorCode: number): void {
    const s = this.#streams.get(streamId);
    if (s && !s.done) {
      if (errorCode === 0) {
        this.#finishStream(s);
      } else {
        this.#failStream(
          s,
          new HttpStreamError('closed', `H2 stream ${streamId} closed with error ${errorCode}`, {
            streamId,
            protocolCode: errorCode,
          }),
        );
      }
    }
    this.#streams.delete(streamId);
    this.#resetIdleTimer();
  }
  /**
   * Apply peer GOAWAY state to this entry.
   *
   * New streams are refused immediately. Streams with identifiers greater than
   * `lastStreamId` are rejected because the peer will not process them; lower
   * stream identifiers remain active and may complete normally.
   *
   * @internal
   */
  handleGoaway(lastStreamId: number, errorCode: number): void {
    this.#goingAway = true;
    this.#clearIdleTimer();
    for (const [activeStreamId, s] of this.#streams) {
      if (activeStreamId > lastStreamId && !s.done) {
        this.#failStream(
          s,
          new HttpStreamError(
            'goaway',
            `H2 GOAWAY rejected stream ${activeStreamId} above lastStreamId ${lastStreamId} with error ${errorCode}`,
            {
              streamId: activeStreamId,
              protocolCode: errorCode,
            },
          ),
        );
        this.#streams.delete(activeStreamId);
      }
    }
    if (this.#streams.size === 0) void this.close();
  }
  /**
   * Apply transport failure teardown to this entry.
   *
   * This is the same path used by the background receive loop when the socket
   * closes or errors. Exposed for deterministic internal tests.
   *
   * @internal
   */
  handleTransportError(err: Error): void {
    this.#teardown(err);
  }
  // -------------------------------------------------------------------------
  // Close / teardown
  // -------------------------------------------------------------------------
  /**
   * Begin graceful close of the pooled connection.
   *
   * The entry marks itself going away, submits GOAWAY, drains pending output,
   * closes the nghttp2 session, and closes both split I/O halves. Repeated calls are
   * ignored after the first close path starts.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.close();
   * ```
   */
  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    this.#goingAway = true;
    this.#clearIdleTimer();
    try {
      this.#session.submitGoaway(0, 0);
    } catch {}
    async function closeH2PoolEntry(entry: H2PoolEntry): Promise<void> {
      try {
        await entry.drainWrite();
      } catch {}
      entry.#closed = true;
      try {
        entry.#session.close();
      } catch {}
      await entry.#closeHalves();
    }
    this.#closePromise = closeH2PoolEntry(this);
    return this.#closePromise;
  }
  /**
   * Dispose support so an entry can be used with `using`.
   *
   * Delegates to `close()` for graceful teardown when the entry leaves a
   * `using` scope. The close runs asynchronously; await `close()` directly if
   * you need to observe completion.
   *
   * ```ts no_run
   * import { Request } from 'internal:net/http/wire';
   * import { createPoolEntry } from 'internal:net/http/pool';
   * {
   *   using entry = createPoolEntry(reader, writer);
   *   await entry.send(new Request('https://example.test/'));
   * } // entry.close() runs here
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  /** Resolve `send()` with a live body once final response headers are complete. */
  #resolveResponse(s: StreamDeferred): void {
    if (s.responseResolved || s.done) return;
    if (!Number.isInteger(s.status) || s.status < 200 || s.status > 599) {
      this.#failStream(
        s,
        new HttpStreamError('protocol', `H2 stream ${s.streamId} has no valid final :status`, {
          streamId: s.streamId,
        }),
      );
      return;
    }
    const method = s.method.toUpperCase();
    const hasBody = method !== 'HEAD' && s.status !== 204 && s.status !== 205 && s.status !== 304;
    try {
      const response = buildWireResponse({
        version: 'HTTP/2',
        status: s.status,
        headers: s.headers,
        body: hasBody ? s.body : null,
        inTrailers: s.trailers,
      });
      Object.defineProperty(response, FETCH_RESPONSE_METADATA, {
        value: {
          connectionId: this.id,
          connectedAt: this.connectedAt,
          reused: s.reused,
          streamId: s.streamId,
          localAddress: null,
          remoteAddress: null,
          alpnProtocol: 'h2',
        },
      });
      s.responseResolved = true;
      s.resolve(response);
    } catch (error) {
      this.#failStream(s, error instanceof Error ? error : new Error(String(error)));
    }
  }
  /** Close the live body and trailer deferred after a clean END_STREAM. */
  #finishStream(s: StreamDeferred): void {
    if (s.done) return;
    this.#resolveResponse(s);
    if (s.done) return;
    s.done = true;
    s.abortCleanup?.();
    if (s.uploadIterator?.return !== undefined) {
      void Promise.resolve(s.uploadIterator.return()).catch(() => {});
    }
    s.uploadIterator = null;
    s.body.close();
    s.trailerResolve(s.trailerHeaders);
    this.#streams.delete(s.streamId);
    this.#resetIdleTimer();
    if (this.#goingAway && this.#streams.size === 0) void this.close();
  }
  /** Fault a stream without disturbing other multiplexed requests. */
  #failStream(s: StreamDeferred, err: Error): void {
    if (s.done) return;
    s.done = true;
    s.abortCleanup?.();
    if (s.uploadIterator?.return !== undefined) {
      void Promise.resolve(s.uploadIterator.return()).catch(() => {});
    }
    s.uploadIterator = null;
    s.body.error(err);
    s.trailerReject(err);
    if (!s.responseResolved) s.reject(err);
  }
  /** Reset a response stream after its consumer cancels before EOF. */
  async #cancelStream(streamId: number, reason: unknown): Promise<void> {
    const s = this.#streams.get(streamId);
    if (!s || s.done) return;
    const err =
      reason instanceof HttpStreamError
        ? reason
        : new HttpStreamError('cancelled', `H2 stream ${streamId} response was cancelled`, {
            streamId,
            protocolCode: H2_CANCEL,
          });
    this.#failStream(s, err);
    this.#streams.delete(streamId);
    try {
      this.#session.submitRstStream(streamId, H2_CANCEL);
      await this.drainWrite();
    } finally {
      this.#resetIdleTimer();
      if (this.#goingAway && this.#streams.size === 0) void this.close();
    }
  }
  /**
   * Abrupt teardown that rejects every in-flight stream with the given error.
   *
   * Used when the transport fails or the socket closes unexpectedly. Marks the
   * entry closed and going away, rejects and clears all pending streams, closes
   * the nghttp2 session, and closes both I/O halves. Idempotent after the first
   * call.
   *
   * @internal
   */
  #teardown(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#goingAway = true;
    this.#clearIdleTimer();
    for (const s of this.#streams.values()) {
      if (!s.done) this.#failStream(s, err);
    }
    this.#streams.clear();
    try {
      this.#session.close();
    } catch {}
    void this.#closeHalves();
  }
  /**
   * Close the reader and writer halves, ignoring individual close failures.
   *
   * Both closes are attempted and awaited via `Promise.allSettled` so a failure
   * on one half never prevents the other from being released.
   *
   * @internal
   */
  async #closeHalves(): Promise<void> {
    const closes: Promise<void>[] = [];
    try {
      closes.push(this.#writer.close());
    } catch {}
    try {
      closes.push(this.#reader.close());
    } catch {}
    await Promise.allSettled(closes);
  }
  /**
   * Re-arm the idle-eviction timer after clearing any existing one.
   *
   * Does nothing when the entry is closed, going away, or has active streams;
   * the timer only runs while the connection is genuinely idle. On expiry the
   * entry marks itself going away and begins a graceful `close()`.
   *
   * @internal
   */
  #resetIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#closed || this.#goingAway) return;
    if (this.#streams.size > 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#goingAway = true;
      void this.close();
    }, this.#idleMs);
  }
  /**
   * Cancel and forget the idle-eviction timer if one is armed.
   *
   * @internal
   */
  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }
}
// ---------------------------------------------------------------------------
// H2ConnectionPool - per-realm singleton
// ---------------------------------------------------------------------------
/**
 * Map of HTTP/2 pool entries keyed by origin string.
 *
 * Origins are expected to be normalized `scheme://host:port` strings. The pool
 * evicts entries that are marked going away and closes all entries when asked.
 *
 * ```ts
 * import { H2ConnectionPool } from 'internal:net/http/pool';
 * const pool = new H2ConnectionPool();
 * pool.has('https://example.test:443');
 * ```
 *
 * @internal
 */
export class H2ConnectionPool {
  /**
   * Live pool entries keyed by normalized `scheme://host:port` origin.
   *
   * @internal
   */
  #entries = new Map<string, H2PoolEntry>();
  /**
   * Return whether a live entry exists for an origin.
   *
   * Entries marked going away are treated as absent. The method does not create
   * new connections.
   *
   * ```ts
   * import { H2ConnectionPool } from 'internal:net/http/pool';
   * const pool = new H2ConnectionPool();
   * pool.has('https://example.test:443');
   * ```
   */
  has(origin: string): boolean {
    const e = this.#entries.get(origin);
    return e !== undefined && !e.goingAway;
  }
  /** Return whether a live entry uses `prefix` directly or as a client slot. @internal */
  hasPrefix(prefix: string): boolean {
    for (const [key, entry] of this.#entries) {
      if ((key === prefix || key.startsWith(`${prefix}#`)) && !entry.goingAway) return true;
    }
    return false;
  }
  /**
   * Retrieve an existing live entry for an origin.
   *
   * Returns `undefined` when no entry exists or when the existing entry is going
   * away. Going-away entries are evicted as a side effect.
   *
   * ```ts
   * import { H2ConnectionPool } from 'internal:net/http/pool';
   * const pool = new H2ConnectionPool();
   * pool.get('https://example.test:443');
   * ```
   */
  get(origin: string): H2PoolEntry | undefined {
    const e = this.#entries.get(origin);
    if (e && !e.goingAway) return e;
    if (e) this.#entries.delete(origin);
    return undefined;
  }
  /**
   * Register a pre-built pool entry for an origin.
   *
   * Existing entries for the same origin are replaced without being closed, so
   * callers should evict first when replacing a live connection.
   *
   * ```ts no_run
   * import { H2ConnectionPool, createPoolEntry } from 'internal:net/http/pool';
   * const pool = new H2ConnectionPool();
   * pool.add('https://example.test:443', createPoolEntry(reader, writer));
   * ```
   */
  add(origin: string, entry: H2PoolEntry): void {
    this.#entries.set(origin, entry);
  }
  /**
   * Remove and close a single origin entry.
   *
   * Unknown origins are ignored. The entry close path is asynchronous
   * internally but the map removal happens synchronously.
   *
   * ```ts
   * import { H2ConnectionPool } from 'internal:net/http/pool';
   * const pool = new H2ConnectionPool();
   * pool.evict('https://example.test:443');
   * ```
   */
  evict(origin: string): Promise<void> {
    const e = this.#entries.get(origin);
    if (e) {
      this.#entries.delete(origin);
      return e.close();
    }
    return Promise.resolve();
  }
  /**
   * Close and remove every pooled entry.
   *
   * The method iterates the current map only. Entries added after `closeAll()`
   * starts are not part of that call.
   *
   * ```ts
   * import { H2ConnectionPool } from 'internal:net/http/pool';
   * const pool = new H2ConnectionPool();
   * pool.closeAll();
   * ```
   */
  async closeAll(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [origin, e] of this.#entries) {
      closes.push(e.close());
      this.#entries.delete(origin);
    }
    await Promise.allSettled(closes);
  }
  /** Close and remove entries whose internal pool key begins with `prefix`. @internal */
  async evictPrefix(prefix: string): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [key, entry] of this.#entries) {
      if (!key.startsWith(prefix)) continue;
      this.#entries.delete(key);
      closes.push(entry.close());
    }
    await Promise.allSettled(closes);
  }
}
// ---------------------------------------------------------------------------
// createPoolEntry - create session + pool entry together so callbacks are wired
// ---------------------------------------------------------------------------
/**
 * Create an nghttp2 client session + pool entry in one shot so the callbacks
 * are wired to the entry before the session fires any events.
 *
 * The function submits empty client SETTINGS and returns an `H2PoolEntry` with
 * its receive loop already running. It throws if libnghttp2 is unavailable or
 * session creation fails.
 *
 * ```ts no_run
 * import { createPoolEntry } from 'internal:net/http/pool';
 * const entry = createPoolEntry(reader, writer);
 * entry.goingAway;
 * ```
 *
 * @internal
 */
export function createPoolEntry(
  reader: BufferedBytesReader,
  writer: BytesWriter,
  options: H2PoolEntryOptions = {},
): H2PoolEntry {
  let entry!: H2PoolEntry;
  const callbacks: H2StreamCallbacks = {
    onBeginHeaders(streamId, isTrailers) {
      entry.handleBeginHeaders(streamId, isTrailers);
    },
    onHeader(streamId, name, value) {
      entry.handleHeader(streamId, name, value);
    },
    onFrameRecv(streamId, type, flags) {
      entry.handleFrameRecv(streamId, type, flags);
    },
    onDataChunk(streamId, data) {
      entry.handleDataChunk(streamId, data);
    },
    onStreamClose(streamId, errorCode) {
      entry.handleStreamClose(streamId, errorCode);
    },
  };
  const session = Nghttp2Session.createClient(callbacks);
  session.submitSettings([]);
  entry = new H2PoolEntry(session, reader, writer, options);
  return entry;
}
