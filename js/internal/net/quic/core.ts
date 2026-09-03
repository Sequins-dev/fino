/**
 * internal:net/quic/endpoint — low-level QUIC over ngtcp2.
 *
 * This module implements the object model that `fino:net/quic` exposes: a
 * `QuicEndpoint` that owns one or more UDP sockets, `QuicListener`s created by
 * `listen()`, `QuicConnection`s created by `connect()` or accepted from the
 * server side, and the `QuicStream`s multiplexed inside each connection. It is
 * the engine room; application code should normally use the public
 * `fino:net/quic` wrapper and reach for this module only when it needs the raw
 * endpoint machinery (for example the HTTP/3 driver, which drives connections
 * and streams directly).
 *
 * The design is deliberately thin over ngtcp2. ngtcp2 owns QUIC packet parsing,
 * loss recovery, congestion control, stream and connection flow control, ACK
 * handling, and all protocol timers; this module owns the UDP I/O loop, the TLS
 * crypto backend wiring, the connection-ID routing table, server address
 * validation (Retry, NEW_TOKEN, rate limiting, source-address filtering), and
 * the translation between ngtcp2 callbacks and the JS event/stream surface. It
 * does not use the high-level QUIC transport APIs some TLS libraries ship; the
 * TLS library is reached only through ngtcp2's crypto helper backend.
 *
 * Availability is gated on both an ngtcp2 build and a working crypto backend —
 * check `quicAvailable` (or call `requireQuic()`) before constructing an
 * endpoint. Everything is driven by the runtime event loop; deterministic tests
 * inject a `QuicRuntime` clock and a `QuicDatagramTransportFactory` through the
 * endpoint's second `internals` argument.
 *
 * ```ts no_run
 * import { QuicEndpoint, quicAvailable } from 'internal:net/quic/endpoint';
 *
 * if (!quicAvailable) throw new Error('this build has no QUIC support');
 *
 * // Server: accept connections and echo each bidirectional stream.
 * const server = new QuicEndpoint({ alpnProtocols: ['h3'] });
 * const listener = await server.listen({
 *   address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
 *   certificateFile: '/etc/tls/cert.pem',
 *   privateKeyFile: '/etc/tls/key.pem',
 * });
 * (async () => {
 *   for (;;) {
 *     const conn = await server.accept();
 *     const stream = await conn.acceptStream();
 *     for await (const chunk of stream.readable) await stream.writer.write(chunk);
 *   }
 * })();
 *
 * // Client: connect and open one stream.
 * const client = new QuicEndpoint({ alpnProtocols: ['h3'] });
 * const conn = await client.connect({ address: listener.address });
 * const stream = await conn.openBidirectionalStream();
 * await stream.writer.write(new TextEncoder().encode('hello'));
 * await stream.writer.close();
 * ```
 *
 * QUIC transport specification: https://www.rfc-editor.org/rfc/rfc9000
 *
 * @internal
 */
import { Event, EventTarget } from '../../../globals/eventtarget.ts';
import { atob } from '../../../globals/encoding.ts';
import { encodeUtf8 } from '../../encoding.ts';
import {
  BytesReader,
  BytesWriter,
  type BytesReadableState,
  type BytesWritableState,
  type ReadResult,
} from '../../stream.ts';
import * as loop from '../../runtime/loop.ts';
import { topic } from '../../../context/topic.ts';
import {
  lib as fileLib,
  cstr as fileCstr,
  O_APPEND,
  O_CREAT,
  O_TRUNC,
  O_WRONLY,
} from '../../file/bindings.ts';
import {
  AF_INET,
  AF_INET6,
  EAGAIN,
  IPPROTO_IP,
  IPPROTO_IPV6,
  IPPROTO_UDP,
  IPV6_UNICAST_HOPS,
  IPV6_RECVTCLASS,
  IPV6_V6ONLY,
  IP_RECVTOS,
  IP_TTL,
  SOL_SOCKET,
  SO_RCVBUF,
  SO_REUSEPORT,
  SO_SNDBUF,
  SOCK_DGRAM,
  bind as socketBind,
  close as socketClose,
  createDatagramRecvBatch,
  decodeAddr,
  encodeAddr,
  getsockname,
  recvmsgEcn,
  recvfrom,
  sendmmsgBatch,
  sendmsgEcn,
  sendto,
  setNonblocking,
  setsockopt,
  socket,
} from '../../../net/socket.ts';
import type { DatagramRecvBatch } from '../../../net/socket.ts';
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
import type { QuicConnection } from './connection.ts';
import type { QuicListener } from './listener.ts';
import type { QuicStream } from './stream.ts';
export type { QuicCaOptions } from './ngtcp2/crypto.ts';
/**
 * A UDP socket address: an IP literal, its port, and its address family.
 *
 * This is the currency of every QUIC path. Endpoints bind to a `QuicAddress`,
 * connections carry a local and remote one, and migration and preferred-address
 * handling exchange them. The `ip` field is an unresolved literal (no DNS is
 * performed here); `family` must agree with the literal — an IPv4 dotted-quad
 * pairs with `'ipv4'` and a bracketless IPv6 literal with `'ipv6'`. A `port` of
 * `0` requests an ephemeral port, and the actual port chosen by the OS is read
 * back from the bound listener or connection address.
 *
 * ```ts no_run
 * const addr: QuicAddress = { family: 'ipv4', ip: '127.0.0.1', port: 4433 };
 * ```
 */
export type QuicAddress = {
  family: 'ipv4' | 'ipv6';
  ip: string;
  port: number;
};
export const _PTR_SIZE = 8;
export const _QUIC_PTR_PATH = 0;
export const _QUIC_PTR_PKT_INFO = 1;
export const _QUIC_PTR_DATA_LEN = 2;
export const _QUIC_PTR_VEC = 3;
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
export type QuicTlsCipherSuite =
  | 'TLS_AES_128_GCM_SHA256'
  | 'TLS_AES_256_GCM_SHA384'
  | 'TLS_CHACHA20_POLY1305_SHA256';
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
/**
 * Storage interface used by resumption and replay-checked 0-RTT policies.
 *
 * Supplied as `sessionStore` in endpoint/connect options. On `connect()` the
 * client loads any state keyed by server name and ALPN; when the server issues
 * a session ticket or address-validation token it is saved back. Every method
 * may be synchronous or async — the driver awaits the result — so a store can
 * be an in-memory `Map` or a shared cache.
 *
 * ```ts no_run
 * import type { QuicSessionStore, QuicSessionState } from 'internal:net/quic/endpoint';
 *
 * const map = new Map<string, QuicSessionState>();
 * const store: QuicSessionStore = {
 *   load: (key) => map.get(key) ?? null,
 *   save: (key, state) => { map.set(key, state); },
 *   delete: (key) => { map.delete(key); },
 * };
 *
 * const conn = await endpoint.connect({ address, sessionStore: store });
 * ```
 */
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
export type QuicRetryOptions =
  | false
  | {
      /** Whether this endpoint should require address validation with Retry. */
      enabled: boolean;
      /** Optional token secret. If omitted, implementations may generate one. */
      tokenSecret?: Uint8Array;
    };
/**
 * Server preferred address advertised to clients for post-handshake migration.
 *
 * A single `QuicAddress` advertises one preferred address whose family matches
 * it; the object form advertises an IPv4 and/or IPv6 preferred address pair so
 * a dual-stack client can migrate to the address in its own family. The server
 * binds an extra UDP socket per advertised address, so these must be addresses
 * the endpoint can actually bind.
 */
