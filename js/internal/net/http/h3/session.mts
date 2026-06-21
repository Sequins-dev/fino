import { TextDecoder as _TextDecoder } from '../../../globals/encoding.mts';
import {
  sym, FfiCallback, Pointer,
  h3Available,
  NGHTTP3_CALLBACKS_VERSION, NGHTTP3_SETTINGS_VERSION,
  CB_SIZE, SETTINGS_SIZE,
  CB_ACKED_STREAM_DATA, CB_STREAM_CLOSE, CB_RECV_DATA,
  CB_DEFERRED_CONSUME,
  CB_BEGIN_HEADERS, CB_RECV_HEADER, CB_END_HEADERS,
  CB_BEGIN_TRAILERS, CB_RECV_TRAILER, CB_END_TRAILERS,
  CB_END_STREAM, CB_RESET_STREAM, CB_SHUTDOWN,
  NV_ENTRY_SIZE,
  VEC_ENTRY_SIZE,
  DR_READ_DATA, DR_SIZE,
  NGHTTP3_DATA_FLAG_EOF, NGHTTP3_DATA_FLAG_NO_END_STREAM,
  NGHTTP3_ERR_WOULDBLOCK, NGHTTP3_ERR_FATAL,
  NGHTTP3_ERR_MALFORMED_HTTP_HEADER, NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING,
  NGHTTP3_H3_MESSAGE_ERROR, NGHTTP3_H3_REQUEST_CANCELLED,
  buildNvArray, readRcbuf, writeCbPtr,
} from './bindings.mts';

export { buildNvArray };

export interface H3SessionCallbacks {
  onBeginHeaders(streamId: bigint): void;
  onRecvHeader(streamId: bigint, token: number, name: string, value: string, flags: number): void;
  onEndHeaders(streamId: bigint, fin: boolean): void;
  onBeginTrailers(streamId: bigint): void;
  onRecvTrailer(streamId: bigint, token: number, name: string, value: string, flags: number): void;
  onEndTrailers(streamId: bigint, fin: boolean): void;
  onRecvData(streamId: bigint, data: Uint8Array): void;
  onEndStream(streamId: bigint): void;
  onStreamClose(streamId: bigint, appErrorCode: bigint): void;
  onResetStream(streamId: bigint, appErrorCode: bigint): void;
  onAckedStreamData(streamId: bigint, datalen: bigint): void;
  onShutdown?(lastStreamId: bigint): void;
}

export type H3BodySource = Uint8Array | AsyncIterable<Uint8Array | ArrayBuffer>;

interface BodySlot {
  bytes: Uint8Array | null;
  iterator: AsyncIterator<Uint8Array | ArrayBuffer> | null;
  pulling: boolean;
  done: boolean;
  error: unknown;
  trailers?: Array<[string, string]>;
}

const _MAX_VECS = 16;
const _VEC_BUF_SIZE = _MAX_VECS * VEC_ENTRY_SIZE;

export class Nghttp3Session {
  #conn: ArrayBuffer;          // nghttp3_conn* (8-byte pointer)
  #callbacks: Array<{ close(): void }> = [];
  #cbsBuf: Uint8Array;         // nghttp3_callbacks struct (kept alive)
  #drBuf: Uint8Array;          // nghttp3_data_reader struct (kept alive)
  #bodySlots = new Map<bigint, BodySlot>();
  #pendingTrailers = new Map<bigint, Array<[string, string]>>();
  #yieldedBytes = new Map<bigint, Uint8Array>();
  #quicStreams = new Map<bigint, { writer: { write(b: Uint8Array): Promise<void>; close(): Promise<void> } }>();
  #closed = false;
  #ready = false;   // true once bindControlStream has been called
  #mu: Promise<void> = Promise.resolve();
  readonly #cb: H3SessionCallbacks;

  private constructor(conn: ArrayBuffer, cbsBuf: Uint8Array, drBuf: Uint8Array, cb: H3SessionCallbacks) {
    this.#conn = conn;
    this.#cbsBuf = cbsBuf;
    this.#drBuf = drBuf;
    this.#cb = cb;
  }

  static createServer(cb: H3SessionCallbacks): Nghttp3Session {
    if (!h3Available || sym === null) throw new Error('libnghttp3 is not available');
    return Nghttp3Session.#create(cb, true);
  }

