/**
 * internal:net/http/h3/session — nghttp3 connection wrapper for HTTP/3.
 *
 * Wraps a single `nghttp3_conn` (via `fino:ffi` bindings) and exposes it to the
 * HTTP/3 client and server drivers as an ordinary JS object. The class owns all
 * of the native plumbing that HTTP/3 requires: the callbacks struct, the shared
 * data-reader struct, a small arena of reusable pointer slots, and the GC pins
 * that keep body buffers alive across FFI boundaries. Callers deal only in
 * `bigint` stream ids, header tuples, and byte chunks — never raw pointers.
 *
 * The session sits between two layers. Above it, a driver submits requests or
 * responses and receives decoded HTTP events through an `H3SessionCallbacks`
 * object. Below it, the same driver feeds inbound QUIC stream bytes in through
 * `receiveStreamData()`/`endStream()` and lets `drainWrites()` push nghttp3's framed output back out
 * to the QUIC stream writers registered with `addQuicStream()`. nghttp3 does the
 * QPACK, framing, and HTTP semantics; this module is the adapter that turns its
 * C callback/vector API into event callbacks and owned `Uint8Array`s.
 *
 * Ordering matters during connection startup. A freshly created session must
 * have its control stream bound with `bindControlStream()` and its QPACK
 * encoder/decoder streams bound with `bindQpackStreams()` before any request or
 * response is submitted; `submitRequest`/`submitResponse` throw until the QPACK
 * streams exist. Each QUIC stream the driver opens must be registered with
 * `addQuicStream()` so the write drain can find its writer.
 *
 * Bodies may be a single `Uint8Array` or an async iterable of chunks. Async
 * bodies are pulled lazily: the native data reader returns "would block" and the
 * session resumes the stream once the next chunk resolves, so backpressure flows
 * from nghttp3 through to the producing iterator. Trailers submitted alongside a
 * body are deferred and flushed from the write drain rather than from inside the
 * data-reader callback, because re-entering nghttp3 there corrupts its state.
 *
 * Inbound stream operations and `drainWrites()` are guarded by a re-entrancy lock: calling
 * either while the other is on the stack throws rather than corrupting nghttp3.
 * All operations are synchronous and safe to run on the JS thread — the only
 * asynchrony is async body iteration, which schedules its continuation as a
 * microtask.
 *
 * WebTransport support is opt-in via `H3SessionOptions.webTransport`. When
 * enabled the session advertises the extended-CONNECT and H3-datagram SETTINGS,
 * buffers the peer's control-stream SETTINGS prefix until it can be decoded, and
 * injects the WebTransport SETTINGS into its own outgoing control stream.
 *
 * This is an internal building block; application code should use the HTTP/3
 * client and server drivers rather than driving a session directly.
 *
 * HTTP/3 specification: https://www.rfc-editor.org/rfc/rfc9114
 * HTTP/3 ORIGIN extension: https://www.rfc-editor.org/rfc/rfc9412
 *
 * ```ts no_run
 * import { Nghttp3Session } from 'internal:net/http/h3/session';
 *
 * const session = Nghttp3Session.createServer({
 *   onBeginHeaders(streamId) {},
 *   onRecvHeader(streamId, token, name, value) {},
 *   onEndHeaders(streamId, fin) {
 *     session.submitResponse(streamId, [[':status', '200']],
 *       new TextEncoder().encode('hello'));
 *     session.drainWrites();
 *   },
 *   onBeginTrailers(streamId) {},
 *   onRecvTrailer(streamId, token, name, value) {},
 *   onEndTrailers(streamId, fin) {},
 *   onRecvData(streamId, data) {},
 *   onEndStream(streamId) {},
 *   onStreamClose(streamId, appErrorCode) {},
 *   onResetStream(streamId, appErrorCode) {},
 * });
 *
 * // Bind the HTTP/3 control and QPACK streams opened on the QUIC connection.
 * session.bindControlStream(controlStreamId);
 * session.bindQpackStreams(qpackEncoderStreamId, qpackDecoderStreamId);
 * session.addQuicStream(controlStreamId, controlWriter);
 * session.drainWrites();
 *
 * // For each inbound QUIC request stream: register its writer, then feed bytes.
 * session.addQuicStream(requestStreamId, requestWriter);
 * session.receiveStreamData(requestStreamId, inboundBytes);
 * session.endStream(requestStreamId);
 * ```
 *
 * @internal
 */
import {
  TextDecoder as _TextDecoder,
  TextEncoder as _TextEncoder,
} from '../../../../globals/encoding.ts';
import {
  sym,
  FfiCallback,
  Pointer,
  h3Available,
  NGHTTP3_CALLBACKS_VERSION,
  NGHTTP3_SETTINGS_VERSION,
  CB_SIZE,
  SETTINGS_SIZE,
  SETTINGS_MAX_FIELD_SECTION_SIZE,
  SETTINGS_QPACK_MAX_DTABLE_CAPACITY,
  SETTINGS_QPACK_ENCODER_MAX_DTABLE_CAPACITY,
  SETTINGS_QPACK_BLOCKED_STREAMS,
  CB_ACKED_STREAM_DATA,
  CB_STREAM_CLOSE,
  CB_RECV_DATA,
  CB_DEFERRED_CONSUME,
  CB_BEGIN_HEADERS,
  CB_RECV_HEADER,
  CB_END_HEADERS,
  CB_BEGIN_TRAILERS,
  CB_RECV_TRAILER,
  CB_END_TRAILERS,
  CB_END_STREAM,
  CB_RESET_STREAM,
  CB_SHUTDOWN,
  CB_RECV_ORIGIN,
  CB_END_ORIGIN,
  CB_RECV_SETTINGS2,
  SETTINGS_ENABLE_CONNECT_PROTOCOL as NGHTTP3_SETTINGS_ENABLE_CONNECT_PROTOCOL,
  SETTINGS_H3_DATAGRAM as NGHTTP3_SETTINGS_H3_DATAGRAM,
  SETTINGS_ORIGIN_LIST,
  PROTO_SETTINGS_ENABLE_CONNECT_PROTOCOL,
  PROTO_SETTINGS_H3_DATAGRAM,
  PROTO_SETTINGS_MAX_FIELD_SECTION_SIZE,
  PROTO_SETTINGS_QPACK_MAX_DTABLE_CAPACITY,
  PROTO_SETTINGS_QPACK_BLOCKED_STREAMS,
  NV_ENTRY_SIZE,
  VEC_ENTRY_SIZE,
  DR_READ_DATA,
  DR_SIZE,
  NGHTTP3_DATA_FLAG_EOF,
  NGHTTP3_DATA_FLAG_NO_END_STREAM,
  NGHTTP3_ERR_WOULDBLOCK,
  NGHTTP3_ERR_FATAL,
  NGHTTP3_ERR_MALFORMED_HTTP_HEADER,
  NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING,
  NGHTTP3_H3_NO_ERROR,
  NGHTTP3_H3_MESSAGE_ERROR,
  NGHTTP3_H3_REQUEST_CANCELLED,
  buildNvArray,
  readRcbuf,
  writeCbPtr,
} from './bindings.ts';
import {
  injectWebTransportSettings,
  readWebTransportSettings,
  SETTINGS_WT_ENABLED,
  SETTINGS_ENABLE_CONNECT_PROTOCOL,
  SETTINGS_H3_DATAGRAM,
  webTransportSettings,
  webTransportSettingsEnabled,
} from './webtransport.ts';
import { encodeH3OriginList } from './origin.ts';
/**
 * Re-exported from the h3 bindings module so drivers can build the native
 * name/value header array without importing `bindings.ts` separately.
 *
 * Takes an array of `[name, value]` header tuples and returns the packed
 * `nghttp3_nv` struct buffer plus the entry count, ready to hand to a submit
 * call. See `internal:net/http/h3/bindings` for the full description.
 */
