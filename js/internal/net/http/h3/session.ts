/**
* internal:net/http/h3/session - nghttp3 session wrapper.
*
* HTTP/3 specification: https://www.rfc-editor.org/rfc/rfc9114
*
* Provides the low-level request/response submission, callback registration,
* native buffer management, and event processing used by the internal HTTP/3
* client and server drivers.
*
* @internal
*/
import { TextDecoder as _TextDecoder } from '../../../../globals/encoding.ts';
import { sym, FfiCallback, Pointer, h3Available, NGHTTP3_CALLBACKS_VERSION, NGHTTP3_SETTINGS_VERSION, CB_SIZE, SETTINGS_SIZE, CB_ACKED_STREAM_DATA, CB_STREAM_CLOSE, CB_RECV_DATA, CB_DEFERRED_CONSUME, CB_BEGIN_HEADERS, CB_RECV_HEADER, CB_END_HEADERS, CB_BEGIN_TRAILERS, CB_RECV_TRAILER, CB_END_TRAILERS, CB_END_STREAM, CB_RESET_STREAM, CB_SHUTDOWN, CB_RECV_SETTINGS2, SETTINGS_ENABLE_CONNECT_PROTOCOL as NGHTTP3_SETTINGS_ENABLE_CONNECT_PROTOCOL, SETTINGS_H3_DATAGRAM as NGHTTP3_SETTINGS_H3_DATAGRAM, PROTO_SETTINGS_ENABLE_CONNECT_PROTOCOL, PROTO_SETTINGS_H3_DATAGRAM, NV_ENTRY_SIZE, VEC_ENTRY_SIZE, DR_READ_DATA, DR_SIZE, NGHTTP3_DATA_FLAG_EOF, NGHTTP3_DATA_FLAG_NO_END_STREAM, NGHTTP3_ERR_WOULDBLOCK, NGHTTP3_ERR_FATAL, NGHTTP3_ERR_MALFORMED_HTTP_HEADER, NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING, NGHTTP3_H3_MESSAGE_ERROR, NGHTTP3_H3_REQUEST_CANCELLED, buildNvArray, readRcbuf, writeCbPtr } from './bindings.ts';
import { injectWebTransportSettings, readWebTransportSettings, SETTINGS_WT_ENABLED, SETTINGS_ENABLE_CONNECT_PROTOCOL, SETTINGS_H3_DATAGRAM, webTransportSettings, webTransportSettingsEnabled } from './webtransport.ts';
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
  onAckedStreamData?(streamId: bigint, datalen: bigint): void;
  onShutdown?(lastStreamId: bigint): void;
  onRecvSettings?(settings: ReadonlyMap<number, number>): void;
}
export type H3BodySource = Uint8Array | AsyncIterable<Uint8Array | ArrayBuffer>;
export interface H3SessionOptions {
  webTransport?: boolean;
}
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
const _PTR_SIZE = 8;
const _PTR_DATA = 0;
const _PTR_STREAM_ID = 1;
const _PTR_FIN = 2;
const _PTR_VEC = 3;
const _PTR_NV = 4;
const _PTR_DR = 5;
const _PTR_TRAILERS = 6;
function nameForQpackToken(token: number): string | null {
  switch (token) {
    case 0: return ':authority';
    case 1: return ':method';
    case 8: return ':path';
    case 9: return ':scheme';
    case 11: return ':status';
    case 25: return 'accept';
    case 27: return 'accept-encoding';
    case 28: return 'accept-language';
    case 45: return 'authorization';
    case 55: return 'content-length';
    case 57: return 'content-type';
    case 68: return 'cookie';
    case 91: return 'user-agent';
    case 1e3: return 'host';
    case 1001: return 'connection';
    case 1002: return 'keep-alive';
    case 1003: return 'proxy-connection';
    case 1004: return 'transfer-encoding';
    case 1005: return 'upgrade';
    case 1006: return 'te';
    case 1007: return ':protocol';
    default: return null;
  }
}
function protoSettingsToMap(settingsPtr: ArrayBuffer | null): Map<number, number> {
  const settings = new Map<number, number>();
  if (settingsPtr === null) return settings;
  settings.set(SETTINGS_ENABLE_CONNECT_PROTOCOL, Pointer.readU8(settingsPtr, PROTO_SETTINGS_ENABLE_CONNECT_PROTOCOL) === 0 ? 0 : 1);
  settings.set(SETTINGS_H3_DATAGRAM, Pointer.readU8(settingsPtr, PROTO_SETTINGS_H3_DATAGRAM) === 0 ? 0 : 1);
  return settings;
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
export class Nghttp3Session {
  #conn: ArrayBuffer;
  #callbacks: Array<{
    close(): void;
  }> = [];
  #cbsBuf: Uint8Array;
  #drBuf: Uint8Array;
  #ptrArena = new ArrayBuffer(_PTR_SIZE * 8);
  #ptrSlots = Array.from({ length: 8 }, (_, i) => new Uint8Array(this.#ptrArena, i * _PTR_SIZE, _PTR_SIZE));
  #writeStreamIdBuf = new ArrayBuffer(8);
  #writeStreamIdView = new DataView(this.#writeStreamIdBuf);
  #writeFinBuf = new ArrayBuffer(4);
  #writeFinView = new DataView(this.#writeFinBuf);
  #writeVecBuf = new Uint8Array(_VEC_BUF_SIZE);
  #writeVecView = new DataView(this.#writeVecBuf.buffer);
  #vecAddrBuf = new ArrayBuffer(8);
  #vecAddrView = new DataView(this.#vecAddrBuf);
  #singleVecScratch = new Uint8Array(16 * 1024);
  #bodySlots = new Map<bigint, BodySlot>();
  #pendingTrailers = new Map<bigint, Array<[string, string]>>();
  #yieldedBytes = new Map<bigint, Uint8Array>();
  #webTransportSettingsPrefixes = new Map<bigint, Uint8Array>();
  #quicStreams = new Map<bigint, {
    writer: {
      write(b: Uint8Array): Promise<void>;
      writeSync?(b: Uint8Array): void;
      close(): Promise<void>;
      closeSync?(): void;
    };
  }>();
  #closed = false;
  #ready = false;
  #locked = false;
  #localSettings = new Map<number, number>();
  #peerSettings = new Map<number, number>();
  #peerSettingsReceived = false;
  #webTransport = false;
  #controlStreamId: bigint | null = null;
  readonly #cb: H3SessionCallbacks;
  private constructor(conn: ArrayBuffer, cbsBuf: Uint8Array, drBuf: Uint8Array, cb: H3SessionCallbacks) {
    this.#conn = conn;
    this.#cbsBuf = cbsBuf;
    this.#drBuf = drBuf;
    this.#cb = cb;
  }
  #ptrOf(source: ArrayBuffer | ArrayBufferView, slot: number): Uint8Array {
    Pointer.of(source, this.#ptrArena, slot * _PTR_SIZE);
    return this.#ptrSlots[slot]!;
  }
  static createServer(cb: H3SessionCallbacks, options: H3SessionOptions = {}): Nghttp3Session {
    if (!h3Available || sym === null) throw new Error('libnghttp3 is not available');
    return Nghttp3Session.#create(cb, true, options);
  }
  static createClient(cb: H3SessionCallbacks, options: H3SessionOptions = {}): Nghttp3Session {
    if (!h3Available || sym === null) throw new Error('libnghttp3 is not available');
    return Nghttp3Session.#create(cb, false, options);
  }
  static #create(cb: H3SessionCallbacks, isServer: boolean, options: H3SessionOptions): Nghttp3Session {
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
    const localSettings = new Map<number, number>();
    if (options.webTransport === true) {
      settingsBuf[NGHTTP3_SETTINGS_ENABLE_CONNECT_PROTOCOL] = 1;
      settingsBuf[NGHTTP3_SETTINGS_H3_DATAGRAM] = 1;
      for (const [id, value] of webTransportSettings()) localSettings.set(id, value);
    }
    const rc = isServer ? sym!.nghttp3_conn_server_new_versioned(Pointer.of(connHandle), NGHTTP3_CALLBACKS_VERSION, Pointer.of(cbsBuf), NGHTTP3_SETTINGS_VERSION, Pointer.of(settingsBuf), null, null) as number : sym!.nghttp3_conn_client_new_versioned(Pointer.of(connHandle), NGHTTP3_CALLBACKS_VERSION, Pointer.of(cbsBuf), NGHTTP3_SETTINGS_VERSION, Pointer.of(settingsBuf), null, null) as number;
    if (rc !== 0) {
      session.#closed = true;
      throw new Error(`nghttp3_conn_${isServer ? 'server' : 'client'}_new_versioned failed: ${rc}`);
    }
    session.#localSettings = localSettings;
    session.#webTransport = options.webTransport === true;
    return session;
  }
  // -------------------------------------------------------------------------
  // Callback installation
  // -------------------------------------------------------------------------
  #installCallbacks(cbsBuf: Uint8Array): void {
    const cb = this.#cb;
    if (cb.onAckedStreamData !== undefined) {
      // acked_stream_data: nghttp3 no longer needs the body bytes.
      const ackedStreamData = new FfiCallback({
        parameters: [
          'ignoredPointer',
          'i64',
          'usize',
          'ignoredPointer',
          'ignoredPointer'
        ],
        result: 'i32'
      }, (_conn: ArrayBuffer, streamId: bigint, datalen: bigint) => {
        cb.onAckedStreamData!(streamId, datalen);
        return 0;
      });
      writeCbPtr(cbsBuf, CB_ACKED_STREAM_DATA, ackedStreamData);
      this.#callbacks.push(ackedStreamData);
    }
    // stream_close: stream finished (cleanly or with error).
    const streamClose = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'u64',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint, appErrorCode: bigint) => {
      this.#bodySlots.delete(streamId);
      this.#pendingTrailers.delete(streamId);
      this.#yieldedBytes.delete(streamId);
      this.#webTransportSettingsPrefixes.delete(streamId);
      cb.onStreamClose(streamId, appErrorCode);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_STREAM_CLOSE, streamClose);
    this.#callbacks.push(streamClose);
    // recv_data: body chunk arrived on a stream.
    const recvData = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'pointer',
        'usize',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint, dataPtr: ArrayBuffer, datalen: bigint) => {
      const bytes = Pointer.copyFrom(dataPtr, Number(datalen)) as Uint8Array;
      cb.onRecvData(streamId, bytes);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_RECV_DATA, recvData);
    this.#callbacks.push(recvData);
    // begin_headers: start of a request or response header block.
    const beginHeaders = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint) => {
      cb.onBeginHeaders(streamId);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_BEGIN_HEADERS, beginHeaders);
    this.#callbacks.push(beginHeaders);
    // recv_header: one decoded header field.
    // name and value are nghttp3_rcbuf* — read struct at offset 8 (base) and 16 (len).
    const recvHeader = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'i32',
        'pointer',
        'pointer',
        'u8',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint, token: number, nameRcbuf: ArrayBuffer, valueRcbuf: ArrayBuffer, flags: number) => {
      const name = nameForQpackToken(token) ?? readRcbuf(nameRcbuf);
      const value = readRcbuf(valueRcbuf);
      cb.onRecvHeader(streamId, token, name, value, flags);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_RECV_HEADER, recvHeader);
    this.#callbacks.push(recvHeader);
    // end_headers: header block complete.
    const endHeaders = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'i32',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint, fin: number) => {
      cb.onEndHeaders(streamId, fin !== 0);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_END_HEADERS, endHeaders);
    this.#callbacks.push(endHeaders);
    // begin_trailers / recv_trailer / end_trailers — same shapes as headers.
    const beginTrailers = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint) => {
      cb.onBeginTrailers(streamId);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_BEGIN_TRAILERS, beginTrailers);
    this.#callbacks.push(beginTrailers);
    const recvTrailer = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'i32',
        'pointer',
        'pointer',
        'u8',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint, token: number, nameRcbuf: ArrayBuffer, valueRcbuf: ArrayBuffer, flags: number) => {
      cb.onRecvTrailer(streamId, token, nameForQpackToken(token) ?? readRcbuf(nameRcbuf), readRcbuf(valueRcbuf), flags);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_RECV_TRAILER, recvTrailer);
    this.#callbacks.push(recvTrailer);
    const endTrailers = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'i32',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint, fin: number) => {
      cb.onEndTrailers(streamId, fin !== 0);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_END_TRAILERS, endTrailers);
    this.#callbacks.push(endTrailers);
    // end_stream: FIN received on the stream.
    const endStream = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint) => {
      cb.onEndStream(streamId);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_END_STREAM, endStream);
    this.#callbacks.push(endStream);
    // reset_stream: remote sent RESET_STREAM.
    const resetStream = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'u64',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, streamId: bigint, appErrorCode: bigint) => {
      this.#bodySlots.delete(streamId);
      this.#pendingTrailers.delete(streamId);
      this.#yieldedBytes.delete(streamId);
      this.#webTransportSettingsPrefixes.delete(streamId);
      cb.onResetStream(streamId, appErrorCode);
      return 0;
    });
    writeCbPtr(cbsBuf, CB_RESET_STREAM, resetStream);
    this.#callbacks.push(resetStream);
    if (cb.onShutdown) {
      const shutdown = new FfiCallback({
        parameters: [
          'ignoredPointer',
          'i64',
          'ignoredPointer'
        ],
        result: 'i32'
      }, (_conn: ArrayBuffer, id: bigint) => {
        cb.onShutdown!(id);
        return 0;
      });
      writeCbPtr(cbsBuf, CB_SHUTDOWN, shutdown);
      this.#callbacks.push(shutdown);
    }
    const recvSettings2 = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'pointer',
        'ignoredPointer'
      ],
      result: 'i32'
    }, (_conn: ArrayBuffer, settingsPtr: ArrayBuffer | null) => {
      this.#recordPeerSettings(protoSettingsToMap(settingsPtr));
      return 0;
    });
    writeCbPtr(cbsBuf, CB_RECV_SETTINGS2, recvSettings2);
    this.#callbacks.push(recvSettings2);
  }
  // Shared read_data callback for all response body submissions.
  #installDataReader(drBuf: Uint8Array): void {
    const readData = new FfiCallback({
      parameters: [
        'ignoredPointer',
        'i64',
        'pointer',
        'usize',
        'pointer',
        'ignoredPointer',
        'ignoredPointer'
      ],
      result: 'isize'
    }, (_conn: ArrayBuffer, streamId: bigint, vecBuf: ArrayBuffer, _veccnt: bigint, pflagsPtr: ArrayBuffer): number => {
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
    });
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
    this.#controlStreamId = controlStreamId;
    this.#ready = true;
  }
  bindQpackStreams(qencId: bigint, qdecId: bigint): void {
    const rc = sym!.nghttp3_conn_bind_qpack_streams(this.#conn, qencId, qdecId) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_bind_qpack_streams failed: ${rc}`);
  }
  // Register a QUIC stream writer so drainWrites can write to it.
  addQuicStream(streamId: bigint, writer: {
    write(b: Uint8Array): Promise<void>;
    writeSync?(b: Uint8Array): void;
    close(): Promise<void>;
    closeSync?(): void;
  }): void {
    this.#quicStreams.set(streamId, { writer });
  }
  // -------------------------------------------------------------------------
  // Submit operations — synchronous; safe to call on the JS thread.
  // -------------------------------------------------------------------------
  submitResponse(streamId: bigint, headers: Array<[string, string]>, body?: H3BodySource, trailers?: Array<[string, string]>): void {
    if (this.#closed) throw new Error('session closed');
    const { buf: nvBuf, nv } = buildNvArray(headers);
    const effectiveBody = body === undefined && trailers !== undefined ? new Uint8Array(0) : body;
    const drPtr = effectiveBody !== undefined ? this.#ptrOf(this.#drBuf, _PTR_DR) : null;
    if (effectiveBody !== undefined) {
      this.#bodySlots.set(streamId, this.#makeBodySlot(effectiveBody, trailers));
    }
    const rc = sym!.nghttp3_conn_submit_response(this.#conn, streamId, this.#ptrOf(nvBuf, _PTR_NV), nv, drPtr) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_response failed: ${rc}`);
  }
  submitRequest(streamId: bigint, headers: Array<[string, string]>, body?: H3BodySource, trailers?: Array<[string, string]>): void {
    if (this.#closed) throw new Error('session closed');
    const { buf: nvBuf, nv } = buildNvArray(headers);
    const effectiveBody = body === undefined && trailers !== undefined ? new Uint8Array(0) : body;
    const drPtr = effectiveBody !== undefined ? this.#ptrOf(this.#drBuf, _PTR_DR) : null;
    if (effectiveBody !== undefined) {
      this.#bodySlots.set(streamId, this.#makeBodySlot(effectiveBody, trailers));
    }
    const rc = sym!.nghttp3_conn_submit_request(this.#conn, streamId, this.#ptrOf(nvBuf, _PTR_NV), nv, drPtr, null) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_request failed: ${rc}`);
  }
  submitTrailers(streamId: bigint, trailers: Array<[string, string]>): void {
    if (this.#closed) throw new Error('session closed');
    const { buf: nvBuf, nv } = buildNvArray(trailers);
    const rc = sym!.nghttp3_conn_submit_trailers(this.#conn, streamId, this.#ptrOf(nvBuf, _PTR_NV), nv) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_trailers failed: ${rc}`);
  }
  #makeBodySlot(body: H3BodySource, trailers?: Array<[string, string]>): BodySlot {
    if (body instanceof Uint8Array) {
      return {
        bytes: body,
        iterator: null,
        pulling: false,
        done: true,
        error: null,
        trailers
      };
    }
    return {
      bytes: null,
      iterator: body[Symbol.asyncIterator](),
      pulling: false,
      done: false,
      error: null,
      trailers
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
        try {
          this.drainWrites();
        } catch {
          this.close();
        }
      }
    }, (error) => {
      slot.pulling = false;
      slot.error = error;
      if (!this.#closed && this.#bodySlots.get(streamId) === slot) {
        const rc = sym!.nghttp3_conn_resume_stream(this.#conn, streamId) as number;
        if (rc !== 0) this.close();
        try {
          this.drainWrites();
        } catch {
          this.close();
        }
      }
    });
  }
  // -------------------------------------------------------------------------
  // Read: feed QUIC stream bytes into nghttp3.
  // -------------------------------------------------------------------------
  readStream(streamId: bigint, data: Uint8Array, fin: boolean): void {
    if (this.#closed) throw new Error('session closed');
    this.#withLock(() => {
      if (this.#closed) throw new Error('session closed');
      if (this.#webTransport && data.byteLength > 0) {
        const buffered = this.#bufferWebTransportSettingsPrefix(streamId, data);
        const settings = readWebTransportSettings(buffered);
        if (settings.size > 0) {
          this.#webTransportSettingsPrefixes.delete(streamId);
          this.#recordPeerSettings(settings);
        }
      }
      const ts = BigInt(Math.floor(performance.now() * 1e6));
      const consumed = sym!.nghttp3_conn_read_stream2(this.#conn, streamId, this.#ptrOf(data, _PTR_DATA), data.byteLength, fin ? 1 : 0, ts) as number;
      if (consumed < 0) {
        const isStreamError = consumed === NGHTTP3_ERR_MALFORMED_HTTP_HEADER || consumed === NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING;
        if (isStreamError) {
          sym!.nghttp3_conn_close_stream(this.#conn, streamId, NGHTTP3_H3_MESSAGE_ERROR);
        } else {
          this.close();
        }
        throw new Error(`nghttp3_conn_read_stream2 error: ${consumed}`);
      }
      this.#drainWritesInnerSync();
    });
  }
  // -------------------------------------------------------------------------
  // Write drain: pull nghttp3 output and push to QUIC streams.
  // -------------------------------------------------------------------------
  drainWrites(): void {
    this.#withLock(() => this.#drainWritesInnerSync());
  }
  #copyVecBytesInto(dest: Uint8Array, baseAddr: bigint, vecLen: number): void {
    this.#vecAddrView.setBigUint64(0, baseAddr, true);
    Pointer.copyFromInto(dest, this.#vecAddrBuf, vecLen);
  }
  #ensureVecScratch(size: number): Uint8Array {
    if (size > this.#singleVecScratch.byteLength) {
      let nextSize = this.#singleVecScratch.byteLength;
      while (nextSize < size) nextSize *= 2;
      this.#singleVecScratch = new Uint8Array(nextSize);
    }
    return this.#singleVecScratch.subarray(0, size);
  }
  #copyVecBytesToScratch(baseAddr: bigint, vecLen: number): Uint8Array {
    const out = this.#ensureVecScratch(vecLen);
    this.#copyVecBytesInto(out, baseAddr, vecLen);
    return out;
  }
  #drainWritesInnerSync(): void {
    const pStreamId = this.#writeStreamIdBuf;
    const pfin = this.#writeFinBuf;
    const vecBuf = this.#writeVecBuf;
    const dvVec = this.#writeVecView;
    while (true) {
      this.#writeStreamIdView.setBigInt64(0, -1n, true);
      const n = sym!.nghttp3_conn_writev_stream(this.#conn, this.#ptrOf(pStreamId, _PTR_STREAM_ID), this.#ptrOf(pfin, _PTR_FIN), this.#ptrOf(vecBuf, _PTR_VEC), _MAX_VECS) as number;
      const sid = this.#writeStreamIdView.getBigInt64(0, true);
      const isFin = this.#writeFinView.getInt32(0, true) !== 0;
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
          const trc = sym!.nghttp3_conn_submit_trailers(this.#conn, tsid, this.#ptrOf(buf, _PTR_TRAILERS), nv) as number;
          if (trc === 0) {
            submittedTrailers = true;
          } else if (trc <= NGHTTP3_ERR_FATAL) {
            this.close();
            throw new Error(`nghttp3_conn_submit_trailers fatal: ${trc}`);
          }
        }
      }
      // Break only when truly nothing left — not when we just queued trailer frames.
      if (n === 0 && sid === -1n && !submittedTrailers) break;
      // Collect bytes from all returned vecs. nghttp3 owns these buffers, so
      // copy before calling add_write_offset or returning to the event loop.
      let totalBytes = 0;
      let nonEmptyVecs = 0;
      let singleBaseAddr = 0n;
      let singleVecLen = 0;
      for (let i = 0; i < n; i++) {
        const baseAddr = dvVec.getBigUint64(i * VEC_ENTRY_SIZE, true);
        const vecLen = Number(dvVec.getBigUint64(i * VEC_ENTRY_SIZE + 8, true));
        if (vecLen === 0) continue;
        if (nonEmptyVecs === 0) {
          singleBaseAddr = baseAddr;
          singleVecLen = vecLen;
        }
        nonEmptyVecs++;
        totalBytes += vecLen;
      }
      // Write to the QUIC stream and report consumed bytes to nghttp3.
      if (sid !== -1n) {
        const entry = this.#quicStreams.get(sid);
        if (!entry) {
          this.#yieldedBytes.delete(sid);
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
          let outgoing: Uint8Array;
          if (nonEmptyVecs === 1) {
            outgoing = this.#copyVecBytesToScratch(singleBaseAddr, singleVecLen);
          } else {
            // Reuse the same growable scratch as the single-vec path: writeSync
            // copies synchronously (#writeChunk does buf.slice()), so the buffer
            // is free to reuse on the next iteration.
            outgoing = this.#ensureVecScratch(totalBytes);
            let off = 0;
            for (let i = 0; i < n; i++) {
              const baseAddr = dvVec.getBigUint64(i * VEC_ENTRY_SIZE, true);
              const vecLen = Number(dvVec.getBigUint64(i * VEC_ENTRY_SIZE + 8, true));
              if (vecLen === 0) continue;
              this.#copyVecBytesInto(outgoing.subarray(off, off + vecLen), baseAddr, vecLen);
              off += vecLen;
            }
          }
          // Release the GC pin now that the nghttp3 bytes have been copied.
          this.#yieldedBytes.delete(sid);
          outgoing = this.#patchOutgoingStreamBytes(sid, outgoing);
          if (entry.writer.writeSync === undefined) {
            throw new Error('H3 stream writer does not support synchronous writes');
          }
          entry.writer.writeSync(outgoing);
          if (this.#closed) return;
          consumed = totalBytes;
        }
        const arc = sym!.nghttp3_conn_add_write_offset(this.#conn, sid, consumed) as number;
        if (arc !== 0) {
          this.close();
          throw new Error(`nghttp3_conn_add_write_offset failed: ${arc}`);
        }
        if (isFin && entry && sid !== this.#controlStreamId) {
          if (entry.writer.closeSync === undefined) {
            throw new Error('H3 stream writer does not support synchronous close');
          }
          entry.writer.closeSync();
          this.#quicStreams.delete(sid);
        }
      }
    }
  }
  // -------------------------------------------------------------------------
  // Mutex helper
  // -------------------------------------------------------------------------
  #withLock<T>(fn: () => T): T {
    if (this.#locked) throw new Error('nghttp3 session operation re-entered');
    this.#locked = true;
    try {
      if (this.#closed) throw new Error('session closed');
      return fn();
    } finally {
      this.#locked = false;
    }
  }
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  get isClosed(): boolean {
    return this.#closed;
  }
  get localSettings(): ReadonlyMap<number, number> {
    return new Map(this.#localSettings);
  }
  get peerSettings(): ReadonlyMap<number, number> {
    return new Map(this.#peerSettings);
  }
  get peerSettingsReceived(): boolean {
    return this.#peerSettingsReceived;
  }
  get peerWebTransportReady(): boolean {
    return webTransportSettingsEnabled(this.#peerSettings);
  }
  _recordPeerSettingsForTest(settings: ReadonlyMap<number, number>): void {
    this.#recordPeerSettings(settings);
  }
  #recordPeerSettings(settings: ReadonlyMap<number, number>): void {
    const merged = new Map(this.#peerSettings);
    for (const [id, value] of settings) {
      if (value === 0 && merged.get(id) === 1) continue;
      merged.set(id, value);
    }
    this.#peerSettings = merged;
    this.#peerSettingsReceived = true;
    this.#cb.onRecvSettings?.(this.peerSettings);
  }
  #bufferWebTransportSettingsPrefix(streamId: bigint, data: Uint8Array): Uint8Array {
    if (this.#peerSettingsReceived) return data;
    if (data.byteLength > 0 && data[0] !== 0) return data;
    const previous = this.#webTransportSettingsPrefixes.get(streamId);
    const buffered = previous === undefined ? data : concatBytes([previous, data]);
    if (buffered.byteLength > 4096) {
      this.#webTransportSettingsPrefixes.delete(streamId);
      return data;
    }
    this.#webTransportSettingsPrefixes.set(streamId, buffered);
    return buffered;
  }
  #patchOutgoingStreamBytes(streamId: bigint, bytes: Uint8Array): Uint8Array {
    if (!this.#webTransport || streamId !== this.#controlStreamId || !this.#localSettings.has(SETTINGS_WT_ENABLED)) {
      return bytes;
    }
    return injectWebTransportSettings(bytes);
  }
  closeWhenIdle(): Promise<void> {
    try {
      if (this.#closed) return Promise.resolve();
      if (this.#ready) {
        const src = sym!.nghttp3_conn_shutdown(this.#conn) as number;
        if (src === 0) {
          try {
            this.drainWrites();
          } catch {}
        }
      }
      this.close();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
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
  [Symbol.dispose](): void {
    this.close();
  }
}
