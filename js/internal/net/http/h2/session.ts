/**
 * internal:net/http/h2/session — Nghttp2Session wrapper.
 *
 * HTTP/2 specification: https://www.rfc-editor.org/rfc/rfc9113
 *
 * Owns the nghttp2_session*, all FfiCallbacks, and per-stream data slots.
 *
 * ## Pointer conventions (fino FFI)
 *
 * A "fino pointer" is an 8-byte ArrayBuffer whose 8 bytes hold a C address.
 * When passed to an FFI function as `'pointer'`, `from_js` reads those bytes
 * as u64 and uses the value as the raw C pointer.
 *
 *   Pointer.of(buf)  -> new 8-byte ArrayBuffer containing buf's backing-store address
 *   Pointer.copyFrom(ptr, n)  -> copy n bytes from the C address in ptr into a new Uint8Array
 *
 * Out-parameters (e.g. nghttp2_session**, nghttp2_session_callbacks**):
 * ```ts no_run
 *   const handle = new ArrayBuffer(8);  // 8 bytes to receive the written pointer
 *   sym.foo(Pointer.of(handle), ...);   // pass address of those 8 bytes
 *   // Now handle's 8 bytes contain the allocated C pointer - use handle directly.
 * ```
 *
 * ## Threading
 *
 * session_mem_recv2 / session_mem_send2 are synchronous in-memory nghttp2
 * operations. FfiCallbacks fire inline on the V8 thread, so submit operations
 * cannot race the native session while parsing or serializing frames.
 *
 * ## GC pinning
 *
 * Every FfiCallback is stored in #callbacks. close() calls .close() on each.
 *
 * @internal
 */
import { TextDecoder as _TextDecoder } from '../../../../globals/encoding.ts';
import {
  sym,
  FfiCallback,
  Pointer,
  h2Available,
  NGHTTP2_FRAME_TYPE_HEADERS,
  NGHTTP2_FRAME_TYPE_DATA,
  NGHTTP2_DATA_FLAG_EOF,
  NGHTTP2_DATA_FLAG_NO_END_STREAM,
  NGHTTP2_ERR_DEFERRED,
  NGHTTP2_NV_FLAG_NONE,
  DP2_SOURCE,
  DP2_READ_CALLBACK,
  FRAME_HD_STREAM_ID,
  NGHTTP2_HCAT_HEADERS,
  readFrameHd,
  readHeadersCat,
  buildNvArray,
  buildSettingsArray,
} from './bindings.ts';
/**
 * Re-export helpers for building nghttp2 name/value and settings arrays.
 *
 * These helpers are defined in the bindings module and re-exported here so
 * session-adjacent code can import them from the wrapper module. They allocate
 * buffers that must stay alive for the FFI call that consumes them.
 *
 * ```ts
 * import { buildSettingsArray } from 'internal:net/http/h2/session';
 * buildSettingsArray([]);
 * ```
 *
 * @internal
 */
export { buildNvArray, buildSettingsArray };
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/**
 * Callback set invoked by nghttp2 session events.
 *
 * The wrapper copies C-owned header and DATA bytes into JavaScript-owned memory
 * before invoking these callbacks, so the values stay valid after the callback
 * returns. Each callback fires synchronously and re-entrantly on the V8 thread
 * from inside `recv()` or `flush()`, while nghttp2 is mid-parse or mid-serialize.
 * Implementations must therefore not re-enter the same session — do not call
 * `recv`, `flush`, or any `submit*` method from within a callback — because the
 * native nghttp2 session is not re-entrant.
 *
 * ```ts
 * const callbacks = {
 *   onBeginHeaders() {},
 *   onHeader() {},
 *   onFrameRecv() {},
 *   onDataChunk() {},
 *   onStreamClose() {},
 * };
 * callbacks.onStreamClose(1, 0);
 * ```
 *
 * @internal
 */