export { buildNvArray };
/**
 * Event callbacks a driver registers with a session to observe decoded HTTP/3.
 *
 * The session invokes these synchronously while receiving stream input as
 * nghttp3 decodes inbound frames. Header and trailer fields arrive one at a
 * time between the matching `begin`/`end` pair; body chunks arrive as owned
 * `Uint8Array`s copied out of nghttp3's buffers, so handlers may retain them.
 * Stream ids are the QUIC stream ids as `bigint`. The three optional callbacks
 * fire only when the corresponding nghttp3 events occur, and `onAckedStreamData`
 * / `onShutdown` are also only installed when provided.
 *
 * ```ts no_run
 * import { Nghttp3Session, H3SessionCallbacks } from 'internal:net/http/h3/session';
 *
 * const parts: Uint8Array[] = [];
 * const callbacks: H3SessionCallbacks = {
 *   onBeginHeaders(streamId) {},
 *   onRecvHeader(streamId, token, name, value) {
 *     if (name === ':status') console.log('status', value);
 *   },
 *   onEndHeaders(streamId, fin) {},
 *   onBeginTrailers(streamId) {},
 *   onRecvTrailer(streamId, token, name, value) {},
 *   onEndTrailers(streamId, fin) {},
 *   onRecvData(streamId, data) { parts.push(data); },
 *   onEndStream(streamId) { console.log('body complete'); },
 *   onStreamClose(streamId, appErrorCode) {},
 *   onResetStream(streamId, appErrorCode) {},
 * };
 * const session = Nghttp3Session.createClient(callbacks);
 * ```
 */
export interface H3SessionCallbacks {
  /** Start of a request or response header block on `streamId`. */
  onBeginHeaders(streamId: bigint): void;
  /**
   * One decoded header field. `token` is the QPACK static-table token (or a
   * negative value for dynamic fields), `name` is lowercased (pseudo-headers
   * keep their leading colon), and `flags` carries nghttp3 header flags.
   */
  onRecvHeader(streamId: bigint, token: number, name: string, value: string, flags: number): void;
  /** Header block complete; `fin` is true when the peer also ended the stream. */
  onEndHeaders(streamId: bigint, fin: boolean): void;
  /** Start of a trailer block on `streamId`, after the body. */
  onBeginTrailers(streamId: bigint): void;
  /** One decoded trailer field; same shape as `onRecvHeader`. */
  onRecvTrailer(streamId: bigint, token: number, name: string, value: string, flags: number): void;
  /** Trailer block complete; `fin` is true when the peer also ended the stream. */
  onEndTrailers(streamId: bigint, fin: boolean): void;
  /** A body chunk arrived, copied into an owned `Uint8Array` the handler may keep. */
  onRecvData(streamId: bigint, data: Uint8Array): void;
  /** The peer sent FIN on `streamId`; no more body or trailers will arrive. */
  onEndStream(streamId: bigint): void;
  /**
   * The stream finished, cleanly or with an application error. Fires after the
   * session has already dropped its per-stream bookkeeping for `streamId`.
   */
  onStreamClose(streamId: bigint, appErrorCode: bigint): void;
  /** The peer sent RESET_STREAM; the stream is aborted with `appErrorCode`. */
  onResetStream(streamId: bigint, appErrorCode: bigint): void;
  /**
   * Optional. nghttp3 acknowledged `datalen` bytes of previously submitted body
   * on `streamId` and no longer needs them retained. Only installed when
   * provided; used by drivers that pace or account for outbound body bytes.
   */
  onAckedStreamData?(streamId: bigint, datalen: bigint): void;
  /**
   * Optional. The peer sent GOAWAY; `streamId` is the first client-initiated
   * bidirectional stream the server will not process. Streams at or above it
   * should be treated as retryable.
   */
  onShutdown?(streamId: bigint): void;
  /**
   * Optional. The peer's HTTP/3 SETTINGS were received (or, for WebTransport,
   * decoded from the control-stream prefix). The map is keyed by SETTINGS
   * identifier. May fire more than once as settings are merged.
   */
  onRecvSettings?(settings: ReadonlyMap<number, number>): void;
  /** Optional. One origin entry from an RFC 9412 ORIGIN frame. */
  onRecvOrigin?(origin: string): void;
  /** Optional. The current RFC 9412 ORIGIN frame was completely processed. */
  onEndOrigin?(): void;
}
/**
 * Accepted shapes for a request or response body passed to a submit call.
 *
 * A single `Uint8Array` is sent as one complete body. An async iterable is
 * pulled lazily, one chunk at a time, so the producer only advances as nghttp3
 * drains what it has already framed — this is how outbound backpressure reaches
 * a streaming source. Iterable chunks may be `Uint8Array` or `ArrayBuffer`;
 * empty chunks are skipped.
 */
export type H3BodySource = Uint8Array | AsyncIterable<Uint8Array | ArrayBuffer>;
/**
 * Options for creating a session with `createServer` / `createClient`.
 *
 * ```ts no_run
 * import { Nghttp3Session } from 'internal:net/http/h3/session';
 *
 * const session = Nghttp3Session.createServer(callbacks, { webTransport: true });
 * ```
 */
