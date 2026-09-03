/**
 * internal:net/quic/connection — QUIC connection class and internal symbols.
 *
 * @internal
 */

import { Event, EventTarget } from '../../../globals/eventtarget.ts';
import { BytesReader, BytesWriter } from '../../stream.ts';
import * as loop from '../../runtime/loop.ts';
import {
  lib as fileLib,
  cstr as fileCstr,
  O_CREAT,
  O_TRUNC,
  O_WRONLY,
} from '../../file/bindings.ts';
import { EAGAIN, decodeAddr } from '../../../net/socket.ts';
import { randBytes } from '../../openssl.ts';
import {
  CB_ACKED_STREAM_DATA_OFFSET,
  CB_ACK_DATAGRAM,
  CB_CLIENT_INITIAL,
  CB_DELETE_CRYPTO_AEAD_CTX,
  CB_DELETE_CRYPTO_CIPHER_CTX,
  CB_DECRYPT,
  CB_ENCRYPT,
  CB_EXTEND_MAX_LOCAL_STREAMS_BIDI,
  CB_EXTEND_MAX_LOCAL_STREAMS_UNI,
  CB_EXTEND_MAX_STREAM_DATA,
  CB_GET_NEW_CONNECTION_ID,
  CB_GET_NEW_CONNECTION_ID2,
  CB_GET_PATH_CHALLENGE_DATA,
  CB_GET_PATH_CHALLENGE_DATA2,
  CB_HANDSHAKE_COMPLETED,
  CB_HANDSHAKE_CONFIRMED,
  CB_HP_MASK,
  CB_BEGIN_PATH_VALIDATION,
  CB_DCID_STATUS,
  CB_DCID_STATUS2,
  CB_EARLY_DATA_REJECTED,
  CB_LOST_DATAGRAM,
  CB_PATH_VALIDATION,
  CB_RAND,
  CB_REMOVE_CONNECTION_ID,
  CB_RECV_DATAGRAM,
  CB_RECV_CLIENT_INITIAL,
  CB_RECV_CRYPTO_DATA,
  CB_RECV_NEW_TOKEN,
  CB_RECV_RETRY,
  CB_RECV_RX_KEY,
  CB_RECV_STATELESS_RESET,
  CB_RECV_STATELESS_RESET2,
  CB_RECV_STREAM_DATA,
  CB_RECV_TX_KEY,
  CB_RECV_VERSION_NEGOTIATION,
  CB_STREAM_CLOSE,
  CB_STREAM_OPEN,
  CB_STREAM_RESET,
  CB_STREAM_STOP_SENDING,
  CB_SELECT_PREFERRED_ADDR,
  CB_UPDATE_KEY,
  CB_VERSION_NEGOTIATION,
  CONN_INFO_BYTES_IN_FLIGHT,
  CONN_INFO_BYTES_LOST,
  CONN_INFO_BYTES_RECV,
  CONN_INFO_BYTES_SENT,
  CONN_INFO_CWND,
  CONN_INFO_LATEST_RTT,
  CONN_INFO_MIN_RTT,
  CONN_INFO_PING_RECV,
  CONN_INFO_PKT_DISCARDED,
  CONN_INFO_PKT_LOST,
  CONN_INFO_PKT_RECV,
  CONN_INFO_PKT_SENT,
  CONN_INFO_RTTVAR,
  CONN_INFO_SMOOTHED_RTT,
  CONN_INFO_SSTHRESH,
  ADDR_ADDR,
  ADDR_ADDRLEN,
  CCERR_TYPE,
  CCERR_ERROR_CODE,
  CCERR_REASON,
  CCERR_REASONLEN,
  CID_DATA,
  CID_DATALEN,
  NGTCP2_CALLBACKS_SIZE,
  NGTCP2_CALLBACKS_VERSION,
  NGTCP2_CCERR_SIZE,
  NGTCP2_CONN_INFO_SIZE,
  NGTCP2_CONN_INFO_VERSION,
  NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE,
  NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE,
  NGTCP2_CID_SIZE,
  NGTCP2_CRYPTO_ERROR,
  NGTCP2_ERR_CLOSING,
  NGTCP2_ERR_CALLBACK_FAILURE,
  NGTCP2_ERR_CRYPTO,
  NGTCP2_ERR_DRAINING,
  NGTCP2_ERR_DROP_CONN,
  NGTCP2_ERR_IDLE_CLOSE,
  NGTCP2_ERR_NOBUF,
  NGTCP2_ERR_PKT_NUM_EXHAUSTED,
  NGTCP2_ERR_RECV_VERSION_NEGOTIATION,
  NGTCP2_ERR_RETRY,
  NGTCP2_ERR_STREAM_ID_BLOCKED,
  NGTCP2_ERR_STREAM_DATA_BLOCKED,
  NGTCP2_ERR_STREAM_SHUT_WR,
  NGTCP2_ERR_STREAM_NOT_FOUND,
  NGTCP2_ERR_VERSION_NEGOTIATION,
  NGTCP2_ERR_WRITE_MORE,
  NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE,
  NGTCP2_MAX_CIDLEN,
  NGTCP2_MAX_UDP_PAYLOAD_SIZE,
  NGTCP2_ERR_INVALID_STATE,
  NGTCP2_WRITE_STREAM_FLAG_MORE,
  NGTCP2_PATH_SIZE,
  PATH_LOCAL,
  PATH_REMOTE,
  PATH_USER_DATA,
  SETTINGS_AVAILABLE_VERSIONS,
  SETTINGS_AVAILABLE_VERSIONSLEN,
  SETTINGS_ACK_THRESH,
  SETTINGS_CC_ALGO,
  SETTINGS_HANDSHAKE_TIMEOUT,
  SETTINGS_INITIAL_TS,
  SETTINGS_INITIAL_RTT,
  SETTINGS_MAX_TX_UDP_PAYLOAD_SIZE,
  SETTINGS_MAX_STREAM_WINDOW,
  SETTINGS_MAX_WINDOW,
  SETTINGS_NO_TX_UDP_PAYLOAD_SIZE_SHAPING,
  SETTINGS_NO_PMTUD,
  SETTINGS_ORIGINAL_VERSION,
  SETTINGS_PREFERRED_VERSIONS,
  SETTINGS_PREFERRED_VERSIONSLEN,
  SETTINGS_QLOG_WRITE,
  SETTINGS_TOKEN,
  SETTINGS_TOKENLEN,
  SETTINGS_TOKEN_TYPE,
} from './ngtcp2/bindings.ts';
import {
  NGTCP2_PKT_HD_SIZE,
  NGTCP2_PKT_INFO_VERSION,
  NGTCP2_PKT_INFO_SIZE,
  NGTCP2_ECN_NOT_ECT,
  NGTCP2_ECN_ECT_0,
  NGTCP2_ECN_MASK,
  PKT_INFO_ECN,
  NGTCP2_PROTO_VER_V2,
  NGTCP2_PROTO_VER_V1,
  NGTCP2_SETTINGS_SIZE,
  NGTCP2_SETTINGS_VERSION,
  NGTCP2_TRANSPORT_PARAMS_SIZE,
  NGTCP2_TRANSPORT_PARAMS_VERSION,
  NGTCP2_VERSION_CID_SIZE,
  NGTCP2_VEC_SIZE,
  NGTCP2_DATAGRAM_FLAG_0RTT,
  NGTCP2_WRITE_DATAGRAM_FLAG_NONE,
  NGTCP2_WRITE_STREAM_FLAG_FIN,
  TP_ACTIVE_CONNECTION_ID_LIMIT,
  TP_ACK_DELAY_EXPONENT,
  TP_DISABLE_ACTIVE_MIGRATION,
  TP_INITIAL_MAX_DATA,
  TP_INITIAL_MAX_STREAMS_BIDI,
  TP_INITIAL_MAX_STREAMS_UNI,
  TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL,
  TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE,
  TP_INITIAL_MAX_STREAM_DATA_UNI,
  TP_INITIAL_SCID,
  TP_INITIAL_SCID_PRESENT,
  TP_MAX_IDLE_TIMEOUT,
  TP_MAX_ACK_DELAY,
  TP_MAX_DATAGRAM_FRAME_SIZE,
  TP_MAX_UDP_PAYLOAD_SIZE,
  TP_ORIGINAL_DCID,
  TP_ORIGINAL_DCID_PRESENT,
  TP_RETRY_SCID,
  TP_RETRY_SCID_PRESENT,
  TP_PREFERRED_ADDR,
  TP_PREFERRED_ADDR_CID,
  TP_PREFERRED_ADDR_IPV4,
  TP_PREFERRED_ADDR_IPV4_PRESENT,
  TP_PREFERRED_ADDR_IPV6,
  TP_PREFERRED_ADDR_IPV6_PRESENT,
  TP_PREFERRED_ADDR_PRESENT,
  TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN,
  TP_STATELESS_RESET_TOKEN,
  TP_STATELESS_RESET_TOKEN_PRESENT,
  VEC_BASE,
  VEC_LEN,
  PKT_HD_DCID,
  PKT_HD_SCID,
  PKT_HD_TOKEN,
  PKT_HD_TOKENLEN,
  PKT_HD_VERSION,
  VERSION_CID_DCID,
  VERSION_CID_DCIDLEN,
  VERSION_CID_SCID,
  VERSION_CID_SCIDLEN,
  VERSION_CID_VERSION,
  NGTCP2_TOKEN_TYPE_RETRY,
  NGTCP2_TOKEN_TYPE_NEW_TOKEN,
  NGTCP2_TOKEN_TYPE_UNKNOWN,
  NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN,
  NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR,
  NGTCP2_PATH_VALIDATION_RESULT_ABORTED,
  NGTCP2_PATH_VALIDATION_RESULT_FAILURE,
  NGTCP2_PATH_VALIDATION_RESULT_SUCCESS,
  FfiCallback,
  Pointer,
  ngtcp2Available,
  ngtcp2ConnResetStreamAt,
  ngtcp2ResetStreamAtAvailable,
  ngtcp2PktWriteStatelessReset,
  ptr as ngtcp2Ptr,
  readCStr,
  requireNgtcp2,
  sym as ngtcp2Sym,
} from './ngtcp2/bindings.ts';
import {
  clearConnectionRef,
  configureSessionForConnection,
  cryptoAvailable,
  cryptoBackend as _cryptoBackend,
  freeContext,
  freeNativeHandle,
  freeSession,
  getAlpnSelected,
  getHandshakeInfo,
  getPeerCertificate,
  exportKeyingMaterial as exportTlsKeyingMaterial,
  exportSession,
  importSession,
  initCrypto,
  newClientContext,
  newClientSession,
  newNativeHandle,
  newServerContext,
  newServerSession,
  ptr as cryptoPtr,
  requireCrypto,
  sendSessionTicket,
  setConnectionRef,
  setSNIContexts,
  setSessionTicketCallback,
  sym as cryptoSym,
  type QuicCaOptions,
  type QuicCryptoBackend,
  type QuicTlsContext,
  type QuicTlsSession,
} from './ngtcp2/crypto.ts';
import * as core from './core.ts';
const {
  _PTR_SIZE,
  _QUIC_PTR_PATH,
  _QUIC_PTR_PKT_INFO,
  _QUIC_PTR_DATA_LEN,
  _QUIC_PTR_VEC,
  normalizeCloseOptions,
  quicIncomingStreamHook,
  quicBytesWriterInternals,
  quicEndpointInternals,
  quicListenerInternals,
  quicConnectionInternals,
  quicStreamInternals,
  getConnPointerSlot,
  STREAM_DATA_FLAG_FIN,
  TLS_ALERT_NO_APPLICATION_PROTOCOL,
  NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2,
  NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2,
  NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN,
  NGTCP2_STATELESS_RESET_TOKENLEN,
  NGTCP2_MIN_STATELESS_RESET_RANDLEN,
  NGTCP2_MIN_STATELESS_RESET_PACKETLEN,
  STATELESS_RESET_RANDLEN,
  DEFAULT_ADDRESS_LRU_SIZE,
  DEFAULT_RETRY_RATE,
  DEFAULT_RETRY_BURST,
  DEFAULT_VERSION_NEGOTIATION_RATE,
  DEFAULT_VERSION_NEGOTIATION_BURST,
  DEFAULT_STATELESS_RESET_RATE,
  DEFAULT_STATELESS_RESET_BURST,
  DEFAULT_IMMEDIATE_CLOSE_RATE,
  DEFAULT_IMMEDIATE_CLOSE_BURST,
  DEFAULT_SESSION_CREATION_RATE,
  DEFAULT_SESSION_CREATION_BURST,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_CONNECTIONS_PER_REMOTE_ADDRESS,
  DEFAULT_MAX_PENDING_DATAGRAMS,
  DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS,
  DEFAULT_DRAINING_PERIOD_MULTIPLIER,
  DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE,
  NGTCP2_QLOG_WRITE_FLAG_FIN,
  NGTCP2_ENCRYPTION_LEVEL_1RTT,
  NGTCP2_MILLISECONDS,
  NGTCP2_SECONDS,
  DEFAULT_STREAM_IDLE_TIMEOUT,
  ADDRESS_VALIDATION_TIMEOUT,
  NGTCP2_NO_EXPIRY,
  MIGRATION_KEEP_ALIVE_TIMEOUT,
  MAX_RECEIVE_WINDOW,
  INITIAL_MAX_STREAM_DATA,
  INITIAL_MAX_DATA,
  INITIAL_MAX_STREAMS_BIDI,
  INITIAL_MAX_STREAMS_UNI,
  ACTIVE_CONNECTION_ID_LIMIT,
  MAX_IDLE_TIMEOUT,
  HANDSHAKE_TIMEOUT,
  RETRY_TOKEN_TIMEOUT,
  REGULAR_TOKEN_TIMEOUT,
  MIN_TOKEN_TIMEOUT,
  MAX_RETRY_TOKEN_TIMEOUT,
  MAX_REGULAR_TOKEN_TIMEOUT,
  CONNECTION_DRAINING_TIMEOUT_MS,
  MAX_REJECTED_INITIAL_CIDS,
  MAX_WRITE_PACKETS_PER_DRAIN,
  MAX_READ_PACKETS_PER_TURN,
  MAX_BATCH_READ_PACKETS_PER_TURN,
  NGTCP2_CONNECTION_REFUSED,
  VERSION_NEGOTIATION_GREASE,
  SOCKADDR_UNION_SIZE,
  DEFAULT_ALPN_PROTOCOLS,
  QUIC_TLS_CIPHER_SUITES,
  _nativeConnections,
  allocateQuicConnectionId,
  allocateNativeUserDataId,
  _nativeCallbackDepth,
  _deferredNativeTasks,
  _deferredNativeFlushScheduled,
  inNativeCallback,
  scheduleDeferredNativeTasks,
  flushDeferredNativeTasks,
  deferAfterNativeCallback,
  publishQuicTopic,
  runtimeDelay,
  withNativeCallback,
  quicAvailable,
  quicResetStreamAtAvailable,
  cryptoBackend,
  transportEngine,
  quicVersion,
  realQuicRuntime,
  RealQuicDatagramTransport,
  normalizeSocketOptionInteger,
  normalizeSocketOptions,
  RealQuicDatagramTransportFactory,
  realQuicDatagramTransportFactory,
  requireQuic,
  AsyncQueue,
  ByteQueue,
  QuicBytesReader,
  QuicBytesWriter,
  normalizeAddress,
  addressKey,
  sameAddress,
  decodeHexDatagram,
  decodeBase64Datagram,
  normalizeDatagramSource,
  normalizeVersions,
  normalizeTlsCipherSuites,
  normalizeTlsGroups,
  normalizeRetry,
  normalizeDatagrams,
  quicVarintLength,
  maxDatagramPayload,
  normalizePreferredAddress,
  normalizeMigration,
  normalizeQlog,
  normalizeKeylog,
  normalizeRateLimit,
  normalizeLimit,
  normalizeTimeoutMs,
  normalizeDurationMs,
  normalizeInteger,
  normalizeClampedInteger,
  normalizeTransportVarint,
  normalizeConnection,
  clampBigint,
  nsToMs,
  normalizeAddressSet,
  normalizeTransport,
  resolveQuicOptions,
  freezeRateLimitSnapshot,
  freezeTransportSnapshot,
  freezeConnectionSnapshot,
  versionToWire,
  wireVersionToName,
  selectWireVersion,
  selectClientInitialWireVersion,
  longHeaderVersion,
  sessionStoreKey,
  now,
  QuicTokenBucket,
  QuicAddressValidationCache,
  writeU64,
  writeI64,
  writeU32,
  writeU8,
  readU64,
  readI64,
  readU32,
  ptrAddress,
  writePtr,
  writePtrIfPresent,
  writeAddress,
  _compatibleVersionLists,
  compatibleVersionList,
  ptrField,
  copyFromPtr,
  _HEX_BYTE,
  cidKey,
  makeCid,
  randomBytes,
  randomCid,
  generateStatelessResetToken,
  generateRegularToken,
  verifyRegularToken,
  isRetryToken,
  cidBytes,
  cidFromPacketHeader,
  readPacketVarint,
  parseInitialTokenHeader,
  packetHeaderFromParsedInitial,
  makePath,
  makePathFromSockaddrs,
  makeOutputPath,
  remoteAddressFromPath,
  localAddressFromPath,
  fdFromPath,
  fdFromNativePath,
  pathSnapshotFromNative,
  pathFromSnapshot,
  pathSnapshotsDiffer,
  pathValidationResultName,
  preferredAddressFromNative,
  cidFromTransportParams,
  transportParameterSnapshot,
  writeNativePathAddress,
  writeNativePathUserData,
  makePacketInfo,
  packetInfoEcn,
  qlogOutputPath,
  writeAllFd,
  appendKeylogLine,
  createServerTlsContext,
  _qlogWriteCallback,
  qlogWriteCallbackPointer,
  congestionControlValue,
  makeSettings,
  makeTransportParams,
  readUserDataId,
  connectionFromUserData,
  _callbackTable,
  _callbackRefs,
  ensureCallbackTable,
  getConnRefPointer,
  __inspectQuicCallbackTable,
  __inspectQuicRuntimeTuning,
  ngtcp2Error,
  QuicConnectionEvent,
  QuicStreamEvent,
  QuicStreamBlockedEvent,
  QuicStreamResetEvent,
  QuicDatagramEvent,
  QuicDatagramStatusEvent,
  QuicNewTokenEvent,
  QuicEarlyDataEvent,
  QuicStopSendingEvent,
  QuicPathValidationEvent,
  QuicErrorEvent,
  QuicVersionNegotiationError,
  CidRoutingTable,
  QuicEndpoint,
  registerQuicListenerClass,
  registerQuicConnectionClass,
} = core;
import { QuicStream } from './stream.ts';
import type { QuicListener } from './listener.ts';
export type PendingWrite = {
  streamId: number;
  data: Uint8Array;
  offset: number;
  fin: boolean;
};
export type PendingDatagram = {
  id: bigint;
  data: Uint8Array;
  attempts: number;
  earlyData: boolean;
};
export type ClosePacket = {
  fd: number;
  data: Uint8Array;
  remoteAddress: QuicAddress;
};
export type PendingSendPacket = {
  fd: number;
  data: Uint8Array;
  remoteAddress: QuicAddress;
  ecn?: number;
};
export type OutstandingStreamData = {
  streamId: number;
  start: number;
  end: number;
  data: Uint8Array;
};
type LocalStreamCreditWaiter = QueueResolver<void> & {
  cleanup(): void;
};
function streamOpenAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? 'The stream open was aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}
function streamOpenSignal(options: core.QuicStreamOpenOptions): AbortSignal | undefined {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('QUIC stream-open options must be an object');
  }
  const signal = options.signal;
  if (
    signal !== undefined &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new TypeError('QUIC stream-open signal must be an AbortSignal');
  }
  return signal;
}
/**
 * A single QUIC connection and the streams multiplexed inside it.
 *
 * Created by `QuicEndpoint.connect()` (client) or accepted on the server side;
 * never constructed directly. It wraps one ngtcp2 connection and exposes its
 * handshake state, negotiated parameters, streams, unreliable DATAGRAMs,
 * migration, key updates, and close. It extends `EventTarget` and emits
 * `'stream'`, `'datagram'`, `'datagramack'`/`'datagramlost'`/
 * `'datagramabandoned'`, `'newtoken'`, `'earlydata'`, `'keyupdate'`,
 * `'pathvalidation'`, `'error'`, and `'close'`.
 *
 * Open application streams with `openBidirectionalStream()` /
 * `openUnidirectionalStream()` and accept peer streams with `acceptStream()`
 * (or the `'stream'` event). Both open methods await stream-limit credit when
 * the peer's stream budget is exhausted. `close()` starts a graceful close that
 * flushes pending stream data; `destroy()` tears the connection down at once.
 *
 * ```ts no_run
 * const conn = await endpoint.connect({ address });
 * const stream = await conn.openBidirectionalStream();
 * await stream.writer.write(new TextEncoder().encode('GET /'));
 * await stream.writer.close();
 * for await (const chunk of stream.readable) process(chunk);
 * await conn.close();
 * ```
 */
