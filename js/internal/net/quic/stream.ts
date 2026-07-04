/**
* internal:net/quic/stream — QUIC stream class and internal symbols.
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
import type { QuicConnection } from './connection.ts';
export type IncomingStreamSegment = {
  offset: number;
  data: Uint8Array;
};
/**
* One QUIC stream multiplexed inside a `QuicConnection`.
*
* Obtained from `connection.openBidirectionalStream()` /
* `openUnidirectionalStream()` or accepted with `connection.acceptStream()` /
* the `'stream'` event; never constructed directly. A bidirectional stream has
* both a readable and a writable half; a unidirectional stream has only one,
* depending on which side opened it. Read and write through the byte-oriented
* `reader`/`writer`, or through the `readable`/`writable` Web Streams adapters.
* It extends `EventTarget` and emits `'reset'`, `'stopsending'`, and
* `'blocked'`.
*
* `reset()` abruptly terminates the sending side with an application error
* code; `stopSending()` asks the peer to stop sending on the receiving side.
* `resetAt()` resets after reliably delivering a prefix, when the ngtcp2 build
* supports it.
*
* ```ts no_run
* const stream = await conn.openBidirectionalStream();
* await stream.writer.write(new TextEncoder().encode('ping'));
* await stream.writer.close();
* for await (const chunk of stream.readable) console.log(chunk.length);
* ```
*/
export class QuicStream extends EventTarget {
  /** Numeric QUIC stream identifier, encoding initiator and directionality. */
  readonly id: number;
  /** Whether the stream is bidirectional or send/receive-only. */
  readonly direction: 'bidirectional' | 'unidirectional';
  /** Byte-oriented reader for the receiving half (closed on send-only streams). */
  readonly reader: BytesReader;
  /** Byte-oriented writer for the sending half (throws on receive-only streams). */
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
  /**
  * Web `ReadableStream` view of the receiving half.
  *
  * Lazily created and cached. Cancelling the stream issues `stopSending(0)`.
  * Prefer `reader` for lower-level byte access.
  */
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
  /**
  * Web `WritableStream` view of the sending half.
  *
  * Lazily created and cached. Closing it sends FIN; aborting it resets the
  * stream (with the abort reason as the error code when it is a number). Prefer
  * `writer` for lower-level byte access.
  */
  get writable(): WritableStream<Uint8Array> {
    if (this.#writable !== null) return this.#writable;
    this.#writable = new WritableStream<Uint8Array>({
      write: (chunk) => this.writer.write(chunk),
      close: () => this.writer.close(),
      abort: (reason) => this.reset(typeof reason === 'number' ? reason : 0)
    });
    return this.#writable;
  }
  /** Frozen snapshot of this stream's byte and offset counters. */
  get stats(): QuicStreamStats {
    const stats = { ...this.#stats };
    if (this.writer.closed && stats.bytesSent > 0 && stats.bytesAcked === 0) {
      stats.bytesAcked = stats.bytesSent;
      stats.maxOffsetAcked = Math.max(stats.maxOffsetAcked, stats.maxOffsetSent);
      if (stats.ackedAt === null) stats.ackedAt = Date.now();
    }
    return Object.freeze(stats);
  }
  /**
  * Abruptly terminate the sending half with an application error code.
  *
  * Sends RESET_STREAM to the peer; any unacknowledged outgoing data is
  * discarded. Throws if the owning connection is already closed.
  *
  * ```ts no_run
  * stream.reset(0x101); // abort with an application-defined code
  * ```
  */
  reset(errorCode: number): void {
    this.#assertConnectionOpen();
    ngtcp2Sym!.ngtcp2_conn_shutdown_stream(this.#connection.nativeHandle, 0, BigInt(this.id), BigInt(errorCode));
    this[quicStreamInternals.resetFromConnection](errorCode);
    this.#connection[quicConnectionInternals.scheduleWrites]();
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
    this[quicStreamInternals.resetFromConnection](errorCode);
    this.#connection[quicConnectionInternals.scheduleWrites]();
  }
  /**
  * Ask the peer to stop sending on the receiving half.
  *
  * Sends STOP_SENDING with the given application error code and closes the
  * local receive side. No-op on a locally opened unidirectional stream (which
  * has no receiving half). Throws if the owning connection is already closed.
  *
  * ```ts no_run
  * stream.stopSending(0); // we no longer want incoming data
  * ```
  */
  stopSending(errorCode: number): void {
    this.#assertConnectionOpen();
    if (this.#connection[quicConnectionInternals.isLocalUnidirectionalStream](this.id)) return;
    this.#incoming.close();
    this.#readStopped = true;
    const rc = ngtcp2Sym!.ngtcp2_conn_shutdown_stream_read(this.#connection.nativeHandle, 0, BigInt(this.id), BigInt(errorCode)) as number;
    if (rc !== 0) throw ngtcp2Error(rc, 'ngtcp2_conn_shutdown_stream_read');
    this.#connection[quicConnectionInternals.scheduleWrites]();
  }
  #assertConnectionOpen(): void {
    if (this.#connection[quicConnectionInternals.isClosedForInternalUse]() || ptrAddress(this.#connection.nativeHandle) === 0n) {
      throw new Error('QUIC connection is closed');
    }
  }
  [quicStreamInternals.reserveWrite](buf: Uint8Array): void {
    if (this.#closed) throw new Error('QUIC stream is closed');
    this[quicStreamInternals.assertWritableSide]();
    if (typeof this.#connection[quicConnectionInternals.reserveStreamData] === 'function') {
      this.#connection[quicConnectionInternals.reserveStreamData](buf);
    }
  }
  [quicStreamInternals.queueWrite](buf: Uint8Array, fin: boolean, earlyDataReserved = false): void {
    if (this.#closed) throw new Error('QUIC stream is closed');
    this[quicStreamInternals.assertWritableSide]();
    this.#connection[quicConnectionInternals.queueStreamData](this, buf, fin, earlyDataReserved);
  }
  [quicStreamInternals.hasWritableSide](): boolean {
    return this.#writableSide;
  }
  [quicStreamInternals.readFinReceived](): boolean {
    return this.#incomingFinOffset !== null;
  }
  [quicStreamInternals.assertWritableSide](): void {
    if (!this.#writableSide) throw new Error('QUIC unidirectional stream is receive-only');
  }
  [quicStreamInternals.scheduleWriterFlush](callback: () => void): void {
    if (typeof this.#connection[quicConnectionInternals.scheduleStreamWriterFlush] === 'function') {
      this.#connection[quicConnectionInternals.scheduleStreamWriterFlush](callback);
    } else {
      loop.timeout(0).then(callback, () => {});
    }
  }
  [quicStreamInternals.readIncoming](maxBytes = 65536, signal?: AbortSignal | null): Promise<Uint8Array | null> {
    return this.#incoming.read(maxBytes, signal);
  }
  [quicStreamInternals.extendStreamReceiveCredit](bytes: number): void {
    this.#connection?.[quicConnectionInternals.extendStreamReceiveCredit]?.(this.id, bytes);
  }
  [quicStreamInternals.extendConnectionReceiveCredit](bytes: number): void {
    this.#connection?.[quicConnectionInternals.extendConnectionReceiveCredit]?.(bytes);
  }
  [quicStreamInternals.pushIncoming](offset: number, data: Uint8Array, fin: boolean): void {
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
  [quicStreamInternals.resetFromConnection](errorCode: number): void {
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
  [quicStreamInternals.blockedFromConnection](): void {
    deferAfterNativeCallback(() => this.dispatchEvent(new QuicStreamBlockedEvent('blocked', {
      stream: this,
      connection: this.#connection,
      streamId: this.id
    })));
  }
  [quicStreamInternals.stopSendingFromConnection](errorCode: number): void {
    this.writer[quicBytesWriterInternals.closeFromStopSending]();
    deferAfterNativeCallback(() => this.dispatchEvent(new QuicStopSendingEvent('stopsending', { errorCode })));
    this.#maybeClose();
  }
  [quicStreamInternals.stopSendingSentFromConnection](errorCode: number): void {
    deferAfterNativeCallback(() => this.dispatchEvent(new QuicStopSendingEvent('stopsending', { errorCode })));
  }
  [quicStreamInternals.writerClosed](): boolean {
    return this.writer.closed;
  }
  [quicStreamInternals.recordQueuedWrite](bytes: number): void {
    this.#stats.bytesSent += bytes;
    this.#stats.maxOffsetSent += bytes;
    this.#stats.maxOffset = this.#stats.maxOffsetSent;
  }
  [quicStreamInternals.recordAck](offset: number, datalen: number): void {
    this.#stats.ackedAt = Date.now();
    this.#stats.bytesAcked += datalen;
    this.#stats.maxOffsetAcked = Math.max(this.#stats.maxOffsetAcked, offset + datalen);
  }
  [quicStreamInternals.closeFromConnection](error?: Error): void {
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
    this.#connection[quicConnectionInternals.removeStream](this);
    publishQuicTopic('quic.stream.closed', {
      stream: this,
      connection: this.#connection,
      error,
      stats: this.stats
    });
    deferAfterNativeCallback(() => this.dispatchEvent(new Event('close')));
  }
}

export { quicBytesWriterInternals, quicStreamInternals } from './core.ts';
export type { QuicStreamStats } from './core.ts';
