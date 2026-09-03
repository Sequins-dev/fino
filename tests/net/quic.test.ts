import { describe, it } from 'fino:test/test';
import { topic } from 'fino:context/topic';
import {
  CidRoutingTable,
  QuicConnectionEvent,
  QuicDatagramEvent,
  QuicDatagramStatusEvent,
  QuicEarlyDataEvent,
  QuicEndpoint,
  QuicErrorEvent,
  QuicNewTokenEvent,
  QuicStream,
  QuicStreamBlockedEvent,
  QuicStreamResetEvent,
  QuicStreamEvent,
  QuicStopSendingEvent,
  QuicPathValidationEvent,
  __inspectQuicCallbackTable,
  __inspectQuicRuntimeTuning,
  cryptoBackend,
  quicAvailable,
  quicVersion,
  requireQuic,
} from 'fino:net/quic';
import {
  AF_INET,
  EAGAIN,
  IPPROTO_UDP,
  SOCK_DGRAM,
  bind as socketBind,
  close as socketClose,
  getsockname,
  recvfrom,
  sendto,
  setNonblocking,
  socket,
} from 'fino:net/socket';
import { DiskFileSystem } from 'fino:file';
import * as loop from 'internal:runtime/loop';
import {
  CB_ACK_DATAGRAM,
  CID_DATA,
  CID_DATALEN,
  CB_DCID_STATUS,
  CB_DCID_STATUS2,
  CB_EARLY_DATA_REJECTED,
  CB_EXTEND_MAX_STREAM_DATA,
  CB_GET_NEW_CONNECTION_ID,
  CB_GET_NEW_CONNECTION_ID2,
  CB_GET_PATH_CHALLENGE_DATA,
  CB_GET_PATH_CHALLENGE_DATA2,
  CB_LOST_DATAGRAM,
  CB_RECV_NEW_TOKEN,
  CB_RECV_RX_KEY,
  CB_RECV_STATELESS_RESET,
  CB_RECV_STATELESS_RESET2,
  CB_RECV_TX_KEY,
  NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE,
  NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE,
  NGTCP2_CID_SIZE,
  NGTCP2_CALLBACKS_VERSION,
  NGTCP2_MAX_UDP_PAYLOAD_SIZE,
  NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN,
  NGTCP2_PATH_VALIDATION_RESULT_SUCCESS,
  NGTCP2_PROTO_VER_V1,
  TP_ACTIVE_CONNECTION_ID_LIMIT,
  TP_ACK_DELAY_EXPONENT,
  TP_DISABLE_ACTIVE_MIGRATION,
  TP_INITIAL_MAX_DATA,
  TP_INITIAL_MAX_STREAMS_BIDI,
  TP_INITIAL_MAX_STREAMS_UNI,
  TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL,
  TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE,
  TP_INITIAL_MAX_STREAM_DATA_UNI,
  TP_MAX_ACK_DELAY,
  TP_MAX_DATAGRAM_FRAME_SIZE,
  TP_MAX_IDLE_TIMEOUT,
  TP_MAX_UDP_PAYLOAD_SIZE,
  TP_PREFERRED_ADDR,
  TP_PREFERRED_ADDR_CID,
  TP_PREFERRED_ADDR_PRESENT,
  TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN,
  TP_STATELESS_RESET_TOKEN_PRESENT,
  Pointer,
  sym as ngtcp2Sym,
} from '../../js/internal/net/quic/ngtcp2/bindings.ts';
import { sym as cryptoSym } from '../../js/internal/net/quic/ngtcp2/crypto.ts';
import { publishNetworkTopic } from 'internal:net/quic/core';
import {
  quicConnectionInternals,
  quicEndpointInternals,
  quicStreamInternals,
} from 'internal:net/quic/endpoint';
const encodeUtf8 = (value: string) => new TextEncoder().encode(value);
const decodeUtf8 = (value: Uint8Array) => new TextDecoder().decode(value);
async function readBytes(promise: Promise<IteratorResult<Uint8Array>>): Promise<Uint8Array | null> {
  const result = await promise;
  return result.done ? null : result.value;
}
const TEST_CERT = 'tests/net/fixtures/test.crt';
const TEST_KEY = 'tests/net/fixtures/test.key';
const NGTCP2_CID_TOKEN_SIZE = 160;
const CID_TOKEN_SEQ = 0;
const CID_TOKEN_CID = 8;
const fs = new DiskFileSystem('/');
function streamConnectionStub(overrides: Record<PropertyKey, unknown> = {}): any {
  return {
    closed: false,
    nativeHandle: new ArrayBuffer(8),
    [quicConnectionInternals.isClosedForInternalUse]: () => false,
    [quicConnectionInternals.extendConnectionReceiveCredit]() {},
    [quicConnectionInternals.extendStreamReceiveCredit]() {},
    [quicConnectionInternals.removeStream]() {},
    [quicConnectionInternals.scheduleWrites]() {},
    [quicConnectionInternals.reserveStreamData]() {},
    [quicConnectionInternals.queueStreamData]() {},
    ...overrides,
  };
}
async function readPemCertificateDer(path: string): Promise<Uint8Array> {
  const pem = decodeUtf8(await fs.readFile(path));
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}
function testListenOptions<T extends Record<string, unknown>>(
  options: T,
): T & {
  certificateFile: string;
  privateKeyFile: string;
} {
  return {
    ...options,
    certificateFile: TEST_CERT,
    privateKeyFile: TEST_KEY,
  };
}
async function withTimeoutValue<T, U>(
  promise: PromiseLike<T>,
  ms: number,
  timeoutValue: U,
): Promise<T | U> {
  const timer = loop.timeout(ms);
  timer.unref();
  try {
    return await Promise.race([promise, timer.then(() => timeoutValue)]);
  } finally {
    timer.cancel();
  }
}
async function waitForHandshakeComplete(
  connection: QuicConnection,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!connection.handshakeComplete) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for QUIC handshake completion');
    await loop.timeout(5);
  }
}
async function waitForStoredSessionTicket(
  sessions: Map<string, any>,
  key: string,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = sessions.get(key);
    if (state?.ticket instanceof Uint8Array && state.ticket.byteLength > 0) return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for QUIC TLS session ticket');
    await loop.timeout(5);
  }
}
function memorySessionStore(sessions: Map<string, any>) {
  return {
    load: (key: string) => sessions.get(key) ?? null,
    save: (key: string, state: any) => sessions.set(key, state),
    delete: (key: string) => sessions.delete(key),
  };
}

