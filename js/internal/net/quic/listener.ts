/**
* internal:net/quic/listener — QUIC listener class and internal symbols.
*
* @internal
*/

import { Event, EventTarget } from '../../../globals/eventtarget.ts';
import { BytesReader, BytesWriter } from '../../stream.ts';
import * as loop from '../../runtime/loop.ts';
import { EAGAIN, decodeAddr } from '../../../net/socket.ts';
import { randBytes } from '../../openssl.ts';
import { CB_ACKED_STREAM_DATA_OFFSET, CB_ACK_DATAGRAM, CB_CLIENT_INITIAL, CB_DELETE_CRYPTO_AEAD_CTX, CB_DELETE_CRYPTO_CIPHER_CTX, CB_DECRYPT, CB_ENCRYPT, CB_EXTEND_MAX_LOCAL_STREAMS_BIDI, CB_EXTEND_MAX_LOCAL_STREAMS_UNI, CB_EXTEND_MAX_STREAM_DATA, CB_GET_NEW_CONNECTION_ID, CB_GET_NEW_CONNECTION_ID2, CB_GET_PATH_CHALLENGE_DATA, CB_GET_PATH_CHALLENGE_DATA2, CB_HANDSHAKE_COMPLETED, CB_HANDSHAKE_CONFIRMED, CB_HP_MASK, CB_BEGIN_PATH_VALIDATION, CB_DCID_STATUS, CB_DCID_STATUS2, CB_EARLY_DATA_REJECTED, CB_LOST_DATAGRAM, CB_PATH_VALIDATION, CB_RAND, CB_REMOVE_CONNECTION_ID, CB_RECV_DATAGRAM, CB_RECV_CLIENT_INITIAL, CB_RECV_CRYPTO_DATA, CB_RECV_NEW_TOKEN, CB_RECV_RETRY, CB_RECV_RX_KEY, CB_RECV_STATELESS_RESET, CB_RECV_STATELESS_RESET2, CB_RECV_STREAM_DATA, CB_RECV_TX_KEY, CB_RECV_VERSION_NEGOTIATION, CB_STREAM_CLOSE, CB_STREAM_OPEN, CB_STREAM_RESET, CB_STREAM_STOP_SENDING, CB_SELECT_PREFERRED_ADDR, CB_UPDATE_KEY, CB_VERSION_NEGOTIATION, CONN_INFO_BYTES_IN_FLIGHT, CONN_INFO_BYTES_LOST, CONN_INFO_BYTES_RECV, CONN_INFO_BYTES_SENT, CONN_INFO_CWND, CONN_INFO_LATEST_RTT, CONN_INFO_MIN_RTT, CONN_INFO_PING_RECV, CONN_INFO_PKT_DISCARDED, CONN_INFO_PKT_LOST, CONN_INFO_PKT_RECV, CONN_INFO_PKT_SENT, CONN_INFO_RTTVAR, CONN_INFO_SMOOTHED_RTT, CONN_INFO_SSTHRESH, ADDR_ADDR, ADDR_ADDRLEN, CCERR_TYPE, CCERR_ERROR_CODE, CCERR_REASON, CCERR_REASONLEN, CID_DATA, CID_DATALEN, NGTCP2_CALLBACKS_SIZE, NGTCP2_CALLBACKS_VERSION, NGTCP2_CCERR_SIZE, NGTCP2_CONN_INFO_SIZE, NGTCP2_CONN_INFO_VERSION, NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE, NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE, NGTCP2_CID_SIZE, NGTCP2_CRYPTO_ERROR, NGTCP2_ERR_CLOSING, NGTCP2_ERR_CALLBACK_FAILURE, NGTCP2_ERR_CRYPTO, NGTCP2_ERR_DRAINING, NGTCP2_ERR_DROP_CONN, NGTCP2_ERR_IDLE_CLOSE, NGTCP2_ERR_NOBUF, NGTCP2_ERR_PKT_NUM_EXHAUSTED, NGTCP2_ERR_RECV_VERSION_NEGOTIATION, NGTCP2_ERR_RETRY, NGTCP2_ERR_STREAM_ID_BLOCKED, NGTCP2_ERR_STREAM_DATA_BLOCKED, NGTCP2_ERR_STREAM_SHUT_WR, NGTCP2_ERR_STREAM_NOT_FOUND, NGTCP2_ERR_VERSION_NEGOTIATION, NGTCP2_ERR_WRITE_MORE, NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE, NGTCP2_MAX_CIDLEN, NGTCP2_MAX_UDP_PAYLOAD_SIZE, NGTCP2_ERR_INVALID_STATE, NGTCP2_WRITE_STREAM_FLAG_MORE, NGTCP2_PATH_SIZE, PATH_LOCAL, PATH_REMOTE, PATH_USER_DATA, SETTINGS_AVAILABLE_VERSIONS, SETTINGS_AVAILABLE_VERSIONSLEN, SETTINGS_ACK_THRESH, SETTINGS_CC_ALGO, SETTINGS_HANDSHAKE_TIMEOUT, SETTINGS_INITIAL_TS, SETTINGS_INITIAL_RTT, SETTINGS_MAX_TX_UDP_PAYLOAD_SIZE, SETTINGS_MAX_STREAM_WINDOW, SETTINGS_MAX_WINDOW, SETTINGS_NO_TX_UDP_PAYLOAD_SIZE_SHAPING, SETTINGS_NO_PMTUD, SETTINGS_ORIGINAL_VERSION, SETTINGS_PREFERRED_VERSIONS, SETTINGS_PREFERRED_VERSIONSLEN, SETTINGS_QLOG_WRITE, SETTINGS_TOKEN, SETTINGS_TOKENLEN, SETTINGS_TOKEN_TYPE } from './ngtcp2/bindings.ts';
import { NGTCP2_PKT_HD_SIZE, NGTCP2_PKT_INFO_VERSION, NGTCP2_PKT_INFO_SIZE, NGTCP2_ECN_NOT_ECT, NGTCP2_ECN_ECT_0, NGTCP2_ECN_MASK, PKT_INFO_ECN, NGTCP2_PROTO_VER_V2, NGTCP2_PROTO_VER_V1, NGTCP2_SETTINGS_SIZE, NGTCP2_SETTINGS_VERSION, NGTCP2_TRANSPORT_PARAMS_SIZE, NGTCP2_TRANSPORT_PARAMS_VERSION, NGTCP2_VERSION_CID_SIZE, NGTCP2_VEC_SIZE, NGTCP2_DATAGRAM_FLAG_0RTT, NGTCP2_WRITE_DATAGRAM_FLAG_NONE, NGTCP2_WRITE_STREAM_FLAG_FIN, TP_ACTIVE_CONNECTION_ID_LIMIT, TP_ACK_DELAY_EXPONENT, TP_DISABLE_ACTIVE_MIGRATION, TP_INITIAL_MAX_DATA, TP_INITIAL_MAX_STREAMS_BIDI, TP_INITIAL_MAX_STREAMS_UNI, TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL, TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE, TP_INITIAL_MAX_STREAM_DATA_UNI, TP_INITIAL_SCID, TP_INITIAL_SCID_PRESENT, TP_MAX_IDLE_TIMEOUT, TP_MAX_ACK_DELAY, TP_MAX_DATAGRAM_FRAME_SIZE, TP_MAX_UDP_PAYLOAD_SIZE, TP_ORIGINAL_DCID, TP_ORIGINAL_DCID_PRESENT, TP_RETRY_SCID, TP_RETRY_SCID_PRESENT, TP_PREFERRED_ADDR, TP_PREFERRED_ADDR_CID, TP_PREFERRED_ADDR_IPV4, TP_PREFERRED_ADDR_IPV4_PRESENT, TP_PREFERRED_ADDR_IPV6, TP_PREFERRED_ADDR_IPV6_PRESENT, TP_PREFERRED_ADDR_PRESENT, TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN, TP_STATELESS_RESET_TOKEN, TP_STATELESS_RESET_TOKEN_PRESENT, VEC_BASE, VEC_LEN, PKT_HD_DCID, PKT_HD_SCID, PKT_HD_TOKEN, PKT_HD_TOKENLEN, PKT_HD_VERSION, VERSION_CID_DCID, VERSION_CID_DCIDLEN, VERSION_CID_SCID, VERSION_CID_SCIDLEN, VERSION_CID_VERSION, NGTCP2_TOKEN_TYPE_RETRY, NGTCP2_TOKEN_TYPE_NEW_TOKEN, NGTCP2_TOKEN_TYPE_UNKNOWN, NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN, NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR, NGTCP2_PATH_VALIDATION_RESULT_ABORTED, NGTCP2_PATH_VALIDATION_RESULT_FAILURE, NGTCP2_PATH_VALIDATION_RESULT_SUCCESS, FfiCallback, Pointer, ngtcp2Available, ngtcp2ConnResetStreamAt, ngtcp2ResetStreamAtAvailable, ngtcp2PktWriteStatelessReset, ptr as ngtcp2Ptr, readCStr, requireNgtcp2, sym as ngtcp2Sym } from './ngtcp2/bindings.ts';
import { clearConnectionRef, configureSessionForConnection, cryptoAvailable, cryptoBackend as _cryptoBackend, freeContext, freeNativeHandle, freeSession, getAlpnSelected, getHandshakeInfo, getPeerCertificate, exportKeyingMaterial as exportTlsKeyingMaterial, exportSession, importSession, initCrypto, newClientContext, newClientSession, newNativeHandle, newServerContext, newServerSession, ptr as cryptoPtr, requireCrypto, sendSessionTicket, setConnectionRef, setSNIContexts, setSessionTicketCallback, sym as cryptoSym, type QuicCaOptions, type QuicCryptoBackend, type QuicTlsContext, type QuicTlsSession } from './ngtcp2/crypto.ts';
import * as core from './core.ts';
const { _PTR_SIZE, _QUIC_PTR_PATH, _QUIC_PTR_PKT_INFO, _QUIC_PTR_DATA_LEN, _QUIC_PTR_VEC, normalizeCloseOptions, quicIncomingStreamHook, quicBytesWriterInternals, quicEndpointInternals, quicListenerInternals, quicConnectionInternals, quicStreamInternals, getConnPointerSlot, STREAM_DATA_FLAG_FIN, TLS_ALERT_NO_APPLICATION_PROTOCOL, NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2, NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2, NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN, NGTCP2_STATELESS_RESET_TOKENLEN, NGTCP2_MIN_STATELESS_RESET_RANDLEN, NGTCP2_MIN_STATELESS_RESET_PACKETLEN, STATELESS_RESET_RANDLEN, DEFAULT_ADDRESS_LRU_SIZE, DEFAULT_RETRY_RATE, DEFAULT_RETRY_BURST, DEFAULT_VERSION_NEGOTIATION_RATE, DEFAULT_VERSION_NEGOTIATION_BURST, DEFAULT_STATELESS_RESET_RATE, DEFAULT_STATELESS_RESET_BURST, DEFAULT_IMMEDIATE_CLOSE_RATE, DEFAULT_IMMEDIATE_CLOSE_BURST, DEFAULT_SESSION_CREATION_RATE, DEFAULT_SESSION_CREATION_BURST, DEFAULT_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS_PER_REMOTE_ADDRESS, DEFAULT_MAX_PENDING_DATAGRAMS, DEFAULT_MAX_DATAGRAM_SEND_ATTEMPTS, DEFAULT_DRAINING_PERIOD_MULTIPLIER, DEFAULT_CONNECTION_MAX_PAYLOAD_SIZE, NGTCP2_QLOG_WRITE_FLAG_FIN, NGTCP2_ENCRYPTION_LEVEL_1RTT, NGTCP2_MILLISECONDS, NGTCP2_SECONDS, DEFAULT_STREAM_IDLE_TIMEOUT, ADDRESS_VALIDATION_TIMEOUT, NGTCP2_NO_EXPIRY, MIGRATION_KEEP_ALIVE_TIMEOUT, MAX_RECEIVE_WINDOW, INITIAL_MAX_STREAM_DATA, INITIAL_MAX_DATA, INITIAL_MAX_STREAMS_BIDI, INITIAL_MAX_STREAMS_UNI, ACTIVE_CONNECTION_ID_LIMIT, MAX_IDLE_TIMEOUT, HANDSHAKE_TIMEOUT, RETRY_TOKEN_TIMEOUT, REGULAR_TOKEN_TIMEOUT, MIN_TOKEN_TIMEOUT, MAX_RETRY_TOKEN_TIMEOUT, MAX_REGULAR_TOKEN_TIMEOUT, CONNECTION_DRAINING_TIMEOUT_MS, MAX_REJECTED_INITIAL_CIDS, MAX_WRITE_PACKETS_PER_DRAIN, MAX_READ_PACKETS_PER_TURN, MAX_BATCH_READ_PACKETS_PER_TURN, NGTCP2_CONNECTION_REFUSED, VERSION_NEGOTIATION_GREASE, SOCKADDR_UNION_SIZE, DEFAULT_ALPN_PROTOCOLS, QUIC_TLS_CIPHER_SUITES, _nativeConnections, allocateQuicConnectionId, allocateNativeUserDataId, _nativeCallbackDepth, _deferredNativeTasks, _deferredNativeFlushScheduled, inNativeCallback, scheduleDeferredNativeTasks, flushDeferredNativeTasks, deferAfterNativeCallback, publishQuicTopic, runtimeDelay, withNativeCallback, quicAvailable, quicResetStreamAtAvailable, cryptoBackend, transportEngine, quicVersion, realQuicRuntime, RealQuicDatagramTransport, normalizeSocketOptionInteger, normalizeSocketOptions, RealQuicDatagramTransportFactory, realQuicDatagramTransportFactory, requireQuic, AsyncQueue, ByteQueue, QuicBytesReader, QuicBytesWriter, normalizeAddress, addressKey, sameAddress, decodeHexDatagram, decodeBase64Datagram, normalizeDatagramSource, normalizeVersions, normalizeTlsCipherSuites, normalizeTlsGroups, normalizeRetry, normalizeDatagrams, quicVarintLength, maxDatagramPayload, normalizePreferredAddress, normalizeMigration, normalizeQlog, normalizeKeylog, normalizeRateLimit, normalizeLimit, normalizeTimeoutMs, normalizeDurationMs, normalizeInteger, normalizeClampedInteger, normalizeTransportVarint, normalizeConnection, clampBigint, nsToMs, normalizeAddressSet, normalizeTransport, resolveQuicOptions, freezeRateLimitSnapshot, freezeTransportSnapshot, freezeConnectionSnapshot, versionToWire, wireVersionToName, selectWireVersion, selectClientInitialWireVersion, longHeaderVersion, sessionStoreKey, now, QuicTokenBucket, QuicAddressValidationCache, writeU64, writeI64, writeU32, writeU8, readU64, readI64, readU32, ptrAddress, writePtr, writePtrIfPresent, writeAddress, _compatibleVersionLists, compatibleVersionList, ptrField, copyFromPtr, _HEX_BYTE, cidKey, makeCid, randomBytes, randomCid, generateStatelessResetToken, generateRegularToken, verifyRegularToken, isRetryToken, cidBytes, cidFromPacketHeader, readPacketVarint, parseInitialTokenHeader, packetHeaderFromParsedInitial, makePath, makePathFromSockaddrs, makeOutputPath, remoteAddressFromPath, localAddressFromPath, fdFromPath, fdFromNativePath, pathSnapshotFromNative, pathFromSnapshot, pathSnapshotsDiffer, pathValidationResultName, preferredAddressFromNative, cidFromTransportParams, transportParameterSnapshot, writeNativePathAddress, writeNativePathUserData, makePacketInfo, packetInfoEcn, qlogOutputPath, writeAllFd, appendKeylogLine, createServerTlsContext, _qlogWriteCallback, qlogWriteCallbackPointer, congestionControlValue, makeSettings, makeTransportParams, readUserDataId, connectionFromUserData, _callbackTable, _callbackRefs, ensureCallbackTable, getConnRefPointer, __inspectQuicCallbackTable, __inspectQuicRuntimeTuning, ngtcp2Error, QuicConnectionEvent, QuicStreamEvent, QuicStreamBlockedEvent, QuicStreamResetEvent, QuicDatagramEvent, QuicDatagramStatusEvent, QuicNewTokenEvent, QuicEarlyDataEvent, QuicStopSendingEvent, QuicPathValidationEvent, QuicErrorEvent, QuicVersionNegotiationError, CidRoutingTable, QuicEndpoint, registerQuicListenerClass, registerQuicConnectionClass } = core;
/**
* A bound server listener created by `QuicEndpoint.listen()`.
*
* Each listener owns the UDP socket(s) bound for one `listen()` call — the
* listen address plus any advertised preferred addresses — and the TLS server
* context (including per-SNI contexts). It runs the receive loop that feeds
* incoming packets into the endpoint's connection routing; accepted connections
* surface on the endpoint, not the listener. Construct one only through
* `endpoint.listen()`.
*
* `close()` releases the listener's sockets and TLS contexts and unregisters it
* from the endpoint. The listener also implements `Symbol.asyncDispose`.
* SNI contexts can be swapped at runtime with `setSNIContexts()`.
*
* ```ts no_run
* const listener = await endpoint.listen({
*   address: { family: 'ipv4', ip: '0.0.0.0', port: 4433 },
*   certificateFile: '/etc/tls/cert.pem',
*   privateKeyFile: '/etc/tls/key.pem',
* });
* console.log('listening on', listener.address.port);
* // ...later
* await listener.close();
* ```
*/
export class QuicListener {
  /** The endpoint that owns this listener. */
  readonly endpoint: QuicEndpoint;
  /** The bound local address, with any ephemeral port resolved. */
  readonly address: QuicAddress;
  /** ALPN protocols this listener accepts. */
  readonly alpnProtocols: string[];
  /** Resolved options this listener was created with. */
  readonly options: ResolvedQuicOptions;
  #closed = false;
  #transports: QuicDatagramTransport[];
  #retryTokenSecret: Uint8Array;
  #sniContexts: Map<string, QuicTlsContext>;
  [quicListenerInternals.ctx]: QuicTlsContext;
  /** Constructed internally by `QuicEndpoint.listen()`; not a public entry point. */
  constructor(endpoint: QuicEndpoint, address: QuicAddress, alpnProtocols: string[], transports: QuicDatagramTransport[], ctx: QuicTlsContext, options: ResolvedQuicOptions, sniContexts: Map<string, QuicTlsContext> = new Map()) {
    this.endpoint = endpoint;
    this.address = address;
    this.alpnProtocols = alpnProtocols;
    this.options = options;
    this.#transports = transports.slice();
    this.#sniContexts = new Map(sniContexts);
    this[quicListenerInternals.ctx] = ctx;
    this.#retryTokenSecret = options.retry.enabled && options.retry.tokenSecret !== undefined ? options.retry.tokenSecret.slice() : randomBytes(32);
  }
  /** Whether this listener has been closed. */
  get closed(): boolean {
    return this.#closed;
  }
  /** Secret used to mint and verify this listener's Retry tokens. */
  get retryTokenSecret(): Uint8Array {
    return this.#retryTokenSecret;
  }
  /** Secret used to derive this listener's stateless-reset tokens. */
  get resetTokenSecret(): Uint8Array {
    return this.#retryTokenSecret;
  }
  /**
  * Close the listener, releasing its sockets and TLS contexts.
  *
  * Unregisters the listener from its endpoint, frees the main and per-SNI TLS
  * contexts, and closes every socket bound for it. Idempotent; also invoked by
  * `Symbol.asyncDispose`. Existing connections accepted through this listener
  * are unaffected.
  */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.endpoint[quicEndpointInternals.removeListener](this);
    freeContext(this[quicListenerInternals.ctx]);
    for (const ctx of this.#sniContexts.values()) freeContext(ctx);
    this.#sniContexts.clear();
    for (const transport of this.#transports) {
      this.endpoint[quicEndpointInternals.unregisterTransport](transport);
      transport.close();
    }
    this.#transports = [];
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /**
  * Return the server names that currently have a dedicated SNI context.
  *
  * The values are placeholder objects — the certificate and key paths are not
  * echoed back — so this is a listing of configured names, not a way to read
  * secrets.
  */
  getSNIContexts(): Record<string, QuicSNIContextOptions> {
    const out: Record<string, QuicSNIContextOptions> = {};
    for (const [name] of this.#sniContexts) out[name] = {} as QuicSNIContextOptions;
    return out;
  }
  /**
  * Replace this listener's per-server-name TLS contexts.
  *
  * Builds fresh TLS contexts for the given entries and swaps them in
  * atomically, freeing the previous contexts. If building any entry fails, no
  * change is made and the error propagates. Throws if the listener is closed.
  *
  * ```ts no_run
  * listener.setSNIContexts({
  *   'api.example.com': {
  *     certificateFile: '/etc/tls/api-cert.pem',
  *     privateKeyFile: '/etc/tls/api-key.pem',
  *   },
  * });
  * ```
  */
  setSNIContexts(entries: Record<string, QuicSNIContextOptions>): void {
    if (this.#closed) throw new Error('QUIC listener is closed');
    const newContexts = new Map<string, QuicTlsContext>();
    try {
      for (const [servername, sni] of Object.entries(entries)) {
        newContexts.set(servername, createServerTlsContext(sni.certificateFile, sni.privateKeyFile, sni.alpnProtocols?.slice() ?? this.alpnProtocols, this.options, {
          clientAuth: sni.clientAuth,
          verifyClient: sni.verifyClient,
          rejectUnauthorized: sni.rejectUnauthorized,
          ca: sni.ca,
          groups: sni.tlsGroups ?? this.options.tlsGroups
        }));
      }
      setSNIContexts(this[quicListenerInternals.ctx], newContexts);
    } catch (error) {
      for (const ctx of newContexts.values()) freeContext(ctx);
      throw error;
    }
    for (const ctx of this.#sniContexts.values()) freeContext(ctx);
    this.#sniContexts = newContexts;
  }
  async [quicListenerInternals.start](): Promise<void> {
    await Promise.all(this.#transports.map((transport) => this.#runTransportLoop(transport)));
  }
  async #runTransportLoop(transport: QuicDatagramTransport): Promise<void> {
    while (!this.#closed && !transport.closed) {
      try {
        const batchCount = transport.recvBatchEach?.(MAX_BATCH_READ_PACKETS_PER_TURN, NGTCP2_MAX_UDP_PAYLOAD_SIZE, (data, addr, ecn, path) => {
          this.endpoint[quicEndpointInternals.handleDatagram](this, transport, transport.address, data, addr, ecn, path);
        });
        if (batchCount !== undefined) {
          if (batchCount >= MAX_BATCH_READ_PACKETS_PER_TURN) {
            await runtimeDelay(this.endpoint[quicEndpointInternals.runtime](), 0);
            continue;
          }
        } else {
          const batch = transport.recvBatch?.(MAX_BATCH_READ_PACKETS_PER_TURN, NGTCP2_MAX_UDP_PAYLOAD_SIZE);
          if (batch !== undefined) {
            for (const received of batch) {
              this.endpoint[quicEndpointInternals.handleDatagram](this, transport, transport.address, received.data, received.addr, received.ecn, received.path);
            }
            if (batch.length >= MAX_BATCH_READ_PACKETS_PER_TURN) {
              await runtimeDelay(this.endpoint[quicEndpointInternals.runtime](), 0);
              continue;
            }
          } else {
            let packets = 0;
            for (; packets < MAX_READ_PACKETS_PER_TURN; packets++) {
              const received = transport.recvNow(NGTCP2_MAX_UDP_PAYLOAD_SIZE);
              if (received === null) break;
              this.endpoint[quicEndpointInternals.handleDatagram](this, transport, transport.address, received.data, received.addr, received.ecn, received.path);
            }
            if (packets >= MAX_READ_PACKETS_PER_TURN) {
              await runtimeDelay(this.endpoint[quicEndpointInternals.runtime](), 0);
              continue;
            }
          }
        }
        await transport.waitReadable();
      } catch (error) {
        if (!this.#closed) {
          this.endpoint.dispatchEvent(new QuicErrorEvent('error', { error: error instanceof Error ? error : new Error(String(error)) }));
          await runtimeDelay(this.endpoint[quicEndpointInternals.runtime](), 5);
        }
      }
    }
  }
}

core.registerQuicListenerClass(QuicListener);
export { quicListenerInternals } from './core.ts';
export type { QuicListenOptions, QuicSNIContextOptions } from './core.ts';
