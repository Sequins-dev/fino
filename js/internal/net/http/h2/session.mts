/**
 * internal:net/http/h2/session — Nghttp2Session wrapper.
 *
 * Owns the nghttp2_session*, all FfiCallbacks, and per-stream data slots.
 *
 * ## Pointer conventions (fino FFI)
 *
 * A "fino pointer" is an 8-byte ArrayBuffer whose 8 bytes hold a C address.
 * When passed to an FFI function as `'pointer'`, `from_js` reads those bytes
 * as u64 and uses the value as the raw C pointer.
 *
 *   Pointer.of(buf)  → new 8-byte ArrayBuffer containing buf's backing-store address
 *   Pointer.copyFrom(ptr, n)  → copy n bytes from the C address in ptr into a new Uint8Array
 *
 * Out-parameters (e.g. nghttp2_session**, nghttp2_session_callbacks**):
 * ```ts no_run
 *   const handle = new ArrayBuffer(8);  // 8 bytes to receive the written pointer
 *   sym.foo(Pointer.of(handle), ...);   // pass address of those 8 bytes
 *   // Now handle's 8 bytes contain the allocated C pointer — use handle directly.
 * ```
 *
 * ## Threading
 *
 * session_mem_recv2 / session_mem_send2 are `async: true` → blocking pool.
 * FfiCallbacks fire from pool threads → condvar bridge → V8 thread → JS.
 * Never call blocking-FFI inside a FfiCallback (deadlocks pool thread).
 *
 * ## GC pinning
 *
 * Every FfiCallback is stored in #callbacks. close() calls .close() on each.
 *
 * @internal
 */

import { TextDecoder as _TextDecoder } from '../../../globals/encoding.mts';
import {
  sym, FfiCallback, Pointer,
  h2Available,
  NGHTTP2_FRAME_TYPE_HEADERS,
  NGHTTP2_FRAME_TYPE_DATA,
  NGHTTP2_DATA_FLAG_EOF,
  NGHTTP2_ERR_DEFERRED,
  NGHTTP2_NV_FLAG_NONE,
  DP2_SOURCE,
  DP2_READ_CALLBACK,
  readFrameHd,
  buildNvArray,
  buildSettingsArray,
} from './bindings.mts';

/** @internal Helpers for building nghttp2 name/value and settings arrays. */
export { buildNvArray, buildSettingsArray };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @internal Callbacks invoked by nghttp2 session events for one HTTP/2 stream. */
export interface H2StreamCallbacks {
  onBeginHeaders(streamId: number, isTrailers: boolean): void;
  onHeader(streamId: number, name: string, value: string, flags: number): void;
  onFrameRecv(streamId: number, frameType: number, frameFlags: number): void;
  onDataChunk(streamId: number, data: Uint8Array): void;
  onStreamClose(streamId: number, errorCode: number): void;
}

interface DataSlot {
  bytes: Uint8Array | null;
}

const _dec = new _TextDecoder();

// ---------------------------------------------------------------------------
// Nghttp2Session
// ---------------------------------------------------------------------------

/** @internal Stateful wrapper around an nghttp2 session pointer. */
export class Nghttp2Session {
  // 8-byte ArrayBuffer whose bytes hold the nghttp2_session* address.
  #sessionHandle: ArrayBuffer;
  #callbacks: Array<{ close(): void }> = [];
  #streamDataSlots = new Map<number, DataSlot>();
  #streamHasData = new Set<number>(); // streams that have received ≥1 DATA frame
  #closed = false;

  // Shared nghttp2_data_provider2 struct (16 bytes) — held alive for submit calls.
  #dpBuf!: Uint8Array;

  // Async mutex: nghttp2 is not thread-safe. recv() and flush() both dispatch
  // to the blocking pool; if they run on different pool threads concurrently
  // they race on the nghttp2_session*. Serialise all pool-bound operations
  // through this promise chain.
  #mu: Promise<void> = Promise.resolve();

  readonly #cb: H2StreamCallbacks;

  private constructor(sessionHandle: ArrayBuffer, cb: H2StreamCallbacks) {
    this.#sessionHandle = sessionHandle;
    this.#cb = cb;
  }

  static createServer(cb: H2StreamCallbacks): Nghttp2Session {
    Nghttp2Session.#requireH2();
    return Nghttp2Session.#create(cb, true);
  }

  static createClient(cb: H2StreamCallbacks): Nghttp2Session {
    Nghttp2Session.#requireH2();
    return Nghttp2Session.#create(cb, false);
  }