describe('Network topic publisher', () => {
  it('constructs events only when the topic has subscribers', (t) => {
    const name = 'test:network-topic:lazy-event';
    let constructions = 0;
    const publish = () =>
      publishNetworkTopic(name, () => {
        constructions++;
        return { value: 42 };
      });

    publish();
    t.equal(constructions, 0, 'unobserved events are not constructed');

    let received: any;
    const subscription = topic<any>(name).subscribe((event) => {
      received = event;
    });
    try {
      publish();
      t.equal(constructions, 1, 'observed events are constructed once');
      t.deepEqual(received, { value: 42 }, 'subscriber receives the constructed event');
      t.ok(Object.isFrozen(received), 'published events remain immutable');
    } finally {
      subscription.dispose();
    }
  });
});

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(offset, value, false);
}
function writeQuicVarint(buf: Uint8Array, offset: number, value: number): number {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError('QUIC varint value must be a non-negative integer');
  if (value < 64) {
    buf[offset] = value;
    return 1;
  }
  if (value < 16384) {
    buf[offset] = 64 | (value >>> 8);
    buf[offset + 1] = value & 255;
    return 2;
  }
  throw new RangeError('test helper only supports QUIC varints up to 16383');
}
function makeInitialProbe(
  seed = 0,
  token: Uint8Array = new Uint8Array(),
  options: {
    dcid?: Uint8Array;
    scid?: Uint8Array;
    version?: number;
  } = {},
): Uint8Array {
  const dcid = options.dcid ?? new Uint8Array(8);
  const scid = options.scid ?? new Uint8Array(8);
  if (options.dcid === undefined || options.scid === undefined) {
    for (let i = 0; i < 8; i++) {
      if (options.dcid === undefined) dcid[i] = (64 + seed + i) & 255;
      if (options.scid === undefined) scid[i] = (128 + seed + i) & 255;
    }
  }
  if (dcid.byteLength > 20 || scid.byteLength > 20)
    throw new RangeError('QUIC test CID is too long');
  const packet = new Uint8Array(1200);
  packet[0] = 192;
  writeU32BE(packet, 1, options.version ?? NGTCP2_PROTO_VER_V1);
  let offset = 5;
  packet[offset++] = dcid.byteLength;
  packet.set(dcid, offset);
  offset += dcid.byteLength;
  packet[offset++] = scid.byteLength;
  packet.set(scid, offset);
  offset += scid.byteLength;
  offset += writeQuicVarint(packet, offset, token.byteLength);
  packet.set(token, offset);
  offset += token.byteLength;
  writeQuicVarint(packet, offset, 0);
  return packet;
}
function parseRetryPacket(packet: Uint8Array): {
  dcid: Uint8Array;
  scid: Uint8Array;
  token: Uint8Array;
  version: number;
} {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let offset = 5;
  const dcidLen = packet[offset++];
  const dcid = packet.slice(offset, offset + dcidLen);
  offset += dcidLen;
  const scidLen = packet[offset++];
  const scid = packet.slice(offset, offset + scidLen);
  offset += scidLen;
  const tokenEnd = packet.byteLength - 16;
  if (tokenEnd < offset) throw new Error('Retry packet is too short for an integrity tag');
  return {
    dcid,
    scid,
    token: packet.slice(offset, tokenEnd),
    version: view.getUint32(1, false),
  };
}
function readU64LE(buf: ArrayBuffer, offset: number): bigint {
  return new DataView(buf).getBigUint64(offset, true);
}
function writeU64LE(buf: ArrayBuffer, offset: number, value: bigint | number): void {
  new DataView(buf).setBigUint64(offset, BigInt(value), true);
}
function makeNativeCid(bytes: Uint8Array): ArrayBuffer {
  const cid = new ArrayBuffer(NGTCP2_CID_SIZE);
  writeU64LE(cid, CID_DATALEN, bytes.byteLength);
  new Uint8Array(cid, CID_DATA, bytes.byteLength).set(bytes);
  return cid;
}
function cidBytesFromStruct(cid: ArrayBuffer): Uint8Array {
  const bytes =
    cid.byteLength >= NGTCP2_CID_SIZE
      ? new Uint8Array(cid)
      : (Pointer.copyFrom(cid, NGTCP2_CID_SIZE) as Uint8Array);
  const len = Number(readU64LE(bytes.buffer, bytes.byteOffset + CID_DATALEN));
  return bytes.subarray(CID_DATA, CID_DATA + len).slice();
}
function cidHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
function copyNativeBytes(ptr: ArrayBuffer, offset: number, length: number): Uint8Array {
  return Pointer.copyFrom(Pointer.offset(ptr, offset), length) as Uint8Array;
}
function sliceBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function currentDestinationCidHex(connection: { nativeHandle: ArrayBuffer }): string {
  const cid = ngtcp2Sym!.ngtcp2_conn_get_dcid(connection.nativeHandle) as ArrayBuffer | null;
  return cid === null ? '' : cidHex(cidBytesFromStruct(cid));
}
function activeDestinationCidSeqs(connection: { nativeHandle: ArrayBuffer }): number[] {
  const count = Number(ngtcp2Sym!.ngtcp2_conn_get_active_dcid(connection.nativeHandle, null));
  const entries = new ArrayBuffer(count * NGTCP2_CID_TOKEN_SIZE);
  const written = Number(
    ngtcp2Sym!.ngtcp2_conn_get_active_dcid(connection.nativeHandle, Pointer.of(entries)),
  );
  const seqs: number[] = [];
  for (let i = 0; i < written; i++) {
    const base = i * NGTCP2_CID_TOKEN_SIZE;
    const cid = cidBytesFromStruct(
      entries.slice(base + CID_TOKEN_CID, base + CID_TOKEN_CID + NGTCP2_CID_SIZE),
    );
    if (cid.byteLength > 0) seqs.push(Number(readU64LE(entries, base + CID_TOKEN_SEQ)));
  }
  return seqs;
}
async function recvUdp(fd: number, timeoutMs: number): Promise<Uint8Array | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const received = recvfrom(fd, 65536);
    if (typeof received !== 'number') return received.data;
    if (received !== EAGAIN) throw new Error(`recvfrom failed: ${received}`);
    await loop.timeout(5);
  }
  return null;
}
describe('QUIC bindings', () => {
  it('exports availability and version metadata', (t) => {
    t.ok(typeof quicAvailable === 'boolean', 'quicAvailable is boolean');
    t.ok(
      quicAvailable
        ? cryptoBackend === 'ossl' || cryptoBackend === 'gnutls'
        : cryptoBackend === null,
      'crypto backend reflects availability',
    );
    if (quicAvailable) {
      t.ok(typeof quicVersion === 'string', 'quicVersion is a string when available');
      t.ok((quicVersion as string).length > 0, 'quicVersion is non-empty');
    } else {
      t.equal(quicVersion, null, 'quicVersion is null when unavailable');
      t.throws(() => requireQuic(), /libngtcp2/, 'requireQuic reports missing libraries');
    }
  });
  it('wires Node-parity ngtcp2 callback slots', (t) => {
    if (!quicAvailable) return;
    const table = __inspectQuicCallbackTable();
    const ptrAt = (offset: number): bigint => new DataView(table).getBigUint64(offset, true);
    t.notEqual(
      ptrAt(CB_RECV_STATELESS_RESET),
      0n,
      'legacy stateless reset callback is wired for ngtcp2 compatibility',
    );
    t.notEqual(
      ptrAt(CB_GET_NEW_CONNECTION_ID),
      0n,
      'legacy CID generation callback is wired for ngtcp2 compatibility',
    );
    t.notEqual(
      ptrAt(CB_DCID_STATUS),
      0n,
      'legacy DCID status callback is wired for ngtcp2 compatibility',
    );
    t.notEqual(
      ptrAt(CB_GET_PATH_CHALLENGE_DATA),
      0n,
      'legacy path challenge callback is wired for ngtcp2 compatibility',
    );
    t.notEqual(ptrAt(CB_RECV_NEW_TOKEN), 0n, 'NEW_TOKEN receive callback is wired');
    t.notEqual(ptrAt(CB_ACK_DATAGRAM), 0n, 'DATAGRAM ACK callback is wired');
    t.notEqual(ptrAt(CB_LOST_DATAGRAM), 0n, 'DATAGRAM loss callback is wired');
    t.notEqual(ptrAt(CB_EXTEND_MAX_STREAM_DATA), 0n, 'stream data credit callback is wired');
    t.notEqual(ptrAt(CB_RECV_RX_KEY), 0n, 'RX key callback is wired');
    t.notEqual(ptrAt(CB_RECV_TX_KEY), 0n, 'TX key callback is wired');
    t.notEqual(ptrAt(CB_EARLY_DATA_REJECTED), 0n, 'early-data rejection callback is wired');
    if (NGTCP2_CALLBACKS_VERSION >= 3) {
      t.notEqual(ptrAt(CB_RECV_STATELESS_RESET2), 0n, 'v3 stateless reset callback is wired');
      t.notEqual(ptrAt(CB_GET_NEW_CONNECTION_ID2), 0n, 'v3 CID generation callback is wired');
      t.notEqual(ptrAt(CB_DCID_STATUS2), 0n, 'v3 DCID status callback is wired');
      t.notEqual(ptrAt(CB_GET_PATH_CHALLENGE_DATA2), 0n, 'v3 path challenge callback is wired');
    }
  });
  it('keeps UDP receive bursts aligned with Node flush pacing', (t) => {
    const tuning = __inspectQuicRuntimeTuning();
    t.equal(tuning.maxReadPacketsPerTurn, 5, 'receive loop yields after Node-sized UDP batches');
    t.equal(
      tuning.maxBatchReadPacketsPerTurn,
      32,
      'batched receive loop can drain larger recvmmsg bursts',
    );
    t.equal(tuning.retryRate, 100, 'retry rate matches Node default');
    t.equal(tuning.retryBurst, 200, 'retry burst matches Node default');
    t.equal(tuning.versionNegotiationRate, 100, 'Version Negotiation rate matches Node default');
    t.equal(tuning.versionNegotiationBurst, 200, 'Version Negotiation burst matches Node default');
    t.equal(tuning.statelessResetRate, 100, 'stateless reset rate matches Node default');
    t.equal(tuning.statelessResetBurst, 200, 'stateless reset burst matches Node default');
    t.equal(tuning.sessionCreationRate, 50, 'session creation rate matches Node default');
    t.equal(tuning.sessionCreationBurst, 100, 'session creation burst matches Node default');
  });
});
describe('QUIC event classes', () => {
  it('carry typed connection, stream, and error payloads', (t) => {
    const endpoint = new QuicEndpoint();
    const connEvent = new QuicConnectionEvent('connection', { connection: null as any });
    const streamEvent = new QuicStreamEvent('stream', { stream: null as any });
    const datagram = new Uint8Array([1, 2, 3]);
    const datagramEvent = new QuicDatagramEvent('datagram', {
      data: datagram,
      earlyData: true,
    });
    const datagramStatusEvent = new QuicDatagramStatusEvent('datagramstatus', {
      id: 7,
      status: 'ack',
    });
    const newTokenEvent = new QuicNewTokenEvent('newtoken', {
      token: new Uint8Array([5, 6]),
      address: {
        family: 'ipv4',
        ip: '127.0.0.1',
        port: 4433,
      },
    });
    const earlyDataEvent = new QuicEarlyDataEvent('earlydata', {
      accepted: true,
      rejected: false,
      reason: 'accepted',
    });
    const streamBlockedEvent = new QuicStreamBlockedEvent('blocked', {
      stream: null as any,
      connection: null as any,
      streamId: 11,
    });
    const streamResetEvent = new QuicStreamResetEvent('reset', { errorCode: 42 });
    const stopSendingEvent = new QuicStopSendingEvent('stopsending', { errorCode: 88 });
    const pathValidationEvent = new QuicPathValidationEvent('pathvalidation', {
      result: 'success',
      path: {
        localAddress: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 4433,
        },
        remoteAddress: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 4434,
        },
      },
      previousPath: null,
      preferredAddress: true,
    });
    const err = new Error('quic-test');
    const errorEvent = new QuicErrorEvent('error', { error: err });
    t.equal(connEvent.connection, null, 'connection payload exposed');
    t.equal(streamEvent.stream, null, 'stream payload exposed');
    t.equal(datagramEvent.data, datagram, 'datagram payload exposed');
    t.equal(datagramEvent.earlyData, true, 'datagram early-data flag exposed');
    t.equal(datagramStatusEvent.id, 7, 'datagram status id exposed');
    t.equal(datagramStatusEvent.status, 'ack', 'datagram status exposed');
    t.deepEqual(Array.from(newTokenEvent.token), [5, 6], 'NEW_TOKEN payload exposed');
    t.equal(newTokenEvent.address.port, 4433, 'NEW_TOKEN peer address exposed');
    t.equal(earlyDataEvent.accepted, true, '0-RTT accepted flag exposed');
    t.equal(earlyDataEvent.rejected, false, '0-RTT rejected flag exposed');
    t.equal(earlyDataEvent.reason, 'accepted', '0-RTT event reason exposed');
    t.equal(streamBlockedEvent.streamId, 11, 'stream blocked event exposes stream id');
    t.equal(streamBlockedEvent.stream, null, 'stream blocked event exposes stream');
    t.equal(streamBlockedEvent.connection, null, 'stream blocked event exposes connection');
    t.equal(streamResetEvent.errorCode, 42, 'RESET_STREAM application code exposed');
    t.ok(
      /42/.test(streamResetEvent.error.message),
      'RESET_STREAM error includes the application code',
    );
    t.equal(stopSendingEvent.errorCode, 88, 'STOP_SENDING application code exposed');
    t.ok(
      /88/.test(stopSendingEvent.error.message),
      'STOP_SENDING error includes the application code',
    );
    t.equal(pathValidationEvent.result, 'success', 'path-validation result exposed');
    t.equal(
      pathValidationEvent.path?.remoteAddress.port,
      4434,
      'path-validation remote path exposed',
    );
    t.equal(
      pathValidationEvent.preferredAddress,
      true,
      'path-validation preferred-address flag exposed',
    );
    t.equal(errorEvent.error, err, 'error payload exposed');
    t.ok(endpoint instanceof EventTarget, 'endpoint extends EventTarget');
  });
});
describe('QUIC hardening options', { exclusive: true }, () => {
  it('uses Node-aligned transport defaults while keeping 0-RTT opt-in', (t) => {
    const endpoint = new QuicEndpoint();
    t.deepEqual(
      endpoint.alpnProtocols,
      ['h3', 'fino-hq'],
      'raw QUIC defaults offer h3 before Fino hq',
    );
    t.deepEqual(
      endpoint.versions,
      ['v2', 'v1'],
      'QUIC v2/v1 compatible version preference is the default',
    );
    t.deepEqual(
      endpoint.retry,
      { enabled: true },
      'Retry address validation is enabled by default',
    );
    t.equal(endpoint.earlyData, false, '0-RTT is disabled by default');
    t.deepEqual(
      endpoint.datagrams,
      {
        enabled: true,
        maxFrameSize: NGTCP2_MAX_UDP_PAYLOAD_SIZE,
        maxPending: 128,
        dropPolicy: 'drop-oldest',
        maxSendAttempts: 5,
      },
      'DATAGRAM uses Node-aligned defaults',
    );
    t.deepEqual(
      endpoint.migration,
      {
        enabled: false,
        usePreferredAddress: false,
      },
      'active migration and preferred-address use are disabled by default',
    );
    t.equal(endpoint.qlog, false, 'qlog is disabled by default');
    t.throws(
      () => new QuicEndpoint({ qlog: { events: ['transport:packet_sent'] } as any }),
      /qlog does not support event filtering/,
      'inert qlog event filters are rejected instead of silently ignored',
    );
    t.equal(endpoint.keylog, false, 'keylog is disabled by default');
    t.equal(endpoint.tlsGroups, null, 'TLS groups use backend defaults by default');
    t.deepEqual(
      endpoint.connection,
      {
        handshakeTimeoutMs: 1e4,
        initialRttMs: 0,
        keepAliveTimeoutMs: 0,
        maxPayloadSize: 1200,
        maxWindow: 0,
        maxStreamWindow: 0,
        unacknowledgedPacketThreshold: 0,
        congestionControl: 'cubic',
        drainingPeriodMultiplier: 3,
        streamIdleTimeoutMs: 3e4,
        maxPendingStreamOpens: 1024,
        cidLength: 20,
      },
      'connection transport tuning defaults match Node',
    );
    t.equal(endpoint.tlsCipherSuites, null, 'TLS cipher suites use backend defaults by default');
    t.equal(endpoint.transport.busy, false, 'endpoint is not busy by default');
    t.equal(endpoint.transport.maxConnections, 1e4, 'default total connection limit matches Node');
    t.equal(
      endpoint.transport.maxConnectionsPerRemoteAddress,
      100,
      'default per-remote connection limit matches Node',
    );
    t.equal(
      endpoint.transport.retryTokenTimeoutMs,
      1e4,
      'Retry token timeout defaults to 10 seconds',
    );
    t.equal(
      endpoint.transport.addressTokenTimeoutMs,
      1e4,
      'regular address token timeout defaults to 10 seconds',
    );
    t.equal(
      endpoint.transport.addressValidationCacheSize,
      1024,
      'address validation cache default matches Node',
    );
    t.deepEqual(
      endpoint.transport.immediateCloseRateLimit,
      {
        rate: 100,
        burst: 200,
      },
      'immediate close rate limit defaults match Node',
    );
    t.equal(
      endpoint.transport.disableStatelessReset,
      false,
      'stateless reset is enabled by default',
    );
  });
  it('inherits and overrides connection transport tuning options', (t) => {
    const endpoint = new QuicEndpoint({
      connection: {
        handshakeTimeoutMs: 250,
        initialRttMs: 25,
        keepAliveTimeoutMs: 75,
        maxPayloadSize: 1300,
        maxWindow: 65536,
        maxStreamWindow: 32768,
        unacknowledgedPacketThreshold: 2,
        congestionControl: 'reno',
        drainingPeriodMultiplier: 4,
        streamIdleTimeoutMs: 500,
        maxPendingStreamOpens: 7,
        cidLength: 12,
      },
    });
    t.deepEqual(
      endpoint.connection,
      {
        handshakeTimeoutMs: 250,
        initialRttMs: 25,
        keepAliveTimeoutMs: 75,
        maxPayloadSize: 1300,
        maxWindow: 65536,
        maxStreamWindow: 32768,
        unacknowledgedPacketThreshold: 2,
        congestionControl: 'reno',
        drainingPeriodMultiplier: 4,
        streamIdleTimeoutMs: 500,
        maxPendingStreamOpens: 7,
        cidLength: 12,
      },
      'endpoint exposes resolved connection tuning options',
    );
  });
  it('sends keep-alive PINGs only when keep-alive is enabled', async (t) => {
    if (!quicAvailable) return;
    const activeServer = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const activeListener = await activeServer.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const activeClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: { keepAliveTimeoutMs: 50 },
    });
    try {
      const clientConnection = await activeClient.connect({ address: activeListener.address });
      const serverConnection = await activeServer.accept();
      await loop.timeout(180);
      t.ok(serverConnection.stats.pingReceived > 0, 'peer receives keep-alive PINGs when enabled');
      await clientConnection.close();
    } finally {
      await activeClient.close();
      await activeServer.close();
    }
    const idleServer = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const idleListener = await idleServer.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const idleClient = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await idleClient.connect({ address: idleListener.address });
      const serverConnection = await idleServer.accept();
      await loop.timeout(60);
      const initialPingCount = serverConnection.stats.pingReceived;
      await loop.timeout(180);
      t.equal(
        serverConnection.stats.pingReceived,
        initialPingCount,
        'default keep-alive setting does not send idle PINGs',
      );
      await clientConnection.close();
    } finally {
      await idleClient.close();
      await idleServer.close();
    }
  });
  it('clamps transport token expiries to Node-compatible ranges', (t) => {
    const endpoint = new QuicEndpoint({
      transport: {
        retryTokenTimeoutMs: 500,
        addressTokenTimeoutMs: 10 * 60 * 1e3,
      },
    });
    t.equal(
      endpoint.transport.retryTokenTimeoutMs,
      1e3,
      'Retry token timeout clamps to at least one second',
    );
    t.equal(
      endpoint.transport.addressTokenTimeoutMs,
      5 * 60 * 1e3,
      'regular address token timeout clamps to five minutes',
    );
  });
  it('returns read-only endpoint stats snapshots', (t) => {
    const endpoint = new QuicEndpoint();
    const stats = endpoint.stats;
    t.equal(Object.isFrozen(stats), true, 'stats snapshot is frozen');
    t.equal(stats.createdAt <= Date.now(), true, 'stats include endpoint creation time');
    t.equal(stats.destroyedAt, null, 'open endpoint has no destroyed timestamp');
    t.equal(stats.serverConnections, 0, 'stats include cumulative server connection count');
    t.equal(stats.clientConnections, 0, 'stats include cumulative client connection count');
    t.equal(stats.immediateCloseSent, 0, 'stats include immediate close send count');
    t.equal(stats.immediateCloseRateLimited, 0, 'stats include immediate close rate-limit count');
    t.throws(
      () => {
        (stats as any).packetsReceived = 100;
      },
      /read only|not writable|Cannot assign/i,
      'stats snapshot cannot be mutated by callers',
    );
    t.equal(
      endpoint.stats.packetsReceived,
      0,
      'mutating a snapshot cannot affect endpoint counters',
    );
  });
  it('exposes read-only connection and stream stats snapshots', (t) => {
    const endpoint = new QuicEndpoint();
    const stream = new QuicStream(0, 'bidirectional', streamConnectionStub());
    t.equal(Object.isFrozen(stream.stats), true, 'stream stats snapshot is frozen');
    t.equal(stream.stats.bytesReceived, 0, 'stream stats include received byte count');
    t.equal(stream.stats.bytesSent, 0, 'stream stats include sent byte count');
    t.equal(stream.stats.maxOffset, 0, 'stream stats include sent max offset');
    t.equal(stream.stats.maxOffsetAcked, 0, 'stream stats include acknowledged max offset');
    t.equal(stream.stats.bytesAccumulated, 0, 'stream stats include buffered byte count');
    t.equal(stream.stats.maxBytesAccumulated, 0, 'stream stats include peak buffered byte count');
    t.throws(
      () => {
        (stream.stats as any).bytesReceived = 10;
      },
      /read only|not writable|Cannot assign/i,
      'stream stats snapshot cannot be mutated',
    );
    t.equal(
      endpoint.stats.activeConnections,
      0,
      'endpoint remains independent from stream unit fixture',
    );
  });
  it('requires replay-safe opt-in and session storage before enabling early data', (t) => {
    t.throws(
      () => new QuicEndpoint({ earlyData: { replaySafe: true } as any }),
      /sessionStore/,
      '0-RTT requires persisted session storage',
    );
    t.throws(
      () =>
        new QuicEndpoint({
          sessionStore: {
            load: async () => null,
            save: async () => {},
            delete: async () => {},
          },
          earlyData: { replaySafe: false } as any,
        }),
      /replay-safe/,
      '0-RTT requires replay-safe policy',
    );
  });
  it('accepts only QUIC-compatible TLS 1.3 cipher suite constraints', (t) => {
    const endpoint = new QuicEndpoint({
      tlsCipherSuites: ['TLS_CHACHA20_POLY1305_SHA256'],
      tlsGroups: ['X25519'],
    });
    t.deepEqual(
      endpoint.tlsCipherSuites,
      ['TLS_CHACHA20_POLY1305_SHA256'],
      'cipher suite constraint is exposed',
    );
    t.deepEqual(endpoint.tlsGroups, ['X25519'], 'TLS group constraint is exposed');
    t.throws(
      () => new QuicEndpoint({ tlsCipherSuites: ['TLS_RSA_WITH_AES_128_CBC_SHA'] as any }),
      /Unsupported QUIC TLS cipher suite/,
      'non-QUIC TLS cipher suites are rejected',
    );
    t.throws(
      () => new QuicEndpoint({ tlsGroups: [] }),
      /TLS group list/,
      'empty TLS group lists are rejected',
    );
    t.throws(
      () => new QuicEndpoint({ tlsGroups: [''] }),
      /TLS groups/,
      'empty TLS group names are rejected',
    );
  });
  it('validates endpoint UDP socket options', async (t) => {
    t.throws(
      () => new QuicEndpoint({ socket: { receiveBufferSize: 0 } }),
      /receiveBufferSize/,
      'receive buffer size must be positive',
    );
    t.throws(() => new QuicEndpoint({ socket: { ttl: 300 } }), /ttl/, 'TTL is bounded to one byte');
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({
      socket: {
        reusePort: false,
        receiveBufferSize: 64 * 1024,
        sendBufferSize: 64 * 1024,
        ttl: 64,
      },
    });
    try {
      const listener = await endpoint.listen(
        testListenOptions({
          address: {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: 0,
          },
        }),
      );
      t.equal(listener.address.family, 'ipv4', 'endpoint binds with configured UDP socket options');
    } finally {
      await endpoint.close();
    }
  });
});
describe('QUIC endpoint lifecycle', () => {
  it('listen and connect require native ngtcp2 support', async (t) => {
    if (quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    await t.rejects(
      () =>
        endpoint.listen({
          address: {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: 0,
          },
        }),
      /libngtcp2/,
      'listen rejects when native QUIC is unavailable',
    );
    await t.rejects(
      () =>
        endpoint.connect({
          address: {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: 4433,
          },
        }),
      /libngtcp2/,
      'connect rejects when native QUIC is unavailable',
    );
    await endpoint.close();
  });
  it('requires explicit server certificate material', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      await t.rejects(
        () =>
          endpoint.listen({
            address: {
              family: 'ipv4',
              ip: '127.0.0.1',
              port: 0,
            },
          }),
        /certificateFile.*privateKeyFile/,
        'listen no longer falls back to repository test credentials',
      );
    } finally {
      await endpoint.close();
    }
  });
  it('listener answers unsupported-version Initial probes with Version Negotiation', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    let endpointError: unknown = null;
    endpoint.addEventListener('error', (event: any) => {
      endpointError = event.error;
    });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const clientDcid = new Uint8Array([64, 65, 66, 67, 68, 69, 70, 71]);
      const clientScid = new Uint8Array([128, 129, 130, 131, 132, 133, 134, 135]);
      const probe = makeInitialProbe(21, new Uint8Array(), {
        dcid: clientDcid,
        scid: clientScid,
        version: 1463896404,
      });
      t.equal(
        sendto(fd, probe, listener.address),
        probe.byteLength,
        'unsupported-version probe sent',
      );
      const response = await recvUdp(fd, 500);
      if (endpointError !== null) throw endpointError;
      if (response === null)
        throw new Error('listener did not send a Version Negotiation response');
      t.equal(response[0] & 128, 128, 'response uses long header form');
      t.equal(
        new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(1, false),
        0,
        'response is Version Negotiation',
      );
      const responseDcidLen = response[5];
      const responseDcid = response.slice(6, 6 + responseDcidLen);
      const responseScidLen = response[6 + responseDcidLen];
      const responseScid = response.slice(
        7 + responseDcidLen,
        7 + responseDcidLen + responseScidLen,
      );
      t.deepEqual(
        Array.from(responseDcid),
        Array.from(clientScid),
        'Version Negotiation DCID is the client SCID',
      );
      t.deepEqual(
        Array.from(responseScid),
        Array.from(clientDcid),
        'Version Negotiation SCID is the client DCID',
      );
      const versions: number[] = [];
      for (
        let offset = 7 + responseDcidLen + responseScidLen;
        offset + 4 <= response.byteLength;
        offset += 4
      ) {
        versions.push(
          new DataView(response.buffer, response.byteOffset + offset, 4).getUint32(0, false),
        );
      }
      t.ok(
        versions.some((version) => ngtcp2Sym!.ngtcp2_is_supported_version(version) !== 0),
        'response advertises at least one supported version',
      );
      t.ok(
        versions.some((version) => ngtcp2Sym!.ngtcp2_is_supported_version(version) === 0),
        'response includes a reserved version grease value',
      );
    } finally {
      socketClose(fd);
      await endpoint.close();
    }
  });
  it('listener filters Version Negotiation advertisements to configured supported versions', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      versions: ['v1'],
    });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        versions: ['v1'],
      }),
    );
    const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const probe = makeInitialProbe(22, new Uint8Array(), { version: 1463896404 });
      t.equal(
        sendto(fd, probe, listener.address),
        probe.byteLength,
        'unsupported-version probe sent to v1-only listener',
      );
      const response = await recvUdp(fd, 500);
      if (response === null)
        throw new Error('listener did not send a Version Negotiation response');
      const dcidLen = response[5];
      const scidLen = response[6 + dcidLen];
      const versions: number[] = [];
      for (let offset = 7 + dcidLen + scidLen; offset + 4 <= response.byteLength; offset += 4) {
        versions.push(
          new DataView(response.buffer, response.byteOffset + offset, 4).getUint32(0, false),
        );
      }
      t.ok(
        versions.includes(NGTCP2_PROTO_VER_V1),
        'Version Negotiation advertises configured QUIC v1',
      );
      t.equal(
        versions.some(
          (version) =>
            version !== NGTCP2_PROTO_VER_V1 &&
            ngtcp2Sym!.ngtcp2_is_supported_version(version) !== 0,
        ),
        false,
        'Version Negotiation omits supported versions not configured on the listener',
      );
      t.ok(
        versions.some((version) => ngtcp2Sym!.ngtcp2_is_supported_version(version) === 0),
        'Version Negotiation still includes grease',
      );
    } finally {
      socketClose(fd);
      await endpoint.close();
    }
  });
  it('listener ignores long-header Version Negotiation packets without stateless reset', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const packet = new Uint8Array(43);
      packet[0] = 192;
      writeU32BE(packet, 1, 0);
      packet[5] = 8;
      for (let i = 0; i < 8; i++) packet[6 + i] = 64 + i;
      packet[14] = 8;
      for (let i = 0; i < 8; i++) packet[15 + i] = 128 + i;
      t.equal(
        sendto(fd, packet, listener.address),
        packet.byteLength,
        'long-header Version Negotiation-looking packet sent',
      );
      t.equal(
        await recvUdp(fd, 100),
        null,
        'listener does not answer long-header Version Negotiation with a stateless reset',
      );
    } finally {
      socketClose(fd);
      await endpoint.close();
    }
  });
  it('rate-limits Version Negotiation responses for unsupported-version floods', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const responseFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    const sendFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(responseFd);
    setNonblocking(sendFd);
    socketBind(responseFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    socketBind(sendFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const bound = getsockname(responseFd);
      if (bound.family !== 'ipv4')
        throw new Error('Version Negotiation test expected IPv4 response socket');
      const tuning = __inspectQuicRuntimeTuning();
      const attempts = tuning.versionNegotiationBurst + 200;
      const started = performance.now();
      for (let attempt = 0; attempt < attempts; attempt++) {
        const probe = new Uint8Array(1207);
        probe[0] = 192;
        writeU32BE(probe, 1, 1463896404);
        probe[5] = 8;
        for (let i = 0; i < 8; i++) probe[6 + i] = (attempt + i) & 255;
        probe[14] = 8;
        for (let i = 0; i < 8; i++) probe[15 + i] = (128 + attempt + i) & 255;
        endpoint[quicEndpointInternals.handleDatagram](
          listener,
          sendFd,
          listener.address,
          probe,
          bound,
        );
      }
      const elapsedSeconds = (performance.now() - started) / 1e3;
      let responses = 0;
      for (;;) {
        const response = await recvUdp(responseFd, responses === 0 ? 500 : 25);
        if (response === null) break;
        responses++;
      }
      const maxAllowed =
        tuning.versionNegotiationBurst +
        Math.ceil(tuning.versionNegotiationRate * elapsedSeconds) +
        2;
      t.ok(responses > 0, 'initial Version Negotiation burst is still allowed');
      t.ok(
        responses <= maxAllowed,
        'Version Negotiation responses stay within the Node-style token bucket',
      );
      t.ok(responses < attempts, 'unsupported-version flood probes are throttled');
    } finally {
      socketClose(responseFd);
      socketClose(sendFd);
      await endpoint.close();
    }
  });
  it('listener sends Retry by default for an unvalidated Initial', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const probe = makeInitialProbe();
      t.equal(sendto(fd, probe, listener.address), probe.byteLength, 'Initial probe sent');
      const response = await recvUdp(fd, 500);
      if (response === null) throw new Error('listener did not send a Retry response');
      t.equal(response[0] & 240, 240, 'response is a QUIC v1 Retry packet');
      t.equal(
        new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(1, false),
        NGTCP2_PROTO_VER_V1,
        'Retry keeps the client version',
      );
    } finally {
      socketClose(fd);
      await endpoint.close();
    }
  });
  it('listener rejects tampered and address-mismatched Retry tokens', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const fdA = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    const fdB = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fdA);
    setNonblocking(fdB);
    socketBind(fdA, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    socketBind(fdB, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      t.equal(
        sendto(fdA, makeInitialProbe(10), listener.address),
        1200,
        'first unvalidated Initial probe sent',
      );
      const firstResponse = await recvUdp(fdA, 500);
      if (firstResponse === null) throw new Error('listener did not send initial Retry response');
      const retry = parseRetryPacket(firstResponse);
      t.equal(retry.version, NGTCP2_PROTO_VER_V1, 'Retry token is bound to the probed version');
      t.ok(retry.token.byteLength > 0, 'Retry response carries token material');
      const tamperedToken = retry.token.slice();
      tamperedToken[tamperedToken.byteLength - 1] ^= 1;
      const retryDcid = retry.scid;
      const retryScid = retry.dcid;
      t.equal(
        sendto(
          fdA,
          makeInitialProbe(11, tamperedToken, {
            dcid: retryDcid,
            scid: retryScid,
          }),
          listener.address,
        ),
        1200,
        'tampered Retry token probe sent from original address',
      );
      const tamperedResponse = await recvUdp(fdA, 500);
      if (tamperedResponse === null)
        throw new Error('listener accepted or ignored a tampered Retry token');
      t.notEqual(
        tamperedResponse[0] & 240,
        240,
        'tampered Retry token receives immediate close instead of fresh Retry',
      );
      const wrongRetryDcid = retryDcid.slice();
      wrongRetryDcid[wrongRetryDcid.byteLength - 1] ^= 2;
      t.equal(
        sendto(
          fdA,
          makeInitialProbe(13, retry.token, {
            dcid: wrongRetryDcid,
            scid: retryScid,
          }),
          listener.address,
        ),
        1200,
        'valid Retry token replayed with the wrong Retry DCID',
      );
      const wrongDcidResponse = await recvUdp(fdA, 500);
      if (wrongDcidResponse === null)
        throw new Error('listener accepted or ignored a Retry token with the wrong Retry DCID');
      t.notEqual(
        wrongDcidResponse[0] & 240,
        240,
        'Retry-token DCID mismatch receives immediate close instead of fresh Retry',
      );
      t.equal(
        sendto(
          fdB,
          makeInitialProbe(12, retry.token, {
            dcid: retryDcid,
            scid: retryScid,
          }),
          listener.address,
        ),
        1200,
        'valid Retry token replayed from a different address',
      );
      const addressMismatchResponse = await recvUdp(fdB, 500);
      if (addressMismatchResponse === null)
        throw new Error('listener accepted or ignored an address-mismatched Retry token');
      t.notEqual(
        addressMismatchResponse[0] & 240,
        240,
        'address-mismatched Retry token receives immediate close instead of fresh Retry',
      );
      const stats = endpoint.stats;
      t.equal(
        stats.retryTokenRejected,
        3,
        'invalid Retry tokens increment Retry-token rejection stats',
      );
      t.equal(
        stats.addressTokenRejected,
        0,
        'invalid Retry tokens are not counted as regular address-token rejections',
      );
      t.equal(
        stats.immediateCloseSent,
        3,
        'invalid Retry tokens send immediate CONNECTION_CLOSE packets',
      );
    } finally {
      socketClose(fdA);
      socketClose(fdB);
      await endpoint.close();
    }
  });
  it('listener rejects expired Retry tokens with an immediate close', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      transport: { retryTokenTimeoutMs: 1e3 },
    });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      t.equal(
        sendto(fd, makeInitialProbe(14), listener.address),
        1200,
        'first unvalidated Initial probe sent',
      );
      const firstResponse = await recvUdp(fd, 500);
      if (firstResponse === null) throw new Error('listener did not send initial Retry response');
      const retry = parseRetryPacket(firstResponse);
      await loop.timeout(1050);
      t.equal(
        sendto(
          fd,
          makeInitialProbe(15, retry.token, {
            dcid: retry.scid,
            scid: retry.dcid,
          }),
          listener.address,
        ),
        1200,
        'expired Retry token probe sent from original address',
      );
      const expiredResponse = await recvUdp(fd, 500);
      if (expiredResponse === null)
        throw new Error('listener accepted or ignored an expired Retry token');
      t.notEqual(
        expiredResponse[0] & 240,
        240,
        'expired Retry token receives immediate close instead of fresh Retry',
      );
      t.equal(
        endpoint.stats.retryTokenRejected,
        1,
        'expired Retry token increments Retry-token rejection stats',
      );
      t.equal(
        endpoint.stats.immediateCloseSent,
        1,
        'expired Retry token sends an immediate CONNECTION_CLOSE packet',
      );
    } finally {
      socketClose(fd);
      await endpoint.close();
    }
  });
  it('listener drops undersized Initial packets without Retry amplification', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const undersized = makeInitialProbe(14).slice(0, 1199);
      t.equal(
        sendto(fd, undersized, listener.address),
        undersized.byteLength,
        'undersized Initial probe sent',
      );
      t.equal(
        await recvUdp(fd, 100),
        null,
        'listener silently drops Initial packets smaller than 1200 bytes',
      );
    } finally {
      socketClose(fd);
      await endpoint.close();
    }
  });
  it('listener drops malformed Initial probes without Retry amplification', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(fd);
    socketBind(fd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const invalidFixedBit = makeInitialProbe(15);
      invalidFixedBit[0] &= 191;
      t.equal(
        sendto(fd, invalidFixedBit, listener.address),
        invalidFixedBit.byteLength,
        'Initial with invalid fixed bit sent',
      );
      t.equal(
        await recvUdp(fd, 100),
        null,
        'listener silently drops Initial packets with an invalid fixed bit',
      );
      const invalidLongHeaderType = makeInitialProbe(16);
      invalidLongHeaderType[0] = 240;
      t.equal(
        sendto(fd, invalidLongHeaderType, listener.address),
        invalidLongHeaderType.byteLength,
        'Initial-shaped packet with invalid long-header type sent',
      );
      t.equal(
        await recvUdp(fd, 100),
        null,
        'listener silently drops invalid long-header packet types',
      );
      const malformedVarint = makeInitialProbe(17);
      malformedVarint[23] = 255;
      t.equal(
        sendto(fd, malformedVarint, listener.address),
        malformedVarint.byteLength,
        'Initial with malformed token varint sent',
      );
      t.equal(
        await recvUdp(fd, 100),
        null,
        'listener silently drops malformed Initial token lengths',
      );
    } finally {
      socketClose(fd);
      await endpoint.close();
    }
  });
  it('listener close does not close the endpoint', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    t.equal(endpoint.listeners.length, 1, 'listener registered');
    await listener.close();
    t.equal(endpoint.listeners.length, 0, 'listener removed');
    const second = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    t.ok(second.address.port > 0, 'endpoint can listen again after listener close');
    await endpoint.close();
  });
  it('pending endpoint accept rejects on close', async (t) => {
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const pending = endpoint.accept();
    await endpoint.close();
    await t.rejects(
      () => pending,
      /endpoint is closed/,
      'pending accept rejects after endpoint close',
    );
  });
});
describe('QUIC loopback object model', () => {
  it('reassembles stream data by QUIC offset before exposing reads', async (t) => {
    const request = encodeUtf8('GET /intense-warm-floppy\r\n');
    const stream = new QuicStream(0, 'bidirectional', null as any);
    stream[quicStreamInternals.pushIncoming](13, request.subarray(13), true);
    stream[quicStreamInternals.pushIncoming](0, request.subarray(0, 13), false);
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await readBytes(stream.reader.read());
      if (chunk === null) break;
      chunks.push(chunk);
    }
    const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
    const assembled = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      assembled.set(chunk, offset);
      offset += chunk.byteLength;
    }
    t.equal(
      decodeUtf8(assembled),
      'GET /intense-warm-floppy\r\n',
      'out-of-order stream data is exposed in byte-offset order',
    );
  });
  it('keeps a large stream open until a late missing range arrives before FIN', async (t) => {
    const body = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < body.byteLength; i++) body[i] = i & 255;
    const gapStart = 6685332;
    const gapEnd = gapStart + 2599;
    const stream = new QuicStream(0, 'bidirectional', null as any);
    stream[quicStreamInternals.pushIncoming](0, body.subarray(0, gapStart), false);
    stream[quicStreamInternals.pushIncoming](gapEnd, body.subarray(gapEnd), true);
    let total = 0;
    while (total < gapStart) {
      const chunk = await readBytes(stream.reader.read());
      if (chunk === null) break;
      total += chunk.byteLength;
    }
    t.equal(total, gapStart, 'reader exposes contiguous data before the missing range');
    stream[quicStreamInternals.pushIncoming](gapStart, body.subarray(gapStart, gapEnd), false);
    let checksum = 0;
    for (;;) {
      const chunk = await readBytes(stream.reader.read());
      if (chunk === null) break;
      for (const byte of chunk) checksum = (checksum + byte) >>> 0;
      total += chunk.byteLength;
    }
    t.equal(total, body.byteLength, 'reader reaches FIN after the late missing range arrives');
    t.equal(checksum, 484562562, 'late range and tail bytes preserve order');
  });
  it('reaches FIN after overlapping retransmits fill a late stream gap', async (t) => {
    const body = new Uint8Array(512 * 1024);
    for (let i = 0; i < body.byteLength; i++) body[i] = (i * 17) & 255;
    const gapStart = 18e4;
    const gapEnd = 183e3;
    const stream = new QuicStream(0, 'bidirectional', null as any);
    const chunks: Uint8Array[] = [];
    let total = 0;
    stream[quicStreamInternals.pushIncoming](0, body.subarray(0, gapStart), false);
    stream[quicStreamInternals.pushIncoming](gapEnd, body.subarray(gapEnd), true);
    while (total < gapStart) {
      const chunk = await readBytes(stream.reader.read());
      if (chunk === null) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    t.equal(total, gapStart, 'reader waits at the missing range even after FIN has arrived');
    const blockedRead = stream.reader.read();
    t.equal(
      await withTimeoutValue(
        blockedRead.then(() => 'read'),
        25,
        'blocked',
      ),
      'blocked',
      'reader is blocked on the gap',
    );
    stream[quicStreamInternals.pushIncoming](
      gapStart - 1200,
      body.subarray(gapStart - 1200, gapStart + 900),
      false,
    );
    const unblocked = await blockedRead;
    if (unblocked.done) throw new Error('reader reached EOF before the missing range arrived');
    chunks.push(unblocked.value);
    total += chunks[chunks.length - 1].byteLength;
    t.equal(total, gapStart + 900, 'first overlapping retransmit advances into the gap');
    stream[quicStreamInternals.pushIncoming](
      gapStart + 300,
      body.subarray(gapStart + 300, gapEnd - 300),
      false,
    );
    stream[quicStreamInternals.pushIncoming](
      gapEnd - 700,
      body.subarray(gapEnd - 700, gapEnd),
      false,
    );
    let checksum = 0;
    for (;;) {
      const chunk = await withTimeoutValue(readBytes(stream.reader.read()), 1e3, undefined);
      if (chunk === undefined)
        throw new Error('reader did not reach EOF after late retransmits filled the gap');
      if (chunk === null) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    for (const chunk of chunks) for (const byte of chunk) checksum = (checksum + byte) >>> 0;
    t.equal(total, body.byteLength, 'reader reaches FIN after overlapping gap fills');
    t.equal(checksum, 66846720, 'reassembled bytes preserve order and duplicates are not exposed');
  });
  it('separates QUIC connection and stream receive credit', async (t) => {
    const request = encodeUtf8('GET /credit-accounting\r\n');
    const connectionCredits: number[] = [];
    const streamCredits: number[] = [];
    const stream = new QuicStream(
      0,
      'bidirectional',
      streamConnectionStub({
        [quicConnectionInternals.extendConnectionReceiveCredit](bytes: number) {
          connectionCredits.push(bytes);
        },
        [quicConnectionInternals.extendStreamReceiveCredit](_streamId: number, bytes: number) {
          streamCredits.push(bytes);
        },
      }),
    );
    stream[quicStreamInternals.pushIncoming](8, request.subarray(8, 16), false);
    t.deepEqual(
      connectionCredits,
      [],
      'out-of-order buffered bytes do not return connection credit',
    );
    t.deepEqual(streamCredits, [], 'out-of-order data does not return stream credit');
    stream[quicStreamInternals.pushIncoming](0, request.subarray(0, 12), false);
    t.deepEqual(
      connectionCredits,
      [],
      'contiguous but unread bytes do not return connection credit',
    );
    t.deepEqual(streamCredits, [], 'contiguous but unread bytes do not return stream credit');
    stream[quicStreamInternals.pushIncoming](4, request.subarray(4, 16), false);
    t.deepEqual(connectionCredits, [], 'duplicate data does not return connection credit');
    t.deepEqual(streamCredits, [], 'duplicate data does not return stream credit');
    stream[quicStreamInternals.pushIncoming](16, request.subarray(16), true);
    t.deepEqual(
      connectionCredits,
      [],
      'complete but unread stream data remains under connection credit',
    );
    t.deepEqual(streamCredits, [], 'complete but unread stream data remains under stream credit');
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await readBytes(stream.reader.read());
      if (chunk === null) break;
      chunks.push(chunk);
    }
    const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
    t.equal(total, request.byteLength, 'all bytes remain readable after credit accounting');
    t.equal(
      connectionCredits.reduce((total, bytes) => total + bytes, 0),
      request.byteLength,
      'read bytes return connection credit once',
    );
    t.equal(
      streamCredits.reduce((total, bytes) => total + bytes, 0),
      request.byteLength,
      'read bytes return stream credit once',
    );
  });
  it('honors byte reader maximum sizes for QUIC stream reads', async (t) => {
    const request = encodeUtf8('abcdef');
    const credits: number[] = [];
    const stream = new QuicStream(
      0,
      'bidirectional',
      streamConnectionStub({
        [quicConnectionInternals.extendStreamReceiveCredit](_streamId: number, bytes: number) {
          credits.push(bytes);
        },
      }),
    );
    const pendingByte = stream.reader.readByte();
    stream[quicStreamInternals.pushIncoming](0, request, true);
    t.equal(
      await pendingByte,
      97,
      'pending one-byte read consumes one byte from an arriving chunk',
    );
    t.equal(
      decodeUtf8((await stream.reader.readExactly(2))!),
      'bc',
      'readExactly consumes only the requested bytes',
    );
    t.equal(
      decodeUtf8((await readBytes(stream.reader.read()))!),
      'def',
      'remaining bytes stay queued for later reads',
    );
    t.equal(await readBytes(stream.reader.read()), null, 'stream still reaches EOF');
    t.deepEqual(credits, [1, 2, 3], 'flow-control credit follows actual read sizes');
  });
  it('coalesces contiguous queued stream data up to the read limit', async (t) => {
    const credits: number[] = [];
    const stream = new QuicStream(
      0,
      'bidirectional',
      streamConnectionStub({
        [quicConnectionInternals.extendStreamReceiveCredit](_streamId: number, bytes: number) {
          credits.push(bytes);
        },
      }),
    );
    stream[quicStreamInternals.pushIncoming](0, encodeUtf8('abc'), false);
    stream[quicStreamInternals.pushIncoming](3, encodeUtf8('def'), false);
    stream[quicStreamInternals.pushIncoming](6, encodeUtf8('ghi'), true);
    t.equal(
      decodeUtf8((await readBytes(stream.reader.read({ maxBytes: 8 })))!),
      'abcdefgh',
      'read coalesces queued contiguous chunks up to maxBytes',
    );
    t.equal(
      decodeUtf8((await readBytes(stream.reader.read()))!),
      'i',
      'remaining byte is preserved for the next read',
    );
    t.equal(await readBytes(stream.reader.read()), null, 'stream still reaches EOF');
    t.deepEqual(credits, [8, 1], 'flow-control credit follows the coalesced read sizes');
  });
  it('rejects reads when a connection closes before stream FIN', async (t) => {
    const stream = new QuicStream(0, 'bidirectional', streamConnectionStub());
    stream[quicStreamInternals.pushIncoming](0, encodeUtf8('partial'), false);
    t.equal(
      decodeUtf8((await readBytes(stream.reader.read()))!),
      'partial',
      'partial data is readable first',
    );
    stream[quicStreamInternals.closeFromConnection](new Error('connection closed before FIN'));
    await t.rejects(
      () => stream.reader.read(),
      /connection closed before FIN/,
      'incomplete connection close rejects instead of returning EOF',
    );
  });
  it('supports AbortSignal on QUIC stream reads', async (t) => {
    const stream = new QuicStream(0, 'bidirectional', streamConnectionStub());
    await t.rejects(
      () => stream.reader.read({ signal: AbortSignal.abort(new Error('pre-aborted read')) }),
      /pre-aborted read/,
      'pre-aborted read rejects with the abort reason',
    );
    const controller = new AbortController();
    const pending = stream.reader.read({ signal: controller.signal });
    controller.abort(new Error('mid-read abort'));
    await t.rejects(() => pending, /mid-read abort/, 'pending read rejects when the signal aborts');
    stream[quicStreamInternals.pushIncoming](0, encodeUtf8('after-abort'), true);
    t.equal(
      decodeUtf8((await readBytes(stream.reader.read()))!),
      'after-abort',
      'aborted waiter is removed before later data arrives',
    );
    t.equal(
      await readBytes(stream.reader.read()),
      null,
      'stream reaches EOF after the post-abort read',
    );
  });
  it('rejects stream control operations after connection close', (t) => {
    let scheduledWrites = 0;
    const stream = new QuicStream(
      0,
      'bidirectional',
      streamConnectionStub({
        [quicConnectionInternals.isClosedForInternalUse]: () => true,
        [quicConnectionInternals.scheduleWrites]() {
          scheduledWrites++;
        },
      }),
    );
    t.throws(
      () => stream.reset(1),
      /QUIC connection is closed/,
      'reset does not enter native code after close',
    );
    t.throws(
      () => stream.stopSending(1),
      /QUIC connection is closed/,
      'STOP_SENDING does not enter native code after close',
    );
    t.equal(scheduledWrites, 0, 'closed stream control does not schedule native writes');
  });
  it('pre-closes unavailable unidirectional stream sides', async (t) => {
    const sendOnly = new QuicStream(2, 'unidirectional', streamConnectionStub(), false);
    t.equal(
      await readBytes(sendOnly.reader.read()),
      null,
      'local send-only stream reader reaches EOF immediately',
    );
    const readableReader = sendOnly.readable.getReader();
    t.deepEqual(
      await readableReader.read(),
      {
        value: undefined,
        done: true,
      },
      'local send-only Web readable is closed',
    );
    await sendOnly.writer.write(encodeUtf8('send-only-ok'));
    await sendOnly.writer.close();
    const receiveOnly = new QuicStream(3, 'unidirectional', streamConnectionStub(), true);
    receiveOnly[quicStreamInternals.pushIncoming](0, encodeUtf8('receive-only-ok'), true);
    t.equal(
      decodeUtf8((await readBytes(receiveOnly.reader.read()))!),
      'receive-only-ok',
      'remote receive-only stream remains readable',
    );
    await t.rejects(
      () => receiveOnly.writer.write(encodeUtf8('not-writable')),
      /receive-only/,
      'remote receive-only stream writer rejects deterministically',
    );
  });
  it('coalesces stream FIN with pending write data', async (t) => {
    const queued: {
      stream: QuicStream;
      data: Uint8Array;
      fin: boolean;
    }[] = [];
    const stream = new QuicStream(
      0,
      'bidirectional',
      streamConnectionStub({
        [quicConnectionInternals.queueStreamData](
          stream: QuicStream,
          data: Uint8Array,
          fin: boolean,
        ) {
          queued.push({
            stream,
            data,
            fin,
          });
        },
      }),
    );
    const write = stream.writer.write(encodeUtf8('GET /coalesced-fin\r\n'));
    const close = stream.writer.close();
    await Promise.all([write, close]);
    t.equal(queued.length, 1, 'write and close produce one pending transport write');
    t.equal(
      decodeUtf8(queued[0].data),
      'GET /coalesced-fin\r\n',
      'pending write keeps stream data',
    );
    t.equal(queued[0].fin, true, 'pending write carries FIN');
  });
  it('coalesces stream FIN after an awaited write', async (t) => {
    const queued: {
      stream: QuicStream;
      data: Uint8Array;
      fin: boolean;
    }[] = [];
    const stream = new QuicStream(
      0,
      'bidirectional',
      streamConnectionStub({
        [quicConnectionInternals.queueStreamData](
          stream: QuicStream,
          data: Uint8Array,
          fin: boolean,
        ) {
          queued.push({
            stream,
            data,
            fin,
          });
        },
      }),
    );
    await stream.writer.write(encodeUtf8('GET /awaited-fin\r\n'));
    await stream.writer.close();
    await loop.timeout(0);
    t.equal(queued.length, 1, 'awaited write and close produce one pending transport write');
    t.equal(decodeUtf8(queued[0].data), 'GET /awaited-fin\r\n', 'pending write keeps stream data');
    t.equal(queued[0].fin, true, 'pending write carries FIN');
  });
  it('does not report locally closed stream bytes as acknowledged', async (t) => {
    const stream = new QuicStream(0, 'bidirectional', streamConnectionStub());
    stream[quicStreamInternals.recordQueuedWrite](14);
    await stream.writer.close();
    t.equal(stream.stats.bytesSent, 14, 'local write accounting records the committed bytes');
    t.equal(stream.stats.bytesAcked, 0, 'local FIN does not fabricate a peer acknowledgement');
    t.equal(stream.stats.maxOffsetAcked, 0, 'acknowledged offset remains transport-driven');
    t.equal(stream.stats.ackedAt, null, 'ack timestamp remains unset before a real ACK callback');

    stream[quicStreamInternals.recordAck](0, 5);
    const firstAckAt = stream.stats.ackedAt;
    await loop.timeout(2);
    stream[quicStreamInternals.recordAck](5, 9);
    t.equal(stream.stats.bytesAcked, 14, 'real ACK callbacks account for acknowledged bytes');
    t.equal(stream.stats.maxOffsetAcked, 14, 'real ACK callbacks advance the acknowledged offset');
    t.ok(
      stream.stats.ackedAt! >= firstAckAt!,
      'ackedAt records the most recent acknowledgement time',
    );
  });
  it('connect dispatches connection event and accept resolves once', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    let eventConnection: unknown = null;
    server.addEventListener('connection', (event: any) => {
      eventConnection = event.connection;
    });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    t.ok(clientConnection.handshakeComplete, 'client handshake is complete');
    t.equal(clientConnection.version, 'v2', 'client exposes the default preferred QUIC version');
    t.equal(serverConnection.alpnProtocol, 'fino-hq', 'server negotiated ALPN');
    t.equal(eventConnection, serverConnection, 'connection event carries accepted connection');
    await client.close();
    await server.close();
  });
  it('supports async disposal for endpoints, listeners, and connections', async (t) => {
    if (!quicAvailable) return;
    const listenerEndpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const disposableListener = await listenerEndpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    await disposableListener[Symbol.asyncDispose]();
    t.equal(disposableListener.closed, true, 'listener asyncDispose closes the listener');
    await listenerEndpoint[Symbol.asyncDispose]();
    await listenerEndpoint[Symbol.asyncDispose]();
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      await clientConnection[Symbol.asyncDispose]();
      await clientConnection.closed;
      t.equal(clientConnection.state, 'closed', 'connection asyncDispose closes the connection');
      t.equal(clientConnection.closing, false, 'closed disposed connection is no longer closing');
      await serverConnection.closed;
    } finally {
      await client[Symbol.asyncDispose]();
      await server[Symbol.asyncDispose]();
      await server[Symbol.asyncDispose]();
    }
  });
  it('covers Fino boolean verifyPeer modes for self-signed loopback certificates', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const insecureClient = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const strictClient = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const accepted = server.accept();
      const connection = await insecureClient.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: false,
      });
      const serverConnection = await accepted;
      t.equal(
        connection.handshakeComplete,
        true,
        'verifyPeer false accepts the self-signed test certificate',
      );
      await connection.close();
      await serverConnection.close();
      await t.rejects(
        () =>
          strictClient.connect({
            address: listener.address,
            serverName: 'localhost',
            verifyPeer: true,
          }),
        null,
        'verifyPeer true rejects the untrusted self-signed test certificate',
      );
    } finally {
      await insecureClient.close();
      await strictClient.close();
      await server.close();
    }
  });
  it('accepts pinned CA trust for self-signed loopback certificates', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const accepted = server.accept();
      const connection = await client.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: true,
        ca: { file: TEST_CERT },
      });
      const serverConnection = await accepted;
      t.equal(
        connection.handshakeComplete,
        true,
        'client verifies the self-signed server cert through pinned CA trust',
      );
      t.equal(
        connection.peerVerification?.errorCode,
        0,
        'client handshake reports successful certificate validation',
      );
      await connection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('accepts in-memory PEM CA trust for self-signed loopback certificates', async (t) => {
    if (!quicAvailable) return;
    const caPem = await fs.readFile(TEST_CERT);
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const accepted = server.accept();
      const connection = await client.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: true,
        ca: { pem: caPem },
      });
      const serverConnection = await accepted;
      t.equal(
        connection.handshakeComplete,
        true,
        'client verifies the server cert through in-memory CA trust',
      );
      t.equal(
        connection.peerVerification?.errorCode,
        0,
        'client handshake reports successful PEM CA validation',
      );
      await connection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('requires and exposes client certificates for mTLS listeners', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        verifyClient: true,
        ca: { file: TEST_CERT },
      }),
    );
    const anonymousClient = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const certifiedClient = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const anonymousConnection = await anonymousClient.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: false,
      });
      t.equal(
        await withTimeoutValue(
          anonymousConnection.closed.then(() => true),
          500,
          false,
        ),
        true,
        'server closes clients that do not present a required certificate',
      );
      const accepted = server.accept();
      const clientConnection = await certifiedClient.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: false,
        certificateFile: TEST_CERT,
        privateKeyFile: TEST_KEY,
      });
      const serverConnection = await accepted;
      t.equal(
        clientConnection.handshakeComplete,
        true,
        'client with certificate completes mTLS handshake',
      );
      const expectedClientCertificate = await readPemCertificateDer(TEST_CERT);
      t.ok(
        serverConnection.peerCertificate instanceof Uint8Array,
        'server exposes the peer certificate DER bytes',
      );
      t.deepEqual(
        Array.from(serverConnection.peerCertificate!),
        Array.from(expectedClientCertificate),
        'server peer certificate matches the client certificate DER',
      );
      t.deepEqual(
        serverConnection.peerVerification,
        {
          verified: true,
          errorCode: 0,
          reason: null,
        },
        'server exposes successful client certificate verification',
      );
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await anonymousClient.close();
      await certifiedClient.close();
      await server.close();
    }
  });
  it('requests optional client certificates without rejecting anonymous clients', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        clientAuth: 'request',
        ca: { file: TEST_CERT },
      }),
    );
    const anonymousClient = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const acceptedAnonymous = server.accept();
      const anonymousConnection = await anonymousClient.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: false,
      });
      const anonymousServerConnection = await acceptedAnonymous;
      await waitForHandshakeComplete(anonymousServerConnection);
      t.equal(
        anonymousConnection.handshakeComplete,
        true,
        'anonymous client completes optional mTLS handshake',
      );
      t.equal(
        anonymousServerConnection.peerCertificate,
        null,
        'server exposes no peer cert for anonymous optional mTLS client',
      );
      t.deepEqual(
        anonymousServerConnection.peerVerification,
        {
          verified: true,
          errorCode: 0,
          reason: null,
        },
        'server verification remains successful when optional client cert is absent',
      );
      await anonymousConnection.close();
      await anonymousServerConnection.close();
    } finally {
      await anonymousClient.close();
      await server.close();
    }
  });
  it('completes mTLS handshake and surfaces peer cert when rejectUnauthorized is false', async (t) => {
    if (!quicAvailable) return;
    // Server has verifyClient + no CA — presented certs will always fail verification.
    // With rejectUnauthorized: false the permissive callback allows the handshake to
    // complete so the server can inspect the cert rather than hard-failing.
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        verifyClient: true,
        rejectUnauthorized: false,
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: false,
        certificateFile: TEST_CERT,
        privateKeyFile: TEST_KEY,
      });
      const serverConnection = await accepted;
      t.equal(
        clientConnection.handshakeComplete,
        true,
        'client completes mTLS handshake even when its cert fails server CA verification',
      );
      t.ok(
        serverConnection.peerCertificate instanceof Uint8Array,
        'server exposes peer certificate DER bytes even when cert is unverified',
      );
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('selects per-SNI server TLS contexts with wildcard matching', async (t) => {
    if (!quicAvailable) return;
    const events: any[] = [];
    const subscription = topic<any>('quic.session.handshake').subscribe((event) =>
      events.push(event),
    );
    const server = new QuicEndpoint({ alpnProtocols: ['fino-default'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        sni: {
          '*.example.test': {
            certificateFile: TEST_CERT,
            privateKeyFile: TEST_KEY,
            alpnProtocols: ['fino-sni'],
          },
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-sni'] });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        serverName: 'api.example.test',
        verifyPeer: false,
      });
      const serverConnection = await accepted;
      t.equal(
        clientConnection.alpnProtocol,
        'fino-sni',
        'client negotiates ALPN from the SNI context',
      );
      t.equal(
        serverConnection.alpnProtocol,
        'fino-sni',
        'server negotiates ALPN from the SNI context',
      );
      t.ok(
        events.some(
          (event) =>
            event.connection === serverConnection && event.servername === 'api.example.test',
        ),
        'server handshake topic reports the requested SNI name',
      );
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      subscription.dispose();
      await client.close();
      await server.close();
    }
  });
  it('runtime setSNIContexts updates per-SNI cert for new handshakes', async (t) => {
    if (!quicAvailable || cryptoBackend !== 'ossl') return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-default'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        sni: {
          '*.example.test': {
            certificateFile: TEST_CERT,
            privateKeyFile: TEST_KEY,
            alpnProtocols: ['fino-sni-v1'],
          },
        },
      }),
    );
    t.deepEqual(
      Object.keys(listener.getSNIContexts()),
      ['*.example.test'],
      'getSNIContexts returns initial SNI names',
    );
    listener.setSNIContexts({
      '*.example.test': {
        certificateFile: TEST_CERT,
        privateKeyFile: TEST_KEY,
        alpnProtocols: ['fino-sni-v2'],
      },
    });
    t.deepEqual(
      Object.keys(listener.getSNIContexts()),
      ['*.example.test'],
      'getSNIContexts reflects updated SNI names',
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-sni-v2'] });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        serverName: 'api.example.test',
        verifyPeer: false,
      });
      const serverConnection = await accepted;
      t.equal(
        clientConnection.alpnProtocol,
        'fino-sni-v2',
        'client negotiates ALPN from the updated SNI context',
      );
      t.equal(
        serverConnection.alpnProtocol,
        'fino-sni-v2',
        'server uses the updated SNI context for new handshakes',
      );
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('negotiates QUIC TLS with configured supported groups', async (t) => {
    if (!quicAvailable || cryptoBackend !== 'ossl') return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      tlsGroups: ['X25519'],
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        tlsGroups: ['X25519'],
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      tlsGroups: ['X25519'],
    });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        tlsGroups: ['X25519'],
      });
      const serverConnection = await accepted;
      await clientConnection.connected;
      await serverConnection.connected;
      t.equal(
        clientConnection.alpnProtocol,
        'fino-hq',
        'client completes TLS handshake with constrained group',
      );
      t.equal(
        serverConnection.alpnProtocol,
        'fino-hq',
        'server completes TLS handshake with constrained group',
      );
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
    const bad = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      await t.rejects(
        () =>
          bad.listen(
            testListenOptions({
              address: {
                family: 'ipv4',
                ip: '127.0.0.1',
                port: 0,
              },
              tlsGroups: ['not-a-real-tls-group'],
            }),
          ),
        /groups_list|group/i,
        'invalid OpenSSL group names fail during TLS context creation',
      );
    } finally {
      await bad.close();
    }
  });
  it('negotiates h3 ALPN over raw QUIC streams without HTTP integration', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['h3'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        alpnProtocols: ['h3'],
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['h3'] });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        alpnProtocols: ['h3'],
      });
      const serverConnection = await accepted;
      const clientStream = await clientConnection.openBidirectionalStream();
      const serverStreamPromise = serverConnection.acceptStream();
      await clientStream.writer.write(encodeUtf8('raw-h3-alpn'));
      await clientStream.writer.close();
      const serverStream = await serverStreamPromise;
      const request = await readBytes(serverStream.reader.read());
      await serverStream.writer.write(encodeUtf8(`echo:${decodeUtf8(request!)}`));
      await serverStream.writer.close();
      t.equal(clientConnection.alpnProtocol, 'h3', 'client negotiated h3 ALPN');
      t.equal(serverConnection.alpnProtocol, 'h3', 'server negotiated h3 ALPN');
      t.equal(
        decodeUtf8((await readBytes(clientStream.reader.read()))!),
        'echo:raw-h3-alpn',
        'h3 ALPN still exposes raw QUIC streams',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('routes simultaneous connections for multiple listeners on one endpoint', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listenerA = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const listenerB = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const clientA = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientB = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const acceptA = server.accept();
      const clientConnectionA = await clientA.connect({ address: listenerA.address });
      const serverConnectionA = await acceptA;
      const acceptB = server.accept();
      const clientConnectionB = await clientB.connect({ address: listenerB.address });
      const serverConnectionB = await acceptB;
      t.equal(
        serverConnectionA.localAddress.port,
        listenerA.address.port,
        'first accepted connection stays on listener A',
      );
      t.equal(
        serverConnectionB.localAddress.port,
        listenerB.address.port,
        'second accepted connection stays on listener B',
      );
      const clientStreamA = await clientConnectionA.openBidirectionalStream();
      const clientStreamB = await clientConnectionB.openBidirectionalStream();
      await clientStreamA.writer.write(encodeUtf8('listener-a'));
      await clientStreamA.writer.close();
      await clientStreamB.writer.write(encodeUtf8('listener-b'));
      await clientStreamB.writer.close();
      const serverStreamA = await serverConnectionA.acceptStream();
      const serverStreamB = await serverConnectionB.acceptStream();
      t.equal(
        decodeUtf8((await readBytes(serverStreamA.reader.read()))!),
        'listener-a',
        'listener A receives its client stream',
      );
      t.equal(
        decodeUtf8((await readBytes(serverStreamB.reader.read()))!),
        'listener-b',
        'listener B receives its client stream',
      );
    } finally {
      await clientA.close();
      await clientB.close();
      await server.close();
    }
  });
  it('returns resumed early-data connections before handshake completion', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024 * 1024,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024 * 1024,
        },
      }),
    );
    const warmupClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024 * 1024,
      },
    });
    let warmupConnection: any = null;
    let serverConnection: any = null;
    try {
      warmupConnection = await warmupClient.connect({
        address: listener.address,
        serverName: 'localhost',
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024 * 1024,
        },
      });
      serverConnection = await server.accept();
      if (cryptoBackend === 'gnutls')
        await waitForStoredSessionTicket(sessions, 'localhost|fino-hq');
    } finally {
      await warmupConnection?.close();
      await serverConnection?.close();
      await warmupClient.close();
    }
    const warmupState = sessions.get('localhost|fino-hq');
    t.ok(warmupState?.ticket instanceof Uint8Array, 'warmup connection persisted a session ticket');
    t.ok(
      warmupState?.transportParameters instanceof Uint8Array,
      'warmup persisted 0-RTT transport parameters',
    );
    t.equal(
      warmupState?.earlyDataMax,
      1024 * 1024,
      'warmup persisted the replay-safe 0-RTT byte limit',
    );
    const earlyClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024 * 1024,
      },
    });
    const connectPromise = earlyClient.connect({
      address: listener.address,
      serverName: 'localhost',
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024 * 1024,
      },
    });
    try {
      const connection = await withTimeoutValue(connectPromise, 150, null);
      if (connection === null) throw new Error('resumed 0-RTT connect waited for handshake');
      t.equal(
        connection.handshakeComplete,
        false,
        '0-RTT connection is returned before handshake completion',
      );
      const earlyDataEvent = await withTimeoutValue(
        new Promise<any>((resolve) =>
          connection.addEventListener('earlydata', resolve, { once: true }),
        ),
        250,
        null,
      );
      t.ok(
        earlyDataEvent instanceof QuicEarlyDataEvent,
        '0-RTT readiness emits typed earlydata event',
      );
      t.equal(earlyDataEvent?.accepted, true, '0-RTT event marks early data accepted');
      t.equal(earlyDataEvent?.rejected, false, '0-RTT event does not mark early data rejected');
      t.equal(earlyDataEvent?.reason, 'accepted', '0-RTT event exposes acceptance reason');
      const stream = await connection.openBidirectionalStream();
      t.ok(
        stream instanceof QuicStream,
        'early-data connection can open a stream before handshake completion',
      );
    } finally {
      await earlyClient.close();
      await server.close();
    }
  });
  it('enforces the configured 0-RTT byte limit before handshake completion', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 16,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 16,
        },
      }),
    );
    const warmupClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 16,
      },
    });
    let warmupConnection: any = null;
    let warmupServerConnection: any = null;
    try {
      warmupConnection = await warmupClient.connect({
        address: listener.address,
        serverName: 'localhost',
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 16,
        },
      });
      warmupServerConnection = await server.accept();
      if (cryptoBackend === 'gnutls')
        await waitForStoredSessionTicket(sessions, 'localhost|fino-hq');
    } finally {
      await warmupConnection?.close();
      await warmupServerConnection?.close();
      await warmupClient.close();
    }
    const earlyClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 16,
      },
    });
    try {
      const connection = await withTimeoutValue(
        earlyClient.connect({
          address: listener.address,
          serverName: 'localhost',
          sessionStore,
          earlyData: {
            replaySafe: true,
            maxBytes: 16,
          },
        }),
        150,
        null,
      );
      if (connection === null) throw new Error('resumed 0-RTT connect waited for handshake');
      const stream = await connection.openBidirectionalStream();
      await t.rejects(
        () => stream.writer.write(encodeUtf8('12345678901234567')),
        /0-RTT write exceeds maxBytes 16/,
        'early stream writes are capped before handshake completion',
      );
    } finally {
      await earlyClient.close();
      await server.close();
    }
  });
  it('sends DATAGRAM frames as 0-RTT data before handshake completion', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 16,
      },
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 16,
        },
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
      }),
    );
    const warmupClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 16,
      },
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    let warmupConnection: any = null;
    let warmupServerConnection: any = null;
    try {
      warmupConnection = await warmupClient.connect({
        address: listener.address,
        serverName: 'localhost',
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 16,
        },
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
      });
      warmupServerConnection = await server.accept();
      if (cryptoBackend === 'gnutls')
        await waitForStoredSessionTicket(sessions, 'localhost|fino-hq');
    } finally {
      await warmupConnection?.close();
      await warmupServerConnection?.close();
      await warmupClient.close();
    }
    const earlyClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 16,
      },
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    try {
      const connection = await withTimeoutValue(
        earlyClient.connect({
          address: listener.address,
          serverName: 'localhost',
          sessionStore,
          earlyData: {
            replaySafe: true,
            maxBytes: 16,
          },
          datagrams: {
            enabled: true,
            maxFrameSize: 1200,
          },
        }),
        150,
        null,
      );
      if (connection === null) throw new Error('resumed 0-RTT connect waited for handshake');
      t.equal(
        connection.handshakeComplete,
        false,
        '0-RTT connection is returned before handshake completion',
      );
      await connection.sendDatagram(encodeUtf8('early-dgram'));
      await t.rejects(
        () => connection.sendDatagram(encodeUtf8('over-limit')),
        /0-RTT write exceeds maxBytes 16/,
        '0-RTT DATAGRAM bytes count against the early-data cap',
      );
      await loop.timeout(0);
      const serverConnection = await server.accept();
      const event = serverConnection[quicConnectionInternals.inspectLastDatagramEvent]();
      if (event === null) throw new Error('server did not receive the 0-RTT DATAGRAM');
      t.equal(event.earlyData, true, 'received DATAGRAM is marked as 0-RTT early data');
      t.equal(decodeUtf8(event.data), 'early-dgram', 'server receives the 0-RTT DATAGRAM payload');
    } finally {
      await earlyClient.close();
      await server.close();
    }
  });
  it('reports rejected early data for incompatible stored transport parameters', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024 * 1024,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024 * 1024,
        },
      }),
    );
    const warmupClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024 * 1024,
      },
    });
    let warmupConnection: any = null;
    let warmupServerConnection: any = null;
    try {
      warmupConnection = await warmupClient.connect({
        address: listener.address,
        serverName: 'localhost',
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024 * 1024,
        },
      });
      warmupServerConnection = await server.accept();
      if (cryptoBackend === 'gnutls')
        await waitForStoredSessionTicket(sessions, 'localhost|fino-hq');
    } finally {
      await warmupConnection?.close();
      await warmupServerConnection?.close();
      await warmupClient.close();
    }
    const state = sessions.get('localhost|fino-hq');
    t.ok(state?.ticket instanceof Uint8Array, 'warmup persisted a session ticket');
    sessions.set('localhost|fino-hq', {
      ...state,
      transportParameters: new Uint8Array([255, 0, 255]),
    });
    const earlyClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024 * 1024,
      },
    });
    try {
      const connection = await earlyClient.connect({
        address: listener.address,
        serverName: 'localhost',
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024 * 1024,
        },
      });
      t.equal(
        connection.handshakeComplete,
        true,
        'incompatible 0-RTT parameters fall back to a full handshake',
      );
      const earlyDataEvent = await withTimeoutValue(
        new Promise<any>((resolve) =>
          connection.addEventListener('earlydata', resolve, { once: true }),
        ),
        250,
        null,
      );
      t.ok(
        earlyDataEvent instanceof QuicEarlyDataEvent,
        '0-RTT fallback emits typed earlydata event',
      );
      t.equal(earlyDataEvent?.accepted, false, '0-RTT fallback is not accepted');
      t.equal(earlyDataEvent?.rejected, true, '0-RTT fallback is reported as rejected');
      t.equal(
        earlyDataEvent?.reason,
        'transport-parameters',
        '0-RTT fallback reports the compatibility reason',
      );
    } finally {
      await earlyClient.close();
      await server.close();
    }
  });
  it('rejects expired and version-mismatched 0-RTT sessions before early writes', async (t) => {
    if (!quicAvailable) return;
    const cases = [
      {
        name: 'expired session',
        reason: 'expired-session',
        versions: undefined,
        state: {
          ticket: new Uint8Array([1, 2, 3]),
          transportParameters: new Uint8Array([0]),
          earlyDataMax: 1024,
          version: 'v2',
          expiresAt: Date.now() - 1e3,
        },
      },
      {
        name: 'version mismatch',
        reason: 'version',
        versions: ['v1'] as const,
        state: {
          ticket: new Uint8Array([4, 5, 6]),
          transportParameters: new Uint8Array([0]),
          earlyDataMax: 1024,
          version: 'v2',
        },
      },
    ];
    for (const testCase of cases) {
      const sessions = new Map<string, any>();
      const sessionStore = memorySessionStore(sessions);
      sessions.set('localhost|fino-hq', testCase.state);
      const server = new QuicEndpoint({
        alpnProtocols: ['fino-hq'],
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024,
        },
      });
      const listener = await server.listen(
        testListenOptions({
          address: {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: 0,
          },
          sessionStore,
          earlyData: {
            replaySafe: true,
            maxBytes: 1024,
          },
        }),
      );
      const client = new QuicEndpoint({
        alpnProtocols: ['fino-hq'],
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024,
        },
        ...(testCase.versions === undefined ? {} : { versions: [...testCase.versions] }),
      });
      try {
        const accepted = server.accept();
        const connection = await client.connect({
          address: listener.address,
          serverName: 'localhost',
          sessionStore,
          earlyData: {
            replaySafe: true,
            maxBytes: 1024,
          },
          ...(testCase.versions === undefined ? {} : { versions: [...testCase.versions] }),
        });
        const serverConnection = await accepted;
        const event = await withTimeoutValue(
          new Promise<any>((resolve) =>
            connection.addEventListener('earlydata', resolve, { once: true }),
          ),
          250,
          null,
        );
        t.equal(
          connection.handshakeComplete,
          true,
          `${testCase.name} falls back to a full handshake`,
        );
        t.ok(
          event instanceof QuicEarlyDataEvent,
          `${testCase.name} emits a typed earlydata rejection`,
        );
        t.equal(event?.accepted, false, `${testCase.name} does not enable early writes`);
        t.equal(event?.rejected, true, `${testCase.name} is reported as rejected`);
        t.equal(
          event?.reason,
          testCase.reason,
          `${testCase.name} reports the compatibility reason`,
        );
        await serverConnection.close();
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
  it('does not reuse 0-RTT sessions across ALPN session keys', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const loadedKeys: string[] = [];
    const sessionStore = {
      load(key: string) {
        loadedKeys.push(key);
        return sessions.get(key) ?? null;
      },
      save(key: string, state: any) {
        sessions.set(key, state);
      },
      delete(key: string) {
        sessions.delete(key);
      },
    };
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq', 'other-proto'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024,
        },
      }),
    );
    const warmupClient = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024,
      },
    });
    let warmupConnection: any = null;
    let warmupServerConnection: any = null;
    try {
      warmupConnection = await warmupClient.connect({
        address: listener.address,
        serverName: 'localhost',
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024,
        },
      });
      warmupServerConnection = await server.accept();
      if (cryptoBackend === 'gnutls')
        await waitForStoredSessionTicket(sessions, 'localhost|fino-hq');
    } finally {
      await warmupConnection?.close();
      await warmupServerConnection?.close();
      await warmupClient.close();
    }
    t.ok(sessions.has('localhost|fino-hq'), 'warmup stores the fino-hq session');
    t.equal(
      sessions.has('localhost|other-proto'),
      false,
      'warmup does not create an other-proto session',
    );
    loadedKeys.length = 0;
    const otherClient = new QuicEndpoint({
      alpnProtocols: ['other-proto'],
      sessionStore,
      earlyData: {
        replaySafe: true,
        maxBytes: 1024,
      },
    });
    try {
      const accepted = server.accept();
      const connection = await otherClient.connect({
        address: listener.address,
        serverName: 'localhost',
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024,
        },
      });
      const serverConnection = await accepted;
      const earlyDataEvent = await withTimeoutValue(
        new Promise<any>((resolve) =>
          connection.addEventListener('earlydata', resolve, { once: true }),
        ),
        100,
        null,
      );
      t.ok(loadedKeys.length >= 1, '0-RTT lookup checks the offered ALPN session key');
      t.equal(
        loadedKeys.every((key) => key === 'localhost|other-proto'),
        true,
        '0-RTT lookup never consults the mismatched fino-hq session key',
      );
      t.equal(
        connection.alpnProtocol,
        'other-proto',
        'connection negotiates the different ALPN with a full handshake',
      );
      t.equal(
        connection.handshakeComplete,
        true,
        'ALPN-mismatched session state is not used for early return',
      );
      t.equal(
        earlyDataEvent,
        null,
        'no earlydata event is emitted because no matching ALPN session was attempted',
      );
      await serverConnection.close();
    } finally {
      await otherClient.close();
      await server.close();
    }
  });
  it('persists received NEW_TOKEN address-validation tokens with session state', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: { enabled: false },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      sessionStore,
    });
    const token = new Uint8Array([1, 2, 3, 4, 5]);
    try {
      const clientConnection = await client.connect({
        address: listener.address,
        serverName: 'localhost',
        sessionStore,
      });
      await server.accept();
      await loop.timeout(20);
      let sessionTicketEvents = 0;
      const newTokenEvents: any[] = [];
      const topicEvents: any[] = [];
      clientConnection.addEventListener('sessionticket', () => {
        sessionTicketEvents++;
      });
      clientConnection.addEventListener('newtoken', (event) => newTokenEvents.push(event));
      const topicHandle = topic<any>('quic.session.new.token').subscribe((event) =>
        topicEvents.push(event),
      );
      clientConnection[quicConnectionInternals.onNewToken](token);
      await loop.timeout(0);
      topicHandle.dispose();
      const state = sessions.get('localhost|fino-hq');
      t.ok(state?.addressToken instanceof Uint8Array, 'NEW_TOKEN is persisted in session state');
      t.deepEqual(
        Array.from(state.addressToken),
        Array.from(token),
        'persisted address token matches received token',
      );
      t.equal(sessionTicketEvents, 0, 'NEW_TOKEN does not emit TLS sessionticket events');
      t.equal(newTokenEvents.length, 1, 'NEW_TOKEN emits a distinct newtoken event');
      t.ok(
        newTokenEvents[0] instanceof QuicNewTokenEvent,
        'newtoken event has a typed event class',
      );
      t.deepEqual(
        Array.from(newTokenEvents[0].token),
        Array.from(token),
        'newtoken event exposes the received token',
      );
      t.deepEqual(
        newTokenEvents[0].address,
        listener.address,
        'newtoken event exposes the peer address',
      );
      t.equal(topicEvents.length, 1, 'NEW_TOKEN publishes the Fino quic.session.new.token topic');
      t.equal(
        topicEvents[0].connection,
        clientConnection,
        'NEW_TOKEN topic includes the connection',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('publishes Node-aligned QUIC transport lifecycle topics through Fino topics', async (t) => {
    if (!quicAvailable) return;
    const events: Array<{
      name: string;
      event: any;
    }> = [];
    const subscriptions = [
      'quic.endpoint.created',
      'quic.endpoint.listen',
      'quic.endpoint.connect',
      'quic.endpoint.closing',
      'quic.endpoint.closed',
      'quic.endpoint.error',
      'quic.endpoint.busy.change',
      'quic.session.created.client',
      'quic.session.created.server',
      'quic.session.handshake',
      'quic.session.update.key',
      'quic.session.closing',
      'quic.session.closed',
      'quic.session.error',
      'quic.session.early.rejected',
      'quic.session.open.stream',
      'quic.session.received.stream',
      'quic.session.send.datagram',
      'quic.session.receive.datagram',
      'quic.session.version.negotiation',
      'quic.session.path.validation',
      'quic.session.ticket',
      'quic.session.new.token',
      'quic.session.receive.datagram.status',
      'quic.stream.reset',
      'quic.stream.closed',
    ].map((name) =>
      topic<any>(name).subscribe((event) =>
        events.push({
          name,
          event,
        }),
      ),
    );
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    try {
      server.setBusy(true);
      server.setBusy(false);
      const streamConnection = streamConnectionStub();
      const stream = new QuicStream(0, 'bidirectional', streamConnection);
      const streamCloseError = new Error('topic stream close failure');
      stream[quicStreamInternals.closeFromConnection](streamCloseError);
      const listener = await server.listen(
        testListenOptions({
          address: {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: 0,
          },
        }),
      );
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const clientStream = await clientConnection.openBidirectionalStream();
      await clientStream.writer.write(encodeUtf8('topic-stream'));
      await clientStream.writer.close();
      const serverStream = await serverConnection.acceptStream();
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'topic-stream',
        'topic test stream transfers data',
      );
      const reader = serverConnection.datagramReadable.getReader();
      await clientConnection.sendDatagram(encodeUtf8('topic-datagram'));
      t.equal(
        decodeUtf8((await reader.read()).value),
        'topic-datagram',
        'topic test DATAGRAM transfers data',
      );
      await reader.cancel();
      clientConnection[quicConnectionInternals.onSessionTicket](new Uint8Array([9]));
      clientConnection[quicConnectionInternals.onDatagramStatus](7, 'ack');
      clientConnection[quicConnectionInternals.onNewToken](new Uint8Array([3, 4, 5]));
      clientConnection[quicConnectionInternals.onEarlyDataRejected]();
      clientConnection[quicConnectionInternals.onPathValidationFinished](
        null,
        null,
        NGTCP2_PATH_VALIDATION_RESULT_SUCCESS,
        0,
      );
      serverStream[quicStreamInternals.resetFromConnection](42);
      clientConnection.initiateKeyUpdate();
      await loop.timeout(0);
      const saw = (name: string, predicate: (event: any) => boolean = () => true) =>
        events.some((event) => event.name === name && predicate(event.event));
      t.ok(
        saw(
          'quic.endpoint.created',
          (event) => event.endpoint === server || event.endpoint === client,
        ),
        'endpoint creation publishes a topic',
      );
      t.ok(
        saw(
          'quic.endpoint.listen',
          (event) => event.endpoint === server && event.listener === listener,
        ),
        'endpoint listen publishes a topic',
      );
      t.ok(
        saw(
          'quic.endpoint.connect',
          (event) => event.endpoint === client && event.connection === clientConnection,
        ),
        'endpoint connect publishes a topic',
      );
      t.ok(
        saw(
          'quic.endpoint.busy.change',
          (event) => event.endpoint === server && event.busy === true,
        ),
        'busy changes publish an endpoint topic',
      );
      t.ok(
        saw(
          'quic.session.created.client',
          (event) => event.endpoint === client && event.connection === clientConnection,
        ),
        'client connection creation publishes a topic',
      );
      t.ok(
        saw(
          'quic.session.created.server',
          (event) => event.endpoint === server && event.connection === serverConnection,
        ),
        'server connection creation publishes a topic',
      );
      t.ok(
        saw(
          'quic.session.handshake',
          (event) =>
            (event.connection === clientConnection || event.connection === serverConnection) &&
            event.protocol === event.alpnProtocol &&
            typeof event.protocol === 'string' &&
            'servername' in event &&
            'cipher' in event &&
            'cipherVersion' in event &&
            'validationErrorReason' in event &&
            'validationErrorCode' in event &&
            typeof event.earlyDataAttempted === 'boolean' &&
            typeof event.earlyDataAccepted === 'boolean',
        ),
        'handshake topic includes Node-aligned TLS metadata fields',
      );
      t.ok(
        saw(
          'quic.session.open.stream',
          (event) => event.connection === clientConnection && event.stream === clientStream,
        ),
        'local stream open publishes a topic',
      );
      t.ok(
        saw(
          'quic.session.received.stream',
          (event) => event.connection === serverConnection && event.stream === serverStream,
        ),
        'received stream publishes a topic',
      );
      t.ok(
        saw(
          'quic.session.send.datagram',
          (event) =>
            event.connection === clientConnection && event.length === 'topic-datagram'.length,
        ),
        'DATAGRAM send publishes a topic',
      );
      t.ok(
        saw(
          'quic.session.receive.datagram',
          (event) =>
            event.connection === serverConnection && event.length === 'topic-datagram'.length,
        ),
        'DATAGRAM receive publishes a topic',
      );
      clientConnection[quicConnectionInternals.onVersionNegotiationForTest](
        1,
        [1, 1889161412],
        [1, 1889161412],
      );
      t.ok(
        saw(
          'quic.session.version.negotiation',
          (event) =>
            event.connection === clientConnection &&
            event.wireVersion === 1 &&
            event.requestedWireVersions?.includes(1889161412),
        ),
        'received Version Negotiation publishes a session topic',
      );
      t.ok(
        saw(
          'quic.session.path.validation',
          (event) => event.connection === clientConnection && event.result === 'success',
        ),
        'path validation publishes a topic',
      );
      t.ok(
        saw('quic.session.update.key', (event) => event.connection === clientConnection),
        'key update publishes a topic',
      );
      t.ok(
        saw(
          'quic.stream.closed',
          (event) =>
            event.stream === stream &&
            event.connection === streamConnection &&
            event.error === streamCloseError &&
            event.stats?.destroyedAt !== null,
        ),
        'stream close topic includes owner connection, close error, and stats',
      );
      t.ok(
        saw(
          'quic.stream.reset',
          (event) =>
            event.stream === serverStream &&
            event.connection === serverConnection &&
            event.errorCode === 42 &&
            event.error instanceof Error,
        ),
        'stream reset topic includes owner connection, error object, and application code',
      );
      t.ok(
        events.some(
          ({ name, event }) =>
            name === 'quic.session.ticket' &&
            event.connection === clientConnection &&
            event.ticket?.[0] === 9,
        ),
        'session ticket topic payload is observable',
      );
      t.ok(
        saw(
          'quic.session.new.token',
          (event) => event.connection === clientConnection && event.token?.[0] === 3,
        ),
        'NEW_TOKEN topic payload is observable',
      );
      t.ok(
        events.some(
          ({ name, event }) =>
            name === 'quic.session.receive.datagram.status' &&
            event.connection === clientConnection &&
            event.id === 7 &&
            event.status === 'ack',
        ),
        'datagram status topic payload is observable',
      );
      t.ok(
        saw('quic.session.early.rejected', (event) => event.connection === clientConnection),
        'early-data rejection publishes a topic',
      );
      clientConnection[quicConnectionInternals.onStatelessReset]();
      await loop.timeout(0);
      t.ok(
        saw(
          'quic.session.error',
          (event) =>
            event.connection === clientConnection && /stateless reset/.test(event.error?.message),
        ),
        'session error publishes a topic',
      );
      t.ok(
        saw(
          'quic.endpoint.error',
          (event) => event.endpoint === client && event.connection === clientConnection,
        ),
        'endpoint error publishes a topic',
      );
      await serverConnection.close();
      await client.close();
      await server.close();
      t.ok(
        saw(
          'quic.session.closing',
          (event) => event.connection === clientConnection || event.connection === serverConnection,
        ),
        'session close start publishes a topic',
      );
      t.ok(
        saw(
          'quic.session.closed',
          (event) =>
            event.connection === serverConnection &&
            event.error === undefined &&
            event.stats?.destroyedAt !== null,
        ),
        'graceful session close topic includes stats and no error',
      );
      t.ok(
        saw(
          'quic.session.closed',
          (event) =>
            event.connection === clientConnection &&
            /stateless reset/.test(event.error?.message) &&
            event.stats?.destroyedAt !== null,
        ),
        'failed session close topic includes the close error and stats',
      );
      t.ok(
        saw(
          'quic.endpoint.closing',
          (event) => event.endpoint === client || event.endpoint === server,
        ),
        'endpoint close start publishes a topic',
      );
      t.ok(
        saw(
          'quic.endpoint.closed',
          (event) => event.endpoint === client || event.endpoint === server,
        ),
        'endpoint close finish publishes a topic',
      );
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      await client.close();
      await server.close();
    }
  });
  it('isolates QUIC EventTarget listener errors as an intentional Node callback divergence', async (t) => {
    const stream = new QuicStream(0, 'bidirectional', streamConnectionStub());
    let secondListenerCalled = false;
    stream.addEventListener('close', () => {
      throw new Error('listener failure');
    });
    stream.addEventListener('close', () => {
      secondListenerCalled = true;
    });
    stream[quicStreamInternals.closeFromConnection]();
    await loop.timeout(0);
    t.equal(
      secondListenerCalled,
      true,
      'throwing QUIC EventTarget listeners do not interrupt later listeners',
    );
  });
  it('advertises peer active migration while keeping local migration API gated', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const clientParams = ngtcp2Sym!.ngtcp2_conn_get_local_transport_params(
        clientConnection.nativeHandle,
      ) as ArrayBuffer | null;
      const serverParams = ngtcp2Sym!.ngtcp2_conn_get_local_transport_params(
        serverConnection.nativeHandle,
      ) as ArrayBuffer | null;
      t.equal(
        Pointer.readU8(clientParams!, TP_DISABLE_ACTIVE_MIGRATION),
        0,
        'client does not forbid peer migration by default',
      );
      t.equal(
        Pointer.readU8(serverParams!, TP_DISABLE_ACTIVE_MIGRATION),
        0,
        'server does not forbid peer migration by default',
      );
      await t.rejects(
        () =>
          clientConnection.migrate({
            family: 'ipv4',
            ip: '0.0.0.0',
            port: 0,
          }),
        /migration is not enabled/,
        'local active migration API remains explicitly gated',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('exposes local and remote transport parameter snapshots after handshake', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      t.equal(
        Object.isFrozen(clientConnection.localTransportParameters),
        true,
        'local snapshot is frozen',
      );
      t.equal(
        Object.isFrozen(clientConnection.remoteTransportParameters),
        true,
        'remote snapshot is frozen',
      );
      t.equal(
        clientConnection.localTransportParameters.maxDatagramFrameSize,
        1200,
        'client local DATAGRAM parameter is exposed',
      );
      t.equal(
        clientConnection.remoteTransportParameters.maxDatagramFrameSize,
        1200,
        'client sees server DATAGRAM parameter',
      );
      t.equal(
        serverConnection.remoteTransportParameters.maxDatagramFrameSize,
        1200,
        'server sees client DATAGRAM parameter',
      );
      t.equal(
        clientConnection.localTransportParameters.disableActiveMigration,
        false,
        'migration disablement is exposed',
      );
      t.equal(
        clientConnection.remoteTransportParameters.activeConnectionIdLimit,
        2,
        'active CID limit is exposed',
      );
      t.ok(
        clientConnection.localTransportParameters.initialMaxData > 0,
        'initial max data is exposed',
      );
      t.ok(
        clientConnection.localTransportParameters.initialSourceConnectionId instanceof Uint8Array,
        'local initial SCID is exposed',
      );
      t.ok(
        clientConnection.remoteTransportParameters.initialSourceConnectionId instanceof Uint8Array,
        'remote initial SCID is exposed',
      );
      t.ok(
        serverConnection.remoteTransportParameters.initialSourceConnectionId instanceof Uint8Array,
        'server sees client initial SCID',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('advertises configured transport parameters to the peer', async (t) => {
    if (!quicAvailable) return;
    const serverConnectionOptions = {
      maxIdleTimeoutMs: 1750,
      initialMaxData: 333333,
      initialMaxStreamDataBidiLocal: 44444,
      initialMaxStreamDataBidiRemote: 55555,
      initialMaxStreamDataUni: 66666,
      initialMaxStreamsBidi: 7,
      initialMaxStreamsUni: 5,
      activeConnectionIdLimit: 12,
      maxAckDelayMs: 17,
      ackDelayExponent: 4,
      disableActiveMigration: true,
    };
    const clientConnectionOptions = {
      maxIdleTimeoutMs: 2500,
      initialMaxData: 222222,
      initialMaxStreamDataBidiLocal: 11111,
      initialMaxStreamDataBidiRemote: 22222,
      initialMaxStreamDataUni: 33333,
      initialMaxStreamsBidi: 4,
      initialMaxStreamsUni: 2,
      activeConnectionIdLimit: 1,
      maxAckDelayMs: 11,
      ackDelayExponent: 2,
      disableActiveMigration: true,
    };
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: serverConnectionOptions,
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: clientConnectionOptions,
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      t.equal(
        clientConnection.remoteTransportParameters.maxIdleTimeoutMs,
        1750,
        'client sees configured server idle timeout',
      );
      t.equal(
        clientConnection.remoteTransportParameters.initialMaxData,
        333333,
        'client sees configured server connection credit',
      );
      t.equal(
        clientConnection.remoteTransportParameters.initialMaxStreamDataBidiLocal,
        44444,
        'client sees configured server bidi local stream credit',
      );
      t.equal(
        clientConnection.remoteTransportParameters.initialMaxStreamDataBidiRemote,
        55555,
        'client sees configured server bidi remote stream credit',
      );
      t.equal(
        clientConnection.remoteTransportParameters.initialMaxStreamDataUni,
        66666,
        'client sees configured server uni stream credit',
      );
      t.equal(
        clientConnection.remoteTransportParameters.initialMaxStreamsBidi,
        7,
        'client sees configured server bidi stream limit',
      );
      t.equal(
        clientConnection.remoteTransportParameters.initialMaxStreamsUni,
        5,
        'client sees configured server uni stream limit',
      );
      t.equal(
        clientConnection.remoteTransportParameters.activeConnectionIdLimit,
        8,
        'server active CID limit is clamped to ngtcp2-safe maximum',
      );
      t.equal(
        clientConnection.remoteTransportParameters.maxAckDelayMs,
        17,
        'client sees configured server max ACK delay',
      );
      t.equal(
        clientConnection.remoteTransportParameters.ackDelayExponent,
        4,
        'client sees configured server ACK delay exponent',
      );
      t.equal(
        clientConnection.remoteTransportParameters.disableActiveMigration,
        true,
        'client sees server disable-active-migration advertisement',
      );
      t.equal(
        serverConnection.remoteTransportParameters.maxIdleTimeoutMs,
        2500,
        'server sees configured client idle timeout',
      );
      t.equal(
        serverConnection.remoteTransportParameters.initialMaxData,
        222222,
        'server sees configured client connection credit',
      );
      t.equal(
        serverConnection.remoteTransportParameters.initialMaxStreamsBidi,
        4,
        'server sees configured client bidi stream limit',
      );
      t.equal(
        serverConnection.remoteTransportParameters.initialMaxStreamsUni,
        2,
        'server sees configured client uni stream limit',
      );
      t.equal(
        serverConnection.remoteTransportParameters.activeConnectionIdLimit,
        2,
        'client active CID limit is clamped to protocol minimum',
      );
      t.equal(
        serverConnection.remoteTransportParameters.disableActiveMigration,
        true,
        'server sees client disable-active-migration advertisement',
      );
      const serverParams = ngtcp2Sym!.ngtcp2_conn_get_local_transport_params(
        serverConnection.nativeHandle,
      ) as ArrayBuffer | null;
      if (serverParams === null) throw new Error('server transport parameters were not available');
      t.equal(
        Number(Pointer.readU64(serverParams, TP_INITIAL_MAX_DATA)),
        333333,
        'native server params carry configured connection credit',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL)),
        44444,
        'native server params carry configured bidi local credit',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE)),
        55555,
        'native server params carry configured bidi remote credit',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_INITIAL_MAX_STREAM_DATA_UNI)),
        66666,
        'native server params carry configured uni credit',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_INITIAL_MAX_STREAMS_BIDI)),
        7,
        'native server params carry configured bidi stream count',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_INITIAL_MAX_STREAMS_UNI)),
        5,
        'native server params carry configured uni stream count',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_MAX_IDLE_TIMEOUT) / 1000000n),
        1750,
        'native server params carry configured idle timeout',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_ACTIVE_CONNECTION_ID_LIMIT)),
        8,
        'native server params carry clamped CID limit',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_MAX_ACK_DELAY) / 1000000n),
        17,
        'native server params carry configured max ACK delay',
      );
      t.equal(
        Number(Pointer.readU64(serverParams, TP_ACK_DELAY_EXPONENT)),
        4,
        'native server params carry configured ACK delay exponent',
      );
      t.equal(
        Pointer.readU8(serverParams, TP_DISABLE_ACTIVE_MIGRATION),
        1,
        'native server params carry disable-active-migration flag',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('uses configured connection ID lengths for local CIDs', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: { cidLength: 12 },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: { cidLength: 12 },
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      t.equal(client.connection.cidLength, 12, 'client exposes resolved CID length');
      t.equal(server.connection.cidLength, 12, 'server exposes resolved CID length');
      t.equal(
        currentDestinationCidHex(clientConnection).length,
        24,
        'client uses the server 12-byte CID',
      );
      t.equal(
        currentDestinationCidHex(serverConnection).length,
        24,
        'server uses the client 12-byte CID',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('derives preferred-address stateless reset tokens from the listener reset secret', async (t) => {
    if (!quicAvailable) return;
    const tokenSecret = new Uint8Array(32);
    for (let i = 0; i < tokenSecret.byteLength; i++) tokenSecret[i] = i + 1;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        retry: {
          enabled: true,
          tokenSecret,
        },
        migration: {
          enabled: true,
          preferredAddress: {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: 0,
          },
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const params = ngtcp2Sym!.ngtcp2_conn_get_local_transport_params(
        serverConnection.nativeHandle,
      ) as ArrayBuffer | null;
      t.equal(
        Pointer.readU8(params!, TP_PREFERRED_ADDR_PRESENT),
        1,
        'server advertises a preferred address',
      );
      const cidStruct = sliceBytes(
        copyNativeBytes(params!, TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_CID, NGTCP2_CID_SIZE),
      );
      const expected = new Uint8Array(16);
      const rc = cryptoSym!.ngtcp2_crypto_generate_stateless_reset_token(
        expected,
        tokenSecret,
        tokenSecret.byteLength,
        Pointer.of(cidStruct),
      ) as number;
      t.equal(rc, 0, 'test can derive the preferred-address reset token');
      const actual = copyNativeBytes(
        params!,
        TP_PREFERRED_ADDR + TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN,
        16,
      );
      t.deepEqual(
        Array.from(actual),
        Array.from(expected),
        'preferred-address reset token is derived from the listener secret and CID',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('surfaces NEW_TOKEN requests on path-validation events', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      await server.accept();
      const pathValidation = new Promise<any>((resolve) => {
        clientConnection.addEventListener('pathvalidation', resolve, { once: true });
      });
      clientConnection[quicConnectionInternals.onPathValidationFinished](
        null,
        null,
        NGTCP2_PATH_VALIDATION_RESULT_SUCCESS,
        NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN,
      );
      const event = await pathValidation;
      t.equal(event.result, 'success', 'path validation result is surfaced');
      t.equal(event.newToken, true, 'path validation exposes NEW_TOKEN generation requests');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('encodes RFC-required transport parameter invariants', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const clientParams = ngtcp2Sym!.ngtcp2_conn_get_local_transport_params(
        clientConnection.nativeHandle,
      ) as ArrayBuffer | null;
      const serverParams = ngtcp2Sym!.ngtcp2_conn_get_local_transport_params(
        serverConnection.nativeHandle,
      ) as ArrayBuffer | null;
      if (clientParams === null || serverParams === null)
        throw new Error('transport parameters were not available');
      t.equal(
        Pointer.readU64(clientParams, TP_MAX_UDP_PAYLOAD_SIZE),
        65527n,
        'client advertises a max UDP payload size above the RFC minimum',
      );
      t.equal(
        Pointer.readU64(serverParams, TP_MAX_UDP_PAYLOAD_SIZE),
        65527n,
        'server advertises a max UDP payload size above the RFC minimum',
      );
      t.ok(
        Pointer.readU64(clientParams, TP_ACTIVE_CONNECTION_ID_LIMIT) >= 2n,
        'client active_connection_id_limit is at least 2',
      );
      t.ok(
        Pointer.readU64(serverParams, TP_ACTIVE_CONNECTION_ID_LIMIT) >= 2n,
        'server active_connection_id_limit is at least 2',
      );
      t.equal(
        Pointer.readU64(clientParams, TP_ACK_DELAY_EXPONENT),
        3n,
        'client ack_delay_exponent is encoded',
      );
      t.equal(
        Pointer.readU64(serverParams, TP_ACK_DELAY_EXPONENT),
        3n,
        'server ack_delay_exponent is encoded',
      );
      t.equal(
        Pointer.readU64(clientParams, TP_MAX_ACK_DELAY),
        25000000n,
        'client max_ack_delay is encoded in nanoseconds',
      );
      t.equal(
        Pointer.readU64(serverParams, TP_MAX_ACK_DELAY),
        25000000n,
        'server max_ack_delay is encoded in nanoseconds',
      );
      t.equal(
        Pointer.readU64(clientParams, TP_MAX_DATAGRAM_FRAME_SIZE),
        1200n,
        'client advertises DATAGRAM max frame size',
      );
      t.equal(
        Pointer.readU64(serverParams, TP_MAX_DATAGRAM_FRAME_SIZE),
        1200n,
        'server advertises DATAGRAM max frame size',
      );
      t.equal(
        Pointer.readU8(clientParams, TP_STATELESS_RESET_TOKEN_PRESENT),
        0,
        'client does not send the server-only stateless_reset_token parameter',
      );
      t.equal(
        Pointer.readU8(serverParams, TP_STATELESS_RESET_TOKEN_PRESENT),
        1,
        'server sends a stateless_reset_token parameter',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('writes qlog output when qlog path is configured', async (t) => {
    if (!quicAvailable) return;
    const fs = new DiskFileSystem();
    const qlogPath = `/tmp/fino-quic-qlog-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlog`;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      qlog: { path: qlogPath },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        qlog: { path: qlogPath },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const stream = await clientConnection.openBidirectionalStream();
      await stream.writer.write(encodeUtf8('qlog-probe'));
      await stream.writer.close();
      const serverStream = await serverConnection.acceptStream();
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'qlog-probe',
        'connection produces traffic for qlog',
      );
      await client.close();
      await server.close();
      await loop.timeout(0);
      const qlog = decodeUtf8(await fs.readFile(qlogPath));
      t.ok(qlog.includes('qlog'), 'qlog file contains qlog preamble');
      t.ok(qlog.includes('packet'), 'qlog file contains packet events');
    } finally {
      await client.close();
      await server.close();
      try {
        await fs.unlink(qlogPath);
      } catch {}
    }
  });
  it('writes TLS keylog output when keylog path is configured', async (t) => {
    if (!quicAvailable || cryptoBackend !== 'ossl') return;
    const fs = new DiskFileSystem();
    const keylogPath = `/tmp/fino-quic-keylog-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      keylog: { path: keylogPath },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        keylog: { path: keylogPath },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      keylog: { path: keylogPath },
    });
    try {
      const clientConnection = await client.connect({
        address: listener.address,
        keylog: { path: keylogPath },
      });
      const serverConnection = await server.accept();
      await clientConnection.connected;
      await serverConnection.connected;
      const keylog = decodeUtf8(await fs.readFile(keylogPath));
      t.ok(
        keylog.includes('CLIENT_HANDSHAKE_TRAFFIC_SECRET'),
        'keylog contains handshake traffic secrets',
      );
      t.ok(
        keylog.includes('CLIENT_TRAFFIC_SECRET_0') || keylog.includes('SERVER_TRAFFIC_SECRET_0'),
        'keylog contains application traffic secrets',
      );
      const clientHandshakeLine = keylog
        .split(/\r?\n/)
        .find((line) => line.startsWith('CLIENT_HANDSHAKE_TRAFFIC_SECRET '));
      t.ok(clientHandshakeLine !== undefined, 'keylog contains a client handshake secret line');
      const fields = clientHandshakeLine!.split(/\s+/);
      t.equal(
        fields.length,
        3,
        'client handshake keylog line has label, client random, and secret fields',
      );
      t.equal(/^[0-9a-f]{64}$/i.test(fields[1]), true, 'client random is a 32-byte hex field');
      t.equal(/^[0-9a-f]+$/i.test(fields[2]), true, 'traffic secret is hex encoded');
      t.equal(fields[2].length % 2, 0, 'traffic secret hex has full bytes');
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
      try {
        await fs.unlink(keylogPath);
      } catch {}
    }
  });
  it('ALPN mismatch fails clearly', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['other-proto'] });
    await t.rejects(
      () => client.connect({ address: listener.address }),
      /ALPN mismatch/,
      'mismatched ALPN rejects',
    );
    await client.close();
    await server.close();
  });
  it('bidirectional stream echo works through reader and writer', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    const clientStream = await clientConnection.openBidirectionalStream();
    await clientStream.writer.write(encodeUtf8('/echo'));
    await clientStream.writer.close();
    const serverStream = await serverConnection.acceptStream();
    const request = await readBytes(serverStream.reader.read());
    t.equal(decodeUtf8(request!), '/echo', 'server reads stream data');
    await serverStream.writer.write(encodeUtf8('echo:/echo'));
    await serverStream.writer.close();
    const response = await readBytes(clientStream.reader.read());
    t.equal(decodeUtf8(response!), 'echo:/echo', 'client reads echo response');
    t.ok(
      clientConnection.stats.connectedAt !== null,
      'client connection stats record handshake completion',
    );
    t.ok(
      serverConnection.stats.connectedAt !== null,
      'server connection stats record handshake completion',
    );
    t.ok(
      clientConnection.stats.handshakeConfirmedAt !== null,
      'client connection stats record handshake confirmation',
    );
    t.equal(
      typeof clientConnection.stats.congestionWindow,
      'number',
      'connection stats expose congestion window',
    );
    t.equal(
      typeof clientConnection.stats.latestRttMs,
      'number',
      'connection stats expose latest RTT',
    );
    t.equal(
      typeof clientConnection.stats.packetsLost,
      'number',
      'connection stats expose packet loss count',
    );
    t.equal(
      typeof clientConnection.stats.bidiOutgoingStreams,
      'number',
      'connection stats expose directional stream counts',
    );
    t.ok(
      clientConnection.stats.congestionWindow > 0,
      'connection stats refresh native congestion window',
    );
    t.ok(clientConnection.stats.smoothedRttMs >= 0, 'connection stats refresh native smoothed RTT');
    t.ok(
      clientConnection.stats.slowStartThreshold >= clientConnection.stats.congestionWindow,
      'connection stats refresh native slow-start threshold',
    );
    t.ok(clientConnection.stats.packetsSent > 0, 'client connection stats count sent packets');
    t.ok(
      serverConnection.stats.packetsReceived > 0,
      'server connection stats count received packets',
    );
    t.ok(clientStream.stats.bytesSent >= 5, 'client stream stats count sent bytes');
    t.ok(serverStream.stats.bytesReceived >= 5, 'server stream stats count received bytes');
    await client.close();
    await server.close();
  });
  it('client-initiated unidirectional streams expose only the writable side locally', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const clientStream = await clientConnection.openUnidirectionalStream();
      t.equal(
        await readBytes(clientStream.reader.read()),
        null,
        'client local uni stream reader reaches EOF immediately',
      );
      const localReadable = clientStream.readable.getReader();
      t.deepEqual(
        await localReadable.read(),
        {
          value: undefined,
          done: true,
        },
        'client local uni Web readable is closed',
      );
      await clientStream.writer.write(encodeUtf8('client-uni'));
      await clientStream.writer.close();
      const serverStream = await serverConnection.acceptStream();
      await t.rejects(
        () => serverStream.writer.write(encodeUtf8('not-writable')),
        /receive-only/,
        'server receive-only uni stream rejects writes before reading data',
      );
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'client-uni',
        'server reads client uni data',
      );
      t.equal(
        await readBytes(serverStream.reader.read()),
        null,
        'server receive-only uni stream reaches EOF',
      );
      await t.rejects(
        () => serverStream.writer.write(encodeUtf8('still-not-writable')),
        /receive-only/,
        'server receive-only uni stream rejects writes after EOF',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('server-initiated unidirectional streams expose only the writable side locally', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const clientStreamPromise = clientConnection.acceptStream();
      const serverStream = await serverConnection.openUnidirectionalStream();
      t.equal(
        await readBytes(serverStream.reader.read()),
        null,
        'server local uni stream reader reaches EOF immediately',
      );
      const localReadable = serverStream.readable.getReader();
      t.deepEqual(
        await localReadable.read(),
        {
          value: undefined,
          done: true,
        },
        'server local uni Web readable is closed',
      );
      await serverStream.writer.write(encodeUtf8('server-uni'));
      await serverStream.writer.close();
      const clientStream = await clientStreamPromise;
      await t.rejects(
        () => clientStream.writer.write(encodeUtf8('not-writable')),
        /receive-only/,
        'client receive-only uni stream rejects writes before reading data',
      );
      t.equal(
        decodeUtf8((await readBytes(clientStream.reader.read()))!),
        'server-uni',
        'client reads server uni data',
      );
      t.equal(
        await readBytes(clientStream.reader.read()),
        null,
        'client receive-only uni stream reaches EOF',
      );
      await t.rejects(
        () => clientStream.writer.write(encodeUtf8('still-not-writable')),
        /receive-only/,
        'client receive-only uni stream rejects writes after EOF',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('close sends a peer-visible application connection close', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const closed = new Promise((resolve) =>
        serverConnection.addEventListener('close', () => resolve('closed'), { once: true }),
      );
      await clientConnection.close({
        errorCode: 42,
        reason: 'application shutdown',
      });
      t.equal(
        await withTimeoutValue(closed, 500, 'open'),
        'closed',
        'peer observes the application close promptly',
      );
      t.deepEqual(
        clientConnection.closeInfo,
        {
          errorCode: 42,
          reason: 'application shutdown',
          type: 'application',
          remote: false,
        },
        'local closeInfo records the graceful application close',
      );
      t.deepEqual(
        serverConnection.closeInfo,
        {
          errorCode: 42,
          reason: 'application shutdown',
          type: 'application',
          remote: true,
        },
        'peer closeInfo records the remote application close with correct code, reason, and type',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('exposes Node-aligned connection close state and destroy API', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const closed = clientConnection.closed.then(() => 'closed');
      const peerClosed = new Promise((resolve) =>
        serverConnection.addEventListener('close', () => resolve('closed'), { once: true }),
      );
      await t.rejects(
        () => (clientConnection.close as any)(9, 'legacy'),
        /close options/,
        'close() rejects the legacy close(code, reason) signature',
      );
      const closePromise = clientConnection.close({
        errorCode: 9,
        reason: 'done',
      });
      t.equal(
        clientConnection.closing || clientConnection.state === 'closed',
        true,
        'close() marks the connection as closing or completes immediately when already drained',
      );
      await closePromise;
      t.equal(
        await withTimeoutValue(closed, 500, 'open'),
        'closed',
        'closed promise resolves after graceful close',
      );
      t.equal(clientConnection.state, 'closed', 'graceful close reaches closed state');
      t.equal(
        await withTimeoutValue(peerClosed, 500, 'open'),
        'closed',
        'peer closes after graceful close packet',
      );
      const secondClient = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
      const secondConnection = await secondClient.connect({ address: listener.address });
      await server.accept();
      secondConnection.destroy(new Error('forced'), {
        errorCode: 11,
        type: 'transport',
        reason: 'forced',
      });
      await secondConnection.closed;
      t.equal(secondConnection.state, 'closed', 'destroy() closes immediately');
      t.deepEqual(
        secondConnection.closeInfo,
        {
          errorCode: 11,
          reason: 'forced',
          type: 'transport',
          remote: false,
        },
        'destroy() records explicit transport closeInfo',
      );
      await secondClient.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('bidirectional stream transfers multi-megabyte responses', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    try {
      const clientStream = await clientConnection.openBidirectionalStream();
      await clientStream.writer.write(encodeUtf8('/large'));
      await clientStream.writer.close();
      const serverStream = await serverConnection.acceptStream();
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        '/large',
        'server reads request',
      );
      const body = new Uint8Array(2 * 1024 * 1024);
      for (let i = 0; i < body.byteLength; i++) body[i] = i & 255;
      await serverStream.writer.write(body);
      await serverStream.writer.close();
      let total = 0;
      let checksum = 0;
      for (;;) {
        const chunk = await readBytes(clientStream.reader.read());
        if (chunk === null) break;
        for (const byte of chunk) checksum = (checksum + byte) >>> 0;
        total += chunk.byteLength;
      }
      t.equal(total, body.byteLength, 'client receives complete response');
      t.equal(checksum, 267386880, 'client receives expected bytes');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('waits for bidirectional stream credit until a remote stream fully closes', async (t) => {
    if (!quicAvailable) return;
    const initialMaxStreamsBidi = 1;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: {
        maxIdleTimeoutMs: 0,
        streamIdleTimeoutMs: 0,
        initialMaxStreamsBidi,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: { maxIdleTimeoutMs: 0, streamIdleTimeoutMs: 0 },
    });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    try {
      const streams: QuicStream[] = [];
      for (let i = 0; i < initialMaxStreamsBidi; i++) {
        const stream = await clientConnection.openBidirectionalStream();
        streams.push(stream);
        await stream.writer.write(encodeUtf8(`stream-${i}`));
      }
      const blockedOpen = clientConnection.openBidirectionalStream();
      const early = await withTimeoutValue(
        blockedOpen.then(() => 'opened'),
        25,
        'blocked',
      );
      t.equal(early, 'blocked', 'stream open waits while peer stream credit is exhausted');
      await streams[0].writer.close();
      const serverStream = await serverConnection.acceptStream();
      while ((await readBytes(serverStream.reader.read())) !== null) {}
      const stillBlocked = await withTimeoutValue(
        blockedOpen.then(() => 'opened'),
        25,
        'blocked',
      );
      t.equal(
        stillBlocked,
        'blocked',
        'stream open remains blocked after only the remote receive side reaches FIN',
      );
      await serverStream.writer.close();
      t.equal(
        await readBytes(streams[0].reader.read()),
        null,
        'client observes the response side close',
      );
      const unblocked = await withTimeoutValue(blockedOpen, 1e3, null);
      if (unblocked === null)
        throw new Error('stream open did not resume after the prior stream fully closed');
      t.ok(
        unblocked instanceof QuicStream,
        'stream open resumes after stream-close MAX_STREAMS credit arrives',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('bounds and cancels pending local stream opens', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: {
        maxIdleTimeoutMs: 0,
        streamIdleTimeoutMs: 0,
        initialMaxStreamsBidi: 1,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: {
        maxIdleTimeoutMs: 0,
        streamIdleTimeoutMs: 0,
        maxPendingStreamOpens: 1,
      },
    });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    try {
      const first = await clientConnection.openBidirectionalStream();
      const controller = new AbortController();
      const cancelled = clientConnection.openBidirectionalStream({ signal: controller.signal });
      await t.rejects(
        () => clientConnection.openBidirectionalStream(),
        /pending stream-open limit exceeded/,
        'a blocked open cannot grow the waiter queue past its configured limit',
      );
      controller.abort();
      await t.rejects(
        () => cancelled,
        /aborted/,
        'a blocked open can be removed from the credit queue',
      );

      const next = clientConnection.openBidirectionalStream();
      await first.writer.close();
      const peerFirst = await serverConnection.acceptStream();
      while ((await readBytes(peerFirst.reader.read())) !== null) {}
      await peerFirst.writer.close();
      t.equal(await readBytes(first.reader.read()), null);
      t.ok(
        (await withTimeoutValue(next, 1e3, null)) instanceof QuicStream,
        'credit skips the cancelled waiter and opens the next stream',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('Web Streams readable and writable transfer byte chunks', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    const clientStream = await clientConnection.openBidirectionalStream();
    const webWriter = clientStream.writable.getWriter();
    await webWriter.write(encodeUtf8('web-stream'));
    await webWriter.close();
    const serverStream = await serverConnection.acceptStream();
    const webReader = serverStream.readable.getReader();
    const first = await webReader.read();
    const eof = await webReader.read();
    t.equal(decodeUtf8(first.value), 'web-stream', 'readable stream receives bytes');
    t.ok(eof.done, 'readable stream reaches EOF');
    await client.close();
    await server.close();
  });
  it('copies QUIC stream source bytes before delayed transport flush', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    try {
      const clientStream = await clientConnection.openBidirectionalStream();
      const source = encodeUtf8('abcd');
      await clientStream.writer.write(source);
      source.set(encodeUtf8('WXYZ'));
      await clientStream.writer.close();
      const serverStream = await serverConnection.acceptStream();
      const received = await readBytes(serverStream.reader.read());
      t.equal(
        decodeUtf8(received!),
        'abcd',
        'peer receives bytes accepted by write before caller mutation',
      );
      t.equal(await readBytes(serverStream.reader.read()), null, 'stream reaches EOF');
      await serverStream.writer.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('accepts Node-covered QUIC stream source view types', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    try {
      const backing = new Uint8Array([0, 112, 97, 114, 116, 0]);
      const buffer = new Uint8Array([222, 173, 202, 254]).buffer;
      const dataView = new DataView(buffer, 2, 2);
      const shared = new SharedArrayBuffer(4);
      const sharedView = new Uint8Array(shared, 1, 3);
      sharedView.set(encodeUtf8('sab'));
      const cases: Array<[Uint8Array | ArrayBuffer | ArrayBufferView, number[]]> = [
        [backing.buffer.slice(1, 5), Array.from(encodeUtf8('part'))],
        [backing.subarray(1, 5), Array.from(encodeUtf8('part'))],
        [dataView, [202, 254]],
        [sharedView, Array.from(encodeUtf8('sab'))],
      ];
      for (const [source, expected] of cases) {
        const stream = await clientConnection.openBidirectionalStream();
        await stream.writer.write(source);
        await stream.writer.close();
        const serverStream = await serverConnection.acceptStream();
        const received = await readBytes(serverStream.reader.read());
        t.deepEqual(Array.from(received!), expected, 'stream writer preserves source view range');
        t.equal(
          await readBytes(serverStream.reader.read()),
          null,
          'stream source case reaches EOF',
        );
        await serverStream.writer.close();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('copies Web Streams QUIC writable chunks before delayed transport flush', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    try {
      const clientStream = await clientConnection.openBidirectionalStream();
      const webWriter = clientStream.writable.getWriter();
      const source = encodeUtf8('web-copy');
      await webWriter.write(source);
      source.set(encodeUtf8('mutated!'));
      await webWriter.close();
      const serverStream = await serverConnection.acceptStream();
      const webReader = serverStream.readable.getReader();
      const received = await webReader.read();
      t.equal(
        decodeUtf8(received.value),
        'web-copy',
        'Web Streams writer copies accepted bytes before caller mutation',
      );
      t.ok((await webReader.read()).done, 'Web Streams source copy case reaches EOF');
      await serverStream.writer.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('can initiate a controlled key update after handshake', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    try {
      const clientStream = await clientConnection.openBidirectionalStream();
      await clientStream.writer.write(encodeUtf8('ready'));
      await clientStream.writer.close();
      const serverStream = await serverConnection.acceptStream();
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'ready',
        'server reads 1-RTT stream data before key update',
      );
      let keyUpdateEvent = false;
      clientConnection.addEventListener('keyupdate', () => {
        keyUpdateEvent = true;
      });
      clientConnection.initiateKeyUpdate();
      t.ok(keyUpdateEvent, 'keyupdate event is dispatched');
      t.ok(serverConnection.handshakeComplete, 'server connection survived key update initiation');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('migrates a client connection to a new local UDP port', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      migration: { enabled: true },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        migration: { enabled: true },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      migration: { enabled: true },
    });
    const clientConnection = await client.connect({
      address: listener.address,
      migration: { enabled: true },
    });
    const serverConnection = await server.accept();
    try {
      const initialDestinationCid = currentDestinationCidHex(clientConnection);
      await clientConnection.migrate({
        family: 'ipv4',
        ip: '0.0.0.0',
        port: 0,
      });
      t.ok(
        activeDestinationCidSeqs(clientConnection).length >= 1,
        'client has an active destination CID after migration starts',
      );
      const clientStream = await clientConnection.openBidirectionalStream();
      await clientStream.writer.write(encodeUtf8('post-migration'));
      await clientStream.writer.close();
      const serverStream = await serverConnection.acceptStream();
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'post-migration',
        'server reads data after migration',
      );
      await serverStream.writer.write(encodeUtf8('migration-ok'));
      await serverStream.writer.close();
      t.equal(
        decodeUtf8((await readBytes(clientStream.reader.read()))!),
        'migration-ok',
        'client reads data after migration',
      );
      t.notEqual(
        currentDestinationCidHex(clientConnection),
        initialDestinationCid,
        'client uses a fresh destination CID after migration',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('exchanges unreliable datagrams when DATAGRAM is negotiated', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    const reader = serverConnection.datagramReadable.getReader();
    await clientConnection.sendDatagram(encodeUtf8('dgram-one'));
    const received = await reader.read();
    t.equal(decodeUtf8(received.value), 'dgram-one', 'server reads client datagram');
    await reader.cancel();
    await client.close();
    await server.close();
  });
  it('exchanges DATAGRAM frames over real UDP with ECN enabled', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
      transport: { ecn: true },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        transport: { ecn: true },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
      transport: { ecn: true },
    });
    try {
      const clientConnection = await client.connect({
        address: listener.address,
        transport: { ecn: true },
      });
      const serverConnection = await server.accept();
      const reader = serverConnection.datagramReadable.getReader();
      await clientConnection.sendDatagram(encodeUtf8('ecn-real-dgram'));
      const received = await reader.read();
      t.equal(
        decodeUtf8(received.value),
        'ecn-real-dgram',
        'recvmsg ECN path preserves real UDP DATAGRAM delivery',
      );
      await reader.cancel();
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('returns DATAGRAM ids that correlate with status events and topics', async (t) => {
    if (!quicAvailable) return;
    const statusTopicEvents: any[] = [];
    const sendTopicEvents: any[] = [];
    const statusSubscription = topic<any>('quic.session.receive.datagram.status').subscribe(
      (event) => statusTopicEvents.push(event),
    );
    const sendSubscription = topic<any>('quic.session.send.datagram').subscribe((event) =>
      sendTopicEvents.push(event),
    );
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const reader = serverConnection.datagramReadable.getReader();
      const statuses: string[] = [];
      clientConnection.addEventListener('datagramack', (event: any) => {
        statuses.push(`${event.id}:${event.status}`);
      });
      const id = await clientConnection.sendDatagram(encodeUtf8('id-correlates'));
      t.equal(typeof id, 'number', 'sendDatagram returns a numeric Fino datagram id');
      t.ok(id > 0, 'sendDatagram returns a nonzero datagram id');
      t.equal(
        decodeUtf8((await reader.read()).value),
        'id-correlates',
        'returned-id datagram is delivered',
      );
      clientConnection[quicConnectionInternals.onDatagramStatus](id, 'ack');
      t.deepEqual(statuses, [`${id}:ack`], 'DATAGRAM ack event uses the returned id');
      t.ok(
        statusTopicEvents.some(
          (event) =>
            event.connection === clientConnection && event.id === id && event.status === 'ack',
        ),
        'DATAGRAM status topic uses the returned id',
      );
      t.ok(
        sendTopicEvents.some(
          (event) =>
            event.connection === clientConnection &&
            event.id === id &&
            event.length === 'id-correlates'.length,
        ),
        'DATAGRAM send topic uses the returned id',
      );
      await reader.cancel();
    } finally {
      statusSubscription.dispose();
      sendSubscription.dispose();
      await client.close();
      await server.close();
    }
  });
  it('accepts Node-covered DATAGRAM source types and copies source bytes', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      const serverConnection = await server.accept();
      const reader = serverConnection.datagramReadable.getReader();
      const source = new Uint8Array([65, 66, 67]);
      const shared = new SharedArrayBuffer(3);
      const sharedView = new Uint8Array(shared);
      sharedView.set([83, 65, 66]);
      const buffer = new Uint8Array([222, 173, 202, 254]).buffer;
      const dataView = new DataView(buffer, 2, 2);
      const partial = new Uint8Array([0, 112, 97, 114, 116, 0]);
      const cases: Array<[() => Promise<number>, number[]]> = [
        [() => clientConnection.sendDatagram('plain' as any), Array.from(encodeUtf8('plain'))],
        [
          () => clientConnection.sendDatagram('686578' as any, 'hex' as any),
          Array.from(encodeUtf8('hex')),
        ],
        [
          () => clientConnection.sendDatagram('YmFzZTY0' as any, 'base64' as any),
          Array.from(encodeUtf8('base64')),
        ],
        [() => clientConnection.sendDatagram(Promise.resolve(new Uint8Array([80])) as any), [80]],
        [() => clientConnection.sendDatagram(sharedView as any), Array.from(encodeUtf8('SAB'))],
        [() => clientConnection.sendDatagram(dataView as any), [202, 254]],
        [
          () => clientConnection.sendDatagram(partial.subarray(1, 5) as any),
          Array.from(encodeUtf8('part')),
        ],
        [() => clientConnection.sendDatagram(source), Array.from(encodeUtf8('ABC'))],
      ];
      const received: number[][] = [];
      const ids: number[] = [];
      for (let i = 0; i < cases.length; i++) {
        const [send] = cases[i];
        const id = await send();
        if (i === cases.length - 1) source.set([88, 89, 90]);
        ids.push(id);
        const read = await reader.read();
        t.equal(read.done, false, 'DATAGRAM source case delivers a payload');
        received.push(Array.from(read.value));
      }
      t.equal(
        ids.every((id) => typeof id === 'number' && id > 0),
        true,
        'each accepted DATAGRAM source returns an id',
      );
      t.deepEqual(
        received,
        cases.map(([, expected]) => expected),
        'DATAGRAM sources preserve encoding, view bounds, and pre-mutation bytes',
      );
      await t.rejects(
        () => clientConnection.sendDatagram({ nope: true } as any),
        /DATAGRAM data|datagram/i,
        'invalid DATAGRAM sources reject',
      );
      await reader.cancel();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('dispatches DATAGRAM ACK and loss status events', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      await server.accept();
      const statuses: string[] = [];
      clientConnection.addEventListener('datagramstatus', (event: any) => {
        statuses.push(`${event.id}:${event.status}`);
      });
      clientConnection[quicConnectionInternals.onDatagramStatus](3, 'ack');
      clientConnection[quicConnectionInternals.onDatagramStatus](4, 'lost');
      t.deepEqual(
        statuses,
        ['3:ack', '4:lost'],
        'datagram status callbacks are surfaced to applications',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('dispatches DATAGRAM abandoned status events separately from loss', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      await server.accept();
      const events: string[] = [];
      clientConnection.addEventListener('datagramstatus', (event: any) => {
        events.push(`status:${event.id}:${event.status}`);
      });
      clientConnection.addEventListener('datagramlost', (event: any) => {
        events.push(`lost:${event.id}:${event.status}`);
      });
      clientConnection.addEventListener('datagramabandoned', (event: any) => {
        events.push(`abandoned:${event.id}:${event.status}`);
      });
      clientConnection[quicConnectionInternals.onDatagramStatus](5, 'abandoned' as any);
      t.deepEqual(
        events,
        ['status:5:abandoned', 'abandoned:5:abandoned'],
        'abandoned datagrams are not reported as lost',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('abandons pending datagrams according to drop-newest overflow policy', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
        maxPending: 1,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
        maxPending: 1,
        dropPolicy: 'drop-newest',
      },
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      await server.accept();
      const abandoned: number[] = [];
      clientConnection.addEventListener('datagramabandoned', (event: any) => {
        abandoned.push(event.id);
      });
      const [firstId, secondId] = await Promise.all([
        clientConnection.sendDatagram(encodeUtf8('queued-one')),
        clientConnection.sendDatagram(encodeUtf8('queued-two')),
      ]);
      await loop.timeout(0);
      t.ok(firstId > 0, 'drop-newest first DATAGRAM returns an id');
      t.ok(secondId > firstId, 'drop-newest second DATAGRAM returns a later id');
      t.equal(abandoned.length, 1, 'overflowing the pending datagram queue abandons one datagram');
      t.equal(abandoned[0], secondId, 'drop-newest abandons the incoming returned datagram id');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('abandons pending datagrams according to drop-oldest overflow policy', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
        maxPending: 1,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
        maxPending: 1,
        dropPolicy: 'drop-oldest',
      },
    });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      await server.accept();
      const abandoned: number[] = [];
      clientConnection.addEventListener('datagramabandoned', (event: any) => {
        abandoned.push(event.id);
      });
      const [firstId, secondId] = await Promise.all([
        clientConnection.sendDatagram(encodeUtf8('queued-one')),
        clientConnection.sendDatagram(encodeUtf8('queued-two')),
      ]);
      await loop.timeout(0);
      t.ok(firstId > 0, 'drop-oldest first DATAGRAM returns an id');
      t.ok(secondId > firstId, 'drop-oldest second DATAGRAM returns a later id');
      t.equal(abandoned.length, 1, 'overflowing the pending datagram queue abandons one datagram');
      t.equal(abandoned[0], firstId, 'drop-oldest abandons the previously returned datagram id');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('rejects oversized datagrams before writing packets', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 32,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 32,
      },
    });
    const clientConnection = await client.connect({ address: listener.address });
    await t.rejects(
      () => clientConnection.sendDatagram(new Uint8Array(33)),
      /exceeds maxFrameSize/,
      'oversized datagrams reject locally',
    );
    await client.close();
    await server.close();
  });
  it('delivers zero-length datagrams as empty payloads', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();
    const reader = serverConnection.datagramReadable.getReader();
    const id = await clientConnection.sendDatagram(new Uint8Array());
    const received = await reader.read();
    t.ok(id > 0, 'zero-length datagram returns a real Fino id');
    t.equal(received.done, false, 'zero-length datagram is delivered');
    t.equal(received.value.byteLength, 0, 'zero-length datagram arrives as an empty Uint8Array');
    await reader.cancel();
    await client.close();
    await server.close();
  });
  it('rejects datagrams when the peer did not negotiate DATAGRAM support', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: { enabled: false },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const clientConnection = await client.connect({ address: listener.address });
    await server.accept();
    await t.rejects(
      () => clientConnection.sendDatagram(encodeUtf8('dgram-one')),
      /peer did not negotiate QUIC DATAGRAM/,
      'DATAGRAM sends require peer transport-parameter support',
    );
    await client.close();
    await server.close();
  });
  it('rejects datagrams larger than the peer negotiated DATAGRAM payload', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 16,
      },
    });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      datagrams: {
        enabled: true,
        maxFrameSize: 1200,
      },
    });
    const clientConnection = await client.connect({ address: listener.address });
    await server.accept();
    await t.rejects(
      () => clientConnection.sendDatagram(new Uint8Array(15)),
      /exceeds peer maxDatagramPayload/,
      'peer DATAGRAM frame size includes frame overhead',
    );
    await client.close();
    await server.close();
  });
  it('closes a connection when an unknown short packet matches a stateless reset token', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    await server.accept();
    const cid = makeNativeCid(new Uint8Array([16, 32, 48, 64]));
    const token = new Uint8Array(16);
    for (let i = 0; i < token.byteLength; i++) token[i] = 160 + i;
    clientConnection[quicConnectionInternals.onDestinationCidStatus](
      NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE,
      cid,
      Pointer.of(token.buffer),
    );
    const reset = new Uint8Array(33);
    reset[0] = 64;
    reset.set(token, reset.byteLength - token.byteLength);
    client[quicEndpointInternals.handleDatagram](
      null,
      0,
      listener.address,
      reset,
      listener.address,
    );
    await loop.timeout(0);
    t.equal(
      clientConnection.state,
      'closed',
      'stateless reset token closes the matching connection',
    );
    await client.close();
    await server.close();
  });
  it('registers and unregisters issued CIDs in the endpoint route table', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      await server.accept();
      const issuedCidBytes = new Uint8Array([49, 50, 51, 52, 53]);
      const issuedCid = makeNativeCid(issuedCidBytes);
      const issuedKey = cidHex(issuedCidBytes);
      clientConnection[quicConnectionInternals.registerIssuedCid](issuedCid);
      t.equal(
        client.cidTable.get(issuedKey),
        clientConnection,
        'issued CID routes to the connection',
      );
      clientConnection[quicConnectionInternals.unregisterIssuedCid](issuedCid);
      t.equal(
        client.cidTable.get(issuedKey),
        undefined,
        'retired issued CID is removed from routing',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('deactivates destination-CID stateless reset tokens', async (t) => {
    if (!quicAvailable) return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    try {
      const clientConnection = await client.connect({ address: listener.address });
      await server.accept();
      const cid = makeNativeCid(new Uint8Array([80, 96, 112, 128]));
      const token = new Uint8Array(16);
      for (let i = 0; i < token.byteLength; i++) token[i] = 192 + i;
      clientConnection[quicConnectionInternals.onDestinationCidStatus](
        NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE,
        cid,
        Pointer.of(token.buffer),
      );
      clientConnection[quicConnectionInternals.onDestinationCidStatus](
        NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE,
        cid,
        Pointer.of(token.buffer),
      );
      const reset = new Uint8Array(33);
      reset[0] = 64;
      reset.set(token, reset.byteLength - token.byteLength);
      client[quicEndpointInternals.handleDatagram](
        null,
        0,
        listener.address,
        reset,
        listener.address,
      );
      await loop.timeout(0);
      t.notEqual(
        clientConnection.state,
        'closed',
        'deactivated stateless reset token no longer closes the connection',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('sends stateless reset for unknown short-header packets', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const responseFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    const sendFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(responseFd);
    setNonblocking(sendFd);
    socketBind(responseFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    socketBind(sendFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const bound = getsockname(responseFd);
      if (bound.family !== 'ipv4')
        throw new Error('stateless reset test expected IPv4 response socket');
      const packet = new Uint8Array(43);
      packet[0] = 64;
      for (let i = 1; i < packet.byteLength; i++) packet[i] = i;
      endpoint[quicEndpointInternals.handleDatagram](
        listener,
        sendFd,
        listener.address,
        packet,
        bound,
      );
      const response = await recvUdp(responseFd, 500);
      if (response === null) throw new Error('no stateless reset was sent');
      t.ok(response.byteLength >= 17, 'stateless reset contains random bytes and token');
      t.equal(response[0] & 128, 0, 'stateless reset is a short-header-looking packet');
    } finally {
      socketClose(responseFd);
      socketClose(sendFd);
      await endpoint.close();
    }
  });
  it('does not send stateless reset when disabled', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      transport: { disableStatelessReset: true },
    });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const responseFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    const sendFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(responseFd);
    setNonblocking(sendFd);
    socketBind(responseFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    socketBind(sendFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const bound = getsockname(responseFd);
      if (bound.family !== 'ipv4')
        throw new Error('stateless reset disable test expected IPv4 response socket');
      const packet = new Uint8Array(43);
      packet[0] = 64;
      for (let i = 1; i < packet.byteLength; i++) packet[i] = i;
      endpoint[quicEndpointInternals.handleDatagram](
        listener,
        sendFd,
        listener.address,
        packet,
        bound,
      );
      t.equal(
        await recvUdp(responseFd, 100),
        null,
        'unknown short packet receives no stateless reset when disabled',
      );
      t.equal(
        endpoint.stats.statelessResetSent,
        0,
        'disabled stateless reset does not increment sent counter',
      );
    } finally {
      socketClose(responseFd);
      socketClose(sendFd);
      await endpoint.close();
    }
  });
  it('does not send stateless reset for packets below the minimum reset size', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const responseFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    const sendFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(responseFd);
    setNonblocking(sendFd);
    socketBind(responseFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    socketBind(sendFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const bound = getsockname(responseFd);
      if (bound.family !== 'ipv4')
        throw new Error('stateless reset minimum-size test expected IPv4 response socket');
      const packet = new Uint8Array(41);
      packet[0] = 64;
      for (let i = 1; i < packet.byteLength; i++) packet[i] = i;
      endpoint[quicEndpointInternals.handleDatagram](
        listener,
        sendFd,
        listener.address,
        packet,
        bound,
      );
      t.equal(
        await recvUdp(responseFd, 100),
        null,
        'unknown short packet below the minimum reset source size is ignored',
      );
    } finally {
      socketClose(responseFd);
      socketClose(sendFd);
      await endpoint.close();
    }
  });
  it('rate-limits stateless resets for unknown short-header floods', async (t) => {
    if (!quicAvailable) return;
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const responseFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    const sendFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    setNonblocking(responseFd);
    setNonblocking(sendFd);
    socketBind(responseFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    socketBind(sendFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    try {
      const bound = getsockname(responseFd);
      if (bound.family !== 'ipv4')
        throw new Error('stateless reset test expected IPv4 response socket');
      const packet = new Uint8Array(43);
      packet[0] = 64;
      const tuning = __inspectQuicRuntimeTuning();
      const attempts = tuning.statelessResetBurst + 200;
      const started = performance.now();
      for (let attempt = 0; attempt < attempts; attempt++) {
        for (let i = 1; i < packet.byteLength; i++) packet[i] = (attempt + i) & 255;
        endpoint[quicEndpointInternals.handleDatagram](
          listener,
          sendFd,
          listener.address,
          packet,
          bound,
        );
      }
      const elapsedSeconds = (performance.now() - started) / 1e3;
      let responses = 0;
      for (;;) {
        const response = await recvUdp(responseFd, responses === 0 ? 500 : 25);
        if (response === null) break;
        responses++;
      }
      const maxAllowed =
        tuning.statelessResetBurst + Math.ceil(tuning.statelessResetRate * elapsedSeconds) + 2;
      t.ok(responses > 0, 'initial stateless reset burst is still allowed');
      t.ok(
        responses <= maxAllowed,
        'stateless reset responses stay within the Node-style token bucket',
      );
      t.ok(responses < attempts, 'flood probes are throttled');
    } finally {
      socketClose(responseFd);
      socketClose(sendFd);
      await endpoint.close();
    }
  });
});
describe('QUIC GnuTLS backend parity', () => {
  it('completes TLS handshake and exposes ALPN on GnuTLS', async (t) => {
    if (!quicAvailable || cryptoBackend !== 'gnutls') return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-gnutls'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-gnutls'] });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: false,
      });
      const serverConnection = await accepted;
      t.equal(clientConnection.alpnProtocol, 'fino-gnutls', 'GnuTLS client negotiates ALPN');
      t.equal(serverConnection.alpnProtocol, 'fino-gnutls', 'GnuTLS server negotiates ALPN');
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('verifies server cert with pinned CA trust on GnuTLS', async (t) => {
    if (!quicAvailable || cryptoBackend !== 'gnutls') return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-gnutls'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-gnutls'] });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: true,
        ca: { file: TEST_CERT },
      });
      const serverConnection = await accepted;
      t.equal(
        clientConnection.handshakeComplete,
        true,
        'GnuTLS client verifies self-signed server cert through pinned CA',
      );
      t.equal(
        clientConnection.peerVerification?.errorCode,
        0,
        'GnuTLS client reports successful CA validation',
      );
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('requires and exposes client cert for mTLS on GnuTLS', async (t) => {
    if (!quicAvailable || cryptoBackend !== 'gnutls') return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-gnutls'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        verifyClient: true,
        ca: { file: TEST_CERT },
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-gnutls'] });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: false,
        certificateFile: TEST_CERT,
        privateKeyFile: TEST_KEY,
      });
      const serverConnection = await accepted;
      t.equal(clientConnection.handshakeComplete, true, 'GnuTLS mTLS client completes handshake');
      t.ok(
        serverConnection.peerCertificate instanceof Uint8Array,
        'GnuTLS server exposes peer certificate DER bytes',
      );
      t.deepEqual(
        serverConnection.peerVerification,
        {
          verified: true,
          errorCode: 0,
          reason: null,
        },
        'GnuTLS server reports successful client cert verification',
      );
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('allows unverified cert with rejectUnauthorized false on GnuTLS', async (t) => {
    if (!quicAvailable || cryptoBackend !== 'gnutls') return;
    const server = new QuicEndpoint({ alpnProtocols: ['fino-gnutls'] });
    const listener = await server.listen(
      testListenOptions({
        address: {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: 0,
        },
        verifyClient: true,
        rejectUnauthorized: false,
      }),
    );
    const client = new QuicEndpoint({ alpnProtocols: ['fino-gnutls'] });
    try {
      const accepted = server.accept();
      const clientConnection = await client.connect({
        address: listener.address,
        serverName: 'localhost',
        verifyPeer: false,
        certificateFile: TEST_CERT,
        privateKeyFile: TEST_KEY,
      });
      const serverConnection = await accepted;
      t.equal(
        clientConnection.handshakeComplete,
        true,
        'GnuTLS client completes mTLS even when its cert fails server CA verification',
      );
      t.ok(
        serverConnection.peerCertificate instanceof Uint8Array,
        'GnuTLS server exposes peer certificate DER bytes even when unverified',
      );
      await clientConnection.close();
      await serverConnection.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
describe('QUIC CID routing table', () => {
  it('adds, looks up, removes, and clears connection IDs', (t) => {
    const table = new CidRoutingTable<string>();
    const cid = new Uint8Array([222, 173, 190, 239]);
    table.add(cid, 'conn-a');
    t.equal(table.get(cid), 'conn-a', 'lookup by bytes');
    t.equal(table.get('deadbeef'), 'conn-a', 'lookup by normalized string');
    t.ok(table.delete(cid), 'delete returns true');
    t.equal(table.get(cid), undefined, 'deleted CID is absent');
    table.add('aa', 'conn-b');
    table.clear();
    t.equal(table.get('aa'), undefined, 'clear removes entries');
  });
});
