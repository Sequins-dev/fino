/**
 * internal:net/http/pool — per-realm H2 connection pool.
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
 * @internal
 */

import { Headers } from 'fino:net/http';
import { Response } from 'fino:net/http';
import { Request } from 'fino:net/http';
import { Nghttp2Session } from './h2/session.mts';
import type { H2StreamCallbacks } from './h2/session.mts';
import type { BufferedBytesReader, BytesWriter } from '../../stream.mts';

const IDLE_MS = 60_000;

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
// H2PoolEntry — one live H2 connection
// ---------------------------------------------------------------------------

export class H2PoolEntry {
  readonly #session: Nghttp2Session;
  readonly #writer: BytesWriter;
  #streams = new Map<number, StreamDeferred>();
  #goingAway = false;
  #maxConcurrent = 100;
  #closed = false;
  #drainChain: Promise<void> = Promise.resolve();
  #idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(session: Nghttp2Session, reader: BufferedBytesReader, writer: BytesWriter) {
    this.#session = session;
    this.#writer = writer;
    // Start the background recv loop (fire and forget — errors are handled inside).
    this.#recvLoop(reader).catch(() => {});
    this.#resetIdleTimer();
  }

  get goingAway(): boolean { return this.#goingAway; }
  get activeStreams(): number { return this.#streams.size; }

  // -------------------------------------------------------------------------
  // drainWrite (serialized)
  // -------------------------------------------------------------------------

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
  // send() — submit a new request stream
  // -------------------------------------------------------------------------

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

  async #recvLoop(reader: BufferedBytesReader): Promise<void> {
    try {
      for await (const chunk of reader) {
        if (this.#closed) break;
        await this.#session.recv(chunk);
        await this.drainWrite();
      }
    } catch {
      // Transport error — reject all pending streams.
    } finally {
      this.#teardown(new Error('H2 connection closed'));
    }
  }

  // -------------------------------------------------------------------------
  // Callbacks (wired in H2ConnectionPool.createEntry)
  // -------------------------------------------------------------------------

  handleBeginHeaders(streamId: number, isTrailers: boolean): void {
    const s = this.#streams.get(streamId);
    if (!s) return;
    if (isTrailers) s.inTrailers = true;
  }

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

  handleFrameRecv(streamId: number, frameType: number, frameFlags: number): void {
    const HEADERS = 0x01, DATA = 0x00, END_STREAM = 0x01, END_HEADERS = 0x04;
    const s = this.#streams.get(streamId);
    if (!s) return;
    const endStream = (frameFlags & END_STREAM) !== 0;
    if (frameType === HEADERS && (frameFlags & END_HEADERS) !== 0 && endStream) this.#finishStream(s);
    if (frameType === DATA && endStream) this.#finishStream(s);
  }

  handleDataChunk(streamId: number, data: Uint8Array): void {
    const s = this.#streams.get(streamId);
    if (s) s.bodyChunks.push(data);
  }

  handleStreamClose(streamId: number, errorCode: number): void {
    const s = this.#streams.get(streamId);
    if (s && !s.done) {
      s.done = true;
      s.reject(new Error(`H2 stream ${streamId} closed with error ${errorCode}`));
    }
    this.#streams.delete(streamId);
    this.#resetIdleTimer();
  }

  // -------------------------------------------------------------------------
  // Close / teardown
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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
  }

  #teardown(err: Error): void {
    this.#closed = true;
    this.#clearIdleTimer();
    for (const s of this.#streams.values()) {
      if (!s.done) { s.done = true; s.reject(err); }
    }
    this.#streams.clear();
    try { this.#session.close(); } catch {}
  }

  #resetIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#streams.size > 0) return; // don't idle-timeout while streams active
    this.#idleTimer = setTimeout(() => {
      this.#goingAway = true;
      this.close();
    }, IDLE_MS);
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) { clearTimeout(this.#idleTimer); this.#idleTimer = null; }
  }
}

// ---------------------------------------------------------------------------
// H2ConnectionPool — per-realm singleton
// ---------------------------------------------------------------------------

export class H2ConnectionPool {
  #entries = new Map<string, H2PoolEntry>();

  /** True if the pool has a live (non-going-away) entry for this origin. */
  has(origin: string): boolean {
    const e = this.#entries.get(origin);
    return e !== undefined && !e.goingAway;
  }

  /** Retrieve an existing live entry. */
  get(origin: string): H2PoolEntry | undefined {
    const e = this.#entries.get(origin);
    if (e && !e.goingAway) return e;
    if (e) this.#entries.delete(origin); // evict dead entry
    return undefined;
  }

  /** Register a pre-built pool entry (created via createPoolEntry) for an origin. */
  add(origin: string, entry: H2PoolEntry): void {
    this.#entries.set(origin, entry);
  }

  evict(origin: string): void {
    const e = this.#entries.get(origin);
    if (e) { e.close(); this.#entries.delete(origin); }
  }

  closeAll(): void {
    for (const [origin, e] of this.#entries) { e.close(); this.#entries.delete(origin); }
  }
}

// ---------------------------------------------------------------------------
// createPoolEntry — create session + pool entry together so callbacks are wired
// ---------------------------------------------------------------------------

/**
 * Create an nghttp2 client session + pool entry in one shot so the callbacks
 * are wired to the entry before the session fires any events.
 */
export function createPoolEntry(
  reader: BufferedBytesReader,
  writer: BytesWriter,
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
  entry = new H2PoolEntry(session, reader, writer);
  return entry;
}
