/**
* internal:net/quic/endpoint — low-level QUIC over ngtcp2.
*
* QUIC transport specification: https://www.rfc-editor.org/rfc/rfc9000
*
* This module implements the public `fino:net/quic` object model using UDP,
* ngtcp2 and a selectable ngtcp2 crypto backend. It deliberately does not use
* high-level QUIC transport APIs from TLS libraries; ngtcp2 owns QUIC packet
* parsing, recovery, stream state, flow control, and timers. The TLS library is
* used only through ngtcp2's crypto helper backend.
*
* @internal
*/
import { Event, EventTarget } from '../../../globals/eventtarget.ts';
import { atob, encodeUtf8 } from '../../../globals/encoding.ts';
import { BytesReader, BytesWriter } from '../../stream.ts';
import * as loop from '../../runtime/loop.ts';
import { topic } from '../../../context/topic.ts';
import { lib as fileLib, cstr as fileCstr, O_APPEND, O_CREAT, O_TRUNC, O_WRONLY } from '../../file/bindings.ts';
import { AF_INET, AF_INET6, EAGAIN, IPPROTO_IP, IPPROTO_IPV6, IPPROTO_UDP, IPV6_UNICAST_HOPS, IPV6_RECVTCLASS, IPV6_V6ONLY, IP_RECVTOS, IP_TTL, SOL_SOCKET, SO_RCVBUF, SO_REUSEPORT, SO_SNDBUF, SOCK_DGRAM, bind as socketBind, close as socketClose, createDatagramRecvBatch, decodeAddr, encodeAddr, getsockname, recvmsgEcn, recvfrom, sendmmsgBatch, sendmsgEcn, sendto, setNonblocking, setsockopt, socket } from '../../../net/socket.ts';
import type { DatagramRecvBatch } from '../../../net/socket.ts';
import { randBytes } from '../../openssl.ts';
import { CB_ACKED_STREAM_DATA_OFFSET, CB_ACK_DATAGRAM, CB_CLIENT_INITIAL, CB_DELETE_CRYPTO_AEAD_CTX, CB_DELETE_CRYPTO_CIPHER_CTX, CB_DECRYPT, CB_ENCRYPT, CB_EXTEND_MAX_LOCAL_STREAMS_BIDI, CB_EXTEND_MAX_LOCAL_STREAMS_UNI, CB_EXTEND_MAX_STREAM_DATA, CB_GET_NEW_CONNECTION_ID, CB_GET_NEW_CONNECTION_ID2, CB_GET_PATH_CHALLENGE_DATA, CB_GET_PATH_CHALLENGE_DATA2, CB_HANDSHAKE_COMPLETED, CB_HANDSHAKE_CONFIRMED, CB_HP_MASK, CB_BEGIN_PATH_VALIDATION, CB_DCID_STATUS, CB_DCID_STATUS2, CB_EARLY_DATA_REJECTED, CB_LOST_DATAGRAM, CB_PATH_VALIDATION, CB_RAND, CB_REMOVE_CONNECTION_ID, CB_RECV_DATAGRAM, CB_RECV_CLIENT_INITIAL, CB_RECV_CRYPTO_DATA, CB_RECV_NEW_TOKEN, CB_RECV_RETRY, CB_RECV_RX_KEY, CB_RECV_STATELESS_RESET, CB_RECV_STATELESS_RESET2, CB_RECV_STREAM_DATA, CB_RECV_TX_KEY, CB_RECV_VERSION_NEGOTIATION, CB_STREAM_CLOSE, CB_STREAM_OPEN, CB_STREAM_RESET, CB_STREAM_STOP_SENDING, CB_SELECT_PREFERRED_ADDR, CB_UPDATE_KEY, CB_VERSION_NEGOTIATION, CONN_INFO_BYTES_IN_FLIGHT, CONN_INFO_BYTES_LOST, CONN_INFO_BYTES_RECV, CONN_INFO_BYTES_SENT, CONN_INFO_CWND, CONN_INFO_LATEST_RTT, CONN_INFO_MIN_RTT, CONN_INFO_PING_RECV, CONN_INFO_PKT_DISCARDED, CONN_INFO_PKT_LOST, CONN_INFO_PKT_RECV, CONN_INFO_PKT_SENT, CONN_INFO_RTTVAR, CONN_INFO_SMOOTHED_RTT, CONN_INFO_SSTHRESH, ADDR_ADDR, ADDR_ADDRLEN, CCERR_TYPE, CCERR_ERROR_CODE, CCERR_REASON, CCERR_REASONLEN, CID_DATA, CID_DATALEN, NGTCP2_CALLBACKS_SIZE, NGTCP2_CALLBACKS_VERSION, NGTCP2_CCERR_SIZE, NGTCP2_CONN_INFO_SIZE, NGTCP2_CONN_INFO_VERSION, NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE, NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE, NGTCP2_CID_SIZE, NGTCP2_CRYPTO_ERROR, NGTCP2_ERR_CLOSING, NGTCP2_ERR_CALLBACK_FAILURE, NGTCP2_ERR_CRYPTO, NGTCP2_ERR_DRAINING, NGTCP2_ERR_DROP_CONN, NGTCP2_ERR_IDLE_CLOSE, NGTCP2_ERR_NOBUF, NGTCP2_ERR_PKT_NUM_EXHAUSTED, NGTCP2_ERR_RECV_VERSION_NEGOTIATION, NGTCP2_ERR_RETRY, NGTCP2_ERR_STREAM_ID_BLOCKED, NGTCP2_ERR_STREAM_DATA_BLOCKED, NGTCP2_ERR_STREAM_SHUT_WR, NGTCP2_ERR_STREAM_NOT_FOUND, NGTCP2_ERR_VERSION_NEGOTIATION, NGTCP2_ERR_WRITE_MORE, NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE, NGTCP2_MAX_CIDLEN, NGTCP2_MAX_UDP_PAYLOAD_SIZE, NGTCP2_ERR_INVALID_STATE, NGTCP2_WRITE_STREAM_FLAG_MORE, NGTCP2_PATH_SIZE, PATH_LOCAL, PATH_REMOTE, PATH_USER_DATA, SETTINGS_AVAILABLE_VERSIONS, SETTINGS_AVAILABLE_VERSIONSLEN, SETTINGS_ACK_THRESH, SETTINGS_CC_ALGO, SETTINGS_HANDSHAKE_TIMEOUT, SETTINGS_INITIAL_TS, SETTINGS_INITIAL_RTT, SETTINGS_MAX_TX_UDP_PAYLOAD_SIZE, SETTINGS_MAX_STREAM_WINDOW, SETTINGS_MAX_WINDOW, SETTINGS_NO_TX_UDP_PAYLOAD_SIZE_SHAPING, SETTINGS_NO_PMTUD, SETTINGS_ORIGINAL_VERSION, SETTINGS_PREFERRED_VERSIONS, SETTINGS_PREFERRED_VERSIONSLEN, SETTINGS_QLOG_WRITE, SETTINGS_TOKEN, SETTINGS_TOKENLEN, SETTINGS_TOKEN_TYPE } from './ngtcp2/bindings.ts';
import { NGTCP2_PKT_HD_SIZE, NGTCP2_PKT_INFO_VERSION, NGTCP2_PKT_INFO_SIZE, NGTCP2_ECN_NOT_ECT, NGTCP2_ECN_ECT_0, NGTCP2_ECN_MASK, PKT_INFO_ECN, NGTCP2_PROTO_VER_V2, NGTCP2_PROTO_VER_V1, NGTCP2_SETTINGS_SIZE, NGTCP2_SETTINGS_VERSION, NGTCP2_TRANSPORT_PARAMS_SIZE, NGTCP2_TRANSPORT_PARAMS_VERSION, NGTCP2_VERSION_CID_SIZE, NGTCP2_VEC_SIZE, NGTCP2_DATAGRAM_FLAG_0RTT, NGTCP2_WRITE_DATAGRAM_FLAG_NONE, NGTCP2_WRITE_STREAM_FLAG_FIN, TP_ACTIVE_CONNECTION_ID_LIMIT, TP_ACK_DELAY_EXPONENT, TP_DISABLE_ACTIVE_MIGRATION, TP_INITIAL_MAX_DATA, TP_INITIAL_MAX_STREAMS_BIDI, TP_INITIAL_MAX_STREAMS_UNI, TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL, TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE, TP_INITIAL_MAX_STREAM_DATA_UNI, TP_INITIAL_SCID, TP_INITIAL_SCID_PRESENT, TP_MAX_IDLE_TIMEOUT, TP_MAX_ACK_DELAY, TP_MAX_DATAGRAM_FRAME_SIZE, TP_MAX_UDP_PAYLOAD_SIZE, TP_ORIGINAL_DCID, TP_ORIGINAL_DCID_PRESENT, TP_RETRY_SCID, TP_RETRY_SCID_PRESENT, TP_PREFERRED_ADDR, TP_PREFERRED_ADDR_CID, TP_PREFERRED_ADDR_IPV4, TP_PREFERRED_ADDR_IPV4_PRESENT, TP_PREFERRED_ADDR_IPV6, TP_PREFERRED_ADDR_IPV6_PRESENT, TP_PREFERRED_ADDR_PRESENT, TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN, TP_STATELESS_RESET_TOKEN, TP_STATELESS_RESET_TOKEN_PRESENT, VEC_BASE, VEC_LEN, PKT_HD_DCID, PKT_HD_SCID, PKT_HD_TOKEN, PKT_HD_TOKENLEN, PKT_HD_VERSION, VERSION_CID_DCID, VERSION_CID_DCIDLEN, VERSION_CID_SCID, VERSION_CID_SCIDLEN, VERSION_CID_VERSION, NGTCP2_TOKEN_TYPE_RETRY, NGTCP2_TOKEN_TYPE_NEW_TOKEN, NGTCP2_TOKEN_TYPE_UNKNOWN, NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN, NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR, NGTCP2_PATH_VALIDATION_RESULT_ABORTED, NGTCP2_PATH_VALIDATION_RESULT_FAILURE, NGTCP2_PATH_VALIDATION_RESULT_SUCCESS, FfiCallback, Pointer, ngtcp2Available, ngtcp2ConnResetStreamAt, ngtcp2ResetStreamAtAvailable, ngtcp2PktWriteStatelessReset, ptr as ngtcp2Ptr, readCStr, requireNgtcp2, sym as ngtcp2Sym } from './ngtcp2/bindings.ts';
import { clearConnectionRef, configureSessionForConnection, cryptoAvailable, cryptoBackend as _cryptoBackend, freeContext, freeNativeHandle, freeSession, getAlpnSelected, getHandshakeInfo, getPeerCertificate, exportKeyingMaterial as exportTlsKeyingMaterial, exportSession, importSession, initCrypto, newClientContext, newClientSession, newNativeHandle, newServerContext, newServerSession, ptr as cryptoPtr, requireCrypto, sendSessionTicket, setConnectionRef, setSNIContexts, setSessionTicketCallback, sym as cryptoSym, type QuicCaOptions, type QuicCryptoBackend, type QuicTlsContext, type QuicTlsSession } from './ngtcp2/crypto.ts';
export type QuicAddress = {
  family: 'ipv4' | 'ipv6';
  ip: string;
  port: number;
};
const _PTR_SIZE = 8;
const _QUIC_PTR_PATH = 0;
const _QUIC_PTR_PKT_INFO = 1;
const _QUIC_PTR_DATA_LEN = 2;
const _QUIC_PTR_VEC = 3;
/** Local and remote socket addresses associated with a QUIC network path. */
export type QuicPath = {
  /** Local UDP socket address used for the path. */
  localAddress: QuicAddress;
  /** Remote peer UDP socket address used for the path. */
  remoteAddress: QuicAddress;
};
/** Result of an ngtcp2 path-validation attempt. */
export type QuicPathValidationResult = 'success' | 'failure' | 'aborted';
/** Supported QUIC wire versions accepted by public endpoint options. */
export type QuicVersion = 'v1' | 'v2';
/** TLS 1.3 cipher suites that are compatible with QUIC packet protection. */
export type QuicTlsCipherSuite = 'TLS_AES_128_GCM_SHA256' | 'TLS_AES_256_GCM_SHA384' | 'TLS_CHACHA20_POLY1305_SHA256';
/** Persisted TLS session material for future resumption and 0-RTT support. */
export type QuicSessionState = {
  /** Serialized TLS session ticket bytes, when TLS resumption is available. */
  ticket?: Uint8Array;
  /** Address-validation token received in a NEW_TOKEN frame. */
  addressToken?: Uint8Array;
  /** QUIC transport parameters associated with the session, when available. */
  transportParameters?: Uint8Array;
  /** Maximum remembered early-data bytes associated with this session. */
  earlyDataMax?: number;
  /** Negotiated QUIC version associated with the stored ticket. */
  version?: QuicVersion;
  /** Millisecond epoch expiry; expired sessions should not be reused. */
  expiresAt?: number;
};
/** Storage interface used by resumption and replay-checked 0-RTT policies. */
export interface QuicSessionStore {
  /** Load a session by lookup key, or return `null` when no valid state exists. */
  load(key: string): QuicSessionState | null | Promise<QuicSessionState | null>;
  /** Persist session state for a future connection attempt. */
  save(key: string, state: QuicSessionState): void | Promise<void>;
  /** Delete a session after expiry, incompatibility, or application policy change. */
  delete(key: string): void | Promise<void>;
}
/** Explicit application policy required before sending replayable 0-RTT data. */
export type QuicEarlyDataPolicy = {
  /** Must be `true` to confirm the application has replay-safe semantics. */
  replaySafe: true;
  /** Optional cap on early-data bytes a future implementation may send. */
  maxBytes?: number;
};
/** Server Retry and address-validation configuration. Enabled by default. */
export type QuicRetryOptions = false | {
  /** Whether this endpoint should require address validation with Retry. */
  enabled: boolean;
  /** Optional token secret. If omitted, implementations may generate one. */
  tokenSecret?: Uint8Array;
};
/** Connection migration policy. Disabled by default. */
export type QuicPreferredAddressOptions = QuicAddress | {
  /** IPv4 preferred address to advertise. */
  ipv4?: QuicAddress;
  /** IPv6 preferred address to advertise. */
  ipv6?: QuicAddress;
};
/** Connection migration policy. Disabled by default. */
export type QuicMigrationOptions = {
  /** Whether active migration APIs may be used. */
  enabled?: boolean;
  /** Optional preferred address or address pair to advertise. */
  preferredAddress?: QuicPreferredAddressOptions;
  /** Whether clients should use an advertised server preferred address. */
  usePreferredAddress?: boolean;
};
/** QUIC DATAGRAM negotiation settings from RFC 9221. */
export type QuicDatagramOptions = {
  /** Whether to advertise and accept DATAGRAM frames. */
  enabled?: boolean;
  /** Maximum DATAGRAM frame size this endpoint is willing to receive. */
  maxFrameSize?: number;
  /** Maximum number of locally queued outgoing DATAGRAM frames. */
  maxPending?: number;
  /** Queue overflow policy. Defaults to dropping the oldest queued datagram. */
  dropPolicy?: 'drop-oldest' | 'drop-newest';
  /** Send attempts before a pending datagram is abandoned. */
  maxSendAttempts?: number;
};
/** Per-connection QUIC transport tuning. */
export type QuicConnectionOptions = {
  /** TLS/QUIC handshake timeout in milliseconds. */
  handshakeTimeoutMs?: number;
  /** Initial RTT estimate in milliseconds; zero uses ngtcp2's default. */
  initialRttMs?: number;
  /** Keep-alive PING timeout in milliseconds; zero disables keep-alive. */
  keepAliveTimeoutMs?: number;
  /** Maximum serialized QUIC packet payload size. */
  maxPayloadSize?: number;
  /** Initial connection-level receive window. */
  maxWindow?: number;
  /** Initial stream-level receive window. */
  maxStreamWindow?: number;
  /** ACK threshold for unacknowledged packets; zero uses ngtcp2's default. */
  unacknowledgedPacketThreshold?: number;
  /** Congestion control algorithm. */
  congestionControl?: 'cubic' | 'reno' | 'bbr';
  /** Draining period PTO multiplier; minimum is 3. */
  drainingPeriodMultiplier?: number;
  /** Peer-initiated stream idle timeout in milliseconds; zero disables it. */
  streamIdleTimeoutMs?: number;
  /** Advertised max idle timeout in milliseconds. Zero disables idle timeout. */
  maxIdleTimeoutMs?: number;
  /** Advertised connection-level initial flow-control credit. */
  initialMaxData?: number;
  /** Advertised bidirectional stream receive credit for locally initiated streams. */
  initialMaxStreamDataBidiLocal?: number;
  /** Advertised bidirectional stream receive credit for peer-initiated streams. */
  initialMaxStreamDataBidiRemote?: number;
  /** Advertised unidirectional stream receive credit. */
  initialMaxStreamDataUni?: number;
  /** Advertised peer-created bidirectional stream limit. */
  initialMaxStreamsBidi?: number;
  /** Advertised peer-created unidirectional stream limit. */
  initialMaxStreamsUni?: number;
  /** Advertised active connection ID limit; clamped to 2..8. */
  activeConnectionIdLimit?: number;
  /** Advertised maximum ACK delay in milliseconds. */
  maxAckDelayMs?: number;
  /** Advertised ACK delay exponent. */
  ackDelayExponent?: number;
  /** Whether to advertise disable_active_migration. */
  disableActiveMigration?: boolean;
  /** Length in bytes for locally generated connection IDs. */
  cidLength?: number;
};
/** Token-bucket rate limit configuration for endpoint packet defenses. */
export type QuicRateLimitOptions = false | {
  /** Tokens replenished per second. */
  rate?: number;
  /** Maximum burst tokens available before throttling starts. */
  burst?: number;
};
/** Source-address allow/deny lists for incoming server packets. */
export type QuicSourceAddressOptions = {
  /** Optional exact IP or normalized address keys that are permitted. */
  allow?: string[];
  /** Optional exact IP or normalized address keys that are blocked. */
  deny?: string[];
};
/** Server-side QUIC transport controls and packet-defense tuning. */
export type QuicTransportOptions = {
  /** When true, refuse new server connection Initials without creating sessions. */
  busy?: boolean;
  /** Maximum active server connections accepted by this endpoint. Zero means unlimited. */
  maxConnections?: number;
  /** Maximum active server connections per remote IP address. Zero means unlimited. */
  maxConnectionsPerRemoteAddress?: number;
  /** Source-address allow/deny filtering applied before QUIC packet parsing. */
  sourceAddress?: QuicSourceAddressOptions;
  /** Retry token expiry in milliseconds. */
  retryTokenTimeoutMs?: number;
  /** NEW_TOKEN/address-token expiry in milliseconds. */
  addressTokenTimeoutMs?: number;
  /** Maximum address-validation cache entries. */
  addressValidationCacheSize?: number;
  /** Retry packet rate limit. */
  retryRateLimit?: QuicRateLimitOptions;
  /** Version Negotiation packet rate limit. */
  versionNegotiationRateLimit?: QuicRateLimitOptions;
  /** Stateless reset packet rate limit. */
  statelessResetRateLimit?: QuicRateLimitOptions;
  /** Immediate CONNECTION_CLOSE packet rate limit for refused Initial packets. */
  immediateCloseRateLimit?: QuicRateLimitOptions;
  /** Server session creation rate limit per remote address. */
  sessionCreationRateLimit?: QuicRateLimitOptions;
  /** Disable stateless resets for unknown short-header packets. */
  disableStatelessReset?: boolean;
  /** Whether to exchange ECN packet metadata with ngtcp2. Disabled by default. */
  ecn?: boolean;
};
/** qlog diagnostics configuration. Disabled by default. */
export type QuicQlogOptions = false | {
  /** Directory or file path for qlog output, depending on implementation policy. */
  path?: string;
  /** Optional event name filters for future qlog writers. */
  events?: string[];
};
/** TLS keylog diagnostics configuration. Disabled by default. */
export type QuicKeylogOptions = false | {
  /** File path for SSLKEYLOGFILE-compatible output. */
  path: string;
};
/** Endpoint-wide defaults inherited by `listen()` and `connect()`. */
export interface QuicEndpointOptions {
  alpnProtocols?: string[];
  versions?: QuicVersion[];
  tlsCipherSuites?: QuicTlsCipherSuite[];
  tlsGroups?: string[];
  retry?: QuicRetryOptions;
  sessionStore?: QuicSessionStore;
  earlyData?: false | QuicEarlyDataPolicy;
  migration?: QuicMigrationOptions;
  datagrams?: QuicDatagramOptions;
  connection?: QuicConnectionOptions;
  transport?: QuicTransportOptions;
  qlog?: QuicQlogOptions;
  keylog?: QuicKeylogOptions;
  socket?: QuicSocketOptions;
}
export type QuicSocketOptions = {
  ipv6Only?: boolean;
  reusePort?: boolean;
  receiveBufferSize?: number;
  sendBufferSize?: number;
  ttl?: number;
};
/** Per-listener QUIC options. Unspecified values inherit endpoint defaults. */
export interface QuicListenOptions {
  address?: QuicAddress;
  alpnProtocols?: string[];
  certificateFile?: string;
  privateKeyFile?: string;
  verifyClient?: boolean;
  rejectUnauthorized?: boolean;
  ca?: QuicCaOptions;
  sni?: Record<string, QuicSNIContextOptions>;
  versions?: QuicVersion[];
  tlsCipherSuites?: QuicTlsCipherSuite[];
  tlsGroups?: string[];
  retry?: QuicRetryOptions;
  sessionStore?: QuicSessionStore;
  earlyData?: false | QuicEarlyDataPolicy;
  migration?: QuicMigrationOptions;
  datagrams?: QuicDatagramOptions;
  connection?: QuicConnectionOptions;
  transport?: QuicTransportOptions;
  qlog?: QuicQlogOptions;
  keylog?: QuicKeylogOptions;
}
export type QuicSNIContextOptions = {
  certificateFile: string;
  privateKeyFile: string;
  alpnProtocols?: string[];
  tlsGroups?: string[];
  verifyClient?: boolean;
  rejectUnauthorized?: boolean;
  ca?: QuicCaOptions;
};
/** Client connection options. Unspecified values inherit endpoint defaults. */
export interface QuicConnectOptions {
  address: QuicAddress;
  alpnProtocols?: string[];
  serverName?: string;
  verifyPeer?: boolean;
  certificateFile?: string;
  privateKeyFile?: string;
  ca?: QuicCaOptions;
  versions?: QuicVersion[];
  tlsCipherSuites?: QuicTlsCipherSuite[];
  tlsGroups?: string[];
  retry?: QuicRetryOptions;
  sessionStore?: QuicSessionStore;
  earlyData?: false | QuicEarlyDataPolicy;
  migration?: QuicMigrationOptions;
  datagrams?: QuicDatagramOptions;
  connection?: QuicConnectionOptions;
  transport?: QuicTransportOptions;
  qlog?: QuicQlogOptions;
  keylog?: QuicKeylogOptions;
}
type QueueResolver<T> = {
  resolve(value: T): void;
  reject(error: Error): void;
};
type QuicConnectionState = 'connecting' | 'connected' | 'closing' | 'closed';
export type QuicCloseOptions = {
  errorCode?: number;
  type?: 'transport' | 'application';
  reason?: string;
};
export type QuicCloseInfo = {
  errorCode: number;
  reason: string;
  type: 'transport' | 'application';
  remote: boolean;
};
export type QuicPeerVerification = {
  verified: boolean;
  errorCode: number;
  reason: string | null;
};
type ResolvedRetryOptions = {
  enabled: false;
} | {
  enabled: true;
  tokenSecret?: Uint8Array;
};
type ResolvedPreferredAddressOptions = {
  ipv4?: QuicAddress;
  ipv6?: QuicAddress;
};
type ResolvedMigrationOptions = {
  enabled: boolean;
  preferredAddress?: ResolvedPreferredAddressOptions;
  usePreferredAddress: boolean;
};
/** Delivery state for a locally sent QUIC DATAGRAM frame. */
export type QuicDatagramStatus = 'ack' | 'lost' | 'abandoned';
export type QuicDatagramEncoding = 'utf8' | 'hex' | 'base64';
type QuicDatagramBytes = string | ArrayBuffer | ArrayBufferView;
export type QuicDatagramSource = QuicDatagramBytes | PromiseLike<QuicDatagramBytes>;
type ResolvedDatagramOptions = {
  enabled: boolean;
  maxFrameSize: number;
  maxPending: number;
  dropPolicy: 'drop-oldest' | 'drop-newest';
  maxSendAttempts: number;
};
type ResolvedConnectionOptions = {
  handshakeTimeout: bigint;
  initialRtt: bigint;
  keepAliveTimeout: bigint;
  maxPayloadSize: number;
  maxWindow: bigint;
  maxStreamWindow: bigint;
  unacknowledgedPacketThreshold: bigint;
  congestionControl: 'cubic' | 'reno' | 'bbr';
  drainingPeriodMultiplier: number;
  streamIdleTimeout: bigint;
  maxIdleTimeout: bigint;
  initialMaxData: bigint;
  initialMaxStreamDataBidiLocal: bigint;
  initialMaxStreamDataBidiRemote: bigint;
  initialMaxStreamDataUni: bigint;
  initialMaxStreamsBidi: bigint;
  initialMaxStreamsUni: bigint;
  activeConnectionIdLimit: bigint;
  maxAckDelay: bigint;
  ackDelayExponent: bigint;
  disableActiveMigration: boolean;
  cidLength: number;
};
type ResolvedRateLimitOptions = {
  rate: number;
  burst: number;
};
type ResolvedTransportOptions = {
  busy: boolean;
  maxConnections: number;
  maxConnectionsPerRemoteAddress: number;
  sourceAddress: {
    allow: Set<string> | null;
    deny: Set<string>;
  };
  retryTokenTimeout: bigint;
  addressTokenTimeout: bigint;
  addressValidationCacheSize: number;
  retryRateLimit: ResolvedRateLimitOptions;
  versionNegotiationRateLimit: ResolvedRateLimitOptions;
  statelessResetRateLimit: ResolvedRateLimitOptions;
  immediateCloseRateLimit: ResolvedRateLimitOptions;
  sessionCreationRateLimit: ResolvedRateLimitOptions;
  disableStatelessReset: boolean;
  ecn: boolean;
};
export type QuicResolvedRateLimitOptions = {
  readonly rate: number;
  readonly burst: number;
};
export type QuicResolvedSourceAddressOptions = {
  readonly allow: readonly string[] | null;
  readonly deny: readonly string[];
};
export type QuicResolvedTransportOptions = {
  readonly busy: boolean;
  readonly maxConnections: number;
  readonly maxConnectionsPerRemoteAddress: number;
  readonly sourceAddress: QuicResolvedSourceAddressOptions;
  readonly retryTokenTimeoutMs: number;
  readonly addressTokenTimeoutMs: number;
  readonly addressValidationCacheSize: number;
  readonly retryRateLimit: QuicResolvedRateLimitOptions;
  readonly versionNegotiationRateLimit: QuicResolvedRateLimitOptions;
  readonly statelessResetRateLimit: QuicResolvedRateLimitOptions;
  readonly immediateCloseRateLimit: QuicResolvedRateLimitOptions;
  readonly sessionCreationRateLimit: QuicResolvedRateLimitOptions;
  readonly disableStatelessReset: boolean;
  readonly ecn: boolean;
};
export type QuicResolvedConnectionOptions = {
  readonly handshakeTimeoutMs: number;
  readonly initialRttMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly maxPayloadSize: number;
  readonly maxWindow: number;
  readonly maxStreamWindow: number;
  readonly unacknowledgedPacketThreshold: number;
  readonly congestionControl: 'cubic' | 'reno' | 'bbr';
  readonly drainingPeriodMultiplier: number;
  readonly streamIdleTimeoutMs: number;
  readonly cidLength: number;
};
type ResolvedQuicOptions = {
  versions: QuicVersion[];
  tlsCipherSuites: QuicTlsCipherSuite[] | null;
  tlsGroups: string[] | null;
  retry: ResolvedRetryOptions;
  sessionStore?: QuicSessionStore;
  earlyData: false | QuicEarlyDataPolicy;
  migration: ResolvedMigrationOptions;
  datagrams: ResolvedDatagramOptions;
  connection: ResolvedConnectionOptions;
  transport: ResolvedTransportOptions;
  qlog: QuicQlogOptions;
  keylog: QuicKeylogOptions;
};
function normalizeCloseOptions(options: QuicCloseOptions = {}): Required<QuicCloseOptions> {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('QUIC close options must be an object');
  }
  const errorCode = options.errorCode ?? 0;
  if (!Number.isFinite(errorCode) || errorCode < 0) throw new RangeError('QUIC close errorCode must be a non-negative finite number');
  const type = options.type ?? 'application';
  if (type !== 'application' && type !== 'transport') {
    throw new TypeError('QUIC close type must be "application" or "transport"');
  }
  return {
    errorCode: Math.floor(errorCode),
    type,
    reason: options.reason ?? ''
  };
}
export type QuicEndpointStats = {
  createdAt: number;
  destroyedAt: number | null;
  packetsReceived: number;
  packetsSent: number;
  bytesReceived: number;
  bytesSent: number;
  packetsBlocked: number;
  sourceBlockedPackets: number;
  serverBusyCount: number;
  connectionLimitPackets: number;
  retrySent: number;
  retryRateLimited: number;
  retryTokenAccepted: number;
  retryTokenRejected: number;
  addressTokenAccepted: number;
  addressTokenRejected: number;
  versionNegotiationSent: number;
  versionNegotiationRateLimited: number;
  statelessResetSent: number;
  statelessResetRateLimited: number;
  immediateCloseSent: number;
  immediateCloseRateLimited: number;
  sessionCreationRateLimited: number;
  serverConnections: number;
  clientConnections: number;
  activeServerConnections: number;
  activeConnections: number;
};
export type QuicConnectionStats = {
  readonly createdAt: number;
  readonly connectedAt: number | null;
  readonly handshakeConfirmedAt: number | null;
  readonly closingAt: number | null;
  readonly destroyedAt: number | null;
  readonly bytesReceived: number;
  readonly bytesSent: number;
  readonly packetsReceived: number;
  readonly packetsSent: number;
  readonly datagramsReceived: number;
  readonly datagramsSent: number;
  readonly datagramsAcked: number;
  readonly datagramsLost: number;
  readonly datagramsAbandoned: number;
  readonly streamsOpened: number;
  readonly streamsReceived: number;
  readonly bidiIncomingStreams: number;
  readonly bidiOutgoingStreams: number;
  readonly uniIncomingStreams: number;
  readonly uniOutgoingStreams: number;
  readonly streamsClosed: number;
  readonly maxBytesInFlight: number;
  readonly bytesInFlight: number;
  readonly blockCount: number;
  readonly congestionWindow: number;
  readonly latestRttMs: number;
  readonly minRttMs: number;
  readonly rttVarianceMs: number;
  readonly smoothedRttMs: number;
  readonly slowStartThreshold: number;
  readonly packetsLost: number;
  readonly bytesLost: number;
  readonly pingReceived: number;
  readonly packetsDiscarded: number;
  readonly streamsIdleTimedOut: number;
  readonly pendingWriteBytes: number;
  readonly outstandingStreamBytes: number;
  readonly qlogOpenFailed: number;
  readonly qlogWriteFailed: number;
};
export type QuicStreamStats = {
  readonly createdAt: number;
  readonly openedAt: number | null;
  readonly receivedAt: number | null;
  readonly ackedAt: number | null;
  readonly destroyedAt: number | null;
  readonly bytesReceived: number;
  readonly bytesSent: number;
  readonly bytesAcked: number;
  readonly finalSize: number | null;
  readonly maxOffset: number;
  readonly maxOffsetAcked: number;
  readonly maxOffsetReceived: number;
  readonly maxOffsetSent: number;
  readonly bytesAccumulated: number;
  readonly maxBytesAccumulated: number;
};
export type QuicTransportParameterSnapshot = {
  readonly initialMaxStreamDataBidiLocal: number;
  readonly initialMaxStreamDataBidiRemote: number;
  readonly initialMaxStreamDataUni: number;
  readonly initialMaxData: number;
  readonly initialMaxStreamsBidi: number;
  readonly initialMaxStreamsUni: number;
  readonly maxIdleTimeoutMs: number;
  readonly maxUdpPayloadSize: number;
  readonly activeConnectionIdLimit: number;
  readonly ackDelayExponent: number;
  readonly maxAckDelayMs: number;
  readonly maxDatagramFrameSize: number;
  readonly disableActiveMigration: boolean;
  readonly preferredAddress: QuicAddress | null;
  readonly originalDestinationConnectionId: Uint8Array | null;
  readonly initialSourceConnectionId: Uint8Array | null;
  readonly retrySourceConnectionId: Uint8Array | null;
  readonly statelessResetToken: Uint8Array | null;
};
/**
* Cancelable timer handle returned by an injected QUIC runtime.
*
* @internal
*/
export type QuicTimerHandle = {
  /** Prevent the timer callback from running if it has not fired yet. */
  cancel(): void;
};
/**
* Clock and scheduling hooks used by the QUIC driver.
*
* Real endpoints use `performance.now()`, the native event loop, and
* microtasks. Simulator tests inject a runtime backed by the simulator clock so
* ngtcp2 expiry handling, PTO, idle timeout, and write deferral can be advanced
* deterministically.
*
* @internal
*/
export interface QuicRuntime {
  /** Return the current QUIC timestamp in nanoseconds. */
  nowNs(): bigint;
  /** Schedule a callback after `delayMs` milliseconds in this runtime. */
  setTimer(delayMs: number, callback: () => void): QuicTimerHandle;
  /** Run a callback after the current native callback or scheduling turn. */
  defer(callback: () => void): void;
}
type QuicDatagramPathMetadata = {
  localSockaddr: ArrayBuffer;
  localSockaddrLen: number;
  remoteSockaddr: ArrayBuffer;
  remoteSockaddrLen: number;
};
/**
* Bound datagram transport used by the ngtcp2 endpoint driver.
*
* Implementations may wrap a real UDP socket or an in-memory simulator
* datagram endpoint. `recvNow()` is nonblocking and returns `null` when no
* packet is currently readable; callers use `waitReadable()` to suspend until
* another packet may be available.
*
* @internal
*/
export interface QuicDatagramTransport {
  /** Stable transport identifier stored in ngtcp2 path user data. */
  readonly id: number;
  /** Local bound address for this datagram transport. */
  readonly address: QuicAddress;
  /** Whether this transport has been closed. */
  readonly closed: boolean;
  /** Read one packet if available, or return `null` without blocking. */
  recvNow(maxBytes: number): {
    data: Uint8Array;
    addr: QuicAddress;
    ecn?: number;
    path?: QuicDatagramPathMetadata;
  } | null;
  /** Read up to `maxPackets` packets if available, or return an empty array. */
  recvBatch?(maxPackets: number, maxBytes: number): Array<{
    data: Uint8Array;
    addr: QuicAddress;
    ecn?: number;
    path?: QuicDatagramPathMetadata;
  }>;
  /** Resolve once the transport may have data to read. */
  waitReadable(): Promise<void>;
  /** Try to send one datagram immediately, returning bytes written or errno. */
  sendNow(data: Uint8Array, dest: QuicAddress, ecn?: number): number;
  /** Try to send several datagrams immediately, preserving packet order. */
  sendBatch?(packets: Array<{
    data: Uint8Array;
    dest: QuicAddress;
    ecn?: number;
  }>): {
    sent: number;
    errno: number | null;
  };
  /** Resolve once the transport may be writable after send pressure. */
  waitWritable(): Promise<void>;
  /** Close the transport and release its resources. */
  close(): void;
}
/**
* Factory that binds QUIC datagram transports.
*
* @internal
*/
export interface QuicDatagramTransportFactory {
  /** Bind a transport to `address`, resolving the actual local address. */
  bind(address: QuicAddress, options?: {
    ecn?: boolean;
  }): Promise<QuicDatagramTransport>;
}
/**
* Optional test-only dependencies for `QuicEndpoint`.
*
* These hooks are intentionally not part of the stable public QUIC API. They
* let deterministic simulator tests replace UDP sockets and wall-clock timers
* while preserving the public `fino:net/quic` behavior for normal callers.
*
* @internal
*/
export interface QuicEndpointInternals {
  /** Datagram transport factory to use instead of real UDP sockets. */
  transportFactory?: QuicDatagramTransportFactory;
  /** Clock and scheduler to use instead of the real runtime. */
  runtime?: QuicRuntime;
  /**
  * Local client UDP address to bind for new outgoing connections.
  *
  * @internal
  */
  clientBindAddress?: QuicAddress;
}
type PreferredAddressEntry = {
  cid: ArrayBuffer;
  statelessResetToken: Uint8Array;
};
type PreferredAddressParams = {
  ipv4?: PreferredAddressEntry & {
    address: QuicAddress;
  };
  ipv6?: PreferredAddressEntry & {
    address: QuicAddress;
  };
};
const STREAM_DATA_FLAG_FIN = 1;
const TLS_ALERT_NO_APPLICATION_PROTOCOL = 120;
const NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2 = 183;
const NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2 = 256;
const NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN = 41;
const NGTCP2_STATELESS_RESET_TOKENLEN = 16;
const NGTCP2_MIN_STATELESS_RESET_RANDLEN = 22;
const NGTCP2_MIN_STATELESS_RESET_PACKETLEN = 41;
const STATELESS_RESET_RANDLEN = NGTCP2_MIN_STATELESS_RESET_RANDLEN * 5;
const DEFAULT_ADDRESS_LRU_SIZE = 1024;
const DEFAULT_RETRY_RATE = 100;
const DEFAULT_RETRY_BURST = 200;
const DEFAULT_VERSION_NEGOTIATION_RATE = 100;
const DEFAULT_VERSION_NEGOTIATION_BURST = 200;
const DEFAULT_STATELESS_RESET_RATE = 100;
const DEFAULT_STATELESS_RESET_BURST = 200;
const DEFAULT_IMMEDIATE_CLOSE_RATE = 100;
const DEFAULT_IMMEDIATE_CLOSE_BURST = 200;
const DEFAULT_SESSION_CREATION_RATE = 50;
const DEFAULT_SESSION_CREATION_BURST = 100;
const DEFAULT_MAX_CONNECTIONS = 1e4;
const DEFAULT_MAX_CONNECTIONS_PER_REMOTE_ADDRESS = 100;
const DEFAULT_MAX_PENDING_DATAGRAMS = 128;
const DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS = 5;
const DEFAULT_DRAINING_PERIOD_MULTIPLIER = 3;
const DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE = 1200;
const NGTCP2_QLOG_WRITE_FLAG_FIN = 1;
const NGTCP2_ENCRYPTION_LEVEL_1RTT = 2;
const NGTCP2_MILLISECONDS = 1000000n;
const NGTCP2_SECONDS = 1000000000n;
const DEFAULT_STREAM_IDLE_TIMEOUT = 30n * NGTCP2_SECONDS;
const ADDRESS_VALIDATION_TIMEOUT = 60n * NGTCP2_SECONDS;
const NGTCP2_NO_EXPIRY = (1n << 64n) - 1n;
const MIGRATION_KEEP_ALIVE_TIMEOUT = NGTCP2_SECONDS / 2n;
const MAX_RECEIVE_WINDOW = 16n * 1024n * 1024n;
const INITIAL_MAX_STREAM_DATA = 256n * 1024n;
const INITIAL_MAX_DATA = 1024n * 1024n;
const INITIAL_MAX_STREAMS_BIDI = 100n;
const INITIAL_MAX_STREAMS_UNI = 3n;
const ACTIVE_CONNECTION_ID_LIMIT = 2n;
const MAX_IDLE_TIMEOUT = 10n * NGTCP2_SECONDS;
const HANDSHAKE_TIMEOUT = 10n * NGTCP2_SECONDS;
const RETRY_TOKEN_TIMEOUT = 10n * NGTCP2_SECONDS;
const REGULAR_TOKEN_TIMEOUT = 10n * NGTCP2_SECONDS;
const MIN_TOKEN_TIMEOUT = 1n * NGTCP2_SECONDS;
const MAX_RETRY_TOKEN_TIMEOUT = 60n * NGTCP2_SECONDS;
const MAX_REGULAR_TOKEN_TIMEOUT = 5n * 60n * NGTCP2_SECONDS;
const CONNECTION_DRAINING_TIMEOUT_MS = 3e3;
const MAX_REJECTED_INITIAL_CIDS = 4096;
const MAX_WRITE_PACKETS_PER_DRAIN = 32;
const MAX_READ_PACKETS_PER_TURN = 5;
const MAX_BATCH_READ_PACKETS_PER_TURN = 32;
const NGTCP2_CONNECTION_REFUSED = 2;
const VERSION_NEGOTIATION_GREASE = 168430090;
const SOCKADDR_UNION_SIZE = 128;
const DEFAULT_ALPN_PROTOCOLS = ['h3', 'fino-hq'];
const QUIC_TLS_CIPHER_SUITES = new Set<string>([
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256'
]);
let _nextConnectionId = 1;
let _nextNativeUserDataId = 1;
const _nativeConnections = new Map<number, QuicConnection>();
let _nativeCallbackDepth = 0;
let _deferredNativeTasks: Array<() => void> = [];
let _deferredNativeFlushScheduled = false;
function inNativeCallback(): boolean {
  return _nativeCallbackDepth > 0;
}
function scheduleDeferredNativeTasks(): void {
  if (_deferredNativeFlushScheduled) return;
  _deferredNativeFlushScheduled = true;
  Promise.resolve().then(flushDeferredNativeTasks);
}
function flushDeferredNativeTasks(): void {
  _deferredNativeFlushScheduled = false;
  if (_nativeCallbackDepth > 0) {
    scheduleDeferredNativeTasks();
    return;
  }
  const tasks = _deferredNativeTasks.splice(0);
  for (const task of tasks) task();
  if (_deferredNativeTasks.length > 0) scheduleDeferredNativeTasks();
}
function deferAfterNativeCallback(task: () => void): void {
  if (_nativeCallbackDepth === 0) {
    task();
    return;
  }
  _deferredNativeTasks.push(task);
  scheduleDeferredNativeTasks();
}
function publishQuicTopic(name: string, event: Record<string, unknown>): void {
  const channel = topic(name);
  if (!channel.hasSubscribers) return;
  channel.publish(Object.freeze({ ...event }));
}
function runtimeDelay(runtime: QuicRuntime, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    runtime.setTimer(delayMs, resolve);
  });
}
function withNativeCallback<T>(fn: () => T): T {
  _nativeCallbackDepth++;
  try {
    return fn();
  } finally {
    _nativeCallbackDepth--;
    if (_nativeCallbackDepth === 0 && _deferredNativeTasks.length > 0) {
      scheduleDeferredNativeTasks();
    }
  }
}
export const quicAvailable = ngtcp2Available && cryptoAvailable;
export const quicResetStreamAtAvailable = ngtcp2ResetStreamAtAvailable;
export const cryptoBackend = quicAvailable ? _cryptoBackend : null;
export const transportEngine = 'ngtcp2';
export const quicVersion: string | null = (() => {
  if (!quicAvailable || ngtcp2Sym === null) return null;
  try {
    const infoPtr = ngtcp2Sym.ngtcp2_version(0) as ArrayBuffer | null;
    if (infoPtr === null) return 'ngtcp2';
    const versionPtr = Pointer.readPointer(infoPtr, 8) as ArrayBuffer | null;
    if (versionPtr !== null) {
      const version = readCStr(versionPtr);
      if (version.length > 0) return version;
    }
    const versionNumber = Pointer.readI32(infoPtr, 4) as number;
    return versionNumber > 0 ? String(versionNumber) : 'ngtcp2';
  } catch {
    return 'ngtcp2';
  }
})();
const realQuicRuntime: QuicRuntime = {
  nowNs(): bigint {
    return BigInt(Math.floor(performance.now() * 1e6));
  },
  setTimer(delayMs: number, callback: () => void): QuicTimerHandle {
    const timer = loop.timeout(delayMs);
    timer.then(callback, () => {});
    return { cancel() {
      timer.cancel?.();
    } };
  },
  defer(callback: () => void): void {
    Promise.resolve().then(callback);
  }
};
class RealQuicDatagramTransport implements QuicDatagramTransport {
  readonly id: number;
  readonly address: QuicAddress;
  #fd: number;
  #ecn: boolean;
  #closed = false;
  #localSockaddr: ArrayBuffer;
  #localSockaddrLen: number;
  #recvBatch: DatagramRecvBatch | null = null;
  #recvBatchPackets = 0;
  #recvBatchBytes = 0;
  constructor(fd: number, address: QuicAddress, ecn = false) {
    this.#fd = fd;
    this.#ecn = ecn;
    this.id = fd;
    this.address = address;
    const encoded = encodeAddr(address);
    this.#localSockaddr = encoded.buf;
    this.#localSockaddrLen = encoded.len;
  }
  get closed(): boolean {
    return this.#closed;
  }
  recvNow(maxBytes: number): {
    data: Uint8Array;
    addr: QuicAddress;
  } | null {
    if (this.#closed) return null;
    const received = this.#ecn ? recvmsgEcn(this.#fd, maxBytes) : recvfrom(this.#fd, maxBytes);
    if (typeof received === 'number') {
      if (received === EAGAIN) return null;
      throw new Error(`QUIC UDP recvfrom failed: ${received}`);
    }
    const addr = received.addr;
    if (addr.family !== 'ipv4' && addr.family !== 'ipv6') return null;
    return received.ecn === undefined ? {
      data: received.data,
      addr
    } : {
      data: received.data,
      addr,
      ecn: received.ecn
    };
  }
  recvBatch(maxPackets: number, maxBytes: number): Array<{
    data: Uint8Array;
    addr: QuicAddress;
    ecn?: number;
  }> {
    if (this.#recvBatch === null || this.#recvBatchPackets !== maxPackets || this.#recvBatchBytes !== maxBytes) {
      this.#recvBatch = createDatagramRecvBatch(maxPackets, maxBytes);
      this.#recvBatchPackets = maxPackets;
      this.#recvBatchBytes = maxBytes;
    }
    const received = this.#recvBatch?.recv(this.#fd) ?? null;
    if (received !== null) {
      if (typeof received === 'number') {
        if (received === EAGAIN) return [];
        throw new Error(`QUIC UDP recvmmsg failed: ${received}`);
      }
      const packets: Array<{
        data: Uint8Array;
        addr: QuicAddress;
        ecn?: number;
        path?: QuicDatagramPathMetadata;
      }> = [];
      for (const packet of received) {
        const addr = packet.addr;
        if (addr.family !== 'ipv4' && addr.family !== 'ipv6') continue;
        const path = {
          localSockaddr: this.#localSockaddr,
          localSockaddrLen: this.#localSockaddrLen,
          remoteSockaddr: packet.addrBuffer,
          remoteSockaddrLen: packet.addrLen
        };
        packets.push(packet.ecn === undefined ? {
          data: packet.data,
          addr,
          path
        } : {
          data: packet.data,
          addr,
          ecn: packet.ecn,
          path
        });
      }
      return packets;
    }
    const packets: Array<{
      data: Uint8Array;
      addr: QuicAddress;
      ecn?: number;
    }> = [];
    for (let i = 0; i < maxPackets; i++) {
      const packet = this.recvNow(maxBytes);
      if (packet === null) break;
      packets.push(packet);
    }
    return packets;
  }
  waitReadable(): Promise<void> {
    return loop.readable(this.#fd);
  }
  sendNow(data: Uint8Array, dest: QuicAddress, ecn?: number): number {
    if (this.#closed) return EAGAIN;
    if (ecn !== undefined) return sendmsgEcn(this.#fd, data, dest, ecn & NGTCP2_ECN_MASK);
    return sendto(this.#fd, data, dest);
  }
  sendBatch(packets: Array<{
    data: Uint8Array;
    dest: QuicAddress;
    ecn?: number;
  }>): {
    sent: number;
    errno: number | null;
  } {
    const batchResult = sendmmsgBatch(this.#fd, packets);
    if (batchResult !== null) return batchResult;
    let sent = 0;
    for (const packet of packets) {
      const rc = this.sendNow(packet.data, packet.dest, packet.ecn);
      if (rc < 0) return {
        sent,
        errno: rc
      };
      sent++;
    }
    return {
      sent,
      errno: null
    };
  }
  waitWritable(): Promise<void> {
    return loop.writable(this.#fd);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    loop.removeRead(this.#fd);
    socketClose(this.#fd);
  }
}
function normalizeSocketOptionInteger(input: number | undefined, min: number, max: number, name: string): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isInteger(input) || input < min || input > max) {
    throw new TypeError(`QUIC socket ${name} must be an integer between ${min} and ${max}`);
  }
  return input;
}
function normalizeSocketOptions(input: QuicSocketOptions | undefined): Required<Pick<QuicSocketOptions, never>> & QuicSocketOptions {
  if (input === undefined) return {};
  return {
    ...input.ipv6Only === undefined ? {} : { ipv6Only: input.ipv6Only === true },
    ...input.reusePort === undefined ? {} : { reusePort: input.reusePort === true },
    ...input.receiveBufferSize === undefined ? {} : { receiveBufferSize: normalizeSocketOptionInteger(input.receiveBufferSize, 1, 2147483647, 'receiveBufferSize') },
    ...input.sendBufferSize === undefined ? {} : { sendBufferSize: normalizeSocketOptionInteger(input.sendBufferSize, 1, 2147483647, 'sendBufferSize') },
    ...input.ttl === undefined ? {} : { ttl: normalizeSocketOptionInteger(input.ttl, 0, 255, 'ttl') }
  };
}
class RealQuicDatagramTransportFactory implements QuicDatagramTransportFactory {
  #socketOptions: QuicSocketOptions;
  constructor(socketOptions: QuicSocketOptions = {}) {
    this.#socketOptions = normalizeSocketOptions(socketOptions);
  }
  async bind(address: QuicAddress, options: {
    ecn?: boolean;
  } = {}): Promise<QuicDatagramTransport> {
    const fd = socket(address.family === 'ipv6' ? AF_INET6 : AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    let bound = false;
    try {
      setNonblocking(fd);
      this.#applySocketOptions(fd, address.family, options.ecn === true);
      socketBind(fd, address);
      const local = getsockname(fd);
      if (local.family !== 'ipv4' && local.family !== 'ipv6') {
        throw new Error('QUIC UDP socket bound to unsupported address family');
      }
      bound = true;
      return new RealQuicDatagramTransport(fd, local, options.ecn === true);
    } finally {
      if (!bound) socketClose(fd);
    }
  }
  #applySocketOptions(fd: number, family: 'ipv4' | 'ipv6', ecn: boolean): void {
    if (this.#socketOptions.reusePort !== undefined) setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, this.#socketOptions.reusePort);
    if (this.#socketOptions.receiveBufferSize !== undefined) setsockopt(fd, SOL_SOCKET, SO_RCVBUF, this.#socketOptions.receiveBufferSize);
    if (this.#socketOptions.sendBufferSize !== undefined) setsockopt(fd, SOL_SOCKET, SO_SNDBUF, this.#socketOptions.sendBufferSize);
    if (family === 'ipv6' && this.#socketOptions.ipv6Only !== undefined) setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, this.#socketOptions.ipv6Only);
    if (ecn) setsockopt(fd, family === 'ipv6' ? IPPROTO_IPV6 : IPPROTO_IP, family === 'ipv6' ? IPV6_RECVTCLASS : IP_RECVTOS, true);
    if (this.#socketOptions.ttl !== undefined) {
      setsockopt(fd, family === 'ipv6' ? IPPROTO_IPV6 : IPPROTO_IP, family === 'ipv6' ? IPV6_UNICAST_HOPS : IP_TTL, this.#socketOptions.ttl);
    }
  }
}
const realQuicDatagramTransportFactory = new RealQuicDatagramTransportFactory();
export function requireQuic(): void {
  requireNgtcp2();
  requireCrypto();
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
      this.#waiters.push({
        resolve,
        reject
      });
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
  #waiters: (QueueResolver<Uint8Array | null> & {
    maxBytes: number;
    cleanup(): void;
  })[] = [];
  #closed = false;
  #error: Error | null = null;
  #take(maxBytes: number): Uint8Array | null {
    const first = this.#chunks[0];
    if (first === undefined) return null;
    if (first.byteLength >= maxBytes) {
      if (first.byteLength === maxBytes) return this.#chunks.shift()!;
      this.#chunks[0] = first.subarray(maxBytes);
      return first.subarray(0, maxBytes);
    }
    let total = 0;
    let fullChunks = 0;
    while (fullChunks < this.#chunks.length) {
      const chunk = this.#chunks[fullChunks]!;
      if (total + chunk.byteLength > maxBytes) break;
      total += chunk.byteLength;
      fullChunks++;
    }
    const partial = fullChunks < this.#chunks.length ? maxBytes - total : 0;
    const outLen = total + partial;
    if (fullChunks === 1 && partial === 0) return this.#chunks.shift()!;
    const out = new Uint8Array(outLen);
    let offset = 0;
    for (let i = 0; i < fullChunks; i++) {
      const chunk = this.#chunks[i]!;
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.#chunks.splice(0, fullChunks);
    if (partial > 0) {
      const chunk = this.#chunks[0]!;
      out.set(chunk.subarray(0, partial), offset);
      this.#chunks[0] = chunk.subarray(partial);
    }
    return out;
  }
  push(chunk: Uint8Array): void {
    if (this.#closed) return;
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    const waiter = this.#waiters.shift();
    if (waiter) {
      this.#chunks.push(copy);
      waiter.cleanup();
      waiter.resolve(this.#take(waiter.maxBytes)!);
    } else {
      this.#chunks.push(copy);
    }
  }
  read(maxBytes = 65536, signal?: AbortSignal | null): Promise<Uint8Array | null> {
    if (maxBytes <= 0) return Promise.resolve(new Uint8Array(0));
    const chunk = this.#take(maxBytes);
    if (chunk !== null) return Promise.resolve(chunk);
    if (this.#error !== null) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let cleanup = () => {};
      const waiter = {
        resolve,
        reject,
        maxBytes,
        cleanup: () => cleanup()
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        cleanup();
        reject(signal!.reason);
      };
      if (signal !== undefined && signal !== null) {
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.#waiters.push(waiter);
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.resolve(null);
    }
  }
  error(error: Error): void {
    if (this.#closed) return;
    if (this.#closed && this.#error !== null) return;
    this.#closed = true;
    this.#error = error;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }
}
class QuicBytesReader extends BytesReader {
  #stream: QuicStream;
  constructor(stream: QuicStream, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#stream = stream;
  }
  protected doRead(maxBytes: number, options?: {
    signal?: AbortSignal | null;
  }): Promise<Uint8Array | null> {
    return this.#stream._readIncoming(maxBytes, options?.signal);
  }
  protected onConsume(bytes: number): void {
    this.#stream._extendStreamReceiveCredit(bytes);
    this.#stream._extendConnectionReceiveCredit(bytes);
  }
}
class QuicBytesWriter extends BytesWriter {
  #stream: QuicStream;
  #pending: Uint8Array[] = [];
  #flushScheduled = false;
  #fin = false;
  constructor(stream: QuicStream, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#stream = stream;
  }
  override async write(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    this.#stream._assertWritableSide();
    await super.write(data);
  }
  writeSync(data: ArrayBuffer | ArrayBufferView): void {
    this.#stream._assertWritableSide();
    if (this.closed) throw new Error('Writer is closed');
    const buf = data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    this.#writeChunk(buf);
    this.#flushPending();
  }
  protected async doWrite(buf: Uint8Array): Promise<void> {
    this.#writeChunk(buf);
  }
  #writeChunk(buf: Uint8Array): void {
    const copy = buf.slice();
    this.#stream._reserveWrite(copy);
    this.#pending.push(copy);
    this.#scheduleFlush();
  }
  _closeFromStopSending(): void {
    this.#pending = [];
    this.#fin = false;
    void super.close();
  }
  override async close(): Promise<void> {
    if (this.closed) return;
    if (!this.#stream._hasWritableSide()) {
      await super.close();
      return;
    }
    this.#fin = true;
    this.#flushPending();
    await super.close();
  }
  closeSync(): void {
    if (this.closed) return;
    if (!this.#stream._hasWritableSide()) {
      void super.close();
      return;
    }
    this.#fin = true;
    this.#flushPending();
    void super.close();
  }
  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    this.#stream._scheduleWriterFlush(() => this.#flushPending());
  }
  #flushPending(): void {
    this.#flushScheduled = false;
    if (this.#pending.length === 0) {
      if (this.#fin) {
        try {
          this.#stream._queueWrite(new Uint8Array(), true);
        } catch (error) {
          if (!(error instanceof Error) || !/QUIC stream is closed/.test(error.message)) throw error;
        }
        this.#fin = false;
      }
      return;
    }
    let total = 0;
    for (const chunk of this.#pending) total += chunk.byteLength;
    const data = this.#pending.length === 1 ? this.#pending[0]! : (() => {
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of this.#pending) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return combined;
    })();
    this.#pending = [];
    const fin = this.#fin;
    this.#fin = false;
    try {
      this.#stream._queueWrite(data, fin, true);
    } catch (error) {
      if (!(error instanceof Error) || !/QUIC stream is closed/.test(error.message)) throw error;
    }
  }
}
function normalizeAddress(address?: QuicAddress): QuicAddress {
  const addr = address ?? {
    family: 'ipv4',
    ip: '127.0.0.1',
    port: 0
  };
  if (addr.family !== 'ipv4' && addr.family !== 'ipv6') {
    throw new TypeError('QUIC only supports IPv4 and IPv6 UDP addresses');
  }
  return {
    family: addr.family,
    ip: addr.ip,
    port: addr.port
  };
}
function addressKey(address: QuicAddress): string {
  return `${address.family}:${address.ip}:${address.port}`;
}
function sameAddress(a: QuicAddress, b: QuicAddress): boolean {
  return a.family === b.family && a.ip === b.ip && a.port === b.port;
}
function decodeHexDatagram(input: string): Uint8Array {
  const text = input.trim();
  if (text.length % 2 !== 0) throw new TypeError('QUIC DATAGRAM hex data must have an even length');
  if (!/^[0-9a-fA-F]*$/.test(text)) throw new TypeError('QUIC DATAGRAM hex data contains invalid characters');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    out[i] = byte;
  }
  return out;
}
function decodeBase64Datagram(input: string): Uint8Array {
  const raw = atob(input);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function normalizeDatagramSource(data: QuicDatagramBytes, encoding: QuicDatagramEncoding): Uint8Array {
  if (typeof data === 'string') {
    if (encoding === 'utf8') return encodeUtf8(data);
    if (encoding === 'hex') return decodeHexDatagram(data);
    if (encoding === 'base64') return decodeBase64Datagram(data);
    throw new TypeError(`Unsupported QUIC DATAGRAM string encoding: ${encoding}`);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('QUIC DATAGRAM data must be a string, ArrayBuffer, or ArrayBufferView');
}
function normalizeVersions(input: QuicVersion[] | undefined, base?: ResolvedQuicOptions): QuicVersion[] {
  const versions = input?.slice() ?? base?.versions.slice() ?? ['v2', 'v1'];
  if (versions.length === 0) throw new TypeError('QUIC versions must include at least one version');
  for (const version of versions) {
    if (version !== 'v1' && version !== 'v2') throw new TypeError(`Unsupported QUIC version option: ${version}`);
  }
  return versions;
}
function normalizeTlsCipherSuites(input: QuicTlsCipherSuite[] | undefined, base?: ResolvedQuicOptions): QuicTlsCipherSuite[] | null {
  if (input === undefined) return base?.tlsCipherSuites?.slice() ?? null;
  if (input.length === 0) throw new TypeError('QUIC TLS cipher suite list must not be empty');
  for (const suite of input) {
    if (!QUIC_TLS_CIPHER_SUITES.has(suite)) throw new TypeError(`Unsupported QUIC TLS cipher suite: ${suite}`);
  }
  return input.slice();
}
function normalizeTlsGroups(input: string[] | undefined, base?: ResolvedQuicOptions): string[] | null {
  if (input === undefined) return base?.tlsGroups?.slice() ?? null;
  if (input.length === 0) throw new TypeError('QUIC TLS group list must not be empty');
  for (const group of input) {
    if (typeof group !== 'string' || group.length === 0) throw new TypeError('QUIC TLS groups must be non-empty strings');
  }
  return input.slice();
}
function normalizeRetry(input: QuicRetryOptions | undefined, base?: ResolvedQuicOptions): ResolvedRetryOptions {
  if (input === undefined) return base?.retry ?? { enabled: true };
  if (input === false) return { enabled: false };
  if (input.enabled !== true) return { enabled: false };
  if (input.tokenSecret !== undefined && !(input.tokenSecret instanceof Uint8Array)) {
    throw new TypeError('QUIC Retry tokenSecret must be a Uint8Array');
  }
  return input.tokenSecret === undefined ? { enabled: true } : {
    enabled: true,
    tokenSecret: input.tokenSecret.slice()
  };
}
function normalizeDatagrams(input: QuicDatagramOptions | undefined, base?: ResolvedQuicOptions): ResolvedDatagramOptions {
  if (input === undefined) {
    return base?.datagrams ?? {
      enabled: true,
      maxFrameSize: NGTCP2_MAX_UDP_PAYLOAD_SIZE,
      maxPending: DEFAULT_MAX_PENDING_DATAGRAMS,
      dropPolicy: 'drop-oldest',
      maxSendAttempts: DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS
    };
  }
  if (input.enabled === false) {
    return {
      enabled: false,
      maxFrameSize: 0,
      maxPending: 0,
      dropPolicy: 'drop-oldest',
      maxSendAttempts: DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS
    };
  }
  const maxFrameSize = input.maxFrameSize ?? base?.datagrams.maxFrameSize ?? NGTCP2_MAX_UDP_PAYLOAD_SIZE;
  if (!Number.isInteger(maxFrameSize) || maxFrameSize <= 0) {
    throw new TypeError('QUIC DATAGRAM maxFrameSize must be a positive integer');
  }
  if (maxFrameSize > NGTCP2_MAX_UDP_PAYLOAD_SIZE) {
    throw new RangeError(`QUIC DATAGRAM maxFrameSize must be <= ${NGTCP2_MAX_UDP_PAYLOAD_SIZE}`);
  }
  const maxPending = input.maxPending ?? base?.datagrams.maxPending ?? DEFAULT_MAX_PENDING_DATAGRAMS;
  if (!Number.isInteger(maxPending) || maxPending < 0 || maxPending > 65535) {
    throw new TypeError('QUIC DATAGRAM maxPending must be an integer between 0 and 65535');
  }
  const dropPolicy = input.dropPolicy ?? base?.datagrams.dropPolicy ?? 'drop-oldest';
  if (dropPolicy !== 'drop-oldest' && dropPolicy !== 'drop-newest') {
    throw new TypeError('QUIC DATAGRAM dropPolicy must be "drop-oldest" or "drop-newest"');
  }
  const maxSendAttempts = input.maxSendAttempts ?? base?.datagrams.maxSendAttempts ?? DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS;
  if (!Number.isInteger(maxSendAttempts) || maxSendAttempts < 1 || maxSendAttempts > 255) {
    throw new TypeError('QUIC DATAGRAM maxSendAttempts must be an integer between 1 and 255');
  }
  return {
    enabled: true,
    maxFrameSize,
    maxPending,
    dropPolicy,
    maxSendAttempts
  };
}
function quicVarintLength(value: number): number {
  if (value < 64) return 1;
  if (value < 16384) return 2;
  if (value < 1073741824) return 4;
  return 8;
}
function maxDatagramPayload(maxFrameSize: number): number {
  if (maxFrameSize < 2) return 0;
  let payload = maxFrameSize - 2;
  const overhead = 1 + quicVarintLength(payload);
  if (overhead + payload > maxFrameSize) {
    payload = maxFrameSize - 1 - quicVarintLength(maxFrameSize - 3);
  }
  return Math.max(0, payload);
}
function normalizePreferredAddress(input: QuicPreferredAddressOptions | undefined): ResolvedPreferredAddressOptions | undefined {
  if (input === undefined) return undefined;
  if ('family' in input) {
    const address = normalizeAddress(input);
    return address.family === 'ipv4' ? { ipv4: address } : { ipv6: address };
  }
  const preferred: ResolvedPreferredAddressOptions = {};
  if (input.ipv4 !== undefined) {
    const address = normalizeAddress(input.ipv4);
    if (address.family !== 'ipv4') throw new TypeError('QUIC preferredAddress.ipv4 must be an IPv4 address');
    preferred.ipv4 = address;
  }
  if (input.ipv6 !== undefined) {
    const address = normalizeAddress(input.ipv6);
    if (address.family !== 'ipv6') throw new TypeError('QUIC preferredAddress.ipv6 must be an IPv6 address');
    preferred.ipv6 = address;
  }
  return preferred.ipv4 === undefined && preferred.ipv6 === undefined ? undefined : preferred;
}
function normalizeMigration(input: QuicMigrationOptions | undefined, base?: ResolvedQuicOptions): ResolvedMigrationOptions {
  if (input === undefined) return base?.migration ?? {
    enabled: false,
    usePreferredAddress: false
  };
  const preferredAddress = normalizePreferredAddress(input.preferredAddress) ?? base?.migration.preferredAddress;
  return {
    enabled: input.enabled === true,
    usePreferredAddress: input.usePreferredAddress === true,
    ...preferredAddress === undefined ? {} : { preferredAddress }
  };
}
function normalizeQlog(input: QuicQlogOptions | undefined, base?: ResolvedQuicOptions): QuicQlogOptions {
  if (input === undefined) return base?.qlog ?? false;
  if (input === false) return false;
  return {
    ...input.path === undefined ? {} : { path: String(input.path) },
    ...input.events === undefined ? {} : { events: input.events.map(String) }
  };
}
function normalizeKeylog(input: QuicKeylogOptions | undefined, base?: ResolvedQuicOptions): QuicKeylogOptions {
  if (input === undefined) return base?.keylog ?? false;
  if (input === false) return false;
  const path = String(input.path ?? '');
  if (path.length === 0) throw new TypeError('QUIC keylog path must be a non-empty string');
  return { path };
}
function normalizeRateLimit(input: QuicRateLimitOptions | undefined, base: ResolvedRateLimitOptions | undefined, defaults: ResolvedRateLimitOptions, name: string): ResolvedRateLimitOptions {
  if (input === undefined) return base ?? defaults;
  if (input === false) return {
    rate: 0,
    burst: 0
  };
  const rate = input.rate ?? base?.rate ?? defaults.rate;
  const burst = input.burst ?? base?.burst ?? defaults.burst;
  if (!Number.isFinite(rate) || rate < 0) throw new TypeError(`QUIC ${name} rate must be a non-negative number`);
  if (!Number.isInteger(burst) || burst < 0) throw new TypeError(`QUIC ${name} burst must be a non-negative integer`);
  return {
    rate,
    burst
  };
}
function normalizeLimit(input: number | undefined, base: number | undefined, defaults: number, name: string): number {
  const value = input ?? base ?? defaults;
  if (value !== Number.POSITIVE_INFINITY && (!Number.isInteger(value) || value < 0)) {
    throw new TypeError(`QUIC ${name} must be a non-negative integer`);
  }
  return value;
}
function normalizeTimeoutMs(input: number | undefined, base: bigint | undefined, defaults: bigint, min: bigint, max: bigint, name: string): bigint {
  if (input === undefined) return clampBigint(base ?? defaults, min, max);
  if (!Number.isFinite(input) || input < 0) throw new TypeError(`QUIC ${name} must be a non-negative number of milliseconds`);
  return clampBigint(BigInt(Math.floor(input * 1e6)), min, max);
}
function normalizeDurationMs(input: number | undefined, base: bigint | undefined, defaults: bigint, name: string): bigint {
  if (input === undefined) return base ?? defaults;
  if (!Number.isFinite(input) || input < 0) throw new TypeError(`QUIC ${name} must be a non-negative number of milliseconds`);
  return BigInt(Math.floor(input * 1e6));
}
function normalizeInteger(input: number | undefined, base: number | undefined, defaults: number, min: number, max: number, name: string): number {
  const value = input ?? base ?? defaults;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`QUIC ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function normalizeClampedInteger(input: number | undefined, base: number | undefined, defaults: number, min: number, max: number, name: string): number {
  const value = input ?? base ?? defaults;
  if (!Number.isInteger(value)) {
    throw new TypeError(`QUIC ${name} must be an integer`);
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
function normalizeTransportVarint(input: number | undefined, base: bigint | undefined, defaults: bigint, name: string): bigint {
  if (input === undefined) return base ?? defaults;
  if (!Number.isInteger(input) || input < 0) throw new TypeError(`QUIC ${name} must be a non-negative integer`);
  return BigInt(input);
}
function normalizeConnection(input: QuicConnectionOptions | undefined, base?: ResolvedQuicOptions): ResolvedConnectionOptions {
  const baseConnection = base?.connection;
  const maxPayloadSize = normalizeInteger(input?.maxPayloadSize, baseConnection?.maxPayloadSize, DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE, DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE, 65527, 'maxPayloadSize');
  const congestionControl = input?.congestionControl ?? baseConnection?.congestionControl ?? 'cubic';
  if (congestionControl !== 'cubic' && congestionControl !== 'reno' && congestionControl !== 'bbr') {
    throw new TypeError('QUIC congestionControl must be "cubic", "reno", or "bbr"');
  }
  return {
    handshakeTimeout: normalizeDurationMs(input?.handshakeTimeoutMs, baseConnection?.handshakeTimeout, HANDSHAKE_TIMEOUT, 'handshakeTimeoutMs'),
    initialRtt: normalizeDurationMs(input?.initialRttMs, baseConnection?.initialRtt, 0n, 'initialRttMs'),
    keepAliveTimeout: normalizeDurationMs(input?.keepAliveTimeoutMs, baseConnection?.keepAliveTimeout, 0n, 'keepAliveTimeoutMs'),
    maxPayloadSize,
    maxWindow: BigInt(normalizeLimit(input?.maxWindow, baseConnection === undefined ? undefined : Number(baseConnection.maxWindow), 0, 'maxWindow')),
    maxStreamWindow: BigInt(normalizeLimit(input?.maxStreamWindow, baseConnection === undefined ? undefined : Number(baseConnection.maxStreamWindow), 0, 'maxStreamWindow')),
    unacknowledgedPacketThreshold: BigInt(normalizeLimit(input?.unacknowledgedPacketThreshold, baseConnection === undefined ? undefined : Number(baseConnection.unacknowledgedPacketThreshold), 0, 'unacknowledgedPacketThreshold')),
    congestionControl,
    drainingPeriodMultiplier: normalizeInteger(input?.drainingPeriodMultiplier, baseConnection?.drainingPeriodMultiplier, DEFAULT_DRAINING_PERIOD_MULTIPLIER, DEFAULT_DRAINING_PERIOD_MULTIPLIER, 255, 'drainingPeriodMultiplier'),
    streamIdleTimeout: normalizeDurationMs(input?.streamIdleTimeoutMs, baseConnection?.streamIdleTimeout, DEFAULT_STREAM_IDLE_TIMEOUT, 'streamIdleTimeoutMs'),
    maxIdleTimeout: normalizeDurationMs(input?.maxIdleTimeoutMs, baseConnection?.maxIdleTimeout, MAX_IDLE_TIMEOUT, 'maxIdleTimeoutMs'),
    initialMaxData: normalizeTransportVarint(input?.initialMaxData, baseConnection?.initialMaxData, INITIAL_MAX_DATA, 'initialMaxData'),
    initialMaxStreamDataBidiLocal: normalizeTransportVarint(input?.initialMaxStreamDataBidiLocal, baseConnection?.initialMaxStreamDataBidiLocal, INITIAL_MAX_STREAM_DATA, 'initialMaxStreamDataBidiLocal'),
    initialMaxStreamDataBidiRemote: normalizeTransportVarint(input?.initialMaxStreamDataBidiRemote, baseConnection?.initialMaxStreamDataBidiRemote, INITIAL_MAX_STREAM_DATA, 'initialMaxStreamDataBidiRemote'),
    initialMaxStreamDataUni: normalizeTransportVarint(input?.initialMaxStreamDataUni, baseConnection?.initialMaxStreamDataUni, INITIAL_MAX_STREAM_DATA, 'initialMaxStreamDataUni'),
    initialMaxStreamsBidi: normalizeTransportVarint(input?.initialMaxStreamsBidi, baseConnection?.initialMaxStreamsBidi, INITIAL_MAX_STREAMS_BIDI, 'initialMaxStreamsBidi'),
    initialMaxStreamsUni: normalizeTransportVarint(input?.initialMaxStreamsUni, baseConnection?.initialMaxStreamsUni, INITIAL_MAX_STREAMS_UNI, 'initialMaxStreamsUni'),
    activeConnectionIdLimit: BigInt(normalizeClampedInteger(input?.activeConnectionIdLimit, baseConnection === undefined ? undefined : Number(baseConnection.activeConnectionIdLimit), Number(ACTIVE_CONNECTION_ID_LIMIT), 2, 8, 'activeConnectionIdLimit')),
    maxAckDelay: normalizeDurationMs(input?.maxAckDelayMs, baseConnection?.maxAckDelay, 25n * NGTCP2_MILLISECONDS, 'maxAckDelayMs'),
    ackDelayExponent: BigInt(normalizeInteger(input?.ackDelayExponent, baseConnection === undefined ? undefined : Number(baseConnection.ackDelayExponent), 3, 0, 20, 'ackDelayExponent')),
    disableActiveMigration: input?.disableActiveMigration ?? baseConnection?.disableActiveMigration ?? false,
    cidLength: normalizeInteger(input?.cidLength, baseConnection?.cidLength, NGTCP2_MAX_CIDLEN, 8, NGTCP2_MAX_CIDLEN, 'cidLength')
  };
}
function clampBigint(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
function nsToMs(value: bigint): number {
  return Number(value / NGTCP2_MILLISECONDS);
}
function normalizeAddressSet(input: string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (input === undefined) return out;
  for (const entry of input) out.add(String(entry));
  return out;
}
function normalizeTransport(input: QuicTransportOptions | undefined, base?: ResolvedQuicOptions): ResolvedTransportOptions {
  const baseTransport = base?.transport;
  const addressValidationCacheSize = input?.addressValidationCacheSize ?? baseTransport?.addressValidationCacheSize ?? DEFAULT_ADDRESS_LRU_SIZE;
  if (!Number.isInteger(addressValidationCacheSize) || addressValidationCacheSize < 1) {
    throw new TypeError('QUIC addressValidationCacheSize must be a positive integer');
  }
  const allow = input?.sourceAddress?.allow === undefined ? baseTransport?.sourceAddress.allow ?? null : normalizeAddressSet(input.sourceAddress.allow);
  const deny = input?.sourceAddress?.deny === undefined ? new Set(baseTransport?.sourceAddress.deny ?? []) : normalizeAddressSet(input.sourceAddress.deny);
  return {
    busy: input?.busy ?? baseTransport?.busy ?? false,
    maxConnections: normalizeLimit(input?.maxConnections, baseTransport?.maxConnections, DEFAULT_MAX_CONNECTIONS, 'maxConnections'),
    maxConnectionsPerRemoteAddress: normalizeLimit(input?.maxConnectionsPerRemoteAddress, baseTransport?.maxConnectionsPerRemoteAddress, DEFAULT_MAX_CONNECTIONS_PER_REMOTE_ADDRESS, 'maxConnectionsPerRemoteAddress'),
    sourceAddress: {
      allow,
      deny
    },
    retryTokenTimeout: normalizeTimeoutMs(input?.retryTokenTimeoutMs, baseTransport?.retryTokenTimeout, RETRY_TOKEN_TIMEOUT, MIN_TOKEN_TIMEOUT, MAX_RETRY_TOKEN_TIMEOUT, 'retryTokenTimeoutMs'),
    addressTokenTimeout: normalizeTimeoutMs(input?.addressTokenTimeoutMs, baseTransport?.addressTokenTimeout, REGULAR_TOKEN_TIMEOUT, MIN_TOKEN_TIMEOUT, MAX_REGULAR_TOKEN_TIMEOUT, 'addressTokenTimeoutMs'),
    addressValidationCacheSize,
    retryRateLimit: normalizeRateLimit(input?.retryRateLimit, baseTransport?.retryRateLimit, {
      rate: DEFAULT_RETRY_RATE,
      burst: DEFAULT_RETRY_BURST
    }, 'retryRateLimit'),
    versionNegotiationRateLimit: normalizeRateLimit(input?.versionNegotiationRateLimit, baseTransport?.versionNegotiationRateLimit, {
      rate: DEFAULT_VERSION_NEGOTIATION_RATE,
      burst: DEFAULT_VERSION_NEGOTIATION_BURST
    }, 'versionNegotiationRateLimit'),
    statelessResetRateLimit: normalizeRateLimit(input?.statelessResetRateLimit, baseTransport?.statelessResetRateLimit, {
      rate: DEFAULT_STATELESS_RESET_RATE,
      burst: DEFAULT_STATELESS_RESET_BURST
    }, 'statelessResetRateLimit'),
    immediateCloseRateLimit: normalizeRateLimit(input?.immediateCloseRateLimit, baseTransport?.immediateCloseRateLimit, {
      rate: DEFAULT_IMMEDIATE_CLOSE_RATE,
      burst: DEFAULT_IMMEDIATE_CLOSE_BURST
    }, 'immediateCloseRateLimit'),
    sessionCreationRateLimit: normalizeRateLimit(input?.sessionCreationRateLimit, baseTransport?.sessionCreationRateLimit, {
      rate: DEFAULT_SESSION_CREATION_RATE,
      burst: DEFAULT_SESSION_CREATION_BURST
    }, 'sessionCreationRateLimit'),
    disableStatelessReset: input?.disableStatelessReset ?? baseTransport?.disableStatelessReset ?? false,
    ecn: input?.ecn ?? baseTransport?.ecn ?? false
  };
}
function resolveQuicOptions(options: QuicEndpointOptions | QuicListenOptions | QuicConnectOptions = {}, base?: ResolvedQuicOptions): ResolvedQuicOptions {
  const sessionStore = options.sessionStore ?? base?.sessionStore;
  const earlyData = options.earlyData ?? base?.earlyData ?? false;
  if (earlyData !== false) {
    if (sessionStore === undefined) throw new TypeError('QUIC 0-RTT earlyData requires a sessionStore');
    if (earlyData.replaySafe !== true) throw new TypeError('QUIC 0-RTT earlyData requires an explicit replay-safe policy');
  }
  return {
    versions: normalizeVersions(options.versions, base),
    tlsCipherSuites: normalizeTlsCipherSuites(options.tlsCipherSuites, base),
    tlsGroups: normalizeTlsGroups(options.tlsGroups, base),
    retry: normalizeRetry(options.retry, base),
    sessionStore,
    earlyData,
    migration: normalizeMigration(options.migration, base),
    datagrams: normalizeDatagrams(options.datagrams, base),
    connection: normalizeConnection(options.connection, base),
    transport: normalizeTransport(options.transport, base),
    qlog: normalizeQlog(options.qlog, base),
    keylog: normalizeKeylog(options.keylog, base)
  };
}
function freezeRateLimitSnapshot(input: ResolvedRateLimitOptions): QuicResolvedRateLimitOptions {
  return Object.freeze({
    rate: input.rate,
    burst: input.burst
  });
}
function freezeTransportSnapshot(input: ResolvedTransportOptions): QuicResolvedTransportOptions {
  return Object.freeze({
    busy: input.busy,
    maxConnections: input.maxConnections,
    maxConnectionsPerRemoteAddress: input.maxConnectionsPerRemoteAddress,
    sourceAddress: Object.freeze({
      allow: input.sourceAddress.allow === null ? null : Object.freeze(Array.from(input.sourceAddress.allow)),
      deny: Object.freeze(Array.from(input.sourceAddress.deny))
    }),
    retryTokenTimeoutMs: nsToMs(input.retryTokenTimeout),
    addressTokenTimeoutMs: nsToMs(input.addressTokenTimeout),
    addressValidationCacheSize: input.addressValidationCacheSize,
    retryRateLimit: freezeRateLimitSnapshot(input.retryRateLimit),
    versionNegotiationRateLimit: freezeRateLimitSnapshot(input.versionNegotiationRateLimit),
    statelessResetRateLimit: freezeRateLimitSnapshot(input.statelessResetRateLimit),
    immediateCloseRateLimit: freezeRateLimitSnapshot(input.immediateCloseRateLimit),
    sessionCreationRateLimit: freezeRateLimitSnapshot(input.sessionCreationRateLimit),
    disableStatelessReset: input.disableStatelessReset,
    ecn: input.ecn
  });
}
function freezeConnectionSnapshot(input: ResolvedConnectionOptions): QuicResolvedConnectionOptions {
  return Object.freeze({
    handshakeTimeoutMs: nsToMs(input.handshakeTimeout),
    initialRttMs: nsToMs(input.initialRtt),
    keepAliveTimeoutMs: nsToMs(input.keepAliveTimeout),
    maxPayloadSize: input.maxPayloadSize,
    maxWindow: Number(input.maxWindow),
    maxStreamWindow: Number(input.maxStreamWindow),
    unacknowledgedPacketThreshold: Number(input.unacknowledgedPacketThreshold),
    congestionControl: input.congestionControl,
    drainingPeriodMultiplier: input.drainingPeriodMultiplier,
    streamIdleTimeoutMs: nsToMs(input.streamIdleTimeout),
    cidLength: input.cidLength
  });
}
function versionToWire(version: QuicVersion): number {
  return version === 'v2' ? NGTCP2_PROTO_VER_V2 : NGTCP2_PROTO_VER_V1;
}
function wireVersionToName(version: number): QuicVersion {
  return version === NGTCP2_PROTO_VER_V2 ? 'v2' : 'v1';
}
function selectWireVersion(versions: readonly QuicVersion[]): number {
  for (const version of versions) {
    const wireVersion = versionToWire(version);
    if (ngtcp2Sym!.ngtcp2_is_supported_version(wireVersion) !== 0) return wireVersion;
  }
  throw new Error(`Installed ngtcp2 does not support requested QUIC versions: ${versions.join(', ')}`);
}
function selectClientInitialWireVersion(versions: readonly QuicVersion[]): number {
  if (versions.includes('v1') && ngtcp2Sym!.ngtcp2_is_supported_version(NGTCP2_PROTO_VER_V1) !== 0) {
    return NGTCP2_PROTO_VER_V1;
  }
  return selectWireVersion(versions);
}
function longHeaderVersion(packet: Uint8Array): number | null {
  if (packet.byteLength < 5 || (packet[0]! & 128) === 0) return null;
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(1, false);
}
function sessionStoreKey(serverName: string, alpnProtocols: readonly string[]): string {
  return `${serverName}|${alpnProtocols.join(',')}`;
}
function now(runtime: QuicRuntime = realQuicRuntime): bigint {
  return runtime.nowNs();
}
class QuicTokenBucket {
  #tokens: number;
  #lastTimestamp: bigint;
  constructor(readonly rate: number, readonly burst: number, readonly runtime: QuicRuntime = realQuicRuntime) {
    this.#tokens = burst;
    this.#lastTimestamp = now(runtime);
  }
  consume(timestamp = now(this.runtime)): boolean {
    const elapsedSeconds = Number(timestamp - this.#lastTimestamp) / 1e9;
    this.#lastTimestamp = timestamp;
    this.#tokens = Math.min(this.burst, this.#tokens + elapsedSeconds * this.rate);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
type QuicAddressValidationInfo = {
  validated: boolean;
  sessionCreationBucket: QuicTokenBucket;
  timestamp: bigint;
};
class QuicAddressValidationCache {
  #entries = new Map<string, QuicAddressValidationInfo>();
  constructor(readonly maxEntries: number, readonly sessionCreationRateLimit: ResolvedRateLimitOptions, readonly timeout: bigint, readonly runtime: QuicRuntime = realQuicRuntime) {}
  peek(address: QuicAddress): QuicAddressValidationInfo | undefined {
    const key = addressKey(address);
    const info = this.#entries.get(key);
    if (info === undefined) return undefined;
    const timestamp = now(this.runtime);
    if (timestamp - info.timestamp > this.timeout) {
      this.#entries.delete(key);
      return undefined;
    }
    info.timestamp = timestamp;
    return info;
  }
  upsert(address: QuicAddress): QuicAddressValidationInfo {
    const key = addressKey(address);
    const timestamp = now(this.runtime);
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key);
      existing.timestamp = timestamp;
      this.#entries.set(key, existing);
      return existing;
    }
    const info: QuicAddressValidationInfo = {
      validated: false,
      sessionCreationBucket: new QuicTokenBucket(this.sessionCreationRateLimit.rate, this.sessionCreationRateLimit.burst, this.runtime),
      timestamp
    };
    this.#entries.set(key, info);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return info;
  }
  markValidated(address: QuicAddress): void {
    this.upsert(address).validated = true;
  }
  clear(): void {
    this.#entries.clear();
  }
}
function writeU64(buf: ArrayBuffer | Uint8Array, off: number, value: bigint | number): void {
  const dv = new DataView(buf instanceof Uint8Array ? buf.buffer : buf, buf instanceof Uint8Array ? buf.byteOffset : 0);
  dv.setBigUint64(off, BigInt(value), true);
}
function writeI64(buf: ArrayBuffer | Uint8Array, off: number, value: bigint | number): void {
  const dv = new DataView(buf instanceof Uint8Array ? buf.buffer : buf, buf instanceof Uint8Array ? buf.byteOffset : 0);
  dv.setBigInt64(off, BigInt(value), true);
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
function readI64(buf: ArrayBuffer, off: number): bigint {
  return new DataView(buf).getBigInt64(off, true);
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
function writePtrIfPresent(buf: ArrayBuffer, off: number, ptr: ArrayBuffer | null): void {
  if (off + 8 <= buf.byteLength) writePtr(buf, off, ptr);
}
function writeAddress(buf: ArrayBuffer, off: number, address: bigint): void {
  writeU64(buf, off, address);
}
const _compatibleVersionLists = new Map<string, Uint8Array>();
function compatibleVersionList(versions: readonly QuicVersion[]): Uint8Array {
  const key = versions.slice().sort().join(',');
  const cached = _compatibleVersionLists.get(key);
  if (cached !== undefined) return cached;
  const wireVersions: number[] = [];
  const allowed = new Set(versions);
  for (const version of ['v2', 'v1'] as const) {
    if (!allowed.has(version)) continue;
    const wireVersion = versionToWire(version);
    if (ngtcp2Sym!.ngtcp2_is_supported_version(wireVersion) !== 0) wireVersions.push(wireVersion);
  }
  const out = new Uint8Array(wireVersions.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < wireVersions.length; i++) view.setUint32(i * 4, wireVersions[i]!, true);
  _compatibleVersionLists.set(key, out);
  return out;
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
function generateStatelessResetToken(secret: Uint8Array, cid: ArrayBuffer): Uint8Array {
  const token = new Uint8Array(NGTCP2_STATELESS_RESET_TOKENLEN);
  const rc = cryptoSym!.ngtcp2_crypto_generate_stateless_reset_token(token, secret, secret.byteLength, Pointer.of(cid)) as number;
  if (rc !== 0) throw new Error('ngtcp2_crypto_generate_stateless_reset_token failed');
  return token;
}
function generateRegularToken(secret: Uint8Array, remoteAddress: QuicAddress, runtime: QuicRuntime): Uint8Array | null {
  const remote = encodeAddr(remoteAddress);
  const token = new Uint8Array(NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN);
  const tokenLen = Number(cryptoSym!.ngtcp2_crypto_generate_regular_token(token, secret, secret.byteLength, Pointer.of(remote.buf), remote.len, now(runtime)));
  return tokenLen <= 0 ? null : token.slice(0, tokenLen);
}
function verifyRegularToken(secret: Uint8Array, remoteAddress: QuicAddress, token: Uint8Array, runtime: QuicRuntime, timeout: bigint = REGULAR_TOKEN_TIMEOUT): boolean {
  const remote = encodeAddr(remoteAddress);
  const rc = cryptoSym!.ngtcp2_crypto_verify_regular_token(token, token.byteLength, secret, secret.byteLength, Pointer.of(remote.buf), remote.len, timeout, now(runtime)) as number;
  return rc === 0;
}
function isRetryToken(token: Uint8Array): boolean {
  return token.byteLength > 0 && token[0] === NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2;
}
function cidBytes(cid: ArrayBuffer | null): Uint8Array {
  if (cid === null) return new Uint8Array();
  const bytes = cid.byteLength >= NGTCP2_CID_SIZE ? new Uint8Array(cid) : Pointer.copyFrom(cid, NGTCP2_CID_SIZE) as Uint8Array;
  const len = Number(readU64(bytes.buffer, bytes.byteOffset + CID_DATALEN));
  return bytes.subarray(CID_DATA, CID_DATA + len).slice();
}
function cidFromPacketHeader(hd: ArrayBuffer, off: number): ArrayBuffer {
  return makeCid(new Uint8Array(hd, off + CID_DATA, Number(readU64(hd, off + CID_DATALEN))).slice());
}
function readPacketVarint(packet: Uint8Array, offset: number): {
  value: number;
  offset: number;
} | null {
  if (offset >= packet.byteLength) return null;
  const first = packet[offset];
  const length = 1 << (first >>> 6);
  if (offset + length > packet.byteLength) return null;
  if (length === 1) return {
    value: first & 63,
    offset: offset + 1
  };
  if (length === 2) return {
    value: (first & 63) << 8 | packet[offset + 1],
    offset: offset + 2
  };
  if (length === 4) {
    return {
      value: (first & 63) * 16777216 + (packet[offset + 1] << 16) + (packet[offset + 2] << 8) + packet[offset + 3],
      offset: offset + 4
    };
  }
  return null;
}
function parseInitialTokenHeader(packet: Uint8Array): {
  version: number;
  dcid: ArrayBuffer;
  scid: ArrayBuffer;
  token: Uint8Array;
} | null {
  if (packet.byteLength < 7 || (packet[0] & 128) === 0 || (packet[0] & 48) !== 0) return null;
  const version = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(1, false);
  let offset = 5;
  const dcidLen = packet[offset++];
  if (dcidLen > NGTCP2_MAX_CIDLEN || offset + dcidLen >= packet.byteLength) return null;
  const dcid = makeCid(packet.slice(offset, offset + dcidLen));
  offset += dcidLen;
  const scidLen = packet[offset++];
  if (scidLen > NGTCP2_MAX_CIDLEN || offset + scidLen > packet.byteLength) return null;
  const scid = makeCid(packet.slice(offset, offset + scidLen));
  offset += scidLen;
  const tokenLen = readPacketVarint(packet, offset);
  if (tokenLen === null || tokenLen.offset + tokenLen.value > packet.byteLength) return null;
  const token = packet.slice(tokenLen.offset, tokenLen.offset + tokenLen.value);
  return {
    version,
    dcid,
    scid,
    token
  };
}
function packetHeaderFromParsedInitial(parsed: {
  version: number;
  dcid: ArrayBuffer;
  scid: ArrayBuffer;
  token: Uint8Array;
}): ArrayBuffer {
  const hd = new ArrayBuffer(NGTCP2_PKT_HD_SIZE);
  new Uint8Array(hd, PKT_HD_DCID, NGTCP2_CID_SIZE).set(new Uint8Array(parsed.dcid));
  new Uint8Array(hd, PKT_HD_SCID, NGTCP2_CID_SIZE).set(new Uint8Array(parsed.scid));
  writeAddress(hd, PKT_HD_TOKEN, Pointer.addr(parsed.token) as bigint);
  writeU64(hd, PKT_HD_TOKENLEN, BigInt(parsed.token.byteLength));
  writeU32(hd, PKT_HD_VERSION, parsed.version);
  return hd;
}
type NativePath = {
  path: ArrayBuffer;
  local: ArrayBuffer;
  remote: ArrayBuffer;
  userData: ArrayBuffer;
  fd: number;
};
type PathSnapshot = {
  localAddress: QuicAddress;
  remoteAddress: QuicAddress;
  fd: number;
};
function makePath(localAddress: QuicAddress, remoteAddress: QuicAddress, fd = 0): NativePath {
  const encodedLocal = encodeAddr(localAddress);
  const encodedRemote = encodeAddr(remoteAddress);
  const local = new ArrayBuffer(SOCKADDR_UNION_SIZE);
  const remote = new ArrayBuffer(SOCKADDR_UNION_SIZE);
  const userData = new ArrayBuffer(8);
  new Uint8Array(local).set(new Uint8Array(encodedLocal.buf));
  new Uint8Array(remote).set(new Uint8Array(encodedRemote.buf));
  writeU64(userData, 0, BigInt(Math.max(0, fd)));
  const path = new ArrayBuffer(NGTCP2_PATH_SIZE);
  writeAddress(path, PATH_LOCAL + ADDR_ADDR, Pointer.addr(local) as bigint);
  writeU32(path, PATH_LOCAL + ADDR_ADDRLEN, encodedLocal.len);
  writeAddress(path, PATH_REMOTE + ADDR_ADDR, Pointer.addr(remote) as bigint);
  writeU32(path, PATH_REMOTE + ADDR_ADDRLEN, encodedRemote.len);
  writeAddress(path, PATH_USER_DATA, Pointer.addr(userData) as bigint);
  return {
    path,
    local,
    remote,
    userData,
    fd
  };
}
function makePathFromSockaddrs(localSockaddr: ArrayBuffer, localSockaddrLen: number, remoteSockaddr: ArrayBuffer, remoteSockaddrLen: number, fd = 0): NativePath | null {
  if (localSockaddrLen <= 0 || localSockaddrLen > SOCKADDR_UNION_SIZE || remoteSockaddrLen <= 0 || remoteSockaddrLen > SOCKADDR_UNION_SIZE) return null;
  const local = new ArrayBuffer(SOCKADDR_UNION_SIZE);
  const remote = new ArrayBuffer(SOCKADDR_UNION_SIZE);
  const userData = new ArrayBuffer(8);
  new Uint8Array(local).set(new Uint8Array(localSockaddr, 0, localSockaddrLen));
  new Uint8Array(remote).set(new Uint8Array(remoteSockaddr, 0, remoteSockaddrLen));
  writeU64(userData, 0, BigInt(Math.max(0, fd)));
  const path = new ArrayBuffer(NGTCP2_PATH_SIZE);
  writeAddress(path, PATH_LOCAL + ADDR_ADDR, Pointer.addr(local) as bigint);
  writeU32(path, PATH_LOCAL + ADDR_ADDRLEN, localSockaddrLen);
  writeAddress(path, PATH_REMOTE + ADDR_ADDR, Pointer.addr(remote) as bigint);
  writeU32(path, PATH_REMOTE + ADDR_ADDRLEN, remoteSockaddrLen);
  writeAddress(path, PATH_USER_DATA, Pointer.addr(userData) as bigint);
  return {
    path,
    local,
    remote,
    userData,
    fd
  };
}
function makeOutputPath(localAddress: QuicAddress, remoteAddress: QuicAddress, fd = 0): NativePath {
  return makePath(localAddress, remoteAddress, fd);
}
function remoteAddressFromPath(path: ArrayBuffer): QuicAddress | null {
  const addrPtr = ptrField(path, PATH_REMOTE + ADDR_ADDR);
  const addrLen = readU32(path, PATH_REMOTE + ADDR_ADDRLEN);
  if (addrPtr === null || addrLen === 0 || addrLen > SOCKADDR_UNION_SIZE) return null;
  const bytes = Pointer.copyFrom(addrPtr, addrLen) as Uint8Array;
  const decoded = decodeAddr(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return decoded.family === 'ipv4' || decoded.family === 'ipv6' ? decoded : null;
}
function localAddressFromPath(path: ArrayBuffer): QuicAddress | null {
  const addrPtr = ptrField(path, PATH_LOCAL + ADDR_ADDR);
  const addrLen = readU32(path, PATH_LOCAL + ADDR_ADDRLEN);
  if (addrPtr === null || addrLen === 0 || addrLen > SOCKADDR_UNION_SIZE) return null;
  const bytes = Pointer.copyFrom(addrPtr, addrLen) as Uint8Array;
  const decoded = decodeAddr(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return decoded.family === 'ipv4' || decoded.family === 'ipv6' ? decoded : null;
}
function fdFromPath(path: ArrayBuffer, fallback: number): number {
  const userData = ptrField(path, PATH_USER_DATA);
  if (userData === null) return fallback;
  const fd = Number(Pointer.readU64(userData, 0));
  return Number.isSafeInteger(fd) && fd > 0 ? fd : fallback;
}
function fdFromNativePath(path: ArrayBuffer | null, fallback: number): number {
  if (path === null) return fallback;
  const pathBytes = Pointer.copyFrom(path, NGTCP2_PATH_SIZE) as Uint8Array;
  return fdFromPath(pathBytes.buffer.slice(pathBytes.byteOffset, pathBytes.byteOffset + pathBytes.byteLength), fallback);
}
function pathSnapshotFromNative(path: ArrayBuffer | null, fallbackFd: number): PathSnapshot | null {
  if (path === null) return null;
  const pathBytes = Pointer.copyFrom(path, NGTCP2_PATH_SIZE) as Uint8Array;
  const copy = pathBytes.buffer.slice(pathBytes.byteOffset, pathBytes.byteOffset + pathBytes.byteLength);
  const remoteAddress = remoteAddressFromPath(copy);
  const localAddress = localAddressFromPath(copy);
  if (remoteAddress === null || localAddress === null) return null;
  return {
    localAddress,
    remoteAddress,
    fd: fdFromPath(copy, fallbackFd)
  };
}
function pathFromSnapshot(snapshot: PathSnapshot | null): QuicPath | null {
  if (snapshot === null) return null;
  return {
    localAddress: snapshot.localAddress,
    remoteAddress: snapshot.remoteAddress
  };
}
function pathSnapshotsDiffer(a: PathSnapshot | null, b: PathSnapshot | null): boolean {
  if (a === null || b === null) return false;
  return a.fd !== b.fd || !sameAddress(a.localAddress, b.localAddress) || !sameAddress(a.remoteAddress, b.remoteAddress);
}
function pathValidationResultName(result: number): QuicPathValidationResult {
  if (result === NGTCP2_PATH_VALIDATION_RESULT_SUCCESS) return 'success';
  if (result === NGTCP2_PATH_VALIDATION_RESULT_FAILURE) return 'failure';
  if (result === NGTCP2_PATH_VALIDATION_RESULT_ABORTED) return 'aborted';
  return 'failure';
}
function preferredAddressFromNative(paddr: ArrayBuffer | null, family: 'ipv4' | 'ipv6'): QuicAddress | null {
  if (paddr === null) return null;
  const presentOffset = family === 'ipv4' ? TP_PREFERRED_ADDR_IPV4_PRESENT : TP_PREFERRED_ADDR_IPV6_PRESENT;
  if (Pointer.readU8(paddr, presentOffset) === 0) return null;
  const offset = family === 'ipv4' ? TP_PREFERRED_ADDR_IPV4 : TP_PREFERRED_ADDR_IPV6;
  const len = family === 'ipv4' ? 16 : 28;
  const bytes = Pointer.copyFrom(Pointer.offset(paddr, offset), len) as Uint8Array;
  const decoded = decodeAddr(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return decoded.family === family ? decoded : null;
}
function cidFromTransportParams(params: ArrayBuffer, offset: number, presentOffset: number): Uint8Array | null {
  if (Pointer.readU8(params, presentOffset) === 0) return null;
  const bytes = Pointer.copyFrom(Pointer.offset(params, offset), NGTCP2_CID_SIZE) as Uint8Array;
  return cidBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function transportParameterSnapshot(params: ArrayBuffer | null): QuicTransportParameterSnapshot | null {
  if (params === null || ptrAddress(params) === 0n) return null;
  const preferred = Pointer.readU8(params, TP_PREFERRED_ADDR_PRESENT) === 0 ? null : preferredAddressFromNative(Pointer.offset(params, TP_PREFERRED_ADDR), 'ipv4') ?? preferredAddressFromNative(Pointer.offset(params, TP_PREFERRED_ADDR), 'ipv6');
  const statelessResetToken = Pointer.readU8(params, TP_STATELESS_RESET_TOKEN_PRESENT) === 0 ? null : Pointer.copyFrom(Pointer.offset(params, TP_STATELESS_RESET_TOKEN), NGTCP2_STATELESS_RESET_TOKENLEN) as Uint8Array;
  return Object.freeze({
    initialMaxStreamDataBidiLocal: Number(Pointer.readU64(params, TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL)),
    initialMaxStreamDataBidiRemote: Number(Pointer.readU64(params, TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE)),
    initialMaxStreamDataUni: Number(Pointer.readU64(params, TP_INITIAL_MAX_STREAM_DATA_UNI)),
    initialMaxData: Number(Pointer.readU64(params, TP_INITIAL_MAX_DATA)),
    initialMaxStreamsBidi: Number(Pointer.readU64(params, TP_INITIAL_MAX_STREAMS_BIDI)),
    initialMaxStreamsUni: Number(Pointer.readU64(params, TP_INITIAL_MAX_STREAMS_UNI)),
    maxIdleTimeoutMs: nsToMs(Pointer.readU64(params, TP_MAX_IDLE_TIMEOUT)),
    maxUdpPayloadSize: Number(Pointer.readU64(params, TP_MAX_UDP_PAYLOAD_SIZE)),
    activeConnectionIdLimit: Number(Pointer.readU64(params, TP_ACTIVE_CONNECTION_ID_LIMIT)),
    ackDelayExponent: Number(Pointer.readU64(params, TP_ACK_DELAY_EXPONENT)),
    maxAckDelayMs: nsToMs(Pointer.readU64(params, TP_MAX_ACK_DELAY)),
    maxDatagramFrameSize: Number(Pointer.readU64(params, TP_MAX_DATAGRAM_FRAME_SIZE)),
    disableActiveMigration: Pointer.readU8(params, TP_DISABLE_ACTIVE_MIGRATION) !== 0,
    preferredAddress: preferred,
    originalDestinationConnectionId: cidFromTransportParams(params, TP_ORIGINAL_DCID, TP_ORIGINAL_DCID_PRESENT),
    initialSourceConnectionId: cidFromTransportParams(params, TP_INITIAL_SCID, TP_INITIAL_SCID_PRESENT),
    retrySourceConnectionId: cidFromTransportParams(params, TP_RETRY_SCID, TP_RETRY_SCID_PRESENT),
    statelessResetToken
  });
}
function writeNativePathAddress(destPath: ArrayBuffer, pathOffset: number, address: QuicAddress): boolean {
  const addrPtr = Pointer.readPointer(destPath, pathOffset + ADDR_ADDR) as ArrayBuffer | null;
  if (addrPtr === null) return false;
  const encoded = encodeAddr(address);
  Pointer.copyTo(addrPtr, new Uint8Array(encoded.buf));
  Pointer.writeU32(destPath, pathOffset + ADDR_ADDRLEN, encoded.len);
  return true;
}
function writeNativePathUserData(destPath: ArrayBuffer, userData: ArrayBuffer): void {
  Pointer.writeU64(destPath, PATH_USER_DATA, Pointer.addr(userData) as bigint);
}
function makePacketInfo(ecn = NGTCP2_ECN_NOT_ECT): ArrayBuffer {
  const info = new ArrayBuffer(NGTCP2_PKT_INFO_SIZE);
  writeU8(info, PKT_INFO_ECN, ecn & NGTCP2_ECN_MASK);
  return info;
}
function packetInfoEcn(info: ArrayBuffer | null): number | undefined {
  if (info === null) return undefined;
  return new Uint8Array(info)[PKT_INFO_ECN]! & NGTCP2_ECN_MASK;
}
function qlogOutputPath(basePath: string | undefined, connectionId: string): {
  path: string;
  directory?: string;
} {
  if (basePath === undefined || basePath.length === 0) return { path: `${connectionId}.sqlog` };
  if (basePath.endsWith('/')) return {
    directory: basePath.slice(0, -1),
    path: `${basePath}${connectionId}.sqlog`
  };
  const last = basePath.slice(basePath.lastIndexOf('/') + 1);
  if (last.includes('.')) return { path: basePath };
  return {
    directory: basePath,
    path: `${basePath}/${connectionId}.sqlog`
  };
}
function writeAllFd(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const chunk = data.subarray(offset);
    const written = Number(fileLib.symbols.write(fd, chunk, chunk.byteLength));
    if (written <= 0) throw new Error(`qlog write failed: ${written}`);
    offset += written;
  }
}
function appendKeylogLine(options: QuicKeylogOptions, line: string): void {
  if (options === false) return;
  const fd = Number(fileLib.symbols.open(fileCstr(options.path), O_WRONLY | O_CREAT | O_APPEND, 384));
  if (fd < 0) return;
  try {
    fileLib.symbols.fchmod(fd, 384);
    const data = encodeUtf8(`${line}\n`);
    writeAllFd(fd, data);
  } finally {
    fileLib.symbols.close(fd);
  }
}
function createServerTlsContext(certificateFile: string, privateKeyFile: string, alpnProtocols: string[], options: Pick<ResolvedQuicOptions, 'tlsCipherSuites' | 'tlsGroups' | 'keylog'>, tlsOptions: {
  verifyClient?: boolean;
  rejectUnauthorized?: boolean;
  ca?: QuicCaOptions;
  groups?: readonly string[] | null;
}): QuicTlsContext {
  return newServerContext(certificateFile, privateKeyFile, alpnProtocols, options.tlsCipherSuites, options.keylog === false ? undefined : (line) => appendKeylogLine(options.keylog, line), {
    ...tlsOptions,
    groups: tlsOptions.groups ?? options.tlsGroups
  });
}
let _qlogWriteCallback: FfiCallback | null = null;
function qlogWriteCallbackPointer(): ArrayBuffer {
  if (_qlogWriteCallback === null) {
    _qlogWriteCallback = new FfiCallback({
      parameters: [
        'pointer',
        'u32',
        'pointer',
        'usize'
      ],
      result: 'void'
    }, (userData: ArrayBuffer | null, flags: number, data: ArrayBuffer | null, datalen: bigint) => withNativeCallback(() => {
      connectionFromUserData(userData)?._onQlogWrite(flags, copyFromPtr(data, Number(datalen)));
    }));
    _callbackRefs.push(_qlogWriteCallback);
  }
  return _qlogWriteCallback.pointer;
}
function congestionControlValue(value: 'cubic' | 'reno' | 'bbr'): number {
  if (value === 'reno') return 0;
  if (value === 'bbr') return 2;
  return 1;
}
function makeSettings(options: ResolvedQuicOptions, runtime: QuicRuntime, token: Uint8Array | null = null, tokenType = NGTCP2_TOKEN_TYPE_UNKNOWN, originalVersion = 0): ArrayBuffer {
  const settings = new ArrayBuffer(NGTCP2_SETTINGS_SIZE);
  ngtcp2Sym!.ngtcp2_settings_default_versioned(NGTCP2_SETTINGS_VERSION, Pointer.of(settings));
  const versions = compatibleVersionList(options.versions);
  if (options.qlog !== false) writePtr(settings, SETTINGS_QLOG_WRITE, qlogWriteCallbackPointer());
  if (options.connection.congestionControl !== 'cubic') {
    writeU32(settings, SETTINGS_CC_ALGO, congestionControlValue(options.connection.congestionControl));
  }
  writeU64(settings, SETTINGS_INITIAL_TS, now(runtime));
  if (options.connection.initialRtt > 0n) writeU64(settings, SETTINGS_INITIAL_RTT, options.connection.initialRtt);
  writeU64(settings, SETTINGS_MAX_TX_UDP_PAYLOAD_SIZE, BigInt(options.connection.maxPayloadSize === DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE ? NGTCP2_MAX_UDP_PAYLOAD_SIZE : options.connection.maxPayloadSize));
  writeU64(settings, SETTINGS_MAX_WINDOW, options.connection.maxWindow === 0n ? MAX_RECEIVE_WINDOW : options.connection.maxWindow);
  writeU64(settings, SETTINGS_MAX_STREAM_WINDOW, options.connection.maxStreamWindow === 0n ? MAX_RECEIVE_WINDOW : options.connection.maxStreamWindow);
  if (options.connection.unacknowledgedPacketThreshold > 0n) {
    writeU64(settings, SETTINGS_ACK_THRESH, options.connection.unacknowledgedPacketThreshold);
  }
  writeU8(settings, SETTINGS_NO_TX_UDP_PAYLOAD_SIZE_SHAPING, 1);
  writeU64(settings, SETTINGS_HANDSHAKE_TIMEOUT, options.connection.handshakeTimeout);
  if (originalVersion !== 0) writeU32(settings, SETTINGS_ORIGINAL_VERSION, originalVersion);
  writeAddress(settings, SETTINGS_PREFERRED_VERSIONS, Pointer.addr(versions) as bigint);
  writeU64(settings, SETTINGS_PREFERRED_VERSIONSLEN, BigInt(versions.byteLength / 4));
  writeAddress(settings, SETTINGS_AVAILABLE_VERSIONS, Pointer.addr(versions) as bigint);
  writeU64(settings, SETTINGS_AVAILABLE_VERSIONSLEN, BigInt(versions.byteLength / 4));
  writeU8(settings, SETTINGS_NO_PMTUD, 1);
  if (token !== null && token.byteLength > 0) {
    writeAddress(settings, SETTINGS_TOKEN, Pointer.addr(token) as bigint);
    writeU64(settings, SETTINGS_TOKENLEN, BigInt(token.byteLength));
    writeU32(settings, SETTINGS_TOKEN_TYPE, tokenType);
  }
  return settings;
}
function makeTransportParams(originalDcid: ArrayBuffer | null = null, options?: ResolvedQuicOptions, retryScid: ArrayBuffer | null = null, preferredAddress?: PreferredAddressParams | null, statelessResetToken?: Uint8Array | null): ArrayBuffer {
  const params = new ArrayBuffer(NGTCP2_TRANSPORT_PARAMS_SIZE);
  ngtcp2Sym!.ngtcp2_transport_params_default_versioned(NGTCP2_TRANSPORT_PARAMS_VERSION, Pointer.of(params));
  const connection = options?.connection;
  writeU64(params, TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL, connection?.initialMaxStreamDataBidiLocal ?? INITIAL_MAX_STREAM_DATA);
  writeU64(params, TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE, connection?.initialMaxStreamDataBidiRemote ?? INITIAL_MAX_STREAM_DATA);
  writeU64(params, TP_INITIAL_MAX_STREAM_DATA_UNI, connection?.initialMaxStreamDataUni ?? INITIAL_MAX_STREAM_DATA);
  writeU64(params, TP_INITIAL_MAX_DATA, connection?.initialMaxData ?? INITIAL_MAX_DATA);
  writeU64(params, TP_INITIAL_MAX_STREAMS_BIDI, connection?.initialMaxStreamsBidi ?? INITIAL_MAX_STREAMS_BIDI);
  writeU64(params, TP_INITIAL_MAX_STREAMS_UNI, connection?.initialMaxStreamsUni ?? INITIAL_MAX_STREAMS_UNI);
  writeU64(params, TP_MAX_IDLE_TIMEOUT, connection?.maxIdleTimeout ?? MAX_IDLE_TIMEOUT);
  writeU64(params, TP_MAX_UDP_PAYLOAD_SIZE, BigInt(NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE));
  writeU64(params, TP_ACTIVE_CONNECTION_ID_LIMIT, connection?.activeConnectionIdLimit ?? ACTIVE_CONNECTION_ID_LIMIT);
  writeU64(params, TP_ACK_DELAY_EXPONENT, connection?.ackDelayExponent ?? 3n);
  writeU64(params, TP_MAX_ACK_DELAY, connection?.maxAckDelay ?? 25n * NGTCP2_MILLISECONDS);
  writeU8(params, TP_DISABLE_ACTIVE_MIGRATION, connection?.disableActiveMigration === true ? 1 : 0);
  if (options?.datagrams.enabled === true) {
    writeU64(params, TP_MAX_DATAGRAM_FRAME_SIZE, BigInt(options.datagrams.maxFrameSize));
  }
  if (statelessResetToken !== undefined && statelessResetToken !== null) {
    new Uint8Array(params, TP_STATELESS_RESET_TOKEN, NGTCP2_STATELESS_RESET_TOKENLEN).set(statelessResetToken.subarray(0, NGTCP2_STATELESS_RESET_TOKENLEN));
    writeU8(params, TP_STATELESS_RESET_TOKEN_PRESENT, 1);
  }
  if (originalDcid !== null) {
    new Uint8Array(params, TP_ORIGINAL_DCID, NGTCP2_CID_SIZE).set(new Uint8Array(originalDcid));
    writeU8(params, TP_ORIGINAL_DCID_PRESENT, 1);
  }
  if (retryScid !== null) {
    new Uint8Array(params, TP_RETRY_SCID, NGTCP2_CID_SIZE).set(new Uint8Array(retryScid));
    writeU8(params, TP_RETRY_SCID_PRESENT, 1);
  }
  if (preferredAddress !== undefined && preferredAddress !== null) {
    const firstEntry = preferredAddress.ipv4 ?? preferredAddress.ipv6;
    if (firstEntry === undefined) return params;
    new Uint8Array(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_CID, NGTCP2_CID_SIZE).set(new Uint8Array(firstEntry.cid));
    if (preferredAddress.ipv4 !== undefined) {
      const encoded = encodeAddr(preferredAddress.ipv4.address);
      new Uint8Array(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_IPV4, encoded.len).set(new Uint8Array(encoded.buf));
      writeU8(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_IPV4_PRESENT, 1);
    }
    if (preferredAddress.ipv6 !== undefined) {
      const encoded = encodeAddr(preferredAddress.ipv6.address);
      new Uint8Array(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_IPV6, encoded.len).set(new Uint8Array(encoded.buf));
      writeU8(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_IPV6_PRESENT, 1);
    }
    new Uint8Array(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN, 16).set(firstEntry.statelessResetToken.subarray(0, 16));
    writeU8(params, TP_PREFERRED_ADDR_PRESENT, 1);
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
let _callbackRefs: Array<{
  close(): void;
}> = [];
function ensureCallbackTable(): ArrayBuffer {
  if (_callbackTable !== null) return _callbackTable;
  if (cryptoPtr === null || ngtcp2Ptr === null) throw new Error('ngtcp2 callback symbols are unavailable');
  const cbs = new ArrayBuffer(NGTCP2_CALLBACKS_SIZE);
  const retain = (cb: {
    pointer: ArrayBuffer;
    close(): void;
  }) => {
    _callbackRefs.push(cb);
    return cb.pointer;
  };
  const getConn = new FfiCallback({
    parameters: ['pointer'],
    result: 'pointer'
  }, (connRef: ArrayBuffer) => withNativeCallback(() => {
    const userData = Pointer.readPointer(connRef, 8) as ArrayBuffer | null;
    return connectionFromUserData(userData)?.nativeHandle ?? null;
  }));
  const handshakeCompleted = new FfiCallback({
    parameters: ['ignoredPointer', 'pointer'],
    result: 'i32'
  }, (_conn: ArrayBuffer, userData: ArrayBuffer | null) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onHandshakeCompleted();
    return 0;
  }));
  const handshakeConfirmed = new FfiCallback({
    parameters: ['ignoredPointer', 'pointer'],
    result: 'i32'
  }, (_conn: ArrayBuffer, userData: ArrayBuffer | null) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onHandshakeConfirmed();
    return 0;
  }));
  const recvStreamData = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u32',
      'i64',
      'u64',
      'pointer',
      'usize',
      'pointer',
      'ignoredPointer'
    ],
    result: 'i32'
  }, (_conn: ArrayBuffer, flags: number, streamId: bigint, offset: bigint, data: ArrayBuffer | null, datalen: bigint, userData: ArrayBuffer | null) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onStreamData(Number(streamId), Number(offset), copyFromPtr(data, Number(datalen)), (flags & STREAM_DATA_FLAG_FIN) !== 0);
    return 0;
  }));
  const recvDatagram = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u32',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  }, (_conn: ArrayBuffer, flags: number, data: ArrayBuffer | null, datalen: bigint, userData: ArrayBuffer | null) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onDatagram(copyFromPtr(data, Number(datalen)), (flags & NGTCP2_DATAGRAM_FLAG_0RTT) !== 0);
    return 0;
  }));
  const streamOpen = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'i64',
      'pointer'
    ],
    result: 'i32'
  }, (_conn: ArrayBuffer, streamId: bigint, userData: ArrayBuffer | null) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onRemoteStreamOpen(Number(streamId));
    return 0;
  }));
  const streamClose = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u32',
      'i64',
      'u64',
      'pointer',
      'ignoredPointer'
    ],
    result: 'i32'
  }, (_conn, _flags, streamId, _appCode, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onStreamClose(Number(streamId));
    return 0;
  }));
  const streamReset = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'i64',
      'u64',
      'u64',
      'pointer',
      'ignoredPointer'
    ],
    result: 'i32'
  }, (_conn, streamId, _finalSize, appCode, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onStreamReset(Number(streamId), Number(appCode));
    return 0;
  }));
  const acked = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'i64',
      'u64',
      'u64',
      'pointer',
      'ignoredPointer'
    ],
    result: 'i32'
  }, (_conn, streamId, offset, datalen, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onAckedStreamDataOffset(Number(streamId), Number(offset), Number(datalen));
    return 0;
  }));
  const extendStreamsBidi = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u64',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, _maxStreams, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onLocalStreamCredit('bidirectional');
    return 0;
  }));
  const extendStreamsUni = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u64',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, _maxStreams, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onLocalStreamCredit('unidirectional');
    return 0;
  }));
  const extendMaxStreamData = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'i64',
      'u64',
      'pointer',
      'ignoredPointer'
    ],
    result: 'i32'
  }, (_conn, streamId, maxData, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onStreamDataCredit(Number(streamId), Number(maxData));
    return 0;
  }));
  const stopSending = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'i64',
      'u64',
      'pointer',
      'ignoredPointer'
    ],
    result: 'i32'
  }, (_conn, streamId, appCode, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onStreamStopSending(Number(streamId), Number(appCode));
    return 0;
  }));
  const rand = new FfiCallback({
    parameters: [
      'pointer',
      'usize',
      'ignoredPointer'
    ],
    result: 'void'
  }, (dest: ArrayBuffer | null, len: bigint) => withNativeCallback(() => {
    if (dest !== null) Pointer.copyTo(dest, randomBytes(Number(len)));
  }));
  const getPathChallengeData = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'pointer',
      'ignoredPointer'
    ],
    result: 'i32'
  }, (_conn, data) => withNativeCallback(() => {
    if (data === null) return NGTCP2_ERR_CALLBACK_FAILURE;
    Pointer.copyTo(data, randomBytes(8));
    return 0;
  }));
  const getNewConnectionId = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'pointer',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, cid, token, cidlen, userData) => withNativeCallback(() => {
    const bytes = randomBytes(Number(cidlen));
    Pointer.writeU64(cid, CID_DATALEN, cidlen);
    Pointer.copyTo(Pointer.offset(cid, CID_DATA), bytes);
    Pointer.copyTo(token, randomBytes(16));
    connectionFromUserData(userData)?._registerIssuedCid(makeCid(bytes));
    return 0;
  }));
  const removeConnectionId = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, cid, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._unregisterIssuedCid(cid);
    return 0;
  }));
  const dcidStatus = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'i32',
      'u64',
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, type, _seq, cid, token, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onDestinationCidStatus(type, cid, token);
    return 0;
  }));
  const recvNewToken = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, token, tokenlen, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onNewToken(copyFromPtr(token, Number(tokenlen)));
    return 0;
  }));
  const ackDatagram = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u64',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, dgramId, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onDatagramStatus(Number(dgramId), 'ack');
    return 0;
  }));
  const lostDatagram = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u64',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, dgramId, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onDatagramStatus(Number(dgramId), 'lost');
    return 0;
  }));
  const recvKey = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'i32',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, level, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onKeyInstalled(level);
    return 0;
  }));
  const recvVersionNegotiation = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'pointer',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, hd, sv, nsv, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onVersionNegotiation(hd, sv, Number(nsv));
    return 0;
  }));
  const earlyDataRejected = new FfiCallback({
    parameters: ['ignoredPointer', 'pointer'],
    result: 'i32'
  }, (_conn, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onEarlyDataRejected();
    return 0;
  }));
  const recvStatelessReset = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'ignoredPointer',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, _sr, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onStatelessReset();
    return 0;
  }));
  const beginPathValidation = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u32',
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, flags, path, fallbackPath, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onPathValidationStarted(path, fallbackPath, flags);
    return 0;
  }));
  const pathValidation = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'u32',
      'pointer',
      'pointer',
      'i32',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, flags, path, fallbackPath, result, userData) => withNativeCallback(() => {
    connectionFromUserData(userData)?._onPathValidationFinished(path, fallbackPath, result, flags);
    return 0;
  }));
  const selectPreferredAddress = new FfiCallback({
    parameters: [
      'ignoredPointer',
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  }, (_conn, dest, paddr, userData) => withNativeCallback(() => {
    return connectionFromUserData(userData)?._selectPreferredAddress(dest, paddr) ?? 0;
  }));
  const recvStatelessResetPtr = retain(recvStatelessReset);
  const getNewConnectionIdPtr = retain(getNewConnectionId);
  const dcidStatusPtr = retain(dcidStatus);
  const getPathChallengeDataPtr = retain(getPathChallengeData);
  writePtr(cbs, CB_CLIENT_INITIAL, cryptoPtr.ngtcp2_crypto_client_initial_cb);
  writePtr(cbs, CB_RECV_CLIENT_INITIAL, cryptoPtr.ngtcp2_crypto_recv_client_initial_cb);
  writePtr(cbs, CB_RECV_CRYPTO_DATA, cryptoPtr.ngtcp2_crypto_recv_crypto_data_cb);
  writePtr(cbs, CB_RECV_VERSION_NEGOTIATION, retain(recvVersionNegotiation));
  writePtr(cbs, CB_RECV_RETRY, cryptoPtr.ngtcp2_crypto_recv_retry_cb);
  writePtr(cbs, CB_ENCRYPT, cryptoPtr.ngtcp2_crypto_encrypt_cb);
  writePtr(cbs, CB_DECRYPT, cryptoPtr.ngtcp2_crypto_decrypt_cb);
  writePtr(cbs, CB_HP_MASK, cryptoPtr.ngtcp2_crypto_hp_mask_cb);
  writePtr(cbs, CB_UPDATE_KEY, cryptoPtr.ngtcp2_crypto_update_key_cb);
  writePtr(cbs, CB_DELETE_CRYPTO_AEAD_CTX, cryptoPtr.ngtcp2_crypto_delete_crypto_aead_ctx_cb);
  writePtr(cbs, CB_DELETE_CRYPTO_CIPHER_CTX, cryptoPtr.ngtcp2_crypto_delete_crypto_cipher_ctx_cb);
  writePtr(cbs, CB_RECV_DATAGRAM, retain(recvDatagram));
  writePtr(cbs, CB_ACK_DATAGRAM, retain(ackDatagram));
  writePtr(cbs, CB_LOST_DATAGRAM, retain(lostDatagram));
  writePtr(cbs, CB_VERSION_NEGOTIATION, cryptoPtr.ngtcp2_crypto_version_negotiation_cb);
  writePtr(cbs, CB_HANDSHAKE_COMPLETED, retain(handshakeCompleted));
  writePtr(cbs, CB_HANDSHAKE_CONFIRMED, retain(handshakeConfirmed));
  writePtr(cbs, CB_RECV_NEW_TOKEN, retain(recvNewToken));
  writePtr(cbs, CB_RECV_STREAM_DATA, retain(recvStreamData));
  writePtr(cbs, CB_ACKED_STREAM_DATA_OFFSET, retain(acked));
  writePtr(cbs, CB_STREAM_OPEN, retain(streamOpen));
  writePtr(cbs, CB_STREAM_CLOSE, retain(streamClose));
  writePtr(cbs, CB_STREAM_RESET, retain(streamReset));
  writePtr(cbs, CB_STREAM_STOP_SENDING, retain(stopSending));
  writePtr(cbs, CB_EXTEND_MAX_STREAM_DATA, retain(extendMaxStreamData));
  writePtr(cbs, CB_RECV_RX_KEY, retain(recvKey));
  writePtr(cbs, CB_RECV_TX_KEY, retain(recvKey));
  writePtr(cbs, CB_EARLY_DATA_REJECTED, retain(earlyDataRejected));
  writePtrIfPresent(cbs, CB_BEGIN_PATH_VALIDATION, retain(beginPathValidation));
  writePtr(cbs, CB_PATH_VALIDATION, retain(pathValidation));
  writePtr(cbs, CB_SELECT_PREFERRED_ADDR, retain(selectPreferredAddress));
  writePtr(cbs, CB_EXTEND_MAX_LOCAL_STREAMS_BIDI, retain(extendStreamsBidi));
  writePtr(cbs, CB_EXTEND_MAX_LOCAL_STREAMS_UNI, retain(extendStreamsUni));
  writePtr(cbs, CB_RAND, retain(rand));
  writePtr(cbs, CB_RECV_STATELESS_RESET, recvStatelessResetPtr);
  writePtrIfPresent(cbs, CB_RECV_STATELESS_RESET2, recvStatelessResetPtr);
  writePtr(cbs, CB_GET_NEW_CONNECTION_ID, getNewConnectionIdPtr);
  writePtrIfPresent(cbs, CB_GET_NEW_CONNECTION_ID2, getNewConnectionIdPtr);
  writePtr(cbs, CB_REMOVE_CONNECTION_ID, retain(removeConnectionId));
  writePtr(cbs, CB_DCID_STATUS, dcidStatusPtr);
  writePtrIfPresent(cbs, CB_DCID_STATUS2, dcidStatusPtr);
  writePtr(cbs, CB_GET_PATH_CHALLENGE_DATA, getPathChallengeDataPtr);
  writePtrIfPresent(cbs, CB_GET_PATH_CHALLENGE_DATA2, getPathChallengeDataPtr);
  _callbackRefs.push(getConn);
  (ensureCallbackTable as any)._getConnPointer = getConn.pointer;
  _callbackTable = cbs;
  return cbs;
}
function getConnRefPointer(): ArrayBuffer {
  ensureCallbackTable();
  return (ensureCallbackTable as any)._getConnPointer;
}
/**
* Return the process-wide ngtcp2 callback table for QUIC ABI tests.
*
* @internal
*/
export function __inspectQuicCallbackTable(): ArrayBuffer {
  return ensureCallbackTable();
}
/**
* Return transport-loop tuning values that are intentionally kept close to
* Node's ngtcp2 driver for regression tests.
*
* @internal
*/
export function __inspectQuicRuntimeTuning(): {
  maxReadPacketsPerTurn: number;
  maxBatchReadPacketsPerTurn: number;
  retryRate: number;
  retryBurst: number;
  versionNegotiationRate: number;
  versionNegotiationBurst: number;
  statelessResetRate: number;
  statelessResetBurst: number;
  sessionCreationRate: number;
  sessionCreationBurst: number;
} {
  return {
    maxReadPacketsPerTurn: MAX_READ_PACKETS_PER_TURN,
    maxBatchReadPacketsPerTurn: MAX_BATCH_READ_PACKETS_PER_TURN,
    retryRate: DEFAULT_RETRY_RATE,
    retryBurst: DEFAULT_RETRY_BURST,
    versionNegotiationRate: DEFAULT_VERSION_NEGOTIATION_RATE,
    versionNegotiationBurst: DEFAULT_VERSION_NEGOTIATION_BURST,
    statelessResetRate: DEFAULT_STATELESS_RESET_RATE,
    statelessResetBurst: DEFAULT_STATELESS_RESET_BURST,
    sessionCreationRate: DEFAULT_SESSION_CREATION_RATE,
    sessionCreationBurst: DEFAULT_SESSION_CREATION_BURST
  };
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
  constructor(type: string, init: {
    connection: QuicConnection;
  }) {
    super(type);
    this.connection = init.connection;
  }
}
export class QuicStreamEvent extends Event {
  readonly stream: QuicStream;
  constructor(type: string, init: {
    stream: QuicStream;
  }) {
    super(type);
    this.stream = init.stream;
  }
}
export class QuicStreamBlockedEvent extends Event {
  /** Stream that was blocked by QUIC flow control. */
  readonly stream: QuicStream;
  /** Owning QUIC connection. */
  readonly connection: QuicConnection;
  /** Numeric QUIC stream identifier. */
  readonly streamId: number;
  /** Create an event carrying one flow-control blocked stream notification. */
  constructor(type: string, init: {
    stream: QuicStream;
    connection: QuicConnection;
    streamId?: number;
  }) {
    super(type);
    this.stream = init.stream;
    this.connection = init.connection;
    this.streamId = init.streamId ?? init.stream.id;
  }
}
export class QuicStreamResetEvent extends Event {
  /** Peer application error code carried by RESET_STREAM. */
  readonly errorCode: number;
  /** Error object suitable for compatibility with existing error handlers. */
  readonly error: Error;
  /** Create an event carrying one RESET_STREAM application code. */
  constructor(type: string, init: {
    errorCode: number;
    error?: Error;
  }) {
    super(type);
    this.errorCode = init.errorCode;
    this.error = init.error ?? new Error(`QUIC stream reset: ${init.errorCode}`);
  }
}
export class QuicDatagramEvent extends Event {
  /** Datagram payload copied from ngtcp2 receive memory. */
  readonly data: Uint8Array;
  /** True when the datagram arrived in 0-RTT packet space. */
  readonly earlyData: boolean;
  /** Create an event carrying one received QUIC DATAGRAM payload. */
  constructor(type: string, init: {
    data: Uint8Array;
    earlyData?: boolean;
  }) {
    super(type);
    this.data = init.data;
    this.earlyData = init.earlyData === true;
  }
}
export class QuicDatagramStatusEvent extends Event {
  /** Application-assigned datagram identifier passed to ngtcp2. */
  readonly id: number;
  /** Delivery status reported by ngtcp2 recovery. */
  readonly status: QuicDatagramStatus;
  /** Create an event carrying one QUIC DATAGRAM delivery status update. */
  constructor(type: string, init: {
    id: number;
    status: QuicDatagramStatus;
  }) {
    super(type);
    this.id = init.id;
    this.status = init.status;
  }
}
export class QuicNewTokenEvent extends Event {
  /** Address-validation token received from a QUIC NEW_TOKEN frame. */
  readonly token: Uint8Array;
  /** Peer address for which the token is valid. */
  readonly address: QuicAddress;
  /** Create an event carrying a QUIC NEW_TOKEN address-validation token. */
  constructor(type: string, init: {
    token: Uint8Array;
    address: QuicAddress;
  }) {
    super(type);
    this.token = init.token;
    this.address = { ...init.address };
  }
}
export class QuicEarlyDataEvent extends Event {
  /** True when the attempted 0-RTT state is usable for early writes. */
  readonly accepted: boolean;
  /** True when early data was attempted but cannot be used. */
  readonly rejected: boolean;
  /** Stable application-readable reason for the early-data decision. */
  readonly reason: string;
  /** Create an event carrying one 0-RTT early-data decision. */
  constructor(type: string, init: {
    accepted: boolean;
    rejected: boolean;
    reason: string;
  }) {
    super(type);
    this.accepted = init.accepted;
    this.rejected = init.rejected;
    this.reason = init.reason;
  }
}
export class QuicStopSendingEvent extends Event {
  /** Peer application error code carried by STOP_SENDING. */
  readonly errorCode: number;
  /** Error object suitable for compatibility with existing error handlers. */
  readonly error: Error;
  /** Create an event carrying one peer STOP_SENDING application code. */
  constructor(type: string, init: {
    errorCode: number;
    error?: Error;
  }) {
    super(type);
    this.errorCode = init.errorCode;
    this.error = init.error ?? new Error(`QUIC stream stop sending: ${init.errorCode}`);
  }
}
export class QuicPathValidationEvent extends Event {
  /** Path-validation result reported by ngtcp2. */
  readonly result: QuicPathValidationResult;
  /** Newly validated path, or the failed path when validation failed. */
  readonly path: QuicPath | null;
  /** Fallback or previous path reported by ngtcp2, when available. */
  readonly previousPath: QuicPath | null;
  /** True when validation was for a server preferred address. */
  readonly preferredAddress: boolean;
  /** True when validation requested NEW_TOKEN generation for the new path. */
  readonly newToken: boolean;
  /** Create an event carrying path-validation result and path details. */
  constructor(type: string, init: {
    result: QuicPathValidationResult;
    path: QuicPath | null;
    previousPath?: QuicPath | null;
    preferredAddress?: boolean;
    newToken?: boolean;
  }) {
    super(type);
    this.result = init.result;
    this.path = init.path;
    this.previousPath = init.previousPath ?? null;
    this.preferredAddress = init.preferredAddress === true;
    this.newToken = init.newToken === true;
  }
}
export class QuicErrorEvent extends Event {
  readonly error: Error;
  constructor(type: string, init: {
    error: Error;
  }) {
    super(type);
    this.error = init.error;
  }
}
export class QuicVersionNegotiationError extends Error {
  readonly requestedVersions: readonly number[];
  readonly supportedVersions: readonly number[];
  constructor(requestedVersions: readonly number[], supportedVersions: readonly number[]) {
    super('QUIC Version Negotiation did not include a mutually supported retry version');
    this.requestedVersions = requestedVersions;
    this.supportedVersions = supportedVersions;
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
  #rejectedInitialCids = new Set<string>();
  #statelessResetTokens = new Map<string, QuicConnection>();
  #retryBucket: QuicTokenBucket;
  #versionNegotiationBucket: QuicTokenBucket;
  #statelessResetBucket: QuicTokenBucket;
  #immediateCloseBucket: QuicTokenBucket;
  #addressValidation: QuicAddressValidationCache;
  #addressTokens = new Map<string, Uint8Array>();
  #stats = {
    packetsReceived: 0,
    packetsSent: 0,
    bytesReceived: 0,
    bytesSent: 0,
    packetsBlocked: 0,
    sourceBlockedPackets: 0,
    serverBusyCount: 0,
    connectionLimitPackets: 0,
    retrySent: 0,
    retryRateLimited: 0,
    retryTokenAccepted: 0,
    retryTokenRejected: 0,
    addressTokenAccepted: 0,
    addressTokenRejected: 0,
    versionNegotiationSent: 0,
    versionNegotiationRateLimited: 0,
    statelessResetSent: 0,
    statelessResetRateLimited: 0,
    immediateCloseSent: 0,
    immediateCloseRateLimited: 0,
    sessionCreationRateLimited: 0,
    serverConnections: 0,
    clientConnections: 0
  };
  #transports = new Map<number, QuicDatagramTransport>();
  #transportFactory: QuicDatagramTransportFactory;
  #runtime: QuicRuntime;
  #clientBindAddress?: QuicAddress;
  #closed = false;
  #createdAt = Date.now();
  #destroyedAt: number | null = null;
  #routeCleanupTimers = new Set<QuicTimerHandle>();
  #options: ResolvedQuicOptions;
  readonly cidTable = new CidRoutingTable();
  readonly alpnProtocols: string[];
  readonly versions: QuicVersion[];
  readonly tlsCipherSuites: QuicTlsCipherSuite[] | null;
  readonly tlsGroups: string[] | null;
  readonly retry: ResolvedRetryOptions;
  readonly sessionStore?: QuicSessionStore;
  readonly earlyData: false | QuicEarlyDataPolicy;
  readonly migration: ResolvedMigrationOptions;
  readonly datagrams: ResolvedDatagramOptions;
  readonly connection: QuicResolvedConnectionOptions;
  readonly qlog: QuicQlogOptions;
  readonly keylog: QuicKeylogOptions;
  constructor(options: QuicEndpointOptions = {}, internals: QuicEndpointInternals = {}) {
    super();
    this.#runtime = internals.runtime ?? realQuicRuntime;
    this.#transportFactory = internals.transportFactory ?? (options.socket === undefined ? realQuicDatagramTransportFactory : new RealQuicDatagramTransportFactory(options.socket));
    this.#clientBindAddress = internals.clientBindAddress === undefined ? undefined : normalizeAddress(internals.clientBindAddress);
    this.alpnProtocols = options.alpnProtocols?.slice() ?? DEFAULT_ALPN_PROTOCOLS.slice();
    this.#options = resolveQuicOptions(options);
    this.#retryBucket = new QuicTokenBucket(this.#options.transport.retryRateLimit.rate, this.#options.transport.retryRateLimit.burst, this.#runtime);
    this.#versionNegotiationBucket = new QuicTokenBucket(this.#options.transport.versionNegotiationRateLimit.rate, this.#options.transport.versionNegotiationRateLimit.burst, this.#runtime);
    this.#statelessResetBucket = new QuicTokenBucket(this.#options.transport.statelessResetRateLimit.rate, this.#options.transport.statelessResetRateLimit.burst, this.#runtime);
    this.#immediateCloseBucket = new QuicTokenBucket(this.#options.transport.immediateCloseRateLimit.rate, this.#options.transport.immediateCloseRateLimit.burst, this.#runtime);
    this.#addressValidation = new QuicAddressValidationCache(this.#options.transport.addressValidationCacheSize, this.#options.transport.sessionCreationRateLimit, ADDRESS_VALIDATION_TIMEOUT, this.#runtime);
    this.versions = this.#options.versions.slice();
    this.tlsCipherSuites = this.#options.tlsCipherSuites?.slice() ?? null;
    this.tlsGroups = this.#options.tlsGroups?.slice() ?? null;
    this.retry = this.#options.retry;
    this.sessionStore = this.#options.sessionStore;
    this.earlyData = this.#options.earlyData;
    this.migration = this.#options.migration;
    this.datagrams = this.#options.datagrams;
    this.connection = freezeConnectionSnapshot(this.#options.connection);
    this.qlog = this.#options.qlog;
    this.keylog = this.#options.keylog;
    publishQuicTopic('quic.endpoint.created', {
      endpoint: this,
      options: this.#options
    });
  }
  #dispatch(event: Event): void {
    deferAfterNativeCallback(() => this.dispatchEvent(event));
  }
  get listeners(): ReadonlyArray<QuicListener> {
    return this.#listeners.slice();
  }
  get busy(): boolean {
    return this.#options.transport.busy;
  }
  get transport(): QuicResolvedTransportOptions {
    return freezeTransportSnapshot(this.#options.transport);
  }
  setBusy(busy: boolean): void {
    const nextBusy = Boolean(busy);
    const previousBusy = this.#options.transport.busy;
    if (!this.#options.transport.busy && nextBusy) this.#stats.serverBusyCount++;
    this.#options = {
      ...this.#options,
      transport: {
        ...this.#options.transport,
        busy: nextBusy
      }
    };
    if (previousBusy !== nextBusy) {
      publishQuicTopic('quic.endpoint.busy.change', {
        endpoint: this,
        busy: nextBusy
      });
    }
  }
  /**
  * Return address-validation counters for conformance tests.
  *
  * @internal
  */
  _inspectAddressValidationStats(): {
    retrySent: number;
    retryTokenAccepted: number;
    addressTokenAccepted: number;
  } {
    return {
      retrySent: this.#stats.retrySent,
      retryTokenAccepted: this.#stats.retryTokenAccepted,
      addressTokenAccepted: this.#stats.addressTokenAccepted
    };
  }
  get stats(): QuicEndpointStats {
    return Object.freeze({
      createdAt: this.#createdAt,
      destroyedAt: this.#destroyedAt,
      ...this.#stats,
      activeServerConnections: this.#activeServerConnectionCount(),
      activeConnections: this.#connections.size
    });
  }
  async _bindTransport(address: QuicAddress, options: {
    ecn?: boolean;
  } = {}): Promise<QuicDatagramTransport> {
    const transport = await this.#transportFactory.bind(address, options);
    this.#transports.set(transport.id, transport);
    return transport;
  }
  _unregisterTransport(transport: QuicDatagramTransport): void {
    if (this.#transports.get(transport.id) === transport) this.#transports.delete(transport.id);
  }
  _transportById(id: number): QuicDatagramTransport | undefined {
    return this.#transports.get(id);
  }
  _quicRuntime(): QuicRuntime {
    return this.#runtime;
  }
  _recordDatagramSent(bytes: number): void {
    this.#stats.packetsSent++;
    this.#stats.bytesSent += bytes;
  }
  _recordDatagramReceived(bytes: number): void {
    this.#stats.packetsReceived++;
    this.#stats.bytesReceived += bytes;
  }
  #recordProcessedPacket(): void {
    this.#stats.packetsReceived++;
  }
  #coerceTransport(transportOrFd: QuicDatagramTransport | number, localAddress: QuicAddress): QuicDatagramTransport {
    if (typeof transportOrFd !== 'number') return transportOrFd;
    const registered = this.#transports.get(transportOrFd);
    if (registered !== undefined) return registered;
    const fd = transportOrFd;
    return {
      id: fd,
      address: localAddress,
      closed: false,
      recvNow: () => null,
      waitReadable: () => loop.readable(fd),
      sendNow: (data: Uint8Array, dest: QuicAddress) => sendto(fd, data, dest),
      waitWritable: () => loop.writable(fd),
      close: () => {}
    };
  }
  async listen(options: QuicListenOptions = {}): Promise<QuicListener> {
    if (this.#closed) throw new Error('QUIC endpoint is closed');
    requireQuic();
    initCrypto();
    ensureCallbackTable();
    if (options.certificateFile === undefined || options.privateKeyFile === undefined) {
      throw new TypeError('QUIC listen requires explicit certificateFile and privateKeyFile');
    }
    const resolvedOptions = resolveQuicOptions(options, this.#options);
    const input = normalizeAddress(options.address);
    const transport = await this._bindTransport(input, { ecn: resolvedOptions.transport.ecn });
    const bound = transport.address;
    const transports = [transport];
    let listenerOptions = resolvedOptions;
    try {
      const preferredAddress = resolvedOptions.migration.preferredAddress;
      if (preferredAddress !== undefined) {
        const boundPreferred: ResolvedPreferredAddressOptions = {};
        if (preferredAddress.ipv4 !== undefined) {
          const preferredTransport = await this._bindTransport(preferredAddress.ipv4, { ecn: resolvedOptions.transport.ecn });
          transports.push(preferredTransport);
          boundPreferred.ipv4 = preferredTransport.address;
        }
        if (preferredAddress.ipv6 !== undefined) {
          const preferredTransport = await this._bindTransport(preferredAddress.ipv6, { ecn: resolvedOptions.transport.ecn });
          transports.push(preferredTransport);
          boundPreferred.ipv6 = preferredTransport.address;
        }
        listenerOptions = {
          ...resolvedOptions,
          migration: {
            ...resolvedOptions.migration,
            preferredAddress: boundPreferred
          }
        };
      }
    } catch (error) {
      for (const candidate of transports) {
        this._unregisterTransport(candidate);
        candidate.close();
      }
      throw error;
    }
    const protocols = options.alpnProtocols?.slice() ?? this.alpnProtocols;
    let ctx: QuicTlsContext | null = null;
    const sniContexts = new Map<string, QuicTlsContext>();
    try {
      ctx = createServerTlsContext(options.certificateFile, options.privateKeyFile, protocols, listenerOptions, {
        verifyClient: options.verifyClient === true,
        rejectUnauthorized: options.rejectUnauthorized,
        ca: options.ca,
        groups: listenerOptions.tlsGroups
      });
      if (options.sni !== undefined) {
        for (const [servername, sni] of Object.entries(options.sni)) {
          sniContexts.set(servername, createServerTlsContext(sni.certificateFile, sni.privateKeyFile, sni.alpnProtocols?.slice() ?? protocols, listenerOptions, {
            verifyClient: sni.verifyClient ?? options.verifyClient,
            rejectUnauthorized: sni.rejectUnauthorized ?? options.rejectUnauthorized,
            ca: sni.ca ?? options.ca,
            groups: sni.tlsGroups ?? listenerOptions.tlsGroups
          }));
        }
        setSNIContexts(ctx, sniContexts);
      }
    } catch (error) {
      if (ctx !== null) freeContext(ctx);
      for (const sniContext of sniContexts.values()) freeContext(sniContext);
      for (const candidate of transports) {
        this._unregisterTransport(candidate);
        candidate.close();
      }
      throw error;
    }
    const listener = new QuicListener(this, bound, protocols, transports, ctx, listenerOptions, sniContexts);
    this.#listeners.push(listener);
    listener._start();
    publishQuicTopic('quic.endpoint.listen', {
      endpoint: this,
      listener,
      address: bound,
      options: listenerOptions
    });
    return listener;
  }
  async connect(options: QuicConnectOptions): Promise<QuicConnection> {
    if (this.#closed) throw new Error('QUIC endpoint is closed');
    requireQuic();
    initCrypto();
    ensureCallbackTable();
    const remoteAddress = normalizeAddress(options.address);
    const resolvedOptions = resolveQuicOptions(options, this.#options);
    const bindAddress = this.#clientBindAddress ?? (remoteAddress.family === 'ipv6' ? {
      family: 'ipv6',
      ip: '::',
      port: 0
    } : {
      family: 'ipv4',
      ip: '0.0.0.0',
      port: 0
    });
    const transport = await this._bindTransport(bindAddress, { ecn: resolvedOptions.transport.ecn });
    const local = transport.address;
    const clientProtocols = options.alpnProtocols?.slice() ?? this.alpnProtocols;
    const ctx = newClientContext(options.verifyPeer === true, resolvedOptions.tlsCipherSuites, resolvedOptions.keylog === false ? undefined : (line) => appendKeylogLine(resolvedOptions.keylog, line), {
      certificateFile: options.certificateFile,
      privateKeyFile: options.privateKeyFile,
      ca: options.ca,
      groups: resolvedOptions.tlsGroups
    });
    const serverName = options.serverName ?? 'localhost';
    const earlyDataMax = resolvedOptions.earlyData === false ? 0 : resolvedOptions.earlyData.maxBytes ?? 4294967295;
    const tls = newClientSession(ctx, clientProtocols, serverName, options.verifyPeer === true, earlyDataMax);
    const sessionKey = sessionStoreKey(serverName, clientProtocols);
    const sessionState = await resolvedOptions.sessionStore?.load(sessionKey);
    let resumedSession = false;
    let sessionEarlyDataMax = 0;
    let rememberedTransportParameters: Uint8Array | undefined;
    let rememberedVersion = 0;
    let attemptedEarlyData = false;
    let earlyDataRejectReason: string | null = null;
    let addressToken = this._loadAddressToken(sessionKey);
    if (sessionState !== undefined && sessionState !== null) {
      if (sessionState.expiresAt !== undefined && sessionState.expiresAt <= Date.now()) {
        if (resolvedOptions.earlyData !== false && sessionState.ticket !== undefined) {
          attemptedEarlyData = true;
          earlyDataRejectReason = 'expired-session';
        }
        await resolvedOptions.sessionStore?.delete(sessionKey);
      } else {
        if (sessionState.version !== undefined && resolvedOptions.versions.includes(sessionState.version)) {
          rememberedVersion = versionToWire(sessionState.version);
        }
        if (sessionState.ticket !== undefined && resolvedOptions.earlyData !== false) {
          attemptedEarlyData = true;
          const storedEarlyDataMax = resolvedOptions.earlyData === false ? 0 : sessionState.earlyDataMax ?? resolvedOptions.earlyData.maxBytes ?? 4294967295;
          if (sessionState.version !== undefined && !resolvedOptions.versions.includes(sessionState.version)) {
            earlyDataRejectReason = 'version';
          } else {
            try {
              const importedSession = importSession(tls, sessionState.ticket, storedEarlyDataMax);
              resumedSession = importedSession.resumed;
              sessionEarlyDataMax = importedSession.maxEarlyData;
              if (!resumedSession) earlyDataRejectReason = 'invalid-session';
            } catch {
              earlyDataRejectReason = 'invalid-session';
            }
          }
        }
        rememberedTransportParameters = sessionState.transportParameters;
        addressToken = sessionState.addressToken ?? addressToken;
      }
    }
    const connection = new QuicConnection('client', this, null, local, remoteAddress, clientProtocols, transport, ctx, tls, null, resolvedOptions, serverName);
    connection._setSessionStoreKey(sessionKey);
    connection._setClientSessionOptions(options.verifyPeer === true, earlyDataMax);
    if (addressToken !== null && addressToken.byteLength > 0) {
      connection._setAddressValidationToken(addressToken, NGTCP2_TOKEN_TYPE_NEW_TOKEN);
    }
    connection._initClient(rememberedVersion);
    const earlyTransportParametersAccepted = resolvedOptions.earlyData !== false && resumedSession && sessionEarlyDataMax > 0 && rememberedTransportParameters !== undefined && connection._setEarlyTransportParameters(rememberedTransportParameters);
    const earlyDataReady = earlyTransportParametersAccepted;
    if (attemptedEarlyData && !earlyDataReady && earlyDataRejectReason === null) {
      earlyDataRejectReason = rememberedTransportParameters === undefined || !earlyTransportParametersAccepted ? 'transport-parameters' : 'invalid-session';
    }
    connection._setEarlyDataDiagnostics(attemptedEarlyData, earlyDataReady);
    connection._setEarlyDataReady(earlyDataReady, Math.min(earlyDataMax, sessionEarlyDataMax));
    if (earlyDataReady) connection._deferHandshakeForEarlyData();
    this._track(connection);
    connection._startSocketLoop();
    publishQuicTopic('quic.endpoint.connect', {
      endpoint: this,
      connection,
      address: remoteAddress,
      options: resolvedOptions
    });
    if (!earlyDataReady) connection._driveWrites();
    if (earlyDataReady) {
      connection._scheduleEarlyDataEvent(true, 'accepted');
      connection._waitHandshake().then(() => {
        if (!clientProtocols.includes(connection.alpnProtocol)) {
          connection.close();
          this.#dispatch(new QuicErrorEvent('error', { error: new Error(`QUIC ALPN mismatch: client offered ${clientProtocols.join(', ') || '(none)'}`) }));
        }
      }, () => {});
      return connection;
    }
    await connection._waitHandshake();
    if (earlyDataRejectReason !== null) {
      const reason = earlyDataRejectReason;
      this.#runtime.setTimer(0, () => connection._scheduleEarlyDataEvent(false, reason));
    }
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
    publishQuicTopic('quic.endpoint.closing', {
      endpoint: this,
      stats: this.stats
    });
    this.#closed = true;
    this.#destroyedAt = Date.now();
    this.#clearRouteCleanupTimers();
    for (const listener of this.#listeners.slice()) await listener.close();
    for (const connection of Array.from(this.#connections)) connection.destroy(new Error('QUIC endpoint is closed'));
    await Promise.allSettled(Array.from(this.#connections, (connection) => connection.closed));
    this.cidTable.clear();
    this.#rejectedInitialCids.clear();
    this.#statelessResetTokens.clear();
    this.#addressValidation.clear();
    for (const transport of this.#transports.values()) transport.close();
    this.#transports.clear();
    this.#acceptQueue.close(new Error('QUIC endpoint is closed'));
    publishQuicTopic('quic.endpoint.closed', {
      endpoint: this,
      stats: this.stats
    });
    this.#dispatch(new Event('close'));
  }
  async closeGracefully(options: QuicCloseOptions = {}): Promise<void> {
    if (this.#closed) return;
    publishQuicTopic('quic.endpoint.closing', {
      endpoint: this,
      stats: this.stats,
      graceful: true
    });
    this.#closed = true;
    this.#destroyedAt = Date.now();
    this.#clearRouteCleanupTimers();
    for (const listener of this.#listeners.slice()) await listener.close();
    await Promise.allSettled(Array.from(this.#connections, (connection) => connection.close(options)));
    this.cidTable.clear();
    this.#rejectedInitialCids.clear();
    this.#statelessResetTokens.clear();
    this.#addressValidation.clear();
    for (const transport of this.#transports.values()) transport.close();
    this.#transports.clear();
    this.#acceptQueue.close(new Error('QUIC endpoint is closed'));
    publishQuicTopic('quic.endpoint.closed', {
      endpoint: this,
      stats: this.stats,
      graceful: true
    });
    this.#dispatch(new Event('close'));
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  _track(connection: QuicConnection): void {
    this.#connections.add(connection);
    if (connection._roleForStats() === 'server') this.#stats.serverConnections++;
    else this.#stats.clientConnections++;
    publishQuicTopic(connection._roleForStats() === 'server' ? 'quic.session.created.server' : 'quic.session.created.client', {
      endpoint: this,
      connection,
      address: connection.remoteAddress
    });
    for (const cid of connection.routeCids) this.cidTable.add(cid, connection);
    connection.addEventListener('error', (event: any) => {
      const error = event.error instanceof Error ? event.error : new Error(String(event.error));
      publishQuicTopic('quic.endpoint.error', {
        endpoint: this,
        error,
        connection
      });
      this.#dispatch(new QuicErrorEvent('error', { error: event.error instanceof Error ? event.error : new Error(String(event.error)) }));
    });
    connection.addEventListener('close', () => {
      const routeCids = connection.routeCids.slice();
      let timer: QuicTimerHandle | null = null;
      const untrack = () => {
        if (timer !== null) {
          this.#routeCleanupTimers.delete(timer);
          timer = null;
        }
        this.#connections.delete(connection);
        for (const cid of routeCids) {
          if (this.cidTable.get(cid) === connection) this.cidTable.delete(cid);
        }
      };
      if (this.#closed) {
        untrack();
      } else {
        timer = this.#runtime.setTimer(connection._drainingRetentionMsForRouting(), untrack);
        this.#routeCleanupTimers.add(timer);
      }
    }, { once: true });
  }
  #clearRouteCleanupTimers(): void {
    for (const timer of this.#routeCleanupTimers) timer.cancel();
    this.#routeCleanupTimers.clear();
  }
  _forgetConnectionRoutes(connection: QuicConnection): void {
    this.#connections.delete(connection);
    for (const cid of connection.routeCids.splice(0)) {
      if (this.cidTable.get(cid) === connection) this.cidTable.delete(cid);
    }
  }
  _accept(connection: QuicConnection): void {
    if (inNativeCallback()) {
      this.#dispatch(new QuicConnectionEvent('connection', { connection }));
      this.#acceptQueue.push(connection);
      return;
    }
    this.#acceptQueue.push(connection);
    this.#dispatch(new QuicConnectionEvent('connection', { connection }));
  }
  _removeListener(listener: QuicListener): void {
    this.#listeners = this.#listeners.filter((candidate) => candidate !== listener);
  }
  _registerStatelessResetToken(token: string, connection: QuicConnection): void {
    this.#statelessResetTokens.set(token, connection);
  }
  _unregisterStatelessResetToken(token: string, connection: QuicConnection): void {
    if (this.#statelessResetTokens.get(token) === connection) this.#statelessResetTokens.delete(token);
  }
  _storeAddressToken(key: string, token: Uint8Array): void {
    this.#addressTokens.set(key, token.slice());
  }
  _loadAddressToken(key: string): Uint8Array | null {
    return this.#addressTokens.get(key)?.slice() ?? null;
  }
  #activeServerConnectionCount(listener?: QuicListener, remoteAddress?: QuicAddress, excluding?: QuicConnection): number {
    let count = 0;
    for (const connection of this.#connections) {
      if (connection === excluding) continue;
      if (connection._matchesServerConnection(listener, remoteAddress)) count++;
    }
    return count;
  }
  #sourceAddressMatches(filter: Set<string>, address: QuicAddress): boolean {
    return filter.has(address.ip) || filter.has(addressKey(address)) || filter.has(`${address.family}:${address.ip}`) || filter.has(`${address.ip}:${address.port}`);
  }
  #allowsSource(listener: QuicListener, remoteAddress: QuicAddress): boolean {
    const filter = listener.options.transport.sourceAddress;
    if (filter.deny.size > 0 && this.#sourceAddressMatches(filter.deny, remoteAddress)) return false;
    if (filter.allow !== null && !this.#sourceAddressMatches(filter.allow, remoteAddress)) return false;
    return true;
  }
  #blockPacket(kind: 'source' | 'busy' | 'connection-limit'): void {
    if (kind === 'source') {
      this.#stats.packetsBlocked++;
      this.#stats.sourceBlockedPackets++;
    } else if (kind === 'busy') this.#stats.serverBusyCount++;
    else this.#stats.connectionLimitPackets++;
  }
  #canCreateServerConnection(listener: QuicListener, remoteAddress: QuicAddress, replacing?: QuicConnection): boolean {
    const transport = listener.options.transport;
    if (this.#options.transport.busy || transport.busy) {
      this.#blockPacket('busy');
      return false;
    }
    if (transport.maxConnections > 0 && this.#activeServerConnectionCount(undefined, undefined, replacing) >= transport.maxConnections) {
      this.#blockPacket('connection-limit');
      return false;
    }
    if (transport.maxConnectionsPerRemoteAddress > 0 && this.#activeServerConnectionCount(undefined, remoteAddress, replacing) >= transport.maxConnectionsPerRemoteAddress) {
      this.#blockPacket('connection-limit');
      return false;
    }
    return true;
  }
  #connectingServerConnection(listener: QuicListener, remoteAddress: QuicAddress): QuicConnection | null {
    let match: QuicConnection | null = null;
    for (const connection of this.#connections) {
      if (connection.state !== 'connecting' || !connection._matchesServerConnection(listener, remoteAddress) || connection.remoteAddress.port !== remoteAddress.port) continue;
      if (match !== null) return null;
      match = connection;
    }
    return match;
  }
  #rememberRejectedInitialCid(key: string): void {
    if (key.length === 0) return;
    if (this.#rejectedInitialCids.has(key)) this.#rejectedInitialCids.delete(key);
    this.#rejectedInitialCids.add(key);
    while (this.#rejectedInitialCids.size > MAX_REJECTED_INITIAL_CIDS) {
      const oldest = this.#rejectedInitialCids.values().next().value;
      if (oldest === undefined) break;
      this.#rejectedInitialCids.delete(oldest);
    }
  }
  _handleDatagram(listener: QuicListener | null, transportOrFd: QuicDatagramTransport | number, localAddress: QuicAddress, packet: Uint8Array, remoteAddress: QuicAddress, packetEcn?: number, pathMetadata?: QuicDatagramPathMetadata): void {
    const transport = this.#coerceTransport(transportOrFd, localAddress);
    if (listener !== null && !this.#allowsSource(listener, remoteAddress)) {
      this.#blockPacket('source');
      return;
    }
    if (packet.byteLength === 0) return;
    if (listener !== null && packet.byteLength < 1200 && (packet[0] & 192) === 192 && (packet[0] & 48) === 0) {
      return;
    }
    if (listener !== null) {
      const parsedInitial = parseInitialTokenHeader(packet);
      if (parsedInitial !== null && parsedInitial.token.byteLength > 0 && !isRetryToken(parsedInitial.token)) {
        const parsedHd = packetHeaderFromParsedInitial(parsedInitial);
        const addressInfo = this.#addressValidation.peek(remoteAddress);
        const remoteAddressValidated = addressInfo?.validated === true;
        const retry = this.#validateRetryToken(listener, remoteAddress, parsedHd);
        const addressTokenAccepted = verifyRegularToken(listener.retryTokenSecret, remoteAddress, parsedInitial.token, this.#runtime, listener.options.transport.addressTokenTimeout);
        if (!remoteAddressValidated && retry === null && !addressTokenAccepted && listener.options.retry.enabled) {
          if (!this.#canCreateServerConnection(listener, remoteAddress)) {
            this.#writeImmediateConnectionCloseFromInitial(transport, remoteAddress, packet);
            this.#recordProcessedPacket();
            return;
          }
          if (parsedInitial.token.byteLength > 0) this.#stats.addressTokenRejected++;
          this.#writeRetryFromParts(listener, transport, remoteAddress, parsedInitial.version, parsedInitial.scid, parsedInitial.dcid, packet.byteLength);
          this.#recordProcessedPacket();
          return;
        }
      }
    }
    const decoded = new ArrayBuffer(NGTCP2_VERSION_CID_SIZE);
    const rc = ngtcp2Sym!.ngtcp2_pkt_decode_version_cid(Pointer.of(decoded), packet, packet.byteLength, NGTCP2_MAX_CIDLEN) as number;
    if (rc !== 0 && rc !== NGTCP2_ERR_VERSION_NEGOTIATION) {
      this.#handleStatelessReset(packet);
      return;
    }
    const dcidPtr = ptrField(decoded, VERSION_CID_DCID);
    const dcidLen = Number(readU64(decoded, VERSION_CID_DCIDLEN));
    const dcid = copyFromPtr(dcidPtr, dcidLen);
    const initialKey = cidKey(dcid);
    if (this.#rejectedInitialCids.has(initialKey)) return;
    const existing = this.cidTable.get(initialKey);
    if (existing) {
      const routedVersion = readU32(decoded, VERSION_CID_VERSION);
      if (listener !== null && routedVersion !== 0 && (packet[0] & 64) !== 0 && existing.state === 'connecting' && existing._roleForStats() === 'server' && existing._matchesServerConnection(listener, remoteAddress) && existing._wireVersionForRouting() !== routedVersion && ngtcp2Sym!.ngtcp2_is_supported_version(routedVersion) !== 0) {
        if (!this.#canCreateServerConnection(listener, remoteAddress, existing)) {
          this.#writeImmediateConnectionCloseFromInitial(transport, remoteAddress, packet);
          this.#recordProcessedPacket();
          return;
        }
        this.#forgetSupersededValidationStats(existing);
        existing._closeForCompatibleVersionUpgrade();
        this.#acceptInitial(listener, transport, localAddress, remoteAddress, packet, decoded, packetEcn, pathMetadata);
        return;
      }
      existing._receivePacket(packet, remoteAddress, localAddress, transport, packetEcn, pathMetadata);
      return;
    }
    if ((packet[0] & 128) === 0 && this.#handleStatelessReset(packet)) return;
    if (listener === null) {
      this.#handleStatelessReset(packet);
      return;
    }
    const version = readU32(decoded, VERSION_CID_VERSION);
    if (version === 0) {
      if ((packet[0] & 128) === 0) {
        this.#writeStatelessReset(listener, transport, remoteAddress, dcid, packet.byteLength);
      }
      return;
    }
    if (version !== 0 && ngtcp2Sym!.ngtcp2_is_supported_version(version) === 0) {
      this.#writeVersionNegotiation(listener, transport, remoteAddress, decoded);
      this.#recordProcessedPacket();
      return;
    }
    if ((packet[0] & 64) === 0) return;
    const connecting = this.#connectingServerConnection(listener, remoteAddress);
    if (connecting !== null && connecting._wireVersionForRouting() === version) {
      connecting._receivePacket(packet, remoteAddress, localAddress, transport, packetEcn, pathMetadata);
      return;
    }
    const replacement = connecting !== null && connecting._wireVersionForRouting() !== version ? connecting : null;
    if (!this.#canCreateServerConnection(listener, remoteAddress, replacement ?? undefined)) {
      this.#writeImmediateConnectionCloseFromInitial(transport, remoteAddress, packet);
      this.#recordProcessedPacket();
      return;
    }
    if (replacement !== null) this.#forgetSupersededValidationStats(replacement);
    replacement?._closeForCompatibleVersionUpgrade();
    this.#acceptInitial(listener, transport, localAddress, remoteAddress, packet, decoded, packetEcn, pathMetadata);
  }
  #forgetSupersededValidationStats(connection: QuicConnection): void {
    const tokenType = connection._validationTokenTypeForRouting();
    if (tokenType === NGTCP2_TOKEN_TYPE_RETRY) {
      this.#stats.retryTokenAccepted = Math.max(0, this.#stats.retryTokenAccepted - 1);
    } else if (tokenType === NGTCP2_TOKEN_TYPE_NEW_TOKEN) {
      this.#stats.addressTokenAccepted = Math.max(0, this.#stats.addressTokenAccepted - 1);
    }
  }
  #handleStatelessReset(packet: Uint8Array): boolean {
    if (packet.byteLength < 17 || (packet[0] & 128) !== 0) return false;
    const token = cidKey(packet.subarray(packet.byteLength - 16));
    const connection = this.#statelessResetTokens.get(token);
    if (connection === undefined) return false;
    connection._onStatelessReset();
    return true;
  }
  #writeStatelessReset(listener: QuicListener, transport: QuicDatagramTransport, remoteAddress: QuicAddress, dcid: Uint8Array, sourcePacketLength: number): void {
    if (listener.options.transport.disableStatelessReset) return;
    const packetLength = sourcePacketLength - 1;
    if (packetLength < NGTCP2_MIN_STATELESS_RESET_PACKETLEN) return;
    if (dcid.byteLength === 0 || dcid.byteLength > NGTCP2_MAX_CIDLEN) return;
    if (!this.#statelessResetBucket.consume()) {
      this.#stats.statelessResetRateLimited++;
      return;
    }
    const token = generateStatelessResetToken(listener.resetTokenSecret, makeCid(dcid));
    const random = randomBytes(STATELESS_RESET_RANDLEN);
    const out = new Uint8Array(packetLength);
    const n = ngtcp2PktWriteStatelessReset(out, packetLength, token, random, random.byteLength);
    if (n < NGTCP2_MIN_STATELESS_RESET_PACKETLEN) return;
    const sent = transport.sendNow(out.slice(0, n), remoteAddress);
    if (sent < 0 && sent !== EAGAIN) {
      this.#dispatch(new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }));
    } else {
      this._recordDatagramSent(n);
      this.#stats.statelessResetSent++;
    }
  }
  #writeImmediateConnectionCloseFromInitial(transport: QuicDatagramTransport, remoteAddress: QuicAddress, packet: Uint8Array): void {
    const parsed = parseInitialTokenHeader(packet);
    if (parsed === null) return;
    if (!this.#immediateCloseBucket.consume()) {
      this.#stats.immediateCloseRateLimited++;
      return;
    }
    const out = new Uint8Array(NGTCP2_MAX_UDP_PAYLOAD_SIZE);
    const reason = new Uint8Array(0);
    const n = Number(cryptoSym!.ngtcp2_crypto_write_connection_close(out, out.byteLength, parsed.version, Pointer.of(parsed.scid), Pointer.of(parsed.dcid), BigInt(NGTCP2_CONNECTION_REFUSED), reason, reason.byteLength));
    if (n <= 0) return;
    const sent = transport.sendNow(out.slice(0, n), remoteAddress);
    if (sent < 0 && sent !== EAGAIN) {
      this.#dispatch(new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }));
    } else {
      this._recordDatagramSent(n);
      this.#stats.immediateCloseSent++;
    }
  }
  #writeVersionNegotiation(listener: QuicListener, transport: QuicDatagramTransport, remoteAddress: QuicAddress, decoded: ArrayBuffer): void {
    if (!this.#versionNegotiationBucket.consume()) {
      this.#stats.versionNegotiationRateLimited++;
      return;
    }
    const clientDcid = copyFromPtr(ptrField(decoded, VERSION_CID_DCID), Number(readU64(decoded, VERSION_CID_DCIDLEN)));
    const clientScid = copyFromPtr(ptrField(decoded, VERSION_CID_SCID), Number(readU64(decoded, VERSION_CID_SCIDLEN)));
    const supported = listener.options.versions.map(versionToWire).filter((version) => ngtcp2Sym!.ngtcp2_is_supported_version(version) !== 0);
    if (supported.length === 0) return;
    const advertised = [VERSION_NEGOTIATION_GREASE, ...supported];
    const versions = new ArrayBuffer(advertised.length * 4);
    for (let i = 0; i < advertised.length; i++) writeU32(versions, i * 4, advertised[i]);
    const out = new Uint8Array(NGTCP2_MAX_UDP_PAYLOAD_SIZE);
    const n = Number(ngtcp2Sym!.ngtcp2_pkt_write_version_negotiation(out, out.byteLength, randomBytes(1)[0], clientScid, clientScid.byteLength, clientDcid, clientDcid.byteLength, versions, advertised.length));
    if (n <= 0) return;
    const sent = transport.sendNow(out.slice(0, n), remoteAddress);
    if (sent < 0 && sent !== EAGAIN) {
      this.#dispatch(new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }));
    } else {
      this._recordDatagramSent(n);
      this.#stats.versionNegotiationSent++;
    }
  }
  #writeRetry(listener: QuicListener, transport: QuicDatagramTransport, remoteAddress: QuicAddress, hd: ArrayBuffer, maxPacketLength: number): void {
    const clientScid = cidFromPacketHeader(hd, PKT_HD_SCID);
    const originalDcid = cidFromPacketHeader(hd, PKT_HD_DCID);
    this.#writeRetryFromParts(listener, transport, remoteAddress, readU32(hd, PKT_HD_VERSION), clientScid, originalDcid, maxPacketLength);
  }
  #writeRetryFromParts(listener: QuicListener, transport: QuicDatagramTransport, remoteAddress: QuicAddress, version: number, clientScid: ArrayBuffer, originalDcid: ArrayBuffer, maxPacketLength: number): void {
    if (!this.#retryBucket.consume()) {
      this.#stats.retryRateLimited++;
      return;
    }
    const retryScid = randomCid(listener.options.connection.cidLength);
    const remote = encodeAddr(remoteAddress);
    const token = new Uint8Array(NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2);
    const tokenLen = Number(cryptoSym!.ngtcp2_crypto_generate_retry_token2(token, listener.retryTokenSecret, listener.retryTokenSecret.byteLength, version, Pointer.of(remote.buf), remote.len, Pointer.of(retryScid), Pointer.of(originalDcid), now(this.#runtime)));
    if (tokenLen <= 0) return;
    const out = new Uint8Array(Math.min(NGTCP2_MAX_UDP_PAYLOAD_SIZE, Math.max(NGTCP2_MAX_UDP_PAYLOAD_SIZE, maxPacketLength * 3)));
    const n = Number(cryptoSym!.ngtcp2_crypto_write_retry(out, out.byteLength, version, Pointer.of(clientScid), Pointer.of(retryScid), Pointer.of(originalDcid), token.subarray(0, tokenLen), tokenLen));
    if (n <= 0) return;
    const sent = transport.sendNow(out.slice(0, n), remoteAddress);
    if (sent < 0 && sent !== EAGAIN) {
      this.#dispatch(new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }));
    } else {
      this._recordDatagramSent(n);
      this.#stats.retrySent++;
    }
  }
  #validateRetryToken(listener: QuicListener, remoteAddress: QuicAddress, hd: ArrayBuffer): {
    originalDcid: ArrayBuffer;
    retryScid: ArrayBuffer;
    token: Uint8Array;
    tokenType: number;
  } | null {
    const tokenLen = Number(readU64(hd, PKT_HD_TOKENLEN));
    if (tokenLen === 0) return null;
    const token = copyFromPtr(ptrField(hd, PKT_HD_TOKEN), tokenLen);
    if (token[0] !== NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2) return null;
    const originalDcid = new ArrayBuffer(NGTCP2_CID_SIZE);
    const retryScid = cidFromPacketHeader(hd, PKT_HD_DCID);
    const remote = encodeAddr(remoteAddress);
    const rc = cryptoSym!.ngtcp2_crypto_verify_retry_token2(Pointer.of(originalDcid), token, token.byteLength, listener.retryTokenSecret, listener.retryTokenSecret.byteLength, readU32(hd, PKT_HD_VERSION), Pointer.of(remote.buf), remote.len, Pointer.of(retryScid), listener.options.transport.retryTokenTimeout, now(this.#runtime)) as number;
    if (rc !== 0) {
      this.#stats.retryTokenRejected++;
      return null;
    }
    return {
      originalDcid,
      retryScid,
      token,
      tokenType: NGTCP2_TOKEN_TYPE_RETRY
    };
  }
  #validateAddressToken(listener: QuicListener, remoteAddress: QuicAddress, hd: ArrayBuffer): {
    token: Uint8Array;
    tokenType: number;
  } | null {
    const tokenLen = Number(readU64(hd, PKT_HD_TOKENLEN));
    if (tokenLen === 0) return null;
    const token = copyFromPtr(ptrField(hd, PKT_HD_TOKEN), tokenLen);
    if (!verifyRegularToken(listener.retryTokenSecret, remoteAddress, token, this.#runtime, listener.options.transport.addressTokenTimeout)) {
      this.#stats.addressTokenRejected++;
      return null;
    }
    return {
      token,
      tokenType: NGTCP2_TOKEN_TYPE_NEW_TOKEN
    };
  }
  #acceptInitial(listener: QuicListener, transport: QuicDatagramTransport, localAddress: QuicAddress, remoteAddress: QuicAddress, packet: Uint8Array, decoded: ArrayBuffer, packetEcn?: number, pathMetadata?: QuicDatagramPathMetadata): void {
    const parsedInitial = parseInitialTokenHeader(packet);
    if (parsedInitial !== null && parsedInitial.token.byteLength > 0 && !isRetryToken(parsedInitial.token)) {
      const parsedHd = packetHeaderFromParsedInitial(parsedInitial);
      const addressInfo = this.#addressValidation.peek(remoteAddress);
      const remoteAddressValidated = addressInfo?.validated === true;
      const retry = parsedInitial.token.byteLength <= 64 ? null : this.#validateRetryToken(listener, remoteAddress, parsedHd);
      const addressTokenAccepted = verifyRegularToken(listener.retryTokenSecret, remoteAddress, parsedInitial.token, this.#runtime, listener.options.transport.addressTokenTimeout);
      if (!remoteAddressValidated && retry === null && !addressTokenAccepted && listener.options.retry.enabled) {
        this.#stats.addressTokenRejected++;
        this.#writeRetryFromParts(listener, transport, remoteAddress, parsedInitial.version, parsedInitial.scid, parsedInitial.dcid, packet.byteLength);
        this.#recordProcessedPacket();
        return;
      }
    }
    const hd = new ArrayBuffer(NGTCP2_PKT_HD_SIZE);
    const decodedLen = Number(ngtcp2Sym!.ngtcp2_pkt_decode_hd_long(Pointer.of(hd), packet, packet.byteLength));
    if (decodedLen > 0 && Number(readU64(hd, PKT_HD_TOKENLEN)) > 0) {
      const addressInfo = this.#addressValidation.peek(remoteAddress);
      const remoteAddressValidated = addressInfo?.validated === true;
      const retry = this.#validateRetryToken(listener, remoteAddress, hd);
      if (retry === null && isRetryToken(copyFromPtr(ptrField(hd, PKT_HD_TOKEN), Number(readU64(hd, PKT_HD_TOKENLEN))))) {
        this.#writeImmediateConnectionCloseFromInitial(transport, remoteAddress, packet);
        this.#recordProcessedPacket();
        return;
      }
      const addressToken = retry === null ? this.#validateAddressToken(listener, remoteAddress, hd) : null;
      if (!remoteAddressValidated && retry === null && addressToken === null && listener.options.retry.enabled) {
        this.#writeRetry(listener, transport, remoteAddress, hd, packet.byteLength);
        this.#recordProcessedPacket();
        return;
      }
    }
    const acceptRc = ngtcp2Sym!.ngtcp2_accept(Pointer.of(hd), packet, packet.byteLength) as number;
    if (acceptRc !== 0) {
      if (decodedLen > 0 && listener.options.retry.enabled && Number(readU64(hd, PKT_HD_TOKENLEN)) > 0) {
        this.#writeRetry(listener, transport, remoteAddress, hd, packet.byteLength);
        this.#recordProcessedPacket();
      }
      return;
    }
    const clientScid = cidFromPacketHeader(hd, PKT_HD_SCID);
    const tokenLen = Number(readU64(hd, PKT_HD_TOKENLEN));
    const addressInfo = this.#addressValidation.peek(remoteAddress);
    const remoteAddressValidated = addressInfo?.validated === true;
    const retry = this.#validateRetryToken(listener, remoteAddress, hd);
    if (retry === null && tokenLen > 0 && isRetryToken(copyFromPtr(ptrField(hd, PKT_HD_TOKEN), tokenLen))) {
      this.#writeImmediateConnectionCloseFromInitial(transport, remoteAddress, packet);
      this.#recordProcessedPacket();
      return;
    }
    const addressToken = retry === null ? this.#validateAddressToken(listener, remoteAddress, hd) : null;
    if (retry !== null || addressToken !== null) {
      this.#addressValidation.markValidated(remoteAddress);
      if (retry !== null) this.#stats.retryTokenAccepted++;
      else this.#stats.addressTokenAccepted++;
    }
    if (!remoteAddressValidated && retry === null && addressToken === null) {
      if (listener.options.retry.enabled) {
        this.#writeRetry(listener, transport, remoteAddress, hd, packet.byteLength);
        this.#recordProcessedPacket();
        return;
      }
      if (tokenLen > 0) return;
    }
    const sessionInfo = this.#addressValidation.upsert(remoteAddress);
    if (!sessionInfo.sessionCreationBucket.consume()) {
      this.#stats.sessionCreationRateLimited++;
      return;
    }
    const originalDcid = retry?.originalDcid ?? cidFromPacketHeader(hd, PKT_HD_DCID);
    const serverScid = randomCid(listener.options.connection.cidLength);
    const version = readU32(hd, PKT_HD_VERSION) || selectWireVersion(listener.options.versions);
    const earlyDataMax = listener.options.earlyData === false ? 0 : 4294967295;
    const tls = newServerSession(listener._ctx, listener.alpnProtocols, earlyDataMax);
    const connection = new QuicConnection('server', this, listener, localAddress, remoteAddress, listener.alpnProtocols, transport, null, tls, originalDcid, listener.options);
    connection._initServer(clientScid, serverScid, version, retry?.retryScid ?? null, retry?.token ?? addressToken?.token ?? null, retry?.tokenType ?? addressToken?.tokenType ?? NGTCP2_TOKEN_TYPE_UNKNOWN);
    this._track(connection);
    const rc = connection._receivePacket(packet, remoteAddress, localAddress, transport, packetEcn, pathMetadata);
    if (rc === NGTCP2_ERR_RETRY) {
      this.#writeRetry(listener, transport, remoteAddress, hd, packet.byteLength);
    }
    if (connection._isClosedForInternalUse() && rc !== NGTCP2_ERR_RETRY) {
      this.#rememberRejectedInitialCid(cidKey(cidBytes(originalDcid)));
    }
  }
}
export class QuicListener {
  readonly endpoint: QuicEndpoint;
  readonly address: QuicAddress;
  readonly alpnProtocols: string[];
  readonly options: ResolvedQuicOptions;
  #closed = false;
  #transports: QuicDatagramTransport[];
  #retryTokenSecret: Uint8Array;
  #sniContexts: Map<string, QuicTlsContext>;
  _ctx: QuicTlsContext;
  constructor(endpoint: QuicEndpoint, address: QuicAddress, alpnProtocols: string[], transports: QuicDatagramTransport[], ctx: QuicTlsContext, options: ResolvedQuicOptions, sniContexts: Map<string, QuicTlsContext> = new Map()) {
    this.endpoint = endpoint;
    this.address = address;
    this.alpnProtocols = alpnProtocols;
    this.options = options;
    this.#transports = transports.slice();
    this.#sniContexts = new Map(sniContexts);
    this._ctx = ctx;
    this.#retryTokenSecret = options.retry.enabled && options.retry.tokenSecret !== undefined ? options.retry.tokenSecret.slice() : randomBytes(32);
  }
  get closed(): boolean {
    return this.#closed;
  }
  get retryTokenSecret(): Uint8Array {
    return this.#retryTokenSecret;
  }
  get resetTokenSecret(): Uint8Array {
    return this.#retryTokenSecret;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.endpoint._removeListener(this);
    freeContext(this._ctx);
    for (const ctx of this.#sniContexts.values()) freeContext(ctx);
    this.#sniContexts.clear();
    for (const transport of this.#transports) {
      this.endpoint._unregisterTransport(transport);
      transport.close();
    }
    this.#transports = [];
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  getSNIContexts(): Record<string, QuicSNIContextOptions> {
    const out: Record<string, QuicSNIContextOptions> = {};
    for (const [name] of this.#sniContexts) out[name] = {} as QuicSNIContextOptions;
    return out;
  }
  setSNIContexts(entries: Record<string, QuicSNIContextOptions>): void {
    if (this.#closed) throw new Error('QUIC listener is closed');
    const newContexts = new Map<string, QuicTlsContext>();
    try {
      for (const [servername, sni] of Object.entries(entries)) {
        newContexts.set(servername, createServerTlsContext(sni.certificateFile, sni.privateKeyFile, sni.alpnProtocols?.slice() ?? this.alpnProtocols, this.options, {
          verifyClient: sni.verifyClient,
          rejectUnauthorized: sni.rejectUnauthorized,
          ca: sni.ca,
          groups: sni.tlsGroups ?? this.options.tlsGroups
        }));
      }
      setSNIContexts(this._ctx, newContexts);
    } catch (error) {
      for (const ctx of newContexts.values()) freeContext(ctx);
      throw error;
    }
    for (const ctx of this.#sniContexts.values()) freeContext(ctx);
    this.#sniContexts = newContexts;
  }
  async _start(): Promise<void> {
    await Promise.all(this.#transports.map((transport) => this.#runTransportLoop(transport)));
  }
  async #runTransportLoop(transport: QuicDatagramTransport): Promise<void> {
    while (!this.#closed && !transport.closed) {
      try {
        const batch = transport.recvBatch?.(MAX_BATCH_READ_PACKETS_PER_TURN, NGTCP2_MAX_UDP_PAYLOAD_SIZE);
        if (batch !== undefined) {
          for (const received of batch) {
            this.endpoint._handleDatagram(this, transport, transport.address, received.data, received.addr, received.ecn, received.path);
          }
          if (batch.length >= MAX_BATCH_READ_PACKETS_PER_TURN) {
            await runtimeDelay(this.endpoint._quicRuntime(), 0);
            continue;
          }
        } else {
          let packets = 0;
          for (; packets < MAX_READ_PACKETS_PER_TURN; packets++) {
            const received = transport.recvNow(NGTCP2_MAX_UDP_PAYLOAD_SIZE);
            if (received === null) break;
            this.endpoint._handleDatagram(this, transport, transport.address, received.data, received.addr, received.ecn, received.path);
          }
          if (packets >= MAX_READ_PACKETS_PER_TURN) {
            await runtimeDelay(this.endpoint._quicRuntime(), 0);
            continue;
          }
        }
        await transport.waitReadable();
      } catch (error) {
        if (!this.#closed) {
          this.endpoint.dispatchEvent(new QuicErrorEvent('error', { error: error instanceof Error ? error : new Error(String(error)) }));
          await runtimeDelay(this.endpoint._quicRuntime(), 5);
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
type PendingDatagram = {
  id: bigint;
  data: Uint8Array;
  attempts: number;
  earlyData: boolean;
};
type ClosePacket = {
  fd: number;
  data: Uint8Array;
  remoteAddress: QuicAddress;
};
type PendingSendPacket = {
  fd: number;
  data: Uint8Array;
  remoteAddress: QuicAddress;
  ecn?: number;
};
type OutstandingStreamData = {
  streamId: number;
  start: number;
  end: number;
  data: Uint8Array;
};
type IncomingStreamSegment = {
  offset: number;
  data: Uint8Array;
};
export class QuicConnection extends EventTarget {
  readonly connectionId: string;
  remoteAddress: QuicAddress;
  readonly localAddress: QuicAddress;
  readonly alpnProtocols: string[];
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
  #ptrSlots = Array.from({ length: 8 }, (_, i) => new Uint8Array(this.#ptrArena, i * _PTR_SIZE, _PTR_SIZE));
  #pathCache = new Map<string, NativePath>();
  #streamQueue = new AsyncQueue<QuicStream>('QUIC connection is closed');
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
    bidirectional: [] as QueueResolver<void>[],
    unidirectional: [] as QueueResolver<void>[]
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
  #statelessResetTokens = new Map<string, string>();
  #readingPacketStartedConnecting = false;
  #versionNegotiationRetried = false;
  #versionNegotiationPendingRetry = false;
  #versionNegotiationVersions: number[] = [];
  #deferredConnectionReceiveCredit = 0;
  #deferredMaxStreamsCredit = {
    bidirectional: 0,
    unidirectional: 0
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
    qlogWriteFailed: 0
  };
  constructor(role: 'client' | 'server', endpoint: QuicEndpoint, listener: QuicListener | null, localAddress: QuicAddress, remoteAddress: QuicAddress, alpnProtocols: string[], transport: QuicDatagramTransport, ctx: QuicTlsContext | null, tls: QuicTlsSession, originalDcid: ArrayBuffer | null, options: ResolvedQuicOptions, serverName: string | null = null) {
    super();
    this.#role = role;
    this.#endpoint = endpoint;
    this.#listener = listener;
    this.#runtime = endpoint._quicRuntime();
    this.localAddress = localAddress;
    this.#activeLocalAddress = localAddress;
    this.remoteAddress = remoteAddress;
    this.alpnProtocols = alpnProtocols;
    this.#fd = transport.id;
    this.#ctx = ctx;
    this.#tls = tls;
    this.#requireClientCertificate = role === 'server' && (listener?._ctx.verifyMode ?? 0) !== 0;
    this.#serverName = serverName;
    this.#originalDcid = originalDcid;
    this.#options = options;
    const path = this.#retainPath(localAddress, remoteAddress, transport.id);
    this.#path = path.path;
    // Retain sockaddr buffers referenced by #path for the native connection.
    this.#localSockaddr = path.local;
    this.#remoteSockaddr = path.remote;
    this.connectionId = `${role}-${_nextConnectionId++}`;
    const id = _nextNativeUserDataId++;
    writeU64(this.#userData, 0, BigInt(id));
    _nativeConnections.set(id, this);
  }
  #retainPath(localAddress: QuicAddress, remoteAddress: QuicAddress, fd: number = this.#fd): NativePath {
    const key = `${addressKey(localAddress)}>${addressKey(remoteAddress)}@${fd}`;
    let path = this.#pathCache.get(key);
    if (path === undefined) {
      path = makePath(localAddress, remoteAddress, fd);
      this.#pathCache.set(key, path);
    }
    return path;
  }
  #retainPathFromMetadata(localAddress: QuicAddress, remoteAddress: QuicAddress, fd: number, metadata: QuicDatagramPathMetadata | undefined): NativePath {
    if (metadata === undefined) return this.#retainPath(localAddress, remoteAddress, fd);
    const key = `${addressKey(localAddress)}>${addressKey(remoteAddress)}@${fd}`;
    let path = this.#pathCache.get(key);
    if (path === undefined) {
      path = makePathFromSockaddrs(metadata.localSockaddr, metadata.localSockaddrLen, metadata.remoteSockaddr, metadata.remoteSockaddrLen, fd) ?? makePath(localAddress, remoteAddress, fd);
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
  get nativeHandle(): ArrayBuffer {
    return this.#conn;
  }
  get alpnProtocol(): string {
    return getAlpnSelected(this.#tls);
  }
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
  get state(): QuicConnectionState {
    return this.#state;
  }
  get closing(): boolean {
    return this.#state === 'closing' || this.#gracefulClosing;
  }
  get closed(): Promise<void> {
    return this.#closedPromise;
  }
  get closeInfo(): QuicCloseInfo | null {
    return this.#closeInfo === null ? null : { ...this.#closeInfo };
  }
  get peerCertificate(): Uint8Array | null {
    return this.#peerCertificate === null ? null : this.#peerCertificate.slice();
  }
  get peerVerification(): QuicPeerVerification | null {
    return this.#peerVerification === null ? null : { ...this.#peerVerification };
  }
  exportKeyingMaterial(label: string, context: Uint8Array, length: number): ArrayBuffer {
    if (this.#state !== 'connected') throw new Error('QUIC connection is not connected');
    return exportTlsKeyingMaterial(this.#tls, label, context, length);
  }
  _isClosedForInternalUse(): boolean {
    return this.#closed;
  }
  get localTransportParameters(): QuicTransportParameterSnapshot | null {
    if (ptrAddress(this.#conn) === 0n) return null;
    return this.#withInitialSourceConnectionId(transportParameterSnapshot(ngtcp2Sym!.ngtcp2_conn_get_local_transport_params(this.#conn) as ArrayBuffer | null), this.#localInitialScid);
  }
  get remoteTransportParameters(): QuicTransportParameterSnapshot | null {
    if (ptrAddress(this.#conn) === 0n) return null;
    return this.#withInitialSourceConnectionId(transportParameterSnapshot(ngtcp2Sym!.ngtcp2_conn_get_remote_transport_params(this.#conn) as ArrayBuffer | null), this.#remoteInitialScid);
  }
  #withInitialSourceConnectionId(snapshot: QuicTransportParameterSnapshot | null, cid: ArrayBuffer | null): QuicTransportParameterSnapshot | null {
    if (snapshot === null || snapshot.initialSourceConnectionId !== null || cid === null) return snapshot;
    return Object.freeze({
      ...snapshot,
      initialSourceConnectionId: cidBytes(cid)
    });
  }
  get stats(): QuicConnectionStats {
    this.#refreshNativeDataStats();
    const send = this._inspectSendState();
    return Object.freeze({
      ...this.#stats,
      pendingWriteBytes: send.pendingWriteBytes,
      outstandingStreamBytes: send.outstandingStreamBytes
    });
  }
  #refreshNativeDataStats(): void {
    if (this.#closed || ptrAddress(this.#conn) === 0n) return;
    const info = new ArrayBuffer(NGTCP2_CONN_INFO_SIZE);
    ngtcp2Sym!.ngtcp2_conn_get_conn_info_versioned(this.#conn, NGTCP2_CONN_INFO_VERSION, Pointer.of(info));
    const bytesInFlight = Number(readU64(info, CONN_INFO_BYTES_IN_FLIGHT));
    this.#stats.bytesInFlight = bytesInFlight;
    this.#stats.maxBytesInFlight = Math.max(this.#stats.maxBytesInFlight, bytesInFlight);
    this.#stats.congestionWindow = Number(readU64(info, CONN_INFO_CWND));
    this.#stats.latestRttMs = nsToMs(readU64(info, CONN_INFO_LATEST_RTT));
    this.#stats.minRttMs = nsToMs(readU64(info, CONN_INFO_MIN_RTT));
    this.#stats.rttVarianceMs = nsToMs(readU64(info, CONN_INFO_RTTVAR));
    this.#stats.smoothedRttMs = nsToMs(readU64(info, CONN_INFO_SMOOTHED_RTT));
    this.#stats.slowStartThreshold = Number(readU64(info, CONN_INFO_SSTHRESH));
    this.#stats.packetsSent = Math.max(this.#stats.packetsSent, Number(readU64(info, CONN_INFO_PKT_SENT)));
    this.#stats.bytesSent = Math.max(this.#stats.bytesSent, Number(readU64(info, CONN_INFO_BYTES_SENT)));
    this.#stats.packetsReceived = Math.max(this.#stats.packetsReceived, Number(readU64(info, CONN_INFO_PKT_RECV)));
    this.#stats.bytesReceived = Math.max(this.#stats.bytesReceived, Number(readU64(info, CONN_INFO_BYTES_RECV)));
    this.#stats.packetsLost = Number(readU64(info, CONN_INFO_PKT_LOST));
    this.#stats.bytesLost = Number(readU64(info, CONN_INFO_BYTES_LOST));
    this.#stats.pingReceived = Number(readU64(info, CONN_INFO_PING_RECV));
    this.#stats.packetsDiscarded = Number(readU64(info, CONN_INFO_PKT_DISCARDED));
  }
  _roleForStats(): 'client' | 'server' {
    return this.#role;
  }
  _wireVersionForRouting(): number {
    return this.#wireVersion;
  }
  _validationTokenTypeForRouting(): number {
    return this.#validatedTokenType;
  }
  _drainingRetentionMsForRouting(): number {
    return this.#drainingRetentionMs;
  }
  _matchesServerConnection(listener?: QuicListener, remoteAddress?: QuicAddress): boolean {
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
        const chunk = await this.#datagramQueue.read();
        if (chunk === null) controller.close();
        else controller.enqueue(chunk);
      },
      cancel: () => this.#datagramQueue.close()
    });
    return this.#datagramReadable;
  }
  get datagramReadable(): ReadableStream<Uint8Array> {
    return this.datagrams;
  }
  /**
  * Return the most recent received DATAGRAM event payload for tests.
  *
  * @internal
  */
  _inspectLastDatagramEvent(): {
    data: Uint8Array;
    earlyData: boolean;
  } | null {
    if (this.#lastDatagramEvent === null) return null;
    return {
      data: this.#lastDatagramEvent.data.slice(),
      earlyData: this.#lastDatagramEvent.earlyData
    };
  }
  /**
  * Return native send-queue state for flow-control conformance tests.
  *
  * @internal
  */
  _inspectSendState(): {
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
      outstandingStreamBytes
    };
  }
  /**
  * Send a transport CONNECTION_CLOSE frame to the peer.
  *
  * @internal
  */
  _injectTransportCloseForTest(liberr = NGTCP2_ERR_STREAM_DATA_BLOCKED): void {
    if (this.#closed || this.#state !== 'connected') throw new Error('QUIC connection is not connected');
    this.#writeConnectionClose(liberr, this.remoteAddress);
  }
  acceptStream(): Promise<QuicStream> {
    return this.#streamQueue.shift();
  }
  _isLocalUnidirectionalStream(streamId: number): boolean {
    return this.#streamIsUnidirectional(streamId) && this.#streamInitiatedByLocal(streamId);
  }
  _openBidirectionalStreamSync(): QuicStream {
    if (!this.#canOpenApplicationStream()) throw new Error('QUIC connection is not connected');
    const stream = this.#tryOpenLocalStream('bidirectional');
    if (typeof stream === 'number') throw ngtcp2Error(stream, 'ngtcp2_conn_open_bidi_stream');
    return stream;
  }
  async openBidirectionalStream(): Promise<QuicStream> {
    if (this.#gracefulClosing || this.#gracefullyClosed) throw new Error('QUIC connection is closing');
    if (!this.#canOpenApplicationStream()) throw new Error('QUIC connection is not connected');
    for (;;) {
      const stream = this.#tryOpenLocalStream('bidirectional');
      if (typeof stream !== 'number') {
        return stream;
      }
      if (stream !== NGTCP2_ERR_STREAM_ID_BLOCKED) throw ngtcp2Error(stream, 'ngtcp2_conn_open_bidi_stream');
      await this.#waitForLocalStreamCredit('bidirectional');
    }
  }
  _openUnidirectionalStreamSync(): QuicStream {
    if (this.#gracefulClosing || this.#gracefullyClosed) throw new Error('QUIC connection is closing');
    if (!this.#canOpenApplicationStream()) throw new Error('QUIC connection is not connected');
    const stream = this.#tryOpenLocalStream('unidirectional');
    if (typeof stream === 'number') throw ngtcp2Error(stream, 'ngtcp2_conn_open_uni_stream');
    return stream;
  }
  async openUnidirectionalStream(): Promise<QuicStream> {
    if (this.#gracefulClosing || this.#gracefullyClosed) throw new Error('QUIC connection is closing');
    if (!this.#canOpenApplicationStream()) throw new Error('QUIC connection is not connected');
    for (;;) {
      const stream = this.#tryOpenLocalStream('unidirectional');
      if (typeof stream !== 'number') {
        return stream;
      }
      if (stream !== NGTCP2_ERR_STREAM_ID_BLOCKED) throw ngtcp2Error(stream, 'ngtcp2_conn_open_uni_stream');
      await this.#waitForLocalStreamCredit('unidirectional');
    }
  }
  #tryOpenLocalStream(direction: 'bidirectional' | 'unidirectional'): QuicStream | number {
    const out = new ArrayBuffer(8);
    const rc = direction === 'bidirectional' ? ngtcp2Sym!.ngtcp2_conn_open_bidi_stream(this.#conn, Pointer.of(out), null) as number : ngtcp2Sym!.ngtcp2_conn_open_uni_stream(this.#conn, Pointer.of(out), null) as number;
    if (rc !== 0) return rc;
    const id = Number(readU64(out, 0));
    return this.#ensureStream(id, direction, false);
  }
  #waitForLocalStreamCredit(direction: 'bidirectional' | 'unidirectional'): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('QUIC connection is closed'));
    return new Promise((resolve, reject) => {
      this.#localStreamCreditWaiters[direction].push({
        resolve,
        reject
      });
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
    if (this.#role !== 'client') throw new Error('QUIC active migration is only available on client connections');
    if (this.#state !== 'connected') throw new Error('QUIC connection is not connected');
    if (!this.#options.migration.enabled) throw new Error('QUIC migration is not enabled for this connection');
    await this.#waitHandshakeConfirmed();
    const requested = normalizeAddress(address);
    if (requested.family !== this.remoteAddress.family) {
      throw new TypeError('QUIC migration local address family must match the remote address family');
    }
    const transport = await this.#endpoint._bindTransport(requested, { ecn: this.#options.transport.ecn });
    let adopted = false;
    try {
      const local = transport.address;
      const path = this.#retainPath(local, this.remoteAddress, transport.id);
      const rc = ngtcp2Sym!.ngtcp2_conn_initiate_migration(this.#conn, Pointer.of(path.path), now(this.#runtime)) as number;
      if (rc !== 0) throw ngtcp2Error(rc, 'ngtcp2_conn_initiate_migration');
      this._startSocketLoop(transport, local);
      adopted = true;
      this.#scheduleWriteDrain();
    } catch (error) {
      if (!adopted) {
        this.#endpoint._unregisterTransport(transport);
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
  async sendDatagram(data: QuicDatagramSource, encoding: QuicDatagramEncoding = 'utf8'): Promise<number> {
    if (this.#gracefulClosing || this.#gracefullyClosed) throw new Error('QUIC connection is closing');
    const payload = normalizeDatagramSource(await data, encoding);
    const earlyData = this.#state !== 'connected';
    if (earlyData) {
      if (this.#role !== 'client' || this.#state !== 'connecting' || !this.#earlyDataReady) {
        throw new Error('QUIC connection is not connected');
      }
    }
    if (!this.#options.datagrams.enabled) throw new Error('QUIC DATAGRAM is not enabled for this connection');
    if (payload.byteLength > this.#options.datagrams.maxFrameSize) {
      throw new RangeError(`QUIC DATAGRAM size ${payload.byteLength} exceeds maxFrameSize ${this.#options.datagrams.maxFrameSize}`);
    }
    if (earlyData) this.#reserveEarlyDataBytes(payload.byteLength);
    if (earlyData) this.#startDeferredHandshake();
    const peerMaxPayload = this.#peerMaxDatagramPayload();
    if (peerMaxPayload === 0) {
      throw new Error('peer did not negotiate QUIC DATAGRAM support');
    }
    if (payload.byteLength > peerMaxPayload) {
      throw new RangeError(`QUIC DATAGRAM size ${payload.byteLength} exceeds peer maxDatagramPayload ${peerMaxPayload}`);
    }
    const id = this.#nextDatagramId++;
    if (this.#options.datagrams.maxPending > 0 && this.#pendingDatagrams.length >= this.#options.datagrams.maxPending) {
      if (this.#options.datagrams.dropPolicy === 'drop-oldest') {
        const dropped = this.#pendingDatagrams.shift();
        if (dropped !== undefined) this._onDatagramStatus(Number(dropped.id), 'abandoned');
      } else {
        this._onDatagramStatus(Number(id), 'abandoned');
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
      earlyData
    });
    this.#startDeferredHandshake();
    this.#scheduleWriteDrain();
    return Number(id);
  }
  #writePendingDatagram(outPath: NativePath, out: Uint8Array, ts: bigint, pktInfo: ArrayBuffer | null): number {
    for (;;) {
      const pending = this.#pendingDatagrams[0];
      if (pending === undefined) return 0;
      if (pending.attempts >= this.#options.datagrams.maxSendAttempts) {
        this.#pendingDatagrams.shift();
        this._onDatagramStatus(Number(pending.id), 'abandoned');
        continue;
      }
      const accepted = new ArrayBuffer(4);
      const n = Number(ngtcp2Sym!.ngtcp2_conn_write_datagram_versioned(this.#conn, Pointer.of(outPath.path), NGTCP2_PKT_INFO_VERSION, pktInfo === null ? null : Pointer.of(pktInfo), out, out.byteLength, Pointer.of(accepted), NGTCP2_WRITE_DATAGRAM_FLAG_NONE, pending.id, pending.data, pending.data.byteLength, ts));
      const acceptedDatagram = new DataView(accepted).getInt32(0, true) !== 0;
      if (acceptedDatagram) {
        this.#pendingDatagrams.shift();
        this.#stats.datagramsSent++;
        publishQuicTopic('quic.session.send.datagram', {
          connection: this,
          id: Number(pending.id),
          length: pending.data.byteLength,
          earlyData: pending.earlyData
        });
      }
      if (n === 0) {
        if (!acceptedDatagram && pending.earlyData && this.#state === 'connecting') return 0;
        if (!acceptedDatagram) pending.attempts++;
        if (pending.attempts >= this.#options.datagrams.maxSendAttempts) {
          this.#pendingDatagrams.shift();
          this._onDatagramStatus(Number(pending.id), 'abandoned');
          continue;
        }
      }
      if (n === NGTCP2_ERR_INVALID_STATE) {
        if (pending.earlyData && this.#state === 'connecting') return 0;
        this.#pendingDatagrams.shift();
        this._onDatagramStatus(Number(pending.id), 'abandoned');
        continue;
      }
      return n;
    }
  }
  #hasPendingDatagrams(): boolean {
    return this.#pendingDatagrams.length > 0;
  }
  #nextDatagramOnlyPacket(outPath: NativePath, out: Uint8Array, ts: bigint, pktInfo: ArrayBuffer | null): number {
    const n = this.#writePendingDatagram(outPath, out, ts, pktInfo);
    if (n !== 0 || !this.#hasPendingDatagrams()) return n;
    return Number(ngtcp2Sym!.ngtcp2_conn_write_pkt_versioned(this.#conn, Pointer.of(outPath.path), NGTCP2_PKT_INFO_VERSION, pktInfo === null ? null : Pointer.of(pktInfo), out, out.byteLength, ts));
  }
  #queueWrittenPacket(batch: PendingSendPacket[], n: number, outPath: NativePath, fallbackRemoteAddress: QuicAddress, out: Uint8Array, ts: bigint, pktInfo: ArrayBuffer | null): void {
    if (n <= 0) return;
    const output = this.#outputFromPathForPacket(outPath, fallbackRemoteAddress);
    batch.push({
      fd: output.fd,
      data: out.subarray(0, n),
      remoteAddress: output.remoteAddress,
      ecn: packetInfoEcn(pktInfo)
    });
    ngtcp2Sym!.ngtcp2_conn_update_pkt_tx_time(this.#conn, ts);
  }
  #discardPendingDatagrams(): void {
    while (this.#pendingDatagrams.length > 0) {
      const pending = this.#pendingDatagrams.shift()!;
      this._onDatagramStatus(Number(pending.id), 'abandoned');
    }
  }
  #peerMaxDatagramPayload(): number {
    const params = ngtcp2Sym!.ngtcp2_conn_get_remote_transport_params(this.#conn) as ArrayBuffer | null;
    if (params === null || ptrAddress(params) === 0n) return 0;
    const maxFrameSize = Number(Pointer.readU64(params, TP_MAX_DATAGRAM_FRAME_SIZE));
    return maxDatagramPayload(maxFrameSize);
  }
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
      graceful: true
    });
    this.#state = 'closing';
    if (this.#stats.closingAt === null) this.#stats.closingAt = Date.now();
    this.#closeWritableStreamsForGracefulClose();
    this.#maybeFinishGracefulClose();
    return this.#gracefulClosePromise;
  }
  destroy(error?: Error, options: QuicCloseOptions = {}): void {
    const closeOptions = normalizeCloseOptions(options);
    this.#closeInfo = {
      errorCode: closeOptions.errorCode,
      reason: closeOptions.reason,
      type: closeOptions.type,
      remote: false
    };
    void this.#close(closeOptions.errorCode, closeOptions.reason, true, error, closeOptions.type);
  }
  async #close(errorCode: number, reason: string, sendConnectionClose: boolean, closeError?: Error, type: 'transport' | 'application' = 'application'): Promise<void> {
    if (this.#closed || this.#state === 'closed') return;
    if (this.#closeInfo === null) {
      this.#closeInfo = {
        errorCode,
        reason,
        type,
        remote: closeError !== undefined
      };
    }
    const canSendConnectionClose = sendConnectionClose && ptrAddress(this.#conn) !== 0n && !this.#connectionCloseSent;
    publishQuicTopic('quic.session.closing', {
      connection: this,
      errorCode,
      reason
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
    if (this.#handshakeTimer !== null) this.#handshakeTimer.cancel?.();
    this.#handshakeTimer = null;
    if (this.#role === 'client' && this.#tls !== null && this.#tls.backend === 'ossl' && this.#sessionKey !== null && this.#options.sessionStore !== undefined) {
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
    for (const stream of Array.from(this.#streams.values())) stream._closeFromConnection(connectionCloseError);
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
    this.#closeQlogFd();
    this.#pathCache.clear();
    for (const token of this.#statelessResetTokens.values()) {
      this.#endpoint._unregisterStatelessResetToken(token, this);
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
        this.#endpoint._unregisterTransport(transport);
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
      closeInfo: this.closeInfo
    });
    this.#dispatch(new Event('close'));
  }
  #closeWritableStreamsForGracefulClose(): void {
    for (const stream of Array.from(this.#streams.values())) {
      if (!stream._writerClosed() && stream._hasWritableSide()) {
        void stream.writer.close().catch(() => {});
      }
    }
  }
  #maybeFinishGracefulClose(): void {
    if (!this.#gracefulClosing || this.#closed || this.#gracefulCloseOptions === null) return;
    if (this.#pendingWrites.length > 0 || this.#pendingDatagrams.length > 0 || this.#blockedSend.length > 0) {
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
    if (pto <= 0n && this.#options.connection.initialRtt > 0n) pto = this.#options.connection.initialRtt;
    if (pto <= 0n) return CONNECTION_DRAINING_TIMEOUT_MS;
    const retentionNs = BigInt(this.#options.connection.drainingPeriodMultiplier) * pto;
    if (retentionNs <= 0n) return 1;
    return Math.max(1, Math.ceil(Number(retentionNs) / 1e6));
  }
  #closeFromTransport(errorCode = 0, reason = '', closeError?: Error, type: 'transport' | 'application' = 'transport', remote = closeError !== undefined): void {
    const handleError = (error: unknown) => {
      if (!this.#closed) {
        this.#dispatch(new QuicErrorEvent('error', { error: error instanceof Error ? error : new Error(String(error)) }));
      }
    };
    try {
      if (remote && this.#closeInfo === null) {
        this.#closeInfo = {
          errorCode,
          reason,
          type,
          remote: true
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
  _setSessionStoreKey(key: string): void {
    this.#sessionKey = key;
  }
  _setClientSessionOptions(verifyPeer: boolean, earlyDataMax: number): void {
    this.#clientVerifyPeer = verifyPeer;
    this.#clientEarlyDataMax = Math.max(0, Math.floor(earlyDataMax));
  }
  _closeForCompatibleVersionUpgrade(): void {
    this.#closeFromTransport();
    this.#endpoint._forgetConnectionRoutes(this);
  }
  _setAddressValidationToken(token: Uint8Array, tokenType: number): void {
    this.#validatedToken = token.slice();
    this.#validatedTokenType = tokenType;
  }
  _setEarlyDataDiagnostics(attempted: boolean, accepted: boolean): void {
    this.#earlyDataAttempted = attempted;
    this.#earlyDataAccepted = accepted;
  }
  _setEarlyDataReady(ready: boolean, maxBytes: number): void {
    this.#earlyDataReady = ready;
    this.#earlyDataMaxBytes = Math.max(0, Math.floor(maxBytes));
    this.#earlyDataQueuedBytes = 0;
  }
  _deferHandshakeForEarlyData(): void {
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
        reason: decision.reason
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
  _scheduleEarlyDataEvent(accepted: boolean, reason: string): void {
    this.#earlyDataDecision = {
      accepted,
      reason
    };
    this.#earlyDataDecisionDispatched = false;
    this.#runtime.defer(() => {
      this.#runtime.setTimer(0, () => {
        if (this.#closed) return;
        this.#earlyDataDecisionDispatched = true;
        this.dispatchEvent(new QuicEarlyDataEvent('earlydata', {
          accepted,
          rejected: !accepted,
          reason
        }));
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
        ticket: ticketCopy
      });
    }
    if (this.#sessionKey === null || this.#options.sessionStore === undefined) return;
    const store = this.#options.sessionStore;
    const key = this.#sessionKey;
    const transportParameters = this.#encodeEarlyTransportParameters();
    const earlyDataMax = this.#options.earlyData === false ? 0 : this.#options.earlyData.maxBytes ?? 4294967295;
    const version = this.version;
    const existing = await store.load(key) ?? {};
    await store.save(key, transportParameters === null ? {
      ...existing,
      ticket: ticketCopy,
      earlyDataMax,
      version
    } : {
      ...existing,
      ticket: ticketCopy,
      transportParameters,
      earlyDataMax,
      version
    });
  }
  _onSessionTicket(ticket: Uint8Array): void {
    void this.#saveSessionTicket(ticket).catch((error) => {
      if (!this.#closed) {
        this.#dispatch(new QuicErrorEvent('error', { error: error instanceof Error ? error : new Error(String(error)) }));
      }
    });
  }
  _setEarlyTransportParameters(data: Uint8Array): boolean {
    const rc = ngtcp2Sym!.ngtcp2_conn_decode_and_set_0rtt_transport_params(this.#conn, data, data.byteLength) as number;
    return rc === 0;
  }
  _initClient(rememberedVersion = 0): void {
    const dcid = randomCid(this.#options.connection.cidLength);
    const scid = randomCid(this.#options.connection.cidLength);
    this.#clientInitialDcid = dcid.slice(0);
    const initialVersion = rememberedVersion !== 0 && this.#options.versions.map(versionToWire).includes(rememberedVersion) && ngtcp2Sym!.ngtcp2_is_supported_version(rememberedVersion) !== 0 ? rememberedVersion : selectClientInitialWireVersion(this.#options.versions);
    this.#createNative(dcid, scid, null, initialVersion, true, initialVersion);
    this.#registerRoute(scid);
  }
  _initServer(clientScid: ArrayBuffer, serverScid: ArrayBuffer, version: number, retryScid: ArrayBuffer | null = null, token: Uint8Array | null = null, tokenType = NGTCP2_TOKEN_TYPE_UNKNOWN): void {
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
  #createNative(dcid: ArrayBuffer, scid: ArrayBuffer, originalDcid: ArrayBuffer | null, version: number, client: boolean, originalVersion = 0): void {
    this.#localInitialScid = scid.slice(0);
    this.#remoteInitialScid = client ? null : dcid.slice(0);
    const callbacks = ensureCallbackTable();
    const settings = makeSettings(this.#options, this.#runtime, this.#validatedToken, this.#validatedTokenType, originalVersion);
    const preferredAddress = !client && this.#options.migration.preferredAddress !== undefined ? this.#makePreferredAddressParams() : null;
    const statelessResetToken = !client && this.#listener !== null ? generateStatelessResetToken(this.#listener.resetTokenSecret, scid) : null;
    const params = makeTransportParams(originalDcid, this.#options, this.#retryScid, preferredAddress, statelessResetToken);
    this.#tlsNativeHandle = newNativeHandle(this.#tls!);
    this.#tlsNativeBackend = this.#tls!.backend;
    this.#wireVersion = version;
    writePtr(this.#connRef, 0, getConnRefPointer());
    writeAddress(this.#connRef, 8, Pointer.addr(this.#userData) as bigint);
    setConnectionRef(this.#tls!, this.#connRef);
    if (client) {
      setSessionTicketCallback(this.#tls!, (ticket) => {
        const copy = ticket.slice();
        this.#runtime.defer(() => this._onSessionTicket(copy));
      });
    }
    configureSessionForConnection(client ? 'client' : 'server', this.#tls!);
    const fn = client ? ngtcp2Sym!.ngtcp2_conn_client_new_versioned : ngtcp2Sym!.ngtcp2_conn_server_new_versioned;
    const rc = fn(Pointer.of(this.#conn), Pointer.of(dcid), Pointer.of(scid), Pointer.of(this.#path), version, NGTCP2_CALLBACKS_VERSION, Pointer.of(callbacks), NGTCP2_SETTINGS_VERSION, Pointer.of(settings), NGTCP2_TRANSPORT_PARAMS_VERSION, Pointer.of(params), null, Pointer.of(this.#userData)) as number;
    if (rc !== 0) throw ngtcp2Error(rc, client ? 'ngtcp2_conn_client_new' : 'ngtcp2_conn_server_new');
    ngtcp2Sym!.ngtcp2_conn_set_tls_native_handle(this.#conn, this.#tlsNativeHandle);
    ngtcp2Sym!.ngtcp2_conn_set_path_user_data(this.#conn, ptrField(this.#path, PATH_USER_DATA));
    const keepAliveTimeout = this.#options.connection.keepAliveTimeout > 0n ? this.#options.connection.keepAliveTimeout : client && this.#options.migration.enabled ? MIGRATION_KEEP_ALIVE_TIMEOUT : 0n;
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
        statelessResetToken: generateStatelessResetToken(this.#listener.resetTokenSecret, cid)
      };
    }
    if (addresses.ipv6 !== undefined) {
      const cid = randomCid(this.#options.connection.cidLength);
      preferred.ipv6 = {
        address: addresses.ipv6,
        cid,
        statelessResetToken: generateStatelessResetToken(this.#listener.resetTokenSecret, cid)
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
  _registerIssuedCid(cid: ArrayBuffer): void {
    this.#registerRoute(cid);
  }
  _unregisterIssuedCid(cid: ArrayBuffer): void {
    const key = cidKey(cidBytes(cid));
    this.#endpoint.cidTable.delete(key);
    const index = this.routeCids.indexOf(key);
    if (index !== -1) this.routeCids.splice(index, 1);
  }
  _onDestinationCidStatus(type: number, cid: ArrayBuffer | null, token: ArrayBuffer | null): void {
    if (cid === null || token === null) return;
    const key = cidKey(cidBytes(cid));
    if (type === NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE) {
      const tokenKey = cidKey(copyFromPtr(token, 16));
      const previous = this.#statelessResetTokens.get(key);
      if (previous !== undefined && previous !== tokenKey) {
        this.#endpoint._unregisterStatelessResetToken(previous, this);
      }
      this.#statelessResetTokens.set(key, tokenKey);
      this.#endpoint._registerStatelessResetToken(tokenKey, this);
    } else if (type === NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE) {
      const tokenKey = this.#statelessResetTokens.get(key);
      if (tokenKey !== undefined) this.#endpoint._unregisterStatelessResetToken(tokenKey, this);
      this.#statelessResetTokens.delete(key);
    }
  }
  _onStatelessReset(): void {
    this.#fail(new Error('QUIC stateless reset received'));
  }
  _waitHandshake(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    if (this.#handshakeError !== null) return Promise.reject(this.#handshakeError);
    return new Promise((resolve, reject) => this.#handshakeWaiters.push({
      resolve,
      reject
    }));
  }
  #waitHandshakeConfirmed(): Promise<void> {
    if (this.#handshakeConfirmed) return Promise.resolve();
    if (this.#handshakeError !== null) return Promise.reject(this.#handshakeError);
    if (this.#closed) return Promise.reject(new Error('QUIC connection is closed'));
    this.#startDeferredHandshake();
    this._driveWrites();
    return new Promise((resolve, reject) => this.#handshakeConfirmedWaiters.push({
      resolve,
      reject
    }));
  }
  _onHandshakeCompleted(): void {
    if (this.#state === 'closed') return;
    if (this.#handshakeTimer !== null) this.#handshakeTimer.cancel?.();
    this.#handshakeTimer = null;
    this.#state = 'connected';
    if (this.#stats.connectedAt === null) this.#stats.connectedAt = Date.now();
    if (this.#role === 'server') this.#markHandshakeConfirmed();
    if (this.#role === 'client' && this.#remoteInitialScid === null && ptrAddress(this.#conn) !== 0n) {
      const dcid = ngtcp2Sym!.ngtcp2_conn_get_dcid(this.#conn) as ArrayBuffer | null;
      if (dcid !== null && ptrAddress(dcid) !== 0n) this.#remoteInitialScid = makeCid(cidBytes(dcid));
    }
    this.#earlyDataReady = false;
    this.#earlyDataQueuedBytes = 0;
    const alpnProtocol = this.alpnProtocol;
    const handshakeInfo = getHandshakeInfo(this.#tls, this.#serverName);
    this.#peerCertificate = getPeerCertificate(this.#tls);
    this.#peerVerification = {
      verified: handshakeInfo.validationErrorCode === 0,
      errorCode: handshakeInfo.validationErrorCode,
      reason: handshakeInfo.validationErrorReason
    };
    if (this.#role === 'server' && this.#requireClientCertificate && this.#peerCertificate === null) {
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
      earlyDataAccepted: this.#earlyDataAccepted
    });
    const waiters = this.#handshakeWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve(undefined);
    if (this.#role === 'server' && !this.#accepted) {
      this.#accepted = true;
      this.#endpoint._accept(this);
      if (this.#tls !== null) {
        this.#scheduleSessionTicket();
      }
    }
  }
  _onHandshakeConfirmed(): void {
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
      const rc = cryptoSym!.ngtcp2_crypto_read_write_crypto_data(this.#conn, NGTCP2_ENCRYPTION_LEVEL_1RTT, null, 0n) as number;
      if (rc !== 0) {
        this.#fail(ngtcp2Error(rc, 'ngtcp2_crypto_read_write_crypto_data'));
        return;
      }
      this.#scheduleWriteDrain();
    });
  }
  #submitNewToken(): void {
    if (this.#role !== 'server' || this.#listener === null) return;
    const token = generateRegularToken(this.#listener.retryTokenSecret, this.remoteAddress, this.#runtime);
    if (token === null || token.byteLength === 0) return;
    const rc = ngtcp2Sym!.ngtcp2_conn_submit_new_token(this.#conn, token, token.byteLength) as number;
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
      error
    });
    this.#dispatch(new QuicErrorEvent('error', { error }));
    this.#closeFromTransport(0, '', error);
  }
  #writeBufferSize(): number {
    const maxPayload = Number(ngtcp2Sym!.ngtcp2_conn_get_max_tx_udp_payload_size(this.#conn) as bigint | number);
    return maxPayload > 0 ? Math.min(65536, Math.max(NGTCP2_MAX_UDP_PAYLOAD_SIZE, maxPayload)) : NGTCP2_MAX_UDP_PAYLOAD_SIZE;
  }
  #writePacketBudget(): number {
    const quantum = Number(ngtcp2Sym!.ngtcp2_conn_get_send_quantum(this.#conn) as bigint | number);
    const maxPayload = Number(ngtcp2Sym!.ngtcp2_conn_get_max_tx_udp_payload_size(this.#conn) as bigint | number);
    if (quantum <= 0 || maxPayload <= 0) return MAX_WRITE_PACKETS_PER_DRAIN;
    return Math.max(1, Math.min(MAX_WRITE_PACKETS_PER_DRAIN, Math.floor(quantum / maxPayload) || 1));
  }
  #outputFromPath(path: ArrayBuffer, fallbackRemoteAddress: QuicAddress, fallbackFd: number = this.#fd): {
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
      remoteAddress
    };
  }
  #outputFromPathForPacket(outPath: NativePath, fallbackRemoteAddress: QuicAddress): {
    fd: number;
    remoteAddress: QuicAddress;
  } {
    const fd = fdFromPath(outPath.path, this.#fd);
    if (fd === this.#fd && this.#activePathValidations.length === 0) {
      return {
        fd,
        remoteAddress: fallbackRemoteAddress
      };
    }
    const output = this.#outputFromPath(outPath.path, fallbackRemoteAddress);
    return {
      fd: output.fd,
      remoteAddress: output.remoteAddress
    };
  }
  #transportById(id: number): QuicDatagramTransport | null {
    return this.#endpoint._transportById(id) ?? null;
  }
  #syncActivePathFromNative(preferredPath: ArrayBuffer | null = null): boolean {
    const nativePath = preferredPath ?? ngtcp2Sym!.ngtcp2_conn_get_path(this.#conn) as ArrayBuffer | null;
    const snapshot = pathSnapshotFromNative(nativePath, this.#fd);
    return this.#syncActivePathSnapshot(snapshot);
  }
  #syncActivePathSnapshot(snapshot: PathSnapshot | null): boolean {
    if (snapshot === null) return false;
    const { localAddress, remoteAddress, fd } = snapshot;
    const changed = fd !== this.#fd || !sameAddress(localAddress, this.#activeLocalAddress) || !sameAddress(remoteAddress, this.remoteAddress);
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
    return this.#blockedSend.length === 0 && this.#flushPacketBatch([{
      fd,
      data,
      remoteAddress
    }]);
  }
  #copyPendingSendPacket(packet: PendingSendPacket): PendingSendPacket {
    return {
      fd: packet.fd,
      data: packet.data.slice(),
      remoteAddress: { ...packet.remoteAddress },
      ecn: packet.ecn
    };
  }
  #recordPacketSent(packet: PendingSendPacket): void {
    this.#endpoint._recordDatagramSent(packet.data.byteLength);
    this.#stats.packetsSent++;
    this.#stats.bytesSent += packet.data.byteLength;
  }
  #flushPacketBatch(packets: PendingSendPacket[]): boolean {
    for (let index = 0; index < packets.length;) {
      const first = packets[index]!;
      const transport = this.#transportById(first.fd);
      if (transport === null) {
        this.#fail(new Error(`QUIC datagram transport ${first.fd} is closed`));
        return false;
      }
      let end = index + 1;
      while (end < packets.length && packets[end]!.fd === first.fd) end++;
      const chunk = packets.slice(index, end);
      const result = transport.sendBatch === undefined ? this.#sendPacketChunkFallback(transport, chunk) : transport.sendBatch(chunk.map((packet) => ({
        data: packet.data,
        dest: packet.remoteAddress,
        ecn: packet.ecn
      })));
      for (let sent = 0; sent < result.sent; sent++) this.#recordPacketSent(chunk[sent]!);
      if (result.errno !== null) {
        if (result.errno === EAGAIN) {
          this.#blockedSend = packets.slice(index + result.sent).map((packet) => this.#copyPendingSendPacket(packet));
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
  #sendPacketChunkFallback(transport: QuicDatagramTransport, packets: PendingSendPacket[]): {
    sent: number;
    errno: number | null;
  } {
    let sent = 0;
    for (const packet of packets) {
      const rc = transport.sendNow(packet.data, packet.remoteAddress);
      if (rc < 0) return {
        sent,
        errno: rc
      };
      sent++;
    }
    return {
      sent,
      errno: null
    };
  }
  #sendClosePacket(fd: number, data: Uint8Array, remoteAddress: QuicAddress): boolean {
    const transport = this.#transportById(fd);
    if (transport === null) return false;
    const sent = transport.sendNow(data, remoteAddress);
    if (sent < 0) {
      if (sent !== EAGAIN) {
        this.#dispatch(new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }));
      }
      return false;
    }
    this.#endpoint._recordDatagramSent(data.byteLength);
    this.#stats.packetsSent++;
    this.#stats.bytesSent += data.byteLength;
    return true;
  }
  #rememberClosePacket(fd: number, data: Uint8Array, remoteAddress: QuicAddress): void {
    this.#closePacket = {
      fd,
      data: data.slice(),
      remoteAddress: { ...remoteAddress }
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
    transport.waitWritable().then(() => {
      this.#blockedSendRetryScheduled = false;
      const pending = this.#blockedSend;
      if (this.#closed || pending.length === 0) return;
      this.#blockedSend = [];
      if (this.#flushPacketBatch(pending)) {
        this.#scheduleTimer();
        this.#scheduleWriteDrain(pending[pending.length - 1]!.remoteAddress);
      }
    }, (error) => {
      this.#blockedSendRetryScheduled = false;
      if (!this.#closed) this.#fail(error instanceof Error ? error : new Error(String(error)));
    });
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
        ngtcp2Sym!.ngtcp2_ccerr_set_tls_alert(Pointer.of(ccerr), alert, reasonBytes, reasonBytes.byteLength);
      } else {
        ngtcp2Sym!.ngtcp2_ccerr_set_liberr(Pointer.of(ccerr), liberr, reasonBytes, reasonBytes.byteLength);
      }
    } else {
      ngtcp2Sym!.ngtcp2_ccerr_set_liberr(Pointer.of(ccerr), liberr, reasonBytes, reasonBytes.byteLength);
    }
    const outPath = makeOutputPath(this.#activeLocalAddress, remoteAddress, this.#fd);
    const ts = now(this.#runtime);
    const n = Number(ngtcp2Sym!.ngtcp2_conn_write_connection_close_versioned(this.#conn, Pointer.of(outPath.path), NGTCP2_PKT_INFO_VERSION, null, out, out.byteLength, Pointer.of(ccerr), ts));
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
    ngtcp2Sym!.ngtcp2_ccerr_set_application_error(Pointer.of(ccerr), BigInt(Math.max(0, Math.floor(errorCode))), reasonBytes, reasonBytes.byteLength);
    const outPath = makeOutputPath(this.#activeLocalAddress, this.remoteAddress, this.#fd);
    const ts = now(this.#runtime);
    const n = Number(ngtcp2Sym!.ngtcp2_conn_write_connection_close_versioned(this.#conn, Pointer.of(outPath.path), NGTCP2_PKT_INFO_VERSION, null, out, out.byteLength, Pointer.of(ccerr), ts));
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
    ngtcp2Sym!.ngtcp2_ccerr_set_transport_error(Pointer.of(ccerr), BigInt(Math.max(0, Math.floor(errorCode))), reasonBytes, reasonBytes.byteLength);
    const outPath = makeOutputPath(this.#activeLocalAddress, this.remoteAddress, this.#fd);
    const ts = now(this.#runtime);
    const n = Number(ngtcp2Sym!.ngtcp2_conn_write_connection_close_versioned(this.#conn, Pointer.of(outPath.path), NGTCP2_PKT_INFO_VERSION, null, out, out.byteLength, Pointer.of(ccerr), ts));
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
        remote: true
      };
      if (type === 'transport' && (errorCode & NGTCP2_CRYPTO_ERROR) === NGTCP2_CRYPTO_ERROR) {
        const alert = errorCode & 255;
        if (alert === TLS_ALERT_NO_APPLICATION_PROTOCOL) {
          return new Error(`QUIC ALPN mismatch: client offered ${this.alpnProtocols.join(', ') || '(none)'}`);
        }
      }
    }
    return ngtcp2Error(liberr, 'ngtcp2_conn_read_pkt');
  }
  #selectVersionNegotiationRetryVersion(): number {
    const allowed = new Set(this.#options.versions.map(versionToWire));
    for (const version of this.#versionNegotiationVersions) {
      if (allowed.has(version) && ngtcp2Sym!.ngtcp2_is_supported_version(version) !== 0 && version !== this.#wireVersion) {
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
    if (dcid === null || scid === null || this.#ctx === null || this.#serverName === null) return false;
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
    this.#tls = newClientSession(this.#ctx, this.alpnProtocols.slice(), this.#serverName, this.#clientVerifyPeer, this.#clientEarlyDataMax);
    this.#earlyDataReady = false;
    this.#earlyDataQueuedBytes = 0;
    this.#handshakeDeferred = false;
    this.#createNative(dcid, scid, null, version, true, originalVersion);
    this.#scheduleWriteDrain();
    return true;
  }
  _startSocketLoop(transport: QuicDatagramTransport | null = this.#transportById(this.#fd), localAddress: QuicAddress = this.#activeLocalAddress): void {
    if (this.#role !== 'client') return;
    if (transport === null) return;
    if (this.#clientTransports.has(transport.id)) return;
    this.#clientTransports.set(transport.id, transport);
    void this.#runSocketLoop(transport, localAddress);
  }
  async #runSocketLoop(transport: QuicDatagramTransport, localAddress: QuicAddress): Promise<void> {
    while (!this.#closed && this.#clientTransports.has(transport.id)) {
      try {
        const batch = transport.recvBatch?.(MAX_BATCH_READ_PACKETS_PER_TURN, NGTCP2_MAX_UDP_PAYLOAD_SIZE);
        if (batch !== undefined) {
          for (const received of batch) {
            this.#endpoint._handleDatagram(null, transport, localAddress, received.data, received.addr, received.ecn, received.path);
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
            this.#endpoint._handleDatagram(null, transport, localAddress, received.data, received.addr, received.ecn, received.path);
          }
          if (packets >= MAX_READ_PACKETS_PER_TURN) {
            await runtimeDelay(this.#runtime, 0);
            continue;
          }
        }
        await transport.waitReadable();
      } catch (error) {
        if (!this.#closed) this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  _receivePacket(packet: Uint8Array, remoteAddress: QuicAddress, localAddress: QuicAddress = this.localAddress, transport: QuicDatagramTransport | null = this.#transportById(this.#fd), packetEcn?: number, pathMetadata?: QuicDatagramPathMetadata): number {
    if (this.#closed) return this.#receiveClosingPacket(transport?.id ?? this.#fd, remoteAddress);
    this.#stats.packetsReceived++;
    this.#stats.bytesReceived += packet.byteLength;
    const fd = transport?.id ?? this.#fd;
    const packetPath = this.#retainPathFromMetadata(localAddress, remoteAddress, fd, pathMetadata);
    const packetVersion = longHeaderVersion(packet);
    if (this.#role === 'client' && this.#state === 'connecting' && packetVersion !== null && packetVersion !== 0 && packetVersion !== this.#wireVersion && this.#options.versions.map(versionToWire).includes(packetVersion) && ngtcp2Sym!.ngtcp2_is_supported_version(packetVersion) !== 0) {
      this.#retryVersionNegotiation(packetVersion);
    }
    const previousReadingPacketStartedConnecting = this.#readingPacketStartedConnecting;
    this.#readingPacketStartedConnecting = this.#state === 'connecting';
    let rc = 0;
    try {
      const pktInfo = this.#options.transport.ecn ? makePacketInfo(packetEcn ?? NGTCP2_ECN_NOT_ECT) : null;
      rc = ngtcp2Sym!.ngtcp2_conn_read_pkt_versioned(this.#conn, this.#ptrOf(packetPath.path, _QUIC_PTR_PATH), NGTCP2_PKT_INFO_VERSION, pktInfo === null ? null : this.#ptrOf(pktInfo, _QUIC_PTR_PKT_INFO), packet, packet.byteLength, now(this.#runtime)) as number;
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
      this.#fail(new QuicVersionNegotiationError(this.#versionNegotiationVersions, this.#options.versions.map(versionToWire)));
      return rc;
    }
    if (rc === NGTCP2_ERR_RECV_VERSION_NEGOTIATION || rc === NGTCP2_ERR_VERSION_NEGOTIATION) {
      if (this.#retryVersionNegotiation()) return rc;
      this.#fail(new QuicVersionNegotiationError(this.#versionNegotiationVersions, this.#options.versions.map(versionToWire)));
      return rc;
    }
    if (rc !== 0) {
      try {
        this.#writeConnectionClose(rc, remoteAddress);
      } catch {}
      this.#fail(this.#readCloseError(rc));
      return rc;
    }
    this.#endpoint._recordDatagramReceived(packet.byteLength);
    if (fd !== this.#fd || !sameAddress(localAddress, this.#activeLocalAddress) || !sameAddress(remoteAddress, this.remoteAddress) || this.#activePathValidations.length > 0) {
      this.#syncActivePathFromNative();
    }
    this.#scheduleTimer();
    this.#scheduleWriteDrain(remoteAddress);
    return rc;
  }
  _reserveStreamData(data: Uint8Array): void {
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
  _queueStreamData(stream: QuicStream, data: Uint8Array, fin: boolean, earlyDataReserved = false): void {
    if (!earlyDataReserved) {
      this.#validateEarlyStreamData(data);
    }
    if (fin && data.byteLength === 0) {
      const pending = this.#pendingWrites[this.#pendingWrites.length - 1];
      if (pending !== undefined && pending.streamId === stream.id && pending.offset === 0 && !pending.fin) {
        pending.fin = true;
        this.#scheduleWriteDrain();
        return;
      }
    }
    stream._recordQueuedWrite(data.byteLength);
    this.#pendingWrites.push({
      streamId: stream.id,
      data,
      offset: 0,
      fin
    });
    this.#startDeferredHandshake();
    this.#scheduleWriteDrain();
  }
  #canOpenApplicationStream(): boolean {
    if (this.#gracefulClosing) return false;
    return this.#state === 'connected' || this.#role === 'client' && this.#state === 'connecting' && this.#earlyDataReady;
  }
  #encodeEarlyTransportParameters(): Uint8Array | null {
    if (ptrAddress(this.#conn) === 0n) return null;
    if (ngtcp2Sym!.ngtcp2_conn_get_handshake_completed(this.#conn) === 0) return null;
    const out = new Uint8Array(65536);
    const n = Number(ngtcp2Sym!.ngtcp2_conn_encode_0rtt_transport_params(this.#conn, out, out.byteLength));
    if (n <= 0) return null;
    return out.slice(0, n);
  }
  _driveWrites(remoteAddress: QuicAddress = this.remoteAddress): void {
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
      const writeBufferSize = this.#writeBufferSize();
      const ts = now(this.#runtime);
      let packets = 0;
      const packetBudget = this.#writePacketBudget();
      const packetBatch: PendingSendPacket[] = [];
      const outPath = this.#retainPath(this.#activeLocalAddress, remoteAddress, this.#fd);
      for (; packets < packetBudget; packets++) {
        let n = 0;
        const out = this.#writePacketBuffer(packets, writeBufferSize);
        const pktInfo = this.#options.transport.ecn ? makePacketInfo() : null;
        const pktInfoPtr = pktInfo === null ? null : this.#ptrOf(pktInfo, _QUIC_PTR_PKT_INFO);
        const outPathPtr = this.#ptrOf(outPath.path, _QUIC_PTR_PATH);
        const writeNoStreamData = (): number => Number(ngtcp2Sym!.ngtcp2_conn_writev_stream_versioned(this.#conn, outPathPtr, NGTCP2_PKT_INFO_VERSION, pktInfoPtr, out, out.byteLength, null, 0, -1n, null, 0n, ts));
        const isCoalescingRetry = (code: number): boolean => code === NGTCP2_ERR_WRITE_MORE || code === NGTCP2_ERR_STREAM_DATA_BLOCKED || code === NGTCP2_ERR_STREAM_NOT_FOUND || code === NGTCP2_ERR_STREAM_SHUT_WR;
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
            const flags = (pending.fin ? NGTCP2_WRITE_STREAM_FLAG_FIN : 0) | NGTCP2_WRITE_STREAM_FLAG_MORE;
            coalescing = true;
            n = Number(ngtcp2Sym!.ngtcp2_conn_writev_stream_versioned(this.#conn, outPathPtr, NGTCP2_PKT_INFO_VERSION, pktInfoPtr, out, out.byteLength, this.#ptrOf(dataLen, _QUIC_PTR_DATA_LEN), flags, BigInt(pending.streamId), this.#ptrOf(vec, _QUIC_PTR_VEC), 1n, ts));
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
                data: remaining.subarray(0, consumed)
              });
              pending.offset += consumed;
            }
            const consumedAllData = pending.offset >= pending.data.byteLength;
            const streamFrameWritten = consumed >= 0 && packetAccepted;
            const finWritten = !pending.fin || streamFrameWritten && consumedAllData;
            if (consumedAllData && finWritten) this.#pendingWrites.splice(pendingIndex, 1);
            if (n === NGTCP2_ERR_WRITE_MORE) {
              coalescing = true;
              continue;
            }
            if (n === NGTCP2_ERR_STREAM_NOT_FOUND || n === NGTCP2_ERR_STREAM_SHUT_WR) {
              this.#dropPendingWrites(pending.streamId);
              this.#streams.get(pending.streamId)?._stopSendingFromConnection(0);
              if (coalescing || this.#pendingWrites.length > 0) continue;
              break;
            }
            if (n === NGTCP2_ERR_STREAM_DATA_BLOCKED) {
              this.#stats.blockCount++;
              const stream = this.#streams.get(pending.streamId) ?? null;
              publishQuicTopic('quic.stream.blocked', {
                connection: this,
                stream,
                streamId: pending.streamId
              });
              stream?._blockedFromConnection();
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
          n = Number(ngtcp2Sym!.ngtcp2_conn_write_pkt_versioned(this.#conn, outPathPtr, NGTCP2_PKT_INFO_VERSION, pktInfoPtr, out, out.byteLength, ts));
        }
        if (n > 0) {
          this.#queueWrittenPacket(packetBatch, n, outPath, remoteAddress, out, ts, pktInfo);
          if (this.#closed) break;
          continue;
        }
        if (n === 0 || n === NGTCP2_ERR_NOBUF || n === NGTCP2_ERR_PKT_NUM_EXHAUSTED || n === NGTCP2_ERR_STREAM_DATA_BLOCKED || n === NGTCP2_ERR_STREAM_NOT_FOUND || n === NGTCP2_ERR_STREAM_SHUT_WR) {
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
  _scheduleWrites(remoteAddress: QuicAddress = this.remoteAddress): void {
    this.#scheduleWriteDrain(remoteAddress);
  }
  _scheduleStreamWriterFlush(callback: () => void): void {
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
      this._driveWrites(drainRemoteAddress);
    });
  }
  #scheduleTimer(): void {
    if (this.#closed) return;
    if (this.#timer !== null) this.#timer.cancel?.();
    this.#timer = null;
    const expiry = ngtcp2Sym!.ngtcp2_conn_get_expiry(this.#conn) as bigint;
    const current = now(this.#runtime);
    const streamIdleDelayMs = this.#nextStreamIdleDelayMs(current);
    if (expiry === NGTCP2_NO_EXPIRY) {
      if (streamIdleDelayMs !== null) {
        this.#timer = this.#runtime.setTimer(streamIdleDelayMs, () => this.#handleTimerExpiry());
      }
      return;
    }
    if (expiry <= current) {
      this.#scheduleImmediateTimerExpiry();
      return;
    }
    const deltaNs = expiry - current;
    let delayMs = Math.max(1, Number(deltaNs / 1000000n));
    if (streamIdleDelayMs !== null) delayMs = Math.min(delayMs, streamIdleDelayMs);
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
    else if (rc !== 0 && rc !== NGTCP2_ERR_DRAINING && rc !== NGTCP2_ERR_CLOSING) this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_handle_expiry'));
    else {
      this._driveWrites();
      this.#checkStreamIdleTimeout(current);
    }
  }
  #nextStreamIdleDelayMs(current: bigint): number | null {
    const timeout = this.#options.connection.streamIdleTimeout;
    if (timeout <= 0n || this.#peerStreamActivity.size === 0) return null;
    let nextDue: bigint | null = null;
    for (const lastActivity of this.#peerStreamActivity.values()) {
      const due = lastActivity + timeout;
      if (nextDue === null || due < nextDue) nextDue = due;
    }
    if (nextDue === null) return null;
    if (nextDue <= current) return 1;
    return Math.max(1, Number((nextDue - current) / 1000000n));
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
      const rc = ngtcp2Sym!.ngtcp2_conn_shutdown_stream(this.#conn, 0, BigInt(streamId), 0n) as number;
      if (rc !== 0 && rc !== NGTCP2_ERR_STREAM_NOT_FOUND && rc !== NGTCP2_ERR_STREAM_SHUT_WR) {
        this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_shutdown_stream'));
        return;
      }
      this.#stats.streamsIdleTimedOut++;
      this.#releaseStreamData(streamId);
      this.#extendMaxStreamsOnRemoteClose(streamId);
      stream._closeFromConnection(new Error('QUIC stream idle timeout'));
      this.#scheduleWriteDrain();
    }
  }
  _onRemoteStreamOpen(streamId: number): void {
    this.#recordPeerStreamActivity(streamId);
    this.#ensureStream(streamId, ngtcp2Sym!.ngtcp2_is_bidi_stream(BigInt(streamId)) ? 'bidirectional' : 'unidirectional', true);
  }
  _onLocalStreamCredit(direction: 'bidirectional' | 'unidirectional'): void {
    const waiter = this.#localStreamCreditWaiters[direction].shift();
    if (waiter !== undefined) waiter.resolve(undefined);
  }
  _onStreamData(streamId: number, offset: number, data: Uint8Array, fin: boolean): void {
    this.#recordPeerStreamActivity(streamId);
    const stream = this.#ensureStream(streamId, ngtcp2Sym!.ngtcp2_is_bidi_stream(BigInt(streamId)) ? 'bidirectional' : 'unidirectional', true);
    stream._pushIncoming(offset, data, fin);
  }
  _onStreamDataCredit(_streamId: number, _maxData: number): void {
    this.#scheduleWriteDrain();
  }
  _extendStreamReceiveCredit(streamId: number, bytes: number): void {
    if (bytes <= 0 || this.#closed) return;
    const rc = ngtcp2Sym!.ngtcp2_conn_extend_max_stream_offset(this.#conn, BigInt(streamId), BigInt(bytes)) as number;
    if (rc !== 0) {
      this.#fail(ngtcp2Error(rc, 'ngtcp2_conn_extend_max_stream_offset'));
      return;
    }
    this.#scheduleWriteDrain();
  }
  _extendConnectionReceiveCredit(bytes: number): void {
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
  _onStreamClose(streamId: number): void {
    this.#peerStreamActivity.delete(streamId);
    this.#ackOutstandingStreamData(streamId);
    this.#releaseStreamData(streamId);
    this.#extendMaxStreamsOnRemoteClose(streamId);
    this.#streams.get(streamId)?._closeFromConnection();
  }
  _onStreamReset(streamId: number, code: number): void {
    this.#peerStreamActivity.delete(streamId);
    this.#releaseStreamData(streamId);
    this.#extendMaxStreamsOnRemoteClose(streamId);
    this.#streams.get(streamId)?._resetFromConnection(code);
  }
  _onStreamStopSending(streamId: number, code: number): void {
    this.#streams.get(streamId)?._stopSendingFromConnection(code);
    this.#scheduleWriteDrain();
  }
  #extendMaxStreamsOnRemoteClose(streamId: number): void {
    if (this.#creditedRemoteStreamCloses.has(streamId)) return;
    const initiator = streamId & 1;
    const remoteInitiated = this.#role === 'client' ? initiator === 1 : initiator === 0;
    if (!remoteInitiated) return;
    this.#creditedRemoteStreamCloses.add(streamId);
    const direction = ngtcp2Sym!.ngtcp2_is_bidi_stream(BigInt(streamId)) ? 'bidirectional' : 'unidirectional';
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
  _onDatagram(data: Uint8Array, earlyData: boolean): void {
    if (!this.#options.datagrams.enabled) return;
    this.#stats.datagramsReceived++;
    const receivedEarlyData = earlyData || this.#role === 'server' && this.#readingPacketStartedConnecting;
    this.#lastDatagramEvent = {
      data: data.slice(),
      earlyData: receivedEarlyData
    };
    this.#datagramQueue.push(data);
    publishQuicTopic('quic.session.receive.datagram', {
      connection: this,
      length: data.byteLength,
      earlyData: receivedEarlyData
    });
    this.#dispatch(new QuicDatagramEvent('datagram', {
      data,
      earlyData: receivedEarlyData
    }));
  }
  _onDatagramStatus(id: number, status: QuicDatagramStatus): void {
    if (status === 'ack') this.#stats.datagramsAcked++;
    else if (status === 'lost') this.#stats.datagramsLost++;
    else this.#stats.datagramsAbandoned++;
    publishQuicTopic('quic.session.receive.datagram.status', {
      connection: this,
      id,
      status
    });
    this.#dispatch(new QuicDatagramStatusEvent('datagramstatus', {
      id,
      status
    }));
    const eventType = status === 'ack' ? 'datagramack' : status === 'lost' ? 'datagramlost' : 'datagramabandoned';
    this.#dispatch(new QuicDatagramStatusEvent(eventType, {
      id,
      status
    }));
  }
  _onKeyInstalled(_level: number): void {}
  _onVersionNegotiation(hd: ArrayBuffer | null, sv: ArrayBuffer | null, nsv: number): void {
    const wireVersion = hd === null || hd.byteLength < PKT_HD_VERSION + 4 ? this.#wireVersion : readU32(hd, PKT_HD_VERSION);
    const requestedWireVersions: number[] = [];
    const versions = copyFromPtr(sv, Math.max(0, nsv) * 4);
    const view = new DataView(versions.buffer, versions.byteOffset, versions.byteLength);
    for (let offset = 0; offset + 4 <= versions.byteLength; offset += 4) {
      requestedWireVersions.push(view.getUint32(offset, true));
    }
    this.#versionNegotiationVersions = requestedWireVersions.slice();
    if (this.#role === 'client' && this.#state === 'connecting' && !this.#versionNegotiationRetried) {
      this.#versionNegotiationPendingRetry = true;
    }
    this.#publishVersionNegotiation(wireVersion, requestedWireVersions);
  }
  _onVersionNegotiationForTest(wireVersion: number, requestedWireVersions: number[], supportedWireVersions?: number[]): void {
    this.#publishVersionNegotiation(wireVersion, requestedWireVersions, supportedWireVersions);
  }
  #publishVersionNegotiation(wireVersion: number, requestedWireVersions: number[], supportedWireVersions = this.#options.versions.map(versionToWire)): void {
    publishQuicTopic('quic.session.version.negotiation', {
      connection: this,
      version: wireVersion === NGTCP2_PROTO_VER_V1 || wireVersion === NGTCP2_PROTO_VER_V2 ? wireVersionToName(wireVersion) : null,
      wireVersion,
      requestedWireVersions: Object.freeze(requestedWireVersions.slice()),
      supportedWireVersions: Object.freeze(supportedWireVersions.slice())
    });
  }
  _onNewToken(token: Uint8Array): void {
    if (this.#sessionKey === null || token.byteLength === 0) return;
    const addressToken = token.slice();
    this.#endpoint._storeAddressToken(this.#sessionKey, addressToken);
    if (this.#options.sessionStore !== undefined) {
      const store = this.#options.sessionStore;
      const key = this.#sessionKey;
      void Promise.resolve(store.load(key)).then((existing) => {
        return store.save(key, {
          ...existing ?? {},
          addressToken
        });
      }).catch((error) => {
        if (!this.#closed) this.#dispatch(new QuicErrorEvent('error', { error: error instanceof Error ? error : new Error(String(error)) }));
      });
    }
    const eventToken = addressToken.slice();
    this.#dispatch(new QuicNewTokenEvent('newtoken', {
      token: eventToken,
      address: this.remoteAddress
    }));
    publishQuicTopic('quic.session.new.token', {
      connection: this,
      token: eventToken,
      address: this.remoteAddress
    });
  }
  _onQlogWrite(flags: number, data: Uint8Array): void {
    if (this.#options.qlog === false) return;
    try {
      const fd = this.#openQlogFd();
      if (data.byteLength > 0) writeAllFd(fd, data);
      if ((flags & NGTCP2_QLOG_WRITE_FLAG_FIN) !== 0) this.#closeQlogFd();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/open failed/.test(message)) this.#stats.qlogOpenFailed++;
      else this.#stats.qlogWriteFailed++;
      if (!this.#closed) this.#dispatch(new QuicErrorEvent('error', { error: error instanceof Error ? error : new Error(String(error)) }));
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
    const fd = Number(fileLib.symbols.open(fileCstr(output.path), O_WRONLY | O_CREAT | O_TRUNC, 420));
    if (fd < 0) throw new Error(`qlog open failed: ${fd}`);
    fileLib.symbols.fchmod(fd, 420);
    this.#qlogFd = fd;
    return fd;
  }
  #closeQlogFd(): void {
    if (this.#qlogFd === null) return;
    fileLib.symbols.close(this.#qlogFd);
    this.#qlogFd = null;
  }
  _onEarlyDataRejected(): void {
    this.#earlyDataReady = false;
    this.#earlyDataQueuedBytes = 0;
    publishQuicTopic('quic.session.early.rejected', { connection: this });
    this.#dispatch(new QuicEarlyDataEvent('earlydata', {
      accepted: false,
      rejected: true,
      reason: 'rejected-by-peer'
    }));
  }
  _onPathValidationStarted(path: ArrayBuffer | null, fallbackPath?: ArrayBuffer | null, flags = 0): void {
    this.#activePathValidations.push({
      path: pathSnapshotFromNative(path, this.#fd),
      previousPath: pathSnapshotFromNative(fallbackPath ?? null, this.#fd),
      preferredAddress: (flags & NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR) !== 0,
      newToken: (flags & NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN) !== 0
    });
  }
  _onPathValidationFinished(path: ArrayBuffer | null, fallbackPath: ArrayBuffer | null, result: number, flags: number): void {
    const validatedSnapshot = pathSnapshotFromNative(path, this.#fd);
    const fallbackSnapshot = pathSnapshotFromNative(fallbackPath, this.#fd);
    this.#forgetActivePathValidation(validatedSnapshot, fallbackSnapshot, flags);
    const snapshot = result === NGTCP2_PATH_VALIDATION_RESULT_SUCCESS ? validatedSnapshot : fallbackSnapshot;
    const init = {
      result: pathValidationResultName(result),
      path: pathFromSnapshot(validatedSnapshot),
      previousPath: pathFromSnapshot(fallbackSnapshot),
      preferredAddress: (flags & NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR) !== 0,
      newToken: (flags & NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN) !== 0
    };
    deferAfterNativeCallback(() => {
      const activePathChanged = this.#syncActivePathSnapshot(snapshot);
      publishQuicTopic('quic.session.path.validation', {
        connection: this,
        ...init
      });
      this.#dispatch(new QuicPathValidationEvent('pathvalidation', init));
      if (result === NGTCP2_PATH_VALIDATION_RESULT_SUCCESS && (activePathChanged || pathSnapshotsDiffer(validatedSnapshot, fallbackSnapshot))) {
        this.#dispatch(new QuicPathValidationEvent('migration', init));
      }
    });
  }
  #forgetActivePathValidation(path: PathSnapshot | null, previousPath: PathSnapshot | null, flags: number): void {
    const preferredAddress = (flags & NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR) !== 0;
    const newToken = (flags & NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN) !== 0;
    const index = this.#activePathValidations.findIndex((validation) => !pathSnapshotsDiffer(validation.path, path) && !pathSnapshotsDiffer(validation.previousPath, previousPath) && validation.preferredAddress === preferredAddress && validation.newToken === newToken);
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
        newToken: validation.newToken
      };
      publishQuicTopic('quic.session.path.validation', {
        connection: this,
        ...init
      });
      this.#dispatch(new QuicPathValidationEvent('pathvalidation', init));
    }
  }
  _selectPreferredAddress(dest: ArrayBuffer | null, paddr: ArrayBuffer | null): number {
    if (dest === null || paddr === null || !this.#options.migration.enabled || !this.#options.migration.usePreferredAddress) return 0;
    const localAddress = this.#activeLocalAddress;
    const remoteAddress = preferredAddressFromNative(paddr, localAddress.family);
    if (remoteAddress === null) return 0;
    const path = this.#retainPath(localAddress, remoteAddress, this.#fd);
    if (!writeNativePathAddress(dest, PATH_LOCAL, localAddress)) return NGTCP2_ERR_CALLBACK_FAILURE;
    if (!writeNativePathAddress(dest, PATH_REMOTE, remoteAddress)) return NGTCP2_ERR_CALLBACK_FAILURE;
    writeNativePathUserData(dest, path.userData);
    return 0;
  }
  #ensureStream(streamId: number, direction: 'bidirectional' | 'unidirectional', incoming: boolean): QuicStream {
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
        direction
      });
      if (incoming) {
        if (this.#gracefulClosing) {
          if (ptrAddress(this.#conn) !== 0n) {
            ngtcp2Sym!.ngtcp2_conn_shutdown_stream(this.#conn, 0, BigInt(streamId), 0n);
            this.#scheduleWriteDrain();
          }
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
  _removeStream(stream: QuicStream): void {
    this.#peerStreamActivity.delete(stream.id);
    this.#streams.delete(stream.id);
    this.#closedStreams.set(stream.id, stream);
    this.#stats.streamsClosed++;
    this.#maybeFinishGracefulClose();
  }
  _onAckedStreamDataOffset(streamId: number, offset: number, datalen: number): void {
    (this.#streams.get(streamId) ?? this.#closedStreams.get(streamId))?._recordAck(offset, datalen);
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
          data: entry.data.subarray(0, offset - entry.start)
        });
      }
      if (end < entry.end) {
        outstanding.push({
          streamId,
          start: end,
          end: entry.end,
          data: entry.data.subarray(end - entry.start)
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
      stream._recordAck(entry.start, entry.end - entry.start);
    }
  }
  #releaseStreamData(streamId: number): void {
    this.#nextStreamOffsets.delete(streamId);
    this.#outstandingStreamData = this.#outstandingStreamData.filter((entry) => entry.streamId !== streamId);
    this.#closedStreams.delete(streamId);
    this.#dropPendingWrites(streamId);
  }
  #dropPendingWrites(streamId: number): void {
    this.#pendingWrites = this.#pendingWrites.filter((entry) => entry.streamId !== streamId);
  }
}
export class QuicStream extends EventTarget {
  readonly id: number;
  readonly direction: 'bidirectional' | 'unidirectional';
  readonly reader: BytesReader;
  readonly writer: QuicBytesWriter;
  #connection: QuicConnection;
  #readableSide: boolean;
  #writableSide: boolean;
  #incoming = new ByteQueue();
  #incomingSegments: IncomingStreamSegment[] = [];
  #incomingOffset = 0;
  #incomingFinOffset: number | null = null;
  #readStopped = false;
  #closed = false;
  #readable: ReadableStream<Uint8Array> | null = null;
  #writable: WritableStream<Uint8Array> | null = null;
  #stats = {
    createdAt: Date.now(),
    openedAt: Date.now() as number | null,
    receivedAt: null as number | null,
    ackedAt: null as number | null,
    destroyedAt: null as number | null,
    bytesReceived: 0,
    bytesSent: 0,
    bytesAcked: 0,
    finalSize: null as number | null,
    maxOffset: 0,
    maxOffsetAcked: 0,
    maxOffsetReceived: 0,
    maxOffsetSent: 0,
    bytesAccumulated: 0,
    maxBytesAccumulated: 0
  };
  constructor(id: number, direction: 'bidirectional' | 'unidirectional', connection: QuicConnection, incoming = false) {
    super();
    this.id = id;
    this.direction = direction;
    this.#connection = connection;
    this.#readableSide = direction === 'bidirectional' || incoming;
    this.#writableSide = direction === 'bidirectional' || !incoming;
    this.reader = new QuicBytesReader(this, () => this.#closeReadable());
    this.writer = new QuicBytesWriter(this, () => this.#closeWritable());
    if (!this.#readableSide) this.#incoming.close();
  }
  get readable(): ReadableStream<Uint8Array> {
    if (this.#readable !== null) return this.#readable;
    this.#readable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const chunk = await this.reader.read();
        if (chunk === null) controller.close();
        else controller.enqueue(chunk);
      },
      cancel: () => this.stopSending(0)
    });
    return this.#readable;
  }
  get writable(): WritableStream<Uint8Array> {
    if (this.#writable !== null) return this.#writable;
    this.#writable = new WritableStream<Uint8Array>({
      write: (chunk) => this.writer.write(chunk),
      close: () => this.writer.close(),
      abort: (reason) => this.reset(typeof reason === 'number' ? reason : 0)
    });
    return this.#writable;
  }
  get stats(): QuicStreamStats {
    const stats = { ...this.#stats };
    if (this.writer.closed && stats.bytesSent > 0 && stats.bytesAcked === 0) {
      stats.bytesAcked = stats.bytesSent;
      stats.maxOffsetAcked = Math.max(stats.maxOffsetAcked, stats.maxOffsetSent);
      if (stats.ackedAt === null) stats.ackedAt = Date.now();
    }
    return Object.freeze(stats);
  }
  reset(errorCode: number): void {
    this.#assertConnectionOpen();
    ngtcp2Sym!.ngtcp2_conn_shutdown_stream(this.#connection.nativeHandle, 0, BigInt(this.id), BigInt(errorCode));
    this._resetFromConnection(errorCode);
    this.#connection._scheduleWrites();
  }
  /**
  * Reset the stream after reliably delivering bytes up to `finalSize`.
  *
  * This requires ngtcp2 support for the QUIC reliable reset extension. Builds
  * without that native symbol throw a clear unsupported error.
  */
  resetAt(errorCode: number, finalSize: number | bigint): void {
    this.#assertConnectionOpen();
    if (!ngtcp2ResetStreamAtAvailable) {
      throw new Error('ngtcp2 reset_stream_at is not supported by the loaded library');
    }
    if (!Number.isFinite(errorCode) || errorCode < 0) {
      throw new RangeError('QUIC stream resetAt errorCode must be a non-negative finite number');
    }
    const reliableSize = typeof finalSize === 'bigint' ? finalSize : BigInt(finalSize);
    if (reliableSize < 0n) throw new RangeError('QUIC stream resetAt finalSize must be non-negative');
    const rc = ngtcp2ConnResetStreamAt(this.#connection.nativeHandle, 0, BigInt(this.id), BigInt(Math.floor(errorCode)), reliableSize);
    if (rc !== 0) throw ngtcp2Error(rc, 'ngtcp2 reset_stream_at');
    this._resetFromConnection(errorCode);
    this.#connection._scheduleWrites();
  }
  stopSending(errorCode: number): void {
    this.#assertConnectionOpen();
    if (this.#connection._isLocalUnidirectionalStream(this.id)) return;
    this.#incoming.close();
    this.#readStopped = true;
    const rc = ngtcp2Sym!.ngtcp2_conn_shutdown_stream_read(this.#connection.nativeHandle, 0, BigInt(this.id), BigInt(errorCode)) as number;
    if (rc !== 0) throw ngtcp2Error(rc, 'ngtcp2_conn_shutdown_stream_read');
    this.#connection._scheduleWrites();
  }
  #assertConnectionOpen(): void {
    if (this.#connection._isClosedForInternalUse() || ptrAddress(this.#connection.nativeHandle) === 0n) {
      throw new Error('QUIC connection is closed');
    }
  }
  _reserveWrite(buf: Uint8Array): void {
    if (this.#closed) throw new Error('QUIC stream is closed');
    this._assertWritableSide();
    if (typeof this.#connection._reserveStreamData === 'function') {
      this.#connection._reserveStreamData(buf);
    }
  }
  _queueWrite(buf: Uint8Array, fin: boolean, earlyDataReserved = false): void {
    if (this.#closed) throw new Error('QUIC stream is closed');
    this._assertWritableSide();
    this.#connection._queueStreamData(this, buf, fin, earlyDataReserved);
  }
  _hasWritableSide(): boolean {
    return this.#writableSide;
  }
  _readFinReceived(): boolean {
    return this.#incomingFinOffset !== null;
  }
  _assertWritableSide(): void {
    if (!this.#writableSide) throw new Error('QUIC unidirectional stream is receive-only');
  }
  _scheduleWriterFlush(callback: () => void): void {
    if (typeof this.#connection._scheduleStreamWriterFlush === 'function') {
      this.#connection._scheduleStreamWriterFlush(callback);
    } else {
      loop.timeout(0).then(callback, () => {});
    }
  }
  _readIncoming(maxBytes = 65536, signal?: AbortSignal | null): Promise<Uint8Array | null> {
    return this.#incoming.read(maxBytes, signal);
  }
  _extendStreamReceiveCredit(bytes: number): void {
    this.#connection?._extendStreamReceiveCredit?.(this.id, bytes);
  }
  _extendConnectionReceiveCredit(bytes: number): void {
    this.#connection?._extendConnectionReceiveCredit?.(bytes);
  }
  _pushIncoming(offset: number, data: Uint8Array, fin: boolean): void {
    if (this.#stats.receivedAt === null) this.#stats.receivedAt = Date.now();
    this.#stats.bytesReceived += data.byteLength;
    this.#stats.maxOffsetReceived = Math.max(this.#stats.maxOffsetReceived, offset + data.byteLength);
    if (fin) this.#stats.finalSize = offset + data.byteLength;
    if (fin) this.#incomingFinOffset = offset + data.byteLength;
    if (data.byteLength > 0) {
      this.#insertIncomingSegment(offset, data);
      this.#refreshAccumulatedStats();
    }
    this.#flushIncomingSegments();
    this.#refreshAccumulatedStats();
  }
  #insertIncomingSegment(offset: number, data: Uint8Array): number {
    const end = offset + data.byteLength;
    if (end <= this.#incomingOffset) return 0;
    const start = Math.max(offset, this.#incomingOffset);
    const accepted = this.#countNewIncomingBytes(start, end);
    const segments = this.#incomingSegments.concat({
      offset: start,
      data: start === offset ? data : data.subarray(start - offset)
    });
    segments.sort((a, b) => a.offset - b.offset);
    const normalized: IncomingStreamSegment[] = [];
    for (const segment of segments) {
      const segmentStart = Math.max(segment.offset, this.#incomingOffset);
      const segmentEnd = segment.offset + segment.data.byteLength;
      if (segmentEnd <= segmentStart) continue;
      const last = normalized[normalized.length - 1];
      const coveredUntil = last === undefined ? this.#incomingOffset : last.offset + last.data.byteLength;
      if (segmentEnd <= coveredUntil) continue;
      const appendOffset = Math.max(segmentStart, coveredUntil);
      normalized.push({
        offset: appendOffset,
        data: appendOffset === segment.offset ? segment.data : segment.data.subarray(appendOffset - segment.offset)
      });
    }
    this.#incomingSegments = normalized;
    return accepted;
  }
  #countNewIncomingBytes(start: number, end: number): number {
    let cursor = start;
    let accepted = 0;
    for (const segment of this.#incomingSegments) {
      const segmentStart = Math.max(segment.offset, this.#incomingOffset);
      const segmentEnd = segment.offset + segment.data.byteLength;
      if (segmentEnd <= cursor) continue;
      if (segmentStart > cursor) {
        const gapEnd = Math.min(segmentStart, end);
        if (gapEnd > cursor) accepted += gapEnd - cursor;
      }
      cursor = Math.max(cursor, segmentEnd);
      if (cursor >= end) break;
    }
    if (cursor < end) accepted += end - cursor;
    return accepted;
  }
  #flushIncomingSegments(): void {
    for (;;) {
      const segment = this.#incomingSegments[0];
      if (segment === undefined || segment.offset > this.#incomingOffset) break;
      this.#incomingSegments.shift();
      const skip = this.#incomingOffset - segment.offset;
      if (skip >= segment.data.byteLength) continue;
      const chunk = skip === 0 ? segment.data : segment.data.subarray(skip);
      this.#incoming.push(chunk);
      this.#incomingOffset += chunk.byteLength;
    }
    if (this.#incomingFinOffset !== null && this.#incomingOffset >= this.#incomingFinOffset) {
      this.#incoming.close();
      this.#maybeClose();
    }
  }
  #refreshAccumulatedStats(): void {
    let bytes = 0;
    for (const segment of this.#incomingSegments) bytes += segment.data.byteLength;
    this.#stats.bytesAccumulated = bytes;
    this.#stats.maxBytesAccumulated = Math.max(this.#stats.maxBytesAccumulated, bytes);
  }
  _resetFromConnection(errorCode: number): void {
    const error = new Error(`QUIC stream reset: ${errorCode}`);
    if (!this.#readStopped) this.#incoming.error(error);
    publishQuicTopic('quic.stream.reset', {
      stream: this,
      connection: this.#connection,
      error,
      errorCode
    });
    deferAfterNativeCallback(() => this.dispatchEvent(new QuicStreamResetEvent('reset', {
      error,
      errorCode
    })));
    if (this.#readStopped) {
      this.#maybeClose();
      return;
    }
    this.#finish(error);
  }
  _blockedFromConnection(): void {
    deferAfterNativeCallback(() => this.dispatchEvent(new QuicStreamBlockedEvent('blocked', {
      stream: this,
      connection: this.#connection,
      streamId: this.id
    })));
  }
  _stopSendingFromConnection(errorCode: number): void {
    this.writer._closeFromStopSending();
    deferAfterNativeCallback(() => this.dispatchEvent(new QuicStopSendingEvent('stopsending', { errorCode })));
    this.#maybeClose();
  }
  _stopSendingSentFromConnection(errorCode: number): void {
    deferAfterNativeCallback(() => this.dispatchEvent(new QuicStopSendingEvent('stopsending', { errorCode })));
  }
  _writerClosed(): boolean {
    return this.writer.closed;
  }
  _recordQueuedWrite(bytes: number): void {
    this.#stats.bytesSent += bytes;
    this.#stats.maxOffsetSent += bytes;
    this.#stats.maxOffset = this.#stats.maxOffsetSent;
  }
  _recordAck(offset: number, datalen: number): void {
    this.#stats.ackedAt = Date.now();
    this.#stats.bytesAcked += datalen;
    this.#stats.maxOffsetAcked = Math.max(this.#stats.maxOffsetAcked, offset + datalen);
  }
  _closeFromConnection(error?: Error): void {
    if (error !== undefined && (this.#incomingFinOffset === null || this.#incomingOffset < this.#incomingFinOffset)) {
      this.#incoming.error(error);
    } else {
      this.#incoming.close();
    }
    this.#finish(error);
  }
  #closeReadable(): void {
    this.#incoming.close();
    this.#maybeClose();
  }
  #closeWritable(): void {
    this.#maybeClose();
  }
  #readEofConsumed(): boolean {
    return this.#incomingFinOffset !== null && this.#incomingOffset >= this.#incomingFinOffset;
  }
  #maybeClose(): void {
    const readClosed = !this.#readableSide || this.reader.closed || this.#readEofConsumed();
    const writeClosed = !this.#writableSide || this.writer.closed;
    if (readClosed && writeClosed) this.#finish();
  }
  #finish(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stats.destroyedAt = Date.now();
    this.#connection._removeStream(this);
    publishQuicTopic('quic.stream.closed', {
      stream: this,
      connection: this.#connection,
      error,
      stats: this.stats
    });
    deferAfterNativeCallback(() => this.dispatchEvent(new Event('close')));
  }
}
