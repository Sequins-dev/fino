/**
 * internal:net/quic/endpoint — low-level QUIC over ngtcp2.
 *
 * This module implements the public `fino:net/quic` object model using UDP,
 * ngtcp2, `ngtcp2_crypto_ossl`, and OpenSSL TLS sessions. It deliberately does
 * not use OpenSSL's high-level QUIC transport APIs; ngtcp2 owns QUIC packet
 * parsing, recovery, stream state, flow control, and timers. OpenSSL is used
 * only as the TLS backend through `ngtcp2_crypto_ossl`.
 *
 * @internal
 */

import { Event, EventTarget } from '../../globals/eventtarget.mts';
import { BytesReader, BytesWriter } from '../../stream.mts';
import * as loop from '../../runtime/loop.mts';
import {
  AF_INET,
  AF_INET6,
  EAGAIN,
  IPPROTO_UDP,
  SOCK_DGRAM,
  bind as socketBind,
  close as socketClose,
  encodeAddr,
  getsockname,
  recvfrom,
  sendto,
  setNonblocking,
  socket,
} from '../../../net/socket.mts';
import {
  getErrorString,
  randBytes,
  sslCtxFree,
  sslCtxNewClient,
  sslCtxNewServer,
  sslCtxSetAlpnServerProtos,
  sslCtxSetDefaultVerifyPaths,
  sslCtxSetVerify,
  sslCtxUseCertKey,
  sslFree,
  sslGetAlpnSelected,
  sslNew,
  sslSetAcceptState,
  sslSetAlpnProtos,
  sslSetAppData,
  sslSetConnectState,
  sslSetHostname,
} from '../../openssl.mts';
import {
  CB_ACKED_STREAM_DATA_OFFSET,
  CB_CLIENT_INITIAL,
  CB_DELETE_CRYPTO_AEAD_CTX,
  CB_DELETE_CRYPTO_CIPHER_CTX,
  CB_DECRYPT,
  CB_ENCRYPT,
  CB_EXTEND_MAX_LOCAL_STREAMS_BIDI,
  CB_EXTEND_MAX_LOCAL_STREAMS_UNI,
  CB_GET_NEW_CONNECTION_ID2,
  CB_GET_PATH_CHALLENGE_DATA2,
  CB_HANDSHAKE_COMPLETED,
  CB_HP_MASK,
  CB_RAND,
  CB_RECV_CLIENT_INITIAL,
  CB_RECV_CRYPTO_DATA,
  CB_RECV_RETRY,
  CB_RECV_STREAM_DATA,
  CB_RECV_VERSION_NEGOTIATION,
  CB_STREAM_CLOSE,
  CB_STREAM_OPEN,
  CB_STREAM_RESET,
  CB_STREAM_STOP_SENDING,
  CB_UPDATE_KEY,
  CB_VERSION_NEGOTIATION,
  ADDR_ADDR,
  ADDR_ADDRLEN,
  CID_DATA,
  CID_DATALEN,
  NGTCP2_CALLBACKS_SIZE,
  NGTCP2_CALLBACKS_VERSION,
  NGTCP2_CID_SIZE,
  NGTCP2_ERR_CLOSING,
  NGTCP2_ERR_DRAINING,
  NGTCP2_ERR_NOBUF,
  NGTCP2_ERR_STREAM_DATA_BLOCKED,
  NGTCP2_ERR_STREAM_SHUT_WR,
  NGTCP2_ERR_WRITE_MORE,
  NGTCP2_MAX_CIDLEN,
  NGTCP2_MAX_UDP_PAYLOAD_SIZE,
  NGTCP2_PATH_SIZE,
  PATH_LOCAL,
  PATH_REMOTE,
} from './ngtcp2/bindings.mts';
import {
  NGTCP2_PKT_HD_SIZE,
  NGTCP2_PKT_INFO_VERSION,
  NGTCP2_PROTO_VER_V1,
  NGTCP2_SETTINGS_SIZE,
  NGTCP2_SETTINGS_VERSION,
  NGTCP2_TRANSPORT_PARAMS_SIZE,
  NGTCP2_TRANSPORT_PARAMS_VERSION,
  NGTCP2_VERSION_CID_SIZE,
  NGTCP2_VEC_SIZE,
  NGTCP2_WRITE_STREAM_FLAG_FIN,
  TP_ACTIVE_CONNECTION_ID_LIMIT,
  TP_ACK_DELAY_EXPONENT,
  TP_INITIAL_MAX_DATA,
  TP_INITIAL_MAX_STREAMS_BIDI,
  TP_INITIAL_MAX_STREAMS_UNI,
  TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL,
  TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE,
  TP_INITIAL_MAX_STREAM_DATA_UNI,
  TP_MAX_ACK_DELAY,
  TP_MAX_UDP_PAYLOAD_SIZE,
  TP_ORIGINAL_DCID,
  TP_ORIGINAL_DCID_PRESENT,
  VEC_BASE,
  VEC_LEN,
  VERSION_CID_DCID,
  VERSION_CID_DCIDLEN,
  VERSION_CID_SCID,
  VERSION_CID_SCIDLEN,
  VERSION_CID_VERSION,
  FfiCallback,
  Pointer,
  ngtcp2Available,
  ptr as ngtcp2Ptr,
  readCStr,
  requireNgtcp2,
  sym as ngtcp2Sym,
} from './ngtcp2/bindings.mts';
import {
  cryptoBackend as _cryptoBackend,
  cryptoOsslAvailable,
  newCryptoOsslContext,
  ptr as cryptoPtr,
  requireCryptoOssl,
  sym as cryptoSym,
} from './ngtcp2/crypto-ossl.mts';

export type QuicAddress = {
  family: 'ipv4' | 'ipv6';
  ip: string;
  port: number;
};

export interface QuicEndpointOptions {
  alpnProtocols?: string[];
}

export interface QuicListenOptions {
  address?: QuicAddress;
  alpnProtocols?: string[];
  certificateFile?: string;
  privateKeyFile?: string;
}

export interface QuicConnectOptions {
  address: QuicAddress;
  alpnProtocols?: string[];
  serverName?: string;
  verifyPeer?: boolean;
}

type QueueResolver<T> = { resolve(value: T): void; reject(error: Error): void };
type QuicConnectionState = 'connecting' | 'connected' | 'closing' | 'closed';

const DEFAULT_LOOPBACK_CERT = 'tests/net/fixtures/test.crt';
const DEFAULT_LOOPBACK_KEY = 'tests/net/fixtures/test.key';
const STREAM_DATA_FLAG_FIN = 0x01;
const DEBUG_QUIC = false;