  static createClient(cb: H3SessionCallbacks): Nghttp3Session {
    if (!h3Available || sym === null) throw new Error('libnghttp3 is not available');
    return Nghttp3Session.#create(cb, false);
  }


  static #create(cb: H3SessionCallbacks, isServer: boolean): Nghttp3Session {
    // Allocate the 152-byte callbacks struct (zeroed = null callbacks for unused fields).
    const cbsBuf = new Uint8Array(CB_SIZE);

    // Allocate 8-byte out-param buffer for the conn pointer.
    const connHandle = new ArrayBuffer(8);

    // Create the session object now so #installCallbacks can close over it.
    const drBuf = new Uint8Array(DR_SIZE);
    const session = new Nghttp3Session(connHandle, cbsBuf, drBuf, cb);

    session.#installCallbacks(cbsBuf);
    session.#installDataReader(drBuf);

    // Fill settings struct with library defaults.
    const settingsBuf = new Uint8Array(SETTINGS_SIZE);
    sym!.nghttp3_settings_default_versioned(NGHTTP3_SETTINGS_VERSION, Pointer.of(settingsBuf));

    const rc = isServer
      ? sym!.nghttp3_conn_server_new_versioned(
          Pointer.of(connHandle), NGHTTP3_CALLBACKS_VERSION, Pointer.of(cbsBuf),
          NGHTTP3_SETTINGS_VERSION, Pointer.of(settingsBuf), null, null,
        ) as number
      : sym!.nghttp3_conn_client_new_versioned(
          Pointer.of(connHandle), NGHTTP3_CALLBACKS_VERSION, Pointer.of(cbsBuf),
          NGHTTP3_SETTINGS_VERSION, Pointer.of(settingsBuf), null, null,
        ) as number;

    if (rc !== 0) {
      session.#closed = true;
      throw new Error(`nghttp3_conn_${isServer ? 'server' : 'client'}_new_versioned failed: ${rc}`);
    }

