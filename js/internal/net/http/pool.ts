/**
* internal:net/http/pool - per-realm H2 connection pool.
*
* One `H2PoolEntry` per origin (scheme://host:port). Each entry holds a live
* nghttp2 client session that multiplexes concurrent streams. A background
* recv loop drives the session; `send()` submits new streams and awaits their
* individual response deferreds.
*
* The release baseline is eager at the Request/Response boundary: `send()`
* reads the whole request body before submitting DATA frames and accumulates
* the whole response body before resolving with a `Response`. This keeps pooled
* HTTP/2 behavior aligned with the current fetch body model, but it is not a
* streaming large-body API.
*
* ## drainWrite serialization
*
* As in the per-request driver, concurrent `nghttp2_session_mem_send2` calls
* on the same session are a data race. A `drainChain` promise mutex serializes
* all drainWrite calls across both the recv loop and concurrent `send()` calls.
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
* @internal
*/
import { Headers, Request, Response } from 'internal:net/http/wire';
import { Nghttp2Session } from './h2/session.ts';
import type { H2StreamCallbacks } from './h2/session.ts';
import type { BufferedBytesReader, BytesWriter } from '../../stream.ts';
/**
* Default idle timeout in milliseconds (60s) before an idle entry self-evicts.
*
* @internal
*/
const IDLE_MS = 6e4;
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
}
// ---------------------------------------------------------------------------
// Per-stream state inside a pool entry
// ---------------------------------------------------------------------------
/**
* Mutable state accumulated for one in-flight HTTP/2 stream.
*
* The receive-loop callbacks build up `status`, `headers`, `trailerHeaders`,
* and `bodyChunks` as frames arrive; `inTrailers` tracks whether the current
* header block is a trailer block; `done` guards against double settlement; and
* `resolve`/`reject` settle the promise returned by `send()`.
*
* @internal
*/
interface StreamDeferred {
  streamId: number;
  status: number;
  headers: Headers;
  trailerHeaders: Headers;
  inTrailers: boolean;
  bodyChunks: Uint8Array[];
  done: boolean;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
}
// ---------------------------------------------------------------------------
// H2PoolEntry - one live H2 connection
// ---------------------------------------------------------------------------
/**
* One reusable HTTP/2 client connection for a single origin.
*
* The entry owns an nghttp2 client session, a background receive loop, and all
* in-flight stream deferreds. New requests are refused once the connection is
* going away or closed. Request and response bodies are buffered in memory for
* this release baseline; use caller-level size limits for untrusted large
* bodies.
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
  * Each `StreamDeferred` accumulates response status, headers, trailers, and
  * body chunks until the stream ends, then resolves the caller's `send()`
  * promise. Entries are removed on stream close, finish, or teardown.
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
  /**
  * Whether the nghttp2 session and I/O halves have been closed.
  *
  * Once set, `drainWrite`, `send`, and the receive loop become no-ops.
  *
  * @internal
  */
  #closed = false;
  /**
  * Promise mutex serializing every `drainWrite` call.
  *
  * Concurrent `nghttp2_session_mem_send2` calls on one session are a data race,
  * so all flushes from the receive loop and from `send()` are chained through
  * this promise.
  *
  * @internal
  */
  #drainChain: Promise<void> = Promise.resolve();
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
  constructor(session: Nghttp2Session, reader: BufferedBytesReader, writer: BytesWriter, options: H2PoolEntryOptions = {}) {
    this.#session = session;
    this.#reader = reader;
    this.#writer = writer;
    this.#idleMs = options.idleMs ?? IDLE_MS;
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
  * Calls are chained through an internal promise mutex because concurrent
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
    this.#drainChain = this.#drainChain.then(drainH2PoolWrites, drainH2PoolWrites);
    return this.#drainChain;
  }
  // -------------------------------------------------------------------------
  // send() - submit a new request stream
  // -------------------------------------------------------------------------
  /**
  * Submit an HTTP request on a new HTTP/2 stream.
  *
  * The request body, if present, is buffered before being sent. The returned
  * promise resolves with a fully buffered `Response`, rejects if the connection
  * is going away, or rejects when the stream closes with an error.
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
      [':authority', url.host]
    ];
    for (const [k, v] of req.headers.entries()) {
      if (k === 'host' || k === 'connection' || k === 'keep-alive' || k === 'transfer-encoding' || k === 'upgrade') continue;
      requestHeaders.push([k, v]);
    }
    // Buffer request body.
    let bodyBytes: Uint8Array | null = null;
    if (req.body) {
      try {
        const buf = await req.arrayBuffer();
        bodyBytes = buf.byteLength > 0 ? new Uint8Array(buf) : null;
      } catch {
        bodyBytes = null;
      }
    }
    const hasTrailers = req._hasOutTrailers();
    const hasBody = bodyBytes !== null || hasTrailers;
    const streamId = this.#session.submitRequest(requestHeaders, hasBody);
    // Register deferred for this stream.
    const responsePromise = new Promise<Response>((resolve, reject) => {
      this.#streams.set(streamId, {
        streamId,
        status: 200,
        headers: new Headers(),
        trailerHeaders: new Headers(),
        inTrailers: false,
        bodyChunks: [],
        done: false,
        resolve,
        reject
      });
    });
    await this.drainWrite();
    if (bodyBytes) {
      this.#session.setStreamData(streamId, bodyBytes, { endStream: !hasTrailers });
      await this.drainWrite();
    }
    if (hasTrailers) {
      let trailersOut: Headers;
      const raw = req._getRawOutTrailers();
      if (raw instanceof Headers) {
        trailersOut = raw;
      } else if (typeof raw === 'function') {
        try {
          trailersOut = await raw();
        } catch {
          trailersOut = new Headers();
        }
      } else {
        trailersOut = new Headers();
      }
      const trailerList: Array<[string, string]> = [];
      for (const [k, v] of trailersOut.entries()) trailerList.push([k, v]);
      if (trailerList.length > 0) {
        this.#session.submitTrailer(streamId, trailerList);
        this.#session.setStreamData(streamId, null);
        await this.drainWrite();
      } else {
        this.#session.setStreamData(streamId, null);
        await this.drainWrite();
      }
    } else if (hasBody && bodyBytes === null) {
      this.#session.setStreamData(streamId, null);
      await this.drainWrite();
    }
    return responsePromise;
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
    } catch {} finally {
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
    if (isTrailers) s.inTrailers = true;
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
  * The method finishes streams on HEADERS or DATA frames with `END_STREAM`.
  * Frame constants are numeric nghttp2 values; unknown streams are ignored.
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
    const HEADERS = 1, DATA = 0, GOAWAY = 7, END_STREAM = 1, END_HEADERS = 4;
    if (frameType === GOAWAY) {
      this.handleGoaway(0, 0);
      return;
    }
    const s = this.#streams.get(streamId);
    if (!s) return;
    const endStream = (frameFlags & END_STREAM) !== 0;
    if (frameType === HEADERS && (frameFlags & END_HEADERS) !== 0 && endStream) this.#finishStream(s);
    if (frameType === DATA && endStream) this.#finishStream(s);
  }
  /**
  * Append one response DATA chunk to a stream buffer.
  *
  * Bodies are buffered until the stream finishes. Unknown streams are ignored,
  * which can happen after cancellation or teardown.
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
    if (s) s.bodyChunks.push(data);
  }
  /**
  * Handle nghttp2 stream close notification.
  *
  * If the stream has not already produced a `Response`, its promise is
  * rejected with the numeric nghttp2 error code. The stream is always removed
  * from the active map.
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
      s.done = true;
      s.reject(new Error(`H2 stream ${streamId} closed with error ${errorCode}`));
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
        s.done = true;
        s.reject(new Error(`H2 GOAWAY rejected stream ${activeStreamId} above lastStreamId ${lastStreamId} with error ${errorCode}`));
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
  /**
  * Concatenate a stream's buffered body and resolve its `send()` promise.
  *
  * Coalesces the accumulated chunks into a single body, builds a `Response`
  * from the collected status, headers, and trailers, removes the stream from
  * the active map, and triggers `close()` if this was the last stream on a
  * going-away connection. No-op if the stream already finished.
  *
  * @internal
  */
  #finishStream(s: StreamDeferred): void {
    if (s.done) return;
    s.done = true;
    const total = s.bodyChunks.reduce((n, c) => n + c.byteLength, 0);
    let bodyInit: BodyInit | null = null;
    if (total > 0) {
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of s.bodyChunks) {
        all.set(c, off);
        off += c.byteLength;
      }
      bodyInit = all.buffer;
    }
    s.resolve(new Response(bodyInit, {
      status: s.status,
      headers: s.headers,
      trailers: s.trailerHeaders
    } as any));
    this.#streams.delete(s.streamId);
    if (this.#goingAway && this.#streams.size === 0) void this.close();
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
      if (!s.done) {
        s.done = true;
        s.reject(err);
      }
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
export function createPoolEntry(reader: BufferedBytesReader, writer: BytesWriter, options: H2PoolEntryOptions = {}): H2PoolEntry {
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
    }
  };
  const session = Nghttp2Session.createClient(callbacks);
  session.submitSettings([]);
  entry = new H2PoolEntry(session, reader, writer, options);
  return entry;
}