export interface H3SessionOptions {
  /**
   * Enable WebTransport over HTTP/3. When true the session advertises the
   * extended-CONNECT and H3-datagram SETTINGS and performs WebTransport
   * SETTINGS negotiation on the control stream. Defaults to false.
   */
  webTransport?: boolean;
  /**
   * Maximum decoded size accepted for each header or trailer section, using
   * RFC 9114's name bytes + value bytes + 32 bytes per field accounting.
   * Advertised to the peer and enforced by the client/server drivers. Defaults
   * to 64 KiB.
   */
  maxFieldSectionSize?: number;
  /** Maximum QPACK decoder dynamic-table capacity in bytes. Defaults to libnghttp3's 4 KiB. */
  qpackMaxTableCapacity?: number;
  /** Maximum QPACK encoder dynamic-table capacity in bytes. Defaults to libnghttp3's 4 KiB. */
  qpackEncoderMaxTableCapacity?: number;
  /** Maximum number of streams allowed to block on QPACK state. Defaults to libnghttp3's 100. */
  qpackBlockedStreams?: number;
  /** Normalized HTTPS origins to advertise from a server in an RFC 9412 ORIGIN frame. */
  origins?: string[];
}
/** Default maximum decoded size of one HTTP field section. @internal */
export const DEFAULT_MAX_FIELD_SECTION_SIZE = 64 * 1024;
const _fieldEncoder = new _TextEncoder();
/** Return RFC 9114 field-list accounting for one decoded field. @internal */
export function h3FieldSize(name: string, value: string): number {
  return _fieldEncoder.encode(name).byteLength + _fieldEncoder.encode(value).byteLength + 32;
}
function checkedSetting(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return BigInt(value);
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
const EMPTY_BYTES = new Uint8Array(0);
const _PTR_STREAM_ID = 1;
const _PTR_FIN = 2;
const _PTR_VEC = 3;
const _PTR_NV = 4;
const _PTR_DR = 5;
const _PTR_TRAILERS = 6;
function nameForQpackToken(token: number): string | null {
  switch (token) {
    case 0:
      return ':authority';
    case 1:
      return ':method';
    case 8:
      return ':path';
    case 9:
      return ':scheme';
    case 11:
      return ':status';
    case 25:
      return 'accept';
    case 27:
      return 'accept-encoding';
    case 28:
      return 'accept-language';
    case 45:
      return 'authorization';
    case 55:
      return 'content-length';
    case 57:
      return 'content-type';
    case 68:
      return 'cookie';
    case 91:
      return 'user-agent';
    case 1e3:
      return 'host';
    case 1001:
      return 'connection';
    case 1002:
      return 'keep-alive';
    case 1003:
      return 'proxy-connection';
    case 1004:
      return 'transfer-encoding';
    case 1005:
      return 'upgrade';
    case 1006:
      return 'te';
    case 1007:
      return ':protocol';
    default:
      return null;
  }
}
function protoSettingsToMap(settingsPtr: ArrayBuffer | null): Map<number, number> {
  const settings = new Map<number, number>();
  if (settingsPtr === null) return settings;
  settings.set(0x06, Number(Pointer.readU64(settingsPtr, PROTO_SETTINGS_MAX_FIELD_SECTION_SIZE)));
  settings.set(
    0x01,
    Number(Pointer.readU64(settingsPtr, PROTO_SETTINGS_QPACK_MAX_DTABLE_CAPACITY)),
  );
  settings.set(0x07, Number(Pointer.readU64(settingsPtr, PROTO_SETTINGS_QPACK_BLOCKED_STREAMS)));
  settings.set(
    SETTINGS_ENABLE_CONNECT_PROTOCOL,
    Pointer.readU8(settingsPtr, PROTO_SETTINGS_ENABLE_CONNECT_PROTOCOL) === 0 ? 0 : 1,
  );
  settings.set(
    SETTINGS_H3_DATAGRAM,
    Pointer.readU8(settingsPtr, PROTO_SETTINGS_H3_DATAGRAM) === 0 ? 0 : 1,
  );
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
/**
 * A single HTTP/3 connection backed by a native `nghttp3_conn`.
 *
 * Instances are created through the `createServer` / `createClient` static
 * factories, never with `new` — the constructor is private because it must
 * install the native callback and data-reader structs before the connection is
 * usable. A session owns native resources and must be released with `close()`
 * (or `using`, via `Symbol.dispose`) when the QUIC connection goes away.
 *
 * A driver uses a session in three overlapping roles: it submits outbound
 * requests or responses (`submitRequest` / `submitResponse` / `submitTrailers`),
 * feeds inbound QUIC stream bytes with `receiveStreamData()` and `endStream()`, and lets `drainWrites()`
 * hand nghttp3's framed output to the per-stream writers registered with
 * `addQuicStream()`. Decoded HTTP events surface through the `H3SessionCallbacks`
 * passed at creation.
 *
 * ```ts no_run
 * import { Nghttp3Session } from 'internal:net/http/h3/session';
 *
 * using session = Nghttp3Session.createClient(callbacks);
 * session.bindControlStream(controlStreamId);
 * session.bindQpackStreams(qpackEncoderStreamId, qpackDecoderStreamId);
 * session.addQuicStream(controlStreamId, controlWriter);
 * session.addQuicStream(requestStreamId, requestWriter);
 * session.submitRequest(requestStreamId, [
 *   [':method', 'GET'], [':scheme', 'https'],
 *   [':authority', 'example.com'], [':path', '/'],
 * ]);
 * session.drainWrites();
 * ```
 */
export class Nghttp3Session {
  #conn: ArrayBuffer;
  #callbacks: Array<{
    close(): void;
  }> = [];
  #cbsBuf: Uint8Array;
  #drBuf: Uint8Array;
  #ptrArena = new ArrayBuffer(_PTR_SIZE * 8);
  #ptrSlots = Array.from(
    { length: 8 },
    (_, i) => new Uint8Array(this.#ptrArena, i * _PTR_SIZE, _PTR_SIZE),
  );
  #writeStreamIdBuf = new ArrayBuffer(8);
  #writeStreamIdView = new DataView(this.#writeStreamIdBuf);
  #writeFinBuf = new ArrayBuffer(4);
  #writeFinView = new DataView(this.#writeFinBuf);
  #writeVecBuf = new Uint8Array(_VEC_BUF_SIZE);
  #writeVecView = new DataView(this.#writeVecBuf.buffer);
  #vecAddrBuf = new ArrayBuffer(8);
  #vecAddrView = new DataView(this.#vecAddrBuf);
  #bodySlots = new Map<bigint, BodySlot>();
  #pendingTrailers = new Map<bigint, Array<[string, string]>>();
  #yieldedBytes = new Map<bigint, Uint8Array>();
  #webTransportSettingsPrefixes = new Map<bigint, Uint8Array>();
  #quicStreams = new Map<
    bigint,
    {
      writer: {
        write(b: Uint8Array): Promise<void>;
        writeSync?(b: Uint8Array, owned?: boolean): void;
        close(): Promise<void>;
        closeSync?(): void;
      };
    }
  >();
  #closed = false;
  #ready = false;
  #shutdownStarted = false;
  #shutdownNoticeSent = false;
  #drainPromise: Promise<void> | null = null;
  #resolveDrained: (() => void) | null = null;
  #drainCheckScheduled = false;
  #remoteEndedStreams = new Set<bigint>();
  #localEndedStreams = new Set<bigint>();
  #qpackStreamsBound = false;
  #locked = false;
  #localSettings = new Map<number, number>();
  #peerSettings = new Map<number, number>();
  #peerSettingsReceived = false;
  #webTransport = false;
  #originPayload: Uint8Array | null = null;
  #originVec: Uint8Array | null = null;
  #controlStreamId: bigint | null = null;
  readonly #isServer: boolean;
  readonly #cb: H3SessionCallbacks;
  private constructor(
    conn: ArrayBuffer,
    cbsBuf: Uint8Array,
    drBuf: Uint8Array,
    cb: H3SessionCallbacks,
    isServer: boolean,
  ) {
    this.#conn = conn;
    this.#cbsBuf = cbsBuf;
    this.#drBuf = drBuf;
    this.#cb = cb;
    this.#isServer = isServer;
  }
  #ptrOf(source: ArrayBuffer | ArrayBufferView, slot: number): Uint8Array {
    Pointer.of(source, this.#ptrArena, slot * _PTR_SIZE);
    return this.#ptrSlots[slot]!;
  }
  /**
   * Create a server-side session, whose peer is an HTTP/3 client.
   *
   * Allocates and initializes a new `nghttp3_conn` in server mode and installs
   * the callbacks in `cb`. Throws if libnghttp3 could not be loaded on this
   * platform.
   *
   * ```ts no_run
   * import { Nghttp3Session } from 'internal:net/http/h3/session';
   *
   * const session = Nghttp3Session.createServer({
   *   onBeginHeaders(streamId) {},
   *   onRecvHeader(streamId, token, name, value) {},
   *   onEndHeaders(streamId, fin) {
   *     session.submitResponse(streamId, [[':status', '204']]);
   *     session.drainWrites();
   *   },
   *   onBeginTrailers(streamId) {},
   *   onRecvTrailer(streamId, token, name, value) {},
   *   onEndTrailers(streamId, fin) {},
   *   onRecvData(streamId, data) {},
   *   onEndStream(streamId) {},
   *   onStreamClose(streamId, appErrorCode) {},
   *   onResetStream(streamId, appErrorCode) {},
   * });
   * ```
   */
  static createServer(cb: H3SessionCallbacks, options: H3SessionOptions = {}): Nghttp3Session {
    if (!h3Available || sym === null) throw new Error('libnghttp3 is not available');
    return Nghttp3Session.#create(cb, true, options);
  }
  /**
   * Create a client-side session, whose peer is an HTTP/3 server.
   *
   * Allocates and initializes a new `nghttp3_conn` in client mode and installs
   * the callbacks in `cb`. Throws if libnghttp3 could not be loaded on this
   * platform.
   *
   * ```ts no_run
   * import { Nghttp3Session } from 'internal:net/http/h3/session';
   *
   * const session = Nghttp3Session.createClient(callbacks);
   * session.bindControlStream(controlStreamId);
   * session.bindQpackStreams(qpackEncoderStreamId, qpackDecoderStreamId);
   * ```
   */
  static createClient(cb: H3SessionCallbacks, options: H3SessionOptions = {}): Nghttp3Session {
    if (!h3Available || sym === null) throw new Error('libnghttp3 is not available');
    return Nghttp3Session.#create(cb, false, options);
  }
  static #create(
    cb: H3SessionCallbacks,
    isServer: boolean,
    options: H3SessionOptions,
  ): Nghttp3Session {
    const maxFieldSectionSize = options.maxFieldSectionSize ?? DEFAULT_MAX_FIELD_SECTION_SIZE;
    const maxFieldSectionSizeSetting = checkedSetting('maxFieldSectionSize', maxFieldSectionSize);
    const qpackMaxTableCapacitySetting =
      options.qpackMaxTableCapacity === undefined
        ? null
        : checkedSetting('qpackMaxTableCapacity', options.qpackMaxTableCapacity);
    const qpackEncoderMaxTableCapacitySetting =
      options.qpackEncoderMaxTableCapacity === undefined
        ? null
        : checkedSetting('qpackEncoderMaxTableCapacity', options.qpackEncoderMaxTableCapacity);
    const qpackBlockedStreamsSetting =
      options.qpackBlockedStreams === undefined
        ? null
        : checkedSetting('qpackBlockedStreams', options.qpackBlockedStreams);
    // Allocate the 152-byte callbacks struct (zeroed = null callbacks for unused fields).
    const cbsBuf = new Uint8Array(CB_SIZE);
    // Allocate 8-byte out-param buffer for the conn pointer.
    const connHandle = new ArrayBuffer(8);
    // Create the session object now so #installCallbacks can close over it.
    const drBuf = new Uint8Array(DR_SIZE);
    const session = new Nghttp3Session(connHandle, cbsBuf, drBuf, cb, isServer);
    session.#installCallbacks(cbsBuf);
    session.#installDataReader(drBuf);
    // Fill settings struct with library defaults.
    const settingsBuf = new Uint8Array(SETTINGS_SIZE);
    sym!.nghttp3_settings_default_versioned(NGHTTP3_SETTINGS_VERSION, Pointer.of(settingsBuf));
    const settingsView = new DataView(settingsBuf.buffer);
    settingsView.setBigUint64(SETTINGS_MAX_FIELD_SECTION_SIZE, maxFieldSectionSizeSetting, true);
    if (qpackMaxTableCapacitySetting !== null) {
      settingsView.setBigUint64(
        SETTINGS_QPACK_MAX_DTABLE_CAPACITY,
        qpackMaxTableCapacitySetting,
        true,
      );
    }
    if (qpackEncoderMaxTableCapacitySetting !== null) {
      settingsView.setBigUint64(
        SETTINGS_QPACK_ENCODER_MAX_DTABLE_CAPACITY,
        qpackEncoderMaxTableCapacitySetting,
        true,
      );
    }
    if (qpackBlockedStreamsSetting !== null) {
      settingsView.setBigUint64(SETTINGS_QPACK_BLOCKED_STREAMS, qpackBlockedStreamsSetting, true);
    }
    const localSettings = new Map<number, number>([
      [0x06, maxFieldSectionSize],
      [0x01, Number(settingsView.getBigUint64(SETTINGS_QPACK_MAX_DTABLE_CAPACITY, true))],
      [0x07, Number(settingsView.getBigUint64(SETTINGS_QPACK_BLOCKED_STREAMS, true))],
    ]);
    if (options.webTransport === true) {
      settingsBuf[NGHTTP3_SETTINGS_ENABLE_CONNECT_PROTOCOL] = 1;
      settingsBuf[NGHTTP3_SETTINGS_H3_DATAGRAM] = 1;
      for (const [id, value] of webTransportSettings()) localSettings.set(id, value);
    }
    if (isServer && options.origins !== undefined) {
      const payload = encodeH3OriginList(options.origins);
      const vec = new Uint8Array(VEC_ENTRY_SIZE);
      const vecView = new DataView(vec.buffer);
      vecView.setBigUint64(0, Pointer.addr(payload), true);
      vecView.setBigUint64(8, BigInt(payload.byteLength), true);
      new DataView(settingsBuf.buffer).setBigUint64(SETTINGS_ORIGIN_LIST, Pointer.addr(vec), true);
      session.#originPayload = payload;
      session.#originVec = vec;
    }
    const rc = isServer
      ? (sym!.nghttp3_conn_server_new_versioned(
          Pointer.of(connHandle),
          NGHTTP3_CALLBACKS_VERSION,
          Pointer.of(cbsBuf),
          NGHTTP3_SETTINGS_VERSION,
          Pointer.of(settingsBuf),
          null,
          null,
        ) as number)
      : (sym!.nghttp3_conn_client_new_versioned(
          Pointer.of(connHandle),
          NGHTTP3_CALLBACKS_VERSION,
          Pointer.of(cbsBuf),
          NGHTTP3_SETTINGS_VERSION,
          Pointer.of(settingsBuf),
          null,
          null,
        ) as number);
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
      const ackedStreamData = new FfiCallback(
        {
          parameters: ['ignoredPointer', 'i64', 'usize', 'ignoredPointer', 'ignoredPointer'],
          result: 'i32',
        },
        (_conn: ArrayBuffer, streamId: bigint, datalen: bigint) => {
          cb.onAckedStreamData!(streamId, datalen);
          return 0;
        },
      );
      writeCbPtr(cbsBuf, CB_ACKED_STREAM_DATA, ackedStreamData);
      this.#callbacks.push(ackedStreamData);
    }
    // stream_close: stream finished (cleanly or with error).
    const streamClose = new FfiCallback(
      {
        parameters: ['ignoredPointer', 'i64', 'u64', 'ignoredPointer', 'ignoredPointer'],
        result: 'i32',
      },
      (_conn: ArrayBuffer, streamId: bigint, appErrorCode: bigint) => {
        this.#dropBodySlot(streamId);
        this.#pendingTrailers.delete(streamId);
        this.#yieldedBytes.delete(streamId);
        this.#webTransportSettingsPrefixes.delete(streamId);
        cb.onStreamClose(streamId, appErrorCode);
        this.#scheduleDrainedCheck();
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_STREAM_CLOSE, streamClose);
    this.#callbacks.push(streamClose);
    // recv_data: body chunk arrived on a stream.
    const recvData = new FfiCallback(
      {
        parameters: [
          'ignoredPointer',
          'i64',
          'pointer',
          'usize',
          'ignoredPointer',
          'ignoredPointer',
        ],
        result: 'i32',
      },
      (_conn: ArrayBuffer, streamId: bigint, dataPtr: ArrayBuffer, datalen: bigint) => {
        const bytes = Pointer.copyFrom(dataPtr, Number(datalen)) as Uint8Array;
        cb.onRecvData(streamId, bytes);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RECV_DATA, recvData);
    this.#callbacks.push(recvData);
    // begin_headers: start of a request or response header block.
    const beginHeaders = new FfiCallback(
      {
        parameters: ['ignoredPointer', 'i64', 'ignoredPointer', 'ignoredPointer'],
        result: 'i32',
      },
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
      {
        parameters: [
          'ignoredPointer',
          'i64',
          'i32',
          'pointer',
          'pointer',
          'u8',
          'ignoredPointer',
          'ignoredPointer',
        ],
        result: 'i32',
      },
      (
        _conn: ArrayBuffer,
        streamId: bigint,
        token: number,
        nameRcbuf: ArrayBuffer,
        valueRcbuf: ArrayBuffer,
        flags: number,
      ) => {
        const name = nameForQpackToken(token) ?? readRcbuf(nameRcbuf);
        const value = readRcbuf(valueRcbuf);
        cb.onRecvHeader(streamId, token, name, value, flags);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RECV_HEADER, recvHeader);
    this.#callbacks.push(recvHeader);
    // end_headers: header block complete.
    const endHeaders = new FfiCallback(
      {
        parameters: ['ignoredPointer', 'i64', 'i32', 'ignoredPointer', 'ignoredPointer'],
        result: 'i32',
      },
      (_conn: ArrayBuffer, streamId: bigint, fin: number) => {
        cb.onEndHeaders(streamId, fin !== 0);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_END_HEADERS, endHeaders);
    this.#callbacks.push(endHeaders);
    // begin_trailers / recv_trailer / end_trailers — same shapes as headers.
    const beginTrailers = new FfiCallback(
      {
        parameters: ['ignoredPointer', 'i64', 'ignoredPointer', 'ignoredPointer'],
        result: 'i32',
      },
      (_conn: ArrayBuffer, streamId: bigint) => {
        cb.onBeginTrailers(streamId);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_BEGIN_TRAILERS, beginTrailers);
    this.#callbacks.push(beginTrailers);
    const recvTrailer = new FfiCallback(
      {
        parameters: [
          'ignoredPointer',
          'i64',
          'i32',
          'pointer',
          'pointer',
          'u8',
          'ignoredPointer',
          'ignoredPointer',
        ],
        result: 'i32',
      },
      (
        _conn: ArrayBuffer,
        streamId: bigint,
        token: number,
        nameRcbuf: ArrayBuffer,
        valueRcbuf: ArrayBuffer,
        flags: number,
      ) => {
        cb.onRecvTrailer(
          streamId,
          token,
          nameForQpackToken(token) ?? readRcbuf(nameRcbuf),
          readRcbuf(valueRcbuf),
          flags,
        );
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RECV_TRAILER, recvTrailer);
    this.#callbacks.push(recvTrailer);
    const endTrailers = new FfiCallback(
      {
        parameters: ['ignoredPointer', 'i64', 'i32', 'ignoredPointer', 'ignoredPointer'],
        result: 'i32',
      },
      (_conn: ArrayBuffer, streamId: bigint, fin: number) => {
        cb.onEndTrailers(streamId, fin !== 0);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_END_TRAILERS, endTrailers);
    this.#callbacks.push(endTrailers);
    // end_stream: FIN received on the stream.
    const endStream = new FfiCallback(
      {
        parameters: ['ignoredPointer', 'i64', 'ignoredPointer', 'ignoredPointer'],
        result: 'i32',
      },
      (_conn: ArrayBuffer, streamId: bigint) => {
        cb.onEndStream(streamId);
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_END_STREAM, endStream);
    this.#callbacks.push(endStream);
    // reset_stream: remote sent RESET_STREAM.
    const resetStream = new FfiCallback(
      {
        parameters: ['ignoredPointer', 'i64', 'u64', 'ignoredPointer', 'ignoredPointer'],
        result: 'i32',
      },
      (_conn: ArrayBuffer, streamId: bigint, appErrorCode: bigint) => {
        this.#dropBodySlot(streamId);
        this.#pendingTrailers.delete(streamId);
        this.#yieldedBytes.delete(streamId);
        this.#webTransportSettingsPrefixes.delete(streamId);
        cb.onResetStream(streamId, appErrorCode);
        this.#scheduleDrainedCheck();
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RESET_STREAM, resetStream);
    this.#callbacks.push(resetStream);
    if (cb.onShutdown) {
      const shutdown = new FfiCallback(
        {
          parameters: ['ignoredPointer', 'i64', 'ignoredPointer'],
          result: 'i32',
        },
        (_conn: ArrayBuffer, id: bigint) => {
          cb.onShutdown!(id);
          return 0;
        },
      );
      writeCbPtr(cbsBuf, CB_SHUTDOWN, shutdown);
      this.#callbacks.push(shutdown);
    }
    if (cb.onRecvOrigin) {
      const recvOrigin = new FfiCallback(
        {
          parameters: ['ignoredPointer', 'pointer', 'usize', 'ignoredPointer'],
          result: 'i32',
        },
        (_conn: ArrayBuffer, originPtr: ArrayBuffer, originLength: bigint) => {
          const bytes = Pointer.copyFrom(originPtr, Number(originLength)) as Uint8Array;
          cb.onRecvOrigin!(new _TextDecoder().decode(bytes));
          return 0;
        },
      );
      writeCbPtr(cbsBuf, CB_RECV_ORIGIN, recvOrigin);
      this.#callbacks.push(recvOrigin);
    }
    if (cb.onEndOrigin) {
      const endOrigin = new FfiCallback(
        { parameters: ['ignoredPointer', 'ignoredPointer'], result: 'i32' },
        () => {
          cb.onEndOrigin!();
          return 0;
        },
      );
      writeCbPtr(cbsBuf, CB_END_ORIGIN, endOrigin);
      this.#callbacks.push(endOrigin);
    }
    const recvSettings2 = new FfiCallback(
      {
        parameters: ['ignoredPointer', 'pointer', 'ignoredPointer'],
        result: 'i32',
      },
      (_conn: ArrayBuffer, settingsPtr: ArrayBuffer | null) => {
        this.#recordPeerSettings(protoSettingsToMap(settingsPtr));
        return 0;
      },
    );
    writeCbPtr(cbsBuf, CB_RECV_SETTINGS2, recvSettings2);
    this.#callbacks.push(recvSettings2);
  }
  // Shared read_data callback for all response body submissions.
  #installDataReader(drBuf: Uint8Array): void {
    const readData = new FfiCallback(
      {
        parameters: [
          'ignoredPointer',
          'i64',
          'pointer',
          'usize',
          'pointer',
          'ignoredPointer',
          'ignoredPointer',
        ],
        result: 'isize',
      },
      (
        _conn: ArrayBuffer,
        streamId: bigint,
        vecBuf: ArrayBuffer,
        _veccnt: bigint,
        pflagsPtr: ArrayBuffer,
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
  /**
   * Bind the local outgoing HTTP/3 control stream, once, during startup.
   *
   * `controlStreamId` must be a freshly opened unidirectional QUIC stream. This
   * also marks the session ready, so `closeWhenIdle()` will send GOAWAY. Call
   * before submitting any request or response, and register the same stream's
   * writer with `addQuicStream()` so the control frames can be flushed. Throws
   * if nghttp3 rejects the binding.
   *
   * ```ts no_run
   * session.bindControlStream(controlStreamId);
   * session.addQuicStream(controlStreamId, controlWriter);
   * ```
   */
  bindControlStream(controlStreamId: bigint): void {
    const rc = sym!.nghttp3_conn_bind_control_stream(this.#conn, controlStreamId) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_bind_control_stream failed: ${rc}`);
    this.#controlStreamId = controlStreamId;
    this.#ready = true;
  }
  /**
   * Bind the local QPACK encoder and decoder streams, once, during startup.
   *
   * Both must be freshly opened unidirectional QUIC streams. Until this is
   * called, `submitRequest` and `submitResponse` throw, since QPACK cannot
   * encode headers without its streams. Throws if nghttp3 rejects the binding.
   *
   * ```ts no_run
   * session.bindQpackStreams(qpackEncoderStreamId, qpackDecoderStreamId);
   * ```
   */
  bindQpackStreams(qencId: bigint, qdecId: bigint): void {
    const rc = sym!.nghttp3_conn_bind_qpack_streams(this.#conn, qencId, qdecId) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_bind_qpack_streams failed: ${rc}`);
    this.#qpackStreamsBound = true;
  }
  /**
   * Register the QUIC writer for a stream so `drainWrites()` can flush to it.
   *
   * Call once per QUIC stream the driver opens or accepts — control, QPACK, and
   * every request/response stream — before draining writes for that stream. The
   * writer must expose `writeSync` and `closeSync`, which the synchronous write
   * drain uses; the async `write`/`close` are used by async body pulling. The
   * session drops the entry automatically when the stream closes or resets.
   *
   * ```ts no_run
   * session.addQuicStream(requestStreamId, requestStream.writer);
   * ```
   */
  // Register a QUIC stream writer so drainWrites can write to it.
  addQuicStream(
    streamId: bigint,
    writer: {
      write(b: Uint8Array): Promise<void>;
      writeSync?(b: Uint8Array, owned?: boolean): void;
      close(): Promise<void>;
      closeSync?(): void;
    },
  ): void {
    this.#quicStreams.set(streamId, { writer });
  }
  // -------------------------------------------------------------------------
  // Submit operations — synchronous; safe to call on the JS thread.
  // -------------------------------------------------------------------------
  /**
   * Queue an HTTP/3 response on a request stream (server sessions).
   *
   * `headers` must start with the `:status` pseudo-header. `body` may be omitted
   * (empty response), a single `Uint8Array`, or an async iterable pulled lazily.
   * `trailers` are sent after the body; passing trailers with no body sends an
   * empty body so the trailer block has a stream to follow. Nothing goes on the
   * wire until the next `drainWrites()`.
   *
   * Throws if the session is closed or its QPACK streams are not yet bound, or
   * if nghttp3 rejects the submission.
   *
   * ```ts no_run
   * session.submitResponse(streamId,
   *   [[':status', '200'], ['content-type', 'text/plain']],
   *   new TextEncoder().encode('hello'));
   * session.drainWrites();
   * ```
   */
  submitResponse(
    streamId: bigint,
    headers: Array<[string, string]>,
    body?: H3BodySource,
    trailers?: Array<[string, string]>,
  ): void {
    if (this.#closed) throw new Error('session closed');
    if (!this.#qpackStreamsBound) throw new Error('H3 session QPACK streams are not bound');
    const { buf: nvBuf, nv } = buildNvArray(headers);
    const effectiveBody = body === undefined && trailers !== undefined ? new Uint8Array(0) : body;
    const drPtr = effectiveBody !== undefined ? this.#ptrOf(this.#drBuf, _PTR_DR) : null;
    if (effectiveBody !== undefined) {
      this.#bodySlots.set(streamId, this.#makeBodySlot(effectiveBody, trailers));
    }
    const rc = sym!.nghttp3_conn_submit_response(
      this.#conn,
      streamId,
      this.#ptrOf(nvBuf, _PTR_NV),
      nv,
      drPtr,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_response failed: ${rc}`);
  }
  /** Queue a non-final 1xx response field section on a server request stream. */
  submitInformational(streamId: bigint, headers: Array<[string, string]>): void {
    if (this.#closed) throw new Error('session closed');
    if (!this.#qpackStreamsBound) throw new Error('H3 session QPACK streams are not bound');
    const { buf: nvBuf, nv } = buildNvArray(headers);
    const rc = sym!.nghttp3_conn_submit_info(
      this.#conn,
      streamId,
      this.#ptrOf(nvBuf, _PTR_NV),
      nv,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_info failed: ${rc}`);
  }
  /**
   * Queue an HTTP/3 request on a client-opened stream (client sessions).
   *
   * `headers` must include the `:method`, `:scheme`, `:authority`, and `:path`
   * pseudo-headers. `body` and `trailers` behave exactly as in `submitResponse`.
   * Nothing goes on the wire until the next `drainWrites()`.
   *
   * Throws if the session is closed or its QPACK streams are not yet bound, or
   * if nghttp3 rejects the submission.
   *
   * ```ts no_run
   * session.submitRequest(streamId, [
   *   [':method', 'POST'], [':scheme', 'https'],
   *   [':authority', 'example.com'], [':path', '/upload'],
   * ], new TextEncoder().encode('payload'));
   * session.drainWrites();
   * ```
   */
  submitRequest(
    streamId: bigint,
    headers: Array<[string, string]>,
    body?: H3BodySource,
    trailers?: Array<[string, string]>,
  ): void {
    if (this.#closed) throw new Error('session closed');
    if (!this.#qpackStreamsBound) throw new Error('H3 session QPACK streams are not bound');
    const { buf: nvBuf, nv } = buildNvArray(headers);
    const effectiveBody = body === undefined && trailers !== undefined ? new Uint8Array(0) : body;
    const drPtr = effectiveBody !== undefined ? this.#ptrOf(this.#drBuf, _PTR_DR) : null;
    if (effectiveBody !== undefined) {
      this.#bodySlots.set(streamId, this.#makeBodySlot(effectiveBody, trailers));
    }
    const rc = sym!.nghttp3_conn_submit_request(
      this.#conn,
      streamId,
      this.#ptrOf(nvBuf, _PTR_NV),
      nv,
      drPtr,
      null,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_request failed: ${rc}`);
  }
  /**
   * Queue a trailer block on a stream whose body has already been sent.
   *
   * Use this to send trailers out of band — when the trailer set is only known
   * after the body was submitted without a `trailers` argument. Trailers passed
   * to `submitRequest`/`submitResponse` are handled internally and do not need
   * this call. Nothing goes on the wire until the next `drainWrites()`.
   *
   * Throws if the session is closed or nghttp3 rejects the submission.
   *
   * ```ts no_run
   * session.submitTrailers(streamId, [['x-checksum', 'a1b2c3']]);
   * session.drainWrites();
   * ```
   */
  submitTrailers(streamId: bigint, trailers: Array<[string, string]>): void {
    if (this.#closed) throw new Error('session closed');
    const { buf: nvBuf, nv } = buildNvArray(trailers);
    const rc = sym!.nghttp3_conn_submit_trailers(
      this.#conn,
      streamId,
      this.#ptrOf(nvBuf, _PTR_NV),
      nv,
    ) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_trailers failed: ${rc}`);
  }
  /**
   * Cancel one request stream without closing the HTTP/3 connection.
   *
   * Drops any pending request-body producer (calling its async iterator's
   * `return()` hook when available), clears per-stream write state, and tells
   * nghttp3 that the stream ended with `H3_REQUEST_CANCELLED`. The QUIC driver
   * remains responsible for sending `STOP_SENDING` and `RESET_STREAM` on the
   * transport stream itself.
   *
   * This method is idempotent from the caller's perspective: cancellation of a
   * stream nghttp3 has already removed is ignored.
   *
   * @internal
   */
  cancelStream(streamId: bigint, errorCode: bigint = NGHTTP3_H3_REQUEST_CANCELLED): void {
    if (this.#closed) return;
    this.#dropBodySlot(streamId);
    this.#pendingTrailers.delete(streamId);
    this.#yieldedBytes.delete(streamId);
    this.#webTransportSettingsPrefixes.delete(streamId);
    this.#quicStreams.delete(streamId);
    // nghttp3 reports an error if the stream has already reached its terminal
    // callback. There is no further state to release in that case.
    this.#closeStream(streamId, errorCode);
  }
  #dropBodySlot(streamId: bigint): void {
    const slot = this.#bodySlots.get(streamId);
    if (slot === undefined) return;
    this.#bodySlots.delete(streamId);
    if (slot.iterator?.return !== undefined) {
      void Promise.resolve(slot.iterator.return()).catch(() => {});
    }
  }
  #makeBodySlot(body: H3BodySource, trailers?: Array<[string, string]>): BodySlot {
    if (body instanceof Uint8Array) {
      return {
        bytes: body,
        iterator: null,
        pulling: false,
        done: true,
        error: null,
        trailers,
      };
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
    Promise.resolve(slot.iterator.next()).then(
      (result) => {
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
      },
      (error) => {
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
      },
    );
  }
  // -------------------------------------------------------------------------
  // Read: feed QUIC stream bytes into nghttp3.
  // -------------------------------------------------------------------------
  /**
   * Feed bytes present on an inbound QUIC stream into nghttp3 for decoding.
   *
   * Completion is a separate control operation expressed through `endStream()`;
   * `data` must therefore contain at least one byte. nghttp3 drives the registered
   * `H3SessionCallbacks` synchronously, then the session drains any writes the
   * decode produced, such as QPACK acknowledgements.
   *
   * A malformed HTTP header or message closes just the offending stream; any
   * other nghttp3 error closes the whole session. Either way the underlying
   * error is thrown. Throws immediately if the session is closed, if `data` is
   * empty, or if called re-entrantly during another session operation.
   */
  receiveStreamData(streamId: bigint, data: Uint8Array): void {
    if (data.byteLength === 0) throw new TypeError('stream data must not be empty');
    this.#receiveStreamInput(streamId, data, false);
  }

  /**
   * Signal clean completion of an inbound QUIC stream to nghttp3.
   *
   * This is the control counterpart to `receiveStreamData()`. It carries no
   * bytes and maps the channel's done state to the QUIC FIN expected by nghttp3.
   * Throws immediately if the session is closed or if called re-entrantly during
   * another session operation.
   */
  endStream(streamId: bigint): void {
    this.#receiveStreamInput(streamId, EMPTY_BYTES, true);
  }

  #receiveStreamInput(streamId: bigint, data: Uint8Array, fin: boolean): void {
    if (this.#locked) throw new Error('nghttp3 session operation re-entered');
    if (this.#closed) throw new Error('session closed');
    this.#locked = true;
    try {
      // nghttp3 only considers a request stream closed after the transport tells
      // it that both QUIC directions have ended. Remember the remote FIN before
      // draining because that drain may synchronously produce our local FIN.
      if (fin && (streamId & 2n) === 0n) this.#remoteEndedStreams.add(streamId);
      if (this.#webTransport && data.byteLength > 0) {
        const buffered = this.#bufferWebTransportSettingsPrefix(streamId, data);
        const settings = readWebTransportSettings(buffered);
        if (settings.size > 0) {
          this.#webTransportSettingsPrefixes.delete(streamId);
          this.#recordPeerSettings(settings);
        }
      }
      const ts = BigInt(Math.floor(performance.now() * 1e6));
      const consumed = sym!.nghttp3_conn_read_stream2(
        this.#conn,
        streamId,
        this.#ptrOf(data, _PTR_DATA),
        data.byteLength,
        fin ? 1 : 0,
        ts,
      ) as number;
      if (consumed < 0) {
        const isStreamError =
          consumed === NGHTTP3_ERR_MALFORMED_HTTP_HEADER ||
          consumed === NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING;
        if (isStreamError) {
          this.#closeStream(streamId, NGHTTP3_H3_MESSAGE_ERROR);
        } else {
          this.close();
        }
        throw new Error(`nghttp3_conn_read_stream2 error: ${consumed}`);
      }
      this.#drainWritesInnerSync();
      this.#closeFullyEndedStream(streamId);
    } finally {
      this.#locked = false;
    }
  }
  // -------------------------------------------------------------------------
  // Write drain: pull nghttp3 output and push to QUIC streams.
  // -------------------------------------------------------------------------
  /**
   * Pull all pending nghttp3 output and write it to the QUIC stream writers.
   *
   * Repeatedly asks nghttp3 for framed bytes and hands each stream's output to
   * the writer registered with `addQuicStream()` via `writeSync`, reporting the
   * consumed length back to nghttp3, until nothing is left to write. Also
   * flushes any trailers that a streaming body deferred, and closes streams
   * whose FIN has been produced. Call after every submit and after any async
   * body chunk becomes available; the read path also drains automatically.
   *
   * If the writer for a stream is missing, its queued data is dropped and the
   * stream is cancelled so nghttp3 does not stall. Closes the session and throws
   * on a fatal nghttp3 error. Throws immediately if the session is closed, or if
   * called re-entrantly while another session operation is on the stack.
   *
   * ```ts no_run
   * session.submitResponse(streamId, [[':status', '200']]);
   * session.drainWrites();
   * ```
   */
  drainWrites(): void {
    if (this.#locked) throw new Error('nghttp3 session operation re-entered');
    if (this.#closed) throw new Error('session closed');
    this.#locked = true;
    try {
      this.#drainWritesInnerSync();
    } finally {
      this.#locked = false;
    }
  }
  #copyVecBytesInto(dest: Uint8Array, baseAddr: bigint, vecLen: number): void {
    this.#vecAddrView.setBigUint64(0, baseAddr, true);
    Pointer.copyFromInto(dest, this.#vecAddrBuf, vecLen);
  }
  #drainWritesInnerSync(): void {
    const pStreamId = this.#writeStreamIdBuf;
    const pfin = this.#writeFinBuf;
    const vecBuf = this.#writeVecBuf;
    const dvVec = this.#writeVecView;
    while (true) {
      this.#writeStreamIdView.setBigInt64(0, -1n, true);
      const n = sym!.nghttp3_conn_writev_stream(
        this.#conn,
        this.#ptrOf(pStreamId, _PTR_STREAM_ID),
        this.#ptrOf(pfin, _PTR_FIN),
        this.#ptrOf(vecBuf, _PTR_VEC),
        _MAX_VECS,
      ) as number;
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
          const trc = sym!.nghttp3_conn_submit_trailers(
            this.#conn,
            tsid,
            this.#ptrOf(buf, _PTR_TRAILERS),
            nv,
          ) as number;
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
            this.#closeStream(sid, NGHTTP3_H3_REQUEST_CANCELLED);
          } else {
            // FIN-only frame, writer already gone — advance by 0 so nghttp3 releases
            // its internal stream state instead of leaving a stale entry.
            sym!.nghttp3_conn_add_write_offset(this.#conn, sid, 0);
          }
          continue;
        }
        let consumed = 0;
        if (totalBytes > 0 && entry) {
          // Copy nghttp3's vecs once into a fresh, owned buffer. Handing an owned
          // buffer to writeSync lets it skip its defensive slice(), so the body
          // bytes are copied once here instead of twice (was: copy to reused
          // scratch, then writeSync slices).
          let outgoing = new Uint8Array(totalBytes);
          if (nonEmptyVecs === 1) {
            this.#copyVecBytesInto(outgoing, singleBaseAddr, singleVecLen);
          } else {
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
          entry.writer.writeSync(outgoing, true);
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
          if ((sid & 2n) === 0n) this.#localEndedStreams.add(sid);
          this.#quicStreams.delete(sid);
          this.#closeFullyEndedStream(sid);
        }
      }
    }
  }
  #closeFullyEndedStream(streamId: bigint): void {
    if (!this.#remoteEndedStreams.has(streamId) || !this.#localEndedStreams.has(streamId)) {
      return;
    }
    this.#remoteEndedStreams.delete(streamId);
    this.#localEndedStreams.delete(streamId);
    this.#closeStream(streamId, NGHTTP3_H3_NO_ERROR);
  }
  #closeStream(streamId: bigint, errorCode: bigint): void {
    sym!.nghttp3_conn_close_stream(this.#conn, streamId, errorCode);
    this.#scheduleDrainedCheck();
  }
  // -------------------------------------------------------------------------
  // Mutex helper
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  /** True once the session has been closed and its native resources freed. */
  get isClosed(): boolean {
    return this.#closed;
  }
  /**
   * A copy of the HTTP/3 SETTINGS this session advertises to the peer, keyed by
   * SETTINGS identifier. Populated with WebTransport settings when the session
   * was created with `webTransport: true`.
   */
  get localSettings(): ReadonlyMap<number, number> {
    return new Map(this.#localSettings);
  }
  /**
   * A copy of the peer's HTTP/3 SETTINGS as received so far, keyed by SETTINGS
   * identifier. Empty until `peerSettingsReceived` is true; may grow as further
   * settings are merged.
   */
  get peerSettings(): ReadonlyMap<number, number> {
    return new Map(this.#peerSettings);
  }
  /** True once the peer's SETTINGS have been received at least once. */
  get peerSettingsReceived(): boolean {
    return this.#peerSettingsReceived;
  }
  /**
   * True when the peer's received SETTINGS enable WebTransport (extended CONNECT
   * plus H3 datagrams), meaning WebTransport CONNECT streams may be opened.
   */
  get peerWebTransportReady(): boolean {
    return webTransportSettingsEnabled(this.#peerSettings);
  }
  /**
   * Inject peer SETTINGS directly, bypassing the wire, for tests that need to
   * exercise settings-dependent behavior without a live control stream. Not for
   * production use.
   */
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
    if (
      !this.#webTransport ||
      streamId !== this.#controlStreamId ||
      !this.#localSettings.has(SETTINGS_WT_ENABLED)
    ) {
      return bytes;
    }
    return injectWebTransportSettings(bytes);
  }
  /**
   * Begin a graceful shutdown, then close the session.
   *
   * If the session is ready (its control stream is bound), this sends an HTTP/3
   * GOAWAY via `nghttp3_conn_shutdown` and drains it to the wire so the peer
   * learns which stream ids will still be serviced, then closes. On an already
   * closed session it resolves immediately. The returned promise rejects only if
   * the shutdown itself throws.
   *
   * ```ts no_run
   * await session.closeWhenIdle();
   * ```
   */
  closeWhenIdle(): Promise<void> {
    try {
      if (this.#closed) return Promise.resolve();
      if (!this.#ready) {
        this.close();
        return Promise.resolve();
      }
      if (!this.#shutdownStarted) {
        this.#shutdownStarted = true;
        const src = sym!.nghttp3_conn_shutdown(this.#conn) as number;
        if (src !== 0) {
          this.close();
          return Promise.reject(new Error(`nghttp3_conn_shutdown failed: ${src}`));
        }
        this.drainWrites();
      }
      if (!this.#isServer) {
        this.close();
        return Promise.resolve();
      }
      if ((sym!.nghttp3_conn_is_drained(this.#conn) as number) !== 0) {
        this.close();
        return Promise.resolve();
      }
      if (this.#drainPromise === null) {
        this.#drainPromise = new Promise((resolve) => {
          this.#resolveDrained = resolve;
        });
      }
      return this.#drainPromise;
    } catch (error) {
      this.close();
      return Promise.reject(error);
    }
  }
  /** Send the initial maximum-ID GOAWAY without preventing accepted responses. */
  submitShutdownNotice(): void {
    if (this.#closed) throw new Error('session closed');
    if (!this.#ready || this.#shutdownNoticeSent) return;
    const rc = sym!.nghttp3_conn_submit_shutdown_notice(this.#conn) as number;
    if (rc !== 0) throw new Error(`nghttp3_conn_submit_shutdown_notice failed: ${rc}`);
    this.#shutdownNoticeSent = true;
    this.drainWrites();
  }
  #scheduleDrainedCheck(): void {
    if (!this.#shutdownStarted || this.#closed || this.#drainCheckScheduled) return;
    this.#drainCheckScheduled = true;
    queueMicrotask(() => {
      this.#drainCheckScheduled = false;
      if (this.#closed || !this.#shutdownStarted) return;
      if ((sym!.nghttp3_conn_is_drained(this.#conn) as number) === 0) return;
      this.close();
    });
  }
  /**
   * Free the native connection and release all per-stream state immediately.
   *
   * Deletes the `nghttp3_conn`, closes every installed FFI callback, and clears
   * body slots, deferred trailers, GC pins, and registered stream writers.
   * Idempotent; safe to call more than once. After this, all submit/read/drain
   * operations throw. Use `closeWhenIdle()` instead when a graceful GOAWAY is
   * wanted.
   *
   * ```ts no_run
   * session.close();
   * ```
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    sym!.nghttp3_conn_del(this.#conn);
    for (const cb of this.#callbacks) cb.close();
    this.#callbacks.length = 0;
    for (const streamId of this.#bodySlots.keys()) this.#dropBodySlot(streamId);
    this.#pendingTrailers.clear();
    this.#yieldedBytes.clear();
    this.#quicStreams.clear();
    this.#remoteEndedStreams.clear();
    this.#localEndedStreams.clear();
    this.#resolveDrained?.();
    this.#resolveDrained = null;
  }
  /**
   * Dispose support so a session can be scoped with `using`. Calls `close()`.
   *
   * ```ts no_run
   * using session = Nghttp3Session.createClient(callbacks);
   * // session.close() runs automatically at end of scope.
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
}