export interface H2StreamCallbacks {
  /**
   * Called when nghttp2 starts a HEADERS frame for a stream.
   *
   * `isTrailers` comes from nghttp2's `NGHTTP2_HCAT_HEADERS` category, so a
   * trailing header block is recognized even when no DATA frame preceded it.
   * Stream `0` and non-HEADERS frames are filtered before this callback.
   *
   * ```ts
   * const callbacks = { onBeginHeaders(streamId, isTrailers) { void streamId; void isTrailers; }, onHeader() {}, onFrameRecv() {}, onDataChunk() {}, onStreamClose() {} };
   * callbacks.onBeginHeaders(1, false);
   * ```
   */
  onBeginHeaders(streamId: number, isTrailers: boolean): void;
  /**
   * Called for each decoded header name/value pair.
   *
   * Names and values are UTF-8 decoded from nghttp2 buffers. `flags` is the raw
   * nghttp2 name/value flags byte and is usually `0`.
   *
   * ```ts
   * const callbacks = { onBeginHeaders() {}, onHeader(streamId, name, value, flags) { void streamId; void name; void value; void flags; }, onFrameRecv() {}, onDataChunk() {}, onStreamClose() {} };
   * callbacks.onHeader(1, ':status', '200', 0);
   * ```
   */
  onHeader(streamId: number, name: string, value: string, flags: number): void;
  /**
   * Called after nghttp2 receives a complete frame.
   *
   * `frameType` and `frameFlags` are the raw nghttp2 numeric values for the
   * completed frame.
   *
   * ```ts
   * const callbacks = { onBeginHeaders() {}, onHeader() {}, onFrameRecv(streamId, frameType, frameFlags) { void streamId; void frameType; void frameFlags; }, onDataChunk() {}, onStreamClose() {} };
   * callbacks.onFrameRecv(1, 0x01, 0x04);
   * ```
   */
  onFrameRecv(streamId: number, frameType: number, frameFlags: number): void;
  /**
   * Called for one received DATA chunk.
   *
   * The `Uint8Array` is a copy of C memory and remains valid after the callback
   * returns. Empty chunks may be delivered by nghttp2 and should be tolerated.
   *
   * ```ts
   * const callbacks = { onBeginHeaders() {}, onHeader() {}, onFrameRecv() {}, onDataChunk(streamId, data) { void streamId; void data; }, onStreamClose() {} };
   * callbacks.onDataChunk(1, new Uint8Array([65]));
   * ```
   */
  onDataChunk(streamId: number, data: Uint8Array): void;
  /**
   * Called when nghttp2 closes a stream.
   *
   * `errorCode` is the HTTP/2 error code associated with the close. The session
   * wrapper clears its per-stream data slot before invoking this callback.
   *
   * ```ts
   * const callbacks = { onBeginHeaders() {}, onHeader() {}, onFrameRecv() {}, onDataChunk() {}, onStreamClose(streamId, errorCode) { void streamId; void errorCode; } };
   * callbacks.onStreamClose(1, 0);
   * ```
   */
  onStreamClose(streamId: number, errorCode: number): void;
}
interface DataSlot {
  bytes?: Uint8Array;
  eof?: boolean;
  noEndStream?: boolean;
}
const _dec = new _TextDecoder();
// Reused scratch for decoding header name/value bytes out of nghttp2-owned
// memory. The on_header callback fires synchronously on the main thread, so a
// single growable buffer avoids allocating two Uint8Arrays per header.
let _hdrScratch = new Uint8Array(512);
function _decodeFromPtr(ptr: ArrayBuffer, len: number): string {
  if (len === 0) return '';
  if (len > _hdrScratch.byteLength) {
    let size = _hdrScratch.byteLength;
    while (size < len) size *= 2;
    _hdrScratch = new Uint8Array(size);
  }
  Pointer.copyFromInto(_hdrScratch, ptr, len);
  return _dec.decode(_hdrScratch.subarray(0, len));
}
// ---------------------------------------------------------------------------
// Nghttp2Session
// ---------------------------------------------------------------------------
/**
 * Stateful wrapper around an `nghttp2_session*`.
 *
 * The wrapper owns the `nghttp2_session_callbacks` registration, the GC-pinned
 * `FfiCallback` objects, the shared 16-byte data-provider struct, and the
 * per-stream data slots that back the data-provider callback. All of the pump
 * (`recv`, `flush`) and `submit*` operations are synchronous and run on the V8
 * thread against a single native session, so no locking is required. Call
 * `close()` exactly once when the session is no longer needed; it frees the
 * native session and releases every pinned callback.
 *
 * ```ts no_run
 * import { Nghttp2Session } from 'internal:net/http/h2/session';
 * const session = Nghttp2Session.createClient(callbacks);
 * session.close();
 * ```
 *
 * @internal
 */