export type QuicPreferredAddressOptions =
  | QuicAddress
  | {
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
  /** Maximum blocked local stream-open calls queued for peer credit. */
  maxPendingStreamOpens?: number;
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
export type QuicRateLimitOptions =
  | false
  | {
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
export type QuicQlogOptions =
  | false
  | {
      /** Directory or file path for qlog output, depending on implementation policy. */
      path?: string;
    };
/** TLS keylog diagnostics configuration. Disabled by default. */
export type QuicKeylogOptions =
  | false
  | {
      /** File path for SSLKEYLOGFILE-compatible output. */
      path: string;
    };
/**
 * Endpoint-wide defaults inherited by every `listen()` and `connect()` call.
 *
 * These are the baseline for the endpoint. A `QuicListenOptions` or
 * `QuicConnectOptions` passed to `listen()`/`connect()` is resolved against
 * these defaults, so a value set here applies to every listener and connection
 * on the endpoint unless the per-call options override it. Only `socket` is
 * endpoint-only (it configures the UDP sockets themselves and cannot be
 * overridden per connection).
 *
 * ```ts no_run
 * import { QuicEndpoint } from 'internal:net/quic/endpoint';
 *
 * const endpoint = new QuicEndpoint({
 *   alpnProtocols: ['h3'],
 *   versions: ['v1', 'v2'],
 *   datagrams: { enabled: true },
 *   connection: { maxIdleTimeoutMs: 30_000 },
 *   socket: { reusePort: true },
 * });
 * ```
 */
export interface QuicEndpointOptions {
  /** Default ALPN protocol list offered/accepted; defaults to `['h3', 'fino-hq']`. */
  alpnProtocols?: string[];
  /** QUIC wire versions to enable; order expresses preference. */
  versions?: QuicVersion[];
  /** Restrict the TLS 1.3 cipher suites offered for QUIC packet protection. */
  tlsCipherSuites?: QuicTlsCipherSuite[];
  /** Named key-exchange groups (curves) to offer, in preference order. */
  tlsGroups?: string[];
  /** Server Retry / address-validation policy. Enabled by default. */
  retry?: QuicRetryOptions;
  /** Store used to persist and resume TLS session state for 0-RTT/resumption. */
  sessionStore?: QuicSessionStore;
  /** 0-RTT early-data policy; `false` (default) disables early data. */
  earlyData?: false | QuicEarlyDataPolicy;
  /** Connection migration and preferred-address policy. */
  migration?: QuicMigrationOptions;
  /** RFC 9221 DATAGRAM negotiation and queueing settings. */
  datagrams?: QuicDatagramOptions;
  /** Per-connection transport tuning (windows, timeouts, congestion control). */
  connection?: QuicConnectionOptions;
  /** Server-side packet defenses and connection limits. */
  transport?: QuicTransportOptions;
  /** qlog diagnostics output. Disabled by default. */
  qlog?: QuicQlogOptions;
  /** TLS keylog (SSLKEYLOGFILE) diagnostics. Disabled by default. */
  keylog?: QuicKeylogOptions;
  /** UDP socket tuning applied to every socket this endpoint binds. */
  socket?: QuicSocketOptions;
}
/**
 * Low-level UDP socket tuning applied to every socket an endpoint binds.
 *
 * These map directly onto `setsockopt` calls made when the endpoint binds a
 * datagram socket. They affect all listeners and the ephemeral client sockets
 * alike, and cannot be changed per connection.
 */
export type QuicSocketOptions = {
  /** For IPv6 sockets, refuse IPv4-mapped addresses (sets `IPV6_V6ONLY`). */
  ipv6Only?: boolean;
  /** Enable `SO_REUSEPORT` so multiple endpoints can share a port for load spreading. */
  reusePort?: boolean;
  /** Requested `SO_RCVBUF` receive buffer size in bytes. */
  receiveBufferSize?: number;
  /** Requested `SO_SNDBUF` send buffer size in bytes. */
  sendBufferSize?: number;
  /** Outgoing packet TTL / hop limit. */
  ttl?: number;
};
/**
 * Options for a single `QuicEndpoint.listen()` call.
 *
 * `certificateFile` and `privateKeyFile` are mandatory — `listen()` throws a
 * `TypeError` without them. Every other field is optional and, when omitted,
 * inherits the endpoint's `QuicEndpointOptions` default. The TLS and transport
 * fields shared with the endpoint (`versions`, `retry`, `datagrams`, and so on)
 * override the endpoint default for connections accepted by this listener only.
 *
 * ```ts no_run
 * const listener = await endpoint.listen({
 *   address: { family: 'ipv4', ip: '0.0.0.0', port: 4433 },
 *   certificateFile: '/etc/tls/cert.pem',
 *   privateKeyFile: '/etc/tls/key.pem',
 *   alpnProtocols: ['h3'],
 *   clientAuth: 'request',
 *   sni: {
 *     'api.example.com': {
 *       certificateFile: '/etc/tls/api-cert.pem',
 *       privateKeyFile: '/etc/tls/api-key.pem',
 *     },
 *   },
 * });
 * ```
 */
export interface QuicListenOptions {
  /** Local address to bind; a port of `0` requests an ephemeral port. */
  address?: QuicAddress;
  /** ALPN protocols this listener accepts; overrides the endpoint default. */
  alpnProtocols?: string[];
  /** Path to the PEM server certificate chain. Required. */
  certificateFile?: string;
  /** Path to the PEM server private key. Required. */
  privateKeyFile?: string;
  /** Whether client certificates are requested or required during the handshake. */
  clientAuth?: 'none' | 'request' | 'require';
  /** Request a client certificate; shorthand that maps onto `clientAuth`. */
  verifyClient?: boolean;
  /** Fail the handshake when a presented client certificate does not verify. */
  rejectUnauthorized?: boolean;
  /** Trust anchors used to verify client certificates. */
  ca?: QuicCaOptions;
  /** Per-server-name TLS contexts selected by the client's SNI value. */
  sni?: Record<string, QuicSNIContextOptions>;
  /** QUIC wire versions this listener accepts. */
  versions?: QuicVersion[];
  /** TLS 1.3 cipher suites offered by this listener. */
  tlsCipherSuites?: QuicTlsCipherSuite[];
  /** Named key-exchange groups offered by this listener. */
  tlsGroups?: string[];
  /** Retry / address-validation policy for this listener. */
  retry?: QuicRetryOptions;
  /** Session store used for this listener's resumption state. */
  sessionStore?: QuicSessionStore;
  /** 0-RTT early-data policy for connections accepted by this listener. */
  earlyData?: false | QuicEarlyDataPolicy;
  /** Migration / preferred-address policy advertised to accepted clients. */
  migration?: QuicMigrationOptions;
  /** DATAGRAM negotiation settings for this listener. */
  datagrams?: QuicDatagramOptions;
  /** Per-connection transport tuning for accepted connections. */
  connection?: QuicConnectionOptions;
  /** Server packet defenses and connection limits for this listener. */
  transport?: QuicTransportOptions;
  /** qlog diagnostics for connections accepted by this listener. */
  qlog?: QuicQlogOptions;
  /** TLS keylog diagnostics for connections accepted by this listener. */
  keylog?: QuicKeylogOptions;
}
/**
 * TLS context for one server name, selected by the client's SNI extension.
 *
 * Supplied through `QuicListenOptions.sni` (or `QuicListener.setSNIContexts`),
 * keyed by the server name it serves. `certificateFile` and `privateKeyFile`
 * are required; the remaining fields default to the listener's own values when
 * omitted, so an SNI entry can share the listener's ALPN and client-auth policy
 * while presenting a different certificate.
 */
export type QuicSNIContextOptions = {
  /** Path to the PEM certificate chain presented for this server name. */
  certificateFile: string;
  /** Path to the PEM private key for this server name. */
  privateKeyFile: string;
  /** ALPN protocols for this server name; defaults to the listener's list. */
  alpnProtocols?: string[];
  /** Named key-exchange groups for this server name. */
  tlsGroups?: string[];
  /** Client-certificate policy for this server name. */
  clientAuth?: 'none' | 'request' | 'require';
  /** Request a client certificate for this server name. */
  verifyClient?: boolean;
  /** Reject unverified client certificates for this server name. */
  rejectUnauthorized?: boolean;
  /** Trust anchors used to verify client certificates for this server name. */
  ca?: QuicCaOptions;
};
/**
 * Options for a single `QuicEndpoint.connect()` call.
 *
 * `address` is the only required field — it names the server to dial. When
 * `serverName` is omitted it defaults to `'localhost'`; it is used both for SNI
 * and for certificate verification when `verifyPeer` is set. Peer verification
 * is opt-in: `verifyPeer` defaults to `false`, so callers dialing untrusted or
 * self-signed servers get a working connection, and production clients should
 * set it to `true` (optionally with `ca` trust anchors). Every non-address
 * field inherits the endpoint default when omitted.
 *
 * ```ts no_run
 * const conn = await endpoint.connect({
 *   address: { family: 'ipv4', ip: '203.0.113.10', port: 4433 },
 *   serverName: 'example.com',
 *   verifyPeer: true,
 *   alpnProtocols: ['h3'],
 * });
 * ```
 */
export interface QuicConnectOptions {
  /** Remote server address to dial. Required. */
  address: QuicAddress;
  /** ALPN protocols offered to the server; overrides the endpoint default. */
  alpnProtocols?: string[];
  /** SNI / certificate-verification hostname; defaults to `'localhost'`. */
  serverName?: string;
  /** Verify the server certificate against the trust store. Defaults to `false`. */
  verifyPeer?: boolean;
  /** Path to a PEM client certificate chain for mutual TLS. */
  certificateFile?: string;
  /** Path to the PEM client private key for mutual TLS. */
  privateKeyFile?: string;
  /** Trust anchors used to verify the server certificate. */
  ca?: QuicCaOptions;
  /** QUIC wire versions offered, in preference order. */
  versions?: QuicVersion[];
  /** TLS 1.3 cipher suites offered to the server. */
  tlsCipherSuites?: QuicTlsCipherSuite[];
  /** Named key-exchange groups offered to the server. */
  tlsGroups?: string[];
  /** Retry-token handling for this connection. */
  retry?: QuicRetryOptions;
  /** Session store consulted for resumption/0-RTT state, keyed by server name and ALPN. */
  sessionStore?: QuicSessionStore;
  /** 0-RTT early-data policy for this connection. */
  earlyData?: false | QuicEarlyDataPolicy;
  /** Migration policy, including whether active migration is permitted. */
  migration?: QuicMigrationOptions;
  /** DATAGRAM negotiation settings for this connection. */
  datagrams?: QuicDatagramOptions;
  /** Per-connection transport tuning. */
  connection?: QuicConnectionOptions;
  /** Transport-level controls (mostly server-side; ECN applies to clients too). */
  transport?: QuicTransportOptions;
  /** qlog diagnostics for this connection. */
  qlog?: QuicQlogOptions;
  /** TLS keylog diagnostics for this connection. */
  keylog?: QuicKeylogOptions;
}
export type QueueResolver<T> = {
  resolve(value: T): void;
  reject(error: Error): void;
};
/** Cancellation controls for opening a locally initiated QUIC stream. */
export type QuicStreamOpenOptions = {
  /** Abort while waiting for peer stream credit. */
  signal?: AbortSignal;
};
export type QuicConnectionState = 'connecting' | 'connected' | 'closing' | 'closed';
/**
 * Parameters for a graceful or immediate QUIC connection close.
 *
 * Passed to `QuicConnection.close()`, `QuicConnection.destroy()`, and
 * `QuicEndpoint.closeGracefully()`. `errorCode` defaults to `0` (no error) and
 * must be a non-negative finite number, or normalization throws a `RangeError`.
 * `type` selects the CONNECTION_CLOSE frame flavor: `'application'` (the
 * default) carries an application error code, `'transport'` a QUIC transport
 * error code. `reason` defaults to the empty string.
 */
export type QuicCloseOptions = {
  /** Non-negative error code sent in the CONNECTION_CLOSE frame; defaults to `0`. */
  errorCode?: number;
  /** Whether the close is an application or transport-level close; defaults to `'application'`. */
  type?: 'transport' | 'application';
  /** Human-readable close reason; defaults to `''`. */
  reason?: string;
};
/**
 * Resolved details of why a connection closed, read from `QuicConnection.closeInfo`.
 *
 * Available once the connection has entered its closing/closed state. `remote`
 * distinguishes a peer-initiated close (a received CONNECTION_CLOSE) from a
 * local one.
 */
export type QuicCloseInfo = {
  /** Error code carried by the CONNECTION_CLOSE frame. */
  errorCode: number;
  /** Human-readable reason, or the empty string when none was given. */
  reason: string;
  /** Whether the code is an application or transport error code. */
  type: 'transport' | 'application';
  /** True when the peer initiated the close; false for a local close. */
  remote: boolean;
};
/**
 * Outcome of TLS certificate verification for the connected peer.
 *
 * Read from `QuicConnection.peerVerification` after the handshake. `verified`
 * is true when the peer presented a certificate that passed verification;
 * otherwise `errorCode`/`reason` describe the verification failure.
 */
export type QuicPeerVerification = {
  /** True when the peer certificate chain verified successfully. */
  verified: boolean;
  /** TLS verification result code; `0` on success. */
  errorCode: number;
  /** Human-readable verification failure reason, or `null` on success. */
  reason: string | null;
};
export type ResolvedRetryOptions =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      tokenSecret?: Uint8Array;
    };
export type ResolvedPreferredAddressOptions = {
  ipv4?: QuicAddress;
  ipv6?: QuicAddress;
};
export type ResolvedMigrationOptions = {
  enabled: boolean;
  preferredAddress?: ResolvedPreferredAddressOptions;
  usePreferredAddress: boolean;
};
/** Delivery state for a locally sent QUIC DATAGRAM frame. */
export type QuicDatagramStatus = 'ack' | 'lost' | 'abandoned';
/**
 * How to decode a string payload passed to `QuicConnection.sendDatagram()`.
 *
 * Only applies when the payload is a string; binary payloads
 * (`ArrayBuffer`/typed array) are sent verbatim. Defaults to `'utf8'`.
 */
export type QuicDatagramEncoding = 'utf8' | 'hex' | 'base64';
export type QuicDatagramBytes = string | ArrayBuffer | ArrayBufferView;
/**
 * Payload accepted by `QuicConnection.sendDatagram()`.
 *
 * A string (decoded per the `QuicDatagramEncoding` argument), raw bytes, or a
 * promise resolving to either — the connection awaits the promise before
 * framing the DATAGRAM, so a value can be produced lazily at send time.
 */
export type QuicDatagramSource = QuicDatagramBytes | PromiseLike<QuicDatagramBytes>;
export type ResolvedDatagramOptions = {
  enabled: boolean;
  maxFrameSize: number;
  maxPending: number;
  dropPolicy: 'drop-oldest' | 'drop-newest';
  maxSendAttempts: number;
};
export type ResolvedConnectionOptions = {
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
  maxPendingStreamOpens: number;
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
export type ResolvedRateLimitOptions = {
  rate: number;
  burst: number;
};
export type ResolvedTransportOptions = {
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
/**
 * Frozen view of a resolved token-bucket rate limit.
 *
 * Exposed inside `QuicResolvedTransportOptions` so callers can inspect the
 * effective packet-defense limits after endpoint defaults have been applied.
 */
export type QuicResolvedRateLimitOptions = {
  /** Tokens replenished per second. */
  readonly rate: number;
  /** Maximum burst tokens before throttling engages. */
  readonly burst: number;
};
/**
 * Frozen view of the resolved source-address allow/deny lists.
 *
 * `allow` is `null` when no allow-list was configured (all sources permitted
 * unless denied); otherwise only the listed keys are permitted. `deny` always
 * takes precedence over `allow`.
 */
export type QuicResolvedSourceAddressOptions = {
  /** Permitted source-address keys, or `null` when no allow-list is set. */
  readonly allow: readonly string[] | null;
  /** Source-address keys that are always blocked. */
  readonly deny: readonly string[];
};
/**
 * Frozen snapshot of an endpoint's resolved server-transport controls.
 *
 * Returned by `QuicEndpoint.transport`. Every field reflects the effective
 * value after endpoint defaults and per-call overrides were merged, with
 * millisecond timeouts denormalized back from ngtcp2's nanosecond internals.
 */
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
/**
 * Frozen snapshot of an endpoint's resolved per-connection transport tuning.
 *
 * Returned by `QuicEndpoint.connection`. It exposes the effective values with
 * timeouts and windows converted back to the millisecond/byte units of
 * `QuicConnectionOptions` (the internal representation is nanosecond/bigint).
 */
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
  readonly maxPendingStreamOpens: number;
  readonly cidLength: number;
};
export type ResolvedQuicOptions = {
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
export function normalizeCloseOptions(options: QuicCloseOptions = {}): Required<QuicCloseOptions> {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('QUIC close options must be an object');
  }
  const errorCode = options.errorCode ?? 0;
  if (!Number.isFinite(errorCode) || errorCode < 0)
    throw new RangeError('QUIC close errorCode must be a non-negative finite number');
  const type = options.type ?? 'application';
  if (type !== 'application' && type !== 'transport') {
    throw new TypeError('QUIC close type must be "application" or "transport"');
  }
  return {
    errorCode: Math.floor(errorCode),
    type,
    reason: options.reason ?? '',
  };
}
/**
 * Aggregate counters for one `QuicEndpoint`, read from `QuicEndpoint.stats`.
 *
 * Each read returns a frozen snapshot. Alongside packet/byte totals it records
 * how the endpoint's server-side defenses behaved: how many packets were
 * dropped by source-address filtering, rejected while busy or over the
 * connection limit, and how the Retry, Version Negotiation, stateless-reset,
 * immediate-close, and session-creation rate limiters fired. `destroyedAt` is
 * `null` until the endpoint is closed. The `active*` fields are live gauges;
 * the rest are monotonic counters.
 */
export type QuicEndpointStats = {
  /** Millisecond epoch when the endpoint was created. */
  createdAt: number;
  /** Millisecond epoch when the endpoint was closed, or `null` while open. */
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
/**
 * Per-connection counters and recovery metrics, read from `QuicConnection.stats`.
 *
 * Each read returns a frozen snapshot refreshed from ngtcp2's live connection
 * info, so the RTT, congestion-window, bytes-in-flight, and loss fields track
 * the current recovery state rather than lifetime totals. Timestamps are
 * millisecond epochs and are `null` until the corresponding milestone occurs
 * (`connectedAt` on handshake completion, `closingAt`/`destroyedAt` on close).
 * Stream and datagram counts are lifetime totals for the connection.
 */
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
/**
 * Per-stream byte and offset counters, read from `QuicStream.stats`.
 *
 * Each read returns a frozen snapshot. `finalSize` is `null` until the stream's
 * final size is known (a FIN was received or the stream was reset). The
 * `maxOffset*` fields track how far each end of the stream has progressed, and
 * `bytesAccumulated`/`maxBytesAccumulated` report current and peak buffered
 * receive bytes so a slow reader's backlog is visible. Closing the local writer
 * only commits a FIN; acknowledgement fields advance later from ngtcp2's peer
 * ACK notifications.
 */
export type QuicStreamStats = {
  readonly createdAt: number;
  readonly openedAt: number | null;
  readonly receivedAt: number | null;
  /** Millisecond epoch of the most recent peer acknowledgement, or `null`. */
  readonly ackedAt: number | null;
  readonly destroyedAt: number | null;
  readonly bytesReceived: number;
  readonly bytesSent: number;
  /** Sent payload bytes acknowledged by the peer transport. */
  readonly bytesAcked: number;
  readonly finalSize: number | null;
  readonly maxOffset: number;
  /** Greatest exclusive stream offset acknowledged by the peer transport. */
  readonly maxOffsetAcked: number;
  readonly maxOffsetReceived: number;
  readonly maxOffsetSent: number;
  readonly bytesAccumulated: number;
  readonly maxBytesAccumulated: number;
};
/**
 * Decoded QUIC transport parameters for one side of a connection.
 *
 * Returned by `QuicConnection.localTransportParameters` and
 * `.remoteTransportParameters` (both `null` before the native connection
 * exists). It exposes the negotiated flow-control limits, idle timeout, ACK
 * tuning, migration flag, advertised preferred address, and the connection-ID
 * fields QUIC uses to bind the handshake — including the byte-array CIDs, each
 * `null` when the peer did not send it.
 */
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
 * ```ts no_run
 * import { QuicEndpoint, type QuicRuntime } from 'internal:net/quic/endpoint';
 *
 * let virtualNs = 0n;
 * const runtime: QuicRuntime = {
 *   nowNs: () => virtualNs,
 *   setTimer: (delayMs, cb) => { const id = setTimeout(cb, delayMs); return { cancel: () => clearTimeout(id) }; },
 *   defer: (cb) => { queueMicrotask(cb); },
 * };
 * const endpoint = new QuicEndpoint({}, { runtime });
 * ```
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
export type QuicDatagramPathMetadata = {
  localSockaddr: ArrayBuffer;
  localSockaddrLen: number;
  remoteSockaddr: ArrayBuffer;
  remoteSockaddrLen: number;
};
export type QuicDatagramPacket = {
  data: Uint8Array;
  addr?: QuicAddress;
  ecn?: number;
  path?: QuicDatagramPathMetadata;
};
export type QuicDatagramPacketCallback = (
  data: Uint8Array,
  addr: QuicAddress | undefined,
  ecn: number | undefined,
  path: QuicDatagramPathMetadata | undefined,
) => void;
/**
 * Bound datagram transport used by the ngtcp2 endpoint driver.
 *
 * Implementations may wrap a real UDP socket or an in-memory simulator
 * datagram endpoint. `recvNow()` is nonblocking and returns `null` when no
 * packet is currently readable; callers use `waitReadable()` to suspend until
 * another packet may be available. The optional `recvBatch`/`recvBatchEach` and
 * `sendBatch` methods let an implementation move several packets per syscall;
 * the driver falls back to the single-packet methods when they are absent.
 *
 * ```ts no_run
 * import type { QuicDatagramTransport } from 'internal:net/quic/endpoint';
 *
 * async function drain(transport: QuicDatagramTransport) {
 *   while (!transport.closed) {
 *     let packet = transport.recvNow(1200);
 *     while (packet !== null) {
 *       handle(packet.data, packet.addr);
 *       packet = transport.recvNow(1200);
 *     }
 *     await transport.waitReadable();
 *   }
 * }
 * ```
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
  recvNow(maxBytes: number): QuicDatagramPacket | null;
  /** Read up to `maxPackets` packets if available, or return an empty array. */
  recvBatch?(maxPackets: number, maxBytes: number): QuicDatagramPacket[];
  /** Read up to `maxPackets` packets and invoke `callback` for each packet. */
  recvBatchEach?(
    maxPackets: number,
    maxBytes: number,
    callback: QuicDatagramPacketCallback,
  ): number;
  /** Resolve once the transport may have data to read. */
  waitReadable(): Promise<void>;
  /** Try to send one datagram immediately, returning bytes written or errno. */
  sendNow(data: Uint8Array, dest: QuicAddress, ecn?: number): number;
  /** Try to send several datagrams immediately, preserving packet order. */
  sendBatch?(
    packets: Array<{
      data: Uint8Array;
      dest: QuicAddress;
      ecn?: number;
    }>,
  ): {
    sent: number;
    errno: number | null;
  };
  /** Resolve once the transport may be writable after send pressure. */
  waitWritable(): Promise<void>;
  /** Close the transport and release its resources. */
  close(): void;
}
/**
 * Factory that binds QUIC datagram transports for an endpoint.
 *
 * The endpoint calls `bind()` for every socket it needs: each listener address,
 * each advertised preferred address, and one ephemeral socket per outgoing
 * client connection. Injecting a factory through `QuicEndpointInternals` lets a
 * test replace the real UDP layer wholesale while the endpoint logic is
 * unchanged.
 *
 * ```ts no_run
 * import { QuicEndpoint, type QuicDatagramTransportFactory } from 'internal:net/quic/endpoint';
 *
 * const transportFactory: QuicDatagramTransportFactory = {
 *   bind: (address) => openSimulatedSocket(address),
 * };
 * const endpoint = new QuicEndpoint({}, { transportFactory });
 * ```
 *
 * @internal
 */
export interface QuicDatagramTransportFactory {
  /** Bind a transport to `address`, resolving with the actual local address (ephemeral ports resolved). */
  bind(
    address: QuicAddress,
    options?: {
      ecn?: boolean;
    },
  ): Promise<QuicDatagramTransport>;
}
/**
 * Optional test-only dependencies for `QuicEndpoint`.
 *
 * These hooks are intentionally not part of the stable public QUIC API. They
 * let deterministic simulator tests replace UDP sockets and wall-clock timers
 * while preserving the public `fino:net/quic` behavior for normal callers.
 * They are passed as the second argument to the `QuicEndpoint` constructor.
 *
 * ```ts no_run
 * import { QuicEndpoint, type QuicEndpointInternals } from 'internal:net/quic/endpoint';
 *
 * const internals: QuicEndpointInternals = {
 *   transportFactory,
 *   runtime,
 *   clientBindAddress: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
 * };
 * const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] }, internals);
 * ```
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
export type PreferredAddressEntry = {
  cid: ArrayBuffer;
  statelessResetToken: Uint8Array;
};
export type PreferredAddressParams = {
  ipv4?: PreferredAddressEntry & {
    address: QuicAddress;
  };
  ipv6?: PreferredAddressEntry & {
    address: QuicAddress;
  };
};
export const quicIncomingStreamHook = Symbol('fino.quic.incomingStreamHook');
export const quicBytesWriterInternals = {
  closeFromStopSending: Symbol('fino.quic.bytesWriter.closeFromStopSending'),
} as const;
export const quicEndpointInternals = {
  inspectAddressValidationStats: Symbol('fino.quic.endpoint.inspectAddressValidationStats'),
  bindTransport: Symbol('fino.quic.endpoint.bindTransport'),
  unregisterTransport: Symbol('fino.quic.endpoint.unregisterTransport'),
  transportById: Symbol('fino.quic.endpoint.transportById'),
  runtime: Symbol('fino.quic.endpoint.runtime'),
  recordDatagramSent: Symbol('fino.quic.endpoint.recordDatagramSent'),
  recordDatagramReceived: Symbol('fino.quic.endpoint.recordDatagramReceived'),
  track: Symbol('fino.quic.endpoint.track'),
  forgetConnectionRoutes: Symbol('fino.quic.endpoint.forgetConnectionRoutes'),
  accept: Symbol('fino.quic.endpoint.accept'),
  removeListener: Symbol('fino.quic.endpoint.removeListener'),
  registerStatelessResetToken: Symbol('fino.quic.endpoint.registerStatelessResetToken'),
  unregisterStatelessResetToken: Symbol('fino.quic.endpoint.unregisterStatelessResetToken'),
  storeAddressToken: Symbol('fino.quic.endpoint.storeAddressToken'),
  loadAddressToken: Symbol('fino.quic.endpoint.loadAddressToken'),
  handleDatagram: Symbol('fino.quic.endpoint.handleDatagram'),
} as const;
export const quicListenerInternals = {
  ctx: Symbol('fino.quic.listener.ctx'),
  start: Symbol('fino.quic.listener.start'),
} as const;
export const quicConnectionInternals = {
  isClosedForInternalUse: Symbol('fino.quic.connection.isClosedForInternalUse'),
  roleForStats: Symbol('fino.quic.connection.roleForStats'),
  wireVersionForRouting: Symbol('fino.quic.connection.wireVersionForRouting'),
  validationTokenTypeForRouting: Symbol('fino.quic.connection.validationTokenTypeForRouting'),
  drainingRetentionMsForRouting: Symbol('fino.quic.connection.drainingRetentionMsForRouting'),
  canReceiveWithoutDecodedAddress: Symbol('fino.quic.connection.canReceiveWithoutDecodedAddress'),
  matchesServerConnection: Symbol('fino.quic.connection.matchesServerConnection'),
  inspectLastDatagramEvent: Symbol('fino.quic.connection.inspectLastDatagramEvent'),
  inspectSendState: Symbol('fino.quic.connection.inspectSendState'),
  injectTransportCloseForTest: Symbol('fino.quic.connection.injectTransportCloseForTest'),
  isLocalUnidirectionalStream: Symbol('fino.quic.connection.isLocalUnidirectionalStream'),
  openBidirectionalStreamSync: Symbol('fino.quic.connection.openBidirectionalStreamSync'),
  openUnidirectionalStreamSync: Symbol('fino.quic.connection.openUnidirectionalStreamSync'),
  setSessionStoreKey: Symbol('fino.quic.connection.setSessionStoreKey'),
  setClientSessionOptions: Symbol('fino.quic.connection.setClientSessionOptions'),
  closeForCompatibleVersionUpgrade: Symbol('fino.quic.connection.closeForCompatibleVersionUpgrade'),
  setAddressValidationToken: Symbol('fino.quic.connection.setAddressValidationToken'),
  setEarlyDataDiagnostics: Symbol('fino.quic.connection.setEarlyDataDiagnostics'),
  setEarlyDataReady: Symbol('fino.quic.connection.setEarlyDataReady'),
  deferHandshakeForEarlyData: Symbol('fino.quic.connection.deferHandshakeForEarlyData'),
  scheduleEarlyDataEvent: Symbol('fino.quic.connection.scheduleEarlyDataEvent'),
  onSessionTicket: Symbol('fino.quic.connection.onSessionTicket'),
  setEarlyTransportParameters: Symbol('fino.quic.connection.setEarlyTransportParameters'),
  initClient: Symbol('fino.quic.connection.initClient'),
  initServer: Symbol('fino.quic.connection.initServer'),
  registerIssuedCid: Symbol('fino.quic.connection.registerIssuedCid'),
  unregisterIssuedCid: Symbol('fino.quic.connection.unregisterIssuedCid'),
  onDestinationCidStatus: Symbol('fino.quic.connection.onDestinationCidStatus'),
  onStatelessReset: Symbol('fino.quic.connection.onStatelessReset'),
  waitHandshake: Symbol('fino.quic.connection.waitHandshake'),
  onHandshakeCompleted: Symbol('fino.quic.connection.onHandshakeCompleted'),
  onHandshakeConfirmed: Symbol('fino.quic.connection.onHandshakeConfirmed'),
  startSocketLoop: Symbol('fino.quic.connection.startSocketLoop'),
  receivePacket: Symbol('fino.quic.connection.receivePacket'),
  reserveStreamData: Symbol('fino.quic.connection.reserveStreamData'),
  queueStreamData: Symbol('fino.quic.connection.queueStreamData'),
  driveWrites: Symbol('fino.quic.connection.driveWrites'),
  scheduleWrites: Symbol('fino.quic.connection.scheduleWrites'),
  scheduleStreamWriterFlush: Symbol('fino.quic.connection.scheduleStreamWriterFlush'),
  onRemoteStreamOpen: Symbol('fino.quic.connection.onRemoteStreamOpen'),
  onLocalStreamCredit: Symbol('fino.quic.connection.onLocalStreamCredit'),
  onStreamData: Symbol('fino.quic.connection.onStreamData'),
  onStreamDataCredit: Symbol('fino.quic.connection.onStreamDataCredit'),
  extendStreamReceiveCredit: Symbol('fino.quic.connection.extendStreamReceiveCredit'),
  extendConnectionReceiveCredit: Symbol('fino.quic.connection.extendConnectionReceiveCredit'),
  onStreamClose: Symbol('fino.quic.connection.onStreamClose'),
  onStreamReset: Symbol('fino.quic.connection.onStreamReset'),
  onStreamStopSending: Symbol('fino.quic.connection.onStreamStopSending'),
  onDatagram: Symbol('fino.quic.connection.onDatagram'),
  onDatagramStatus: Symbol('fino.quic.connection.onDatagramStatus'),
  onKeyInstalled: Symbol('fino.quic.connection.onKeyInstalled'),
  onVersionNegotiation: Symbol('fino.quic.connection.onVersionNegotiation'),
  onVersionNegotiationForTest: Symbol('fino.quic.connection.onVersionNegotiationForTest'),
  onNewToken: Symbol('fino.quic.connection.onNewToken'),
  onQlogWrite: Symbol('fino.quic.connection.onQlogWrite'),
  onEarlyDataRejected: Symbol('fino.quic.connection.onEarlyDataRejected'),
  onPathValidationStarted: Symbol('fino.quic.connection.onPathValidationStarted'),
  onPathValidationFinished: Symbol('fino.quic.connection.onPathValidationFinished'),
  selectPreferredAddress: Symbol('fino.quic.connection.selectPreferredAddress'),
  removeStream: Symbol('fino.quic.connection.removeStream'),
  onAckedStreamDataOffset: Symbol('fino.quic.connection.onAckedStreamDataOffset'),
} as const;
export const quicStreamInternals = {
  reserveWrite: Symbol('fino.quic.stream.reserveWrite'),
  queueWrite: Symbol('fino.quic.stream.queueWrite'),
  hasWritableSide: Symbol('fino.quic.stream.hasWritableSide'),
  readFinReceived: Symbol('fino.quic.stream.readFinReceived'),
  assertWritableSide: Symbol('fino.quic.stream.assertWritableSide'),
  scheduleWriterFlush: Symbol('fino.quic.stream.scheduleWriterFlush'),
  readIncoming: Symbol('fino.quic.stream.readIncoming'),
  extendStreamReceiveCredit: Symbol('fino.quic.stream.extendStreamReceiveCredit'),
  extendConnectionReceiveCredit: Symbol('fino.quic.stream.extendConnectionReceiveCredit'),
  pushIncoming: Symbol('fino.quic.stream.pushIncoming'),
  resetFromConnection: Symbol('fino.quic.stream.resetFromConnection'),
  blockedFromConnection: Symbol('fino.quic.stream.blockedFromConnection'),
  stopSendingFromConnection: Symbol('fino.quic.stream.stopSendingFromConnection'),
  stopSendingSentFromConnection: Symbol('fino.quic.stream.stopSendingSentFromConnection'),
  writerClosed: Symbol('fino.quic.stream.writerClosed'),
  recordQueuedWrite: Symbol('fino.quic.stream.recordQueuedWrite'),
  recordAck: Symbol('fino.quic.stream.recordAck'),
  closeFromConnection: Symbol('fino.quic.stream.closeFromConnection'),
} as const;
export const getConnPointerSlot = Symbol('fino.quic.callbackTable.getConnPointer');
export const STREAM_DATA_FLAG_FIN = 1;
export const TLS_ALERT_NO_APPLICATION_PROTOCOL = 120;
export const NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2 = 183;
export const NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2 = 256;
export const NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN = 41;
export const NGTCP2_STATELESS_RESET_TOKENLEN = 16;
export const NGTCP2_MIN_STATELESS_RESET_RANDLEN = 22;
export const NGTCP2_MIN_STATELESS_RESET_PACKETLEN = 41;
export const STATELESS_RESET_RANDLEN = NGTCP2_MIN_STATELESS_RESET_RANDLEN * 5;
export const DEFAULT_ADDRESS_LRU_SIZE = 1024;
export const DEFAULT_RETRY_RATE = 100;
export const DEFAULT_RETRY_BURST = 200;
export const DEFAULT_VERSION_NEGOTIATION_RATE = 100;
export const DEFAULT_VERSION_NEGOTIATION_BURST = 200;
export const DEFAULT_STATELESS_RESET_RATE = 100;
export const DEFAULT_STATELESS_RESET_BURST = 200;
export const DEFAULT_IMMEDIATE_CLOSE_RATE = 100;
export const DEFAULT_IMMEDIATE_CLOSE_BURST = 200;
export const DEFAULT_SESSION_CREATION_RATE = 50;
export const DEFAULT_SESSION_CREATION_BURST = 100;
export const DEFAULT_MAX_CONNECTIONS = 1e4;
export const DEFAULT_MAX_CONNECTIONS_PER_REMOTE_ADDRESS = 100;
export const DEFAULT_MAX_PENDING_DATAGRAMS = 128;
export const DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS = 5;
export const DEFAULT_DRAINING_PERIOD_MULTIPLIER = 3;
export const DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE = 1200;
export const NGTCP2_QLOG_WRITE_FLAG_FIN = 1;
export const NGTCP2_ENCRYPTION_LEVEL_1RTT = 2;
export const NGTCP2_MILLISECONDS = 1000000n;
export const NGTCP2_SECONDS = 1000000000n;
export const DEFAULT_STREAM_IDLE_TIMEOUT = 30n * NGTCP2_SECONDS;
export const DEFAULT_MAX_PENDING_STREAM_OPENS = 1024;
export const ADDRESS_VALIDATION_TIMEOUT = 60n * NGTCP2_SECONDS;
export const NGTCP2_NO_EXPIRY = (1n << 64n) - 1n;
export const MIGRATION_KEEP_ALIVE_TIMEOUT = NGTCP2_SECONDS / 2n;
export const MAX_RECEIVE_WINDOW = 16n * 1024n * 1024n;
export const INITIAL_MAX_STREAM_DATA = 256n * 1024n;
export const INITIAL_MAX_DATA = 1024n * 1024n;
export const INITIAL_MAX_STREAMS_BIDI = 100n;
export const INITIAL_MAX_STREAMS_UNI = 3n;
export const ACTIVE_CONNECTION_ID_LIMIT = 2n;
export const MAX_IDLE_TIMEOUT = 10n * NGTCP2_SECONDS;
export const HANDSHAKE_TIMEOUT = 10n * NGTCP2_SECONDS;
export const RETRY_TOKEN_TIMEOUT = 10n * NGTCP2_SECONDS;
export const REGULAR_TOKEN_TIMEOUT = 10n * NGTCP2_SECONDS;
export const MIN_TOKEN_TIMEOUT = 1n * NGTCP2_SECONDS;
export const MAX_RETRY_TOKEN_TIMEOUT = 60n * NGTCP2_SECONDS;
export const MAX_REGULAR_TOKEN_TIMEOUT = 5n * 60n * NGTCP2_SECONDS;
export const CONNECTION_DRAINING_TIMEOUT_MS = 3e3;
export const MAX_REJECTED_INITIAL_CIDS = 4096;
export const MAX_WRITE_PACKETS_PER_DRAIN = 32;
export const MAX_READ_PACKETS_PER_TURN = 5;
export const MAX_BATCH_READ_PACKETS_PER_TURN = 32;
export const NGTCP2_CONNECTION_REFUSED = 2;
export const VERSION_NEGOTIATION_GREASE = 168430090;
export const SOCKADDR_UNION_SIZE = 128;
export const DEFAULT_ALPN_PROTOCOLS = ['h3', 'fino-hq'];
export const QUIC_TLS_CIPHER_SUITES = new Set<string>([
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
]);
const _quicIdState = {
  connectionId: 1,
  nativeUserDataId: 1,
};
export const _nativeConnections = new Map<number, QuicConnection>();
export function allocateQuicConnectionId(role: 'client' | 'server'): string {
  return `${role}-${_quicIdState.connectionId++}`;
}
export function allocateNativeUserDataId(): number {
  return _quicIdState.nativeUserDataId++;
}
export let _nativeCallbackDepth = 0;
export let _deferredNativeTasks: Array<() => void> = [];
export let _deferredNativeFlushScheduled = false;
export function inNativeCallback(): boolean {
  return _nativeCallbackDepth > 0;
}
export function scheduleDeferredNativeTasks(): void {
  if (_deferredNativeFlushScheduled) return;
  _deferredNativeFlushScheduled = true;
  Promise.resolve().then(flushDeferredNativeTasks);
}
export function flushDeferredNativeTasks(): void {
  _deferredNativeFlushScheduled = false;
  if (_nativeCallbackDepth > 0) {
    scheduleDeferredNativeTasks();
    return;
  }
  const tasks = _deferredNativeTasks.splice(0);
  for (const task of tasks) task();
  if (_deferredNativeTasks.length > 0) scheduleDeferredNativeTasks();
}
export function deferAfterNativeCallback(task: () => void): void {
  if (_nativeCallbackDepth === 0) {
    task();
    return;
  }
  _deferredNativeTasks.push(task);
  scheduleDeferredNativeTasks();
}
export function publishQuicTopic(name: string, event: Record<string, unknown>): void {
  publishNetworkTopic(name, () => event);
}
export function publishNetworkTopic(
  name: string,
  createEvent: () => Record<string, unknown>,
): void {
  const channel = topic(name);
  if (!channel.hasSubscribers) return;
  channel.publish(Object.freeze({ ...createEvent() }));
}
export function runtimeDelay(runtime: QuicRuntime, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    runtime.setTimer(delayMs, resolve);
  });
}
export function withNativeCallback<T>(fn: () => T): T {
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
/**
 * Whether this build can run QUIC at all.
 *
 * True only when both an ngtcp2 library and a working TLS crypto backend were
 * found. Guard endpoint construction with this (or call `requireQuic()`, which
 * throws) before using anything else in the module.
 *
 * ```ts no_run
 * import { quicAvailable, QuicEndpoint } from 'internal:net/quic/endpoint';
 * if (!quicAvailable) throw new Error('QUIC unavailable in this build');
 * const endpoint = new QuicEndpoint();
 * ```
 */
export const quicAvailable = ngtcp2Available && cryptoAvailable;
/**
 * Whether the loaded ngtcp2 supports the reliable stream reset extension.
 *
 * When false, `QuicStream.resetAt()` throws because the native
 * `ngtcp2_conn_reset_stream_at` symbol is missing. `reset()` is always
 * available.
 */
export const quicResetStreamAtAvailable = ngtcp2ResetStreamAtAvailable;
/**
 * Identifier of the active TLS crypto backend, or `null` when QUIC is unavailable.
 *
 * Reports which ngtcp2 crypto helper is in use (for example the OpenSSL or
 * GnuTLS backend), useful for diagnostics and backend-specific test skips.
 */
export const cryptoBackend = quicAvailable ? _cryptoBackend : null;
/** The QUIC transport engine backing this module. Always `'ngtcp2'`. */
export const transportEngine = 'ngtcp2';
/**
 * Human-readable version string of the loaded ngtcp2 library, or `null` when
 * QUIC is unavailable.
 *
 * Resolves from `ngtcp2_version()` at module load; falls back to the bare
 * string `'ngtcp2'` when the library reports no readable version.
 */
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
export const realQuicRuntime: QuicRuntime = {
  nowNs(): bigint {
    return BigInt(Math.floor(performance.now() * 1e6));
  },
  setTimer(delayMs: number, callback: () => void): QuicTimerHandle {
    const timer = loop.timeout(delayMs);
    // The endpoint's UDP readiness owns transport liveness. Protocol clocks
    // should still fire while that transport is active, but must not keep a
    // Realm alive after its endpoint and sockets are gone.
    timer.unref();
    timer.then(callback, () => {});
    return {
      cancel() {
        timer.cancel?.();
      },
    };
  },
  defer(callback: () => void): void {
    Promise.resolve().then(callback);
  },
};
export class RealQuicDatagramTransport implements QuicDatagramTransport {
  readonly id: number;
  readonly address: QuicAddress;
  #fd: number;
  #ecn: boolean;
  #closed = false;
  #localSockaddr: ArrayBuffer;
  #localSockaddrLen: number;
  #recvPath: QuicDatagramPathMetadata;
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
    this.#recvPath = {
      localSockaddr: this.#localSockaddr,
      localSockaddrLen: this.#localSockaddrLen,
      remoteSockaddr: this.#localSockaddr,
      remoteSockaddrLen: this.#localSockaddrLen,
    };
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
    return received.ecn === undefined
      ? {
          data: received.data,
          addr,
        }
      : {
          data: received.data,
          addr,
          ecn: received.ecn,
        };
  }
  recvBatch(maxPackets: number, maxBytes: number): QuicDatagramPacket[] {
    if (
      this.#recvBatch === null ||
      this.#recvBatchPackets !== maxPackets ||
      this.#recvBatchBytes !== maxBytes
    ) {
      this.#recvBatch = createDatagramRecvBatch(maxPackets, maxBytes);
      this.#recvBatchPackets = maxPackets;
      this.#recvBatchBytes = maxBytes;
    }
    const received = this.#recvBatch?.recvRaw(this.#fd) ?? null;
    if (received !== null) {
      if (typeof received === 'number') {
        if (received === EAGAIN) return [];
        throw new Error(`QUIC UDP recvmmsg failed: ${received}`);
      }
      const packets: QuicDatagramPacket[] = [];
      for (const packet of received) {
        const path = {
          localSockaddr: this.#localSockaddr,
          localSockaddrLen: this.#localSockaddrLen,
          remoteSockaddr: packet.addrBuffer,
          remoteSockaddrLen: packet.addrLen,
        };
        packets.push(
          packet.ecn === undefined
            ? {
                data: packet.data,
                path,
              }
            : {
                data: packet.data,
                ecn: packet.ecn,
                path,
              },
        );
      }
      return packets;
    }
    const packets: QuicDatagramPacket[] = [];
    for (let i = 0; i < maxPackets; i++) {
      const packet = this.recvNow(maxBytes);
      if (packet === null) break;
      packets.push(packet);
    }
    return packets;
  }
  recvBatchEach(
    maxPackets: number,
    maxBytes: number,
    callback: QuicDatagramPacketCallback,
  ): number {
    if (
      this.#recvBatch === null ||
      this.#recvBatchPackets !== maxPackets ||
      this.#recvBatchBytes !== maxBytes
    ) {
      this.#recvBatch = createDatagramRecvBatch(maxPackets, maxBytes);
      this.#recvBatchPackets = maxPackets;
      this.#recvBatchBytes = maxBytes;
    }
    const received =
      this.#recvBatch?.recvRawEach(this.#fd, (data, addrBuffer, addrLen, ecn) => {
        this.#recvPath.remoteSockaddr = addrBuffer;
        this.#recvPath.remoteSockaddrLen = addrLen;
        callback(data, undefined, ecn, this.#recvPath);
      }) ?? null;
    if (received !== null) {
      if (received < 0) {
        if (received === EAGAIN) return 0;
        throw new Error(`QUIC UDP recvmmsg failed: ${received}`);
      }
      return received;
    }
    let packets = 0;
    for (; packets < maxPackets; packets++) {
      const packet = this.recvNow(maxBytes);
      if (packet === null) break;
      callback(packet.data, packet.addr, packet.ecn, packet.path);
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
  sendBatch(
    packets: Array<{
      data: Uint8Array;
      dest: QuicAddress;
      ecn?: number;
    }>,
  ): {
    sent: number;
    errno: number | null;
  } {
    const batchResult = sendmmsgBatch(this.#fd, packets);
    if (batchResult !== null) return batchResult;
    let sent = 0;
    for (const packet of packets) {
      const rc = this.sendNow(packet.data, packet.dest, packet.ecn);
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
export function normalizeSocketOptionInteger(
  input: number | undefined,
  min: number,
  max: number,
  name: string,
): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isInteger(input) || input < min || input > max) {
    throw new TypeError(`QUIC socket ${name} must be an integer between ${min} and ${max}`);
  }
  return input;
}
export function normalizeSocketOptions(
  input: QuicSocketOptions | undefined,
): Required<Pick<QuicSocketOptions, never>> & QuicSocketOptions {
  if (input === undefined) return {};
  return {
    ...(input.ipv6Only === undefined ? {} : { ipv6Only: input.ipv6Only === true }),
    ...(input.reusePort === undefined ? {} : { reusePort: input.reusePort === true }),
    ...(input.receiveBufferSize === undefined
      ? {}
      : {
          receiveBufferSize: normalizeSocketOptionInteger(
            input.receiveBufferSize,
            1,
            2147483647,
            'receiveBufferSize',
          ),
        }),
    ...(input.sendBufferSize === undefined
      ? {}
      : {
          sendBufferSize: normalizeSocketOptionInteger(
            input.sendBufferSize,
            1,
            2147483647,
            'sendBufferSize',
          ),
        }),
    ...(input.ttl === undefined
      ? {}
      : { ttl: normalizeSocketOptionInteger(input.ttl, 0, 255, 'ttl') }),
  };
}
export class RealQuicDatagramTransportFactory implements QuicDatagramTransportFactory {
  #socketOptions: QuicSocketOptions;
  constructor(socketOptions: QuicSocketOptions = {}) {
    this.#socketOptions = normalizeSocketOptions(socketOptions);
  }
  async bind(
    address: QuicAddress,
    options: {
      ecn?: boolean;
    } = {},
  ): Promise<QuicDatagramTransport> {
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
    if (this.#socketOptions.reusePort !== undefined)
      setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, this.#socketOptions.reusePort);
    if (this.#socketOptions.receiveBufferSize !== undefined)
      setsockopt(fd, SOL_SOCKET, SO_RCVBUF, this.#socketOptions.receiveBufferSize);
    if (this.#socketOptions.sendBufferSize !== undefined)
      setsockopt(fd, SOL_SOCKET, SO_SNDBUF, this.#socketOptions.sendBufferSize);
    if (family === 'ipv6' && this.#socketOptions.ipv6Only !== undefined)
      setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, this.#socketOptions.ipv6Only);
    if (ecn)
      setsockopt(
        fd,
        family === 'ipv6' ? IPPROTO_IPV6 : IPPROTO_IP,
        family === 'ipv6' ? IPV6_RECVTCLASS : IP_RECVTOS,
        true,
      );
    if (this.#socketOptions.ttl !== undefined) {
      setsockopt(
        fd,
        family === 'ipv6' ? IPPROTO_IPV6 : IPPROTO_IP,
        family === 'ipv6' ? IPV6_UNICAST_HOPS : IP_TTL,
        this.#socketOptions.ttl,
      );
    }
  }
}
export const realQuicDatagramTransportFactory = new RealQuicDatagramTransportFactory();
/**
 * Assert that QUIC is usable, throwing a descriptive error otherwise.
 *
 * Verifies both the ngtcp2 library and the TLS crypto backend are present.
 * `listen()` and `connect()` call this internally, so most callers rely on the
 * check indirectly; use it directly to fail fast before doing setup work.
 *
 * Throws when ngtcp2 or the crypto backend is missing from the build.
 *
 * ```ts no_run
 * import { requireQuic } from 'internal:net/quic/endpoint';
 * requireQuic(); // throws here if QUIC is unavailable
 * ```
 */
export function requireQuic(): void {
  requireNgtcp2();
  requireCrypto();
}
export class AsyncQueue<T> {
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
        reject,
      });
    });
  }
  // Remove and return all currently-buffered items without awaiting. Used to
  // hand a backlog to a consumer switching from the queue to a direct callback,
  // so items pushed before the callback was installed are not lost.
  drainBuffered(): T[] {
    if (this.#items.length === 0) return [];
    return this.#items.splice(0);
  }
  close(error: Error = this.#closeError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}
export class ByteQueue {
  #chunks: Uint8Array[] = [];
  #waiters: (QueueResolver<ReadResult<Uint8Array>> & {
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
    // The chunk is already a private, immutable JS buffer (materialized by
    // copyFromPtr in the ngtcp2 recv_stream_data callback); nothing mutates it
    // after this point, so store it by reference instead of copying again.
    const waiter = this.#waiters.shift();
    if (waiter) {
      this.#chunks.push(chunk);
      waiter.cleanup();
      waiter.resolve({ done: false, value: this.#take(waiter.maxBytes)! });
    } else {
      this.#chunks.push(chunk);
    }
  }
  read(maxBytes = 65536, signal?: AbortSignal | null): Promise<ReadResult<Uint8Array>> {
    if (maxBytes <= 0) return Promise.resolve({ done: false, value: new Uint8Array(0) });
    const chunk = this.#take(maxBytes);
    if (chunk !== null) return Promise.resolve({ done: false, value: chunk });
    if (this.#error !== null) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let cleanup = () => {};
      const waiter = {
        resolve,
        reject,
        maxBytes,
        cleanup: () => cleanup(),
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
      waiter.resolve({ done: true, value: undefined });
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
export class QuicBytesReader extends BytesReader {
  #stream: QuicStream;
  constructor(stream: QuicStream, onClose: () => void | Promise<void>) {
    const state: BytesReadableState = {
      read(options) {
        const maxBytes = typeof options === 'number' ? options : (options?.maxBytes ?? 65536);
        const signal = typeof options === 'number' ? undefined : options?.signal;
        return stream[quicStreamInternals.readIncoming](maxBytes, signal);
      },
      async readInto(buffer, options) {
        const destination = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const result = await stream[quicStreamInternals.readIncoming](
          destination.byteLength,
          options?.signal,
        );
        if (result.done) return result;
        destination.set(result.value);
        return { done: false, value: result.value.byteLength };
      },
      closeReader: onClose,
    };
    super(state);
    this.#stream = stream;
  }
  protected onConsume(bytes: number): void {
    this.#stream[quicStreamInternals.extendStreamReceiveCredit](bytes);
    this.#stream[quicStreamInternals.extendConnectionReceiveCredit](bytes);
  }
}
class QuicBytesWritableState implements BytesWritableState {
  #stream: QuicStream;
  #onClose: () => void | Promise<void>;
  #pending: Uint8Array[] = [];
  #flushScheduled = false;
  #fin = false;
  #stopped = false;
  #reservation: Uint8Array | null = null;
  #error: unknown = null;
  constructor(stream: QuicStream, onClose: () => void | Promise<void>) {
    this.#stream = stream;
    this.#onClose = onClose;
  }
  write(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (this.#error !== null) return Promise.reject(this.#error);
    this.#stream[quicStreamInternals.assertWritableSide]();
    const buf = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.#writeChunk(buf, false);
    return Promise.resolve();
  }
  writeSync(data: ArrayBuffer | ArrayBufferView, owned = false): void {
    if (this.#error !== null) throw this.#error;
    this.#stream[quicStreamInternals.assertWritableSide]();
    const buf =
      data instanceof Uint8Array
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
    // `owned` means the caller handed us a fresh buffer it will not reuse (the
    // H3 drain allocates one per write), so we can retain it without slicing.
    this.#writeChunk(buf, owned);
    this.#flushPending();
  }
  reserve(): Promise<Uint8Array> {
    if (this.#error !== null) return Promise.reject(this.#error);
    if (this.#reservation !== null) return Promise.reject(new Error('Write already reserved'));
    this.#reservation = new Uint8Array(65536);
    return Promise.resolve(this.#reservation);
  }
  commit(bytesWritten: number): void {
    const reservation = this.#reservation;
    if (reservation === null) throw new Error('No active write reservation');
    if (
      !Number.isInteger(bytesWritten) ||
      bytesWritten < 0 ||
      bytesWritten > reservation.byteLength
    )
      throw new RangeError('commit exceeds reserved capacity');
    this.#reservation = null;
    this.#writeChunk(reservation.subarray(0, bytesWritten), true);
  }
  #writeChunk(buf: Uint8Array, owned: boolean): void {
    const chunk = owned ? buf : buf.slice();
    this.#stream[quicStreamInternals.reserveWrite](chunk);
    this.#pending.push(chunk);
    this.#scheduleFlush();
  }
  closeFromStopSending(): void {
    this.#pending = [];
    this.#fin = false;
    this.#stopped = true;
  }
  async closeWriter(): Promise<void> {
    if (!this.#stopped && this.#stream[quicStreamInternals.hasWritableSide]()) {
      this.#fin = true;
    }
    if (this.#fin) this.#flushPending();
    await this.#onClose();
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    this.#stream[quicStreamInternals.scheduleWriterFlush](() => this.#flushPending());
  }
  #flushPending(): void {
    this.#flushScheduled = false;
    if (this.#pending.length === 0) {
      if (this.#fin) {
        try {
          this.#stream[quicStreamInternals.queueWrite](new Uint8Array(), true);
        } catch (error) {
          if (!(error instanceof Error) || !/QUIC stream is closed/.test(error.message))
            throw error;
        }
        this.#fin = false;
      }
      return;
    }
    let total = 0;
    for (const chunk of this.#pending) total += chunk.byteLength;
    const data =
      this.#pending.length === 1
        ? this.#pending[0]!
        : (() => {
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
      this.#stream[quicStreamInternals.queueWrite](data, fin, true);
    } catch (error) {
      if (!(error instanceof Error) || !/QUIC stream is closed/.test(error.message)) throw error;
    }
  }
}
export class QuicBytesWriter extends BytesWriter {
  #state: QuicBytesWritableState;
  constructor(stream: QuicStream, onClose: () => void | Promise<void>) {
    const state = new QuicBytesWritableState(stream, onClose);
    super(state);
    this.#state = state;
  }
  writeSync(data: ArrayBuffer | ArrayBufferView, owned = false): void {
    this.#state.writeSync(data, owned);
  }
  [quicBytesWriterInternals.closeFromStopSending](): void {
    this.#state.closeFromStopSending();
    void this.close();
  }
  closeSync(): void {
    void this.close();
  }
}
export function normalizeAddress(address?: QuicAddress): QuicAddress {
  const addr = address ?? {
    family: 'ipv4',
    ip: '127.0.0.1',
    port: 0,
  };
  if (addr.family !== 'ipv4' && addr.family !== 'ipv6') {
    throw new TypeError('QUIC only supports IPv4 and IPv6 UDP addresses');
  }
  return {
    family: addr.family,
    ip: addr.ip,
    port: addr.port,
  };
}
export function addressKey(address: QuicAddress): string {
  return `${address.family}:${address.ip}:${address.port}`;
}
export function sameAddress(a: QuicAddress, b: QuicAddress): boolean {
  return a.family === b.family && a.ip === b.ip && a.port === b.port;
}
export function decodeHexDatagram(input: string): Uint8Array {
  const text = input.trim();
  if (text.length % 2 !== 0) throw new TypeError('QUIC DATAGRAM hex data must have an even length');
  if (!/^[0-9a-fA-F]*$/.test(text))
    throw new TypeError('QUIC DATAGRAM hex data contains invalid characters');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    out[i] = byte;
  }
  return out;
}
export function decodeBase64Datagram(input: string): Uint8Array {
  const raw = atob(input);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
export function normalizeDatagramSource(
  data: QuicDatagramBytes,
  encoding: QuicDatagramEncoding,
): Uint8Array {
  if (typeof data === 'string') {
    if (encoding === 'utf8') return encodeUtf8(data);
    if (encoding === 'hex') return decodeHexDatagram(data);
    if (encoding === 'base64') return decodeBase64Datagram(data);
    throw new TypeError(`Unsupported QUIC DATAGRAM string encoding: ${encoding}`);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('QUIC DATAGRAM data must be a string, ArrayBuffer, or ArrayBufferView');
}
export function normalizeVersions(
  input: QuicVersion[] | undefined,
  base?: ResolvedQuicOptions,
): QuicVersion[] {
  const versions = input?.slice() ?? base?.versions.slice() ?? ['v2', 'v1'];
  if (versions.length === 0) throw new TypeError('QUIC versions must include at least one version');
  for (const version of versions) {
    if (version !== 'v1' && version !== 'v2')
      throw new TypeError(`Unsupported QUIC version option: ${version}`);
  }
  return versions;
}
export function normalizeTlsCipherSuites(
  input: QuicTlsCipherSuite[] | undefined,
  base?: ResolvedQuicOptions,
): QuicTlsCipherSuite[] | null {
  if (input === undefined) return base?.tlsCipherSuites?.slice() ?? null;
  if (input.length === 0) throw new TypeError('QUIC TLS cipher suite list must not be empty');
  for (const suite of input) {
    if (!QUIC_TLS_CIPHER_SUITES.has(suite))
      throw new TypeError(`Unsupported QUIC TLS cipher suite: ${suite}`);
  }
  return input.slice();
}
export function normalizeTlsGroups(
  input: string[] | undefined,
  base?: ResolvedQuicOptions,
): string[] | null {
  if (input === undefined) return base?.tlsGroups?.slice() ?? null;
  if (input.length === 0) throw new TypeError('QUIC TLS group list must not be empty');
  for (const group of input) {
    if (typeof group !== 'string' || group.length === 0)
      throw new TypeError('QUIC TLS groups must be non-empty strings');
  }
  return input.slice();
}
export function normalizeRetry(
  input: QuicRetryOptions | undefined,
  base?: ResolvedQuicOptions,
): ResolvedRetryOptions {
  if (input === undefined) return base?.retry ?? { enabled: true };
  if (input === false) return { enabled: false };
  if (input.enabled !== true) return { enabled: false };
  if (input.tokenSecret !== undefined && !(input.tokenSecret instanceof Uint8Array)) {
    throw new TypeError('QUIC Retry tokenSecret must be a Uint8Array');
  }
  return input.tokenSecret === undefined
    ? { enabled: true }
    : {
        enabled: true,
        tokenSecret: input.tokenSecret.slice(),
      };
}
export function normalizeDatagrams(
  input: QuicDatagramOptions | undefined,
  base?: ResolvedQuicOptions,
): ResolvedDatagramOptions {
  if (input === undefined) {
    return (
      base?.datagrams ?? {
        enabled: true,
        maxFrameSize: NGTCP2_MAX_UDP_PAYLOAD_SIZE,
        maxPending: DEFAULT_MAX_PENDING_DATAGRAMS,
        dropPolicy: 'drop-oldest',
        maxSendAttempts: DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS,
      }
    );
  }
  if (input.enabled === false) {
    return {
      enabled: false,
      maxFrameSize: 0,
      maxPending: 0,
      dropPolicy: 'drop-oldest',
      maxSendAttempts: DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS,
    };
  }
  const maxFrameSize =
    input.maxFrameSize ?? base?.datagrams.maxFrameSize ?? NGTCP2_MAX_UDP_PAYLOAD_SIZE;
  if (!Number.isInteger(maxFrameSize) || maxFrameSize <= 0) {
    throw new TypeError('QUIC DATAGRAM maxFrameSize must be a positive integer');
  }
  if (maxFrameSize > NGTCP2_MAX_UDP_PAYLOAD_SIZE) {
    throw new RangeError(`QUIC DATAGRAM maxFrameSize must be <= ${NGTCP2_MAX_UDP_PAYLOAD_SIZE}`);
  }
  const maxPending =
    input.maxPending ?? base?.datagrams.maxPending ?? DEFAULT_MAX_PENDING_DATAGRAMS;
  if (!Number.isInteger(maxPending) || maxPending < 0 || maxPending > 65535) {
    throw new TypeError('QUIC DATAGRAM maxPending must be an integer between 0 and 65535');
  }
  const dropPolicy = input.dropPolicy ?? base?.datagrams.dropPolicy ?? 'drop-oldest';
  if (dropPolicy !== 'drop-oldest' && dropPolicy !== 'drop-newest') {
    throw new TypeError('QUIC DATAGRAM dropPolicy must be "drop-oldest" or "drop-newest"');
  }
  const maxSendAttempts =
    input.maxSendAttempts ?? base?.datagrams.maxSendAttempts ?? DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS;
  if (!Number.isInteger(maxSendAttempts) || maxSendAttempts < 1 || maxSendAttempts > 255) {
    throw new TypeError('QUIC DATAGRAM maxSendAttempts must be an integer between 1 and 255');
  }
  return {
    enabled: true,
    maxFrameSize,
    maxPending,
    dropPolicy,
    maxSendAttempts,
  };
}
export function quicVarintLength(value: number): number {
  if (value < 64) return 1;
  if (value < 16384) return 2;
  if (value < 1073741824) return 4;
  return 8;
}
export function maxDatagramPayload(maxFrameSize: number): number {
  if (maxFrameSize < 2) return 0;
  let payload = maxFrameSize - 2;
  const overhead = 1 + quicVarintLength(payload);
  if (overhead + payload > maxFrameSize) {
    payload = maxFrameSize - 1 - quicVarintLength(maxFrameSize - 3);
  }
  return Math.max(0, payload);
}
export function normalizePreferredAddress(
  input: QuicPreferredAddressOptions | undefined,
): ResolvedPreferredAddressOptions | undefined {
  if (input === undefined) return undefined;
  if ('family' in input) {
    const address = normalizeAddress(input);
    return address.family === 'ipv4' ? { ipv4: address } : { ipv6: address };
  }
  const preferred: ResolvedPreferredAddressOptions = {};
  if (input.ipv4 !== undefined) {
    const address = normalizeAddress(input.ipv4);
    if (address.family !== 'ipv4')
      throw new TypeError('QUIC preferredAddress.ipv4 must be an IPv4 address');
    preferred.ipv4 = address;
  }
  if (input.ipv6 !== undefined) {
    const address = normalizeAddress(input.ipv6);
    if (address.family !== 'ipv6')
      throw new TypeError('QUIC preferredAddress.ipv6 must be an IPv6 address');
    preferred.ipv6 = address;
  }
  return preferred.ipv4 === undefined && preferred.ipv6 === undefined ? undefined : preferred;
}
export function normalizeMigration(
  input: QuicMigrationOptions | undefined,
  base?: ResolvedQuicOptions,
): ResolvedMigrationOptions {
  if (input === undefined)
    return (
      base?.migration ?? {
        enabled: false,
        usePreferredAddress: false,
      }
    );
  const preferredAddress =
    normalizePreferredAddress(input.preferredAddress) ?? base?.migration.preferredAddress;
  return {
    enabled: input.enabled === true,
    usePreferredAddress: input.usePreferredAddress === true,
    ...(preferredAddress === undefined ? {} : { preferredAddress }),
  };
}
export function normalizeQlog(
  input: QuicQlogOptions | undefined,
  base?: ResolvedQuicOptions,
): QuicQlogOptions {
  if (input === undefined) return base?.qlog ?? false;
  if (input === false) return false;
  if ('events' in input) {
    throw new TypeError('QUIC qlog does not support event filtering; omit qlog.events');
  }
  return {
    ...(input.path === undefined ? {} : { path: String(input.path) }),
  };
}
export function normalizeKeylog(
  input: QuicKeylogOptions | undefined,
  base?: ResolvedQuicOptions,
): QuicKeylogOptions {
  if (input === undefined) return base?.keylog ?? false;
  if (input === false) return false;
  const path = String(input.path ?? '');
  if (path.length === 0) throw new TypeError('QUIC keylog path must be a non-empty string');
  return { path };
}
export function normalizeRateLimit(
  input: QuicRateLimitOptions | undefined,
  base: ResolvedRateLimitOptions | undefined,
  defaults: ResolvedRateLimitOptions,
  name: string,
): ResolvedRateLimitOptions {
  if (input === undefined) return base ?? defaults;
  if (input === false)
    return {
      rate: 0,
      burst: 0,
    };
  const rate = input.rate ?? base?.rate ?? defaults.rate;
  const burst = input.burst ?? base?.burst ?? defaults.burst;
  if (!Number.isFinite(rate) || rate < 0)
    throw new TypeError(`QUIC ${name} rate must be a non-negative number`);
  if (!Number.isInteger(burst) || burst < 0)
    throw new TypeError(`QUIC ${name} burst must be a non-negative integer`);
  return {
    rate,
    burst,
  };
}
export function normalizeLimit(
  input: number | undefined,
  base: number | undefined,
  defaults: number,
  name: string,
): number {
  const value = input ?? base ?? defaults;
  if (value !== Number.POSITIVE_INFINITY && (!Number.isInteger(value) || value < 0)) {
    throw new TypeError(`QUIC ${name} must be a non-negative integer`);
  }
  return value;
}
export function normalizeTimeoutMs(
  input: number | undefined,
  base: bigint | undefined,
  defaults: bigint,
  min: bigint,
  max: bigint,
  name: string,
): bigint {
  if (input === undefined) return clampBigint(base ?? defaults, min, max);
  if (!Number.isFinite(input) || input < 0)
    throw new TypeError(`QUIC ${name} must be a non-negative number of milliseconds`);
  return clampBigint(BigInt(Math.floor(input * 1e6)), min, max);
}
export function normalizeDurationMs(
  input: number | undefined,
  base: bigint | undefined,
  defaults: bigint,
  name: string,
): bigint {
  if (input === undefined) return base ?? defaults;
  if (!Number.isFinite(input) || input < 0)
    throw new TypeError(`QUIC ${name} must be a non-negative number of milliseconds`);
  return BigInt(Math.floor(input * 1e6));
}
export function normalizeInteger(
  input: number | undefined,
  base: number | undefined,
  defaults: number,
  min: number,
  max: number,
  name: string,
): number {
  const value = input ?? base ?? defaults;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`QUIC ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
export function normalizeClampedInteger(
  input: number | undefined,
  base: number | undefined,
  defaults: number,
  min: number,
  max: number,
  name: string,
): number {
  const value = input ?? base ?? defaults;
  if (!Number.isInteger(value)) {
    throw new TypeError(`QUIC ${name} must be an integer`);
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
export function normalizeTransportVarint(
  input: number | undefined,
  base: bigint | undefined,
  defaults: bigint,
  name: string,
): bigint {
  if (input === undefined) return base ?? defaults;
  if (!Number.isInteger(input) || input < 0)
    throw new TypeError(`QUIC ${name} must be a non-negative integer`);
  return BigInt(input);
}
export function normalizeConnection(
  input: QuicConnectionOptions | undefined,
  base?: ResolvedQuicOptions,
): ResolvedConnectionOptions {
  const baseConnection = base?.connection;
  const maxPayloadSize = normalizeInteger(
    input?.maxPayloadSize,
    baseConnection?.maxPayloadSize,
    DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE,
    DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE,
    65527,
    'maxPayloadSize',
  );
  const congestionControl =
    input?.congestionControl ?? baseConnection?.congestionControl ?? 'cubic';
  if (
    congestionControl !== 'cubic' &&
    congestionControl !== 'reno' &&
    congestionControl !== 'bbr'
  ) {
    throw new TypeError('QUIC congestionControl must be "cubic", "reno", or "bbr"');
  }
  return {
    handshakeTimeout: normalizeDurationMs(
      input?.handshakeTimeoutMs,
      baseConnection?.handshakeTimeout,
      HANDSHAKE_TIMEOUT,
      'handshakeTimeoutMs',
    ),
    initialRtt: normalizeDurationMs(
      input?.initialRttMs,
      baseConnection?.initialRtt,
      0n,
      'initialRttMs',
    ),
    keepAliveTimeout: normalizeDurationMs(
      input?.keepAliveTimeoutMs,
      baseConnection?.keepAliveTimeout,
      0n,
      'keepAliveTimeoutMs',
    ),
    maxPayloadSize,
    maxWindow: BigInt(
      normalizeLimit(
        input?.maxWindow,
        baseConnection === undefined ? undefined : Number(baseConnection.maxWindow),
        0,
        'maxWindow',
      ),
    ),
    maxStreamWindow: BigInt(
      normalizeLimit(
        input?.maxStreamWindow,
        baseConnection === undefined ? undefined : Number(baseConnection.maxStreamWindow),
        0,
        'maxStreamWindow',
      ),
    ),
    unacknowledgedPacketThreshold: BigInt(
      normalizeLimit(
        input?.unacknowledgedPacketThreshold,
        baseConnection === undefined
          ? undefined
          : Number(baseConnection.unacknowledgedPacketThreshold),
        0,
        'unacknowledgedPacketThreshold',
      ),
    ),
    congestionControl,
    drainingPeriodMultiplier: normalizeInteger(
      input?.drainingPeriodMultiplier,
      baseConnection?.drainingPeriodMultiplier,
      DEFAULT_DRAINING_PERIOD_MULTIPLIER,
      DEFAULT_DRAINING_PERIOD_MULTIPLIER,
      255,
      'drainingPeriodMultiplier',
    ),
    streamIdleTimeout: normalizeDurationMs(
      input?.streamIdleTimeoutMs,
      baseConnection?.streamIdleTimeout,
      DEFAULT_STREAM_IDLE_TIMEOUT,
      'streamIdleTimeoutMs',
    ),
    maxPendingStreamOpens: normalizeInteger(
      input?.maxPendingStreamOpens,
      baseConnection?.maxPendingStreamOpens,
      DEFAULT_MAX_PENDING_STREAM_OPENS,
      0,
      65535,
      'maxPendingStreamOpens',
    ),
    maxIdleTimeout: normalizeDurationMs(
      input?.maxIdleTimeoutMs,
      baseConnection?.maxIdleTimeout,
      MAX_IDLE_TIMEOUT,
      'maxIdleTimeoutMs',
    ),
    initialMaxData: normalizeTransportVarint(
      input?.initialMaxData,
      baseConnection?.initialMaxData,
      INITIAL_MAX_DATA,
      'initialMaxData',
    ),
    initialMaxStreamDataBidiLocal: normalizeTransportVarint(
      input?.initialMaxStreamDataBidiLocal,
      baseConnection?.initialMaxStreamDataBidiLocal,
      INITIAL_MAX_STREAM_DATA,
      'initialMaxStreamDataBidiLocal',
    ),
    initialMaxStreamDataBidiRemote: normalizeTransportVarint(
      input?.initialMaxStreamDataBidiRemote,
      baseConnection?.initialMaxStreamDataBidiRemote,
      INITIAL_MAX_STREAM_DATA,
      'initialMaxStreamDataBidiRemote',
    ),
    initialMaxStreamDataUni: normalizeTransportVarint(
      input?.initialMaxStreamDataUni,
      baseConnection?.initialMaxStreamDataUni,
      INITIAL_MAX_STREAM_DATA,
      'initialMaxStreamDataUni',
    ),
    initialMaxStreamsBidi: normalizeTransportVarint(
      input?.initialMaxStreamsBidi,
      baseConnection?.initialMaxStreamsBidi,
      INITIAL_MAX_STREAMS_BIDI,
      'initialMaxStreamsBidi',
    ),
    initialMaxStreamsUni: normalizeTransportVarint(
      input?.initialMaxStreamsUni,
      baseConnection?.initialMaxStreamsUni,
      INITIAL_MAX_STREAMS_UNI,
      'initialMaxStreamsUni',
    ),
    activeConnectionIdLimit: BigInt(
      normalizeClampedInteger(
        input?.activeConnectionIdLimit,
        baseConnection === undefined ? undefined : Number(baseConnection.activeConnectionIdLimit),
        Number(ACTIVE_CONNECTION_ID_LIMIT),
        2,
        8,
        'activeConnectionIdLimit',
      ),
    ),
    maxAckDelay: normalizeDurationMs(
      input?.maxAckDelayMs,
      baseConnection?.maxAckDelay,
      25n * NGTCP2_MILLISECONDS,
      'maxAckDelayMs',
    ),
    ackDelayExponent: BigInt(
      normalizeInteger(
        input?.ackDelayExponent,
        baseConnection === undefined ? undefined : Number(baseConnection.ackDelayExponent),
        3,
        0,
        20,
        'ackDelayExponent',
      ),
    ),
    disableActiveMigration:
      input?.disableActiveMigration ?? baseConnection?.disableActiveMigration ?? false,
    cidLength: normalizeInteger(
      input?.cidLength,
      baseConnection?.cidLength,
      NGTCP2_MAX_CIDLEN,
      8,
      NGTCP2_MAX_CIDLEN,
      'cidLength',
    ),
  };
}
export function clampBigint(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
export function nsToMs(value: bigint): number {
  return Number(value / NGTCP2_MILLISECONDS);
}
export function normalizeAddressSet(input: string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (input === undefined) return out;
  for (const entry of input) out.add(String(entry));
  return out;
}
export function normalizeTransport(
  input: QuicTransportOptions | undefined,
  base?: ResolvedQuicOptions,
): ResolvedTransportOptions {
  const baseTransport = base?.transport;
  const addressValidationCacheSize =
    input?.addressValidationCacheSize ??
    baseTransport?.addressValidationCacheSize ??
    DEFAULT_ADDRESS_LRU_SIZE;
  if (!Number.isInteger(addressValidationCacheSize) || addressValidationCacheSize < 1) {
    throw new TypeError('QUIC addressValidationCacheSize must be a positive integer');
  }
  const allow =
    input?.sourceAddress?.allow === undefined
      ? (baseTransport?.sourceAddress.allow ?? null)
      : normalizeAddressSet(input.sourceAddress.allow);
  const deny =
    input?.sourceAddress?.deny === undefined
      ? new Set(baseTransport?.sourceAddress.deny ?? [])
      : normalizeAddressSet(input.sourceAddress.deny);
  return {
    busy: input?.busy ?? baseTransport?.busy ?? false,
    maxConnections: normalizeLimit(
      input?.maxConnections,
      baseTransport?.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
      'maxConnections',
    ),
    maxConnectionsPerRemoteAddress: normalizeLimit(
      input?.maxConnectionsPerRemoteAddress,
      baseTransport?.maxConnectionsPerRemoteAddress,
      DEFAULT_MAX_CONNECTIONS_PER_REMOTE_ADDRESS,
      'maxConnectionsPerRemoteAddress',
    ),
    sourceAddress: {
      allow,
      deny,
    },
    retryTokenTimeout: normalizeTimeoutMs(
      input?.retryTokenTimeoutMs,
      baseTransport?.retryTokenTimeout,
      RETRY_TOKEN_TIMEOUT,
      MIN_TOKEN_TIMEOUT,
      MAX_RETRY_TOKEN_TIMEOUT,
      'retryTokenTimeoutMs',
    ),
    addressTokenTimeout: normalizeTimeoutMs(
      input?.addressTokenTimeoutMs,
      baseTransport?.addressTokenTimeout,
      REGULAR_TOKEN_TIMEOUT,
      MIN_TOKEN_TIMEOUT,
      MAX_REGULAR_TOKEN_TIMEOUT,
      'addressTokenTimeoutMs',
    ),
    addressValidationCacheSize,
    retryRateLimit: normalizeRateLimit(
      input?.retryRateLimit,
      baseTransport?.retryRateLimit,
      {
        rate: DEFAULT_RETRY_RATE,
        burst: DEFAULT_RETRY_BURST,
      },
      'retryRateLimit',
    ),
    versionNegotiationRateLimit: normalizeRateLimit(
      input?.versionNegotiationRateLimit,
      baseTransport?.versionNegotiationRateLimit,
      {
        rate: DEFAULT_VERSION_NEGOTIATION_RATE,
        burst: DEFAULT_VERSION_NEGOTIATION_BURST,
      },
      'versionNegotiationRateLimit',
    ),
    statelessResetRateLimit: normalizeRateLimit(
      input?.statelessResetRateLimit,
      baseTransport?.statelessResetRateLimit,
      {
        rate: DEFAULT_STATELESS_RESET_RATE,
        burst: DEFAULT_STATELESS_RESET_BURST,
      },
      'statelessResetRateLimit',
    ),
    immediateCloseRateLimit: normalizeRateLimit(
      input?.immediateCloseRateLimit,
      baseTransport?.immediateCloseRateLimit,
      {
        rate: DEFAULT_IMMEDIATE_CLOSE_RATE,
        burst: DEFAULT_IMMEDIATE_CLOSE_BURST,
      },
      'immediateCloseRateLimit',
    ),
    sessionCreationRateLimit: normalizeRateLimit(
      input?.sessionCreationRateLimit,
      baseTransport?.sessionCreationRateLimit,
      {
        rate: DEFAULT_SESSION_CREATION_RATE,
        burst: DEFAULT_SESSION_CREATION_BURST,
      },
      'sessionCreationRateLimit',
    ),
    disableStatelessReset:
      input?.disableStatelessReset ?? baseTransport?.disableStatelessReset ?? false,
    ecn: input?.ecn ?? baseTransport?.ecn ?? false,
  };
}
export function resolveQuicOptions(
  options: QuicEndpointOptions | QuicListenOptions | QuicConnectOptions = {},
  base?: ResolvedQuicOptions,
): ResolvedQuicOptions {
  const sessionStore = options.sessionStore ?? base?.sessionStore;
  const earlyData = options.earlyData ?? base?.earlyData ?? false;
  if (earlyData !== false) {
    if (sessionStore === undefined)
      throw new TypeError('QUIC 0-RTT earlyData requires a sessionStore');
    if (earlyData.replaySafe !== true)
      throw new TypeError('QUIC 0-RTT earlyData requires an explicit replay-safe policy');
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
    keylog: normalizeKeylog(options.keylog, base),
  };
}
export function freezeRateLimitSnapshot(
  input: ResolvedRateLimitOptions,
): QuicResolvedRateLimitOptions {
  return Object.freeze({
    rate: input.rate,
    burst: input.burst,
  });
}
export function freezeTransportSnapshot(
  input: ResolvedTransportOptions,
): QuicResolvedTransportOptions {
  return Object.freeze({
    busy: input.busy,
    maxConnections: input.maxConnections,
    maxConnectionsPerRemoteAddress: input.maxConnectionsPerRemoteAddress,
    sourceAddress: Object.freeze({
      allow:
        input.sourceAddress.allow === null
          ? null
          : Object.freeze(Array.from(input.sourceAddress.allow)),
      deny: Object.freeze(Array.from(input.sourceAddress.deny)),
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
    ecn: input.ecn,
  });
}
export function freezeConnectionSnapshot(
  input: ResolvedConnectionOptions,
): QuicResolvedConnectionOptions {
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
    maxPendingStreamOpens: input.maxPendingStreamOpens,
    cidLength: input.cidLength,
  });
}
export function versionToWire(version: QuicVersion): number {
  return version === 'v2' ? NGTCP2_PROTO_VER_V2 : NGTCP2_PROTO_VER_V1;
}
export function wireVersionToName(version: number): QuicVersion {
  return version === NGTCP2_PROTO_VER_V2 ? 'v2' : 'v1';
}
export function selectWireVersion(versions: readonly QuicVersion[]): number {
  for (const version of versions) {
    const wireVersion = versionToWire(version);
    if (ngtcp2Sym!.ngtcp2_is_supported_version(wireVersion) !== 0) return wireVersion;
  }
  throw new Error(
    `Installed ngtcp2 does not support requested QUIC versions: ${versions.join(', ')}`,
  );
}
export function selectClientInitialWireVersion(versions: readonly QuicVersion[]): number {
  if (
    versions.includes('v1') &&
    ngtcp2Sym!.ngtcp2_is_supported_version(NGTCP2_PROTO_VER_V1) !== 0
  ) {
    return NGTCP2_PROTO_VER_V1;
  }
  return selectWireVersion(versions);
}
export function longHeaderVersion(packet: Uint8Array): number | null {
  if (packet.byteLength < 5 || (packet[0]! & 128) === 0) return null;
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(1, false);
}
export function sessionStoreKey(serverName: string, alpnProtocols: readonly string[]): string {
  return `${serverName}|${alpnProtocols.join(',')}`;
}
export function now(runtime: QuicRuntime = realQuicRuntime): bigint {
  return runtime.nowNs();
}
export class QuicTokenBucket {
  #tokens: number;
  #lastTimestamp: bigint;
  constructor(
    readonly rate: number,
    readonly burst: number,
    readonly runtime: QuicRuntime = realQuicRuntime,
  ) {
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
export type QuicAddressValidationInfo = {
  validated: boolean;
  sessionCreationBucket: QuicTokenBucket;
  timestamp: bigint;
};
export class QuicAddressValidationCache {
  #entries = new Map<string, QuicAddressValidationInfo>();
  constructor(
    readonly maxEntries: number,
    readonly sessionCreationRateLimit: ResolvedRateLimitOptions,
    readonly timeout: bigint,
    readonly runtime: QuicRuntime = realQuicRuntime,
  ) {}
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
      sessionCreationBucket: new QuicTokenBucket(
        this.sessionCreationRateLimit.rate,
        this.sessionCreationRateLimit.burst,
        this.runtime,
      ),
      timestamp,
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
export function writeU64(buf: ArrayBuffer | Uint8Array, off: number, value: bigint | number): void {
  const dv = new DataView(
    buf instanceof Uint8Array ? buf.buffer : buf,
    buf instanceof Uint8Array ? buf.byteOffset : 0,
  );
  dv.setBigUint64(off, BigInt(value), true);
}
export function writeI64(buf: ArrayBuffer | Uint8Array, off: number, value: bigint | number): void {
  const dv = new DataView(
    buf instanceof Uint8Array ? buf.buffer : buf,
    buf instanceof Uint8Array ? buf.byteOffset : 0,
  );
  dv.setBigInt64(off, BigInt(value), true);
}
export function writeU32(buf: ArrayBuffer | Uint8Array, off: number, value: number): void {
  const dv = new DataView(
    buf instanceof Uint8Array ? buf.buffer : buf,
    buf instanceof Uint8Array ? buf.byteOffset : 0,
  );
  dv.setUint32(off, value, true);
}
export function writeU8(buf: ArrayBuffer | Uint8Array, off: number, value: number): void {
  new Uint8Array(
    buf instanceof Uint8Array ? buf.buffer : buf,
    buf instanceof Uint8Array ? buf.byteOffset : 0,
  )[off] = value;
}
export function readU64(buf: ArrayBuffer, off: number): bigint {
  return new DataView(buf).getBigUint64(off, true);
}
export function readI64(buf: ArrayBuffer, off: number): bigint {
  return new DataView(buf).getBigInt64(off, true);
}
export function readU32(buf: ArrayBuffer, off: number): number {
  return new DataView(buf).getUint32(off, true);
}
export function ptrAddress(ptr: ArrayBuffer | null): bigint {
  if (ptr === null) return 0n;
  return new DataView(ptr).getBigUint64(0, true);
}
export function writePtr(buf: ArrayBuffer, off: number, ptr: ArrayBuffer | null): void {
  writeU64(buf, off, ptrAddress(ptr));
}
export function writePtrIfPresent(buf: ArrayBuffer, off: number, ptr: ArrayBuffer | null): void {
  if (off + 8 <= buf.byteLength) writePtr(buf, off, ptr);
}
export function writeAddress(buf: ArrayBuffer, off: number, address: bigint): void {
  writeU64(buf, off, address);
}
export const _compatibleVersionLists = new Map<string, Uint8Array>();
export function compatibleVersionList(versions: readonly QuicVersion[]): Uint8Array {
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
export function ptrField(buf: ArrayBuffer, off: number): ArrayBuffer | null {
  const value = readU64(buf, off);
  if (value === 0n) return null;
  const out = new ArrayBuffer(8);
  writeU64(out, 0, value);
  return out;
}
export function copyFromPtr(ptr: ArrayBuffer | null, len: number): Uint8Array {
  if (ptr === null || len === 0) return new Uint8Array();
  return Pointer.copyFrom(ptr, len) as Uint8Array;
}
export const _HEX_BYTE: string[] = [];
for (let i = 0; i < 256; i++) _HEX_BYTE.push(i.toString(16).padStart(2, '0'));
export function cidKey(cid: Uint8Array | string): string {
  if (typeof cid === 'string') return cid;
  let out = '';
  for (let i = 0; i < cid.length; i++) out += _HEX_BYTE[cid[i]!];
  return out;
}
export function makeCid(bytes: Uint8Array): ArrayBuffer {
  const cid = new ArrayBuffer(NGTCP2_CID_SIZE);
  writeU64(cid, CID_DATALEN, BigInt(bytes.byteLength));
  new Uint8Array(cid, CID_DATA, Math.min(bytes.byteLength, NGTCP2_MAX_CIDLEN)).set(
    bytes.subarray(0, NGTCP2_MAX_CIDLEN),
  );
  return cid;
}
export function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  randBytes(out.buffer, len);
  return out;
}
export function randomCid(len = NGTCP2_MAX_CIDLEN): ArrayBuffer {
  return makeCid(randomBytes(len));
}
export function generateStatelessResetToken(secret: Uint8Array, cid: ArrayBuffer): Uint8Array {
  const token = new Uint8Array(NGTCP2_STATELESS_RESET_TOKENLEN);
  const rc = cryptoSym!.ngtcp2_crypto_generate_stateless_reset_token(
    token,
    secret,
    secret.byteLength,
    Pointer.of(cid),
  ) as number;
  if (rc !== 0) throw new Error('ngtcp2_crypto_generate_stateless_reset_token failed');
  return token;
}
export function generateRegularToken(
  secret: Uint8Array,
  remoteAddress: QuicAddress,
  runtime: QuicRuntime,
): Uint8Array | null {
  const remote = encodeAddr(remoteAddress);
  const token = new Uint8Array(NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN);
  const tokenLen = Number(
    cryptoSym!.ngtcp2_crypto_generate_regular_token(
      token,
      secret,
      secret.byteLength,
      Pointer.of(remote.buf),
      remote.len,
      now(runtime),
    ),
  );
  return tokenLen <= 0 ? null : token.slice(0, tokenLen);
}
export function verifyRegularToken(
  secret: Uint8Array,
  remoteAddress: QuicAddress,
  token: Uint8Array,
  runtime: QuicRuntime,
  timeout: bigint = REGULAR_TOKEN_TIMEOUT,
): boolean {
  const remote = encodeAddr(remoteAddress);
  const rc = cryptoSym!.ngtcp2_crypto_verify_regular_token(
    token,
    token.byteLength,
    secret,
    secret.byteLength,
    Pointer.of(remote.buf),
    remote.len,
    timeout,
    now(runtime),
  ) as number;
  return rc === 0;
}
export function isRetryToken(token: Uint8Array): boolean {
  return token.byteLength > 0 && token[0] === NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2;
}
export function cidBytes(cid: ArrayBuffer | null): Uint8Array {
  if (cid === null) return new Uint8Array();
  const bytes =
    cid.byteLength >= NGTCP2_CID_SIZE
      ? new Uint8Array(cid)
      : (Pointer.copyFrom(cid, NGTCP2_CID_SIZE) as Uint8Array);
  const len = Number(readU64(bytes.buffer, bytes.byteOffset + CID_DATALEN));
  return bytes.subarray(CID_DATA, CID_DATA + len).slice();
}
export function cidFromPacketHeader(hd: ArrayBuffer, off: number): ArrayBuffer {
  return makeCid(
    new Uint8Array(hd, off + CID_DATA, Number(readU64(hd, off + CID_DATALEN))).slice(),
  );
}
export function readPacketVarint(
  packet: Uint8Array,
  offset: number,
): {
  value: number;
  offset: number;
} | null {
  if (offset >= packet.byteLength) return null;
  const first = packet[offset];
  const length = 1 << (first >>> 6);
  if (offset + length > packet.byteLength) return null;
  if (length === 1)
    return {
      value: first & 63,
      offset: offset + 1,
    };
  if (length === 2)
    return {
      value: ((first & 63) << 8) | packet[offset + 1],
      offset: offset + 2,
    };
  if (length === 4) {
    return {
      value:
        (first & 63) * 16777216 +
        (packet[offset + 1] << 16) +
        (packet[offset + 2] << 8) +
        packet[offset + 3],
      offset: offset + 4,
    };
  }
  return null;
}
export function parseInitialTokenHeader(packet: Uint8Array): {
  version: number;
  dcid: ArrayBuffer;
  scid: ArrayBuffer;
  token: Uint8Array;
} | null {
  if (packet.byteLength < 7 || (packet[0] & 128) === 0 || (packet[0] & 48) !== 0) return null;
  const version = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(
    1,
    false,
  );
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
    token,
  };
}
export function packetHeaderFromParsedInitial(parsed: {
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
export type NativePath = {
  path: ArrayBuffer;
  local: ArrayBuffer;
  remote: ArrayBuffer;
  userData: ArrayBuffer;
  fd: number;
};
export type PathSnapshot = {
  localAddress: QuicAddress;
  remoteAddress: QuicAddress;
  fd: number;
};
export function makePath(
  localAddress: QuicAddress,
  remoteAddress: QuicAddress,
  fd = 0,
): NativePath {
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
    fd,
  };
}
export function makePathFromSockaddrs(
  localSockaddr: ArrayBuffer,
  localSockaddrLen: number,
  remoteSockaddr: ArrayBuffer,
  remoteSockaddrLen: number,
  fd = 0,
): NativePath | null {
  if (
    localSockaddrLen <= 0 ||
    localSockaddrLen > SOCKADDR_UNION_SIZE ||
    remoteSockaddrLen <= 0 ||
    remoteSockaddrLen > SOCKADDR_UNION_SIZE
  )
    return null;
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
    fd,
  };
}
export function makeOutputPath(
  localAddress: QuicAddress,
  remoteAddress: QuicAddress,
  fd = 0,
): NativePath {
  return makePath(localAddress, remoteAddress, fd);
}
export function remoteAddressFromPath(path: ArrayBuffer): QuicAddress | null {
  const addrPtr = ptrField(path, PATH_REMOTE + ADDR_ADDR);
  const addrLen = readU32(path, PATH_REMOTE + ADDR_ADDRLEN);
  if (addrPtr === null || addrLen === 0 || addrLen > SOCKADDR_UNION_SIZE) return null;
  const bytes = Pointer.copyFrom(addrPtr, addrLen) as Uint8Array;
  const decoded = decodeAddr(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return decoded.family === 'ipv4' || decoded.family === 'ipv6' ? decoded : null;
}
export function localAddressFromPath(path: ArrayBuffer): QuicAddress | null {
  const addrPtr = ptrField(path, PATH_LOCAL + ADDR_ADDR);
  const addrLen = readU32(path, PATH_LOCAL + ADDR_ADDRLEN);
  if (addrPtr === null || addrLen === 0 || addrLen > SOCKADDR_UNION_SIZE) return null;
  const bytes = Pointer.copyFrom(addrPtr, addrLen) as Uint8Array;
  const decoded = decodeAddr(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return decoded.family === 'ipv4' || decoded.family === 'ipv6' ? decoded : null;
}
export function fdFromPath(path: ArrayBuffer, fallback: number): number {
  const userData = ptrField(path, PATH_USER_DATA);
  if (userData === null) return fallback;
  const fd = Number(Pointer.readU64(userData, 0));
  return Number.isSafeInteger(fd) && fd > 0 ? fd : fallback;
}
export function fdFromNativePath(path: ArrayBuffer | null, fallback: number): number {
  if (path === null) return fallback;
  const pathBytes = Pointer.copyFrom(path, NGTCP2_PATH_SIZE) as Uint8Array;
  return fdFromPath(
    pathBytes.buffer.slice(pathBytes.byteOffset, pathBytes.byteOffset + pathBytes.byteLength),
    fallback,
  );
}
export function pathSnapshotFromNative(
  path: ArrayBuffer | null,
  fallbackFd: number,
): PathSnapshot | null {
  if (path === null) return null;
  const pathBytes = Pointer.copyFrom(path, NGTCP2_PATH_SIZE) as Uint8Array;
  const copy = pathBytes.buffer.slice(
    pathBytes.byteOffset,
    pathBytes.byteOffset + pathBytes.byteLength,
  );
  const remoteAddress = remoteAddressFromPath(copy);
  const localAddress = localAddressFromPath(copy);
  if (remoteAddress === null || localAddress === null) return null;
  return {
    localAddress,
    remoteAddress,
    fd: fdFromPath(copy, fallbackFd),
  };
}
export function pathFromSnapshot(snapshot: PathSnapshot | null): QuicPath | null {
  if (snapshot === null) return null;
  return {
    localAddress: snapshot.localAddress,
    remoteAddress: snapshot.remoteAddress,
  };
}
export function pathSnapshotsDiffer(a: PathSnapshot | null, b: PathSnapshot | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.fd !== b.fd ||
    !sameAddress(a.localAddress, b.localAddress) ||
    !sameAddress(a.remoteAddress, b.remoteAddress)
  );
}
export function pathValidationResultName(result: number): QuicPathValidationResult {
  if (result === NGTCP2_PATH_VALIDATION_RESULT_SUCCESS) return 'success';
  if (result === NGTCP2_PATH_VALIDATION_RESULT_FAILURE) return 'failure';
  if (result === NGTCP2_PATH_VALIDATION_RESULT_ABORTED) return 'aborted';
  return 'failure';
}
export function preferredAddressFromNative(
  paddr: ArrayBuffer | null,
  family: 'ipv4' | 'ipv6',
): QuicAddress | null {
  if (paddr === null) return null;
  const presentOffset =
    family === 'ipv4' ? TP_PREFERRED_ADDR_IPV4_PRESENT : TP_PREFERRED_ADDR_IPV6_PRESENT;
  if (Pointer.readU8(paddr, presentOffset) === 0) return null;
  const offset = family === 'ipv4' ? TP_PREFERRED_ADDR_IPV4 : TP_PREFERRED_ADDR_IPV6;
  const len = family === 'ipv4' ? 16 : 28;
  const bytes = Pointer.copyFrom(Pointer.offset(paddr, offset), len) as Uint8Array;
  const decoded = decodeAddr(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return decoded.family === family ? decoded : null;
}
export function cidFromTransportParams(
  params: ArrayBuffer,
  offset: number,
  presentOffset: number,
): Uint8Array | null {
  if (Pointer.readU8(params, presentOffset) === 0) return null;
  const bytes = Pointer.copyFrom(Pointer.offset(params, offset), NGTCP2_CID_SIZE) as Uint8Array;
  return cidBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
export function transportParameterSnapshot(
  params: ArrayBuffer | null,
): QuicTransportParameterSnapshot | null {
  if (params === null || ptrAddress(params) === 0n) return null;
  const preferred =
    Pointer.readU8(params, TP_PREFERRED_ADDR_PRESENT) === 0
      ? null
      : (preferredAddressFromNative(Pointer.offset(params, TP_PREFERRED_ADDR), 'ipv4') ??
        preferredAddressFromNative(Pointer.offset(params, TP_PREFERRED_ADDR), 'ipv6'));
  const statelessResetToken =
    Pointer.readU8(params, TP_STATELESS_RESET_TOKEN_PRESENT) === 0
      ? null
      : (Pointer.copyFrom(
          Pointer.offset(params, TP_STATELESS_RESET_TOKEN),
          NGTCP2_STATELESS_RESET_TOKENLEN,
        ) as Uint8Array);
  return Object.freeze({
    initialMaxStreamDataBidiLocal: Number(
      Pointer.readU64(params, TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL),
    ),
    initialMaxStreamDataBidiRemote: Number(
      Pointer.readU64(params, TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE),
    ),
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
    originalDestinationConnectionId: cidFromTransportParams(
      params,
      TP_ORIGINAL_DCID,
      TP_ORIGINAL_DCID_PRESENT,
    ),
    initialSourceConnectionId: cidFromTransportParams(
      params,
      TP_INITIAL_SCID,
      TP_INITIAL_SCID_PRESENT,
    ),
    retrySourceConnectionId: cidFromTransportParams(params, TP_RETRY_SCID, TP_RETRY_SCID_PRESENT),
    statelessResetToken,
  });
}
export function writeNativePathAddress(
  destPath: ArrayBuffer,
  pathOffset: number,
  address: QuicAddress,
): boolean {
  const addrPtr = Pointer.readPointer(destPath, pathOffset + ADDR_ADDR) as ArrayBuffer | null;
  if (addrPtr === null) return false;
  const encoded = encodeAddr(address);
  Pointer.copyTo(addrPtr, new Uint8Array(encoded.buf));
  Pointer.writeU32(destPath, pathOffset + ADDR_ADDRLEN, encoded.len);
  return true;
}
export function writeNativePathUserData(destPath: ArrayBuffer, userData: ArrayBuffer): void {
  Pointer.writeU64(destPath, PATH_USER_DATA, Pointer.addr(userData) as bigint);
}
export function makePacketInfo(ecn = NGTCP2_ECN_NOT_ECT): ArrayBuffer {
  const info = new ArrayBuffer(NGTCP2_PKT_INFO_SIZE);
  writeU8(info, PKT_INFO_ECN, ecn & NGTCP2_ECN_MASK);
  return info;
}
export function packetInfoEcn(info: ArrayBuffer | null): number | undefined {
  if (info === null) return undefined;
  return new Uint8Array(info)[PKT_INFO_ECN]! & NGTCP2_ECN_MASK;
}
export function qlogOutputPath(
  basePath: string | undefined,
  connectionId: string,
): {
  path: string;
  directory?: string;
} {
  if (basePath === undefined || basePath.length === 0) return { path: `${connectionId}.sqlog` };
  if (basePath.endsWith('/'))
    return {
      directory: basePath.slice(0, -1),
      path: `${basePath}${connectionId}.sqlog`,
    };
  const last = basePath.slice(basePath.lastIndexOf('/') + 1);
  if (last.includes('.')) return { path: basePath };
  return {
    directory: basePath,
    path: `${basePath}/${connectionId}.sqlog`,
  };
}
export function writeAllFd(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const chunk = data.subarray(offset);
    const written = Number(fileLib.symbols.write(fd, chunk, chunk.byteLength));
    if (written <= 0) throw new Error(`qlog write failed: ${written}`);
    offset += written;
  }
}
export function appendKeylogLine(options: QuicKeylogOptions, line: string): void {
  if (options === false) return;
  const fd = Number(
    fileLib.symbols.open(fileCstr(options.path), O_WRONLY | O_CREAT | O_APPEND, 384),
  );
  if (fd < 0) return;
  try {
    fileLib.symbols.fchmod(fd, 384);
    const data = encodeUtf8(`${line}\n`);
    writeAllFd(fd, data);
  } finally {
    fileLib.symbols.close(fd);
  }
}
export function createServerTlsContext(
  certificateFile: string,
  privateKeyFile: string,
  alpnProtocols: string[],
  options: Pick<ResolvedQuicOptions, 'tlsCipherSuites' | 'tlsGroups' | 'keylog'>,
  tlsOptions: {
    clientAuth?: 'none' | 'request' | 'require';
    verifyClient?: boolean;
    rejectUnauthorized?: boolean;
    ca?: QuicCaOptions;
    groups?: readonly string[] | null;
  },
): QuicTlsContext {
  return newServerContext(
    certificateFile,
    privateKeyFile,
    alpnProtocols,
    options.tlsCipherSuites,
    options.keylog === false ? undefined : (line) => appendKeylogLine(options.keylog, line),
    {
      ...tlsOptions,
      groups: tlsOptions.groups ?? options.tlsGroups,
    },
  );
}
export let _qlogWriteCallback: FfiCallback | null = null;
export function qlogWriteCallbackPointer(): ArrayBuffer {
  if (_qlogWriteCallback === null) {
    _qlogWriteCallback = new FfiCallback(
      {
        parameters: ['pointer', 'u32', 'pointer', 'usize'],
        result: 'void',
      },
      (userData: ArrayBuffer | null, flags: number, data: ArrayBuffer | null, datalen: bigint) =>
        withNativeCallback(() => {
          connectionFromUserData(userData)?.[quicConnectionInternals.onQlogWrite](
            flags,
            copyFromPtr(data, Number(datalen)),
          );
        }),
    );
    _callbackRefs.push(_qlogWriteCallback);
  }
  return _qlogWriteCallback.pointer;
}
export function congestionControlValue(value: 'cubic' | 'reno' | 'bbr'): number {
  if (value === 'reno') return 0;
  if (value === 'bbr') return 2;
  return 1;
}
export function makeSettings(
  options: ResolvedQuicOptions,
  runtime: QuicRuntime,
  token: Uint8Array | null = null,
  tokenType = NGTCP2_TOKEN_TYPE_UNKNOWN,
  originalVersion = 0,
): ArrayBuffer {
  const settings = new ArrayBuffer(NGTCP2_SETTINGS_SIZE);
  ngtcp2Sym!.ngtcp2_settings_default_versioned(NGTCP2_SETTINGS_VERSION, Pointer.of(settings));
  const versions = compatibleVersionList(options.versions);
  if (options.qlog !== false) writePtr(settings, SETTINGS_QLOG_WRITE, qlogWriteCallbackPointer());
  if (options.connection.congestionControl !== 'cubic') {
    writeU32(
      settings,
      SETTINGS_CC_ALGO,
      congestionControlValue(options.connection.congestionControl),
    );
  }
  writeU64(settings, SETTINGS_INITIAL_TS, now(runtime));
  if (options.connection.initialRtt > 0n)
    writeU64(settings, SETTINGS_INITIAL_RTT, options.connection.initialRtt);
  writeU64(
    settings,
    SETTINGS_MAX_TX_UDP_PAYLOAD_SIZE,
    BigInt(
      options.connection.maxPayloadSize === DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE
        ? NGTCP2_MAX_UDP_PAYLOAD_SIZE
        : options.connection.maxPayloadSize,
    ),
  );
  writeU64(
    settings,
    SETTINGS_MAX_WINDOW,
    options.connection.maxWindow === 0n ? MAX_RECEIVE_WINDOW : options.connection.maxWindow,
  );
  writeU64(
    settings,
    SETTINGS_MAX_STREAM_WINDOW,
    options.connection.maxStreamWindow === 0n
      ? MAX_RECEIVE_WINDOW
      : options.connection.maxStreamWindow,
  );
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
export function makeTransportParams(
  originalDcid: ArrayBuffer | null = null,
  options?: ResolvedQuicOptions,
  retryScid: ArrayBuffer | null = null,
  preferredAddress?: PreferredAddressParams | null,
  statelessResetToken?: Uint8Array | null,
): ArrayBuffer {
  const params = new ArrayBuffer(NGTCP2_TRANSPORT_PARAMS_SIZE);
  ngtcp2Sym!.ngtcp2_transport_params_default_versioned(
    NGTCP2_TRANSPORT_PARAMS_VERSION,
    Pointer.of(params),
  );
  const connection = options?.connection;
  writeU64(
    params,
    TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL,
    connection?.initialMaxStreamDataBidiLocal ?? INITIAL_MAX_STREAM_DATA,
  );
  writeU64(
    params,
    TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE,
    connection?.initialMaxStreamDataBidiRemote ?? INITIAL_MAX_STREAM_DATA,
  );
  writeU64(
    params,
    TP_INITIAL_MAX_STREAM_DATA_UNI,
    connection?.initialMaxStreamDataUni ?? INITIAL_MAX_STREAM_DATA,
  );
  writeU64(params, TP_INITIAL_MAX_DATA, connection?.initialMaxData ?? INITIAL_MAX_DATA);
  writeU64(
    params,
    TP_INITIAL_MAX_STREAMS_BIDI,
    connection?.initialMaxStreamsBidi ?? INITIAL_MAX_STREAMS_BIDI,
  );
  writeU64(
    params,
    TP_INITIAL_MAX_STREAMS_UNI,
    connection?.initialMaxStreamsUni ?? INITIAL_MAX_STREAMS_UNI,
  );
  writeU64(params, TP_MAX_IDLE_TIMEOUT, connection?.maxIdleTimeout ?? MAX_IDLE_TIMEOUT);
  writeU64(params, TP_MAX_UDP_PAYLOAD_SIZE, BigInt(NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE));
  writeU64(
    params,
    TP_ACTIVE_CONNECTION_ID_LIMIT,
    connection?.activeConnectionIdLimit ?? ACTIVE_CONNECTION_ID_LIMIT,
  );
  writeU64(params, TP_ACK_DELAY_EXPONENT, connection?.ackDelayExponent ?? 3n);
  writeU64(params, TP_MAX_ACK_DELAY, connection?.maxAckDelay ?? 25n * NGTCP2_MILLISECONDS);
  writeU8(params, TP_DISABLE_ACTIVE_MIGRATION, connection?.disableActiveMigration === true ? 1 : 0);
  if (options?.datagrams.enabled === true) {
    writeU64(params, TP_MAX_DATAGRAM_FRAME_SIZE, BigInt(options.datagrams.maxFrameSize));
  }
  if (statelessResetToken !== undefined && statelessResetToken !== null) {
    new Uint8Array(params, TP_STATELESS_RESET_TOKEN, NGTCP2_STATELESS_RESET_TOKENLEN).set(
      statelessResetToken.subarray(0, NGTCP2_STATELESS_RESET_TOKENLEN),
    );
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
    new Uint8Array(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_CID, NGTCP2_CID_SIZE).set(
      new Uint8Array(firstEntry.cid),
    );
    if (preferredAddress.ipv4 !== undefined) {
      const encoded = encodeAddr(preferredAddress.ipv4.address);
      new Uint8Array(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_IPV4, encoded.len).set(
        new Uint8Array(encoded.buf),
      );
      writeU8(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_IPV4_PRESENT, 1);
    }
    if (preferredAddress.ipv6 !== undefined) {
      const encoded = encodeAddr(preferredAddress.ipv6.address);
      new Uint8Array(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_IPV6, encoded.len).set(
        new Uint8Array(encoded.buf),
      );
      writeU8(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_IPV6_PRESENT, 1);
    }
    new Uint8Array(params, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN, 16).set(
      firstEntry.statelessResetToken.subarray(0, 16),
    );
    writeU8(params, TP_PREFERRED_ADDR_PRESENT, 1);
  }
  return params;
}
export function readUserDataId(userData: ArrayBuffer | null): number {
  if (userData === null) return 0;
  return Number(Pointer.readU64(userData, 0));
}
export function connectionFromUserData(userData: ArrayBuffer | null): QuicConnection | undefined {
  return _nativeConnections.get(readUserDataId(userData));
}
export let _callbackTable: ArrayBuffer | null = null;
export let _callbackRefs: Array<{
  close(): void;
}> = [];
export function ensureCallbackTable(): ArrayBuffer {
  if (_callbackTable !== null) return _callbackTable;
  if (cryptoPtr === null || ngtcp2Ptr === null)
    throw new Error('ngtcp2 callback symbols are unavailable');
  const cbs = new ArrayBuffer(NGTCP2_CALLBACKS_SIZE);
  const retain = (cb: { pointer: ArrayBuffer; close(): void }) => {
    _callbackRefs.push(cb);
    return cb.pointer;
  };
  const getConn = new FfiCallback(
    {
      parameters: ['pointer'],
      result: 'pointer',
    },
    (connRef: ArrayBuffer) =>
      withNativeCallback(() => {
        const userData = Pointer.readPointer(connRef, 8) as ArrayBuffer | null;
        return connectionFromUserData(userData)?.nativeHandle ?? null;
      }),
  );
  const handshakeCompleted = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer'],
      result: 'i32',
    },
    (_conn: ArrayBuffer, userData: ArrayBuffer | null) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onHandshakeCompleted]();
        return 0;
      }),
  );
  const handshakeConfirmed = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer'],
      result: 'i32',
    },
    (_conn: ArrayBuffer, userData: ArrayBuffer | null) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onHandshakeConfirmed]();
        return 0;
      }),
  );
  const recvStreamData = new FfiCallback(
    {
      parameters: [
        'ignoredPointer',
        'u32',
        'i64',
        'u64',
        'pointer',
        'usize',
        'pointer',
        'ignoredPointer',
      ],
      result: 'i32',
    },
    (
      _conn: ArrayBuffer,
      flags: number,
      streamId: bigint,
      offset: bigint,
      data: ArrayBuffer | null,
      datalen: bigint,
      userData: ArrayBuffer | null,
    ) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onStreamData](
          Number(streamId),
          Number(offset),
          copyFromPtr(data, Number(datalen)),
          (flags & STREAM_DATA_FLAG_FIN) !== 0,
        );
        return 0;
      }),
  );
  const recvDatagram = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'u32', 'pointer', 'usize', 'pointer'],
      result: 'i32',
    },
    (
      _conn: ArrayBuffer,
      flags: number,
      data: ArrayBuffer | null,
      datalen: bigint,
      userData: ArrayBuffer | null,
    ) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onDatagram](
          copyFromPtr(data, Number(datalen)),
          (flags & NGTCP2_DATAGRAM_FLAG_0RTT) !== 0,
        );
        return 0;
      }),
  );
  const streamOpen = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'i64', 'pointer'],
      result: 'i32',
    },
    (_conn: ArrayBuffer, streamId: bigint, userData: ArrayBuffer | null) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onRemoteStreamOpen](
          Number(streamId),
        );
        return 0;
      }),
  );
  const streamClose = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'u32', 'i64', 'u64', 'pointer', 'ignoredPointer'],
      result: 'i32',
    },
    (_conn, _flags, streamId, _appCode, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onStreamClose](Number(streamId));
        return 0;
      }),
  );
  const streamReset = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'i64', 'u64', 'u64', 'pointer', 'ignoredPointer'],
      result: 'i32',
    },
    (_conn, streamId, _finalSize, appCode, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onStreamReset](
          Number(streamId),
          Number(appCode),
        );
        return 0;
      }),
  );
  const acked = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'i64', 'u64', 'u64', 'pointer', 'ignoredPointer'],
      result: 'i32',
    },
    (_conn, streamId, offset, datalen, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onAckedStreamDataOffset](
          Number(streamId),
          Number(offset),
          Number(datalen),
        );
        return 0;
      }),
  );
  const extendStreamsBidi = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'u64', 'pointer'],
      result: 'i32',
    },
    (_conn, _maxStreams, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onLocalStreamCredit](
          'bidirectional',
        );
        return 0;
      }),
  );
  const extendStreamsUni = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'u64', 'pointer'],
      result: 'i32',
    },
    (_conn, _maxStreams, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onLocalStreamCredit](
          'unidirectional',
        );
        return 0;
      }),
  );
  const extendMaxStreamData = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'i64', 'u64', 'pointer', 'ignoredPointer'],
      result: 'i32',
    },
    (_conn, streamId, maxData, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onStreamDataCredit](
          Number(streamId),
          Number(maxData),
        );
        return 0;
      }),
  );
  const stopSending = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'i64', 'u64', 'pointer', 'ignoredPointer'],
      result: 'i32',
    },
    (_conn, streamId, appCode, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onStreamStopSending](
          Number(streamId),
          Number(appCode),
        );
        return 0;
      }),
  );
  const rand = new FfiCallback(
    {
      parameters: ['pointer', 'usize', 'ignoredPointer'],
      result: 'void',
    },
    (dest: ArrayBuffer | null, len: bigint) =>
      withNativeCallback(() => {
        if (dest !== null) Pointer.copyTo(dest, randomBytes(Number(len)));
      }),
  );
  const getPathChallengeData = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer', 'ignoredPointer'],
      result: 'i32',
    },
    (_conn, data) =>
      withNativeCallback(() => {
        if (data === null) return NGTCP2_ERR_CALLBACK_FAILURE;
        Pointer.copyTo(data, randomBytes(8));
        return 0;
      }),
  );
  const getNewConnectionId = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer', 'pointer', 'usize', 'pointer'],
      result: 'i32',
    },
    (_conn, cid, token, cidlen, userData) =>
      withNativeCallback(() => {
        const bytes = randomBytes(Number(cidlen));
        Pointer.writeU64(cid, CID_DATALEN, cidlen);
        Pointer.copyTo(Pointer.offset(cid, CID_DATA), bytes);
        Pointer.copyTo(token, randomBytes(16));
        connectionFromUserData(userData)?.[quicConnectionInternals.registerIssuedCid](
          makeCid(bytes),
        );
        return 0;
      }),
  );
  const removeConnectionId = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer', 'pointer'],
      result: 'i32',
    },
    (_conn, cid, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.unregisterIssuedCid](cid);
        return 0;
      }),
  );
  const dcidStatus = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'i32', 'u64', 'pointer', 'pointer', 'pointer'],
      result: 'i32',
    },
    (_conn, type, _seq, cid, token, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onDestinationCidStatus](
          type,
          cid,
          token,
        );
        return 0;
      }),
  );
  const recvNewToken = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer', 'usize', 'pointer'],
      result: 'i32',
    },
    (_conn, token, tokenlen, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onNewToken](
          copyFromPtr(token, Number(tokenlen)),
        );
        return 0;
      }),
  );
  const ackDatagram = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'u64', 'pointer'],
      result: 'i32',
    },
    (_conn, dgramId, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onDatagramStatus](
          Number(dgramId),
          'ack',
        );
        return 0;
      }),
  );
  const lostDatagram = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'u64', 'pointer'],
      result: 'i32',
    },
    (_conn, dgramId, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onDatagramStatus](
          Number(dgramId),
          'lost',
        );
        return 0;
      }),
  );
  const recvKey = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'i32', 'pointer'],
      result: 'i32',
    },
    (_conn, level, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onKeyInstalled](level);
        return 0;
      }),
  );
  const recvVersionNegotiation = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer', 'pointer', 'usize', 'pointer'],
      result: 'i32',
    },
    (_conn, hd, sv, nsv, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onVersionNegotiation](
          hd,
          sv,
          Number(nsv),
        );
        return 0;
      }),
  );
  const earlyDataRejected = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer'],
      result: 'i32',
    },
    (_conn, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onEarlyDataRejected]();
        return 0;
      }),
  );
  const recvStatelessReset = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'ignoredPointer', 'pointer'],
      result: 'i32',
    },
    (_conn, _sr, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onStatelessReset]();
        return 0;
      }),
  );
  const beginPathValidation = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'u32', 'pointer', 'pointer', 'pointer'],
      result: 'i32',
    },
    (_conn, flags, path, fallbackPath, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onPathValidationStarted](
          path,
          fallbackPath,
          flags,
        );
        return 0;
      }),
  );
  const pathValidation = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'u32', 'pointer', 'pointer', 'i32', 'pointer'],
      result: 'i32',
    },
    (_conn, flags, path, fallbackPath, result, userData) =>
      withNativeCallback(() => {
        connectionFromUserData(userData)?.[quicConnectionInternals.onPathValidationFinished](
          path,
          fallbackPath,
          result,
          flags,
        );
        return 0;
      }),
  );
  const selectPreferredAddress = new FfiCallback(
    {
      parameters: ['ignoredPointer', 'pointer', 'pointer', 'pointer'],
      result: 'i32',
    },
    (_conn, dest, paddr, userData) =>
      withNativeCallback(() => {
        return (
          connectionFromUserData(userData)?.[quicConnectionInternals.selectPreferredAddress](
            dest,
            paddr,
          ) ?? 0
        );
      }),
  );
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
  (ensureCallbackTable as any)[getConnPointerSlot] = getConn.pointer;
  _callbackTable = cbs;
  return cbs;
}
export function getConnRefPointer(): ArrayBuffer {
  ensureCallbackTable();
  return (ensureCallbackTable as any)[getConnPointerSlot];
}
/**
 * Return the process-wide ngtcp2 callback table for QUIC ABI tests.
 *
 * The table is built lazily and cached; this returns the same backing
 * `ArrayBuffer` the native connections use, so tests can assert its size and
 * layout match the ngtcp2 ABI.
 *
 * ```ts no_run
 * import { __inspectQuicCallbackTable } from 'internal:net/quic/endpoint';
 * const table = __inspectQuicCallbackTable();
 * console.log(table.byteLength);
 * ```
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
 * Exposes the per-turn packet read caps and the default rate-limiter rate/burst
 * pairs as plain numbers so tests can pin them against expected constants.
 *
 * ```ts no_run
 * import { __inspectQuicRuntimeTuning } from 'internal:net/quic/endpoint';
 * const tuning = __inspectQuicRuntimeTuning();
 * console.log(tuning.maxReadPacketsPerTurn, tuning.retryRate);
 * ```
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
    sessionCreationBurst: DEFAULT_SESSION_CREATION_BURST,
  };
}
export function ngtcp2Error(code: number, context: string): Error {
  let text = String(code);
  try {
    const ptr = ngtcp2Sym!.ngtcp2_strerror(code) as ArrayBuffer | null;
    if (ptr !== null) text = readCStr(ptr);
  } catch {}
  return new Error(`${context}: ${text} (${code})`);
}
/**
 * Event carrying a new `QuicConnection`, dispatched on a `QuicEndpoint`.
 *
 * Fired as the `'connection'` event when a server endpoint accepts an incoming
 * connection, giving event-driven code an alternative to awaiting
 * `endpoint.accept()`.
 *
 * ```ts no_run
 * endpoint.addEventListener('connection', (event) => {
 *   const conn = (event as QuicConnectionEvent).connection;
 *   console.log('accepted from', conn.remoteAddress.ip);
 * });
 * ```
 */
export class QuicConnectionEvent extends Event {
  /** The connection this event announces. */
  readonly connection: QuicConnection;
  /** Wrap one `QuicConnection` in an endpoint connection event. */
  constructor(
    type: string,
    init: {
      connection: QuicConnection;
    },
  ) {
    super(type);
    this.connection = init.connection;
  }
}
/**
 * Event carrying a new `QuicStream`, dispatched on a `QuicConnection`.
 *
 * Fired as the `'stream'` event when the peer opens a stream, giving
 * event-driven code an alternative to awaiting `connection.acceptStream()`.
 *
 * ```ts no_run
 * connection.addEventListener('stream', (event) => {
 *   const stream = (event as QuicStreamEvent).stream;
 *   pump(stream.readable);
 * });
 * ```
 */
export class QuicStreamEvent extends Event {
  /** The stream this event announces. */
  readonly stream: QuicStream;
  /** Wrap one `QuicStream` in a connection stream event. */
  constructor(
    type: string,
    init: {
      stream: QuicStream;
    },
  ) {
    super(type);
    this.stream = init.stream;
  }
}
/**
 * Event fired when a stream cannot send because QUIC flow control blocked it.
 *
 * Dispatched as `'blocked'` on the connection when the peer's stream- or
 * connection-level flow-control window is exhausted; the stream resumes
 * automatically once the peer extends credit.
 *
 * ```ts no_run
 * connection.addEventListener('blocked', (event) => {
 *   console.warn('stream flow-control blocked', (event as QuicStreamBlockedEvent).streamId);
 * });
 * ```
 */
export class QuicStreamBlockedEvent extends Event {
  /** Stream that was blocked by QUIC flow control. */
  readonly stream: QuicStream;
  /** Owning QUIC connection. */
  readonly connection: QuicConnection;
  /** Numeric QUIC stream identifier. */
  readonly streamId: number;
  /** Create an event carrying one flow-control blocked stream notification. */
  constructor(
    type: string,
    init: {
      stream: QuicStream;
      connection: QuicConnection;
      streamId?: number;
    },
  ) {
    super(type);
    this.stream = init.stream;
    this.connection = init.connection;
    this.streamId = init.streamId ?? init.stream.id;
  }
}
/**
 * Event fired when the peer aborts a stream's sending side with RESET_STREAM.
 *
 * Dispatched as `'reset'` on the stream; the readable side ends and no further
 * data will arrive. `errorCode` is the peer's application error code.
 *
 * ```ts no_run
 * stream.addEventListener('reset', (event) => {
 *   console.error('peer reset stream', (event as QuicStreamResetEvent).errorCode);
 * });
 * ```
 */
export class QuicStreamResetEvent extends Event {
  /** Peer application error code carried by RESET_STREAM. */
  readonly errorCode: number;
  /** Error object suitable for compatibility with existing error handlers. */
  readonly error: Error;
  /** Create an event carrying one RESET_STREAM application code. */
  constructor(
    type: string,
    init: {
      errorCode: number;
      error?: Error;
    },
  ) {
    super(type);
    this.errorCode = init.errorCode;
    this.error = init.error ?? new Error(`QUIC stream reset: ${init.errorCode}`);
  }
}
/**
 * Event carrying one received unreliable QUIC DATAGRAM payload.
 *
 * Dispatched as `'datagram'` on the connection for each received RFC 9221
 * DATAGRAM frame. Delivery is unreliable and unordered; `earlyData` marks
 * payloads that arrived in 0-RTT packet space. The same payloads are also
 * available through `connection.datagrams` as a `ReadableStream`.
 *
 * ```ts no_run
 * connection.addEventListener('datagram', (event) => {
 *   handle((event as QuicDatagramEvent).data);
 * });
 * ```
 */
export class QuicDatagramEvent extends Event {
  /** Datagram payload copied from ngtcp2 receive memory. */
  readonly data: Uint8Array;
  /** True when the datagram arrived in 0-RTT packet space. */
  readonly earlyData: boolean;
  /** Create an event carrying one received QUIC DATAGRAM payload. */
  constructor(
    type: string,
    init: {
      data: Uint8Array;
      earlyData?: boolean;
    },
  ) {
    super(type);
    this.data = init.data;
    this.earlyData = init.earlyData === true;
  }
}
/**
 * Event reporting the delivery outcome of a locally sent QUIC DATAGRAM.
 *
 * Dispatched as `'datagramack'`, `'datagramlost'`, or `'datagramabandoned'` on
 * the connection (also reflected in `status`), keyed by the `id` returned from
 * `sendDatagram()`. Because DATAGRAMs are unreliable, `lost` and `abandoned`
 * are normal outcomes, not errors.
 *
 * ```ts no_run
 * connection.addEventListener('datagramlost', (event) => {
 *   console.log('datagram lost', (event as QuicDatagramStatusEvent).id);
 * });
 * ```
 */
export class QuicDatagramStatusEvent extends Event {
  /** Application-assigned datagram identifier passed to ngtcp2. */
  readonly id: number;
  /** Delivery status reported by ngtcp2 recovery. */
  readonly status: QuicDatagramStatus;
  /** Create an event carrying one QUIC DATAGRAM delivery status update. */
  constructor(
    type: string,
    init: {
      id: number;
      status: QuicDatagramStatus;
    },
  ) {
    super(type);
    this.id = init.id;
    this.status = init.status;
  }
}
/**
 * Event carrying a server-issued NEW_TOKEN address-validation token.
 *
 * Dispatched as `'newtoken'` on a client connection when the server sends a
 * NEW_TOKEN frame. Persisting the token (for example via a session store) lets
 * a later connection to the same address skip the Retry round trip.
 *
 * ```ts no_run
 * connection.addEventListener('newtoken', (event) => {
 *   const e = event as QuicNewTokenEvent;
 *   saveToken(e.address, e.token);
 * });
 * ```
 */
export class QuicNewTokenEvent extends Event {
  /** Address-validation token received from a QUIC NEW_TOKEN frame. */
  readonly token: Uint8Array;
  /** Peer address for which the token is valid. */
  readonly address: QuicAddress;
  /** Create an event carrying a QUIC NEW_TOKEN address-validation token. */
  constructor(
    type: string,
    init: {
      token: Uint8Array;
      address: QuicAddress;
    },
  ) {
    super(type);
    this.token = init.token;
    this.address = { ...init.address };
  }
}
/**
 * Event reporting whether attempted 0-RTT early data was accepted or rejected.
 *
 * Dispatched as `'earlydata'` on a client connection that attempted 0-RTT.
 * When `rejected` is true the early data must be replayed after the handshake;
 * `reason` gives a stable, application-readable cause (for example an expired
 * or incompatible session).
 *
 * ```ts no_run
 * connection.addEventListener('earlydata', (event) => {
 *   const e = event as QuicEarlyDataEvent;
 *   if (e.rejected) replayRequest(e.reason);
 * });
 * ```
 */
export class QuicEarlyDataEvent extends Event {
  /** True when the attempted 0-RTT state is usable for early writes. */
  readonly accepted: boolean;
  /** True when early data was attempted but cannot be used. */
  readonly rejected: boolean;
  /** Stable application-readable reason for the early-data decision. */
  readonly reason: string;
  /** Create an event carrying one 0-RTT early-data decision. */
  constructor(
    type: string,
    init: {
      accepted: boolean;
      rejected: boolean;
      reason: string;
    },
  ) {
    super(type);
    this.accepted = init.accepted;
    this.rejected = init.rejected;
    this.reason = init.reason;
  }
}
/**
 * Event fired when the peer asks us to stop sending on a stream (STOP_SENDING).
 *
 * Dispatched as `'stopsending'` on the stream: the peer no longer wants data on
 * our sending side. `errorCode` is the peer's application code; the usual
 * response is to reset the stream.
 *
 * ```ts no_run
 * stream.addEventListener('stopsending', (event) => {
 *   stream.reset((event as QuicStopSendingEvent).errorCode);
 * });
 * ```
 */
export class QuicStopSendingEvent extends Event {
  /** Peer application error code carried by STOP_SENDING. */
  readonly errorCode: number;
  /** Error object suitable for compatibility with existing error handlers. */
  readonly error: Error;
  /** Create an event carrying one peer STOP_SENDING application code. */
  constructor(
    type: string,
    init: {
      errorCode: number;
      error?: Error;
    },
  ) {
    super(type);
    this.errorCode = init.errorCode;
    this.error = init.error ?? new Error(`QUIC stream stop sending: ${init.errorCode}`);
  }
}
/**
 * Event reporting the result of a QUIC path validation.
 *
 * Dispatched as `'pathvalidation'` on the connection when ngtcp2 finishes
 * probing a network path — during connection migration or when adopting a
 * server preferred address. `result` is `'success'`, `'failure'`, or
 * `'aborted'`; `path` is the path that was validated (or failed) and
 * `previousPath` the one it may fall back to.
 *
 * ```ts no_run
 * connection.addEventListener('pathvalidation', (event) => {
 *   const e = event as QuicPathValidationEvent;
 *   if (e.result === 'success') console.log('migrated to', e.path?.localAddress.ip);
 * });
 * ```
 */
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
  constructor(
    type: string,
    init: {
      result: QuicPathValidationResult;
      path: QuicPath | null;
      previousPath?: QuicPath | null;
      preferredAddress?: boolean;
      newToken?: boolean;
    },
  ) {
    super(type);
    this.result = init.result;
    this.path = init.path;
    this.previousPath = init.previousPath ?? null;
    this.preferredAddress = init.preferredAddress === true;
    this.newToken = init.newToken === true;
  }
}
/**
 * Event carrying a connection-level error, dispatched as `'error'`.
 *
 * Fired on the connection (and re-surfaced on the owning endpoint) when a
 * connection fails — a handshake error, transport error, or unexpected native
 * failure. The connection is closing or closed by the time it fires.
 *
 * ```ts no_run
 * connection.addEventListener('error', (event) => {
 *   console.error('quic connection failed', (event as QuicErrorEvent).error);
 * });
 * ```
 */
export class QuicErrorEvent extends Event {
  /** The error that caused the connection to fail. */
  readonly error: Error;
  /** Wrap one `Error` in a connection error event. */
  constructor(
    type: string,
    init: {
      error: Error;
    },
  ) {
    super(type);
    this.error = init.error;
  }
}
/**
 * Error thrown when QUIC Version Negotiation finds no mutually supported version.
 *
 * A server offered a set of versions in a Version Negotiation packet, but none
 * of them intersects the client's enabled `versions`, so the handshake cannot
 * proceed. Both version lists are exposed as raw wire numbers for diagnostics.
 *
 * ```ts no_run
 * try {
 *   await endpoint.connect({ address, versions: ['v2'] });
 * } catch (err) {
 *   if (err instanceof QuicVersionNegotiationError) {
 *     console.error('no common version', err.requestedVersions, err.supportedVersions);
 *   }
 * }
 * ```
 */
export class QuicVersionNegotiationError extends Error {
  /** Wire version numbers the client offered. */
  readonly requestedVersions: readonly number[];
  /** Wire version numbers the server advertised as supported. */
  readonly supportedVersions: readonly number[];
  /** Build the error from the offered and advertised version lists. */
  constructor(requestedVersions: readonly number[], supportedVersions: readonly number[]) {
    super('QUIC Version Negotiation did not include a mutually supported retry version');
    this.requestedVersions = requestedVersions;
    this.supportedVersions = supportedVersions;
  }
}
/**
 * Routes incoming QUIC packets to a connection by destination connection ID.
 *
 * A QUIC connection is identified not by its 4-tuple but by the connection IDs
 * it advertises, so a single endpoint maps every active (and retiring) CID to
 * its owning connection here. Keys are normalized from either a raw CID byte
 * array or its hex string form, so callers may look up with whichever they
 * hold. The endpoint owns one instance (`endpoint.cidTable`); the default type
 * parameter is `QuicConnection`.
 *
 * ```ts no_run
 * import { CidRoutingTable } from 'internal:net/quic/endpoint';
 *
 * const table = new CidRoutingTable<{ name: string }>();
 * table.add(new Uint8Array([1, 2, 3, 4]), { name: 'conn-a' });
 * table.get('01020304'); // → { name: 'conn-a' }
 * table.delete('01020304');
 * ```
 */
export class CidRoutingTable<T = QuicConnection> {
  #entries = new Map<string, T>();
  /** Associate a connection ID (bytes or hex) with a value. */
  add(cid: Uint8Array | string, value: T): void {
    this.#entries.set(cidKey(cid), value);
  }
  /** Look up the value routed to by a connection ID, or `undefined`. */
  get(cid: Uint8Array | string): T | undefined {
    return this.#entries.get(cidKey(cid));
  }
  /** Remove a connection ID's route; returns whether an entry existed. */
  delete(cid: Uint8Array | string): boolean {
    return this.#entries.delete(cidKey(cid));
  }
  /** Drop every route, for example when the endpoint closes. */
  clear(): void {
    this.#entries.clear();
  }
}
/**
 * A QUIC endpoint: the owner of UDP sockets, listeners, and connections.
 *
 * One endpoint can act as both a server and a client. `listen()` binds a socket
 * and returns a `QuicListener`; accepted connections arrive through `accept()`
 * or the `'connection'` event. `connect()` binds an ephemeral socket and dials
 * a peer, returning a `QuicConnection`. The constructor takes endpoint-wide
 * defaults (`QuicEndpointOptions`) that every listener and connection inherits,
 * plus an optional second `internals` argument used only by deterministic tests
 * to inject a clock and transport factory.
 *
 * The endpoint holds the shared server-side machinery: the connection-ID
 * routing table (`cidTable`), the Retry / Version Negotiation / stateless-reset
 * / immediate-close / session-creation rate limiters, source-address filtering,
 * and address-validation caches. It extends `EventTarget` and emits
 * `'connection'`, `'error'`, and `'close'`. It also implements
 * `Symbol.asyncDispose`, so an `await using` endpoint closes automatically.
 *
 * Call `close()` for an immediate teardown or `closeGracefully()` to let
 * in-flight connections drain first.
 *
 * ```ts no_run
 * import { QuicEndpoint } from 'internal:net/quic/endpoint';
 *
 * await using endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
 * const listener = await endpoint.listen({
 *   address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
 *   certificateFile: '/etc/tls/cert.pem',
 *   privateKeyFile: '/etc/tls/key.pem',
 * });
 * for (;;) {
 *   const conn = await endpoint.accept();
 *   handleConnection(conn);
 * }
 * ```
 */
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
    clientConnections: 0,
  };
  #transports = new Map<number, QuicDatagramTransport>();
  #transportFactory: QuicDatagramTransportFactory;
  #runtime: QuicRuntime;
  // Reused scratch for per-packet version/CID decoding in _handleDatagram.
  // _handleDatagram runs synchronously per packet and no callee retains these,
  // so a single set of buffers avoids allocating on every received datagram.
  #vcidScratch = new ArrayBuffer(NGTCP2_VERSION_CID_SIZE);
  #vcidView = new DataView(this.#vcidScratch);
  #vcidScratchPtr = new Uint8Array(8);
  #vcidDcidPtrView = new Uint8Array(this.#vcidScratch, VERSION_CID_DCID, 8);
  #dcidScratch = new Uint8Array(NGTCP2_MAX_CIDLEN);
  #clientBindAddress?: QuicAddress;
  #closed = false;
  #createdAt = Date.now();
  #destroyedAt: number | null = null;
  #routeCleanupTimers = new Set<QuicTimerHandle>();
  #options: ResolvedQuicOptions;
  /** Connection-ID routing table mapping every active CID to its connection. */
  readonly cidTable = new CidRoutingTable();
  /** Default ALPN protocol list inherited by listeners and connections. */
  readonly alpnProtocols: string[];
  /** Enabled QUIC wire versions, in preference order. */
  readonly versions: QuicVersion[];
  /** Configured TLS cipher-suite restriction, or `null` for the default set. */
  readonly tlsCipherSuites: QuicTlsCipherSuite[] | null;
  /** Configured key-exchange groups, or `null` for the default set. */
  readonly tlsGroups: string[] | null;
  /** Resolved Retry / address-validation policy. */
  readonly retry: ResolvedRetryOptions;
  /** Session store used for resumption and 0-RTT, when configured. */
  readonly sessionStore?: QuicSessionStore;
  /** Resolved 0-RTT early-data policy, or `false` when disabled. */
  readonly earlyData: false | QuicEarlyDataPolicy;
  /** Resolved migration and preferred-address policy. */
  readonly migration: ResolvedMigrationOptions;
  /** Resolved DATAGRAM negotiation and queueing settings. */
  readonly datagrams: ResolvedDatagramOptions;
  /** Frozen snapshot of the resolved per-connection transport tuning. */
  readonly connection: QuicResolvedConnectionOptions;
  /** Resolved qlog diagnostics configuration. */
  readonly qlog: QuicQlogOptions;
  /** Resolved TLS keylog diagnostics configuration. */
  readonly keylog: QuicKeylogOptions;
  /** Create an endpoint from endpoint-wide defaults and optional test internals. */
  constructor(options: QuicEndpointOptions = {}, internals: QuicEndpointInternals = {}) {
    super();
    this.#runtime = internals.runtime ?? realQuicRuntime;
    this.#transportFactory =
      internals.transportFactory ??
      (options.socket === undefined
        ? realQuicDatagramTransportFactory
        : new RealQuicDatagramTransportFactory(options.socket));
    this.#clientBindAddress =
      internals.clientBindAddress === undefined
        ? undefined
        : normalizeAddress(internals.clientBindAddress);
    this.alpnProtocols = options.alpnProtocols?.slice() ?? DEFAULT_ALPN_PROTOCOLS.slice();
    this.#options = resolveQuicOptions(options);
    this.#retryBucket = new QuicTokenBucket(
      this.#options.transport.retryRateLimit.rate,
      this.#options.transport.retryRateLimit.burst,
      this.#runtime,
    );
    this.#versionNegotiationBucket = new QuicTokenBucket(
      this.#options.transport.versionNegotiationRateLimit.rate,
      this.#options.transport.versionNegotiationRateLimit.burst,
      this.#runtime,
    );
    this.#statelessResetBucket = new QuicTokenBucket(
      this.#options.transport.statelessResetRateLimit.rate,
      this.#options.transport.statelessResetRateLimit.burst,
      this.#runtime,
    );
    this.#immediateCloseBucket = new QuicTokenBucket(
      this.#options.transport.immediateCloseRateLimit.rate,
      this.#options.transport.immediateCloseRateLimit.burst,
      this.#runtime,
    );
    this.#addressValidation = new QuicAddressValidationCache(
      this.#options.transport.addressValidationCacheSize,
      this.#options.transport.sessionCreationRateLimit,
      ADDRESS_VALIDATION_TIMEOUT,
      this.#runtime,
    );
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
      options: this.#options,
    });
  }
  #dispatch(event: Event): void {
    deferAfterNativeCallback(() => this.dispatchEvent(event));
  }
  /** Snapshot array of the listeners currently open on this endpoint. */
  get listeners(): ReadonlyArray<QuicListener> {
    return this.#listeners.slice();
  }
  /** Whether the endpoint is refusing new server connections (busy mode). */
  get busy(): boolean {
    return this.#options.transport.busy;
  }
  /** Frozen snapshot of the resolved server-transport controls and packet defenses. */
  get transport(): QuicResolvedTransportOptions {
    return freezeTransportSnapshot(this.#options.transport);
  }
  /**
   * Toggle server busy mode.
   *
   * In busy mode the endpoint refuses new incoming Initial packets without
   * creating sessions, letting a server shed load while keeping existing
   * connections alive. Entering busy mode bumps the `serverBusyCount` stat.
   */
  setBusy(busy: boolean): void {
    const nextBusy = Boolean(busy);
    const previousBusy = this.#options.transport.busy;
    if (!this.#options.transport.busy && nextBusy) this.#stats.serverBusyCount++;
    this.#options = {
      ...this.#options,
      transport: {
        ...this.#options.transport,
        busy: nextBusy,
      },
    };
    if (previousBusy !== nextBusy) {
      publishQuicTopic('quic.endpoint.busy.change', {
        endpoint: this,
        busy: nextBusy,
      });
    }
  }
  /**
   * Return address-validation counters for conformance tests.
   *
   * @internal
   */
  [quicEndpointInternals.inspectAddressValidationStats](): {
    retrySent: number;
    retryTokenAccepted: number;
    addressTokenAccepted: number;
  } {
    return {
      retrySent: this.#stats.retrySent,
      retryTokenAccepted: this.#stats.retryTokenAccepted,
      addressTokenAccepted: this.#stats.addressTokenAccepted,
    };
  }
  /** Frozen snapshot of the endpoint's aggregate counters and live gauges. */
  get stats(): QuicEndpointStats {
    return Object.freeze({
      createdAt: this.#createdAt,
      destroyedAt: this.#destroyedAt,
      ...this.#stats,
      activeServerConnections: this.#activeServerConnectionCount(),
      activeConnections: this.#connections.size,
    });
  }
  async [quicEndpointInternals.bindTransport](
    address: QuicAddress,
    options: {
      ecn?: boolean;
    } = {},
  ): Promise<QuicDatagramTransport> {
    const transport = await this.#transportFactory.bind(address, options);
    this.#transports.set(transport.id, transport);
    return transport;
  }
  [quicEndpointInternals.unregisterTransport](transport: QuicDatagramTransport): void {
    if (this.#transports.get(transport.id) === transport) this.#transports.delete(transport.id);
  }
  [quicEndpointInternals.transportById](id: number): QuicDatagramTransport | undefined {
    return this.#transports.get(id);
  }
  [quicEndpointInternals.runtime](): QuicRuntime {
    return this.#runtime;
  }
  [quicEndpointInternals.recordDatagramSent](bytes: number): void {
    this.#stats.packetsSent++;
    this.#stats.bytesSent += bytes;
  }
  [quicEndpointInternals.recordDatagramReceived](bytes: number): void {
    this.#stats.packetsReceived++;
    this.#stats.bytesReceived += bytes;
  }
  #recordProcessedPacket(): void {
    this.#stats.packetsReceived++;
  }
  #coerceTransport(
    transportOrFd: QuicDatagramTransport | number,
    localAddress: QuicAddress,
  ): QuicDatagramTransport {
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
      close: () => {},
    };
  }
  /**
   * Bind a server socket and start accepting connections on it.
   *
   * Resolves the given `QuicListenOptions` against the endpoint defaults, binds
   * the listen address (and any advertised preferred addresses), builds the TLS
   * server context plus any SNI contexts, and begins the receive loop. The
   * returned `QuicListener` is registered on the endpoint; accepted connections
   * surface through `accept()` / the `'connection'` event.
   *
   * Throws if the endpoint is closed, if QUIC is unavailable, or if
   * `certificateFile`/`privateKeyFile` are missing (`TypeError`). If binding a
   * preferred address or building a TLS context fails, every socket bound for
   * this call is released before the error propagates.
   *
   * ```ts no_run
   * const listener = await endpoint.listen({
   *   address: { family: 'ipv4', ip: '0.0.0.0', port: 4433 },
   *   certificateFile: '/etc/tls/cert.pem',
   *   privateKeyFile: '/etc/tls/key.pem',
   * });
   * ```
   */
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
    const transport = await this[quicEndpointInternals.bindTransport](input, {
      ecn: resolvedOptions.transport.ecn,
    });
    const bound = transport.address;
    const transports = [transport];
    let listenerOptions = resolvedOptions;
    try {
      const preferredAddress = resolvedOptions.migration.preferredAddress;
      if (preferredAddress !== undefined) {
        const boundPreferred: ResolvedPreferredAddressOptions = {};
        if (preferredAddress.ipv4 !== undefined) {
          const preferredTransport = await this[quicEndpointInternals.bindTransport](
            preferredAddress.ipv4,
            { ecn: resolvedOptions.transport.ecn },
          );
          transports.push(preferredTransport);
          boundPreferred.ipv4 = preferredTransport.address;
        }
        if (preferredAddress.ipv6 !== undefined) {
          const preferredTransport = await this[quicEndpointInternals.bindTransport](
            preferredAddress.ipv6,
            { ecn: resolvedOptions.transport.ecn },
          );
          transports.push(preferredTransport);
          boundPreferred.ipv6 = preferredTransport.address;
        }
        listenerOptions = {
          ...resolvedOptions,
          migration: {
            ...resolvedOptions.migration,
            preferredAddress: boundPreferred,
          },
        };
      }
    } catch (error) {
      for (const candidate of transports) {
        this[quicEndpointInternals.unregisterTransport](candidate);
        candidate.close();
      }
      throw error;
    }
    const protocols = options.alpnProtocols?.slice() ?? this.alpnProtocols;
    let ctx: QuicTlsContext | null = null;
    const sniContexts = new Map<string, QuicTlsContext>();
    try {
      ctx = createServerTlsContext(
        options.certificateFile,
        options.privateKeyFile,
        protocols,
        listenerOptions,
        {
          clientAuth: options.clientAuth,
          verifyClient: options.verifyClient === true,
          rejectUnauthorized: options.rejectUnauthorized,
          ca: options.ca,
          groups: listenerOptions.tlsGroups,
        },
      );
      if (options.sni !== undefined) {
        for (const [servername, sni] of Object.entries(options.sni)) {
          sniContexts.set(
            servername,
            createServerTlsContext(
              sni.certificateFile,
              sni.privateKeyFile,
              sni.alpnProtocols?.slice() ?? protocols,
              listenerOptions,
              {
                clientAuth:
                  sni.clientAuth ??
                  (sni.verifyClient === undefined ? options.clientAuth : undefined),
                verifyClient: sni.verifyClient ?? options.verifyClient,
                rejectUnauthorized: sni.rejectUnauthorized ?? options.rejectUnauthorized,
                ca: sni.ca ?? options.ca,
                groups: sni.tlsGroups ?? listenerOptions.tlsGroups,
              },
            ),
          );
        }
        setSNIContexts(ctx, sniContexts);
      }
    } catch (error) {
      if (ctx !== null) freeContext(ctx);
      for (const sniContext of sniContexts.values()) freeContext(sniContext);
      for (const candidate of transports) {
        this[quicEndpointInternals.unregisterTransport](candidate);
        candidate.close();
      }
      throw error;
    }
    const listener = new (quicListenerClass())(
      this,
      bound,
      protocols,
      transports,
      ctx,
      listenerOptions,
      sniContexts,
    );
    this.#listeners.push(listener);
    listener[quicListenerInternals.start]();
    publishQuicTopic('quic.endpoint.listen', {
      endpoint: this,
      listener,
      address: bound,
      options: listenerOptions,
    });
    return listener;
  }
  /**
   * Dial a QUIC server and return the client connection.
   *
   * Binds an ephemeral client socket in the remote address family (or the
   * injected `clientBindAddress`), builds the client TLS context and session,
   * consults `sessionStore` for resumption/0-RTT state and any cached address
   * token, then starts the handshake. The returned `QuicConnection` may still be
   * in its `'connecting'` state — await `openBidirectionalStream()` or the
   * connection's readiness before relying on it.
   *
   * Throws if the endpoint is closed or QUIC is unavailable. Peer verification
   * is governed by `verifyPeer` (default `false`).
   *
   * ```ts no_run
   * const conn = await endpoint.connect({
   *   address: { family: 'ipv4', ip: '203.0.113.10', port: 4433 },
   *   serverName: 'example.com',
   *   verifyPeer: true,
   * });
   * ```
   */
  async connect(options: QuicConnectOptions): Promise<QuicConnection> {
    if (this.#closed) throw new Error('QUIC endpoint is closed');
    requireQuic();
    initCrypto();
    ensureCallbackTable();
    const remoteAddress = normalizeAddress(options.address);
    const resolvedOptions = resolveQuicOptions(options, this.#options);
    const bindAddress =
      this.#clientBindAddress ??
      (remoteAddress.family === 'ipv6'
        ? {
            family: 'ipv6',
            ip: '::',
            port: 0,
          }
        : {
            family: 'ipv4',
            ip: '0.0.0.0',
            port: 0,
          });
    const transport = await this[quicEndpointInternals.bindTransport](bindAddress, {
      ecn: resolvedOptions.transport.ecn,
    });
    const local = transport.address;
    const clientProtocols = options.alpnProtocols?.slice() ?? this.alpnProtocols;
    const ctx = newClientContext(
      options.verifyPeer === true,
      resolvedOptions.tlsCipherSuites,
      resolvedOptions.keylog === false
        ? undefined
        : (line) => appendKeylogLine(resolvedOptions.keylog, line),
      {
        certificateFile: options.certificateFile,
        privateKeyFile: options.privateKeyFile,
        ca: options.ca,
        groups: resolvedOptions.tlsGroups,
      },
    );
    const serverName = options.serverName ?? 'localhost';
    const earlyDataMax =
      resolvedOptions.earlyData === false ? 0 : (resolvedOptions.earlyData.maxBytes ?? 4294967295);
    const tls = newClientSession(
      ctx,
      clientProtocols,
      serverName,
      options.verifyPeer === true,
      earlyDataMax,
    );
    const sessionKey = sessionStoreKey(serverName, clientProtocols);
    const sessionState = await resolvedOptions.sessionStore?.load(sessionKey);
    let resumedSession = false;
    let sessionEarlyDataMax = 0;
    let rememberedTransportParameters: Uint8Array | undefined;
    let rememberedVersion = 0;
    let attemptedEarlyData = false;
    let earlyDataRejectReason: string | null = null;
    let addressToken = this[quicEndpointInternals.loadAddressToken](sessionKey);
    if (sessionState !== undefined && sessionState !== null) {
      if (sessionState.expiresAt !== undefined && sessionState.expiresAt <= Date.now()) {
        if (resolvedOptions.earlyData !== false && sessionState.ticket !== undefined) {
          attemptedEarlyData = true;
          earlyDataRejectReason = 'expired-session';
        }
        await resolvedOptions.sessionStore?.delete(sessionKey);
      } else {
        if (
          sessionState.version !== undefined &&
          resolvedOptions.versions.includes(sessionState.version)
        ) {
          rememberedVersion = versionToWire(sessionState.version);
        }
        if (sessionState.ticket !== undefined && resolvedOptions.earlyData !== false) {
          attemptedEarlyData = true;
          const storedEarlyDataMax =
            resolvedOptions.earlyData === false
              ? 0
              : (sessionState.earlyDataMax ?? resolvedOptions.earlyData.maxBytes ?? 4294967295);
          if (
            sessionState.version !== undefined &&
            !resolvedOptions.versions.includes(sessionState.version)
          ) {
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
    const connection = new (quicConnectionClass())(
      'client',
      this,
      null,
      local,
      remoteAddress,
      clientProtocols,
      transport,
      ctx,
      tls,
      null,
      resolvedOptions,
      serverName,
    );
    connection[quicConnectionInternals.setSessionStoreKey](sessionKey);
    connection[quicConnectionInternals.setClientSessionOptions](
      options.verifyPeer === true,
      earlyDataMax,
    );
    if (addressToken !== null && addressToken.byteLength > 0) {
      connection[quicConnectionInternals.setAddressValidationToken](
        addressToken,
        NGTCP2_TOKEN_TYPE_NEW_TOKEN,
      );
    }
    connection[quicConnectionInternals.initClient](rememberedVersion);
    const earlyTransportParametersAccepted =
      resolvedOptions.earlyData !== false &&
      resumedSession &&
      sessionEarlyDataMax > 0 &&
      rememberedTransportParameters !== undefined &&
      connection[quicConnectionInternals.setEarlyTransportParameters](
        rememberedTransportParameters,
      );
    const earlyDataReady = earlyTransportParametersAccepted;
    if (attemptedEarlyData && !earlyDataReady && earlyDataRejectReason === null) {
      earlyDataRejectReason =
        rememberedTransportParameters === undefined || !earlyTransportParametersAccepted
          ? 'transport-parameters'
          : 'invalid-session';
    }
    connection[quicConnectionInternals.setEarlyDataDiagnostics](attemptedEarlyData, earlyDataReady);
    connection[quicConnectionInternals.setEarlyDataReady](
      earlyDataReady,
      Math.min(earlyDataMax, sessionEarlyDataMax),
    );
    if (earlyDataReady) connection[quicConnectionInternals.deferHandshakeForEarlyData]();
    this[quicEndpointInternals.track](connection);
    connection[quicConnectionInternals.startSocketLoop]();
    publishQuicTopic('quic.endpoint.connect', {
      endpoint: this,
      connection,
      address: remoteAddress,
      options: resolvedOptions,
    });
    if (!earlyDataReady) connection[quicConnectionInternals.driveWrites]();
    if (earlyDataReady) {
      connection[quicConnectionInternals.scheduleEarlyDataEvent](true, 'accepted');
      connection[quicConnectionInternals.waitHandshake]().then(
        () => {
          if (!clientProtocols.includes(connection.alpnProtocol)) {
            connection.close();
            this.#dispatch(
              new QuicErrorEvent('error', {
                error: new Error(
                  `QUIC ALPN mismatch: client offered ${clientProtocols.join(', ') || '(none)'}`,
                ),
              }),
            );
          }
        },
        () => {},
      );
      return connection;
    }
    await connection[quicConnectionInternals.waitHandshake]();
    if (earlyDataRejectReason !== null) {
      const reason = earlyDataRejectReason;
      this.#runtime.setTimer(0, () =>
        connection[quicConnectionInternals.scheduleEarlyDataEvent](false, reason),
      );
    }
    if (!clientProtocols.includes(connection.alpnProtocol)) {
      await connection.close();
      throw new Error(
        `QUIC ALPN mismatch: client offered ${clientProtocols.join(', ') || '(none)'}`,
      );
    }
    return connection;
  }
  /**
   * Wait for and return the next accepted server connection.
   *
   * Resolves as soon as a connection has completed enough of the handshake to be
   * handed to the application, in FIFO order. The returned promise rejects if
   * the endpoint is closed while waiting.
   *
   * ```ts no_run
   * for (;;) {
   *   const conn = await endpoint.accept();
   *   handleConnection(conn);
   * }
   * ```
   */
  accept(): Promise<QuicConnection> {
    return this.#acceptQueue.shift();
  }
  /**
   * Immediately close the endpoint and destroy every connection.
   *
   * Closes all listeners, destroys active connections (sending CONNECTION_CLOSE
   * where possible), waits for them to settle, releases every socket, and
   * rejects any pending `accept()`. Idempotent. Use `closeGracefully()` instead
   * to let in-flight work drain first. Also invoked by `Symbol.asyncDispose`.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    publishQuicTopic('quic.endpoint.closing', {
      endpoint: this,
      stats: this.stats,
    });
    this.#closed = true;
    this.#destroyedAt = Date.now();
    this.#clearRouteCleanupTimers();
    for (const listener of this.#listeners.slice()) await listener.close();
    for (const connection of Array.from(this.#connections))
      connection.destroy(new Error('QUIC endpoint is closed'));
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
      stats: this.stats,
    });
    this.#dispatch(new Event('close'));
  }
  /**
   * Close the endpoint after letting active connections drain.
   *
   * Closes all listeners so no new connections are accepted, then asks every
   * active connection to close gracefully with the given `QuicCloseOptions`
   * (flushing pending stream data and exchanging CONNECTION_CLOSE) before
   * releasing sockets. Idempotent.
   *
   * ```ts no_run
   * await endpoint.closeGracefully({ errorCode: 0, reason: 'shutdown' });
   * ```
   */
  async closeGracefully(options: QuicCloseOptions = {}): Promise<void> {
    if (this.#closed) return;
    publishQuicTopic('quic.endpoint.closing', {
      endpoint: this,
      stats: this.stats,
      graceful: true,
    });
    this.#closed = true;
    this.#destroyedAt = Date.now();
    this.#clearRouteCleanupTimers();
    for (const listener of this.#listeners.slice()) await listener.close();
    await Promise.allSettled(
      Array.from(this.#connections, (connection) => connection.close(options)),
    );
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
      graceful: true,
    });
    this.#dispatch(new Event('close'));
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  [quicEndpointInternals.track](connection: QuicConnection): void {
    this.#connections.add(connection);
    if (connection[quicConnectionInternals.roleForStats]() === 'server')
      this.#stats.serverConnections++;
    else this.#stats.clientConnections++;
    publishQuicTopic(
      connection[quicConnectionInternals.roleForStats]() === 'server'
        ? 'quic.session.created.server'
        : 'quic.session.created.client',
      {
        endpoint: this,
        connection,
        address: connection.remoteAddress,
      },
    );
    for (const cid of connection.routeCids) this.cidTable.add(cid, connection);
    connection.addEventListener('error', (event: any) => {
      const error = event.error instanceof Error ? event.error : new Error(String(event.error));
      publishQuicTopic('quic.endpoint.error', {
        endpoint: this,
        error,
        connection,
      });
      this.#dispatch(
        new QuicErrorEvent('error', {
          error: event.error instanceof Error ? event.error : new Error(String(event.error)),
        }),
      );
    });
    connection.addEventListener(
      'close',
      () => {
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
          timer = this.#runtime.setTimer(
            connection[quicConnectionInternals.drainingRetentionMsForRouting](),
            untrack,
          );
          this.#routeCleanupTimers.add(timer);
        }
      },
      { once: true },
    );
  }
  #clearRouteCleanupTimers(): void {
    for (const timer of this.#routeCleanupTimers) timer.cancel();
    this.#routeCleanupTimers.clear();
  }
  [quicEndpointInternals.forgetConnectionRoutes](connection: QuicConnection): void {
    this.#connections.delete(connection);
    for (const cid of connection.routeCids.splice(0)) {
      if (this.cidTable.get(cid) === connection) this.cidTable.delete(cid);
    }
  }
  [quicEndpointInternals.accept](connection: QuicConnection): void {
    if (inNativeCallback()) {
      this.#dispatch(new QuicConnectionEvent('connection', { connection }));
      this.#acceptQueue.push(connection);
      return;
    }
    this.#acceptQueue.push(connection);
    this.#dispatch(new QuicConnectionEvent('connection', { connection }));
  }
  [quicEndpointInternals.removeListener](listener: QuicListener): void {
    this.#listeners = this.#listeners.filter((candidate) => candidate !== listener);
  }
  [quicEndpointInternals.registerStatelessResetToken](
    token: string,
    connection: QuicConnection,
  ): void {
    this.#statelessResetTokens.set(token, connection);
  }
  [quicEndpointInternals.unregisterStatelessResetToken](
    token: string,
    connection: QuicConnection,
  ): void {
    if (this.#statelessResetTokens.get(token) === connection)
      this.#statelessResetTokens.delete(token);
  }
  [quicEndpointInternals.storeAddressToken](key: string, token: Uint8Array): void {
    this.#addressTokens.set(key, token.slice());
  }
  [quicEndpointInternals.loadAddressToken](key: string): Uint8Array | null {
    return this.#addressTokens.get(key)?.slice() ?? null;
  }
  #activeServerConnectionCount(
    listener?: QuicListener,
    remoteAddress?: QuicAddress,
    excluding?: QuicConnection,
  ): number {
    let count = 0;
    for (const connection of this.#connections) {
      if (connection === excluding) continue;
      if (connection[quicConnectionInternals.matchesServerConnection](listener, remoteAddress))
        count++;
    }
    return count;
  }
  #sourceAddressMatches(filter: Set<string>, address: QuicAddress): boolean {
    return (
      filter.has(address.ip) ||
      filter.has(addressKey(address)) ||
      filter.has(`${address.family}:${address.ip}`) ||
      filter.has(`${address.ip}:${address.port}`)
    );
  }
  #sourceAddressFilterNeedsAddress(listener: QuicListener): boolean {
    const filter = listener.options.transport.sourceAddress;
    return filter.deny.size > 0 || filter.allow !== null;
  }
  #allowsSource(listener: QuicListener, remoteAddress: QuicAddress): boolean {
    const filter = listener.options.transport.sourceAddress;
    if (filter.deny.size > 0 && this.#sourceAddressMatches(filter.deny, remoteAddress))
      return false;
    if (filter.allow !== null && !this.#sourceAddressMatches(filter.allow, remoteAddress))
      return false;
    return true;
  }
  #blockPacket(kind: 'source' | 'busy' | 'connection-limit'): void {
    if (kind === 'source') {
      this.#stats.packetsBlocked++;
      this.#stats.sourceBlockedPackets++;
    } else if (kind === 'busy') this.#stats.serverBusyCount++;
    else this.#stats.connectionLimitPackets++;
  }
  #canCreateServerConnection(
    listener: QuicListener,
    remoteAddress: QuicAddress,
    replacing?: QuicConnection,
  ): boolean {
    const transport = listener.options.transport;
    if (this.#options.transport.busy || transport.busy) {
      this.#blockPacket('busy');
      return false;
    }
    if (
      transport.maxConnections > 0 &&
      this.#activeServerConnectionCount(undefined, undefined, replacing) >= transport.maxConnections
    ) {
      this.#blockPacket('connection-limit');
      return false;
    }
    if (
      transport.maxConnectionsPerRemoteAddress > 0 &&
      this.#activeServerConnectionCount(undefined, remoteAddress, replacing) >=
        transport.maxConnectionsPerRemoteAddress
    ) {
      this.#blockPacket('connection-limit');
      return false;
    }
    return true;
  }
  #connectingServerConnection(
    listener: QuicListener,
    remoteAddress: QuicAddress,
  ): QuicConnection | null {
    let match: QuicConnection | null = null;
    for (const connection of this.#connections) {
      if (
        connection.state !== 'connecting' ||
        !connection[quicConnectionInternals.matchesServerConnection](listener, remoteAddress) ||
        connection.remoteAddress.port !== remoteAddress.port
      )
        continue;
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
  [quicEndpointInternals.handleDatagram](
    listener: QuicListener | null,
    transportOrFd: QuicDatagramTransport | number,
    localAddress: QuicAddress,
    packet: Uint8Array,
    remoteAddress: QuicAddress | undefined,
    packetEcn?: number,
    pathMetadata?: QuicDatagramPathMetadata,
  ): void {
    const transport = this.#coerceTransport(transportOrFd, localAddress);
    let decodedRemoteAddress = remoteAddress;
    const decodeRemoteAddress = (): QuicAddress | null => {
      if (decodedRemoteAddress !== undefined) return decodedRemoteAddress;
      if (pathMetadata === undefined) return null;
      const decoded = decodeAddr(
        pathMetadata.remoteSockaddr.slice(0, pathMetadata.remoteSockaddrLen),
      );
      if (decoded.family !== 'ipv4' && decoded.family !== 'ipv6') return null;
      decodedRemoteAddress = decoded;
      return decodedRemoteAddress;
    };
    const needsSourceAddress = listener !== null && this.#sourceAddressFilterNeedsAddress(listener);
    if (listener !== null && needsSourceAddress) {
      const sourceAddress = decodeRemoteAddress();
      if (sourceAddress === null) return;
      if (!this.#allowsSource(listener, sourceAddress)) {
        this.#blockPacket('source');
        return;
      }
    }
    if (packet.byteLength === 0) return;
    if (
      listener !== null &&
      packet.byteLength < 1200 &&
      (packet[0] & 192) === 192 &&
      (packet[0] & 48) === 0
    ) {
      return;
    }
    const decoded = this.#vcidScratch;
    Pointer.of(decoded, this.#vcidScratchPtr.buffer, 0);
    const rc = ngtcp2Sym!.ngtcp2_pkt_decode_version_cid(
      this.#vcidScratchPtr,
      packet,
      packet.byteLength,
      NGTCP2_MAX_CIDLEN,
    ) as number;
    if (rc !== 0 && rc !== NGTCP2_ERR_VERSION_NEGOTIATION) {
      this.#handleStatelessReset(packet);
      return;
    }
    const dcidLen = Number(this.#vcidView.getBigUint64(VERSION_CID_DCIDLEN, true));
    const dcid = this.#dcidScratch.subarray(0, dcidLen);
    if (dcidLen > 0) Pointer.copyFromInto(dcid, this.#vcidDcidPtrView, dcidLen);
    const initialKey = cidKey(dcid);
    if (this.#rejectedInitialCids.has(initialKey)) return;
    const existing = this.cidTable.get(initialKey);
    if (existing) {
      if (
        decodedRemoteAddress === undefined &&
        !needsSourceAddress &&
        existing[quicConnectionInternals.canReceiveWithoutDecodedAddress]()
      ) {
        existing[quicConnectionInternals.receivePacket](
          packet,
          existing.remoteAddress,
          localAddress,
          transport,
          packetEcn,
          pathMetadata,
        );
        return;
      }
      const routedRemoteAddress = decodeRemoteAddress();
      if (routedRemoteAddress === null) return;
      const routedVersion = readU32(decoded, VERSION_CID_VERSION);
      if (
        listener !== null &&
        routedVersion !== 0 &&
        (packet[0] & 64) !== 0 &&
        existing.state === 'connecting' &&
        existing[quicConnectionInternals.roleForStats]() === 'server' &&
        existing[quicConnectionInternals.matchesServerConnection](listener, routedRemoteAddress) &&
        existing[quicConnectionInternals.wireVersionForRouting]() !== routedVersion &&
        ngtcp2Sym!.ngtcp2_is_supported_version(routedVersion) !== 0
      ) {
        if (!this.#canCreateServerConnection(listener, routedRemoteAddress, existing)) {
          this.#writeImmediateConnectionCloseFromInitial(transport, routedRemoteAddress, packet);
          this.#recordProcessedPacket();
          return;
        }
        this.#forgetSupersededValidationStats(existing);
        existing[quicConnectionInternals.closeForCompatibleVersionUpgrade]();
        this.#acceptInitial(
          listener,
          transport,
          localAddress,
          routedRemoteAddress,
          packet,
          decoded,
          packetEcn,
          pathMetadata,
        );
        return;
      }
      existing[quicConnectionInternals.receivePacket](
        packet,
        routedRemoteAddress,
        localAddress,
        transport,
        packetEcn,
        pathMetadata,
      );
      return;
    }
    const routedRemoteAddress = decodeRemoteAddress();
    if (routedRemoteAddress === null) return;
    if (listener !== null) {
      const parsedInitial = parseInitialTokenHeader(packet);
      if (
        parsedInitial !== null &&
        parsedInitial.token.byteLength > 0 &&
        !isRetryToken(parsedInitial.token)
      ) {
        const parsedHd = packetHeaderFromParsedInitial(parsedInitial);
        const addressInfo = this.#addressValidation.peek(routedRemoteAddress);
        const remoteAddressValidated = addressInfo?.validated === true;
        const retry = this.#validateRetryToken(listener, routedRemoteAddress, parsedHd);
        const addressTokenAccepted = verifyRegularToken(
          listener.retryTokenSecret,
          routedRemoteAddress,
          parsedInitial.token,
          this.#runtime,
          listener.options.transport.addressTokenTimeout,
        );
        if (
          !remoteAddressValidated &&
          retry === null &&
          !addressTokenAccepted &&
          listener.options.retry.enabled
        ) {
          if (!this.#canCreateServerConnection(listener, routedRemoteAddress)) {
            this.#writeImmediateConnectionCloseFromInitial(transport, routedRemoteAddress, packet);
            this.#recordProcessedPacket();
            return;
          }
          if (parsedInitial.token.byteLength > 0) this.#stats.addressTokenRejected++;
          this.#writeRetryFromParts(
            listener,
            transport,
            routedRemoteAddress,
            parsedInitial.version,
            parsedInitial.scid,
            parsedInitial.dcid,
            packet.byteLength,
          );
          this.#recordProcessedPacket();
          return;
        }
      }
    }
    if ((packet[0] & 128) === 0 && this.#handleStatelessReset(packet)) return;
    if (listener === null) {
      this.#handleStatelessReset(packet);
      return;
    }
    const version = readU32(decoded, VERSION_CID_VERSION);
    if (version === 0) {
      if ((packet[0] & 128) === 0) {
        this.#writeStatelessReset(
          listener,
          transport,
          routedRemoteAddress,
          dcid,
          packet.byteLength,
        );
      }
      return;
    }
    if (version !== 0 && ngtcp2Sym!.ngtcp2_is_supported_version(version) === 0) {
      this.#writeVersionNegotiation(listener, transport, routedRemoteAddress, decoded);
      this.#recordProcessedPacket();
      return;
    }
    if ((packet[0] & 64) === 0) return;
    const connecting = this.#connectingServerConnection(listener, routedRemoteAddress);
    if (
      connecting !== null &&
      connecting[quicConnectionInternals.wireVersionForRouting]() === version
    ) {
      connecting[quicConnectionInternals.receivePacket](
        packet,
        routedRemoteAddress,
        localAddress,
        transport,
        packetEcn,
        pathMetadata,
      );
      return;
    }
    const replacement =
      connecting !== null && connecting[quicConnectionInternals.wireVersionForRouting]() !== version
        ? connecting
        : null;
    if (!this.#canCreateServerConnection(listener, routedRemoteAddress, replacement ?? undefined)) {
      this.#writeImmediateConnectionCloseFromInitial(transport, routedRemoteAddress, packet);
      this.#recordProcessedPacket();
      return;
    }
    if (replacement !== null) this.#forgetSupersededValidationStats(replacement);
    replacement?.[quicConnectionInternals.closeForCompatibleVersionUpgrade]();
    this.#acceptInitial(
      listener,
      transport,
      localAddress,
      routedRemoteAddress,
      packet,
      decoded,
      packetEcn,
      pathMetadata,
    );
  }
  #forgetSupersededValidationStats(connection: QuicConnection): void {
    const tokenType = connection[quicConnectionInternals.validationTokenTypeForRouting]();
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
    connection[quicConnectionInternals.onStatelessReset]();
    return true;
  }
  #writeStatelessReset(
    listener: QuicListener,
    transport: QuicDatagramTransport,
    remoteAddress: QuicAddress,
    dcid: Uint8Array,
    sourcePacketLength: number,
  ): void {
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
      this.#dispatch(
        new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }),
      );
    } else {
      this[quicEndpointInternals.recordDatagramSent](n);
      this.#stats.statelessResetSent++;
    }
  }
  #writeImmediateConnectionCloseFromInitial(
    transport: QuicDatagramTransport,
    remoteAddress: QuicAddress,
    packet: Uint8Array,
  ): void {
    const parsed = parseInitialTokenHeader(packet);
    if (parsed === null) return;
    if (!this.#immediateCloseBucket.consume()) {
      this.#stats.immediateCloseRateLimited++;
      return;
    }
    const out = new Uint8Array(NGTCP2_MAX_UDP_PAYLOAD_SIZE);
    const reason = new Uint8Array(0);
    const n = Number(
      cryptoSym!.ngtcp2_crypto_write_connection_close(
        out,
        out.byteLength,
        parsed.version,
        Pointer.of(parsed.scid),
        Pointer.of(parsed.dcid),
        BigInt(NGTCP2_CONNECTION_REFUSED),
        reason,
        reason.byteLength,
      ),
    );
    if (n <= 0) return;
    const sent = transport.sendNow(out.slice(0, n), remoteAddress);
    if (sent < 0 && sent !== EAGAIN) {
      this.#dispatch(
        new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }),
      );
    } else {
      this[quicEndpointInternals.recordDatagramSent](n);
      this.#stats.immediateCloseSent++;
    }
  }
  #writeVersionNegotiation(
    listener: QuicListener,
    transport: QuicDatagramTransport,
    remoteAddress: QuicAddress,
    decoded: ArrayBuffer,
  ): void {
    if (!this.#versionNegotiationBucket.consume()) {
      this.#stats.versionNegotiationRateLimited++;
      return;
    }
    const clientDcid = copyFromPtr(
      ptrField(decoded, VERSION_CID_DCID),
      Number(readU64(decoded, VERSION_CID_DCIDLEN)),
    );
    const clientScid = copyFromPtr(
      ptrField(decoded, VERSION_CID_SCID),
      Number(readU64(decoded, VERSION_CID_SCIDLEN)),
    );
    const supported = listener.options.versions
      .map(versionToWire)
      .filter((version) => ngtcp2Sym!.ngtcp2_is_supported_version(version) !== 0);
    if (supported.length === 0) return;
    const advertised = [VERSION_NEGOTIATION_GREASE, ...supported];
    const versions = new ArrayBuffer(advertised.length * 4);
    for (let i = 0; i < advertised.length; i++) writeU32(versions, i * 4, advertised[i]);
    const out = new Uint8Array(NGTCP2_MAX_UDP_PAYLOAD_SIZE);
    const n = Number(
      ngtcp2Sym!.ngtcp2_pkt_write_version_negotiation(
        out,
        out.byteLength,
        randomBytes(1)[0],
        clientScid,
        clientScid.byteLength,
        clientDcid,
        clientDcid.byteLength,
        versions,
        advertised.length,
      ),
    );
    if (n <= 0) return;
    const sent = transport.sendNow(out.slice(0, n), remoteAddress);
    if (sent < 0 && sent !== EAGAIN) {
      this.#dispatch(
        new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }),
      );
    } else {
      this[quicEndpointInternals.recordDatagramSent](n);
      this.#stats.versionNegotiationSent++;
    }
  }
  #writeRetry(
    listener: QuicListener,
    transport: QuicDatagramTransport,
    remoteAddress: QuicAddress,
    hd: ArrayBuffer,
    maxPacketLength: number,
  ): void {
    const clientScid = cidFromPacketHeader(hd, PKT_HD_SCID);
    const originalDcid = cidFromPacketHeader(hd, PKT_HD_DCID);
    this.#writeRetryFromParts(
      listener,
      transport,
      remoteAddress,
      readU32(hd, PKT_HD_VERSION),
      clientScid,
      originalDcid,
      maxPacketLength,
    );
  }
  #writeRetryFromParts(
    listener: QuicListener,
    transport: QuicDatagramTransport,
    remoteAddress: QuicAddress,
    version: number,
    clientScid: ArrayBuffer,
    originalDcid: ArrayBuffer,
    maxPacketLength: number,
  ): void {
    if (!this.#retryBucket.consume()) {
      this.#stats.retryRateLimited++;
      return;
    }
    const retryScid = randomCid(listener.options.connection.cidLength);
    const remote = encodeAddr(remoteAddress);
    const token = new Uint8Array(NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2);
    const tokenLen = Number(
      cryptoSym!.ngtcp2_crypto_generate_retry_token2(
        token,
        listener.retryTokenSecret,
        listener.retryTokenSecret.byteLength,
        version,
        Pointer.of(remote.buf),
        remote.len,
        Pointer.of(retryScid),
        Pointer.of(originalDcid),
        now(this.#runtime),
      ),
    );
    if (tokenLen <= 0) return;
    const out = new Uint8Array(
      Math.min(
        NGTCP2_MAX_UDP_PAYLOAD_SIZE,
        Math.max(NGTCP2_MAX_UDP_PAYLOAD_SIZE, maxPacketLength * 3),
      ),
    );
    const n = Number(
      cryptoSym!.ngtcp2_crypto_write_retry(
        out,
        out.byteLength,
        version,
        Pointer.of(clientScid),
        Pointer.of(retryScid),
        Pointer.of(originalDcid),
        token.subarray(0, tokenLen),
        tokenLen,
      ),
    );
    if (n <= 0) return;
    const sent = transport.sendNow(out.slice(0, n), remoteAddress);
    if (sent < 0 && sent !== EAGAIN) {
      this.#dispatch(
        new QuicErrorEvent('error', { error: new Error(`QUIC UDP sendto failed: ${sent}`) }),
      );
    } else {
      this[quicEndpointInternals.recordDatagramSent](n);
      this.#stats.retrySent++;
    }
  }
  #validateRetryToken(
    listener: QuicListener,
    remoteAddress: QuicAddress,
    hd: ArrayBuffer,
  ): {
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
    const rc = cryptoSym!.ngtcp2_crypto_verify_retry_token2(
      Pointer.of(originalDcid),
      token,
      token.byteLength,
      listener.retryTokenSecret,
      listener.retryTokenSecret.byteLength,
      readU32(hd, PKT_HD_VERSION),
      Pointer.of(remote.buf),
      remote.len,
      Pointer.of(retryScid),
      listener.options.transport.retryTokenTimeout,
      now(this.#runtime),
    ) as number;
    if (rc !== 0) {
      this.#stats.retryTokenRejected++;
      return null;
    }
    return {
      originalDcid,
      retryScid,
      token,
      tokenType: NGTCP2_TOKEN_TYPE_RETRY,
    };
  }
  #validateAddressToken(
    listener: QuicListener,
    remoteAddress: QuicAddress,
    hd: ArrayBuffer,
  ): {
    token: Uint8Array;
    tokenType: number;
  } | null {
    const tokenLen = Number(readU64(hd, PKT_HD_TOKENLEN));
    if (tokenLen === 0) return null;
    const token = copyFromPtr(ptrField(hd, PKT_HD_TOKEN), tokenLen);
    if (
      !verifyRegularToken(
        listener.retryTokenSecret,
        remoteAddress,
        token,
        this.#runtime,
        listener.options.transport.addressTokenTimeout,
      )
    ) {
      this.#stats.addressTokenRejected++;
      return null;
    }
    return {
      token,
      tokenType: NGTCP2_TOKEN_TYPE_NEW_TOKEN,
    };
  }
  #acceptInitial(
    listener: QuicListener,
    transport: QuicDatagramTransport,
    localAddress: QuicAddress,
    remoteAddress: QuicAddress,
    packet: Uint8Array,
    decoded: ArrayBuffer,
    packetEcn?: number,
    pathMetadata?: QuicDatagramPathMetadata,
  ): void {
    const parsedInitial = parseInitialTokenHeader(packet);
    if (
      parsedInitial !== null &&
      parsedInitial.token.byteLength > 0 &&
      !isRetryToken(parsedInitial.token)
    ) {
      const parsedHd = packetHeaderFromParsedInitial(parsedInitial);
      const addressInfo = this.#addressValidation.peek(remoteAddress);
      const remoteAddressValidated = addressInfo?.validated === true;
      const retry =
        parsedInitial.token.byteLength <= 64
          ? null
          : this.#validateRetryToken(listener, remoteAddress, parsedHd);
      const addressTokenAccepted = verifyRegularToken(
        listener.retryTokenSecret,
        remoteAddress,
        parsedInitial.token,
        this.#runtime,
        listener.options.transport.addressTokenTimeout,
      );
      if (
        !remoteAddressValidated &&
        retry === null &&
        !addressTokenAccepted &&
        listener.options.retry.enabled
      ) {
        this.#stats.addressTokenRejected++;
        this.#writeRetryFromParts(
          listener,
          transport,
          remoteAddress,
          parsedInitial.version,
          parsedInitial.scid,
          parsedInitial.dcid,
          packet.byteLength,
        );
        this.#recordProcessedPacket();
        return;
      }
    }
    const hd = new ArrayBuffer(NGTCP2_PKT_HD_SIZE);
    const decodedLen = Number(
      ngtcp2Sym!.ngtcp2_pkt_decode_hd_long(Pointer.of(hd), packet, packet.byteLength),
    );
    if (decodedLen > 0 && Number(readU64(hd, PKT_HD_TOKENLEN)) > 0) {
      const addressInfo = this.#addressValidation.peek(remoteAddress);
      const remoteAddressValidated = addressInfo?.validated === true;
      const retry = this.#validateRetryToken(listener, remoteAddress, hd);
      if (
        retry === null &&
        isRetryToken(copyFromPtr(ptrField(hd, PKT_HD_TOKEN), Number(readU64(hd, PKT_HD_TOKENLEN))))
      ) {
        this.#writeImmediateConnectionCloseFromInitial(transport, remoteAddress, packet);
        this.#recordProcessedPacket();
        return;
      }
      const addressToken =
        retry === null ? this.#validateAddressToken(listener, remoteAddress, hd) : null;
      if (
        !remoteAddressValidated &&
        retry === null &&
        addressToken === null &&
        listener.options.retry.enabled
      ) {
        this.#writeRetry(listener, transport, remoteAddress, hd, packet.byteLength);
        this.#recordProcessedPacket();
        return;
      }
    }
    const acceptRc = ngtcp2Sym!.ngtcp2_accept(Pointer.of(hd), packet, packet.byteLength) as number;
    if (acceptRc !== 0) {
      if (
        decodedLen > 0 &&
        listener.options.retry.enabled &&
        Number(readU64(hd, PKT_HD_TOKENLEN)) > 0
      ) {
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
    if (
      retry === null &&
      tokenLen > 0 &&
      isRetryToken(copyFromPtr(ptrField(hd, PKT_HD_TOKEN), tokenLen))
    ) {
      this.#writeImmediateConnectionCloseFromInitial(transport, remoteAddress, packet);
      this.#recordProcessedPacket();
      return;
    }
    const addressToken =
      retry === null ? this.#validateAddressToken(listener, remoteAddress, hd) : null;
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
    const tls = newServerSession(
      listener[quicListenerInternals.ctx],
      listener.alpnProtocols,
      earlyDataMax,
    );
    const connection = new (quicConnectionClass())(
      'server',
      this,
      listener,
      localAddress,
      remoteAddress,
      listener.alpnProtocols,
      transport,
      null,
      tls,
      originalDcid,
      listener.options,
    );
    connection[quicConnectionInternals.initServer](
      clientScid,
      serverScid,
      version,
      retry?.retryScid ?? null,
      retry?.token ?? addressToken?.token ?? null,
      retry?.tokenType ?? addressToken?.tokenType ?? NGTCP2_TOKEN_TYPE_UNKNOWN,
    );
    this[quicEndpointInternals.track](connection);
    const rc = connection[quicConnectionInternals.receivePacket](
      packet,
      remoteAddress,
      localAddress,
      transport,
      packetEcn,
      pathMetadata,
    );
    if (rc === NGTCP2_ERR_RETRY) {
      this.#writeRetry(listener, transport, remoteAddress, hd, packet.byteLength);
    }
    if (connection[quicConnectionInternals.isClosedForInternalUse]() && rc !== NGTCP2_ERR_RETRY) {
      this.#rememberRejectedInitialCid(cidKey(cidBytes(originalDcid)));
    }
  }
}

export type QuicListenerConstructor = new (
  endpoint: QuicEndpoint,
  address: QuicAddress,
  alpnProtocols: string[],
  transports: QuicDatagramTransport[],
  ctx: QuicTlsContext,
  options: ResolvedQuicOptions,
  sniContexts?: Map<string, QuicTlsContext>,
) => QuicListener;
export type QuicConnectionConstructor = new (
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
  serverName?: string | null,
) => QuicConnection;
let registeredQuicListenerClass: QuicListenerConstructor | null = null;
let registeredQuicConnectionClass: QuicConnectionConstructor | null = null;
export function registerQuicListenerClass(ctor: QuicListenerConstructor): void {
  registeredQuicListenerClass = ctor;
}
export function registerQuicConnectionClass(ctor: QuicConnectionConstructor): void {
  registeredQuicConnectionClass = ctor;
}
function quicListenerClass(): QuicListenerConstructor {
  if (registeredQuicListenerClass === null)
    throw new Error('QUIC listener class has not been registered');
  return registeredQuicListenerClass;
}
function quicConnectionClass(): QuicConnectionConstructor {
  if (registeredQuicConnectionClass === null)
    throw new Error('QUIC connection class has not been registered');
  return registeredQuicConnectionClass;
}