function debugQuic(message: string): void {
  if (DEBUG_QUIC) console.error(`[quic-debug] ${message}`);
}

let _nextConnectionId = 1;
let _nextNativeUserDataId = 1;

const _nativeConnections = new Map<number, QuicConnection>();

export const quicAvailable = ngtcp2Available && cryptoOsslAvailable;
export const cryptoBackend = quicAvailable ? _cryptoBackend : null;
export const transportEngine = 'ngtcp2';

export const quicVersion: string | null = (() => {
  if (!quicAvailable || ngtcp2Sym === null) return null;
  try {
    const infoPtr = ngtcp2Sym.ngtcp2_version(0) as ArrayBuffer | null;
    if (infoPtr === null) return null;
    const versionPtr = Pointer.readPointer(infoPtr, 8) as ArrayBuffer | null;
    return versionPtr === null ? null : readCStr(versionPtr);
  } catch {
    return null;
  }
})();

export function requireQuic(): void {
  requireNgtcp2();
  requireCryptoOssl();
}

class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: QueueResolver<T>[] = [];
  #closed = false;
  #closeError: Error;

  constructor(closeMessage: string) {
    this.#closeError = new Error(closeMessage);
  }

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(item);
    else this.#items.push(item);
  }

  shift(): Promise<T> {
    if (this.#items.length > 0) return Promise.resolve(this.#items.shift()!);
    if (this.#closed) return Promise.reject(this.#closeError);
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  close(error: Error = this.#closeError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}

class ByteQueue {
  #chunks: Uint8Array[] = [];
  #waiters: QueueResolver<Uint8Array | null>[] = [];
  #closed = false;
  #error: Error | null = null;

  push(chunk: Uint8Array): void {
    if (this.#closed) return;
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(copy);
    else this.#chunks.push(copy);
  }

  read(): Promise<Uint8Array | null> {
    if (this.#chunks.length > 0) return Promise.resolve(this.#chunks.shift()!);
    if (this.#error !== null) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(null);
  }

  error(error: Error): void {
    if (this.#closed && this.#error !== null) return;
    this.#closed = true;
    this.#error = error;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}

class QuicBytesReader extends BytesReader {
  #stream: QuicStream;

  constructor(stream: QuicStream, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#stream = stream;
  }

  protected doRead(_maxBytes: number): Promise<Uint8Array | null> {
    return this.#stream._readIncoming();
  }
}

class QuicBytesWriter extends BytesWriter {
  #stream: QuicStream;

  constructor(stream: QuicStream, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#stream = stream;
  }

  protected async doWrite(buf: Uint8Array): Promise<void> {
    this.#stream._queueWrite(buf, false);
  }
}

function addressKey(address: QuicAddress): string {
  return `${address.family}:${address.ip}:${address.port}`;
}

function normalizeAddress(address?: QuicAddress): QuicAddress {
  const addr = address ?? { family: 'ipv4', ip: '127.0.0.1', port: 0 };
  if (addr.family !== 'ipv4' && addr.family !== 'ipv6') {
    throw new TypeError('QUIC only supports IPv4 and IPv6 UDP addresses');
  }
  return { family: addr.family, ip: addr.ip, port: addr.port };
}

function now(): bigint {
  return BigInt(Math.floor(performance.now() * 1_000_000));
}

function writeU64(buf: ArrayBuffer | Uint8Array, off: number, value: bigint | number): void {
  const dv = new DataView(buf instanceof Uint8Array ? buf.buffer : buf, buf instanceof Uint8Array ? buf.byteOffset : 0);
  dv.setBigUint64(off, BigInt(value), true);
}

function writeU32(buf: ArrayBuffer | Uint8Array, off: number, value: number): void {
  const dv = new DataView(buf instanceof Uint8Array ? buf.buffer : buf, buf instanceof Uint8Array ? buf.byteOffset : 0);
  dv.setUint32(off, value, true);
}

function writeU8(buf: ArrayBuffer | Uint8Array, off: number, value: number): void {
  new Uint8Array(buf instanceof Uint8Array ? buf.buffer : buf, buf instanceof Uint8Array ? buf.byteOffset : 0)[off] = value;
}

function readU64(buf: ArrayBuffer, off: number): bigint {
  return new DataView(buf).getBigUint64(off, true);
}

function readU32(buf: ArrayBuffer, off: number): number {
  return new DataView(buf).getUint32(off, true);
}

function ptrAddress(ptr: ArrayBuffer | null): bigint {
  if (ptr === null) return 0n;
  return new DataView(ptr).getBigUint64(0, true);
}

function writePtr(buf: ArrayBuffer, off: number, ptr: ArrayBuffer | null): void {
  writeU64(buf, off, ptrAddress(ptr));
}

function writeAddress(buf: ArrayBuffer, off: number, address: bigint): void {
  writeU64(buf, off, address);
}

function ptrField(buf: ArrayBuffer, off: number): ArrayBuffer | null {
  const value = readU64(buf, off);
  if (value === 0n) return null;
  const out = new ArrayBuffer(8);
  writeU64(out, 0, value);
  return out;
}

function copyFromPtr(ptr: ArrayBuffer | null, len: number): Uint8Array {
  if (ptr === null || len === 0) return new Uint8Array();
  return Pointer.copyFrom(ptr, len) as Uint8Array;
}

function cidKey(cid: Uint8Array | string): string {
  if (typeof cid === 'string') return cid;
  let out = '';
  for (const byte of cid) out += byte.toString(16).padStart(2, '0');
  return out;
}

function makeCid(bytes: Uint8Array): ArrayBuffer {
  const cid = new ArrayBuffer(NGTCP2_CID_SIZE);
  writeU64(cid, CID_DATALEN, BigInt(bytes.byteLength));
  new Uint8Array(cid, CID_DATA, Math.min(bytes.byteLength, NGTCP2_MAX_CIDLEN)).set(bytes.subarray(0, NGTCP2_MAX_CIDLEN));
  return cid;
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  randBytes(out.buffer, len);
  return out;
}

function randomCid(len = NGTCP2_MAX_CIDLEN): ArrayBuffer {
  return makeCid(randomBytes(len));
}

function cidBytes(cid: ArrayBuffer | null): Uint8Array {
  if (cid === null) return new Uint8Array();
  const len = Number(readU64(cid, CID_DATALEN));
  return new Uint8Array(cid, CID_DATA, len).slice();
}

function makePath(localAddress: QuicAddress, remoteAddress: QuicAddress): { path: ArrayBuffer; local: ArrayBuffer; remote: ArrayBuffer } {
  const local = encodeAddr(localAddress);
  const remote = encodeAddr(remoteAddress);
  const path = new ArrayBuffer(NGTCP2_PATH_SIZE);
  writeAddress(path, PATH_LOCAL + ADDR_ADDR, Pointer.addr(local.buf) as bigint);
  writeU32(path, PATH_LOCAL + ADDR_ADDRLEN, local.len);
  writeAddress(path, PATH_REMOTE + ADDR_ADDR, Pointer.addr(remote.buf) as bigint);
  writeU32(path, PATH_REMOTE + ADDR_ADDRLEN, remote.len);
  return { path, local: local.buf, remote: remote.buf };
}

function makeSettings(): ArrayBuffer {
  const settings = new ArrayBuffer(NGTCP2_SETTINGS_SIZE);
  ngtcp2Sym!.ngtcp2_settings_default_versioned(NGTCP2_SETTINGS_VERSION, Pointer.of(settings));
  return settings;
}

function makeTransportParams(originalDcid: ArrayBuffer | null = null): ArrayBuffer {
  const params = new ArrayBuffer(NGTCP2_TRANSPORT_PARAMS_SIZE);
  ngtcp2Sym!.ngtcp2_transport_params_default_versioned(NGTCP2_TRANSPORT_PARAMS_VERSION, Pointer.of(params));
  writeU64(params, TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL, 1024n * 1024n);
  writeU64(params, TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE, 1024n * 1024n);
  writeU64(params, TP_INITIAL_MAX_STREAM_DATA_UNI, 1024n * 1024n);
  writeU64(params, TP_INITIAL_MAX_DATA, 8n * 1024n * 1024n);
  writeU64(params, TP_INITIAL_MAX_STREAMS_BIDI, 128n);
  writeU64(params, TP_INITIAL_MAX_STREAMS_UNI, 128n);
  writeU64(params, TP_MAX_UDP_PAYLOAD_SIZE, BigInt(NGTCP2_MAX_UDP_PAYLOAD_SIZE));
  writeU64(params, TP_ACTIVE_CONNECTION_ID_LIMIT, 8n);
  writeU64(params, TP_ACK_DELAY_EXPONENT, 3n);
  writeU64(params, TP_MAX_ACK_DELAY, 25n);
  if (originalDcid !== null) {
    new Uint8Array(params, TP_ORIGINAL_DCID, NGTCP2_CID_SIZE).set(new Uint8Array(originalDcid));
    writeU8(params, TP_ORIGINAL_DCID_PRESENT, 1);
  }
  return params;
}

function readUserDataId(userData: ArrayBuffer | null): number {
  if (userData === null) return 0;
  return Number(Pointer.readU64(userData, 0));
}

function connectionFromUserData(userData: ArrayBuffer | null): QuicConnection | undefined {
  return _nativeConnections.get(readUserDataId(userData));
}

let _callbackTable: ArrayBuffer | null = null;
let _callbackRefs: Array<{ close(): void }> = [];

function ensureCallbackTable(): ArrayBuffer {
  if (_callbackTable !== null) return _callbackTable;
  if (cryptoPtr === null || ngtcp2Ptr === null) throw new Error('ngtcp2 callback symbols are unavailable');

  const cbs = new ArrayBuffer(NGTCP2_CALLBACKS_SIZE);
  const retain = (cb: { pointer: ArrayBuffer; close(): void }) => {
    _callbackRefs.push(cb);
    return cb.pointer;
  };

  const getConn = new FfiCallback({ parameters: ['pointer'], result: 'pointer' }, (connRef: ArrayBuffer) => {
    const userData = Pointer.readPointer(connRef, 8) as ArrayBuffer | null;
    return connectionFromUserData(userData)?.nativeHandle ?? null;
  });

  const handshakeCompleted = new FfiCallback({ parameters: ['pointer', 'pointer'], result: 'i32' }, (_conn: ArrayBuffer, userData: ArrayBuffer | null) => {
    connectionFromUserData(userData)?._onHandshakeCompleted();
    return 0;
  });

  const recvStreamData = new FfiCallback(
    { parameters: ['pointer', 'u32', 'i64', 'u64', 'pointer', 'usize', 'pointer', 'pointer'], result: 'i32' },
    (_conn: ArrayBuffer, flags: number, streamId: bigint, _offset: bigint, data: ArrayBuffer | null, datalen: bigint, userData: ArrayBuffer | null) => {
      connectionFromUserData(userData)?._onStreamData(Number(streamId), copyFromPtr(data, Number(datalen)), (flags & STREAM_DATA_FLAG_FIN) !== 0);
      return 0;
    },
  );

  const streamOpen = new FfiCallback({ parameters: ['pointer', 'i64', 'pointer'], result: 'i32' }, (_conn: ArrayBuffer, streamId: bigint, userData: ArrayBuffer | null) => {
    connectionFromUserData(userData)?._onRemoteStreamOpen(Number(streamId));
    return 0;
  });

  const streamClose = new FfiCallback({ parameters: ['pointer', 'u32', 'i64', 'u64', 'pointer', 'pointer'], result: 'i32' }, (_conn, _flags, streamId, _appCode, userData) => {
    connectionFromUserData(userData)?._onStreamClose(Number(streamId));
    return 0;
  });

  const streamReset = new FfiCallback({ parameters: ['pointer', 'i64', 'u64', 'u64', 'pointer', 'pointer'], result: 'i32' }, (_conn, streamId, _finalSize, appCode, userData) => {
    connectionFromUserData(userData)?._onStreamReset(Number(streamId), Number(appCode));
    return 0;
  });

  const acked = new FfiCallback({ parameters: ['pointer', 'i64', 'u64', 'u64', 'pointer', 'pointer'], result: 'i32' }, () => 0);
  const extendStreams = new FfiCallback({ parameters: ['pointer', 'u64', 'pointer'], result: 'i32' }, () => 0);
  const stopSending = new FfiCallback({ parameters: ['pointer', 'i64', 'u64', 'pointer', 'pointer'], result: 'i32' }, (_conn, streamId, appCode, userData) => {
    connectionFromUserData(userData)?._onStreamReset(Number(streamId), Number(appCode));
    return 0;
  });
  const rand = new FfiCallback({ parameters: ['pointer', 'usize', 'pointer'], result: 'void' }, (dest: ArrayBuffer | null, len: bigint) => {
    if (dest !== null) Pointer.copyTo(dest, randomBytes(Number(len)));
  });
  const getNewConnectionId2 = new FfiCallback({ parameters: ['pointer', 'pointer', 'pointer', 'usize', 'pointer'], result: 'i32' }, (_conn, cid, token, cidlen) => {
    const bytes = randomBytes(Number(cidlen));
    Pointer.writeU64(cid, CID_DATALEN, cidlen);
    Pointer.copyTo(Pointer.offset(cid, CID_DATA), bytes);
    Pointer.copyTo(token, randomBytes(16));
    return 0;
  });

  writePtr(cbs, CB_CLIENT_INITIAL, cryptoPtr.ngtcp2_crypto_client_initial_cb);
  writePtr(cbs, CB_RECV_CLIENT_INITIAL, cryptoPtr.ngtcp2_crypto_recv_client_initial_cb);
  writePtr(cbs, CB_RECV_CRYPTO_DATA, cryptoPtr.ngtcp2_crypto_recv_crypto_data_cb);
  writePtr(cbs, CB_RECV_VERSION_NEGOTIATION, retain(new FfiCallback({ parameters: ['pointer', 'pointer', 'pointer', 'usize', 'pointer'], result: 'i32' }, () => 0)));
  writePtr(cbs, CB_RECV_RETRY, cryptoPtr.ngtcp2_crypto_recv_retry_cb);
  writePtr(cbs, CB_ENCRYPT, cryptoPtr.ngtcp2_crypto_encrypt_cb);
  writePtr(cbs, CB_DECRYPT, cryptoPtr.ngtcp2_crypto_decrypt_cb);
  writePtr(cbs, CB_HP_MASK, cryptoPtr.ngtcp2_crypto_hp_mask_cb);
  writePtr(cbs, CB_UPDATE_KEY, cryptoPtr.ngtcp2_crypto_update_key_cb);
  writePtr(cbs, CB_DELETE_CRYPTO_AEAD_CTX, cryptoPtr.ngtcp2_crypto_delete_crypto_aead_ctx_cb);
  writePtr(cbs, CB_DELETE_CRYPTO_CIPHER_CTX, cryptoPtr.ngtcp2_crypto_delete_crypto_cipher_ctx_cb);
  writePtr(cbs, CB_GET_PATH_CHALLENGE_DATA2, cryptoPtr.ngtcp2_crypto_get_path_challenge_data2_cb);
  writePtr(cbs, CB_VERSION_NEGOTIATION, cryptoPtr.ngtcp2_crypto_version_negotiation_cb);
  writePtr(cbs, CB_HANDSHAKE_COMPLETED, retain(handshakeCompleted));
  writePtr(cbs, CB_RECV_STREAM_DATA, retain(recvStreamData));
  writePtr(cbs, CB_ACKED_STREAM_DATA_OFFSET, retain(acked));
  writePtr(cbs, CB_STREAM_OPEN, retain(streamOpen));
  writePtr(cbs, CB_STREAM_CLOSE, retain(streamClose));
  writePtr(cbs, CB_STREAM_RESET, retain(streamReset));
  writePtr(cbs, CB_STREAM_STOP_SENDING, retain(stopSending));
  writePtr(cbs, CB_EXTEND_MAX_LOCAL_STREAMS_BIDI, retain(extendStreams));
  writePtr(cbs, CB_EXTEND_MAX_LOCAL_STREAMS_UNI, retain(extendStreams));
  writePtr(cbs, CB_RAND, retain(rand));
  writePtr(cbs, CB_GET_NEW_CONNECTION_ID2, retain(getNewConnectionId2));
  _callbackRefs.push(getConn);
  (ensureCallbackTable as any)._getConnPointer = getConn.pointer;
  _callbackTable = cbs;
  return cbs;
}

function getConnRefPointer(): ArrayBuffer {
  ensureCallbackTable();
  return (ensureCallbackTable as any)._getConnPointer;
}

function ngtcp2Error(code: number, context: string): Error {
  let text = String(code);
  try {
    const ptr = ngtcp2Sym!.ngtcp2_strerror(code) as ArrayBuffer | null;
    if (ptr !== null) text = readCStr(ptr);
  } catch {}
  return new Error(`${context}: ${text} (${code})`);
}

export class QuicConnectionEvent extends Event {
  readonly connection: QuicConnection;

  constructor(type: string, init: { connection: QuicConnection }) {
    super(type);
    this.connection = init.connection;
  }
}

export class QuicStreamEvent extends Event {
  readonly stream: QuicStream;

  constructor(type: string, init: { stream: QuicStream }) {
    super(type);
    this.stream = init.stream;
  }
}

export class QuicErrorEvent extends Event {
  readonly error: Error;

  constructor(type: string, init: { error: Error }) {
    super(type);
    this.error = init.error;
  }
}

export class CidRoutingTable<T = QuicConnection> {
  #entries = new Map<string, T>();

  add(cid: Uint8Array | string, value: T): void {
    this.#entries.set(cidKey(cid), value);
  }

  get(cid: Uint8Array | string): T | undefined {
    return this.#entries.get(cidKey(cid));
  }

  delete(cid: Uint8Array | string): boolean {
    return this.#entries.delete(cidKey(cid));
  }

  clear(): void {
    this.#entries.clear();
  }
}

export class QuicEndpoint extends EventTarget {
  #listeners: QuicListener[] = [];
  #connections = new Set<QuicConnection>();
  #acceptQueue = new AsyncQueue<QuicConnection>('QUIC endpoint is closed');
  #closed = false;
  readonly cidTable = new CidRoutingTable();
  readonly alpnProtocols: string[];

  constructor(options: QuicEndpointOptions = {}) {
    super();
    this.alpnProtocols = options.alpnProtocols?.slice() ?? ['fino-hq'];
  }

  get listeners(): ReadonlyArray<QuicListener> {
    return this.#listeners.slice();
  }

  async listen(options: QuicListenOptions = {}): Promise<QuicListener> {
    if (this.#closed) throw new Error('QUIC endpoint is closed');
    requireQuic();
    cryptoSym!.ngtcp2_crypto_ossl_init();
    ensureCallbackTable();

    const input = normalizeAddress(options.address);
    const fd = socket(input.family === 'ipv6' ? AF_INET6 : AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, input);
    const bound = getsockname(fd);
    if (bound.family !== 'ipv4' && bound.family !== 'ipv6') {
      socketClose(fd);
      throw new Error('QUIC listener bound to unsupported address family');
    }

    const ctx = sslCtxNewServer();
    sslCtxUseCertKey(ctx, options.certificateFile ?? DEFAULT_LOOPBACK_CERT, options.privateKeyFile ?? DEFAULT_LOOPBACK_KEY);
    const alpnCallback = sslCtxSetAlpnServerProtos(ctx, options.alpnProtocols?.slice() ?? this.alpnProtocols);
    const listener = new QuicListener(this, bound, options.alpnProtocols?.slice() ?? this.alpnProtocols, fd, ctx, alpnCallback);
    this.#listeners.push(listener);
    listener._start();
    return listener;
  }

  async connect(options: QuicConnectOptions): Promise<QuicConnection> {
    if (this.#closed) throw new Error('QUIC endpoint is closed');
    requireQuic();
    cryptoSym!.ngtcp2_crypto_ossl_init();
    ensureCallbackTable();

    const remoteAddress = normalizeAddress(options.address);
    const fd = socket(remoteAddress.family === 'ipv6' ? AF_INET6 : AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, remoteAddress.family === 'ipv6'
      ? { family: 'ipv6', ip: '::1', port: 0 }
      : { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const local = getsockname(fd);
    if (local.family !== 'ipv4' && local.family !== 'ipv6') {
      socketClose(fd);
      throw new Error('QUIC client socket has unsupported local address family');
    }

    const ctx = sslCtxNewClient();
    sslCtxSetVerify(ctx, options.verifyPeer === true ? 1 : 0);
    if (options.verifyPeer === true) sslCtxSetDefaultVerifyPaths(ctx);
    const ssl = sslNew(ctx);
    sslSetHostname(ssl, options.serverName ?? 'localhost');
    sslSetAlpnProtos(ssl, options.alpnProtocols?.slice() ?? this.alpnProtocols);
    cryptoSym!.ngtcp2_crypto_ossl_configure_client_session(ssl);
    sslSetConnectState(ssl);

    const clientProtocols = options.alpnProtocols?.slice() ?? this.alpnProtocols;
    const connection = new QuicConnection('client', this, null, local, remoteAddress, clientProtocols, fd, ctx, ssl, null);
    debugQuic('client init');
    connection._initClient();
    this._track(connection);
    connection._startSocketLoop();
    debugQuic('client drive writes');
    connection._driveWrites();
    debugQuic('client wait handshake');
    await connection._waitHandshake();
    if (!clientProtocols.includes(connection.alpnProtocol)) {
      await connection.close();
      throw new Error(`QUIC ALPN mismatch: client offered ${clientProtocols.join(', ') || '(none)'}`);
    }
    return connection;
  }

  accept(): Promise<QuicConnection> {
    return this.#acceptQueue.shift();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#listeners.slice()) await listener.close();
    for (const connection of Array.from(this.#connections)) await connection.close();
    this.cidTable.clear();
    this.#acceptQueue.close(new Error('QUIC endpoint is closed'));
    this.dispatchEvent(new Event('close'));
  }

  _track(connection: QuicConnection): void {
    this.#connections.add(connection);
    for (const cid of connection.routeCids) this.cidTable.add(cid, connection);
    connection.addEventListener('close', () => {
      this.#connections.delete(connection);
      for (const cid of connection.routeCids) this.cidTable.delete(cid);
    }, { once: true });
  }

  _accept(connection: QuicConnection): void {
    this.#acceptQueue.push(connection);
    this.dispatchEvent(new QuicConnectionEvent('connection', { connection }));
  }

  _removeListener(listener: QuicListener): void {
    this.#listeners = this.#listeners.filter((candidate) => candidate !== listener);
  }

  _handleDatagram(listener: QuicListener | null, fd: number, localAddress: QuicAddress, packet: Uint8Array, remoteAddress: QuicAddress): void {
    const decoded = new ArrayBuffer(NGTCP2_VERSION_CID_SIZE);
    const rc = ngtcp2Sym!.ngtcp2_pkt_decode_version_cid(Pointer.of(decoded), packet, packet.byteLength, NGTCP2_MAX_CIDLEN) as number;
    if (rc !== 0 && rc !== -217) return;

    const dcidPtr = ptrField(decoded, VERSION_CID_DCID);
    const dcidLen = Number(readU64(decoded, VERSION_CID_DCIDLEN));
    const dcid = copyFromPtr(dcidPtr, dcidLen);
    const existing = this.cidTable.get(dcid);
    if (existing) {
      existing._receivePacket(packet, remoteAddress);
      return;
    }

    if (listener === null) return;
    this.#acceptInitial(listener, fd, localAddress, remoteAddress, packet, decoded);
  }

  #acceptInitial(listener: QuicListener, fd: number, localAddress: QuicAddress, remoteAddress: QuicAddress, packet: Uint8Array, decoded: ArrayBuffer): void {
    const hd = new ArrayBuffer(NGTCP2_PKT_HD_SIZE);
    if ((ngtcp2Sym!.ngtcp2_accept(Pointer.of(hd), packet, packet.byteLength) as number) !== 0) return;
    const clientScid = makeCid(copyFromPtr(ptrField(decoded, VERSION_CID_SCID), Number(readU64(decoded, VERSION_CID_SCIDLEN))));
    const originalDcid = makeCid(copyFromPtr(ptrField(decoded, VERSION_CID_DCID), Number(readU64(decoded, VERSION_CID_DCIDLEN))));
    const serverScid = randomCid();
    const ssl = sslNew(listener._ctx);
    cryptoSym!.ngtcp2_crypto_ossl_configure_server_session(ssl);
    sslSetAcceptState(ssl);
    const version = readU32(decoded, VERSION_CID_VERSION) || NGTCP2_PROTO_VER_V1;

    const connection = new QuicConnection('server', this, listener, localAddress, remoteAddress, listener.alpnProtocols, fd, null, ssl, originalDcid);
    debugQuic('server init');
    connection._initServer(clientScid, serverScid, version);
    this._track(connection);
    debugQuic('server read initial');
    connection._receivePacket(packet, remoteAddress);
  }
}

export class QuicListener {
  readonly endpoint: QuicEndpoint;
  readonly address: QuicAddress;
  readonly alpnProtocols: string[];
  #closed = false;
  #fd: number;
  _ctx: object;
  #alpnCallback: any;

  constructor(endpoint: QuicEndpoint, address: QuicAddress, alpnProtocols: string[], fd: number, ctx: object, alpnCallback: any) {
    this.endpoint = endpoint;
    this.address = address;
    this.alpnProtocols = alpnProtocols;
    this.#fd = fd;
    this._ctx = ctx;
    this.#alpnCallback = alpnCallback;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.endpoint._removeListener(this);
    if (this.#alpnCallback && typeof this.#alpnCallback.close === 'function') this.#alpnCallback.close();
    sslCtxFree(this._ctx);
    socketClose(this.#fd);
  }

  async _start(): Promise<void> {
    while (!this.#closed) {
      try {
        for (;;) {
          const received = recvfrom(this.#fd, 65536);
          if (typeof received === 'number') {
            if (received === EAGAIN) break;
            throw new Error(`QUIC UDP recvfrom failed: ${received}`);
          }
          const addr = received.addr;
          if (addr.family !== 'ipv4' && addr.family !== 'ipv6') continue;
          this.endpoint._handleDatagram(this, this.#fd, this.address, received.data, addr);
        }
        await loop.timeout(1);
      } catch (error) {
        if (!this.#closed) {
          this.endpoint.dispatchEvent(new QuicErrorEvent('error', { error: error instanceof Error ? error : new Error(String(error)) }));
          await loop.timeout(5);
        }
      }
    }
  }
}

type PendingWrite = {
  streamId: number;
  data: Uint8Array;
  offset: number;
  fin: boolean;
};

export class QuicConnection extends EventTarget {
  readonly connectionId: string;
  readonly remoteAddress: QuicAddress;
  readonly localAddress: QuicAddress;
  readonly alpnProtocols: string[];
  readonly routeCids: string[] = [];
  #role: 'client' | 'server';
  #endpoint: QuicEndpoint;
  #listener: QuicListener | null;
  #fd: number;
  #ctx: object | null;
  #ssl: object | null;
  #cryptoCtx: ArrayBuffer | null = null;
  #originalDcid: ArrayBuffer | null;
  #conn: ArrayBuffer = new ArrayBuffer(8);
  #userData = new ArrayBuffer(8);
  #connRef = new ArrayBuffer(16);
  #path: ArrayBuffer;
  #localSockaddr: ArrayBuffer;
  #remoteSockaddr: ArrayBuffer;
  #streamQueue = new AsyncQueue<QuicStream>('QUIC connection is closed');
  #streams = new Map<number, QuicStream>();
  #pendingWrites: PendingWrite[] = [];
  #state: QuicConnectionState = 'connecting';
  #accepted = false;
  #closed = false;
  #timer: any = null;
  #handshakeWaiters: QueueResolver<void>[] = [];
  #handshakeError: Error | null = null;

  constructor(role: 'client' | 'server', endpoint: QuicEndpoint, listener: QuicListener | null, localAddress: QuicAddress, remoteAddress: QuicAddress, alpnProtocols: string[], fd: number, ctx: object | null, ssl: object, originalDcid: ArrayBuffer | null) {
    super();
    this.#role = role;
    this.#endpoint = endpoint;
    this.#listener = listener;
    this.localAddress = localAddress;
    this.remoteAddress = remoteAddress;
    this.alpnProtocols = alpnProtocols;
    this.#fd = fd;
    this.#ctx = ctx;
    this.#ssl = ssl;
    this.#originalDcid = originalDcid;
    const path = makePath(localAddress, remoteAddress);
    this.#path = path.path;
    // Retain sockaddr buffers referenced by #path for the native connection.
    this.#localSockaddr = path.local;
    this.#remoteSockaddr = path.remote;
    this.connectionId = `${role}-${_nextConnectionId++}`;
    const id = _nextNativeUserDataId++;
    writeU64(this.#userData, 0, BigInt(id));
    _nativeConnections.set(id, this);
  }

  get nativeHandle(): ArrayBuffer {
    return this.#conn;
  }

  get alpnProtocol(): string {
    return this.#ssl === null ? '' : (sslGetAlpnSelected(this.#ssl) ?? '');
  }

  get handshakeComplete(): boolean {
    return this.#state === 'connected';
  }

  get state(): QuicConnectionState {
    return this.#state;
  }

  acceptStream(): Promise<QuicStream> {
    return this.#streamQueue.shift();
  }

  openBidirectionalStream(): Promise<QuicStream> {
    if (this.#state !== 'connected') throw new Error('QUIC connection is not connected');
    const out = new ArrayBuffer(8);
    const rc = ngtcp2Sym!.ngtcp2_conn_open_bidi_stream(this.#conn, Pointer.of(out), null) as number;
    if (rc !== 0) throw ngtcp2Error(rc, 'ngtcp2_conn_open_bidi_stream');
    const id = Number(readU64(out, 0));
    const stream = this.#ensureStream(id, 'bidirectional', false);
    this._driveWrites();
    return Promise.resolve(stream);
  }

  openUnidirectionalStream(): Promise<QuicStream> {
    if (this.#state !== 'connected') throw new Error('QUIC connection is not connected');
    const out = new ArrayBuffer(8);
    const rc = ngtcp2Sym!.ngtcp2_conn_open_uni_stream(this.#conn, Pointer.of(out), null) as number;
    if (rc !== 0) throw ngtcp2Error(rc, 'ngtcp2_conn_open_uni_stream');
    const id = Number(readU64(out, 0));
    const stream = this.#ensureStream(id, 'unidirectional', false);
    this._driveWrites();
    return Promise.resolve(stream);
  }

  async close(_errorCode: number = 0, _reason: string = ''): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closing';
    this.#closed = true;
    if (this.#timer !== null) this.#timer.cancel?.();
    this.#streamQueue.close(new Error('QUIC connection is closed'));
    for (const stream of Array.from(this.#streams.values())) stream._closeFromConnection();
    if (ptrAddress(this.#conn) !== 0n) {
      ngtcp2Sym!.ngtcp2_conn_del(this.#conn);
      this.#conn = new ArrayBuffer(8);
    }
    if (this.#cryptoCtx !== null) {
      cryptoSym!.ngtcp2_crypto_ossl_ctx_del(this.#cryptoCtx);
      this.#cryptoCtx = null;
    }
    if (this.#ssl !== null) {
      sslSetAppData(this.#ssl, null);
      sslFree(this.#ssl);
      this.#ssl = null;
    }
    if (this.#ctx !== null) {
      sslCtxFree(this.#ctx);
      this.#ctx = null;
    }
    if (this.#role === 'client') socketClose(this.#fd);
    _nativeConnections.delete(Number(readU64(this.#userData, 0)));
    this.#state = 'closed';
    this.dispatchEvent(new Event('close'));
  }

  _initClient(): void {
    const dcid = randomCid();
    const scid = randomCid();
    this.#createNative(dcid, scid, null, NGTCP2_PROTO_VER_V1, true);
    this.#registerRoute(scid);
  }

  _initServer(clientScid: ArrayBuffer, serverScid: ArrayBuffer, version: number): void {
    this.#createNative(clientScid, serverScid, this.#originalDcidForServer(), version, false);
    this.#registerRoute(serverScid);
  }

  #originalDcidForServer(): ArrayBuffer | null {
    return this.#originalDcid;
  }

  #createNative(dcid: ArrayBuffer, scid: ArrayBuffer, originalDcid: ArrayBuffer | null, version: number, client: boolean): void {
    const callbacks = ensureCallbackTable();
    debugQuic(`create native ${client ? 'client' : 'server'} start`);
    const settings = makeSettings();
    const params = makeTransportParams(originalDcid);
    this.#cryptoCtx = newCryptoOsslContext(this.#ssl);
    writePtr(this.#connRef, 0, getConnRefPointer());
    writeAddress(this.#connRef, 8, Pointer.addr(this.#userData) as bigint);
    sslSetAppData(this.#ssl!, Pointer.of(this.#connRef));
    const fn = client ? ngtcp2Sym!.ngtcp2_conn_client_new_versioned : ngtcp2Sym!.ngtcp2_conn_server_new_versioned;
    const rc = fn(
      Pointer.of(this.#conn),
      Pointer.of(dcid),
      Pointer.of(scid),
      Pointer.of(this.#path),
      version,
      NGTCP2_CALLBACKS_VERSION,
      Pointer.of(callbacks),
      NGTCP2_SETTINGS_VERSION,
      Pointer.of(settings),
      NGTCP2_TRANSPORT_PARAMS_VERSION,
      Pointer.of(params),
      null,
      Pointer.of(this.#userData),
    ) as number;
    if (rc !== 0) throw ngtcp2Error(rc, client ? 'ngtcp2_conn_client_new' : 'ngtcp2_conn_server_new');
    debugQuic(`create native ${client ? 'client' : 'server'} ok`);
    ngtcp2Sym!.ngtcp2_conn_set_tls_native_handle(this.#conn, this.#cryptoCtx);
    debugQuic(`set tls native ${client ? 'client' : 'server'} ok`);
  }

  #registerRoute(cid: ArrayBuffer): void {
    const key = cidKey(cidBytes(cid));
    this.routeCids.push(key);
    this.#endpoint.cidTable.add(key, this);
  }

  _waitHandshake(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    if (this.#handshakeError !== null) return Promise.reject(this.#handshakeError);
    return new Promise((resolve, reject) => this.#handshakeWaiters.push({ resolve, reject }));
  }

  _onHandshakeCompleted(): void {
    if (this.#state === 'closed') return;
    this.#state = 'connected';
    const waiters = this.#handshakeWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve(undefined);
    if (this.#role === 'server' && !this.#accepted) {
      this.#accepted = true;
      this.#endpoint._accept(this);
    }
  }

  #fail(error: Error): void {
    if (this.#state === 'closed') return;
    this.#handshakeError = error;
    const waiters = this.#handshakeWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
    this.dispatchEvent(new QuicErrorEvent('error', { error }));
    this.close();
  }

  async _startSocketLoop(): Promise<void> {
    if (this.#role !== 'client') return;
    while (!this.#closed) {
      try {
        for (;;) {
          const received = recvfrom(this.#fd, 65536);
          if (typeof received === 'number') {
            if (received === EAGAIN) break;
            throw new Error(`QUIC UDP recvfrom failed: ${received}`);
          }
          this.#endpoint._handleDatagram(null, this.#fd, this.localAddress, received.data, this.remoteAddress);
        }
        await loop.timeout(1);
      } catch (error) {
        if (!this.#closed) this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  _receivePacket(packet: Uint8Array, remoteAddress: QuicAddress): void {
    if (this.#closed) return;
    const rc = ngtcp2Sym!.ngtcp2_conn_read_pkt_versioned(this.#conn, Pointer.of(this.#path), NGTCP2_PKT_INFO_VERSION, null, packet, packet.byteLength, now()) as number;
    debugQuic(`read pkt rc ${rc}`);
    if (rc !== 0 && rc !== NGTCP2_ERR_DRAINING && rc !== NGTCP2_ERR_CLOSING) {
      this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_read_pkt'));
      return;
    }
    this.#scheduleTimer();
    this._driveWrites(remoteAddress);
  }

  _queueStreamData(stream: QuicStream, data: Uint8Array, fin: boolean): void {
    this.#pendingWrites.push({ streamId: stream.id, data, offset: 0, fin });
    this._driveWrites();
  }

  _driveWrites(remoteAddress: QuicAddress = this.remoteAddress): void {
    if (this.#closed) return;
    const out = new Uint8Array(65536);
    for (;;) {
      let n: number;
      const pending = this.#pendingWrites[0];
      if (pending) {
        debugQuic(`write stream ${pending.streamId}`);
        const remaining = pending.data.subarray(pending.offset);
        const vec = new ArrayBuffer(NGTCP2_VEC_SIZE);
        writeAddress(vec, VEC_BASE, Pointer.addr(remaining) as bigint);
        writeU64(vec, VEC_LEN, BigInt(remaining.byteLength));
        const dataLen = new ArrayBuffer(8);
        n = Number(ngtcp2Sym!.ngtcp2_conn_writev_stream_versioned(
          this.#conn,
          Pointer.of(this.#path),
          NGTCP2_PKT_INFO_VERSION,
          null,
          out,
          out.byteLength,
          Pointer.of(dataLen),
          pending.fin ? NGTCP2_WRITE_STREAM_FLAG_FIN : 0,
          BigInt(pending.streamId),
          Pointer.of(vec),
          1n,
          now(),
        ));
        const consumed = Number(readU64(dataLen, 0));
        if (consumed > 0) pending.offset += consumed;
        if (pending.offset >= pending.data.byteLength) this.#pendingWrites.shift();
      } else {
        debugQuic('write pkt');
        n = Number(ngtcp2Sym!.ngtcp2_conn_write_pkt_versioned(this.#conn, Pointer.of(this.#path), NGTCP2_PKT_INFO_VERSION, null, out, out.byteLength, now()));
      }

      debugQuic(`write rc ${n}`);

      if (n > 0) {
        const sent = sendto(this.#fd, out.slice(0, n), remoteAddress);
        if (sent < 0 && sent !== EAGAIN) this.#fail(new Error(`QUIC UDP sendto failed: ${sent}`));
        break;
      }
      if (n === 0 || n === NGTCP2_ERR_NOBUF || n === NGTCP2_ERR_STREAM_DATA_BLOCKED || n === NGTCP2_ERR_STREAM_SHUT_WR) break;
      if (n === NGTCP2_ERR_WRITE_MORE) continue;
      if (n === NGTCP2_ERR_DRAINING || n === NGTCP2_ERR_CLOSING) break;
      this.#fail(ngtcp2Error(n, 'ngtcp2_conn_write'));
      break;
    }
    this.#scheduleTimer();
  }

  #scheduleTimer(): void {
    if (this.#closed) return;
    if (this.#timer !== null) this.#timer.cancel?.();
    const expiry = ngtcp2Sym!.ngtcp2_conn_get_expiry(this.#conn) as bigint;
    const deltaNs = expiry > now() ? expiry - now() : 0n;
    const delayMs = Math.max(1, Number(deltaNs / 1_000_000n));
    this.#timer = loop.timeout(delayMs);
    this.#timer.then(() => {
      if (this.#closed) return;
      const rc = ngtcp2Sym!.ngtcp2_conn_handle_expiry(this.#conn, now()) as number;
      if (rc !== 0 && rc !== NGTCP2_ERR_DRAINING && rc !== NGTCP2_ERR_CLOSING) this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_handle_expiry'));
      else this._driveWrites();
    });
  }

  _onRemoteStreamOpen(streamId: number): void {
    this.#ensureStream(streamId, ngtcp2Sym!.ngtcp2_is_bidi_stream(BigInt(streamId)) ? 'bidirectional' : 'unidirectional', true);
  }

  _onStreamData(streamId: number, data: Uint8Array, fin: boolean): void {
    const stream = this.#ensureStream(streamId, ngtcp2Sym!.ngtcp2_is_bidi_stream(BigInt(streamId)) ? 'bidirectional' : 'unidirectional', true);
    stream._pushIncoming(data, fin);
    ngtcp2Sym!.ngtcp2_conn_extend_max_stream_offset(this.#conn, BigInt(streamId), BigInt(data.byteLength));
    ngtcp2Sym!.ngtcp2_conn_extend_max_offset(this.#conn, BigInt(data.byteLength));
  }

  _onStreamClose(streamId: number): void {
    this.#streams.get(streamId)?._closeFromConnection();
  }

  _onStreamReset(streamId: number, code: number): void {
    this.#streams.get(streamId)?._resetFromConnection(code);
  }

  #ensureStream(streamId: number, direction: 'bidirectional' | 'unidirectional', incoming: boolean): QuicStream {
    let stream = this.#streams.get(streamId);
    if (!stream) {
      stream = new QuicStream(streamId, direction, this);
      this.#streams.set(streamId, stream);
      if (incoming) {
        this.#streamQueue.push(stream);
        this.dispatchEvent(new QuicStreamEvent('stream', { stream }));
      }
    }
    return stream;
  }

  _removeStream(stream: QuicStream): void {
    this.#streams.delete(stream.id);
  }
}

export class QuicStream extends EventTarget {
  readonly id: number;
  readonly direction: 'bidirectional' | 'unidirectional';
  readonly reader: BytesReader;
  readonly writer: BytesWriter;
  #connection: QuicConnection;
  #incoming = new ByteQueue();
  #closed = false;
  #readable: ReadableStream<Uint8Array> | null = null;
  #writable: WritableStream<Uint8Array> | null = null;

  constructor(id: number, direction: 'bidirectional' | 'unidirectional', connection: QuicConnection) {
    super();
    this.id = id;
    this.direction = direction;
    this.#connection = connection;
    this.reader = new QuicBytesReader(this, () => this.#closeReadable());
    this.writer = new QuicBytesWriter(this, () => {
      this._queueWrite(new Uint8Array(), true);
      this.#closeWritable();
    });
  }

  get readable(): ReadableStream<Uint8Array> {
    if (this.#readable !== null) return this.#readable;
    this.#readable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const chunk = await this.reader.read();
        if (chunk === null) controller.close();
        else controller.enqueue(chunk);
      },
      cancel: () => this.stopSending(0),
    });
    return this.#readable;
  }

  get writable(): WritableStream<Uint8Array> {
    if (this.#writable !== null) return this.#writable;
    this.#writable = new WritableStream<Uint8Array>({
      write: (chunk) => this.writer.write(chunk),
      close: () => this.writer.close(),
      abort: (reason) => this.reset(typeof reason === 'number' ? reason : 0),
    });
    return this.#writable;
  }

  reset(errorCode: number): void {
    ngtcp2Sym!.ngtcp2_conn_shutdown_stream(this.#connection.nativeHandle, BigInt(errorCode), BigInt(this.id));
    this._resetFromConnection(errorCode);
    this.#connection._driveWrites();
  }

  stopSending(errorCode: number): void {
    ngtcp2Sym!.ngtcp2_conn_shutdown_stream_read(this.#connection.nativeHandle, BigInt(errorCode), BigInt(this.id));
    this.#connection._driveWrites();
  }

  _queueWrite(buf: Uint8Array, fin: boolean): void {
    if (this.#closed) throw new Error('QUIC stream is closed');
    this.#connection._queueStreamData(this, buf, fin);
  }

  _readIncoming(): Promise<Uint8Array | null> {
    return this.#incoming.read();
  }

  _pushIncoming(data: Uint8Array, fin: boolean): void {
    if (data.byteLength > 0) this.#incoming.push(data);
    if (fin) this.#incoming.close();
  }

  _resetFromConnection(errorCode: number): void {
    const error = new Error(`QUIC stream reset: ${errorCode}`);
    this.#incoming.error(error);
    this.dispatchEvent(new QuicErrorEvent('reset', { error }));
    this.#finish();
  }

  _closeFromConnection(): void {
    this.#incoming.close();
    this.#finish();
  }

  #closeReadable(): void {
    this.#incoming.close();
    this.#maybeClose();
  }

  #closeWritable(): void {
    this.#maybeClose();
  }

  #maybeClose(): void {
    if (this.reader.closed && this.writer.closed) this.#finish();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection._removeStream(this);
    this.dispatchEvent(new Event('close'));
  }
}