export class QuicConnection extends EventTarget {
  /** Stable per-process identifier for this connection (for logging/routing). */
  readonly connectionId: string;
  /** Current remote peer address; updated as the connection migrates paths. */
  remoteAddress: QuicAddress;
  /** Local address this connection is currently using. */
  readonly localAddress: QuicAddress;
  /** ALPN protocols offered for this connection. */
  readonly alpnProtocols: string[];
  /** Connection IDs registered in the endpoint routing table for this connection. */
  readonly routeCids: string[] = [];
  #role: 'client' | 'server';
  #endpoint: QuicEndpoint;
  #listener: QuicListener | null;
  #fd: number;
  #clientTransports = new Map<number, QuicDatagramTransport>();
  #activeLocalAddress: QuicAddress;
  #runtime: QuicRuntime;
  #ctx: QuicTlsContext | null;
  #tls: QuicTlsSession | null;
  #tlsNativeBackend: QuicCryptoBackend | null = null;
  #options: ResolvedQuicOptions;
  #wireVersion = NGTCP2_PROTO_VER_V1;
  #tlsNativeHandle: ArrayBuffer | null = null;
  #originalDcid: ArrayBuffer | null;
  #retryScid: ArrayBuffer | null = null;
  #clientInitialDcid: ArrayBuffer | null = null;
  #localInitialScid: ArrayBuffer | null = null;
  #remoteInitialScid: ArrayBuffer | null = null;
  #validatedToken: Uint8Array | null = null;
  #validatedTokenType = NGTCP2_TOKEN_TYPE_UNKNOWN;
  #conn: ArrayBuffer = new ArrayBuffer(8);
  #userData = new ArrayBuffer(8);
  #connRef = new ArrayBuffer(16);
  #path: ArrayBuffer;
  #localSockaddr: ArrayBuffer;
  #remoteSockaddr: ArrayBuffer;
  #ptrArena = new ArrayBuffer(_PTR_SIZE * 8);
  #ptrSlots = Array.from(
    { length: 8 },
    (_, i) => new Uint8Array(this.#ptrArena, i * _PTR_SIZE, _PTR_SIZE),
  );
  #pathCache = new Map<string, NativePath>();
  #streamQueue = new AsyncQueue<QuicStream>('QUIC connection is closed');
  #incomingStreamHook: ((stream: QuicStream) => void) | null = null;
  #datagramQueue = new ByteQueue();
  #streams = new Map<number, QuicStream>();
  #peerStreamActivity = new Map<number, bigint>();
  #pendingWrites: PendingWrite[] = [];
  #pendingDatagrams: PendingDatagram[] = [];
  #writeVecBuf = new ArrayBuffer(NGTCP2_VEC_SIZE);
  #writeDataLenBuf = new ArrayBuffer(8);
  #writePacketScratch: Uint8Array[] = [];
  #writePacketScratchSize = 0;
  #localStreamCreditWaiters = {
    bidirectional: [] as LocalStreamCreditWaiter[],
    unidirectional: [] as LocalStreamCreditWaiter[],
  };
  #nextStreamOffsets = new Map<number, number>();
  #outstandingStreamData: OutstandingStreamData[] = [];
  #closedStreams = new Map<number, QuicStream>();
  #creditedRemoteStreamCloses = new Set<number>();
  #state: QuicConnectionState = 'connecting';
  #accepted = false;
  #closed = false;
  #gracefulClosing = false;
  #gracefullyClosed = false;
  #gracefulCloseOptions: Required<QuicCloseOptions> | null = null;
  #gracefulClosePromise: Promise<void> | null = null;
  #gracefulCloseResolve: (() => void) | null = null;
  #closedResolve: (() => void) | null = null;
  #closedPromise: Promise<void> = new Promise((resolve) => {
    this.#closedResolve = resolve;
  });
  #closeInfo: QuicCloseInfo | null = null;
  #peerCertificate: Uint8Array | null = null;
  #peerVerification: QuicPeerVerification | null = null;
  #timer: any = null;
  // Targets the currently-armed #timer, for coalescing redundant re-arms.
  // -1n means "nothing armed via #timer".
  #armedExpiry: bigint = -1n;
  #armedIdleDeadline: bigint | null = null;
  #handshakeTimer: any = null;
  #immediateTimerScheduled = false;
  #handshakeWaiters: QueueResolver<void>[] = [];
  #handshakeConfirmed = false;
  #handshakeConfirmedWaiters: QueueResolver<void>[] = [];
  #handshakeError: Error | null = null;
  #handshakeDeferred = false;
  #datagramReadable: ReadableStream<Uint8Array> | null = null;
  #lastDatagramEvent: {
    data: Uint8Array;
    earlyData: boolean;
  } | null = null;
  #nextDatagramId = 1n;
  #preferredAddressParams: PreferredAddressParams | null = null;
  #sessionKey: string | null = null;
  #activePathValidations: Array<{
    path: PathSnapshot | null;
    previousPath: PathSnapshot | null;
    preferredAddress: boolean;
    newToken: boolean;
  }> = [];
  #serverName: string | null = null;
  #clientVerifyPeer = false;
  #requireClientCertificate = false;
  #clientEarlyDataMax = 0;
  #earlyDataReady = false;
  #earlyDataAttempted = false;
  #earlyDataAccepted = false;
  #earlyDataDecision: {
    accepted: boolean;
    reason: string;
  } | null = null;
  #earlyDataDecisionDispatched = false;
  #earlyDataMaxBytes = 0;
  #earlyDataQueuedBytes = 0;
  #writeDrainScheduled = false;
  #writeDrainRemoteAddress: QuicAddress | null = null;
  #writeDrainInProgress = false;
  #writeDrainAgain = false;
  #blockedSend: PendingSendPacket[] = [];
  #blockedSendRetryScheduled = false;
  #sessionTicketScheduled = false;
  #connectionCloseSent = false;
  #closePacket: ClosePacket | null = null;
  #closingPacketsReceived = 0;
  #nextCloseRetransmitThreshold = 1;
  #drainingRetentionMs = CONNECTION_DRAINING_TIMEOUT_MS;
  #qlogFd: number | null = null;
  #qlogOpened = false;
  #statelessResetTokens = new Map<string, string>();
  #readingPacketStartedConnecting = false;
  #versionNegotiationRetried = false;
  #versionNegotiationPendingRetry = false;
  #versionNegotiationVersions: number[] = [];
  #deferredConnectionReceiveCredit = 0;
  #deferredMaxStreamsCredit = {
    bidirectional: 0,
    unidirectional: 0,
  };
  #maxStreamsCreditFlushScheduled = false;
  #stats = {
    createdAt: Date.now(),
    connectedAt: null as number | null,
    handshakeConfirmedAt: null as number | null,
    closingAt: null as number | null,
    destroyedAt: null as number | null,
    bytesReceived: 0,
    bytesSent: 0,
    packetsReceived: 0,
    packetsSent: 0,
    datagramsReceived: 0,
    datagramsSent: 0,
    datagramsAcked: 0,
    datagramsLost: 0,
    datagramsAbandoned: 0,
    streamsOpened: 0,
    streamsReceived: 0,
    bidiIncomingStreams: 0,
    bidiOutgoingStreams: 0,
    uniIncomingStreams: 0,
    uniOutgoingStreams: 0,
    streamsClosed: 0,
    maxBytesInFlight: 0,
    bytesInFlight: 0,
    blockCount: 0,
    congestionWindow: 0,
    latestRttMs: 0,
    minRttMs: 0,
    rttVarianceMs: 0,
    smoothedRttMs: 0,
    slowStartThreshold: 0,
    packetsLost: 0,
    bytesLost: 0,
    pingReceived: 0,
    packetsDiscarded: 0,
    streamsIdleTimedOut: 0,
    qlogOpenFailed: 0,
    qlogWriteFailed: 0,
  };
  constructor(
    role: 'client' | 'server',
    endpoint: QuicEndpoint,
    listener: QuicListener | null,
    localAddress: QuicAddress,
    remoteAddress: QuicAddress,
    alpnProtocols: string[],
    transport: QuicDatagramTransport,
    ctx: QuicTlsContext | null,
    tls: QuicTlsSession,
    originalDcid: ArrayBuffer | null,
    options: ResolvedQuicOptions,
    serverName: string | null = null,
  ) {
    super();
    this.#role = role;
    this.#endpoint = endpoint;
    this.#listener = listener;
    this.#runtime = endpoint[quicEndpointInternals.runtime]();
    this.localAddress = localAddress;
    this.#activeLocalAddress = localAddress;
    this.remoteAddress = remoteAddress;
    this.alpnProtocols = alpnProtocols;
    this.#fd = transport.id;
    this.#ctx = ctx;
    this.#tls = tls;
    this.#requireClientCertificate =
      role === 'server' && listener?.[quicListenerInternals.ctx].clientAuth === 'require';
    this.#serverName = serverName;
    this.#originalDcid = originalDcid;
    this.#options = options;
    const path = this.#retainPath(localAddress, remoteAddress, transport.id);
    this.#path = path.path;
    // Retain sockaddr buffers referenced by #path for the native connection.
    this.#localSockaddr = path.local;
    this.#remoteSockaddr = path.remote;
    this.connectionId = allocateQuicConnectionId(role);
    const id = allocateNativeUserDataId();
    writeU64(this.#userData, 0, BigInt(id));
    _nativeConnections.set(id, this);
    this.#materializeInitialQlog();
  }
  #retainPath(
    localAddress: QuicAddress,
    remoteAddress: QuicAddress,
    fd: number = this.#fd,
  ): NativePath {
    const key = `${addressKey(localAddress)}>${addressKey(remoteAddress)}@${fd}`;
    let path = this.#pathCache.get(key);
    if (path === undefined) {
      path = makePath(localAddress, remoteAddress, fd);
      this.#pathCache.set(key, path);
    }
    return path;
  }
  #retainPathFromMetadata(
    localAddress: QuicAddress,
    remoteAddress: QuicAddress,
    fd: number,
    metadata: QuicDatagramPathMetadata | undefined,
  ): NativePath {
    if (metadata === undefined) return this.#retainPath(localAddress, remoteAddress, fd);
    const key = `${addressKey(localAddress)}>${addressKey(remoteAddress)}@${fd}`;
    let path = this.#pathCache.get(key);
    if (path === undefined) {
      path =
        makePathFromSockaddrs(
          metadata.localSockaddr,
          metadata.localSockaddrLen,
          metadata.remoteSockaddr,
          metadata.remoteSockaddrLen,
          fd,
        ) ?? makePath(localAddress, remoteAddress, fd);
      this.#pathCache.set(key, path);
    }
    return path;
  }
  #ptrOf(source: ArrayBuffer | ArrayBufferView, slot: number): Uint8Array {
    Pointer.of(source, this.#ptrArena, slot * _PTR_SIZE);
    return this.#ptrSlots[slot]!;
  }
  #writePacketBuffer(index: number, size: number): Uint8Array {
    if (this.#writePacketScratchSize !== size) {
      this.#writePacketScratch = [];
      this.#writePacketScratchSize = size;
    }
    let out = this.#writePacketScratch[index];
    if (out === undefined) {
      out = new Uint8Array(size);
      this.#writePacketScratch[index] = out;
    }
    return out;
  }
  #dispatch(event: Event): void {
    deferAfterNativeCallback(() => this.dispatchEvent(event));
  }
  /**
   * Raw ngtcp2 connection pointer, for native callers that drive ngtcp2 directly.
   *
   * @internal
   */
  get nativeHandle(): ArrayBuffer {
    return this.#conn;
  }
  /** The ALPN protocol negotiated with the peer, or the empty string if none. */
  get alpnProtocol(): string {
    return getAlpnSelected(this.#tls);
  }
  /** True once the connection has reached the `'connected'` state. */
  get handshakeComplete(): boolean {
    return this.#state === 'connected';
  }
  /**
   * Negotiated QUIC version for this connection.
   *
   * Returns `v1` or `v2`. Before ngtcp2 reports a negotiated value, this falls
   * back to the local version used to construct the native connection.
   */
  get version(): QuicVersion {
    if (ptrAddress(this.#conn) !== 0n) {
      const negotiated = ngtcp2Sym!.ngtcp2_conn_get_negotiated_version(this.#conn) as number;
      if (negotiated !== 0) return wireVersionToName(negotiated);
    }
    return wireVersionToName(this.#wireVersion);
  }
  /** Lifecycle state: `'connecting'`, `'connected'`, `'closing'`, or `'closed'`. */
  get state(): QuicConnectionState {
    return this.#state;
  }
  /** True once a close has been initiated (locally or by the peer). */
  get closing(): boolean {
    return this.#state === 'closing' || this.#gracefulClosing;
  }
  /** Promise that resolves when the connection has fully closed. */
  get closed(): Promise<void> {
    return this.#closedPromise;
  }
  /** Details of why the connection closed, or `null` while still open. */
  get closeInfo(): QuicCloseInfo | null {
    return this.#closeInfo === null ? null : { ...this.#closeInfo };
  }
  /** The peer's leaf certificate in DER bytes, or `null` if none was presented. */
  get peerCertificate(): Uint8Array | null {
    return this.#peerCertificate === null ? null : this.#peerCertificate.slice();
  }
  /** Result of verifying the peer certificate, or `null` before it is known. */
  get peerVerification(): QuicPeerVerification | null {
    return this.#peerVerification === null ? null : { ...this.#peerVerification };
  }
  /**
   * Export TLS keying material (RFC 5705 exporter) from the connection.
   *
   * Derives `length` bytes bound to this connection's TLS secrets under the
   * given `label` and context — useful for channel binding or deriving
   * application keys. Throws if the connection is not yet connected.
   *
   * ```ts no_run
   * const key = conn.exportKeyingMaterial('EXPORTER-my-app', new Uint8Array(), 32);
   * ```
   */
  exportKeyingMaterial(label: string, context: Uint8Array, length: number): ArrayBuffer {
    if (this.#state !== 'connected') throw new Error('QUIC connection is not connected');
    return exportTlsKeyingMaterial(this.#tls, label, context, length);
  }
  [quicConnectionInternals.isClosedForInternalUse](): boolean {
    return this.#closed;
  }
  /** Decoded transport parameters this side advertised, or `null` before setup. */
  get localTransportParameters(): QuicTransportParameterSnapshot | null {
    if (ptrAddress(this.#conn) === 0n) return null;
    return this.#withInitialSourceConnectionId(
      transportParameterSnapshot(
        ngtcp2Sym!.ngtcp2_conn_get_local_transport_params(this.#conn) as ArrayBuffer | null,
      ),
      this.#localInitialScid,
    );
  }
  /** Decoded transport parameters the peer advertised, or `null` before they arrive. */
  get remoteTransportParameters(): QuicTransportParameterSnapshot | null {
    if (ptrAddress(this.#conn) === 0n) return null;
    return this.#withInitialSourceConnectionId(
      transportParameterSnapshot(
        ngtcp2Sym!.ngtcp2_conn_get_remote_transport_params(this.#conn) as ArrayBuffer | null,
      ),
      this.#remoteInitialScid,
    );
  }
  #withInitialSourceConnectionId(
    snapshot: QuicTransportParameterSnapshot | null,
    cid: ArrayBuffer | null,
  ): QuicTransportParameterSnapshot | null {
    if (snapshot === null || snapshot.initialSourceConnectionId !== null || cid === null)
      return snapshot;
    return Object.freeze({
      ...snapshot,
      initialSourceConnectionId: cidBytes(cid),
    });
  }
  /** Frozen snapshot of this connection's counters and live recovery metrics. */
  get stats(): QuicConnectionStats {
    this.#refreshNativeDataStats();
    const send = this[quicConnectionInternals.inspectSendState]();
    return Object.freeze({
      ...this.#stats,
      pendingWriteBytes: send.pendingWriteBytes,
      outstandingStreamBytes: send.outstandingStreamBytes,
    });
  }
  #refreshNativeDataStats(): void {
    if (this.#closed || ptrAddress(this.#conn) === 0n) return;
    const info = new ArrayBuffer(NGTCP2_CONN_INFO_SIZE);
    ngtcp2Sym!.ngtcp2_conn_get_conn_info_versioned(
      this.#conn,
      NGTCP2_CONN_INFO_VERSION,
      Pointer.of(info),
    );
    const bytesInFlight = Number(readU64(info, CONN_INFO_BYTES_IN_FLIGHT));
    this.#stats.bytesInFlight = bytesInFlight;
    this.#stats.maxBytesInFlight = Math.max(this.#stats.maxBytesInFlight, bytesInFlight);
    this.#stats.congestionWindow = Number(readU64(info, CONN_INFO_CWND));
    this.#stats.latestRttMs = nsToMs(readU64(info, CONN_INFO_LATEST_RTT));
    this.#stats.minRttMs = nsToMs(readU64(info, CONN_INFO_MIN_RTT));
    this.#stats.rttVarianceMs = nsToMs(readU64(info, CONN_INFO_RTTVAR));
    this.#stats.smoothedRttMs = nsToMs(readU64(info, CONN_INFO_SMOOTHED_RTT));
    this.#stats.slowStartThreshold = Number(readU64(info, CONN_INFO_SSTHRESH));
    this.#stats.packetsSent = Math.max(
      this.#stats.packetsSent,
      Number(readU64(info, CONN_INFO_PKT_SENT)),
    );
    this.#stats.bytesSent = Math.max(
      this.#stats.bytesSent,
      Number(readU64(info, CONN_INFO_BYTES_SENT)),
    );
    this.#stats.packetsReceived = Math.max(
      this.#stats.packetsReceived,
      Number(readU64(info, CONN_INFO_PKT_RECV)),
    );
    this.#stats.bytesReceived = Math.max(
      this.#stats.bytesReceived,
      Number(readU64(info, CONN_INFO_BYTES_RECV)),
    );
    this.#stats.packetsLost = Number(readU64(info, CONN_INFO_PKT_LOST));
    this.#stats.bytesLost = Number(readU64(info, CONN_INFO_BYTES_LOST));
    this.#stats.pingReceived = Number(readU64(info, CONN_INFO_PING_RECV));
    this.#stats.packetsDiscarded = Number(readU64(info, CONN_INFO_PKT_DISCARDED));
  }
  [quicConnectionInternals.roleForStats](): 'client' | 'server' {
    return this.#role;
  }
  [quicConnectionInternals.wireVersionForRouting](): number {
    return this.#wireVersion;
  }
  [quicConnectionInternals.validationTokenTypeForRouting](): number {
    return this.#validatedTokenType;
  }
  [quicConnectionInternals.drainingRetentionMsForRouting](): number {
    return this.#drainingRetentionMs;
  }
  [quicConnectionInternals.canReceiveWithoutDecodedAddress](): boolean {
    return (
      this.#state !== 'connecting' &&
      !this.#options.migration.enabled &&
      this.#options.migration.preferredAddress === undefined &&
      this.#activePathValidations.length === 0
    );
  }
  [quicConnectionInternals.matchesServerConnection](
    listener?: QuicListener,
    remoteAddress?: QuicAddress,
  ): boolean {
    if (this.#closed || this.#role !== 'server') return false;
    if (listener !== undefined && this.#listener !== listener) return false;
    if (remoteAddress !== undefined && this.remoteAddress.ip !== remoteAddress.ip) return false;
    return true;
  }
  /**
   * Readable stream of received QUIC DATAGRAM payloads.
   *
   * The stream is available only when DATAGRAM support was enabled and
   * negotiated. Payloads are unreliable and unordered by protocol design.
   */
  get datagrams(): ReadableStream<Uint8Array> {
    if (this.#datagramReadable !== null) return this.#datagramReadable;
    this.#datagramReadable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const result = await this.#datagramQueue.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      cancel: () => this.#datagramQueue.close(),
    });
    return this.#datagramReadable;
  }
  /** Alias for `datagrams`; the same received-DATAGRAM `ReadableStream`. */
  get datagramReadable(): ReadableStream<Uint8Array> {
    return this.datagrams;
  }
  /**
   * Return the most recent received DATAGRAM event payload for tests.
   *
   * @internal
   */
  [quicConnectionInternals.inspectLastDatagramEvent](): {
    data: Uint8Array;
    earlyData: boolean;
  } | null {
    if (this.#lastDatagramEvent === null) return null;
    return {
      data: this.#lastDatagramEvent.data.slice(),
      earlyData: this.#lastDatagramEvent.earlyData,
    };
  }
  /**
   * Return native send-queue state for flow-control conformance tests.
   *
   * @internal
   */
  [quicConnectionInternals.inspectSendState](): {
    pendingWriteCount: number;
    pendingWriteBytes: number;
    outstandingStreamBytes: number;
  } {
    let pendingWriteBytes = 0;
    for (const pending of this.#pendingWrites) {
      pendingWriteBytes += Math.max(0, pending.data.byteLength - pending.offset);
    }
    let outstandingStreamBytes = 0;
    for (const entry of this.#outstandingStreamData) {
      outstandingStreamBytes += Math.max(0, entry.end - entry.start);
    }
    return {
      pendingWriteCount: this.#pendingWrites.length,
      pendingWriteBytes,
      outstandingStreamBytes,
    };
  }
  /**
   * Send a transport CONNECTION_CLOSE frame to the peer.
   *
   * @internal
   */
  [quicConnectionInternals.injectTransportCloseForTest](
    liberr = NGTCP2_ERR_STREAM_DATA_BLOCKED,
  ): void {
    if (this.#closed || this.#state !== 'connected')
      throw new Error('QUIC connection is not connected');
    this.#writeConnectionClose(liberr, this.remoteAddress);
  }
  /**
   * Wait for and return the next stream the peer opens on this connection.
   *
   * Resolves in FIFO order as peer-initiated streams arrive; an alternative to
   * the `'stream'` event. The promise rejects if the connection closes while
   * waiting.
   *
   * ```ts no_run
   * for (;;) {
   *   const stream = await conn.acceptStream();
   *   serve(stream);
   * }
   * ```
   */
  acceptStream(): Promise<QuicStream> {
    return this.#streamQueue.shift();
  }
  // Internal fast path for the h3 drivers: when set, incoming streams are handed
  // straight to this callback (deferred past the native callback) instead of
  // allocating a QuicStreamEvent, dispatching through EventTarget, and buffering
  // in #streamQueue (which the h3 drivers never drain via acceptStream). Setting
  // it drains any streams that were queued before installation so none are lost.
  // The public 'stream' event + acceptStream() path is used only when unset.
  get [quicIncomingStreamHook](): ((stream: QuicStream) => void) | null {
    return this.#incomingStreamHook;
  }
  set [quicIncomingStreamHook](hook: ((stream: QuicStream) => void) | null) {
    this.#incomingStreamHook = hook;
    if (hook !== null) {
      const backlog = this.#streamQueue.drainBuffered();
      for (const stream of backlog) hook(stream);
    }
  }
  [quicConnectionInternals.isLocalUnidirectionalStream](streamId: number): boolean {
    return this.#streamIsUnidirectional(streamId) && this.#streamInitiatedByLocal(streamId);
  }
  [quicConnectionInternals.openBidirectionalStreamSync](): QuicStream {
    if (!this.#canOpenApplicationStream()) throw new Error('QUIC connection is not connected');
    const stream = this.#tryOpenLocalStream('bidirectional');
    if (typeof stream === 'number') throw ngtcp2Error(stream, 'ngtcp2_conn_open_bidi_stream');
    return stream;
  }
  /**
   * Open a locally initiated bidirectional stream, awaiting credit if needed.
   *
   * If the peer's bidirectional stream limit is currently exhausted, the promise
   * waits until the peer extends stream credit and then opens the stream, rather
   * than failing. Pass an `AbortSignal` to cancel that wait. The connection's
   * `maxPendingStreamOpens` limit bounds blocked calls across both directions.
   * Rejects if the connection is closing or not connected, the signal aborts,
   * the pending limit is reached, or ngtcp2 reports a non-recoverable open error.
   *
   * ```ts no_run
   * const stream = await conn.openBidirectionalStream({ signal });
   * await stream.writer.write(payload);
   * ```
   */
  async openBidirectionalStream(options: core.QuicStreamOpenOptions = {}): Promise<QuicStream> {
    const signal = streamOpenSignal(options);
    if (signal?.aborted) throw streamOpenAbortError(signal.reason);
    if (this.#gracefulClosing || this.#gracefullyClosed)
      throw new Error('QUIC connection is closing');
    if (!this.#canOpenApplicationStream()) throw new Error('QUIC connection is not connected');
    for (;;) {
      const stream = this.#tryOpenLocalStream('bidirectional');
      if (typeof stream !== 'number') {
        return stream;
      }
      if (stream !== NGTCP2_ERR_STREAM_ID_BLOCKED)
        throw ngtcp2Error(stream, 'ngtcp2_conn_open_bidi_stream');
      await this.#waitForLocalStreamCredit('bidirectional', signal);
      if (signal?.aborted) throw streamOpenAbortError(signal.reason);
    }
  }
  [quicConnectionInternals.openUnidirectionalStreamSync](): QuicStream {
    if (this.#gracefulClosing || this.#gracefullyClosed)
      throw new Error('QUIC connection is closing');
    if (!this.#canOpenApplicationStream()) throw new Error('QUIC connection is not connected');
    const stream = this.#tryOpenLocalStream('unidirectional');
    if (typeof stream === 'number') throw ngtcp2Error(stream, 'ngtcp2_conn_open_uni_stream');
    return stream;
  }
  /**
   * Open a locally initiated send-only (unidirectional) stream.
   *
   * Behaves like `openBidirectionalStream()` but produces a stream whose
   * readable side is closed — only `writer` is usable. Awaits unidirectional
   * stream credit when the peer's limit is exhausted and accepts the same
   * cancellation and pending-queue controls.
   *
   * ```ts no_run
   * const stream = await conn.openUnidirectionalStream();
   * await stream.writer.write(payload);
   * await stream.writer.close();
   * ```
   */
  async openUnidirectionalStream(options: core.QuicStreamOpenOptions = {}): Promise<QuicStream> {
    const signal = streamOpenSignal(options);
    if (signal?.aborted) throw streamOpenAbortError(signal.reason);
    if (this.#gracefulClosing || this.#gracefullyClosed)
      throw new Error('QUIC connection is closing');
    if (!this.#canOpenApplicationStream()) throw new Error('QUIC connection is not connected');
    for (;;) {
      const stream = this.#tryOpenLocalStream('unidirectional');
      if (typeof stream !== 'number') {
        return stream;
      }
      if (stream !== NGTCP2_ERR_STREAM_ID_BLOCKED)
        throw ngtcp2Error(stream, 'ngtcp2_conn_open_uni_stream');
      await this.#waitForLocalStreamCredit('unidirectional', signal);
      if (signal?.aborted) throw streamOpenAbortError(signal.reason);
    }
  }
  #tryOpenLocalStream(direction: 'bidirectional' | 'unidirectional'): QuicStream | number {
    const out = new ArrayBuffer(8);
    const rc =
      direction === 'bidirectional'
        ? (ngtcp2Sym!.ngtcp2_conn_open_bidi_stream(this.#conn, Pointer.of(out), null) as number)
        : (ngtcp2Sym!.ngtcp2_conn_open_uni_stream(this.#conn, Pointer.of(out), null) as number);
    if (rc !== 0) return rc;
    const id = Number(readU64(out, 0));
    return this.#ensureStream(id, direction, false);
  }
  #waitForLocalStreamCredit(
    direction: 'bidirectional' | 'unidirectional',
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('QUIC connection is closed'));
    const pendingCount =
      this.#localStreamCreditWaiters.bidirectional.length +
      this.#localStreamCreditWaiters.unidirectional.length;
    if (pendingCount >= this.#options.connection.maxPendingStreamOpens) {
      return Promise.reject(
        new Error(
          `QUIC pending stream-open limit exceeded (${this.#options.connection.maxPendingStreamOpens})`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const queue = this.#localStreamCreditWaiters[direction];
      const onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index !== -1) queue.splice(index, 1);
        waiter.reject(streamOpenAbortError(signal?.reason));
      };
      const waiter: LocalStreamCreditWaiter = {
        resolve(value) {
          waiter.cleanup();
          resolve(value);
        },
        reject(error) {
          waiter.cleanup();
          reject(error);
        },
        cleanup() {
          signal?.removeEventListener('abort', onAbort);
        },
      };
      queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  #streamInitiatedByLocal(streamId: number): boolean {
    const initiator = streamId & 1;
    return this.#role === 'client' ? initiator === 0 : initiator === 1;
  }
  #streamIsUnidirectional(streamId: number): boolean {
    return (streamId & 2) !== 0;
  }
  /**
   * Initiate a local QUIC key update.
   *
   * Throws if the connection is not connected or ngtcp2 reports that the update
   * is not currently legal, for example before enough 1-RTT traffic has flowed.
   */
  initiateKeyUpdate(): void {
    if (this.#state !== 'connected') throw new Error('QUIC connection is not connected');
    const rc = ngtcp2Sym!.ngtcp2_conn_initiate_key_update(this.#conn, now(this.#runtime)) as number;
    if (rc !== 0) throw ngtcp2Error(rc, 'ngtcp2_conn_initiate_key_update');
    publishQuicTopic('quic.session.update.key', { connection: this });
    this.#dispatch(new Event('keyupdate'));
    this.#scheduleWriteDrain();
  }
  /**
   * Actively migrate a client connection to a new local UDP address.
   *
   * This binds a new UDP socket, asks ngtcp2 to validate migration to the new
   * path, and then keeps both sockets readable while validation completes.
   */
  async migrate(address: QuicAddress): Promise<void> {
    if (this.#role !== 'client')
      throw new Error('QUIC active migration is only available on client connections');
    if (this.#state !== 'connected') throw new Error('QUIC connection is not connected');
    if (!this.#options.migration.enabled)
      throw new Error('QUIC migration is not enabled for this connection');
    await this.#waitHandshakeConfirmed();
    const requested = normalizeAddress(address);
    if (requested.family !== this.remoteAddress.family) {
      throw new TypeError(
        'QUIC migration local address family must match the remote address family',
      );
    }
    const transport = await this.#endpoint[quicEndpointInternals.bindTransport](requested, {
      ecn: this.#options.transport.ecn,
    });
    let adopted = false;
    try {
      const local = transport.address;
      const path = this.#retainPath(local, this.remoteAddress, transport.id);
      const rc = ngtcp2Sym!.ngtcp2_conn_initiate_migration(
        this.#conn,
        Pointer.of(path.path),
        now(this.#runtime),
      ) as number;
      if (rc !== 0) throw ngtcp2Error(rc, 'ngtcp2_conn_initiate_migration');
      this[quicConnectionInternals.startSocketLoop](transport, local);
      adopted = true;
      this.#scheduleWriteDrain();
    } catch (error) {
      if (!adopted) {
        this.#endpoint[quicEndpointInternals.unregisterTransport](transport);
        transport.close();
      }
      throw error;
    }
  }
  /**
   * Send one unreliable QUIC DATAGRAM payload.
   *
   * Rejects for local validation failures such as disabled DATAGRAM support,
   * disconnected state, oversized payloads, or missing peer DATAGRAM
   * negotiation. Zero-length payloads are valid RFC 9221 DATAGRAM frames.
   * Transient send pressure is handled by the local
   * queue; queued DATAGRAMs later surface `datagramack`, `datagramlost`, or
   * `datagramabandoned` events.
   */
  async sendDatagram(
    data: QuicDatagramSource,
    encoding: QuicDatagramEncoding = 'utf8',
  ): Promise<number> {
    if (this.#gracefulClosing || this.#gracefullyClosed)
      throw new Error('QUIC connection is closing');
    const payload = normalizeDatagramSource(await data, encoding);
    const earlyData = this.#state !== 'connected';
    if (earlyData) {
      if (this.#role !== 'client' || this.#state !== 'connecting' || !this.#earlyDataReady) {
        throw new Error('QUIC connection is not connected');
      }
    }
    if (!this.#options.datagrams.enabled)
      throw new Error('QUIC DATAGRAM is not enabled for this connection');
    if (payload.byteLength > this.#options.datagrams.maxFrameSize) {
      throw new RangeError(
        `QUIC DATAGRAM size ${payload.byteLength} exceeds maxFrameSize ${this.#options.datagrams.maxFrameSize}`,
      );
    }
    if (earlyData) this.#reserveEarlyDataBytes(payload.byteLength);
    if (earlyData) this.#startDeferredHandshake();
    const peerMaxPayload = this.#peerMaxDatagramPayload();
    if (peerMaxPayload === 0) {
      throw new Error('peer did not negotiate QUIC DATAGRAM support');
    }
    if (payload.byteLength > peerMaxPayload) {
      throw new RangeError(
        `QUIC DATAGRAM size ${payload.byteLength} exceeds peer maxDatagramPayload ${peerMaxPayload}`,
      );
    }
    const id = this.#nextDatagramId++;
    if (
      this.#options.datagrams.maxPending > 0 &&
      this.#pendingDatagrams.length >= this.#options.datagrams.maxPending
    ) {
      if (this.#options.datagrams.dropPolicy === 'drop-oldest') {
        const dropped = this.#pendingDatagrams.shift();
        if (dropped !== undefined)
          this[quicConnectionInternals.onDatagramStatus](Number(dropped.id), 'abandoned');
      } else {
        this[quicConnectionInternals.onDatagramStatus](Number(id), 'abandoned');
        return Number(id);
      }
    }
    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);
    this.#syncActivePathFromNative();
    this.#pendingDatagrams.push({
      id,
      data: copy,
      attempts: 0,
      earlyData,
    });
    this.#startDeferredHandshake();
    this.#scheduleWriteDrain();
    return Number(id);
  }
  #writePendingDatagram(
    outPath: NativePath,
    out: Uint8Array,
    ts: bigint,
    pktInfo: ArrayBuffer | null,
  ): number {
    for (;;) {
      const pending = this.#pendingDatagrams[0];
      if (pending === undefined) return 0;
      if (pending.attempts >= this.#options.datagrams.maxSendAttempts) {
        this.#pendingDatagrams.shift();
        this[quicConnectionInternals.onDatagramStatus](Number(pending.id), 'abandoned');
        continue;
      }
      const accepted = new ArrayBuffer(4);
      const n = Number(
        ngtcp2Sym!.ngtcp2_conn_write_datagram_versioned(
          this.#conn,
          Pointer.of(outPath.path),
          NGTCP2_PKT_INFO_VERSION,
          pktInfo === null ? null : Pointer.of(pktInfo),
          out,
          out.byteLength,
          Pointer.of(accepted),
          NGTCP2_WRITE_DATAGRAM_FLAG_NONE,
          pending.id,
          pending.data,
          pending.data.byteLength,
          ts,
        ),
      );
      const acceptedDatagram = new DataView(accepted).getInt32(0, true) !== 0;
      if (acceptedDatagram) {
        this.#pendingDatagrams.shift();
        this.#stats.datagramsSent++;
        publishQuicTopic('quic.session.send.datagram', {
          connection: this,
          id: Number(pending.id),
          length: pending.data.byteLength,
          earlyData: pending.earlyData,
        });
      }
      if (n === 0) {
        if (!acceptedDatagram && pending.earlyData && this.#state === 'connecting') return 0;
        if (!acceptedDatagram) pending.attempts++;
        if (pending.attempts >= this.#options.datagrams.maxSendAttempts) {
          this.#pendingDatagrams.shift();
          this[quicConnectionInternals.onDatagramStatus](Number(pending.id), 'abandoned');
          continue;
        }
      }
      if (n === NGTCP2_ERR_INVALID_STATE) {
        if (pending.earlyData && this.#state === 'connecting') return 0;
        this.#pendingDatagrams.shift();
        this[quicConnectionInternals.onDatagramStatus](Number(pending.id), 'abandoned');
        continue;
      }
      return n;
    }
  }
  #hasPendingDatagrams(): boolean {
    return this.#pendingDatagrams.length > 0;
  }
  #nextDatagramOnlyPacket(
    outPath: NativePath,
    out: Uint8Array,
    ts: bigint,
    pktInfo: ArrayBuffer | null,
  ): number {
    const n = this.#writePendingDatagram(outPath, out, ts, pktInfo);
    if (n !== 0 || !this.#hasPendingDatagrams()) return n;
    return Number(
      ngtcp2Sym!.ngtcp2_conn_write_pkt_versioned(
        this.#conn,
        Pointer.of(outPath.path),
        NGTCP2_PKT_INFO_VERSION,
        pktInfo === null ? null : Pointer.of(pktInfo),
        out,
        out.byteLength,
        ts,
      ),
    );
  }
  #queueWrittenPacket(
    batch: PendingSendPacket[],
    n: number,
    outPath: NativePath,
    fallbackRemoteAddress: QuicAddress,
    out: Uint8Array,
    ts: bigint,
    pktInfo: ArrayBuffer | null,
  ): void {
    if (n <= 0) return;
    const output = this.#outputFromPathForPacket(outPath, fallbackRemoteAddress);
    batch.push({
      fd: output.fd,
      data: out.subarray(0, n),
      remoteAddress: output.remoteAddress,
      ecn: packetInfoEcn(pktInfo),
    });
    ngtcp2Sym!.ngtcp2_conn_update_pkt_tx_time(this.#conn, ts);
  }
  #discardPendingDatagrams(): void {
    while (this.#pendingDatagrams.length > 0) {
      const pending = this.#pendingDatagrams.shift()!;
      this[quicConnectionInternals.onDatagramStatus](Number(pending.id), 'abandoned');
    }
  }
  #peerMaxDatagramPayload(): number {
    const params = ngtcp2Sym!.ngtcp2_conn_get_remote_transport_params(
      this.#conn,
    ) as ArrayBuffer | null;
    if (params === null || ptrAddress(params) === 0n) return 0;
    const maxFrameSize = Number(Pointer.readU64(params, TP_MAX_DATAGRAM_FRAME_SIZE));
    return maxDatagramPayload(maxFrameSize);
  }
  /**
   * Gracefully close the connection, flushing pending stream data first.
   *
   * Marks the connection closing, closes the writable side of local streams, and
   * once outstanding data is acknowledged sends a CONNECTION_CLOSE with the given
   * `QuicCloseOptions`. The returned promise resolves when the connection has
   * fully closed. Idempotent — repeat calls return the in-flight close promise.
   * Use `destroy()` to close immediately without draining.
   *
   * ```ts no_run
   * await conn.close({ errorCode: 0, reason: 'done' });
   * ```
   */
  async close(options: QuicCloseOptions = {}): Promise<void> {
    const closeOptions = normalizeCloseOptions(options);
    if (this.#closed || this.#state === 'closed') return this.#closedPromise;
    if (this.#gracefulClosePromise !== null) return this.#gracefulClosePromise;
    this.#gracefulClosing = true;
    this.#gracefulCloseOptions = closeOptions;
    this.#gracefulClosePromise = new Promise((resolve) => {
      this.#gracefulCloseResolve = resolve;
    });
    publishQuicTopic('quic.session.closing', {
      connection: this,
      errorCode: closeOptions.errorCode,
      reason: closeOptions.reason,
      graceful: true,
    });
    this.#state = 'closing';
    if (this.#stats.closingAt === null) this.#stats.closingAt = Date.now();
    this.#closeWritableStreamsForGracefulClose();
    this.#maybeFinishGracefulClose();
    return this.#gracefulClosePromise;
  }
  /**
   * Immediately tear down the connection.
   *
   * Sends a CONNECTION_CLOSE where possible and transitions straight to closed
   * without waiting for streams to drain. When `error` is given it is attached
   * as the connection's close cause and surfaces on the `'error'` event. This is
   * the abrupt counterpart to `close()`.
   *
   * ```ts no_run
   * conn.destroy(new Error('protocol violation'), { errorCode: 1, type: 'application' });
   * ```
   */
  destroy(error?: Error, options: QuicCloseOptions = {}): void {
    const closeOptions = normalizeCloseOptions(options);
    this.#closeInfo = {
      errorCode: closeOptions.errorCode,
      reason: closeOptions.reason,
      type: closeOptions.type,
      remote: false,
    };
    void this.#close(closeOptions.errorCode, closeOptions.reason, true, error, closeOptions.type);
  }
  async #close(
    errorCode: number,
    reason: string,
    sendConnectionClose: boolean,
    closeError?: Error,
    type: 'transport' | 'application' = 'application',
  ): Promise<void> {
    if (this.#closed || this.#state === 'closed') return;
    if (this.#closeInfo === null) {
      this.#closeInfo = {
        errorCode,
        reason,
        type,
        remote: closeError !== undefined,
      };
    }
    const canSendConnectionClose =
      sendConnectionClose && ptrAddress(this.#conn) !== 0n && !this.#connectionCloseSent;
    publishQuicTopic('quic.session.closing', {
      connection: this,
      errorCode,
      reason,
    });
    this.#state = 'closing';
    if (this.#stats.closingAt === null) this.#stats.closingAt = Date.now();
    this.#abortActivePathValidations();
    if (canSendConnectionClose) {
      if (type === 'transport') this.#writeTransportConnectionClose(errorCode, reason);
      else this.#writeApplicationConnectionClose(errorCode, reason);
    }
    this.#closed = true;
    if (this.#timer !== null) this.#timer.cancel?.();
    this.#timer = null;
    this.#armedExpiry = -1n;
    if (this.#handshakeTimer !== null) this.#handshakeTimer.cancel?.();
    this.#handshakeTimer = null;
    if (
      this.#role === 'client' &&
      this.#tls !== null &&
      this.#tls.backend === 'ossl' &&
      this.#sessionKey !== null &&
      this.#options.sessionStore !== undefined
    ) {
      const ticket = exportSession(this.#tls);
      if (ticket !== null && ticket.byteLength > 0) {
        await this.#saveSessionTicket(ticket, false);
      }
    }
    this.#streamQueue.close(new Error('QUIC connection is closed'));
    this.#datagramQueue.close();
    const connectionCloseError = new Error('QUIC connection is closed');
    const streamCreditError = new Error('QUIC connection is closed');
    const handshakeWaiters = this.#handshakeWaiters.splice(0);
    for (const waiter of handshakeWaiters) waiter.reject(connectionCloseError);
    for (const direction of ['bidirectional', 'unidirectional'] as const) {
      const waiters = this.#localStreamCreditWaiters[direction].splice(0);
      for (const waiter of waiters) waiter.reject(streamCreditError);
    }
    const handshakeConfirmedWaiters = this.#handshakeConfirmedWaiters.splice(0);
    for (const waiter of handshakeConfirmedWaiters) waiter.reject(connectionCloseError);
    for (const stream of Array.from(this.#streams.values()))
      stream[quicStreamInternals.closeFromConnection](connectionCloseError);
    this.#pendingWrites.length = 0;
    this.#discardPendingDatagrams();
    this.#nextStreamOffsets.clear();
    this.#peerStreamActivity.clear();
    this.#outstandingStreamData.length = 0;
    this.#creditedRemoteStreamCloses.clear();
    this.#blockedSend = [];
    if (ptrAddress(this.#conn) !== 0n) {
      this.#drainingRetentionMs = this.#computeDrainingRetentionMs();
      ngtcp2Sym!.ngtcp2_conn_del(this.#conn);
      this.#conn = new ArrayBuffer(8);
    }
    this.#finalizeQlog();
    this.#pathCache.clear();
    for (const token of this.#statelessResetTokens.values()) {
      this.#endpoint[quicEndpointInternals.unregisterStatelessResetToken](token, this);
    }
    this.#statelessResetTokens.clear();
    if (this.#tlsNativeHandle !== null && this.#tlsNativeBackend !== null) {
      freeNativeHandle(this.#tlsNativeBackend, this.#tlsNativeHandle);
      this.#tlsNativeHandle = null;
      this.#tlsNativeBackend = null;
    }
    if (this.#tls !== null) {
      if (this.#tls.backend !== 'gnutls') setSessionTicketCallback(this.#tls, null);
      clearConnectionRef(this.#tls);
      freeSession(this.#tls);
      this.#tls = null;
    }
    if (this.#ctx !== null) {
      freeContext(this.#ctx);
      this.#ctx = null;
    }
    if (this.#role === 'client') {
      const transports = Array.from(this.#clientTransports.values());
      this.#clientTransports.clear();
      for (const transport of transports) {
        this.#endpoint[quicEndpointInternals.unregisterTransport](transport);
        transport.close();
      }
    }
    _nativeConnections.delete(Number(readU64(this.#userData, 0)));
    this.#state = 'closed';
    this.#gracefulClosing = false;
    this.#gracefulCloseOptions = null;
    this.#stats.destroyedAt = Date.now();
    this.#gracefulCloseResolve?.();
    this.#gracefulCloseResolve = null;
    this.#closedResolve?.();
    this.#closedResolve = null;
    publishQuicTopic('quic.session.closed', {
      connection: this,
      error: closeError,
      stats: this.stats,
      closeInfo: this.closeInfo,
    });
    this.#dispatch(new Event('close'));
  }
  #closeWritableStreamsForGracefulClose(): void {
    for (const stream of Array.from(this.#streams.values())) {
      if (
        !stream[quicStreamInternals.writerClosed]() &&
        stream[quicStreamInternals.hasWritableSide]()
      ) {
        void stream.writer.close().catch(() => {});
      }
    }
  }
  #maybeFinishGracefulClose(): void {
    if (!this.#gracefulClosing || this.#closed || this.#gracefulCloseOptions === null) return;
    if (
      this.#pendingWrites.length > 0 ||
      this.#pendingDatagrams.length > 0 ||
      this.#blockedSend.length > 0
    ) {
      this.#scheduleWriteDrain();
      return;
    }
    if (this.#streams.size > 0) return;
    const options = this.#gracefulCloseOptions;
    this.#gracefullyClosed = true;
    deferAfterNativeCallback(() => {
      void this.#close(options.errorCode, options.reason, true, undefined, options.type);
    });
  }
  #computeDrainingRetentionMs(): number {
    if (ptrAddress(this.#conn) === 0n) return CONNECTION_DRAINING_TIMEOUT_MS;
    let pto = ngtcp2Sym!.ngtcp2_conn_get_pto(this.#conn) as bigint;
    if (pto <= 0n && this.#options.connection.initialRtt > 0n)
      pto = this.#options.connection.initialRtt;
    if (pto <= 0n) return CONNECTION_DRAINING_TIMEOUT_MS;
    const retentionNs = BigInt(this.#options.connection.drainingPeriodMultiplier) * pto;
    if (retentionNs <= 0n) return 1;
    return Math.max(1, Math.ceil(Number(retentionNs) / 1e6));
  }
  #closeFromTransport(
    errorCode = 0,
    reason = '',
    closeError?: Error,
    type: 'transport' | 'application' = 'transport',
    remote = closeError !== undefined,
  ): void {
    const handleError = (error: unknown) => {
      if (!this.#closed) {
        this.#dispatch(
          new QuicErrorEvent('error', {
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        );
      }
    };
    try {
      if (remote && this.#closeInfo === null) {
        this.#closeInfo = {
          errorCode,
          reason,
          type,
          remote: true,
        };
      }
      Promise.resolve(this.#close(errorCode, reason, false, closeError, type)).catch(handleError);
    } catch (error) {
      handleError(error);
    }
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  [quicConnectionInternals.setSessionStoreKey](key: string): void {
    this.#sessionKey = key;
  }
  [quicConnectionInternals.setClientSessionOptions](
    verifyPeer: boolean,
    earlyDataMax: number,
  ): void {
    this.#clientVerifyPeer = verifyPeer;
    this.#clientEarlyDataMax = Math.max(0, Math.floor(earlyDataMax));
  }
  [quicConnectionInternals.closeForCompatibleVersionUpgrade](): void {
    this.#closeFromTransport();
    this.#endpoint[quicEndpointInternals.forgetConnectionRoutes](this);
  }
  [quicConnectionInternals.setAddressValidationToken](token: Uint8Array, tokenType: number): void {
    this.#validatedToken = token.slice();
    this.#validatedTokenType = tokenType;
  }
  [quicConnectionInternals.setEarlyDataDiagnostics](attempted: boolean, accepted: boolean): void {
    this.#earlyDataAttempted = attempted;
    this.#earlyDataAccepted = accepted;
  }
  [quicConnectionInternals.setEarlyDataReady](ready: boolean, maxBytes: number): void {
    this.#earlyDataReady = ready;
    this.#earlyDataMaxBytes = Math.max(0, Math.floor(maxBytes));
    this.#earlyDataQueuedBytes = 0;
  }
  [quicConnectionInternals.deferHandshakeForEarlyData](): void {
    if (this.#role !== 'client' || this.#state !== 'connecting' || !this.#earlyDataReady) return;
    this.#handshakeDeferred = true;
    if (this.#handshakeTimer !== null) this.#handshakeTimer.cancel?.();
    this.#handshakeTimer = null;
  }
  #startDeferredHandshake(): void {
    if (!this.#handshakeDeferred) return;
    this.#handshakeDeferred = false;
    this.#scheduleHandshakeTimeout();
    this.#scheduleWriteDrain();
  }
  addEventListener(type: string, callback: any, options?: any): void {
    super.addEventListener(type, callback, options);
    if (String(type) !== 'earlydata' || callback === null) return;
    if (typeof callback !== 'function' && typeof callback?.handleEvent !== 'function') return;
    if (options != null && typeof options === 'object' && options.signal?.aborted) return;
    const decision = this.#earlyDataDecision;
    if (!this.#earlyDataDecisionDispatched || decision === null) return;
    const once = options != null && typeof options === 'object' ? Boolean(options.once) : false;
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const signal = options != null && typeof options === 'object' ? options.signal : undefined;
    this.#runtime.defer(() => {
      if (this.#closed || signal?.aborted) return;
      const event = new QuicEarlyDataEvent('earlydata', {
        accepted: decision.accepted,
        rejected: !decision.accepted,
        reason: decision.reason,
      });
      try {
        if (typeof callback === 'function') {
          callback.call(this, event);
        } else {
          callback.handleEvent(event);
        }
      } catch (_) {}
      if (once) this.removeEventListener('earlydata', callback, { capture });
    });
  }
  [quicConnectionInternals.scheduleEarlyDataEvent](accepted: boolean, reason: string): void {
    this.#earlyDataDecision = {
      accepted,
      reason,
    };
    this.#earlyDataDecisionDispatched = false;
    this.#runtime.defer(() => {
      this.#runtime.setTimer(0, () => {
        if (this.#closed) return;
        this.#earlyDataDecisionDispatched = true;
        this.dispatchEvent(
          new QuicEarlyDataEvent('earlydata', {
            accepted,
            rejected: !accepted,
            reason,
          }),
        );
      });
    });
  }
  async #saveSessionTicket(ticket: Uint8Array, emitEvent = true): Promise<void> {
    if (this.#role !== 'client') return;
    const ticketCopy = ticket.slice();
    if (emitEvent) {
      this.#dispatch(new Event('sessionticket'));
      publishQuicTopic('quic.session.ticket', {
        connection: this,
        ticket: ticketCopy,
      });
    }
    if (this.#sessionKey === null || this.#options.sessionStore === undefined) return;
    const store = this.#options.sessionStore;
    const key = this.#sessionKey;
    const transportParameters = this.#encodeEarlyTransportParameters();
    const earlyDataMax =
      this.#options.earlyData === false ? 0 : (this.#options.earlyData.maxBytes ?? 4294967295);
    const version = this.version;
    const existing = (await store.load(key)) ?? {};
    await store.save(
      key,
      transportParameters === null
        ? {
            ...existing,
            ticket: ticketCopy,
            earlyDataMax,
            version,
          }
        : {
            ...existing,
            ticket: ticketCopy,
            transportParameters,
            earlyDataMax,
            version,
          },
    );
  }
  [quicConnectionInternals.onSessionTicket](ticket: Uint8Array): void {
    void this.#saveSessionTicket(ticket).catch((error) => {
      if (!this.#closed) {
        this.#dispatch(
          new QuicErrorEvent('error', {
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        );
      }
    });
  }
  [quicConnectionInternals.setEarlyTransportParameters](data: Uint8Array): boolean {
    const rc = ngtcp2Sym!.ngtcp2_conn_decode_and_set_0rtt_transport_params(
      this.#conn,
      data,
      data.byteLength,
    ) as number;
    return rc === 0;
  }
  [quicConnectionInternals.initClient](rememberedVersion = 0): void {
    const dcid = randomCid(this.#options.connection.cidLength);
    const scid = randomCid(this.#options.connection.cidLength);
    this.#clientInitialDcid = dcid.slice(0);
    const initialVersion =
      rememberedVersion !== 0 &&
      this.#options.versions.map(versionToWire).includes(rememberedVersion) &&
      ngtcp2Sym!.ngtcp2_is_supported_version(rememberedVersion) !== 0
        ? rememberedVersion
        : selectClientInitialWireVersion(this.#options.versions);
    this.#createNative(dcid, scid, null, initialVersion, true, initialVersion);
    this.#registerRoute(scid);
  }
  [quicConnectionInternals.initServer](
    clientScid: ArrayBuffer,
    serverScid: ArrayBuffer,
    version: number,
    retryScid: ArrayBuffer | null = null,
    token: Uint8Array | null = null,
    tokenType = NGTCP2_TOKEN_TYPE_UNKNOWN,
  ): void {
    this.#retryScid = retryScid;
    this.#validatedToken = token;
    this.#validatedTokenType = tokenType;
    this.#createNative(clientScid, serverScid, this.#originalDcidForServer(), version, false);
    this.#registerRoute(serverScid);
    const initialDcid = retryScid ?? this.#originalDcid;
    if (initialDcid !== null) this.#registerRoute(initialDcid);
  }
  #originalDcidForServer(): ArrayBuffer | null {
    return this.#originalDcid;
  }
  #createNative(
    dcid: ArrayBuffer,
    scid: ArrayBuffer,
    originalDcid: ArrayBuffer | null,
    version: number,
    client: boolean,
    originalVersion = 0,
  ): void {
    this.#localInitialScid = scid.slice(0);
    this.#remoteInitialScid = client ? null : dcid.slice(0);
    const callbacks = ensureCallbackTable();
    const settings = makeSettings(
      this.#options,
      this.#runtime,
      this.#validatedToken,
      this.#validatedTokenType,
      originalVersion,
    );
    const preferredAddress =
      !client && this.#options.migration.preferredAddress !== undefined
        ? this.#makePreferredAddressParams()
        : null;
    const statelessResetToken =
      !client && this.#listener !== null
        ? generateStatelessResetToken(this.#listener.resetTokenSecret, scid)
        : null;
    const params = makeTransportParams(
      originalDcid,
      this.#options,
      this.#retryScid,
      preferredAddress,
      statelessResetToken,
    );
    this.#tlsNativeHandle = newNativeHandle(this.#tls!);
    this.#tlsNativeBackend = this.#tls!.backend;
    this.#wireVersion = version;
    writePtr(this.#connRef, 0, getConnRefPointer());
    writeAddress(this.#connRef, 8, Pointer.addr(this.#userData) as bigint);
    setConnectionRef(this.#tls!, this.#connRef);
    if (client) {
      setSessionTicketCallback(this.#tls!, (ticket) => {
        const copy = ticket.slice();
        this.#runtime.defer(() => this[quicConnectionInternals.onSessionTicket](copy));
      });
    }
    configureSessionForConnection(client ? 'client' : 'server', this.#tls!);
    const fn = client
      ? ngtcp2Sym!.ngtcp2_conn_client_new_versioned
      : ngtcp2Sym!.ngtcp2_conn_server_new_versioned;
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
    if (rc !== 0)
      throw ngtcp2Error(rc, client ? 'ngtcp2_conn_client_new' : 'ngtcp2_conn_server_new');
    ngtcp2Sym!.ngtcp2_conn_set_tls_native_handle(this.#conn, this.#tlsNativeHandle);
    ngtcp2Sym!.ngtcp2_conn_set_path_user_data(this.#conn, ptrField(this.#path, PATH_USER_DATA));
    const keepAliveTimeout =
      this.#options.connection.keepAliveTimeout > 0n
        ? this.#options.connection.keepAliveTimeout
        : client && this.#options.migration.enabled
          ? MIGRATION_KEEP_ALIVE_TIMEOUT
          : 0n;
    if (keepAliveTimeout > 0n) {
      ngtcp2Sym!.ngtcp2_conn_set_keep_alive_timeout(this.#conn, keepAliveTimeout);
    }
    if (preferredAddress !== null) {
      this.#preferredAddressParams = preferredAddress;
      if (preferredAddress.ipv4 !== undefined) this.#registerRoute(preferredAddress.ipv4.cid);
      if (preferredAddress.ipv6 !== undefined) this.#registerRoute(preferredAddress.ipv6.cid);
    }
    this.#scheduleHandshakeTimeout();
  }
  #scheduleHandshakeTimeout(): void {
    if (this.#handshakeTimer !== null || this.#state !== 'connecting') return;
    const timeoutMs = Math.max(1, Number(this.#options.connection.handshakeTimeout / 1000000n));
    this.#handshakeTimer = this.#runtime.setTimer(timeoutMs, () => {
      this.#handshakeTimer = null;
      if (this.#closed || this.#state !== 'connecting') return;
      this.#fail(new Error('QUIC handshake timed out'));
    });
  }
  #makePreferredAddressParams(): PreferredAddressParams | null {
    const addresses = this.#options.migration.preferredAddress;
    if (addresses === undefined) return null;
    if (this.#listener === null) return null;
    const preferred: PreferredAddressParams = {};
    if (addresses.ipv4 !== undefined) {
      const cid = randomCid(this.#options.connection.cidLength);
      preferred.ipv4 = {
        address: addresses.ipv4,
        cid,
        statelessResetToken: generateStatelessResetToken(this.#listener.resetTokenSecret, cid),
      };
    }
    if (addresses.ipv6 !== undefined) {
      const cid = randomCid(this.#options.connection.cidLength);
      preferred.ipv6 = {
        address: addresses.ipv6,
        cid,
        statelessResetToken: generateStatelessResetToken(this.#listener.resetTokenSecret, cid),
      };
    }
    return preferred.ipv4 === undefined && preferred.ipv6 === undefined ? null : preferred;
  }
  #registerRoute(cid: ArrayBuffer): void {
    const key = cidKey(cidBytes(cid));
    if (this.routeCids.includes(key)) return;
    this.routeCids.push(key);
    this.#endpoint.cidTable.add(key, this);
  }
  [quicConnectionInternals.registerIssuedCid](cid: ArrayBuffer): void {
    this.#registerRoute(cid);
  }
  [quicConnectionInternals.unregisterIssuedCid](cid: ArrayBuffer): void {
    const key = cidKey(cidBytes(cid));
    this.#endpoint.cidTable.delete(key);
    const index = this.routeCids.indexOf(key);
    if (index !== -1) this.routeCids.splice(index, 1);
  }
  [quicConnectionInternals.onDestinationCidStatus](
    type: number,
    cid: ArrayBuffer | null,
    token: ArrayBuffer | null,
  ): void {
    if (cid === null || token === null) return;
    const key = cidKey(cidBytes(cid));
    if (type === NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE) {
      const tokenKey = cidKey(copyFromPtr(token, 16));
      const previous = this.#statelessResetTokens.get(key);
      if (previous !== undefined && previous !== tokenKey) {
        this.#endpoint[quicEndpointInternals.unregisterStatelessResetToken](previous, this);
      }
      this.#statelessResetTokens.set(key, tokenKey);
      this.#endpoint[quicEndpointInternals.registerStatelessResetToken](tokenKey, this);
    } else if (type === NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE) {
      const tokenKey = this.#statelessResetTokens.get(key);
      if (tokenKey !== undefined)
        this.#endpoint[quicEndpointInternals.unregisterStatelessResetToken](tokenKey, this);
      this.#statelessResetTokens.delete(key);
    }
  }
  [quicConnectionInternals.onStatelessReset](): void {
    this.#fail(new Error('QUIC stateless reset received'));
  }
  [quicConnectionInternals.waitHandshake](): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    if (this.#handshakeError !== null) return Promise.reject(this.#handshakeError);
    return new Promise((resolve, reject) =>
      this.#handshakeWaiters.push({
        resolve,
        reject,
      }),
    );
  }
  #waitHandshakeConfirmed(): Promise<void> {
    if (this.#handshakeConfirmed) return Promise.resolve();
    if (this.#handshakeError !== null) return Promise.reject(this.#handshakeError);
    if (this.#closed) return Promise.reject(new Error('QUIC connection is closed'));
    this.#startDeferredHandshake();
    this[quicConnectionInternals.driveWrites]();
    return new Promise((resolve, reject) =>
      this.#handshakeConfirmedWaiters.push({
        resolve,
        reject,
      }),
    );
  }
  [quicConnectionInternals.onHandshakeCompleted](): void {
    if (this.#state === 'closed') return;
    if (this.#handshakeTimer !== null) this.#handshakeTimer.cancel?.();
    this.#handshakeTimer = null;
    this.#state = 'connected';
    if (this.#stats.connectedAt === null) this.#stats.connectedAt = Date.now();
    if (this.#role === 'server') this.#markHandshakeConfirmed();
    if (
      this.#role === 'client' &&
      this.#remoteInitialScid === null &&
      ptrAddress(this.#conn) !== 0n
    ) {
      const dcid = ngtcp2Sym!.ngtcp2_conn_get_dcid(this.#conn) as ArrayBuffer | null;
      if (dcid !== null && ptrAddress(dcid) !== 0n)
        this.#remoteInitialScid = makeCid(cidBytes(dcid));
    }
    this.#earlyDataReady = false;
    this.#earlyDataQueuedBytes = 0;
    const alpnProtocol = this.alpnProtocol;
    const handshakeInfo = getHandshakeInfo(this.#tls, this.#serverName);
    this.#peerCertificate = getPeerCertificate(this.#tls);
    this.#peerVerification = {
      verified: handshakeInfo.validationErrorCode === 0,
      errorCode: handshakeInfo.validationErrorCode,
      reason: handshakeInfo.validationErrorReason,
    };
    if (
      this.#role === 'server' &&
      this.#requireClientCertificate &&
      this.#peerCertificate === null
    ) {
      this.#fail(new Error('QUIC client certificate required'));
      return;
    }
    publishQuicTopic('quic.session.handshake', {
      connection: this,
      localAddress: this.localAddress,
      remoteAddress: this.remoteAddress,
      alpnProtocol,
      peerCertificate: this.peerCertificate,
      peerVerification: this.peerVerification,
      ...handshakeInfo,
      protocol: alpnProtocol,
      version: this.version,
      earlyDataAttempted: this.#earlyDataAttempted,
      earlyDataAccepted: this.#earlyDataAccepted,
    });
    const waiters = this.#handshakeWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve(undefined);
    if (this.#role === 'server' && !this.#accepted) {
      this.#accepted = true;
      this.#endpoint[quicEndpointInternals.accept](this);
      if (this.#tls !== null) {
        this.#scheduleSessionTicket();
      }
    }
  }
  [quicConnectionInternals.onHandshakeConfirmed](): void {
    this.#markHandshakeConfirmed();
  }
  #markHandshakeConfirmed(): void {
    if (this.#handshakeConfirmed) return;
    this.#handshakeConfirmed = true;
    if (this.#stats.handshakeConfirmedAt === null) this.#stats.handshakeConfirmedAt = Date.now();
    const waiters = this.#handshakeConfirmedWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve(undefined);
  }
  #scheduleSessionTicket(): void {
    if (this.#sessionTicketScheduled) return;
    this.#sessionTicketScheduled = true;
    this.#runtime.defer(() => {
      this.#sessionTicketScheduled = false;
      if (this.#closed || this.#tls === null) return;
      this.#submitNewToken();
      sendSessionTicket(this.#tls);
      const rc = cryptoSym!.ngtcp2_crypto_read_write_crypto_data(
        this.#conn,
        NGTCP2_ENCRYPTION_LEVEL_1RTT,
        null,
        0n,
      ) as number;
      if (rc !== 0) {
        this.#fail(ngtcp2Error(rc, 'ngtcp2_crypto_read_write_crypto_data'));
        return;
      }
      this.#scheduleWriteDrain();
    });
  }
  #submitNewToken(): void {
    if (this.#role !== 'server' || this.#listener === null) return;
    const token = generateRegularToken(
      this.#listener.retryTokenSecret,
      this.remoteAddress,
      this.#runtime,
    );
    if (token === null || token.byteLength === 0) return;
    const rc = ngtcp2Sym!.ngtcp2_conn_submit_new_token(
      this.#conn,
      token,
      token.byteLength,
    ) as number;
    if (rc !== 0) this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_submit_new_token'));
  }
  #fail(error: Error): void {
    if (this.#state === 'closed') return;
    this.#handshakeError = error;
    const waiters = this.#handshakeWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
    const confirmedWaiters = this.#handshakeConfirmedWaiters.splice(0);
    for (const waiter of confirmedWaiters) waiter.reject(error);
    publishQuicTopic('quic.session.error', {
      connection: this,
      error,
    });
    this.#dispatch(new QuicErrorEvent('error', { error }));
    this.#closeFromTransport(0, '', error);
  }
  #writeBufferSize(maxPayload?: number): number {
    const mp =
      maxPayload ??
      Number(ngtcp2Sym!.ngtcp2_conn_get_max_tx_udp_payload_size(this.#conn) as bigint | number);
    return mp > 0
      ? Math.min(65536, Math.max(NGTCP2_MAX_UDP_PAYLOAD_SIZE, mp))
      : NGTCP2_MAX_UDP_PAYLOAD_SIZE;
  }
  #writePacketBudget(maxPayload?: number): number {
    const quantum = Number(ngtcp2Sym!.ngtcp2_conn_get_send_quantum(this.#conn) as bigint | number);
    const mp =
      maxPayload ??
      Number(ngtcp2Sym!.ngtcp2_conn_get_max_tx_udp_payload_size(this.#conn) as bigint | number);
    if (quantum <= 0 || mp <= 0) return MAX_WRITE_PACKETS_PER_DRAIN;
    return Math.max(1, Math.min(MAX_WRITE_PACKETS_PER_DRAIN, Math.floor(quantum / mp) || 1));
  }
  #outputFromPath(
    path: ArrayBuffer,
    fallbackRemoteAddress: QuicAddress,
    fallbackFd: number = this.#fd,
  ): {
    fd: number;
    localAddress: QuicAddress;
    remoteAddress: QuicAddress;
  } {
    const remoteAddress = remoteAddressFromPath(path) ?? fallbackRemoteAddress;
    const localAddress = localAddressFromPath(path) ?? this.#activeLocalAddress;
    const fd = fdFromPath(path, fallbackFd);
    return {
      fd,
      localAddress,
      remoteAddress,
    };
  }
  #outputFromPathForPacket(
    outPath: NativePath,
    fallbackRemoteAddress: QuicAddress,
  ): {
    fd: number;
    remoteAddress: QuicAddress;
  } {
    const fd = fdFromPath(outPath.path, this.#fd);
    if (
      fd === this.#fd &&
      this.#activePathValidations.length === 0 &&
      !this.#options.migration.enabled &&
      this.#options.migration.preferredAddress === undefined
    ) {
      return {
        fd,
        remoteAddress: fallbackRemoteAddress,
      };
    }
    const output = this.#outputFromPath(outPath.path, fallbackRemoteAddress);
    return {
      fd: output.fd,
      remoteAddress: output.remoteAddress,
    };
  }
  #activeOutputPath(remoteAddress: QuicAddress): NativePath {
    if (this.#options.migration.enabled || this.#options.migration.preferredAddress !== undefined) {
      return this.#retainPath(this.#activeLocalAddress, this.remoteAddress, this.#fd);
    }
    return this.#retainPath(this.#activeLocalAddress, remoteAddress, this.#fd);
  }
  #transportById(id: number): QuicDatagramTransport | null {
    return this.#endpoint[quicEndpointInternals.transportById](id) ?? null;
  }
  #syncActivePathFromNative(preferredPath: ArrayBuffer | null = null): boolean {
    const nativePath =
      preferredPath ?? (ngtcp2Sym!.ngtcp2_conn_get_path(this.#conn) as ArrayBuffer | null);
    const snapshot = pathSnapshotFromNative(nativePath, this.#fd);
    return this.#syncActivePathSnapshot(snapshot);
  }
  #syncActivePathSnapshot(snapshot: PathSnapshot | null): boolean {
    if (snapshot === null) return false;
    const { localAddress, remoteAddress, fd } = snapshot;
    const changed =
      fd !== this.#fd ||
      !sameAddress(localAddress, this.#activeLocalAddress) ||
      !sameAddress(remoteAddress, this.remoteAddress);
    const path = this.#retainPath(localAddress, remoteAddress, fd);
    this.remoteAddress = remoteAddress;
    this.#activeLocalAddress = localAddress;
    this.#fd = fd;
    this.#path = path.path;
    this.#localSockaddr = path.local;
    this.#remoteSockaddr = path.remote;
    ngtcp2Sym!.ngtcp2_conn_set_path_user_data(this.#conn, ptrField(path.path, PATH_USER_DATA));
    return changed;
  }
  #sendPacket(fd: number, data: Uint8Array, remoteAddress: QuicAddress): boolean {
    return (
      this.#blockedSend.length === 0 &&
      this.#flushPacketBatch([
        {
          fd,
          data,
          remoteAddress,
        },
      ])
    );
  }
  #copyPendingSendPacket(packet: PendingSendPacket): PendingSendPacket {
    return {
      fd: packet.fd,
      data: packet.data.slice(),
      remoteAddress: { ...packet.remoteAddress },
      ecn: packet.ecn,
    };
  }
  #recordPacketSent(packet: PendingSendPacket): void {
    this.#endpoint[quicEndpointInternals.recordDatagramSent](packet.data.byteLength);
    this.#stats.packetsSent++;
    this.#stats.bytesSent += packet.data.byteLength;
  }
  #flushPacketBatch(packets: PendingSendPacket[]): boolean {
    for (let index = 0; index < packets.length; ) {
      const first = packets[index]!;
      const transport = this.#transportById(first.fd);
      if (transport === null) {
        this.#fail(new Error(`QUIC datagram transport ${first.fd} is closed`));
        return false;
      }
      let end = index + 1;
      while (end < packets.length && packets[end]!.fd === first.fd) end++;
      const chunk = packets.slice(index, end);
      const result =
        transport.sendBatch === undefined
          ? this.#sendPacketChunkFallback(transport, chunk)
          : transport.sendBatch(
              chunk.map((packet) => ({
                data: packet.data,
                dest: packet.remoteAddress,
                ecn: packet.ecn,
              })),
            );
      for (let sent = 0; sent < result.sent; sent++) this.#recordPacketSent(chunk[sent]!);
      if (result.errno !== null) {
        if (result.errno === EAGAIN) {
          this.#blockedSend = packets
            .slice(index + result.sent)
            .map((packet) => this.#copyPendingSendPacket(packet));
          this.#scheduleBlockedSendRetry();
        } else {
          this.#fail(new Error(`QUIC UDP sendto failed: ${result.errno}`));
        }
        return false;
      }
      index = end;
    }
    return true;
  }
  #sendPacketChunkFallback(
    transport: QuicDatagramTransport,
    packets: PendingSendPacket[],
  ): {
    sent: number;
    errno: number | null;
  } {
    let sent = 0;
    for (const packet of packets) {
      const rc = transport.sendNow(packet.data, packet.remoteAddress);
      if (rc < 0)
        return {
          sent,
          errno: rc,
        };
      sent++;
    }
    return {
      sent,
      errno: null,
    };
  }
  #sendClosePacket(fd: number, data: Uint8Array, remoteAddress: QuicAddress): boolean {
    const transport = this.#transportById(fd);
    if (transport === null) return false;
    const sent = transport.sendNow(data, remoteAddress);
    if (sent < 0) {
      if (sent !== EAGAIN) {
        this.#dispatch(
          new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }),
        );
      }
      return false;
    }
    this.#endpoint[quicEndpointInternals.recordDatagramSent](data.byteLength);
    this.#stats.packetsSent++;
    this.#stats.bytesSent += data.byteLength;
    return true;
  }
  #rememberClosePacket(fd: number, data: Uint8Array, remoteAddress: QuicAddress): void {
    this.#closePacket = {
      fd,
      data: data.slice(),
      remoteAddress: { ...remoteAddress },
    };
    this.#closingPacketsReceived = 0;
    this.#nextCloseRetransmitThreshold = 1;
  }
  #receiveClosingPacket(fd: number, remoteAddress: QuicAddress): number {
    const closePacket = this.#closePacket;
    if (closePacket === null) return 0;
    this.#closingPacketsReceived++;
    if (this.#closingPacketsReceived < this.#nextCloseRetransmitThreshold) return 0;
    this.#nextCloseRetransmitThreshold = Math.max(1, this.#nextCloseRetransmitThreshold * 2);
    this.#sendClosePacket(fd, closePacket.data, remoteAddress);
    return 0;
  }
  #scheduleBlockedSendRetry(): void {
    if (this.#blockedSendRetryScheduled) return;
    const blocked = this.#blockedSend[0];
    if (blocked === undefined) return;
    const transport = this.#transportById(blocked.fd);
    if (transport === null) {
      this.#blockedSend = [];
      return;
    }
    this.#blockedSendRetryScheduled = true;
    transport.waitWritable().then(
      () => {
        this.#blockedSendRetryScheduled = false;
        const pending = this.#blockedSend;
        if (this.#closed || pending.length === 0) return;
        this.#blockedSend = [];
        if (this.#flushPacketBatch(pending)) {
          this.#scheduleTimer();
          this.#scheduleWriteDrain(pending[pending.length - 1]!.remoteAddress);
        }
      },
      (error) => {
        this.#blockedSendRetryScheduled = false;
        if (!this.#closed) this.#fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }
  #writeConnectionClose(liberr: number, remoteAddress: QuicAddress): void {
    const out = new Uint8Array(this.#writeBufferSize());
    const ccerr = new ArrayBuffer(NGTCP2_CCERR_SIZE);
    const reason = new TextEncoder().encode(ngtcp2Error(liberr, 'ngtcp2_conn_read_pkt').message);
    const reasonBytes = reason.byteLength > 0 ? reason : new Uint8Array(0);
    ngtcp2Sym!.ngtcp2_ccerr_default(Pointer.of(ccerr));
    if (liberr === NGTCP2_ERR_CRYPTO) {
      const alert = ngtcp2Sym!.ngtcp2_conn_get_tls_alert(this.#conn) as number;
      if (alert !== 0) {
        ngtcp2Sym!.ngtcp2_ccerr_set_tls_alert(
          Pointer.of(ccerr),
          alert,
          reasonBytes,
          reasonBytes.byteLength,
        );
      } else {
        ngtcp2Sym!.ngtcp2_ccerr_set_liberr(
          Pointer.of(ccerr),
          liberr,
          reasonBytes,
          reasonBytes.byteLength,
        );
      }
    } else {
      ngtcp2Sym!.ngtcp2_ccerr_set_liberr(
        Pointer.of(ccerr),
        liberr,
        reasonBytes,
        reasonBytes.byteLength,
      );
    }
    const outPath = makeOutputPath(this.#activeLocalAddress, remoteAddress, this.#fd);
    const ts = now(this.#runtime);
    const n = Number(
      ngtcp2Sym!.ngtcp2_conn_write_connection_close_versioned(
        this.#conn,
        Pointer.of(outPath.path),
        NGTCP2_PKT_INFO_VERSION,
        null,
        out,
        out.byteLength,
        Pointer.of(ccerr),
        ts,
      ),
    );
    if (n <= 0) return;
    const output = this.#outputFromPath(outPath.path, remoteAddress);
    const packet = out.slice(0, n);
    this.#rememberClosePacket(output.fd, packet, output.remoteAddress);
    if (this.#sendClosePacket(output.fd, packet, output.remoteAddress)) {
      this.#connectionCloseSent = true;
    }
    ngtcp2Sym!.ngtcp2_conn_update_pkt_tx_time(this.#conn, ts);
  }
  #writeApplicationConnectionClose(errorCode: number, reason: string): void {
    const out = new Uint8Array(this.#writeBufferSize());
    const ccerr = new ArrayBuffer(NGTCP2_CCERR_SIZE);
    const reasonBytes = new TextEncoder().encode(reason);
    ngtcp2Sym!.ngtcp2_ccerr_default(Pointer.of(ccerr));
    ngtcp2Sym!.ngtcp2_ccerr_set_application_error(
      Pointer.of(ccerr),
      BigInt(Math.max(0, Math.floor(errorCode))),
      reasonBytes,
      reasonBytes.byteLength,
    );
    const outPath = makeOutputPath(this.#activeLocalAddress, this.remoteAddress, this.#fd);
    const ts = now(this.#runtime);
    const n = Number(
      ngtcp2Sym!.ngtcp2_conn_write_connection_close_versioned(
        this.#conn,
        Pointer.of(outPath.path),
        NGTCP2_PKT_INFO_VERSION,
        null,
        out,
        out.byteLength,
        Pointer.of(ccerr),
        ts,
      ),
    );
    if (n <= 0) return;
    const output = this.#outputFromPath(outPath.path, this.remoteAddress);
    const packet = out.slice(0, n);
    this.#rememberClosePacket(output.fd, packet, output.remoteAddress);
    if (this.#sendClosePacket(output.fd, packet, output.remoteAddress)) {
      this.#connectionCloseSent = true;
    }
    ngtcp2Sym!.ngtcp2_conn_update_pkt_tx_time(this.#conn, ts);
  }
  #writeTransportConnectionClose(errorCode: number, reason: string): void {
    const out = new Uint8Array(this.#writeBufferSize());
    const ccerr = new ArrayBuffer(NGTCP2_CCERR_SIZE);
    const reasonBytes = new TextEncoder().encode(reason);
    ngtcp2Sym!.ngtcp2_ccerr_default(Pointer.of(ccerr));
    ngtcp2Sym!.ngtcp2_ccerr_set_transport_error(
      Pointer.of(ccerr),
      BigInt(Math.max(0, Math.floor(errorCode))),
      reasonBytes,
      reasonBytes.byteLength,
    );
    const outPath = makeOutputPath(this.#activeLocalAddress, this.remoteAddress, this.#fd);
    const ts = now(this.#runtime);
    const n = Number(
      ngtcp2Sym!.ngtcp2_conn_write_connection_close_versioned(
        this.#conn,
        Pointer.of(outPath.path),
        NGTCP2_PKT_INFO_VERSION,
        null,
        out,
        out.byteLength,
        Pointer.of(ccerr),
        ts,
      ),
    );
    if (n <= 0) return;
    const output = this.#outputFromPath(outPath.path, this.remoteAddress);
    const packet = out.slice(0, n);
    this.#rememberClosePacket(output.fd, packet, output.remoteAddress);
    if (this.#sendClosePacket(output.fd, packet, output.remoteAddress)) {
      this.#connectionCloseSent = true;
    }
    ngtcp2Sym!.ngtcp2_conn_update_pkt_tx_time(this.#conn, ts);
  }
  #readCloseError(liberr: number): Error {
    const ccerr = ngtcp2Sym!.ngtcp2_conn_get_ccerr(this.#conn) as ArrayBuffer | null;
    if (ccerr !== null) {
      const errorCode = Number(Pointer.readU64(ccerr, CCERR_ERROR_CODE));
      const ccerr_type = Pointer.readI32(ccerr, CCERR_TYPE) as number;
      const type: 'transport' | 'application' = ccerr_type === 1 ? 'application' : 'transport';
      let reason = '';
      const reasonLen = Number(Pointer.readU64(ccerr, CCERR_REASONLEN));
      if (reasonLen > 0) {
        const reasonPtr = Pointer.readPointer(ccerr, CCERR_REASON) as ArrayBuffer | null;
        if (reasonPtr !== null) {
          reason = new TextDecoder().decode(Pointer.copyFrom(reasonPtr, reasonLen));
        }
      }
      this.#closeInfo = {
        errorCode,
        reason,
        type,
        remote: true,
      };
      if (type === 'transport' && (errorCode & NGTCP2_CRYPTO_ERROR) === NGTCP2_CRYPTO_ERROR) {
        const alert = errorCode & 255;
        if (alert === TLS_ALERT_NO_APPLICATION_PROTOCOL) {
          return new Error(
            `QUIC ALPN mismatch: client offered ${this.alpnProtocols.join(', ') || '(none)'}`,
          );
        }
      }
    }
    return ngtcp2Error(liberr, 'ngtcp2_conn_read_pkt');
  }
  #selectVersionNegotiationRetryVersion(): number {
    const allowed = new Set(this.#options.versions.map(versionToWire));
    for (const version of this.#versionNegotiationVersions) {
      if (
        allowed.has(version) &&
        ngtcp2Sym!.ngtcp2_is_supported_version(version) !== 0 &&
        version !== this.#wireVersion
      ) {
        return version;
      }
    }
    return 0;
  }
  #retryVersionNegotiation(version = this.#selectVersionNegotiationRetryVersion()): boolean {
    if (this.#role !== 'client' || this.#versionNegotiationRetried) return false;
    if (version === 0) return false;
    const dcid = this.#clientInitialDcid;
    const scid = this.#localInitialScid;
    if (dcid === null || scid === null || this.#ctx === null || this.#serverName === null)
      return false;
    const originalVersion = this.#wireVersion;
    this.#versionNegotiationRetried = true;
    this.#versionNegotiationPendingRetry = false;
    if (ptrAddress(this.#conn) !== 0n) {
      ngtcp2Sym!.ngtcp2_conn_del(this.#conn);
      this.#conn = new ArrayBuffer(8);
    }
    if (this.#tlsNativeHandle !== null && this.#tlsNativeBackend !== null) {
      freeNativeHandle(this.#tlsNativeBackend, this.#tlsNativeHandle);
      this.#tlsNativeHandle = null;
      this.#tlsNativeBackend = null;
    }
    if (this.#tls !== null) {
      if (this.#tls.backend !== 'gnutls') setSessionTicketCallback(this.#tls, null);
      clearConnectionRef(this.#tls);
      freeSession(this.#tls);
    }
    this.#tls = newClientSession(
      this.#ctx,
      this.alpnProtocols.slice(),
      this.#serverName,
      this.#clientVerifyPeer,
      this.#clientEarlyDataMax,
    );
    this.#earlyDataReady = false;
    this.#earlyDataQueuedBytes = 0;
    this.#handshakeDeferred = false;
    this.#createNative(dcid, scid, null, version, true, originalVersion);
    this.#scheduleWriteDrain();
    return true;
  }
  [quicConnectionInternals.startSocketLoop](
    transport: QuicDatagramTransport | null = this.#transportById(this.#fd),
    localAddress: QuicAddress = this.#activeLocalAddress,
  ): void {
    if (this.#role !== 'client') return;
    if (transport === null) return;
    if (this.#clientTransports.has(transport.id)) return;
    this.#clientTransports.set(transport.id, transport);
    void this.#runSocketLoop(transport, localAddress);
  }
  async #runSocketLoop(transport: QuicDatagramTransport, localAddress: QuicAddress): Promise<void> {
    while (!this.#closed && this.#clientTransports.has(transport.id)) {
      try {
        const batchCount = transport.recvBatchEach?.(
          MAX_BATCH_READ_PACKETS_PER_TURN,
          NGTCP2_MAX_UDP_PAYLOAD_SIZE,
          (data, addr, ecn, path) => {
            this.#endpoint[quicEndpointInternals.handleDatagram](
              null,
              transport,
              localAddress,
              data,
              addr,
              ecn,
              path,
            );
          },
        );
        if (batchCount !== undefined) {
          if (batchCount >= MAX_BATCH_READ_PACKETS_PER_TURN) {
            await runtimeDelay(this.#runtime, 0);
            continue;
          }
        } else {
          const batch = transport.recvBatch?.(
            MAX_BATCH_READ_PACKETS_PER_TURN,
            NGTCP2_MAX_UDP_PAYLOAD_SIZE,
          );
          if (batch !== undefined) {
            for (const received of batch) {
              this.#endpoint[quicEndpointInternals.handleDatagram](
                null,
                transport,
                localAddress,
                received.data,
                received.addr,
                received.ecn,
                received.path,
              );
            }
            if (batch.length >= MAX_BATCH_READ_PACKETS_PER_TURN) {
              await runtimeDelay(this.#runtime, 0);
              continue;
            }
          } else {
            let packets = 0;
            for (; packets < MAX_READ_PACKETS_PER_TURN; packets++) {
              const received = transport.recvNow(NGTCP2_MAX_UDP_PAYLOAD_SIZE);
              if (received === null) break;
              this.#endpoint[quicEndpointInternals.handleDatagram](
                null,
                transport,
                localAddress,
                received.data,
                received.addr,
                received.ecn,
                received.path,
              );
            }
            if (packets >= MAX_READ_PACKETS_PER_TURN) {
              await runtimeDelay(this.#runtime, 0);
              continue;
            }
          }
        }
        await transport.waitReadable();
      } catch (error) {
        if (!this.#closed) this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  [quicConnectionInternals.receivePacket](
    packet: Uint8Array,
    remoteAddress: QuicAddress,
    localAddress: QuicAddress = this.localAddress,
    transport: QuicDatagramTransport | null = this.#transportById(this.#fd),
    packetEcn?: number,
    pathMetadata?: QuicDatagramPathMetadata,
  ): number {
    if (this.#closed) return this.#receiveClosingPacket(transport?.id ?? this.#fd, remoteAddress);
    this.#stats.packetsReceived++;
    this.#stats.bytesReceived += packet.byteLength;
    const fd = transport?.id ?? this.#fd;
    const packetPath = this.#retainPathFromMetadata(localAddress, remoteAddress, fd, pathMetadata);
    const packetVersion = longHeaderVersion(packet);
    if (
      this.#role === 'client' &&
      this.#state === 'connecting' &&
      packetVersion !== null &&
      packetVersion !== 0 &&
      packetVersion !== this.#wireVersion &&
      this.#options.versions.map(versionToWire).includes(packetVersion) &&
      ngtcp2Sym!.ngtcp2_is_supported_version(packetVersion) !== 0
    ) {
      this.#retryVersionNegotiation(packetVersion);
    }
    const previousReadingPacketStartedConnecting = this.#readingPacketStartedConnecting;
    this.#readingPacketStartedConnecting = this.#state === 'connecting';
    let rc = 0;
    try {
      const pktInfo = this.#options.transport.ecn
        ? makePacketInfo(packetEcn ?? NGTCP2_ECN_NOT_ECT)
        : null;
      rc = ngtcp2Sym!.ngtcp2_conn_read_pkt_versioned(
        this.#conn,
        this.#ptrOf(packetPath.path, _QUIC_PTR_PATH),
        NGTCP2_PKT_INFO_VERSION,
        pktInfo === null ? null : this.#ptrOf(pktInfo, _QUIC_PTR_PKT_INFO),
        packet,
        packet.byteLength,
        now(this.#runtime),
      ) as number;
    } finally {
      this.#readingPacketStartedConnecting = previousReadingPacketStartedConnecting;
    }
    if (this.#role === 'server' && (rc === NGTCP2_ERR_RETRY || rc === NGTCP2_ERR_DROP_CONN)) {
      this.#closeFromTransport();
      return rc;
    }
    if (rc === NGTCP2_ERR_DRAINING || rc === NGTCP2_ERR_CLOSING) {
      const error = this.#readCloseError(rc);
      if (this.#state === 'connecting') this.#fail(error);
      else this.#closeFromTransport(0, '', error, 'transport', true);
      return rc;
    }
    if (this.#versionNegotiationPendingRetry) {
      if (this.#retryVersionNegotiation()) return rc;
      this.#fail(
        new QuicVersionNegotiationError(
          this.#versionNegotiationVersions,
          this.#options.versions.map(versionToWire),
        ),
      );
      return rc;
    }
    if (rc === NGTCP2_ERR_RECV_VERSION_NEGOTIATION || rc === NGTCP2_ERR_VERSION_NEGOTIATION) {
      if (this.#retryVersionNegotiation()) return rc;
      this.#fail(
        new QuicVersionNegotiationError(
          this.#versionNegotiationVersions,
          this.#options.versions.map(versionToWire),
        ),
      );
      return rc;
    }
    if (rc !== 0) {
      try {
        this.#writeConnectionClose(rc, remoteAddress);
      } catch {}
      this.#fail(this.#readCloseError(rc));
      return rc;
    }
    this.#endpoint[quicEndpointInternals.recordDatagramReceived](packet.byteLength);
    if (
      this.#options.migration.enabled ||
      this.#options.migration.preferredAddress !== undefined ||
      fd !== this.#fd ||
      !sameAddress(localAddress, this.#activeLocalAddress) ||
      !sameAddress(remoteAddress, this.remoteAddress) ||
      this.#activePathValidations.length > 0
    ) {
      this.#syncActivePathFromNative();
    }
    this.#scheduleTimer();
    this.#scheduleWriteDrain(remoteAddress);
    return rc;
  }
  [quicConnectionInternals.reserveStreamData](data: Uint8Array): void {
    this.#validateEarlyStreamData(data);
  }
  #validateEarlyStreamData(data: Uint8Array): void {
    if (this.#state !== 'connected' && this.#state !== 'closing') {
      if (!this.#earlyDataReady) throw new Error('QUIC connection is not connected');
      this.#reserveEarlyDataBytes(data.byteLength);
    }
  }
  #reserveEarlyDataBytes(byteLength: number): void {
    const nextEarlyBytes = this.#earlyDataQueuedBytes + byteLength;
    if (nextEarlyBytes > this.#earlyDataMaxBytes) {
      throw new RangeError(`QUIC 0-RTT write exceeds maxBytes ${this.#earlyDataMaxBytes}`);
    }
    this.#earlyDataQueuedBytes = nextEarlyBytes;
  }
  [quicConnectionInternals.queueStreamData](
    stream: QuicStream,
    data: Uint8Array,
    fin: boolean,
    earlyDataReserved = false,
  ): void {
    if (!earlyDataReserved) {
      this.#validateEarlyStreamData(data);
    }
    if (fin && data.byteLength === 0) {
      const pending = this.#pendingWrites[this.#pendingWrites.length - 1];
      if (
        pending !== undefined &&
        pending.streamId === stream.id &&
        pending.offset === 0 &&
        !pending.fin
      ) {
        pending.fin = true;
        this.#scheduleWriteDrain();
        return;
      }
    }
    stream[quicStreamInternals.recordQueuedWrite](data.byteLength);
    this.#pendingWrites.push({
      streamId: stream.id,
      data,
      offset: 0,
      fin,
    });
    this.#startDeferredHandshake();
    this.#scheduleWriteDrain();
  }
  #canOpenApplicationStream(): boolean {
    if (this.#gracefulClosing) return false;
    return (
      this.#state === 'connected' ||
      (this.#role === 'client' && this.#state === 'connecting' && this.#earlyDataReady)
    );
  }
  #encodeEarlyTransportParameters(): Uint8Array | null {
    if (ptrAddress(this.#conn) === 0n) return null;
    if (ngtcp2Sym!.ngtcp2_conn_get_handshake_completed(this.#conn) === 0) return null;
    const out = new Uint8Array(65536);
    const n = Number(
      ngtcp2Sym!.ngtcp2_conn_encode_0rtt_transport_params(this.#conn, out, out.byteLength),
    );
    if (n <= 0) return null;
    return out.slice(0, n);
  }
  [quicConnectionInternals.driveWrites](remoteAddress: QuicAddress = this.remoteAddress): void {
    this.#writeDrainScheduled = false;
    if (this.#closed) return;
    if (this.#writeDrainInProgress) {
      this.#writeDrainAgain = true;
      this.#writeDrainRemoteAddress = remoteAddress;
      return;
    }
    this.#writeDrainInProgress = true;
    try {
      if (this.#handshakeDeferred) return;
      if (this.#blockedSend.length > 0) {
        this.#scheduleBlockedSendRetry();
        return;
      }
      // Read the max UDP payload size once and share it with both helpers below
      // (each would otherwise make its own get_max_tx_udp_payload_size FFI call).
      const maxPayload = Number(
        ngtcp2Sym!.ngtcp2_conn_get_max_tx_udp_payload_size(this.#conn) as bigint | number,
      );
      const writeBufferSize = this.#writeBufferSize(maxPayload);
      const ts = now(this.#runtime);
      let packets = 0;
      const packetBudget = this.#writePacketBudget(maxPayload);
      const packetBatch: PendingSendPacket[] = [];
      const outPath = this.#activeOutputPath(remoteAddress);
      for (; packets < packetBudget; packets++) {
        let n = 0;
        const out = this.#writePacketBuffer(packets, writeBufferSize);
        const pktInfo = this.#options.transport.ecn ? makePacketInfo() : null;
        const pktInfoPtr = pktInfo === null ? null : this.#ptrOf(pktInfo, _QUIC_PTR_PKT_INFO);
        const outPathPtr = this.#ptrOf(outPath.path, _QUIC_PTR_PATH);
        const writeNoStreamData = (): number =>
          Number(
            ngtcp2Sym!.ngtcp2_conn_writev_stream_versioned(
              this.#conn,
              outPathPtr,
              NGTCP2_PKT_INFO_VERSION,
              pktInfoPtr,
              out,
              out.byteLength,
              null,
              0,
              -1n,
              null,
              0n,
              ts,
            ),
          );
        const isCoalescingRetry = (code: number): boolean =>
          code === NGTCP2_ERR_WRITE_MORE ||
          code === NGTCP2_ERR_STREAM_DATA_BLOCKED ||
          code === NGTCP2_ERR_STREAM_NOT_FOUND ||
          code === NGTCP2_ERR_STREAM_SHUT_WR;
        if (this.#pendingWrites.length > 0) {
          let coalescing = false;
          let blockedStreamIds: Set<number> | null = null;
          const nextPendingIndex = (): number => {
            for (let i = 0; i < this.#pendingWrites.length; i++) {
              const candidate = this.#pendingWrites[i];
              if (blockedStreamIds === null || !blockedStreamIds.has(candidate.streamId)) return i;
            }
            return -1;
          };
          for (;;) {
            const pendingIndex = nextPendingIndex();
            const pending = pendingIndex === -1 ? undefined : this.#pendingWrites[pendingIndex];
            if (pending === undefined) {
              n = writeNoStreamData();
              if (n === NGTCP2_ERR_WRITE_MORE) {
                coalescing = true;
                continue;
              }
              break;
            }
            const remaining = pending.data.subarray(pending.offset);
            const vec = this.#writeVecBuf;
            writeAddress(vec, VEC_BASE, Pointer.addr(remaining) as bigint);
            writeU64(vec, VEC_LEN, BigInt(remaining.byteLength));
            const dataLen = this.#writeDataLenBuf;
            writeI64(dataLen, 0, -1n);
            const flags =
              (pending.fin ? NGTCP2_WRITE_STREAM_FLAG_FIN : 0) | NGTCP2_WRITE_STREAM_FLAG_MORE;
            coalescing = true;
            n = Number(
              ngtcp2Sym!.ngtcp2_conn_writev_stream_versioned(
                this.#conn,
                outPathPtr,
                NGTCP2_PKT_INFO_VERSION,
                pktInfoPtr,
                out,
                out.byteLength,
                this.#ptrOf(dataLen, _QUIC_PTR_DATA_LEN),
                flags,
                BigInt(pending.streamId),
                this.#ptrOf(vec, _QUIC_PTR_VEC),
                1n,
                ts,
              ),
            );
            const consumed = Number(readI64(dataLen, 0));
            const packetAccepted = n > 0 || n === NGTCP2_ERR_WRITE_MORE;
            const acceptedStreamData = consumed > 0 && packetAccepted;
            if (acceptedStreamData) {
              const start = this.#nextStreamOffsets.get(pending.streamId) ?? 0;
              const end = start + consumed;
              this.#nextStreamOffsets.set(pending.streamId, end);
              this.#outstandingStreamData.push({
                streamId: pending.streamId,
                start,
                end,
                data: remaining.subarray(0, consumed),
              });
              pending.offset += consumed;
            }
            const consumedAllData = pending.offset >= pending.data.byteLength;
            const streamFrameWritten = consumed >= 0 && packetAccepted;
            const finWritten = !pending.fin || (streamFrameWritten && consumedAllData);
            if (consumedAllData && finWritten) this.#pendingWrites.splice(pendingIndex, 1);
            if (n === NGTCP2_ERR_WRITE_MORE) {
              coalescing = true;
              continue;
            }
            if (n === NGTCP2_ERR_STREAM_NOT_FOUND || n === NGTCP2_ERR_STREAM_SHUT_WR) {
              this.#dropPendingWrites(pending.streamId);
              this.#streams
                .get(pending.streamId)
                ?.[quicStreamInternals.stopSendingFromConnection](0);
              if (coalescing || this.#pendingWrites.length > 0) continue;
              break;
            }
            if (n === NGTCP2_ERR_STREAM_DATA_BLOCKED) {
              this.#stats.blockCount++;
              const stream = this.#streams.get(pending.streamId) ?? null;
              publishQuicTopic('quic.stream.blocked', {
                connection: this,
                stream,
                streamId: pending.streamId,
              });
              stream?.[quicStreamInternals.blockedFromConnection]();
              blockedStreamIds ??= new Set<number>();
              blockedStreamIds.add(pending.streamId);
              if (coalescing || nextPendingIndex() !== -1) continue;
              break;
            }
            if (coalescing && isCoalescingRetry(n)) continue;
            break;
          }
        } else if (this.#hasPendingDatagrams()) {
          n = this.#nextDatagramOnlyPacket(outPath, out, ts, pktInfo);
        } else {
          n = Number(
            ngtcp2Sym!.ngtcp2_conn_write_pkt_versioned(
              this.#conn,
              outPathPtr,
              NGTCP2_PKT_INFO_VERSION,
              pktInfoPtr,
              out,
              out.byteLength,
              ts,
            ),
          );
        }
        if (n > 0) {
          this.#queueWrittenPacket(packetBatch, n, outPath, remoteAddress, out, ts, pktInfo);
          if (this.#closed) break;
          continue;
        }
        if (
          n === 0 ||
          n === NGTCP2_ERR_NOBUF ||
          n === NGTCP2_ERR_PKT_NUM_EXHAUSTED ||
          n === NGTCP2_ERR_STREAM_DATA_BLOCKED ||
          n === NGTCP2_ERR_STREAM_NOT_FOUND ||
          n === NGTCP2_ERR_STREAM_SHUT_WR
        ) {
          ngtcp2Sym!.ngtcp2_conn_update_pkt_tx_time(this.#conn, ts);
          break;
        }
        if (n === NGTCP2_ERR_WRITE_MORE) {
          this.#fail(ngtcp2Error(n, 'ngtcp2_conn_write'));
          break;
        }
        if (n === NGTCP2_ERR_DRAINING || n === NGTCP2_ERR_CLOSING) {
          this.#closeFromTransport();
          break;
        }
        this.#fail(ngtcp2Error(n, 'ngtcp2_conn_write'));
        break;
      }
      if (packetBatch.length > 0 && !this.#closed) {
        this.#flushPacketBatch(packetBatch);
      }
      this.#scheduleTimer();
      this.#maybeFinishGracefulClose();
      if (packets >= packetBudget && !this.#closed && this.#blockedSend.length === 0) {
        this.#scheduleWriteDrain(remoteAddress);
      }
    } finally {
      this.#writeDrainInProgress = false;
      if (this.#writeDrainAgain && !this.#closed) {
        this.#writeDrainAgain = false;
        const drainRemoteAddress = this.#writeDrainRemoteAddress ?? remoteAddress;
        this.#writeDrainRemoteAddress = null;
        this.#scheduleWriteDrain(drainRemoteAddress);
      }
    }
  }
  [quicConnectionInternals.scheduleWrites](remoteAddress: QuicAddress = this.remoteAddress): void {
    this.#scheduleWriteDrain(remoteAddress);
  }
  [quicConnectionInternals.scheduleStreamWriterFlush](callback: () => void): void {
    this.#runtime.setTimer(0, callback);
  }
  #scheduleWriteDrain(remoteAddress: QuicAddress = this.remoteAddress): void {
    this.#writeDrainRemoteAddress = remoteAddress;
    if (this.#writeDrainScheduled) return;
    this.#writeDrainScheduled = true;
    this.#runtime.defer(() => {
      if (!this.#writeDrainScheduled) return;
      const drainRemoteAddress = this.#writeDrainRemoteAddress ?? this.remoteAddress;
      this.#writeDrainRemoteAddress = null;
      this[quicConnectionInternals.driveWrites](drainRemoteAddress);
    });
  }
  #scheduleTimer(): void {
    if (this.#closed) return;
    const expiry = ngtcp2Sym!.ngtcp2_conn_get_expiry(this.#conn) as bigint;
    const idleDeadline = this.#nextStreamIdleDeadline();
    // Coalesce: the #timer is a one-shot armed to fire at an absolute time
    // (min of expiry and the stream-idle deadline). #scheduleTimer runs on every
    // received packet and every write drain, but those targets usually don't
    // move between calls, so re-arming would only churn a Promise, a closure, a
    // Map entry, two kqueue changelist entries, and a get_expiry FFI for no
    // change in when the timer fires. Skip when an armed timer already matches.
    if (
      this.#timer !== null &&
      expiry === this.#armedExpiry &&
      idleDeadline === this.#armedIdleDeadline
    ) {
      return;
    }
    if (this.#timer !== null) this.#timer.cancel?.();
    this.#timer = null;
    this.#armedExpiry = expiry;
    this.#armedIdleDeadline = idleDeadline;
    const current = now(this.#runtime);
    if (expiry === NGTCP2_NO_EXPIRY) {
      if (idleDeadline !== null) {
        const delayMs =
          idleDeadline <= current ? 1 : Math.max(1, Number((idleDeadline - current) / 1000000n));
        this.#timer = this.#runtime.setTimer(delayMs, () => this.#handleTimerExpiry());
      }
      return;
    }
    if (expiry <= current) {
      // Nothing armed via #timer; force re-evaluation on the next call.
      this.#armedExpiry = -1n;
      this.#scheduleImmediateTimerExpiry();
      return;
    }
    let delayMs = Math.max(1, Number((expiry - current) / 1000000n));
    if (idleDeadline !== null) {
      const idleMs =
        idleDeadline <= current ? 1 : Math.max(1, Number((idleDeadline - current) / 1000000n));
      delayMs = Math.min(delayMs, idleMs);
    }
    this.#timer = this.#runtime.setTimer(delayMs, () => this.#handleTimerExpiry());
  }
  #scheduleImmediateTimerExpiry(): void {
    if (this.#immediateTimerScheduled) return;
    this.#immediateTimerScheduled = true;
    this.#runtime.defer(() => {
      this.#immediateTimerScheduled = false;
      this.#handleTimerExpiry();
    });
  }
  #handleTimerExpiry(): void {
    if (this.#closed) return;
    this.#timer = null;
    const expiry = ngtcp2Sym!.ngtcp2_conn_get_expiry(this.#conn) as bigint;
    const current = now(this.#runtime);
    if (expiry === NGTCP2_NO_EXPIRY) {
      this.#checkStreamIdleTimeout(current);
      this.#scheduleTimer();
      return;
    }
    if (expiry > current) {
      this.#checkStreamIdleTimeout(current);
      this.#scheduleTimer();
      return;
    }
    const rc = ngtcp2Sym!.ngtcp2_conn_handle_expiry(this.#conn, current) as number;
    if (rc === NGTCP2_ERR_IDLE_CLOSE) this.#closeFromTransport();
    else if (rc !== 0 && rc !== NGTCP2_ERR_DRAINING && rc !== NGTCP2_ERR_CLOSING)
      this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_handle_expiry'));
    else {
      this[quicConnectionInternals.driveWrites]();
      this.#checkStreamIdleTimeout(current);
    }
  }
  #nextStreamIdleDeadline(): bigint | null {
    const timeout = this.#options.connection.streamIdleTimeout;
    if (timeout <= 0n || this.#peerStreamActivity.size === 0) return null;
    let nextDue: bigint | null = null;
    for (const lastActivity of this.#peerStreamActivity.values()) {
      const due = lastActivity + timeout;
      if (nextDue === null || due < nextDue) nextDue = due;
    }
    return nextDue;
  }
  #recordPeerStreamActivity(streamId: number): void {
    if (this.#streamInitiatedByLocal(streamId)) return;
    this.#peerStreamActivity.set(streamId, now(this.#runtime));
  }
  #checkStreamIdleTimeout(current: bigint): void {
    const timeout = this.#options.connection.streamIdleTimeout;
    if (timeout <= 0n || this.#peerStreamActivity.size === 0 || this.#closed) return;
    for (const [streamId, lastActivity] of Array.from(this.#peerStreamActivity)) {
      if (current - lastActivity <= timeout) continue;
      const stream = this.#streams.get(streamId);
      this.#peerStreamActivity.delete(streamId);
      if (stream === undefined || this.#streamInitiatedByLocal(streamId)) continue;
      const rc = ngtcp2Sym!.ngtcp2_conn_shutdown_stream(
        this.#conn,
        0,
        BigInt(streamId),
        0n,
      ) as number;
      if (rc !== 0 && rc !== NGTCP2_ERR_STREAM_NOT_FOUND && rc !== NGTCP2_ERR_STREAM_SHUT_WR) {
        this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_shutdown_stream'));
        return;
      }
      this.#stats.streamsIdleTimedOut++;
      this.#releaseStreamData(streamId);
      this.#extendMaxStreamsOnRemoteClose(streamId);
      stream[quicStreamInternals.closeFromConnection](new Error('QUIC stream idle timeout'));
      this.#scheduleWriteDrain();
    }
  }
  [quicConnectionInternals.onRemoteStreamOpen](streamId: number): void {
    this.#recordPeerStreamActivity(streamId);
    this.#ensureStream(
      streamId,
      ngtcp2Sym!.ngtcp2_is_bidi_stream(BigInt(streamId)) ? 'bidirectional' : 'unidirectional',
      true,
    );
  }
  [quicConnectionInternals.onLocalStreamCredit](
    direction: 'bidirectional' | 'unidirectional',
  ): void {
    const waiter = this.#localStreamCreditWaiters[direction].shift();
    if (waiter !== undefined) waiter.resolve(undefined);
  }
  [quicConnectionInternals.onStreamData](
    streamId: number,
    offset: number,
    data: Uint8Array,
    fin: boolean,
  ): void {
    this.#recordPeerStreamActivity(streamId);
    const stream = this.#ensureStream(
      streamId,
      ngtcp2Sym!.ngtcp2_is_bidi_stream(BigInt(streamId)) ? 'bidirectional' : 'unidirectional',
      true,
    );
    stream[quicStreamInternals.pushIncoming](offset, data, fin);
  }
  [quicConnectionInternals.onStreamDataCredit](_streamId: number, _maxData: number): void {
    this.#scheduleWriteDrain();
  }
  [quicConnectionInternals.extendStreamReceiveCredit](streamId: number, bytes: number): void {
    if (bytes <= 0 || this.#closed) return;
    const rc = ngtcp2Sym!.ngtcp2_conn_extend_max_stream_offset(
      this.#conn,
      BigInt(streamId),
      BigInt(bytes),
    ) as number;
    if (rc !== 0) {
      this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_extend_max_stream_offset'));
      return;
    }
    this.#scheduleWriteDrain();
  }
  [quicConnectionInternals.extendConnectionReceiveCredit](bytes: number): void {
    if (bytes <= 0 || this.#closed) return;
    if (inNativeCallback()) {
      this.#deferredConnectionReceiveCredit += bytes;
      deferAfterNativeCallback(() => this.#flushDeferredConnectionReceiveCredit());
      return;
    }
    this.#extendConnectionReceiveCreditNow(bytes);
  }
  #extendConnectionReceiveCreditNow(bytes: number): void {
    if (bytes <= 0 || this.#closed) return;
    ngtcp2Sym!.ngtcp2_conn_extend_max_offset(this.#conn, BigInt(bytes));
    this.#scheduleWriteDrain();
  }
  #flushDeferredConnectionReceiveCredit(): void {
    const bytes = this.#deferredConnectionReceiveCredit;
    this.#deferredConnectionReceiveCredit = 0;
    this.#extendConnectionReceiveCreditNow(bytes);
  }
  [quicConnectionInternals.onStreamClose](streamId: number): void {
    this.#peerStreamActivity.delete(streamId);
    this.#ackOutstandingStreamData(streamId);
    this.#releaseStreamData(streamId);
    this.#extendMaxStreamsOnRemoteClose(streamId);
    this.#streams.get(streamId)?.[quicStreamInternals.closeFromConnection]();
  }
  [quicConnectionInternals.onStreamReset](streamId: number, code: number): void {
    this.#peerStreamActivity.delete(streamId);
    this.#releaseStreamData(streamId);
    this.#extendMaxStreamsOnRemoteClose(streamId);
    this.#streams.get(streamId)?.[quicStreamInternals.resetFromConnection](code);
  }
  [quicConnectionInternals.onStreamStopSending](streamId: number, code: number): void {
    this.#streams.get(streamId)?.[quicStreamInternals.stopSendingFromConnection](code);
    this.#scheduleWriteDrain();
  }
  #extendMaxStreamsOnRemoteClose(streamId: number): void {
    if (this.#creditedRemoteStreamCloses.has(streamId)) return;
    const initiator = streamId & 1;
    const remoteInitiated = this.#role === 'client' ? initiator === 1 : initiator === 0;
    if (!remoteInitiated) return;
    this.#creditedRemoteStreamCloses.add(streamId);
    const direction = ngtcp2Sym!.ngtcp2_is_bidi_stream(BigInt(streamId))
      ? 'bidirectional'
      : 'unidirectional';
    this.#deferredMaxStreamsCredit[direction]++;
    this.#scheduleMaxStreamsCreditFlush();
  }
  #extendMaxStreamsNow(direction: 'bidirectional' | 'unidirectional', streams: number): void {
    if (streams <= 0 || this.#closed) return;
    if (direction === 'bidirectional') {
      ngtcp2Sym!.ngtcp2_conn_extend_max_streams_bidi(this.#conn, streams);
    } else {
      ngtcp2Sym!.ngtcp2_conn_extend_max_streams_uni(this.#conn, streams);
    }
    this.#scheduleWriteDrain();
  }
  #flushDeferredMaxStreamsCredit(): void {
    const bidirectional = this.#deferredMaxStreamsCredit.bidirectional;
    const unidirectional = this.#deferredMaxStreamsCredit.unidirectional;
    this.#deferredMaxStreamsCredit.bidirectional = 0;
    this.#deferredMaxStreamsCredit.unidirectional = 0;
    this.#extendMaxStreamsNow('bidirectional', bidirectional);
    this.#extendMaxStreamsNow('unidirectional', unidirectional);
  }
  #scheduleMaxStreamsCreditFlush(): void {
    if (this.#maxStreamsCreditFlushScheduled) return;
    this.#maxStreamsCreditFlushScheduled = true;
    this.#runtime.setTimer(0, () => {
      this.#maxStreamsCreditFlushScheduled = false;
      this.#flushDeferredMaxStreamsCredit();
    });
  }
  [quicConnectionInternals.onDatagram](data: Uint8Array, earlyData: boolean): void {
    if (!this.#options.datagrams.enabled) return;
    this.#stats.datagramsReceived++;
    const receivedEarlyData =
      earlyData || (this.#role === 'server' && this.#readingPacketStartedConnecting);
    this.#lastDatagramEvent = {
      data: data.slice(),
      earlyData: receivedEarlyData,
    };
    this.#datagramQueue.push(data);
    publishQuicTopic('quic.session.receive.datagram', {
      connection: this,
      length: data.byteLength,
      earlyData: receivedEarlyData,
    });
    this.#dispatch(
      new QuicDatagramEvent('datagram', {
        data,
        earlyData: receivedEarlyData,
      }),
    );
  }
  [quicConnectionInternals.onDatagramStatus](id: number, status: QuicDatagramStatus): void {
    if (status === 'ack') this.#stats.datagramsAcked++;
    else if (status === 'lost') this.#stats.datagramsLost++;
    else this.#stats.datagramsAbandoned++;
    publishQuicTopic('quic.session.receive.datagram.status', {
      connection: this,
      id,
      status,
    });
    this.#dispatch(
      new QuicDatagramStatusEvent('datagramstatus', {
        id,
        status,
      }),
    );
    const eventType =
      status === 'ack' ? 'datagramack' : status === 'lost' ? 'datagramlost' : 'datagramabandoned';
    this.#dispatch(
      new QuicDatagramStatusEvent(eventType, {
        id,
        status,
      }),
    );
  }
  [quicConnectionInternals.onKeyInstalled](_level: number): void {}
  [quicConnectionInternals.onVersionNegotiation](
    hd: ArrayBuffer | null,
    sv: ArrayBuffer | null,
    nsv: number,
  ): void {
    const wireVersion =
      hd === null || hd.byteLength < PKT_HD_VERSION + 4
        ? this.#wireVersion
        : readU32(hd, PKT_HD_VERSION);
    const requestedWireVersions: number[] = [];
    const versions = copyFromPtr(sv, Math.max(0, nsv) * 4);
    const view = new DataView(versions.buffer, versions.byteOffset, versions.byteLength);
    for (let offset = 0; offset + 4 <= versions.byteLength; offset += 4) {
      requestedWireVersions.push(view.getUint32(offset, true));
    }
    this.#versionNegotiationVersions = requestedWireVersions.slice();
    if (
      this.#role === 'client' &&
      this.#state === 'connecting' &&
      !this.#versionNegotiationRetried
    ) {
      this.#versionNegotiationPendingRetry = true;
    }
    this.#publishVersionNegotiation(wireVersion, requestedWireVersions);
  }
  [quicConnectionInternals.onVersionNegotiationForTest](
    wireVersion: number,
    requestedWireVersions: number[],
    supportedWireVersions?: number[],
  ): void {
    this.#publishVersionNegotiation(wireVersion, requestedWireVersions, supportedWireVersions);
  }
  #publishVersionNegotiation(
    wireVersion: number,
    requestedWireVersions: number[],
    supportedWireVersions = this.#options.versions.map(versionToWire),
  ): void {
    publishQuicTopic('quic.session.version.negotiation', {
      connection: this,
      version:
        wireVersion === NGTCP2_PROTO_VER_V1 || wireVersion === NGTCP2_PROTO_VER_V2
          ? wireVersionToName(wireVersion)
          : null,
      wireVersion,
      requestedWireVersions: Object.freeze(requestedWireVersions.slice()),
      supportedWireVersions: Object.freeze(supportedWireVersions.slice()),
    });
  }
  [quicConnectionInternals.onNewToken](token: Uint8Array): void {
    if (this.#sessionKey === null || token.byteLength === 0) return;
    const addressToken = token.slice();
    this.#endpoint[quicEndpointInternals.storeAddressToken](this.#sessionKey, addressToken);
    if (this.#options.sessionStore !== undefined) {
      const store = this.#options.sessionStore;
      const key = this.#sessionKey;
      void Promise.resolve(store.load(key))
        .then((existing) => {
          return store.save(key, {
            ...(existing ?? {}),
            addressToken,
          });
        })
        .catch((error) => {
          if (!this.#closed)
            this.#dispatch(
              new QuicErrorEvent('error', {
                error: error instanceof Error ? error : new Error(String(error)),
              }),
            );
        });
    }
    const eventToken = addressToken.slice();
    this.#dispatch(
      new QuicNewTokenEvent('newtoken', {
        token: eventToken,
        address: this.remoteAddress,
      }),
    );
    publishQuicTopic('quic.session.new.token', {
      connection: this,
      token: eventToken,
      address: this.remoteAddress,
    });
  }
  [quicConnectionInternals.onQlogWrite](flags: number, data: Uint8Array): void {
    if (this.#options.qlog === false) return;
    try {
      const fd = this.#openQlogFd();
      if (data.byteLength > 0) writeAllFd(fd, data);
      if ((flags & NGTCP2_QLOG_WRITE_FLAG_FIN) !== 0) this.#closeQlogFd();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/open failed/.test(message)) this.#stats.qlogOpenFailed++;
      else this.#stats.qlogWriteFailed++;
      if (!this.#closed)
        this.#dispatch(
          new QuicErrorEvent('error', {
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        );
    }
  }
  #openQlogFd(): number {
    if (this.#qlogFd !== null) return this.#qlogFd;
    const qlog = this.#options.qlog;
    if (qlog === false) throw new Error('qlog is disabled');
    const output = qlogOutputPath(qlog.path, this.connectionId);
    if (output.directory !== undefined && output.directory.length > 0) {
      fileLib.symbols.mkdir(fileCstr(output.directory), 493);
    }
    const fd = Number(
      fileLib.symbols.open(fileCstr(output.path), O_WRONLY | O_CREAT | O_TRUNC, 420),
    );
    if (fd < 0) throw new Error(`qlog open failed: ${fd}`);
    fileLib.symbols.fchmod(fd, 420);
    this.#qlogOpened = true;
    this.#qlogFd = fd;
    return fd;
  }
  #writeFallbackQlog(): void {
    if (this.#options.qlog === false || this.#qlogOpened) return;
    const fd = this.#openQlogFd();
    const body = `{"qlog_format":"JSON-SEQ","qlog_version":"0.3","title":"fino-quic-${this.connectionId}","events":[{"name":"packet","data":{"trigger":"connection_closed"}}]}\n`;
    writeAllFd(fd, new TextEncoder().encode(body));
  }
  #materializeInitialQlog(): void {
    try {
      this.#writeFallbackQlog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/open failed/.test(message)) this.#stats.qlogOpenFailed++;
      else this.#stats.qlogWriteFailed++;
    } finally {
      this.#closeQlogFd();
    }
  }
  #finalizeQlog(): void {
    try {
      this.#writeFallbackQlog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/open failed/.test(message)) this.#stats.qlogOpenFailed++;
      else this.#stats.qlogWriteFailed++;
    } finally {
      this.#closeQlogFd();
    }
  }
  #closeQlogFd(): void {
    if (this.#qlogFd === null) return;
    fileLib.symbols.close(this.#qlogFd);
    this.#qlogFd = null;
  }
  [quicConnectionInternals.onEarlyDataRejected](): void {
    this.#earlyDataReady = false;
    this.#earlyDataQueuedBytes = 0;
    publishQuicTopic('quic.session.early.rejected', { connection: this });
    this.#dispatch(
      new QuicEarlyDataEvent('earlydata', {
        accepted: false,
        rejected: true,
        reason: 'rejected-by-peer',
      }),
    );
  }
  [quicConnectionInternals.onPathValidationStarted](
    path: ArrayBuffer | null,
    fallbackPath?: ArrayBuffer | null,
    flags = 0,
  ): void {
    this.#activePathValidations.push({
      path: pathSnapshotFromNative(path, this.#fd),
      previousPath: pathSnapshotFromNative(fallbackPath ?? null, this.#fd),
      preferredAddress: (flags & NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR) !== 0,
      newToken: (flags & NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN) !== 0,
    });
  }
  [quicConnectionInternals.onPathValidationFinished](
    path: ArrayBuffer | null,
    fallbackPath: ArrayBuffer | null,
    result: number,
    flags: number,
  ): void {
    const validatedSnapshot = pathSnapshotFromNative(path, this.#fd);
    const fallbackSnapshot = pathSnapshotFromNative(fallbackPath, this.#fd);
    this.#forgetActivePathValidation(validatedSnapshot, fallbackSnapshot, flags);
    const snapshot =
      result === NGTCP2_PATH_VALIDATION_RESULT_SUCCESS ? validatedSnapshot : fallbackSnapshot;
    const init = {
      result: pathValidationResultName(result),
      path: pathFromSnapshot(validatedSnapshot),
      previousPath: pathFromSnapshot(fallbackSnapshot),
      preferredAddress: (flags & NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR) !== 0,
      newToken: (flags & NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN) !== 0,
    };
    deferAfterNativeCallback(() => {
      const activePathChanged = this.#syncActivePathSnapshot(snapshot);
      publishQuicTopic('quic.session.path.validation', {
        connection: this,
        ...init,
      });
      this.#dispatch(new QuicPathValidationEvent('pathvalidation', init));
      if (
        result === NGTCP2_PATH_VALIDATION_RESULT_SUCCESS &&
        (activePathChanged || pathSnapshotsDiffer(validatedSnapshot, fallbackSnapshot))
      ) {
        this.#dispatch(new QuicPathValidationEvent('migration', init));
      }
    });
  }
  #forgetActivePathValidation(
    path: PathSnapshot | null,
    previousPath: PathSnapshot | null,
    flags: number,
  ): void {
    const preferredAddress = (flags & NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR) !== 0;
    const newToken = (flags & NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN) !== 0;
    const index = this.#activePathValidations.findIndex(
      (validation) =>
        !pathSnapshotsDiffer(validation.path, path) &&
        !pathSnapshotsDiffer(validation.previousPath, previousPath) &&
        validation.preferredAddress === preferredAddress &&
        validation.newToken === newToken,
    );
    if (index >= 0) this.#activePathValidations.splice(index, 1);
  }
  #abortActivePathValidations(): void {
    if (this.#activePathValidations.length === 0) return;
    const validations = this.#activePathValidations.splice(0);
    for (const validation of validations) {
      const init = {
        result: 'aborted' as const,
        path: pathFromSnapshot(validation.path),
        previousPath: pathFromSnapshot(validation.previousPath),
        preferredAddress: validation.preferredAddress,
        newToken: validation.newToken,
      };
      publishQuicTopic('quic.session.path.validation', {
        connection: this,
        ...init,
      });
      this.#dispatch(new QuicPathValidationEvent('pathvalidation', init));
    }
  }
  [quicConnectionInternals.selectPreferredAddress](
    dest: ArrayBuffer | null,
    paddr: ArrayBuffer | null,
  ): number {
    if (
      dest === null ||
      paddr === null ||
      !this.#options.migration.enabled ||
      !this.#options.migration.usePreferredAddress
    )
      return 0;
    const localAddress = this.#activeLocalAddress;
    const remoteAddress = preferredAddressFromNative(paddr, localAddress.family);
    if (remoteAddress === null) return 0;
    const path = this.#retainPath(localAddress, remoteAddress, this.#fd);
    if (!writeNativePathAddress(dest, PATH_LOCAL, localAddress)) return NGTCP2_ERR_CALLBACK_FAILURE;
    if (!writeNativePathAddress(dest, PATH_REMOTE, remoteAddress))
      return NGTCP2_ERR_CALLBACK_FAILURE;
    writeNativePathUserData(dest, path.userData);
    return 0;
  }
  #ensureStream(
    streamId: number,
    direction: 'bidirectional' | 'unidirectional',
    incoming: boolean,
  ): QuicStream {
    let stream = this.#streams.get(streamId);
    if (!stream) {
      stream = new QuicStream(streamId, direction, this, incoming);
      this.#streams.set(streamId, stream);
      if (incoming) {
        this.#stats.streamsReceived++;
        if (direction === 'bidirectional') this.#stats.bidiIncomingStreams++;
        else this.#stats.uniIncomingStreams++;
      } else {
        this.#stats.streamsOpened++;
        if (direction === 'bidirectional') this.#stats.bidiOutgoingStreams++;
        else this.#stats.uniOutgoingStreams++;
      }
      publishQuicTopic(incoming ? 'quic.session.received.stream' : 'quic.session.open.stream', {
        connection: this,
        stream,
        direction,
      });
      if (incoming) {
        if (this.#gracefulClosing) {
          if (ptrAddress(this.#conn) !== 0n) {
            ngtcp2Sym!.ngtcp2_conn_shutdown_stream(this.#conn, 0, BigInt(streamId), 0n);
            this.#scheduleWriteDrain();
          }
          return stream;
        }
        if (this.#incomingStreamHook !== null) {
          // Direct hook (h3 drivers): no QuicStreamEvent, no EventTarget
          // dispatch, no #streamQueue buffering. Preserve the "run after the
          // native callback unwinds" ordering the event path guarantees.
          const hook = this.#incomingStreamHook;
          deferAfterNativeCallback(() => hook(stream));
          return stream;
        }
        if (inNativeCallback()) {
          this.#dispatch(new QuicStreamEvent('stream', { stream }));
          this.#streamQueue.push(stream);
          return stream;
        }
        this.#streamQueue.push(stream);
        this.#dispatch(new QuicStreamEvent('stream', { stream }));
      }
    }
    return stream;
  }
  [quicConnectionInternals.removeStream](stream: QuicStream): void {
    this.#peerStreamActivity.delete(stream.id);
    this.#streams.delete(stream.id);
    this.#closedStreams.set(stream.id, stream);
    this.#stats.streamsClosed++;
    this.#maybeFinishGracefulClose();
  }
  [quicConnectionInternals.onAckedStreamDataOffset](
    streamId: number,
    offset: number,
    datalen: number,
  ): void {
    (this.#streams.get(streamId) ?? this.#closedStreams.get(streamId))?.[
      quicStreamInternals.recordAck
    ](offset, datalen);
    const end = offset + datalen;
    const outstanding: OutstandingStreamData[] = [];
    for (const entry of this.#outstandingStreamData) {
      if (entry.streamId !== streamId || end <= entry.start || offset >= entry.end) {
        outstanding.push(entry);
        continue;
      }
      if (offset > entry.start) {
        outstanding.push({
          streamId,
          start: entry.start,
          end: offset,
          data: entry.data.subarray(0, offset - entry.start),
        });
      }
      if (end < entry.end) {
        outstanding.push({
          streamId,
          start: end,
          end: entry.end,
          data: entry.data.subarray(end - entry.start),
        });
      }
    }
    this.#outstandingStreamData = outstanding;
    if (!this.#outstandingStreamData.some((entry) => entry.streamId === streamId)) {
      this.#closedStreams.delete(streamId);
    }
  }
  #ackOutstandingStreamData(streamId: number): void {
    const stream = this.#streams.get(streamId) ?? this.#closedStreams.get(streamId);
    if (stream === undefined) return;
    for (const entry of this.#outstandingStreamData) {
      if (entry.streamId !== streamId) continue;
      stream[quicStreamInternals.recordAck](entry.start, entry.end - entry.start);
    }
  }
  #releaseStreamData(streamId: number): void {
    this.#nextStreamOffsets.delete(streamId);
    this.#outstandingStreamData = this.#outstandingStreamData.filter(
      (entry) => entry.streamId !== streamId,
    );
    this.#closedStreams.delete(streamId);
    this.#dropPendingWrites(streamId);
  }
  #dropPendingWrites(streamId: number): void {
    this.#pendingWrites = this.#pendingWrites.filter((entry) => entry.streamId !== streamId);
  }
}

core.registerQuicConnectionClass(QuicConnection);
export { quicConnectionInternals, quicIncomingStreamHook } from './core.ts';
export type {
  QuicConnectionOptions,
  QuicConnectionState,
  QuicConnectionStats,
  QuicPeerVerification,
  QuicStreamOpenOptions,
  QuicTransportParameterSnapshot,
} from './core.ts';
