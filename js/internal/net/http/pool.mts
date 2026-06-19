/**
 * internal:net/http/pool - per-realm H2 connection pool.
 *
 * One `H2PoolEntry` per origin (scheme://host:port). Each entry holds a live
 * nghttp2 client session that multiplexes concurrent streams. A background
 * recv loop drives the session; `send()` submits new streams and awaits their
 * individual response deferreds.
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
 * The entry is evicted from the pool on the next `acquire()` check.
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

import { Headers } from 'fino:net/http';
import { Response } from 'fino:net/http';
import { Request } from 'fino:net/http';
import { Nghttp2Session } from './h2/session.mts';
import type { H2StreamCallbacks } from './h2/session.mts';
import type { BufferedBytesReader, BytesWriter } from '../../stream.mts';

const IDLE_MS = 60_000;

interface H2PoolEntryOptions {
  idleMs?: number;
}

// ---------------------------------------------------------------------------
// Per-stream state inside a pool entry
// ---------------------------------------------------------------------------

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
 * going away or closed.
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
   * Private readonly property `#session` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #session = undefined;
   *
   *   readInternalState() {
   *     return this.#session;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #session: Nghttp2Session;
  /**
   * Private readonly property `#writer` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #writer = undefined;
   *
   *   readInternalState() {
   *     return this.#writer;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #writer: BytesWriter;
  /**
   * Private property `#streams` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #streams = undefined;
   *
   *   readInternalState() {
   *     return this.#streams;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #streams = new Map<number, StreamDeferred>();
  /**
   * Private property `#goingAway` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #goingAway = undefined;
   *
   *   readInternalState() {
   *     return this.#goingAway;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #goingAway = false;
  /**
   * Private property `#maxConcurrent` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #maxConcurrent = undefined;
   *
   *   readInternalState() {
   *     return this.#maxConcurrent;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #maxConcurrent = 100;
  /**
   * Private property `#closed` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closed = undefined;
   *
   *   readInternalState() {
   *     return this.#closed;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closed = false;
  /**
   * Private property `#drainChain` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #drainChain = undefined;
   *
   *   readInternalState() {
   *     return this.#drainChain;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #drainChain: Promise<void> = Promise.resolve();
  /**
   * Private property `#idleTimer` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #idleTimer = undefined;
   *
   *   readInternalState() {
   *     return this.#idleTimer;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
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
  get goingAway(): boolean { return this.#goingAway; }
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
  get activeStreams(): number { return this.#streams.size; }

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
    this.#drainChain = this.#drainChain.then(async () => {
      if (this.#closed) return;
      while (this.#session.wantWrite()) {
        const bytes = await this.#session.flush();
        if (bytes && bytes.byteLength > 0) await this.#writer.write(bytes);
      }
      await this.#writer.flush();
    });
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
   * import { Request } from 'fino:net/http';
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
      [':method',    req.method],
      [':path',      url.pathname + url.search],
      [':scheme',    url.protocol.replace(':', '')],
      [':authority', url.host],
    ];
    for (const [k, v] of req.headers.entries()) {
      if (k === 'host' || k === 'connection' || k === 'keep-alive' ||
          k === 'transfer-encoding' || k === 'upgrade') continue;
      requestHeaders.push([k, v]);
    }

    // Buffer request body.
    let bodyBytes: Uint8Array | null = null;
    if (req.body) {
      try {
        const buf = await req.arrayBuffer();
        bodyBytes = buf.byteLength > 0 ? new Uint8Array(buf) : null;
      } catch { bodyBytes = null; }
    }

    const hasBody = bodyBytes !== null;
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
        reject,
      });
    });

    await this.drainWrite();

    if (hasBody && bodyBytes) {
      this.#session.setStreamData(streamId, bodyBytes);
      await this.drainWrite();
      this.#session.setStreamData(streamId, null);
      await this.drainWrite();
    }

    return responsePromise;
  }

  // -------------------------------------------------------------------------
  // Background recv loop
  // -------------------------------------------------------------------------

  /**
   * Private method `#recvLoop` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #recvLoop() {
   *     return 'recvLoop';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#recvLoop();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #recvLoop(reader: BufferedBytesReader): Promise<void> {
    try {
      for await (const chunk of reader) {
        if (this.#closed) break;
        await this.#session.recv(chunk);
        await this.drainWrite();
      }
    } catch {
      // Transport error - reject all pending streams.
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
    if (name === ':status') { s.status = parseInt(value, 10); }
    else if (!name.startsWith(':')) { s.headers.append(name, value); }
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
    const HEADERS = 0x01, DATA = 0x00, GOAWAY = 0x07, END_STREAM = 0x01, END_HEADERS = 0x04;
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
    if (this.#streams.size === 0) this.close();
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
   * closes the nghttp2 session, and closes the writer. Repeated calls are
   * ignored after the first close path starts.
   *
   * ```ts no_run
   * import { createPoolEntry } from 'internal:net/http/pool';
   * const entry = createPoolEntry(reader, writer);
   * entry.close();
   * ```
   */
  close(): void {
    if (this.#closed) return;
    this.#goingAway = true;
    this.#clearIdleTimer();
    try { this.#session.submitGoaway(0, 0); } catch {}
    this.drainWrite().then(() => {
      this.#closed = true;
      this.#session.close();
      this.#writer.close().catch(() => {});
    }).catch(() => {
      this.#closed = true;
      this.#session.close();
    });
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Private method `#finishStream` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #finishStream() {
   *     return 'finishStream';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#finishStream();
   *   }
   * }
   * ```
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
      for (const c of s.bodyChunks) { all.set(c, off); off += c.byteLength; }
      bodyInit = all.buffer;
    }
    s.resolve(new Response(bodyInit, {
      status: s.status,
      headers: s.headers,
      trailers: s.trailerHeaders,
    } as any));
    this.#streams.delete(s.streamId);
    if (this.#goingAway && this.#streams.size === 0) this.close();
  }

  /**
   * Private method `#teardown` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #teardown() {
   *     return 'teardown';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#teardown();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #teardown(err: Error): void {
    this.#closed = true;
    this.#goingAway = true;
    this.#clearIdleTimer();
    for (const s of this.#streams.values()) {
      if (!s.done) { s.done = true; s.reject(err); }
    }
    this.#streams.clear();
    try { this.#session.close(); } catch {}
    try { this.#writer.close().catch(() => {}); } catch {}
  }

  /**
   * Private method `#resetIdleTimer` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #resetIdleTimer() {
   *     return 'resetIdleTimer';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#resetIdleTimer();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #resetIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#streams.size > 0) return; // don't idle-timeout while streams active
    this.#idleTimer = setTimeout(() => {
      this.#goingAway = true;
      this.close();
    }, this.#idleMs);
  }

  /**
   * Private method `#clearIdleTimer` used by `H2PoolEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #clearIdleTimer() {
   *     return 'clearIdleTimer';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#clearIdleTimer();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) { clearTimeout(this.#idleTimer); this.#idleTimer = null; }
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
   * Private property `#entries` used by `H2ConnectionPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #entries = undefined;
   *
   *   readInternalState() {
   *     return this.#entries;
   *   }
   * }
   * ```
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
    if (e) this.#entries.delete(origin); // evict dead entry
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
  evict(origin: string): void {
    const e = this.#entries.get(origin);
    if (e) { e.close(); this.#entries.delete(origin); }
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
  closeAll(): void {
    for (const [origin, e] of this.#entries) { e.close(); this.#entries.delete(origin); }
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
    onBeginHeaders(streamId, isTrailers) { entry.handleBeginHeaders(streamId, isTrailers); },
    onHeader(streamId, name, value)      { entry.handleHeader(streamId, name, value); },
    onFrameRecv(streamId, type, flags)   { entry.handleFrameRecv(streamId, type, flags); },
    onDataChunk(streamId, data)          { entry.handleDataChunk(streamId, data); },
    onStreamClose(streamId, errorCode)   { entry.handleStreamClose(streamId, errorCode); },
  };

  const session = Nghttp2Session.createClient(callbacks);
  session.submitSettings([]);
  entry = new H2PoolEntry(session, reader, writer, options);
  return entry;
}