export class Nghttp2Session {
  // 8-byte ArrayBuffer whose bytes hold the nghttp2_session* address.
  /**
   * Private property `#sessionHandle` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #sessionHandle = undefined;
   *
   *   readInternalState() {
   *     return this.#sessionHandle;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #sessionHandle: ArrayBuffer;
  /**
   * Private property `#callbacks` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #callbacks = undefined;
   *
   *   readInternalState() {
   *     return this.#callbacks;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #callbacks: Array<{
    close(): void;
  }> = [];
  /**
   * Private property `#streamDataSlots` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #streamDataSlots = undefined;
   *
   *   readInternalState() {
   *     return this.#streamDataSlots;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #streamDataSlots = new Map<number, DataSlot>();
  #streamDataWaiters = new Map<
    number,
    Array<{
      resolve(): void;
      reject(reason: unknown): void;
    }>
  >();
  /**
   * Queue of `[streamId, byteLength]` pairs recorded by the DATA-chunk callback.
   *
   * Because the session is created with automatic window updates disabled, the
   * wrapper is responsible for reporting consumed DATA back to nghttp2. The
   * `on_data_chunk_recv` callback fires re-entrantly inside `recv()`, so instead
   * of calling `nghttp2_session_consume` from the callback the wrapper records
   * the byte counts here and drains them after `nghttp2_session_mem_recv2`
   * returns, letting nghttp2 emit the appropriate WINDOW_UPDATE frames.
   */
  #pendingConsumedData: Array<[number, number]> = [];
  /**
   * Private property `#closed` used by `Nghttp2Session`.
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
  // Shared nghttp2_data_provider2 struct (16 bytes) - held alive for submit calls.
  /**
   * Private property `#dpBuf` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #dpBuf = undefined;
   *
   *   readInternalState() {
   *     return this.#dpBuf;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #dpBuf!: Uint8Array;
  /**
   * Private readonly property `#cb` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #cb = undefined;
   *
   *   readInternalState() {
   *     return this.#cb;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #cb: H2StreamCallbacks;
  /**
   * Internal constructor used after a native session handle is allocated.
   *
   * Callers must use `createServer()` or `createClient()` so callbacks and data
   * providers are installed correctly.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * Nghttp2Session.createClient(callbacks);
   * ```
   *
   * @internal
   */
  private constructor(sessionHandle: ArrayBuffer, cb: H2StreamCallbacks) {
    this.#sessionHandle = sessionHandle;
    this.#cb = cb;
  }
  /**
   * Create a server-mode nghttp2 session.
   *
   * The method throws when libnghttp2 is unavailable or native session creation
   * fails. The returned session has callbacks and data provider installed but no
   * SETTINGS have been submitted yet.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createServer(callbacks);
   * session.close();
   * ```
   */
  static createServer(cb: H2StreamCallbacks): Nghttp2Session {
    Nghttp2Session.#requireH2();
    return Nghttp2Session.#create(cb, true);
  }
  /**
   * Create a client-mode nghttp2 session.
   *
   * The method throws when libnghttp2 is unavailable or native session creation
   * fails. Client code normally submits SETTINGS immediately after creation.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.close();
   * ```
   */
  static createClient(cb: H2StreamCallbacks): Nghttp2Session {
    Nghttp2Session.#requireH2();
    return Nghttp2Session.#create(cb, false);
  }
  /**
   * Private static method `#requireH2` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #requireH2() {
   *     return 'requireH2';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#requireH2();
   *   }
   * }
   * ```
   *
   * @internal
   */
  static #requireH2(): void {
    if (!h2Available || sym === null) {
      throw new Error('libnghttp2 is not available on this system');
    }
  }
  /**
   * Private static method `#create` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #create() {
   *     return 'create';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#create();
   *   }
   * }
   * ```
   *
   * @internal
   */
  static #create(cb: H2StreamCallbacks, isServer: boolean): Nghttp2Session {
    // 1. Allocate the nghttp2_session_callbacks struct.
    //    nghttp2_session_callbacks_new(callbacks**) - out-pointer pattern.
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
    const optionHandle = new ArrayBuffer(8);
    const optionRc = sym!.nghttp2_option_new(Pointer.of(optionHandle)) as number;
    if (optionRc !== 0) {
      session.#closed = true;
      sym!.nghttp2_session_callbacks_del(cbsHandle);
      throw new Error(`nghttp2_option_new failed: ${optionRc}`);
    }
    sym!.nghttp2_option_set_no_auto_window_update(optionHandle, 1);
    // The server driver performs RFC 9113 message validation itself. Disable
    // nghttp2's overlapping validator so malformed fields reach our callbacks
    // consistently across nghttp2 versions and receive the required RST_STREAM.
    if (isServer) sym!.nghttp2_option_set_no_http_messaging(optionHandle, 1);
    let rc: number;
    try {
      if (isServer) {
        rc = sym!.nghttp2_session_server_new2(
          Pointer.of(sessionHandle),
          cbsHandle,
          null,
          optionHandle,
        ) as number;
      } else {
        rc = sym!.nghttp2_session_client_new2(
          Pointer.of(sessionHandle),
          cbsHandle,
          null,
          optionHandle,
        ) as number;
      }
    } finally {
      sym!.nghttp2_option_del(optionHandle);
      sym!.nghttp2_session_callbacks_del(cbsHandle);
    }
    if (rc !== 0) {
      session.#closed = true;
      throw new Error(`nghttp2_session_${isServer ? 'server' : 'client'}_new2 failed: ${rc}`);
    }
    // 6. Register the shared data provider.
    session.#installDataProvider();
    return session;
  }
  /**
   * Private method `#installCallbacks` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #installCallbacks() {
   *     return 'installCallbacks';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#installCallbacks();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #installCallbacks(cbsHandle: ArrayBuffer): void {
    const cb = this.#cb;
    const pendingConsumedData = this.#pendingConsumedData;
    const streamDataSlots = this.#streamDataSlots;
    const streamDataWaiters = this.#streamDataWaiters;
    // on_begin_headers: fires at the start of a HEADERS frame.
    const onBeginHeaders = new FfiCallback(
      {
        parameters: ['pointer', 'pointer', 'pointer'],
        result: 'i32',
      },
      function nghttp2OnBeginHeadersCallback(
        _session: ArrayBuffer,
        frame: ArrayBuffer,
        _userData: ArrayBuffer,
      ) {
        const { streamId, type } = readFrameHd(frame);
        if (streamId === 0 || type !== NGHTTP2_FRAME_TYPE_HEADERS) return 0;
        const isTrailers = readHeadersCat(frame) === NGHTTP2_HCAT_HEADERS;
        cb.onBeginHeaders(streamId, isTrailers);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_begin_headers_callback(cbsHandle, onBeginHeaders.pointer);
    this.#callbacks.push(onBeginHeaders);
    // on_header: individual name/value pairs. name/value arrive as pointer+length.
    const onHeader = new FfiCallback(
      {
        parameters: ['pointer', 'pointer', 'pointer', 'usize', 'pointer', 'usize', 'u8', 'pointer'],
        result: 'i32',
      },
      function nghttp2OnHeaderCallback(
        _session: ArrayBuffer,
        frame: ArrayBuffer,
        namePtrBuf: ArrayBuffer,
        nameLen: bigint,
        valuePtrBuf: ArrayBuffer,
        valueLen: bigint,
        flags: number,
        _userData: ArrayBuffer,
      ) {
        // Read name/value before returning - C retains ownership of the memory.
        // Decode straight from a reused scratch buffer and read only the stream
        // id field to avoid allocating per header.
        const name = _decodeFromPtr(namePtrBuf, Number(nameLen));
        const value = _decodeFromPtr(valuePtrBuf, Number(valueLen));
        const streamId = Pointer.readI32(frame, FRAME_HD_STREAM_ID) as number;
        cb.onHeader(streamId, name, value, flags);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_header_callback(cbsHandle, onHeader.pointer);
    this.#callbacks.push(onHeader);
    // on_frame_recv: complete frame received.
    const onFrameRecv = new FfiCallback(
      {
        parameters: ['pointer', 'pointer', 'pointer'],
        result: 'i32',
      },
      function nghttp2OnFrameRecvCallback(
        _session: ArrayBuffer,
        frame: ArrayBuffer,
        _userData: ArrayBuffer,
      ) {
        const { streamId, type, flags } = readFrameHd(frame);
        cb.onFrameRecv(streamId, type, flags);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_frame_recv_callback(cbsHandle, onFrameRecv.pointer);
    this.#callbacks.push(onFrameRecv);
    // on_data_chunk_recv: individual DATA chunk. Copy before returning.
    const onDataChunk = new FfiCallback(
      {
        parameters: ['pointer', 'u8', 'i32', 'pointer', 'usize', 'pointer'],
        result: 'i32',
      },
      function nghttp2OnDataChunkCallback(
        _session: ArrayBuffer,
        _flags: number,
        streamId: number,
        dataPtrBuf: ArrayBuffer,
        len: bigint,
        _userData: ArrayBuffer,
      ) {
        const bytes = Pointer.copyFrom(dataPtrBuf, Number(len)) as Uint8Array;
        cb.onDataChunk(streamId, bytes);
        if (bytes.byteLength > 0) pendingConsumedData.push([streamId, bytes.byteLength]);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_data_chunk_recv_callback(cbsHandle, onDataChunk.pointer);
    this.#callbacks.push(onDataChunk);
    // on_stream_close: stream is done.
    const onStreamClose = new FfiCallback(
      {
        parameters: ['pointer', 'i32', 'u32', 'pointer'],
        result: 'i32',
      },
      function nghttp2OnStreamCloseCallback(
        _session: ArrayBuffer,
        streamId: number,
        errorCode: number,
        _userData: ArrayBuffer,
      ) {
        streamDataSlots.delete(streamId);
        const waiters = streamDataWaiters.get(streamId);
        if (waiters !== undefined) {
          streamDataWaiters.delete(streamId);
          for (const waiter of waiters) {
            waiter.reject(new Error(`HTTP/2 stream ${streamId} closed during upload`));
          }
        }
        cb.onStreamClose(streamId, errorCode);
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_on_stream_close_callback(cbsHandle, onStreamClose.pointer);
    this.#callbacks.push(onStreamClose);
    // error_callback2: session-level error.
    const onError = new FfiCallback(
      {
        parameters: ['pointer', 'i32', 'pointer', 'usize', 'pointer'],
        result: 'i32',
      },
      function nghttp2ErrorCallback(
        _session: ArrayBuffer,
        errCode: number,
        _msgPtr: ArrayBuffer,
        _msgLen: bigint,
        _userData: ArrayBuffer,
      ) {
        return 0;
      },
    );
    sym!.nghttp2_session_callbacks_set_error_callback2(cbsHandle, onError.pointer);
    this.#callbacks.push(onError);
  }
  /**
   * Private method `#installDataProvider` used by `Nghttp2Session`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #installDataProvider() {
   *     return 'installDataProvider';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#installDataProvider();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #installDataProvider(): void {
    // The shared data-provider callback. Looks up per-stream state from
    // #streamDataSlots and returns bytes / DEFERRED / EOF to nghttp2.
    const streamDataSlots = this.#streamDataSlots;
    const streamDataWaiters = this.#streamDataWaiters;
    const dataCb = new FfiCallback(
      {
        parameters: ['pointer', 'i32', 'pointer', 'usize', 'pointer', 'pointer', 'pointer'],
        result: 'isize',
      },
      function nghttp2DataProviderReadCallback(
        _session: ArrayBuffer,
        streamId: number,
        bufPtrBuf: ArrayBuffer,
        length: bigint,
        dataFlagsPtrBuf: ArrayBuffer,
        _source: ArrayBuffer,
        _userData: ArrayBuffer,
      ): number {
        const slot = streamDataSlots.get(streamId);
        if (!slot) {
          return NGHTTP2_ERR_DEFERRED;
        }
        if (!slot.bytes) {
          if (slot.eof) {
            let flags = NGHTTP2_DATA_FLAG_EOF;
            if (slot.noEndStream) flags |= NGHTTP2_DATA_FLAG_NO_END_STREAM;
            Pointer.writeU32(dataFlagsPtrBuf, 0, flags);
            slot.eof = false;
            slot.noEndStream = false;
            return 0;
          }
          return NGHTTP2_ERR_DEFERRED;
        }
        const chunk = slot.bytes;
        const toWrite = Math.min(chunk.byteLength, Number(length));
        Pointer.copyTo(bufPtrBuf, chunk.subarray(0, toWrite));
        if (toWrite < chunk.byteLength) {
          slot.bytes = chunk.subarray(toWrite);
        } else {
          slot.bytes = undefined;
          const waiters = streamDataWaiters.get(streamId);
          if (waiters !== undefined) {
            streamDataWaiters.delete(streamId);
            for (const waiter of waiters) waiter.resolve();
          }
          if (slot.eof) {
            let flags = NGHTTP2_DATA_FLAG_EOF;
            if (slot.noEndStream) flags |= NGHTTP2_DATA_FLAG_NO_END_STREAM;
            Pointer.writeU32(dataFlagsPtrBuf, 0, flags);
            slot.eof = false;
            slot.noEndStream = false;
          }
        }
        return toWrite;
      },
    );
    this.#callbacks.push(dataCb);
    // Build the nghttp2_data_provider2 struct (16 bytes).
    // source.ptr at offset 0 (leave zero - we use streamId to look up state)
    // read_callback at offset 8 (function pointer from dataCb)
    const dpBuf = new Uint8Array(16);
    // dataCb.pointer is an 8-byte ArrayBuffer whose raw bytes contain the fn ptr address.
    // Read the value without pointer-dereference using DataView.
    const fnAddr = new DataView(dataCb.pointer).getBigUint64(0, true);
    new DataView(dpBuf.buffer).setBigUint64(DP2_READ_CALLBACK, fnAddr, true);
    this.#dpBuf = dpBuf;
  }
  // ---------------------------------------------------------------------------
  // I/O pumps
  // ---------------------------------------------------------------------------
  /**
   * Feed incoming bytes into the nghttp2 session.
   *
   * The call synchronously feeds bytes to the in-memory nghttp2 parser. It
   * returns the number of bytes consumed, returns `0` after close, or throws when
   * the native FFI call fails.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.recv(new Uint8Array());
   * ```
   */
  recv(bytes: Uint8Array): number {
    if (this.#closed) return 0;
    const n = sym!.nghttp2_session_mem_recv2(
      this.#sessionHandle,
      Pointer.of(bytes),
      bytes.byteLength,
    ) as number;
    while (this.#pendingConsumedData.length > 0) {
      const [streamId, size] = this.#pendingConsumedData.shift()!;
      sym!.nghttp2_session_consume(this.#sessionHandle, streamId, size);
    }
    return n;
  }
  /**
   * Drain pending outgoing bytes from the session.
   * Returns a Uint8Array to write, or null if nothing to send.
   *
   * The call synchronously serializes pending nghttp2 output. After close, it
   * returns `null`.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * const bytes = session.flush();
   * bytes?.byteLength;
   * ```
   */
  flush(): Uint8Array | null {
    if (this.#closed) return null;
    const outPtrHandle = new ArrayBuffer(8);
    const nBytes = sym!.nghttp2_session_mem_send2(
      this.#sessionHandle,
      Pointer.of(outPtrHandle),
    ) as number;
    if (nBytes <= 0) {
      return null;
    }
    return Pointer.copyFrom(outPtrHandle, nBytes) as Uint8Array;
  }
  /**
   * Return whether nghttp2 wants the caller to write bytes.
   *
   * This mirrors `nghttp2_session_want_write`. It is a synchronous snapshot and
   * should usually be followed by `flush()` until it becomes false.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.wantWrite();
   * ```
   */
  wantWrite(): boolean {
    return (sym!.nghttp2_session_want_write(this.#sessionHandle) as number) !== 0;
  }
  /**
   * Return whether nghttp2 wants more incoming bytes.
   *
   * This mirrors `nghttp2_session_want_read`. A false value usually means the
   * session is closing or has enough data queued for now.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.wantRead();
   * ```
   */
  wantRead(): boolean {
    return (sym!.nghttp2_session_want_read(this.#sessionHandle) as number) !== 0;
  }
  // ---------------------------------------------------------------------------
  // Submit operations (sync)
  // ---------------------------------------------------------------------------
  /**
   * Submit local HTTP/2 settings.
   *
   * Settings are pairs of nghttp2 setting ID and unsigned value. The method
   * throws when nghttp2 rejects the settings array; callers must `flush()` to
   * put the frame on the wire.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.submitSettings([]);
   * ```
   */
  submitSettings(settings: Array<[number, number]>): void {
    const buf = buildSettingsArray(settings);
    const rc = sym!.nghttp2_submit_settings(
      this.#sessionHandle,
      0,
      Pointer.of(buf),
      settings.length,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp2_submit_settings failed: ${rc}`);
  }
  /**
   * Submit a server response.
   * `hasBody` true -> attach the shared data provider; caller feeds data via setStreamData.
   *
   * Headers should include `:status` and any regular response headers. The
   * method throws if nghttp2 rejects the stream ID or header array.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createServer(callbacks);
   * session.submitResponse(1, [[':status', '200']], false);
   * ```
   */
  submitResponse(streamId: number, headers: Array<[string, string]>, hasBody: boolean): void {
    const { buf, nv } = buildNvArray(headers);
    const dpPtr = hasBody ? Pointer.of(this.#dpBuf) : null;
    const rc = sym!.nghttp2_submit_response2(
      this.#sessionHandle,
      streamId,
      Pointer.of(buf),
      nv,
      dpPtr,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp2_submit_response2 failed: ${rc}`);
  }
  /**
   * Submit a client request and return the new stream ID.
   *
   * Request pseudo-headers must be included by the caller. A negative nghttp2
   * return value is converted to an `Error`.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * const id = session.submitRequest([[':method', 'GET'], [':path', '/'], [':scheme', 'https'], [':authority', 'example.test']], false);
   * id;
   * ```
   */
  submitRequest(headers: Array<[string, string]>, hasBody: boolean): number {
    const { buf, nv } = buildNvArray(headers);
    const dpPtr = hasBody ? Pointer.of(this.#dpBuf) : null;
    const streamId = sym!.nghttp2_submit_request2(
      this.#sessionHandle,
      null,
      Pointer.of(buf),
      nv,
      dpPtr,
      null,
    ) as number;
    if (streamId < 0) throw new Error(`nghttp2_submit_request2 failed: ${streamId}`);
    return streamId;
  }
  /**
   * Submit trailers for an existing stream.
   *
   * The trailers array must contain only regular headers. The method throws if
   * nghttp2 rejects the stream or header list; callers must `flush()` afterward.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createServer(callbacks);
   * session.submitTrailer(1, [['x-finished', 'true']]);
   * ```
   */
  submitTrailer(streamId: number, trailers: Array<[string, string]>): void {
    const { buf, nv } = buildNvArray(trailers);
    const rc = sym!.nghttp2_submit_trailer(
      this.#sessionHandle,
      streamId,
      Pointer.of(buf),
      nv,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp2_submit_trailer failed: ${rc}`);
  }
  /**
   * Queue a GOAWAY frame.
   *
   * The method does not throw for the native return value and does not flush.
   * `lastStreamId` and `errorCode` are passed directly to nghttp2.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.submitGoaway(0, 0);
   * ```
   */
  submitGoaway(lastStreamId: number, errorCode: number): void {
    sym!.nghttp2_submit_goaway(this.#sessionHandle, 0, lastStreamId, errorCode, null, 0);
  }
  /**
   * Queue an RST_STREAM frame for one stream.
   *
   * `errorCode` is a numeric HTTP/2 error code. The method does not flush and
   * ignores the native return value.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createServer(callbacks);
   * session.submitRstStream(1, 0x07);
   * ```
   */
  submitRstStream(streamId: number, errorCode: number): void {
    sym!.nghttp2_submit_rst_stream(this.#sessionHandle, 0, streamId, errorCode);
  }
  /**
   * Inform nghttp2 that this connection was established via HTTP/1.1 h2c
   * Upgrade (RFC 7540 Section 3.2). Must be called after session creation and before
   * submitSettings / recv. Works for both client and server sessions.
   *
   * After calling this, stream 1 is implicitly open:
   *   server side: half-closed (remote) - client sent its request over h1.
   *   client side: half-closed (local)  - client already sent the request.
   *
   * The method throws when nghttp2 rejects the settings payload. Call it before
   * submitting SETTINGS or receiving additional HTTP/2 frames.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createServer(callbacks);
   * session.upgradeFromH1(new Uint8Array(), false);
   * ```
   */
  upgradeFromH1(settingsPayload: Uint8Array, headRequest: boolean): void {
    const settingsPtr = settingsPayload.byteLength > 0 ? Pointer.of(settingsPayload) : null;
    const rc = sym!.nghttp2_session_upgrade2(
      this.#sessionHandle,
      settingsPtr,
      settingsPayload.byteLength,
      headRequest ? 1 : 0,
      null,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp2_session_upgrade2 failed: ${rc}`);
  }
  /**
   * Resume data production for a deferred stream.
   *
   * This wakes nghttp2 after `setStreamData()` installs bytes or EOF. The
   * native return value is intentionally ignored.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.resumeData(1);
   * ```
   */
  resumeData(streamId: number): void {
    sym!.nghttp2_session_resume_data(this.#sessionHandle, streamId);
  }
  // ---------------------------------------------------------------------------
  // Per-stream data slots (used by data provider callback)
  // ---------------------------------------------------------------------------
  /**
   * Feed the next body chunk for `streamId`.
   * Pass `null` to signal EOF; the data provider will set the EOF flag on next call.
   * Use `{ endStream: true }` when `bytes` is the final body chunk. Use
   * `{ noEndStream: true }` when trailer HEADERS will be submitted after the
   * data provider reports EOF.
   *
   * The bytes are held by the session until the data provider consumes them.
   * Passing another chunk before the previous one is fully consumed replaces the
   * pending slot, so callers should drain writes between chunks.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.setStreamData(1, new Uint8Array([65]));
   * ```
   */
  setStreamData(
    streamId: number,
    bytes: Uint8Array | null,
    options?: {
      endStream?: boolean;
      noEndStream?: boolean;
    },
  ): void {
    let slot = this.#streamDataSlots.get(streamId);
    if (!slot) {
      slot = {};
      this.#streamDataSlots.set(streamId, slot);
    }
    if (bytes === null) {
      slot.eof = true;
    } else {
      slot.bytes = bytes;
      slot.eof = options?.endStream === true;
    }
    slot.noEndStream = slot.eof === true && options?.noEndStream === true;
    this.resumeData(streamId);
  }
  /**
   * Wait until nghttp2 consumes the DATA chunk currently held for a stream.
   *
   * This couples an async upload producer to HTTP/2 flow control: callers set
   * one bounded chunk, drain writes, then await this promise before pulling the
   * next chunk. It resolves immediately when no bytes remain pending.
   *
   * @internal
   */
  waitForStreamDataConsumed(streamId: number): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('nghttp2 session closed'));
    if (this.#streamDataSlots.get(streamId)?.bytes === undefined) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiters = this.#streamDataWaiters.get(streamId) ?? [];
      waiters.push({ resolve, reject });
      this.#streamDataWaiters.set(streamId, waiters);
    });
  }
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  /**
   * Free the native nghttp2 session and close all FFI callbacks.
   *
   * The method is idempotent. After close, `recv()` returns `0`, `flush()`
   * returns `null`, and submit operations must no longer be called.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.close();
   * ```
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    sym!.nghttp2_session_del(this.#sessionHandle);
    for (const cb of this.#callbacks) cb.close();
    this.#callbacks.length = 0;
    for (const waiters of this.#streamDataWaiters.values()) {
      for (const waiter of waiters) waiter.reject(new Error('nghttp2 session closed'));
    }
    this.#streamDataWaiters.clear();
    this.#streamDataSlots.clear();
    this.#pendingConsumedData.length = 0;
  }
  [Symbol.dispose](): void {
    this.close();
  }
  /**
   * Whether this wrapper has been closed.
   *
   * The value is updated synchronously by `close()`. It does not reflect remote
   * peer GOAWAY state unless higher-level code calls `close()`.
   *
   * ```ts no_run
   * import { Nghttp2Session } from 'internal:net/http/h2/session';
   * const session = Nghttp2Session.createClient(callbacks);
   * session.isClosed;
   * ```
   */
  get isClosed(): boolean {
    return this.#closed;
  }
}