  static #requireH2(): void {
    if (!h2Available || sym === null) {
      throw new Error('libnghttp2 is not available on this system');
    }
  }

  static #create(cb: H2StreamCallbacks, isServer: boolean): Nghttp2Session {
    // 1. Allocate the nghttp2_session_callbacks struct.
    //    nghttp2_session_callbacks_new(callbacks**) — out-pointer pattern.
    const cbsHandle = new ArrayBuffer(8);
    const cbsRc = sym!.nghttp2_session_callbacks_new(Pointer.of(cbsHandle)) as number;
    if (cbsRc !== 0) throw new Error(`nghttp2_session_callbacks_new failed: ${cbsRc}`);

    // 2. Allocate the session handle buffer.
    const sessionHandle = new ArrayBuffer(8);

    // 3. Create the Nghttp2Session JS wrapper (to set up callbacks on it).
    const session = new Nghttp2Session(sessionHandle, cb);

    // 4. Register FfiCallbacks (GC-pinned).
    session.#installCallbacks(cbsHandle);

    // 5. Create the nghttp2 session.
    //    nghttp2_session_server_new2(session**, callbacks*, user_data*, option*)
    //    We pass Pointer.of(sessionHandle) for the out-pointer.
    let rc: number;
    if (isServer) {
      rc = sym!.nghttp2_session_server_new2(
        Pointer.of(sessionHandle), cbsHandle, null, null,
      ) as number;
    } else {
      rc = sym!.nghttp2_session_client_new2(
        Pointer.of(sessionHandle), cbsHandle, null, null,
      ) as number;
    }
    sym!.nghttp2_session_callbacks_del(cbsHandle);

    if (rc !== 0) {
      session.#closed = true;
      throw new Error(`nghttp2_session_${isServer ? 'server' : 'client'}_new2 failed: ${rc}`);
    }

    // 6. Register the shared data provider.
    session.#installDataProvider();

    return session;
  }

  #installCallbacks(cbsHandle: ArrayBuffer): void {
    const cb = this.#cb;
    const streamHasData = this.#streamHasData;

    // on_begin_headers: fires at the start of a HEADERS frame.
    const onBeginHeaders = new FfiCallback(
      { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
      (_session: ArrayBuffer, frame: ArrayBuffer, _userData: ArrayBuffer) => {
        const { streamId, type } = readFrameHd(frame);
        if (streamId === 0 || type !== NGHTTP2_FRAME_TYPE_HEADERS) return 0;
        const isTrailers = streamHasData.has(streamId);
        cb.onBeginHeaders(streamId, isTrailers);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_begin_headers_callback(
      cbsHandle, onBeginHeaders.pointer,
    );
    this.#callbacks.push(onBeginHeaders);

    // on_header: individual name/value pairs. name/value arrive as pointer+length.
    const onHeader = new FfiCallback(
      {
        parameters: ['pointer', 'pointer', 'pointer', 'usize', 'pointer', 'usize', 'u8', 'pointer'],
        result: 'i32',
      },
      (
        _session: ArrayBuffer,
        frame: ArrayBuffer,
        namePtrBuf: ArrayBuffer,
        nameLen: bigint,    // usize → BigInt in FfiCallback
        valuePtrBuf: ArrayBuffer,
        valueLen: bigint,   // usize → BigInt
        flags: number,
        _userData: ArrayBuffer,
      ) => {
        // Read name/value before returning — C retains ownership of the memory.
        const nameBytes  = Pointer.copyFrom(namePtrBuf,  Number(nameLen))  as Uint8Array;
        const valueBytes = Pointer.copyFrom(valuePtrBuf, Number(valueLen)) as Uint8Array;
        const { streamId } = readFrameHd(frame);
        cb.onHeader(streamId, _dec.decode(nameBytes), _dec.decode(valueBytes), flags);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_header_callback(cbsHandle, onHeader.pointer);
    this.#callbacks.push(onHeader);

    // on_frame_recv: complete frame received.
    const onFrameRecv = new FfiCallback(
      { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
      (_session: ArrayBuffer, frame: ArrayBuffer, _userData: ArrayBuffer) => {
        const { streamId, type, flags } = readFrameHd(frame);
        if (type === NGHTTP2_FRAME_TYPE_DATA) streamHasData.add(streamId);
        cb.onFrameRecv(streamId, type, flags);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_frame_recv_callback(cbsHandle, onFrameRecv.pointer);
    this.#callbacks.push(onFrameRecv);

    // on_data_chunk_recv: individual DATA chunk. Copy before returning.
    const onDataChunk = new FfiCallback(
      { parameters: ['pointer', 'u8', 'i32', 'pointer', 'usize', 'pointer'], result: 'i32' },
      (
        _session: ArrayBuffer,
        _flags: number,
        streamId: number,
        dataPtrBuf: ArrayBuffer,
        len: bigint,    // usize → BigInt
        _userData: ArrayBuffer,
      ) => {
        const bytes = Pointer.copyFrom(dataPtrBuf, Number(len)) as Uint8Array;
        cb.onDataChunk(streamId, bytes);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_data_chunk_recv_callback(cbsHandle, onDataChunk.pointer);
    this.#callbacks.push(onDataChunk);

    // on_stream_close: stream is done.
    const onStreamClose = new FfiCallback(
      { parameters: ['pointer', 'i32', 'u32', 'pointer'], result: 'i32' },
      (_session: ArrayBuffer, streamId: number, errorCode: number, _userData: ArrayBuffer) => {
        streamHasData.delete(streamId);
        this.#streamDataSlots.delete(streamId);
        cb.onStreamClose(streamId, errorCode);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_stream_close_callback(cbsHandle, onStreamClose.pointer);
    this.#callbacks.push(onStreamClose);

    // error_callback2: session-level error.
    const onError = new FfiCallback(
      { parameters: ['pointer', 'i32', 'pointer', 'usize', 'pointer'], result: 'i32' },
      (_session: ArrayBuffer, errCode: number, _msgPtr: ArrayBuffer, _msgLen: bigint, _userData: ArrayBuffer) => {
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_error_callback2(cbsHandle, onError.pointer);
    this.#callbacks.push(onError);
  }

  #installDataProvider(): void {
    // The shared data-provider callback. Looks up per-stream state from
    // #streamDataSlots and returns bytes / DEFERRED / EOF to nghttp2.
    const dataCb = new FfiCallback(
      {
        parameters: ['pointer', 'i32', 'pointer', 'usize', 'pointer', 'pointer', 'pointer'],
        result: 'isize',
      },
      (
        _session: ArrayBuffer,
        streamId: number,
        bufPtrBuf: ArrayBuffer,
        length: bigint,   // usize → BigInt
        dataFlagsPtrBuf: ArrayBuffer,
        _source: ArrayBuffer,
        _userData: ArrayBuffer,
      ): number => {
        const slot = this.#streamDataSlots.get(streamId);
        if (!slot) return NGHTTP2_ERR_DEFERRED;
        if (slot.bytes === null) {
          Pointer.writeU32(dataFlagsPtrBuf, 0, NGHTTP2_DATA_FLAG_EOF);
          return 0;
        }
        const chunk = slot.bytes;
        const toWrite = Math.min(chunk.byteLength, Number(length));
        Pointer.copyTo(bufPtrBuf, chunk.subarray(0, toWrite));
        if (toWrite < chunk.byteLength) {
          slot.bytes = chunk.subarray(toWrite);
        } else {
          slot.bytes = null;
        }
        return toWrite;
      },
    );
    this.#callbacks.push(dataCb);

    // Build the nghttp2_data_provider2 struct (16 bytes).
    // source.ptr at offset 0 (leave zero — we use streamId to look up state)
    // read_callback at offset 8 (function pointer from dataCb)
    const dpBuf = new Uint8Array(16);
    // dataCb.pointer is an 8-byte ArrayBuffer whose raw bytes contain the fn ptr address.
    // Read the value without pointer-dereference using DataView.
    const fnAddr = new DataView(dataCb.pointer).getBigUint64(0, true);
    new DataView(dpBuf.buffer).setBigUint64(DP2_READ_CALLBACK, fnAddr, true);
    this.#dpBuf = dpBuf;
  }

  // ---------------------------------------------------------------------------
  // Session-level async mutex
  // ---------------------------------------------------------------------------

  // Serialise all blocking-pool calls (recv2 / send2) so they never run
  // concurrently on different pool threads — nghttp2 is not thread-safe.
  #lock<T>(fn: () => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const release = new Promise<void>(r => (unlock = r));
    const prev = this.#mu;
    this.#mu = release;
    return prev.then(() => fn().finally(unlock), () => fn().finally(unlock));
  }

  // ---------------------------------------------------------------------------
  // I/O pumps (async — run on blocking pool, fire FfiCallbacks)
  // ---------------------------------------------------------------------------

  /** Feed incoming bytes into the session. Returns bytes consumed (or throws). */
  recv(bytes: Uint8Array): Promise<number> {
    return this.#lock(async () => {
      if (this.#closed) return 0;
      const n = await sym!.nghttp2_session_mem_recv2(
        this.#sessionHandle, Pointer.of(bytes), bytes.byteLength,
      ) as bigint;
      return Number(n);
    });
  }

  /**
   * Drain pending outgoing bytes from the session.
   * Returns a Uint8Array to write, or null if nothing to send.
   */
  flush(): Promise<Uint8Array | null> {
    return this.#lock(async () => {
      if (this.#closed) return null;
      const outPtrHandle = new ArrayBuffer(8);
      const n = await sym!.nghttp2_session_mem_send2(
        this.#sessionHandle, Pointer.of(outPtrHandle),
      ) as bigint;
      const nBytes = Number(n);
      if (nBytes <= 0) return null;
      return Pointer.copyFrom(outPtrHandle, nBytes) as Uint8Array;
    });
  }

  /** True if the session has data ready to send. */
  wantWrite(): boolean {
    return (sym!.nghttp2_session_want_write(this.#sessionHandle) as number) !== 0;
  }

  /** True if the session wants more incoming data. */
  wantRead(): boolean {
    return (sym!.nghttp2_session_want_read(this.#sessionHandle) as number) !== 0;
  }

  // ---------------------------------------------------------------------------
  // Submit operations (sync)
  // ---------------------------------------------------------------------------

  submitSettings(settings: Array<[number, number]>): void {
    const buf = buildSettingsArray(settings);
    const rc = sym!.nghttp2_submit_settings(
      this.#sessionHandle, 0, Pointer.of(buf), settings.length,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp2_submit_settings failed: ${rc}`);
  }

  /**
   * Submit a server response.
   * `hasBody` true → attach the shared data provider; caller feeds data via setStreamData.
   */
  submitResponse(streamId: number, headers: Array<[string, string]>, hasBody: boolean): void {
    const { buf, nv } = buildNvArray(headers);
    const dpPtr = hasBody ? Pointer.of(this.#dpBuf) : null;
    const rc = sym!.nghttp2_submit_response2(
      this.#sessionHandle, streamId, Pointer.of(buf), nv, dpPtr,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp2_submit_response2 failed: ${rc}`);
  }

  /** Submit a client request. Returns the new stream ID. */
  submitRequest(headers: Array<[string, string]>, hasBody: boolean): number {
    const { buf, nv } = buildNvArray(headers);
    const dpPtr = hasBody ? Pointer.of(this.#dpBuf) : null;
    const streamId = sym!.nghttp2_submit_request2(
      this.#sessionHandle, null, Pointer.of(buf), nv, dpPtr, null,
    ) as number;
    if (streamId < 0) throw new Error(`nghttp2_submit_request2 failed: ${streamId}`);
    return streamId;
  }

  submitTrailer(streamId: number, trailers: Array<[string, string]>): void {
    const { buf, nv } = buildNvArray(trailers);
    const rc = sym!.nghttp2_submit_trailer(
      this.#sessionHandle, streamId, Pointer.of(buf), nv,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp2_submit_trailer failed: ${rc}`);
  }

  submitGoaway(lastStreamId: number, errorCode: number): void {
    sym!.nghttp2_submit_goaway(this.#sessionHandle, 0, lastStreamId, errorCode, null, 0);
  }

  submitRstStream(streamId: number, errorCode: number): void {
    sym!.nghttp2_submit_rst_stream(this.#sessionHandle, 0, streamId, errorCode);
  }

  /**
   * Inform nghttp2 that this connection was established via HTTP/1.1 h2c
   * Upgrade (RFC 7540 §3.2). Must be called after session creation and before
   * submitSettings / recv. Works for both client and server sessions.
   *
   * After calling this, stream 1 is implicitly open:
   *   server side: half-closed (remote) — client sent its request over h1.
   *   client side: half-closed (local)  — client already sent the request.
   */
  upgradeFromH1(settingsPayload: Uint8Array, headRequest: boolean): void {
    const settingsPtr = settingsPayload.byteLength > 0 ? Pointer.of(settingsPayload) : null;
    const rc = sym!.nghttp2_session_upgrade2(
      this.#sessionHandle, settingsPtr, settingsPayload.byteLength,
      headRequest ? 1 : 0, null,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp2_session_upgrade2 failed: ${rc}`);
  }

  resumeData(streamId: number): void {
    sym!.nghttp2_session_resume_data(this.#sessionHandle, streamId);
  }

  // ---------------------------------------------------------------------------
  // Per-stream data slots (used by data provider callback)
  // ---------------------------------------------------------------------------

  /**
   * Feed the next body chunk for `streamId`.
   * Pass `null` to signal EOF; the data provider will set the EOF flag on next call.
   */
  setStreamData(streamId: number, bytes: Uint8Array | null): void {
    let slot = this.#streamDataSlots.get(streamId);
    if (!slot) {
      slot = { bytes: null };
      this.#streamDataSlots.set(streamId, slot);
    }
    slot.bytes = bytes;
    this.resumeData(streamId);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    sym!.nghttp2_session_del(this.#sessionHandle);
    for (const cb of this.#callbacks) cb.close();
    this.#callbacks.length = 0;
    this.#streamDataSlots.clear();
    this.#streamHasData.clear();
  }

  get isClosed(): boolean { return this.#closed; }
}