    return session;
  }

  // -------------------------------------------------------------------------
  // Callback installation
  // -------------------------------------------------------------------------

  #installCallbacks(cbsBuf: Uint8Array): void {
    const cb = this.#cb;

    // acked_stream_data: nghttp3 no longer needs the body bytes.
    const ackedStreamData = new FfiCallback(
      { parameters: ['pointer', 'i64', 'usize', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint, datalen: bigint) => {
        cb.onAckedStreamData(streamId, datalen);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_ACKED_STREAM_DATA, ackedStreamData);
    this.#callbacks.push(ackedStreamData);

    // stream_close: stream finished (cleanly or with error).
    const streamClose = new FfiCallback(
      { parameters: ['pointer', 'i64', 'u64', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint, appErrorCode: bigint) => {
        this.#bodySlots.delete(streamId);
        this.#pendingTrailers.delete(streamId);
        this.#yieldedBytes.delete(streamId);
        cb.onStreamClose(streamId, appErrorCode);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_STREAM_CLOSE, streamClose);
    this.#callbacks.push(streamClose);

    // recv_data: body chunk arrived on a stream.
    const recvData = new FfiCallback(
      { parameters: ['pointer', 'i64', 'pointer', 'usize', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint, dataPtr: ArrayBuffer, datalen: bigint) => {
        const bytes = Pointer.copyFrom(dataPtr, Number(datalen)) as Uint8Array;
        cb.onRecvData(streamId, bytes);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RECV_DATA, recvData);
    this.#callbacks.push(recvData);

    const deferredConsume = new FfiCallback(
      { parameters: ['pointer', 'i64', 'usize', 'pointer', 'pointer'], result: 'i32' },
      () => 0,
    );
    writeCbPtr(cbsBuf, CB_DEFERRED_CONSUME, deferredConsume);
    this.#callbacks.push(deferredConsume);

    // begin_headers: start of a request or response header block.
    const beginHeaders = new FfiCallback(
      { parameters: ['pointer', 'i64', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint) => {
        cb.onBeginHeaders(streamId);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_BEGIN_HEADERS, beginHeaders);
    this.#callbacks.push(beginHeaders);

    // recv_header: one decoded header field.
    // name and value are nghttp3_rcbuf* — read struct at offset 8 (base) and 16 (len).
    const recvHeader = new FfiCallback(
      { parameters: ['pointer', 'i64', 'i32', 'pointer', 'pointer', 'u8', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint, token: number, nameRcbuf: ArrayBuffer, valueRcbuf: ArrayBuffer, flags: number) => {
        const name  = readRcbuf(nameRcbuf);
        const value = readRcbuf(valueRcbuf);
        cb.onRecvHeader(streamId, token, name, value, flags);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RECV_HEADER, recvHeader);
    this.#callbacks.push(recvHeader);

    // end_headers: header block complete.
    const endHeaders = new FfiCallback(
      { parameters: ['pointer', 'i64', 'i32', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint, fin: number) => {
        cb.onEndHeaders(streamId, fin !== 0);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_END_HEADERS, endHeaders);
    this.#callbacks.push(endHeaders);

    // begin_trailers / recv_trailer / end_trailers — same shapes as headers.
    const beginTrailers = new FfiCallback(
      { parameters: ['pointer', 'i64', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint) => { cb.onBeginTrailers(streamId); return 0; },
    );
    writeCbPtr(cbsBuf, CB_BEGIN_TRAILERS, beginTrailers);
    this.#callbacks.push(beginTrailers);

    const recvTrailer = new FfiCallback(
      { parameters: ['pointer', 'i64', 'i32', 'pointer', 'pointer', 'u8', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint, token: number, nameRcbuf: ArrayBuffer, valueRcbuf: ArrayBuffer, flags: number) => {
        cb.onRecvTrailer(streamId, token, readRcbuf(nameRcbuf), readRcbuf(valueRcbuf), flags);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RECV_TRAILER, recvTrailer);
    this.#callbacks.push(recvTrailer);

    const endTrailers = new FfiCallback(
      { parameters: ['pointer', 'i64', 'i32', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint, fin: number) => { cb.onEndTrailers(streamId, fin !== 0); return 0; },
    );
    writeCbPtr(cbsBuf, CB_END_TRAILERS, endTrailers);
    this.#callbacks.push(endTrailers);

    // end_stream: FIN received on the stream.
    const endStream = new FfiCallback(
      { parameters: ['pointer', 'i64', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint) => { cb.onEndStream(streamId); return 0; },
    );
    writeCbPtr(cbsBuf, CB_END_STREAM, endStream);
    this.#callbacks.push(endStream);

    // reset_stream: remote sent RESET_STREAM.
    const resetStream = new FfiCallback(
      { parameters: ['pointer', 'i64', 'u64', 'pointer', 'pointer'], result: 'i32' },
      (_conn: ArrayBuffer, streamId: bigint, appErrorCode: bigint) => {
        this.#bodySlots.delete(streamId);
        this.#pendingTrailers.delete(streamId);
        this.#yieldedBytes.delete(streamId);
        cb.onResetStream(streamId, appErrorCode);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RESET_STREAM, resetStream);
    this.#callbacks.push(resetStream);

    if (cb.onShutdown) {
      const shutdown = new FfiCallback(
        { parameters: ['pointer', 'i64', 'pointer'], result: 'i32' },
        (_conn: ArrayBuffer, id: bigint) => { cb.onShutdown!(id); return 0; },
      );
      writeCbPtr(cbsBuf, CB_SHUTDOWN, shutdown);
      this.#callbacks.push(shutdown);
    }
  }

  // Shared read_data callback for all response body submissions.
  #installDataReader(drBuf: Uint8Array): void {
    const readData = new FfiCallback(
      {
        parameters: ['pointer', 'i64', 'pointer', 'usize', 'pointer', 'pointer', 'pointer'],
        result: 'isize',
      },
      (
        _conn: ArrayBuffer,
        streamId: bigint,
        vecBuf: ArrayBuffer,     // nghttp3_vec[] in C memory
        _veccnt: bigint,
        pflagsPtr: ArrayBuffer,  // uint32_t* — write flags here
      ): number => {
        const slot = this.#bodySlots.get(streamId);
        if (!slot) {
          Pointer.writeU32(pflagsPtr, 0, NGHTTP3_DATA_FLAG_EOF);
          return 0;
        }
        if (slot.error !== null) {
          this.#bodySlots.delete(streamId);
          return NGHTTP3_ERR_FATAL;
        }
        if (slot.bytes === null || slot.bytes.length === 0) {
          if (!slot.done) {
            this.#pullBodyChunk(streamId, slot);
            return NGHTTP3_ERR_WOULDBLOCK;
          }
          if (slot.trailers !== undefined) {
            // Body done, trailers follow. Signal EOF+NO_END_STREAM so nghttp3 keeps the
            // stream open, then queue trailers for submission after writev_stream returns.
            // Calling submit_trailers from here would be a reentrant nghttp3 call (we're
            // inside writev_stream → data reader) and corrupts internal state.
            Pointer.writeU32(pflagsPtr, 0, NGHTTP3_DATA_FLAG_EOF | NGHTTP3_DATA_FLAG_NO_END_STREAM);
            this.#pendingTrailers.set(streamId, slot.trailers);
            this.#bodySlots.delete(streamId);
          } else {
            Pointer.writeU32(pflagsPtr, 0, NGHTTP3_DATA_FLAG_EOF);
            this.#bodySlots.delete(streamId);
          }
          return 0;
        }
        const chunk = slot.bytes;
        const chunkAddr = Pointer.addr(chunk) as bigint;
        const entry = new Uint8Array(VEC_ENTRY_SIZE);
        const dv = new DataView(entry.buffer);
        dv.setBigUint64(0, chunkAddr, true);
        dv.setBigUint64(8, BigInt(chunk.length), true);
        Pointer.copyTo(vecBuf, entry);
        // Pin chunk in #yieldedBytes so V8 GC cannot free its backing store before
        // #drainWritesInner calls Pointer.copyFrom on the raw address we just stored.
        this.#yieldedBytes.set(streamId, chunk);
        slot.bytes = null;
        return 1;
      },
    );
    this.#callbacks.push(readData);

    // Write the callback pointer into the data reader struct at offset DR_READ_DATA.
    writeCbPtr(drBuf, DR_READ_DATA, readData);
  }

  // -------------------------------------------------------------------------
  // Stream binding — call once during connection startup.
  // -------------------------------------------------------------------------

  bindControlStream(controlStreamId: bigint): void {
    const rc = sym!.nghttp3_conn_bind_control_stream(this.#conn, controlStreamId) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_bind_control_stream failed: ${rc}`);
    this.#ready = true;
  }

  bindQpackStreams(qencId: bigint, qdecId: bigint): void {
    const rc = sym!.nghttp3_conn_bind_qpack_streams(this.#conn, qencId, qdecId) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_bind_qpack_streams failed: ${rc}`);
  }

  // Register a QUIC stream writer so drainWrites can write to it.
  addQuicStream(streamId: bigint, writer: { write(b: Uint8Array): Promise<void>; close(): Promise<void> }): void {
    this.#quicStreams.set(streamId, { writer });
  }

  // -------------------------------------------------------------------------
  // Submit operations — synchronous; safe to call outside #withMu on the JS thread.
  // -------------------------------------------------------------------------

  submitResponse(streamId: bigint, headers: Array<[string, string]>, body?: H3BodySource, trailers?: Array<[string, string]>): void {
    if (this.#closed) throw new Error('session closed');
    const { buf: nvBuf, nv } = buildNvArray(headers);
    const effectiveBody = body === undefined && trailers !== undefined ? new Uint8Array(0) : body;
    const drPtr = effectiveBody !== undefined ? Pointer.of(this.#drBuf) : null;
    if (effectiveBody !== undefined) {
      this.#bodySlots.set(streamId, this.#makeBodySlot(effectiveBody, trailers));
    }
    const rc = sym!.nghttp3_conn_submit_response(
      this.#conn, streamId, Pointer.of(nvBuf), nv, drPtr,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_response failed: ${rc}`);
  }

  submitRequest(streamId: bigint, headers: Array<[string, string]>, body?: H3BodySource, trailers?: Array<[string, string]>): void {
    if (this.#closed) throw new Error('session closed');
    const { buf: nvBuf, nv } = buildNvArray(headers);
    const effectiveBody = body === undefined && trailers !== undefined ? new Uint8Array(0) : body;
    const drPtr = effectiveBody !== undefined ? Pointer.of(this.#drBuf) : null;
    if (effectiveBody !== undefined) {
      this.#bodySlots.set(streamId, this.#makeBodySlot(effectiveBody, trailers));
    }
    const rc = sym!.nghttp3_conn_submit_request(
      this.#conn, streamId, Pointer.of(nvBuf), nv, drPtr, null,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_request failed: ${rc}`);
  }

  submitTrailers(streamId: bigint, trailers: Array<[string, string]>): void {
    if (this.#closed) throw new Error('session closed');
    const { buf: nvBuf, nv } = buildNvArray(trailers);
    const rc = sym!.nghttp3_conn_submit_trailers(
      this.#conn, streamId, Pointer.of(nvBuf), nv,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_trailers failed: ${rc}`);
  }

  #makeBodySlot(body: H3BodySource, trailers?: Array<[string, string]>): BodySlot {
    if (body instanceof Uint8Array) {
      return { bytes: body, iterator: null, pulling: false, done: true, error: null, trailers };
    }
    return {
      bytes: null,
      iterator: body[Symbol.asyncIterator](),
      pulling: false,
      done: false,
      error: null,
      trailers,
    };
  }

  #pullBodyChunk(streamId: bigint, slot: BodySlot): void {
    if (slot.iterator === null || slot.pulling || slot.done || this.#closed) return;
    slot.pulling = true;
    Promise.resolve(slot.iterator.next()).then((result) => {
      slot.pulling = false;
      if (this.#closed || this.#bodySlots.get(streamId) !== slot) return;
      if (result.done) {
        slot.done = true;
      } else {
        const value = result.value;
        slot.bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (slot.bytes.byteLength === 0) {
          this.#pullBodyChunk(streamId, slot);
          return;
        }
      }
      if (!this.#closed) {
        const rc = sym!.nghttp3_conn_resume_stream(this.#conn, streamId) as number;
        if (rc !== 0) {
          slot.error = new Error(`nghttp3_conn_resume_stream failed: ${rc}`);
        }
        void this.drainWrites().catch(() => {});
      }
    }, (error) => {
      slot.pulling = false;
      slot.error = error;
      if (!this.#closed && this.#bodySlots.get(streamId) === slot) {
        const rc = sym!.nghttp3_conn_resume_stream(this.#conn, streamId) as number;
        if (rc !== 0) this.close();
        void this.drainWrites().catch(() => {});
      }
    });
  }

  // -------------------------------------------------------------------------
  // Read: feed QUIC stream bytes into nghttp3.
  // -------------------------------------------------------------------------

  async readStream(streamId: bigint, data: Uint8Array, fin: boolean): Promise<void> {
    if (this.#closed) throw new Error('session closed');
    return this.#withMu(async () => {
      if (this.#closed) throw new Error('session closed');
      const ts = BigInt(Math.floor(performance.now() * 1_000_000));
      const consumed = sym!.nghttp3_conn_read_stream2(
        this.#conn, streamId, Pointer.of(data), data.byteLength, fin ? 1 : 0, ts,
      ) as number;
      if (consumed < 0) {
        const isStreamError = consumed === NGHTTP3_ERR_MALFORMED_HTTP_HEADER
                           || consumed === NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING;
        if (isStreamError) {
          sym!.nghttp3_conn_close_stream(this.#conn, streamId, NGHTTP3_H3_MESSAGE_ERROR);
        } else {
          this.close();
        }
        throw new Error(`nghttp3_conn_read_stream2 error: ${consumed}`);
      }
      await this.#drainWritesInner();
    });
  }

  // -------------------------------------------------------------------------
  // Write drain: pull nghttp3 output and push to QUIC streams.
  // -------------------------------------------------------------------------

  async drainWrites(): Promise<void> {
    return this.#withMu(() => this.#drainWritesInner());
  }

  async #drainWritesInner(): Promise<void> {
    const pStreamId = new ArrayBuffer(8);   // int64_t out-param
    const pfin      = new ArrayBuffer(4);   // int out-param
    const vecBuf    = new Uint8Array(_VEC_BUF_SIZE);

    while (true) {
      new DataView(pStreamId).setBigInt64(0, -1n, true);

      const n = sym!.nghttp3_conn_writev_stream(
        this.#conn,
        Pointer.of(pStreamId),
        Pointer.of(pfin),
        Pointer.of(vecBuf),
        _MAX_VECS,
      ) as number;

      const sid   = new DataView(pStreamId).getBigInt64(0, true);
      const isFin = new DataView(pfin).getInt32(0, true) !== 0;

      if (n < 0) {
        if (n === NGHTTP3_ERR_WOULDBLOCK) break;
        this.close();
        throw new Error(`nghttp3_conn_writev_stream error: ${n}`);
      }

      // Flush any trailers deferred by the data reader (calling submit_trailers from
      // within the data reader callback would be a reentrant nghttp3 call and is unsafe).
      let submittedTrailers = false;
      if (this.#pendingTrailers.size > 0) {
        const pending = [...this.#pendingTrailers];
        this.#pendingTrailers.clear();
        for (const [tsid, trailers] of pending) {
          const { buf, nv } = buildNvArray(trailers);
          const trc = sym!.nghttp3_conn_submit_trailers(this.#conn, tsid, Pointer.of(buf), nv) as number;
          if (trc === 0) {
            submittedTrailers = true;
          } else if (trc <= NGHTTP3_ERR_FATAL) {
            this.close();
            throw new Error(`nghttp3_conn_submit_trailers fatal: ${trc}`);
          }
          // non-fatal (stream not found / invalid state) → skip this trailer
        }
      }

      // Break only when truly nothing left — not when we just queued trailer frames.
      if (n === 0 && sid === -1n && !submittedTrailers) break;

      // Collect bytes from all returned vecs.
      let totalBytes = 0;
      const parts: Uint8Array[] = [];
      const dvVec = new DataView(vecBuf.buffer);

      for (let i = 0; i < n; i++) {
        const baseAddr = dvVec.getBigUint64(i * VEC_ENTRY_SIZE, true);
        const vecLen   = Number(dvVec.getBigUint64(i * VEC_ENTRY_SIZE + 8, true));
        if (vecLen === 0) continue;
        // Reconstruct a C-pointer ArrayBuffer from the raw address bigint.
        const addrBuf = new ArrayBuffer(8);
        new DataView(addrBuf).setBigUint64(0, baseAddr, true);
        parts.push(Pointer.copyFrom(addrBuf, vecLen) as Uint8Array);
        totalBytes += vecLen;
      }

      // Release the GC pin now that Pointer.copyFrom has copied the raw bytes.
      this.#yieldedBytes.delete(sid);

      // Write to the QUIC stream and report consumed bytes to nghttp3.
      if (sid !== -1n) {
        const entry = this.#quicStreams.get(sid);
        if (!entry) {
          if (totalBytes > 0) {
            // Writer is gone but nghttp3 still has data queued — close the stream so
            // nghttp3 stops producing for it. Without this, add_write_offset(0) would
            // stall the loop: nghttp3 never advances its buffer pointer.
            sym!.nghttp3_conn_close_stream(this.#conn, sid, NGHTTP3_H3_REQUEST_CANCELLED);
          } else {
            // FIN-only frame, writer already gone — advance by 0 so nghttp3 releases
            // its internal stream state instead of leaving a stale entry.
            sym!.nghttp3_conn_add_write_offset(this.#conn, sid, 0);
          }
          continue;
        }
        let consumed = 0;
        if (totalBytes > 0 && entry) {
          const combined = new Uint8Array(totalBytes);
          let off = 0;
          for (const p of parts) { combined.set(p, off); off += p.length; }
          await entry.writer.write(combined);
          if (this.#closed) return;
          consumed = totalBytes;
        }
        const arc = sym!.nghttp3_conn_add_write_offset(this.#conn, sid, consumed) as number;
        if (arc !== 0) {
          this.close();
          throw new Error(`nghttp3_conn_add_write_offset failed: ${arc}`);
        }
        if (isFin && entry) {
          void entry.writer.close();
          this.#quicStreams.delete(sid);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mutex helper
  // -------------------------------------------------------------------------

  #withMu<T>(fn: () => Promise<T>): Promise<T> {
    const p: Promise<T> = this.#mu.then(() => {
      if (this.#closed) return Promise.reject(new Error('session closed'));
      return fn();
    });
    this.#mu = p.then(() => {}, () => {});
    return p;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  get isClosed(): boolean { return this.#closed; }

  closeWhenIdle(): Promise<void> {
    const p = this.#mu.then(async () => {
      if (this.#closed) return;
      if (this.#ready) {
        const src = sym!.nghttp3_conn_shutdown(this.#conn) as number;
        if (src === 0) {
          try {
            await this.#drainWritesInner();
          } catch { /* non-fatal: GOAWAY sent, proceed to close */ }
        }
      }
      this.close();
    });
    this.#mu = p.then(() => {}, () => {});
    return p;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    sym!.nghttp3_conn_del(this.#conn);
    for (const cb of this.#callbacks) cb.close();
    this.#callbacks.length = 0;
    this.#bodySlots.clear();
    this.#pendingTrailers.clear();
    this.#yieldedBytes.clear();
    this.#quicStreams.clear();
  }

  [Symbol.dispose](): void { this.close(); }
}
