# quic

fino:net/quic — low-level QUIC client and server endpoints.

This module exposes QUIC as an EventTarget-first transport API. A
`QuicEndpoint` owns one or more UDP listeners and delivers accepted
connections through both `connection` events and the pull-based `accept()`
method. Each `QuicConnection` similarly delivers incoming streams through
`stream` events and `acceptStream()`.

Streams expose Web Streams as the primary public interface:
`QuicStream.readable` and `QuicStream.writable` move `Uint8Array` chunks.
The lower-level `reader` and `writer` properties expose Fino byte reader and
writer objects for code that needs direct structural reads or explicit write
control.

This is intentionally transport-level only and does not implement HTTP/3 or
WebTransport. Endpoints advertise `h3` by default so callers can build raw
HTTP/3-compatible transports, but no `fino:net/http` integration is performed
here. QUIC DATAGRAM and controlled key updates are exposed for lower protocol
work. Replay-sensitive features such as 0-RTT stay disabled unless callers
explicitly provide the required policy and storage.

```ts
import { QuicEndpoint } from 'fino:net/quic';

const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
const listener = await endpoint.listen({
  address: { family: 'ipv4', ip: '127.0.0.1', port: 4433 },
});

endpoint.addEventListener('connection', async (event) => {
  const stream = await event.connection.acceptStream();
  await stream.writer.write(new TextEncoder().encode('ok'));
});

await listener.close();
await endpoint.close();
```

## CidRoutingTable

```ts
class CidRoutingTable<T = QuicConnection> {
```

### add

```ts
add(cid: Uint8Array | string, value: T): void
```

### get

```ts
get(cid: Uint8Array | string): T | undefined
```

### delete

```ts
delete(cid: Uint8Array | string): boolean
```

### clear

```ts
clear(): void
```

## QuicConnection

```ts
class QuicConnection extends EventTarget {
```

### connectionId

```ts
readonly connectionId: string
```

### remoteAddress

```ts
remoteAddress: QuicAddress
```

### localAddress

```ts
readonly localAddress: QuicAddress
```

### alpnProtocols

```ts
readonly alpnProtocols: string[]
```

### routeCids

```ts
readonly routeCids: string[]
```

### constructor

```ts
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
  serverName: string | null = null
)
```

### nativeHandle

```ts
get nativeHandle(): ArrayBuffer
```

### alpnProtocol

```ts
get alpnProtocol(): string
```

### handshakeComplete

```ts
get handshakeComplete(): boolean
```

### version

```ts
get version(): QuicVersion
```

Negotiated QUIC version for this connection.

Returns `v1` or `v2`. Before ngtcp2 reports a negotiated value, this falls
back to the local version used to construct the native connection.

### state

```ts
get state(): QuicConnectionState
```

### closing

```ts
get closing(): boolean
```

### closed

```ts
get closed(): Promise<void>
```

### closeInfo

```ts
get closeInfo(): QuicCloseInfo | null
```

### peerCertificate

```ts
get peerCertificate(): Uint8Array | null
```

### peerVerification

```ts
get peerVerification(): QuicPeerVerification | null
```

### _isClosedForInternalUse

```ts
_isClosedForInternalUse(): boolean
```

### localTransportParameters

```ts
get localTransportParameters(): QuicTransportParameterSnapshot | null
```

### remoteTransportParameters

```ts
get remoteTransportParameters(): QuicTransportParameterSnapshot | null
```

### stats

```ts
get stats(): QuicConnectionStats
```

### _roleForStats

```ts
_roleForStats(): 'client' | 'server'
```

### _wireVersionForRouting

```ts
_wireVersionForRouting(): number
```

### _validationTokenTypeForRouting

```ts
_validationTokenTypeForRouting(): number
```

### _drainingRetentionMsForRouting

```ts
_drainingRetentionMsForRouting(): number
```

### _matchesServerConnection

```ts
_matchesServerConnection(listener?: QuicListener, remoteAddress?: QuicAddress): boolean
```

### datagrams

```ts
get datagrams(): ReadableStream<Uint8Array>
```

Readable stream of received QUIC DATAGRAM payloads.

The stream is available only when DATAGRAM support was enabled and
negotiated. Payloads are unreliable and unordered by protocol design.

### datagramReadable

```ts
get datagramReadable(): ReadableStream<Uint8Array>
```

### acceptStream

```ts
acceptStream(): Promise<QuicStream>
```

### _isLocalUnidirectionalStream

```ts
_isLocalUnidirectionalStream(streamId: number): boolean
```

### _openBidirectionalStreamSync

```ts
_openBidirectionalStreamSync(): QuicStream
```

### openBidirectionalStream

```ts
async openBidirectionalStream(): Promise<QuicStream>
```

### _openUnidirectionalStreamSync

```ts
_openUnidirectionalStreamSync(): QuicStream
```

### openUnidirectionalStream

```ts
async openUnidirectionalStream(): Promise<QuicStream>
```

### initiateKeyUpdate

```ts
initiateKeyUpdate(): void
```

Initiate a local QUIC key update.

Throws if the connection is not connected or ngtcp2 reports that the update
is not currently legal, for example before enough 1-RTT traffic has flowed.

### migrate

```ts
async migrate(address: QuicAddress): Promise<void>
```

Actively migrate a client connection to a new local UDP address.

This binds a new UDP socket, asks ngtcp2 to validate migration to the new
path, and then keeps both sockets readable while validation completes.

### sendDatagram

```ts
async sendDatagram(
  data: QuicDatagramSource,
  encoding: QuicDatagramEncoding = 'utf8'
): Promise<number>
```

Send one unreliable QUIC DATAGRAM payload.

Rejects for local validation failures such as disabled DATAGRAM support,
disconnected state, oversized payloads, or missing peer DATAGRAM
negotiation. Zero-length payloads are valid RFC 9221 DATAGRAM frames.
Transient send pressure is handled by the local
queue; queued DATAGRAMs later surface `datagramack`, `datagramlost`, or
`datagramabandoned` events.

### close

```ts
async close(options: QuicCloseOptions = {}): Promise<void>
```

### destroy

```ts
destroy(error?: Error, options: QuicCloseOptions = {}): void
```

### _setSessionStoreKey

```ts
_setSessionStoreKey(key: string): void
```

### _setClientSessionOptions

```ts
_setClientSessionOptions(verifyPeer: boolean, earlyDataMax: number): void
```

### _closeForCompatibleVersionUpgrade

```ts
_closeForCompatibleVersionUpgrade(): void
```

### _setAddressValidationToken

```ts
_setAddressValidationToken(token: Uint8Array, tokenType: number): void
```

### _setEarlyDataDiagnostics

```ts
_setEarlyDataDiagnostics(attempted: boolean, accepted: boolean): void
```

### _setEarlyDataReady

```ts
_setEarlyDataReady(ready: boolean, maxBytes: number): void
```

### _deferHandshakeForEarlyData

```ts
_deferHandshakeForEarlyData(): void
```

### _scheduleEarlyDataEvent

```ts
_scheduleEarlyDataEvent(accepted: boolean, reason: string): void
```

### _onSessionTicket

```ts
_onSessionTicket(ticket: Uint8Array): void
```

### _setEarlyTransportParameters

```ts
_setEarlyTransportParameters(data: Uint8Array): boolean
```

### _initClient

```ts
_initClient(rememberedVersion = 0): void
```

### _initServer

```ts
_initServer(
  clientScid: ArrayBuffer,
  serverScid: ArrayBuffer,
  version: number,
  retryScid: ArrayBuffer | null = null,
  token: Uint8Array | null = null,
  tokenType = NGTCP2_TOKEN_TYPE_UNKNOWN
): void
```

### _registerIssuedCid

```ts
_registerIssuedCid(cid: ArrayBuffer): void
```

### _unregisterIssuedCid

```ts
_unregisterIssuedCid(cid: ArrayBuffer): void
```

### _onDestinationCidStatus

```ts
_onDestinationCidStatus(type: number, cid: ArrayBuffer | null, token: ArrayBuffer | null): void
```

### _onStatelessReset

```ts
_onStatelessReset(): void
```

### _waitHandshake

```ts
_waitHandshake(): Promise<void>
```

### _onHandshakeCompleted

```ts
_onHandshakeCompleted(): void
```

### _onHandshakeConfirmed

```ts
_onHandshakeConfirmed(): void
```

### _startSocketLoop

```ts
_startSocketLoop(
  transport: QuicDatagramTransport | null = this.#transportById(
    this.#fd
  ),
  localAddress: QuicAddress = this.#activeLocalAddress
): void
```

### _receivePacket

```ts
_receivePacket(
  packet: Uint8Array,
  remoteAddress: QuicAddress,
  localAddress: QuicAddress = this.localAddress,
  transport: QuicDatagramTransport | null = this.#transportById(
    this.#fd
  ),
  packetEcn?: number
): number
```

### _reserveStreamData

```ts
_reserveStreamData(data: Uint8Array): void
```

### _queueStreamData

```ts
_queueStreamData(
  stream: QuicStream,
  data: Uint8Array,
  fin: boolean,
  earlyDataReserved = false
): void
```

### _driveWrites

```ts
_driveWrites(remoteAddress: QuicAddress = this.remoteAddress): void
```

### _scheduleWrites

```ts
_scheduleWrites(remoteAddress: QuicAddress = this.remoteAddress): void
```

### _scheduleStreamWriterFlush

```ts
_scheduleStreamWriterFlush(callback: () => void): void
```

### _onRemoteStreamOpen

```ts
_onRemoteStreamOpen(streamId: number): void
```

### _onLocalStreamCredit

```ts
_onLocalStreamCredit(direction: 'bidirectional' | 'unidirectional'): void
```

### _onStreamData

```ts
_onStreamData(streamId: number, offset: number, data: Uint8Array, fin: boolean): void
```

### _onStreamDataCredit

```ts
_onStreamDataCredit(_streamId: number, _maxData: number): void
```

### _extendStreamReceiveCredit

```ts
_extendStreamReceiveCredit(streamId: number, bytes: number): void
```

### _extendConnectionReceiveCredit

```ts
_extendConnectionReceiveCredit(bytes: number): void
```

### _onStreamClose

```ts
_onStreamClose(streamId: number): void
```

### _onStreamReset

```ts
_onStreamReset(streamId: number, code: number): void
```

### _onStreamStopSending

```ts
_onStreamStopSending(streamId: number, code: number): void
```

### _onDatagram

```ts
_onDatagram(data: Uint8Array, earlyData: boolean): void
```

### _onDatagramStatus

```ts
_onDatagramStatus(id: number, status: QuicDatagramStatus): void
```

### _onKeyInstalled

```ts
_onKeyInstalled(_level: number): void
```

### _onVersionNegotiation

```ts
_onVersionNegotiation(hd: ArrayBuffer | null, sv: ArrayBuffer | null, nsv: number): void
```

### _onVersionNegotiationForTest

```ts
_onVersionNegotiationForTest(
  wireVersion: number,
  requestedWireVersions: number[],
  supportedWireVersions?: number[]
): void
```

### _onNewToken

```ts
_onNewToken(token: Uint8Array): void
```

### _onQlogWrite

```ts
_onQlogWrite(flags: number, data: Uint8Array): void
```

### _onEarlyDataRejected

```ts
_onEarlyDataRejected(): void
```

### _onPathValidationStarted

```ts
_onPathValidationStarted(
  path: ArrayBuffer | null,
  fallbackPath?: ArrayBuffer | null,
  flags = 0
): void
```

### _onPathValidationFinished

```ts
_onPathValidationFinished(
  path: ArrayBuffer | null,
  fallbackPath: ArrayBuffer | null,
  result: number,
  flags: number
): void
```

### _selectPreferredAddress

```ts
_selectPreferredAddress(dest: ArrayBuffer | null, paddr: ArrayBuffer | null): number
```

### _removeStream

```ts
_removeStream(stream: QuicStream): void
```

### _onAckedStreamDataOffset

```ts
_onAckedStreamDataOffset(streamId: number, offset: number, datalen: number): void
```

## QuicConnectionEvent

```ts
class QuicConnectionEvent extends Event {
```

### connection

```ts
readonly connection: QuicConnection
```

### constructor

```ts
constructor(type: string, init: {
  connection: QuicConnection;
})
```

## QuicDatagramEvent

```ts
class QuicDatagramEvent extends Event {
```

### data

```ts
readonly data: Uint8Array
```

Datagram payload copied from ngtcp2 receive memory.

### earlyData

```ts
readonly earlyData: boolean
```

True when the datagram arrived in 0-RTT packet space.

### constructor

```ts
constructor(type: string, init: {
  data: Uint8Array;
  earlyData?: boolean;
})
```

Create an event carrying one received QUIC DATAGRAM payload.

## QuicDatagramStatusEvent

```ts
class QuicDatagramStatusEvent extends Event {
```

### id

```ts
readonly id: number
```

Application-assigned datagram identifier passed to ngtcp2.

### status

```ts
readonly status: QuicDatagramStatus
```

Delivery status reported by ngtcp2 recovery.

### constructor

```ts
constructor(type: string, init: {
  id: number;
  status: QuicDatagramStatus;
})
```

Create an event carrying one QUIC DATAGRAM delivery status update.

## QuicEarlyDataEvent

```ts
class QuicEarlyDataEvent extends Event {
```

### accepted

```ts
readonly accepted: boolean
```

True when the attempted 0-RTT state is usable for early writes.

### rejected

```ts
readonly rejected: boolean
```

True when early data was attempted but cannot be used.

### reason

```ts
readonly reason: string
```

Stable application-readable reason for the early-data decision.

### constructor

```ts
constructor(type: string, init: {
  accepted: boolean;
  rejected: boolean;
  reason: string;
})
```

Create an event carrying one 0-RTT early-data decision.

## QuicEndpoint

```ts
class QuicEndpoint extends EventTarget {
```

### cidTable

```ts
readonly cidTable
```

### alpnProtocols

```ts
readonly alpnProtocols: string[]
```

### versions

```ts
readonly versions: QuicVersion[]
```

### tlsCipherSuites

```ts
readonly tlsCipherSuites: QuicTlsCipherSuite[] | null
```

### tlsGroups

```ts
readonly tlsGroups: string[] | null
```

### retry

```ts
readonly retry: ResolvedRetryOptions
```

### sessionStore

```ts
readonly sessionStore?: QuicSessionStore
```

### earlyData

```ts
readonly earlyData: false | QuicEarlyDataPolicy
```

### migration

```ts
readonly migration: ResolvedMigrationOptions
```

### datagrams

```ts
readonly datagrams: ResolvedDatagramOptions
```

### connection

```ts
readonly connection: QuicResolvedConnectionOptions
```

### qlog

```ts
readonly qlog: QuicQlogOptions
```

### keylog

```ts
readonly keylog: QuicKeylogOptions
```

### constructor

```ts
constructor(options: QuicEndpointOptions = {}, internals: QuicEndpointInternals = {})
```

### listeners

```ts
get listeners(): ReadonlyArray<QuicListener>
```

### busy

```ts
get busy(): boolean
```

### transport

```ts
get transport(): QuicResolvedTransportOptions
```

### setBusy

```ts
setBusy(busy: boolean): void
```

### stats

```ts
get stats(): QuicEndpointStats
```

### _bindTransport

```ts
async _bindTransport(address: QuicAddress, options: {
  ecn?: boolean;
} = {}): Promise<QuicDatagramTransport>
```

### _unregisterTransport

```ts
_unregisterTransport(transport: QuicDatagramTransport): void
```

### _transportById

```ts
_transportById(id: number): QuicDatagramTransport | undefined
```

### _quicRuntime

```ts
_quicRuntime(): QuicRuntime
```

### _recordDatagramSent

```ts
_recordDatagramSent(bytes: number): void
```

### _recordDatagramReceived

```ts
_recordDatagramReceived(bytes: number): void
```

### listen

```ts
async listen(options: QuicListenOptions = {}): Promise<QuicListener>
```

### connect

```ts
async connect(options: QuicConnectOptions): Promise<QuicConnection>
```

### accept

```ts
accept(): Promise<QuicConnection>
```

### close

```ts
async close(): Promise<void>
```

### closeGracefully

```ts
async closeGracefully(options: QuicCloseOptions = {}): Promise<void>
```

### _track

```ts
_track(connection: QuicConnection): void
```

### _forgetConnectionRoutes

```ts
_forgetConnectionRoutes(connection: QuicConnection): void
```

### _accept

```ts
_accept(connection: QuicConnection): void
```

### _removeListener

```ts
_removeListener(listener: QuicListener): void
```

### _registerStatelessResetToken

```ts
_registerStatelessResetToken(token: string, connection: QuicConnection): void
```

### _unregisterStatelessResetToken

```ts
_unregisterStatelessResetToken(token: string, connection: QuicConnection): void
```

### _storeAddressToken

```ts
_storeAddressToken(key: string, token: Uint8Array): void
```

### _loadAddressToken

```ts
_loadAddressToken(key: string): Uint8Array | null
```

### _handleDatagram

```ts
_handleDatagram(
  listener: QuicListener | null,
  transportOrFd: QuicDatagramTransport | number,
  localAddress: QuicAddress,
  packet: Uint8Array,
  remoteAddress: QuicAddress,
  packetEcn?: number
): void
```

## QuicErrorEvent

```ts
class QuicErrorEvent extends Event {
```

### error

```ts
readonly error: Error
```

### constructor

```ts
constructor(type: string, init: {
  error: Error;
})
```

## QuicVersionNegotiationError

```ts
class QuicVersionNegotiationError extends Error {
```

### requestedVersions

```ts
readonly requestedVersions: readonly number[]
```

### supportedVersions

```ts
readonly supportedVersions: readonly number[]
```

### constructor

```ts
constructor(requestedVersions: readonly number[], supportedVersions: readonly number[])
```

## QuicListener

```ts
class QuicListener {
```

### endpoint

```ts
readonly endpoint: QuicEndpoint
```

### address

```ts
readonly address: QuicAddress
```

### alpnProtocols

```ts
readonly alpnProtocols: string[]
```

### options

```ts
readonly options: ResolvedQuicOptions
```

### _ctx

```ts
_ctx: QuicTlsContext
```

### constructor

```ts
constructor(
  endpoint: QuicEndpoint,
  address: QuicAddress,
  alpnProtocols: string[],
  transports: QuicDatagramTransport[],
  ctx: QuicTlsContext,
  options: ResolvedQuicOptions,
  sniContexts: Map<string, QuicTlsContext> = new Map(
  )
)
```

### closed

```ts
get closed(): boolean
```

### retryTokenSecret

```ts
get retryTokenSecret(): Uint8Array
```

### resetTokenSecret

```ts
get resetTokenSecret(): Uint8Array
```

### close

```ts
async close(): Promise<void>
```

### getSNIContexts

```ts
getSNIContexts(): Record<string, QuicSNIContextOptions>
```

### setSNIContexts

```ts
setSNIContexts(entries: Record<string, QuicSNIContextOptions>): void
```

### _start

```ts
async _start(): Promise<void>
```

## QuicNewTokenEvent

```ts
class QuicNewTokenEvent extends Event {
```

### token

```ts
readonly token: Uint8Array
```

Address-validation token received from a QUIC NEW_TOKEN frame.

### address

```ts
readonly address: QuicAddress
```

Peer address for which the token is valid.

### constructor

```ts
constructor(type: string, init: {
  token: Uint8Array;
  address: QuicAddress;
})
```

Create an event carrying a QUIC NEW_TOKEN address-validation token.

## QuicPathValidationEvent

```ts
class QuicPathValidationEvent extends Event {
```

### result

```ts
readonly result: QuicPathValidationResult
```

Path-validation result reported by ngtcp2.

### path

```ts
readonly path: QuicPath | null
```

Newly validated path, or the failed path when validation failed.

### previousPath

```ts
readonly previousPath: QuicPath | null
```

Fallback or previous path reported by ngtcp2, when available.

### preferredAddress

```ts
readonly preferredAddress: boolean
```

True when validation was for a server preferred address.

### newToken

```ts
readonly newToken: boolean
```

True when validation requested NEW_TOKEN generation for the new path.

### constructor

```ts
constructor(type: string, init: {
  result: QuicPathValidationResult;
  path: QuicPath | null;
  previousPath?: QuicPath | null;
  preferredAddress?: boolean;
  newToken?: boolean;
})
```

Create an event carrying path-validation result and path details.

## QuicStream

```ts
class QuicStream extends EventTarget {
```

### id

```ts
readonly id: number
```

### direction

```ts
readonly direction: 'bidirectional' | 'unidirectional'
```

### reader

```ts
readonly reader: BytesReader
```

### writer

```ts
readonly writer: QuicBytesWriter
```

### constructor

```ts
constructor(
  id: number,
  direction: 'bidirectional' | 'unidirectional',
  connection: QuicConnection,
  incoming = false
)
```

### readable

```ts
get readable(): ReadableStream<Uint8Array>
```

### writable

```ts
get writable(): WritableStream<Uint8Array>
```

### stats

```ts
get stats(): QuicStreamStats
```

### reset

```ts
reset(errorCode: number): void
```

### stopSending

```ts
stopSending(errorCode: number): void
```

### _reserveWrite

```ts
_reserveWrite(buf: Uint8Array): void
```

### _queueWrite

```ts
_queueWrite(buf: Uint8Array, fin: boolean, earlyDataReserved = false): void
```

### _hasWritableSide

```ts
_hasWritableSide(): boolean
```

### _readFinReceived

```ts
_readFinReceived(): boolean
```

### _assertWritableSide

```ts
_assertWritableSide(): void
```

### _scheduleWriterFlush

```ts
_scheduleWriterFlush(callback: () => void): void
```

### _readIncoming

```ts
_readIncoming(maxBytes = 65536, signal?: AbortSignal | null): Promise<Uint8Array | null>
```

### _extendStreamReceiveCredit

```ts
_extendStreamReceiveCredit(bytes: number): void
```

### _extendConnectionReceiveCredit

```ts
_extendConnectionReceiveCredit(bytes: number): void
```

### _pushIncoming

```ts
_pushIncoming(offset: number, data: Uint8Array, fin: boolean): void
```

### _resetFromConnection

```ts
_resetFromConnection(errorCode: number): void
```

### _blockedFromConnection

```ts
_blockedFromConnection(): void
```

### _stopSendingFromConnection

```ts
_stopSendingFromConnection(errorCode: number): void
```

### _stopSendingSentFromConnection

```ts
_stopSendingSentFromConnection(errorCode: number): void
```

### _writerClosed

```ts
_writerClosed(): boolean
```

### _recordQueuedWrite

```ts
_recordQueuedWrite(bytes: number): void
```

### _recordAck

```ts
_recordAck(offset: number, datalen: number): void
```

### _closeFromConnection

```ts
_closeFromConnection(error?: Error): void
```

## QuicStreamBlockedEvent

```ts
class QuicStreamBlockedEvent extends Event {
```

### stream

```ts
readonly stream: QuicStream
```

Stream that was blocked by QUIC flow control.

### connection

```ts
readonly connection: QuicConnection
```

Owning QUIC connection.

### streamId

```ts
readonly streamId: number
```

Numeric QUIC stream identifier.

### constructor

```ts
constructor(type: string, init: {
  stream: QuicStream;
  connection: QuicConnection;
  streamId?: number;
})
```

Create an event carrying one flow-control blocked stream notification.

## QuicStreamResetEvent

```ts
class QuicStreamResetEvent extends Event {
```

### errorCode

```ts
readonly errorCode: number
```

Peer application error code carried by RESET_STREAM.

### error

```ts
readonly error: Error
```

Error object suitable for compatibility with existing error handlers.

### constructor

```ts
constructor(type: string, init: {
  errorCode: number;
  error?: Error;
})
```

Create an event carrying one RESET_STREAM application code.

## QuicStreamEvent

```ts
class QuicStreamEvent extends Event {
```

### stream

```ts
readonly stream: QuicStream
```

### constructor

```ts
constructor(type: string, init: {
  stream: QuicStream;
})
```

## QuicStopSendingEvent

```ts
class QuicStopSendingEvent extends Event {
```

### errorCode

```ts
readonly errorCode: number
```

Peer application error code carried by STOP_SENDING.

### error

```ts
readonly error: Error
```

Error object suitable for compatibility with existing error handlers.

### constructor

```ts
constructor(type: string, init: {
  errorCode: number;
  error?: Error;
})
```

Create an event carrying one peer STOP_SENDING application code.

## cryptoBackend

```ts
const cryptoBackend
```

## quicAvailable

```ts
const quicAvailable
```

## quicVersion

```ts
const quicVersion: string | null
```

## requireQuic

```ts
function requireQuic(): void
```

## QuicAddress

```ts
type QuicAddress = {
  family: 'ipv4' | 'ipv6';
  ip: string;
  port: number;
}
```

## QuicConnectOptions

```ts
interface QuicConnectOptions {
```

Client connection options. Unspecified values inherit endpoint defaults.

### address

```ts
address: QuicAddress
```

### alpnProtocols

```ts
alpnProtocols?: string[]
```

### serverName

```ts
serverName?: string
```

### verifyPeer

```ts
verifyPeer?: boolean
```

### certificateFile

```ts
certificateFile?: string
```

### privateKeyFile

```ts
privateKeyFile?: string
```

### ca

```ts
ca?: QuicCaOptions
```

### versions

```ts
versions?: QuicVersion[]
```

### tlsCipherSuites

```ts
tlsCipherSuites?: QuicTlsCipherSuite[]
```

### tlsGroups

```ts
tlsGroups?: string[]
```

### retry

```ts
retry?: QuicRetryOptions
```

### sessionStore

```ts
sessionStore?: QuicSessionStore
```

### earlyData

```ts
earlyData?: false | QuicEarlyDataPolicy
```

### migration

```ts
migration?: QuicMigrationOptions
```

### datagrams

```ts
datagrams?: QuicDatagramOptions
```

### connection

```ts
connection?: QuicConnectionOptions
```

### transport

```ts
transport?: QuicTransportOptions
```

### qlog

```ts
qlog?: QuicQlogOptions
```

### keylog

```ts
keylog?: QuicKeylogOptions
```

## QuicConnectionOptions

```ts
type QuicConnectionOptions = {
  handshakeTimeoutMs?: number;
  initialRttMs?: number;
  keepAliveTimeoutMs?: number;
  maxPayloadSize?: number;
  maxWindow?: number;
  maxStreamWindow?: number;
  unacknowledgedPacketThreshold?: number;
  congestionControl?: 'cubic' | 'reno' | 'bbr';
  drainingPeriodMultiplier?: number;
  streamIdleTimeoutMs?: number;
  maxIdleTimeoutMs?: number;
  initialMaxData?: number;
  initialMaxStreamDataBidiLocal?: number;
  initialMaxStreamDataBidiRemote?: number;
  initialMaxStreamDataUni?: number;
  initialMaxStreamsBidi?: number;
  initialMaxStreamsUni?: number;
  activeConnectionIdLimit?: number;
  maxAckDelayMs?: number;
  ackDelayExponent?: number;
  disableActiveMigration?: boolean;
  cidLength?: number;
}
```

Per-connection QUIC transport tuning.

## QuicConnectionStats

```ts
type QuicConnectionStats = {
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
}
```

## QuicDatagramOptions

```ts
type QuicDatagramOptions = {
  enabled?: boolean;
  maxFrameSize?: number;
  maxPending?: number;
  dropPolicy?: 'drop-oldest' | 'drop-newest';
  maxSendAttempts?: number;
}
```

QUIC DATAGRAM negotiation settings from RFC 9221.

## QuicDatagramStatus

```ts
type QuicDatagramStatus = 'ack' | 'lost' | 'abandoned'
```

Delivery state for a locally sent QUIC DATAGRAM frame.

## QuicEarlyDataPolicy

```ts
type QuicEarlyDataPolicy = {
  replaySafe: true;
  maxBytes?: number;
}
```

Explicit application policy required before sending replayable 0-RTT data.

## QuicEndpointOptions

```ts
interface QuicEndpointOptions {
```

Endpoint-wide defaults inherited by `listen()` and `connect()`.

### alpnProtocols

```ts
alpnProtocols?: string[]
```

### versions

```ts
versions?: QuicVersion[]
```

### tlsCipherSuites

```ts
tlsCipherSuites?: QuicTlsCipherSuite[]
```

### tlsGroups

```ts
tlsGroups?: string[]
```

### retry

```ts
retry?: QuicRetryOptions
```

### sessionStore

```ts
sessionStore?: QuicSessionStore
```

### earlyData

```ts
earlyData?: false | QuicEarlyDataPolicy
```

### migration

```ts
migration?: QuicMigrationOptions
```

### datagrams

```ts
datagrams?: QuicDatagramOptions
```

### connection

```ts
connection?: QuicConnectionOptions
```

### transport

```ts
transport?: QuicTransportOptions
```

### qlog

```ts
qlog?: QuicQlogOptions
```

### keylog

```ts
keylog?: QuicKeylogOptions
```

### socket

```ts
socket?: QuicSocketOptions
```

## QuicEndpointStats

```ts
type QuicEndpointStats = {
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
}
```

## QuicKeylogOptions

```ts
type QuicKeylogOptions = false | {
  path: string;
}
```

TLS keylog diagnostics configuration. Disabled by default.

## QuicListenOptions

```ts
interface QuicListenOptions {
```

Per-listener QUIC options. Unspecified values inherit endpoint defaults.

### address

```ts
address?: QuicAddress
```

### alpnProtocols

```ts
alpnProtocols?: string[]
```

### certificateFile

```ts
certificateFile?: string
```

### privateKeyFile

```ts
privateKeyFile?: string
```

### verifyClient

```ts
verifyClient?: boolean
```

### rejectUnauthorized

```ts
rejectUnauthorized?: boolean
```

### ca

```ts
ca?: QuicCaOptions
```

### sni

```ts
sni?: Record<string, QuicSNIContextOptions>
```

### versions

```ts
versions?: QuicVersion[]
```

### tlsCipherSuites

```ts
tlsCipherSuites?: QuicTlsCipherSuite[]
```

### tlsGroups

```ts
tlsGroups?: string[]
```

### retry

```ts
retry?: QuicRetryOptions
```

### sessionStore

```ts
sessionStore?: QuicSessionStore
```

### earlyData

```ts
earlyData?: false | QuicEarlyDataPolicy
```

### migration

```ts
migration?: QuicMigrationOptions
```

### datagrams

```ts
datagrams?: QuicDatagramOptions
```

### connection

```ts
connection?: QuicConnectionOptions
```

### transport

```ts
transport?: QuicTransportOptions
```

### qlog

```ts
qlog?: QuicQlogOptions
```

### keylog

```ts
keylog?: QuicKeylogOptions
```

## QuicMigrationOptions

```ts
type QuicMigrationOptions = {
  enabled?: boolean;
  preferredAddress?: QuicPreferredAddressOptions;
  usePreferredAddress?: boolean;
}
```

Connection migration policy. Disabled by default.

## QuicPath

```ts
type QuicPath = {
  localAddress: QuicAddress;
  remoteAddress: QuicAddress;
}
```

Local and remote socket addresses associated with a QUIC network path.

## QuicPathValidationResult

```ts
type QuicPathValidationResult = 'success' | 'failure' | 'aborted'
```

Result of an ngtcp2 path-validation attempt.

## QuicQlogOptions

```ts
type QuicQlogOptions = false | {
  path?: string;
  events?: string[];
}
```

qlog diagnostics configuration. Disabled by default.

## QuicRateLimitOptions

```ts
type QuicRateLimitOptions = false | {
  rate?: number;
  burst?: number;
}
```

Token-bucket rate limit configuration for endpoint packet defenses.

## QuicResolvedRateLimitOptions

```ts
type QuicResolvedRateLimitOptions = {
  readonly rate: number;
  readonly burst: number;
}
```

## QuicResolvedConnectionOptions

```ts
type QuicResolvedConnectionOptions = {
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
}
```

## QuicResolvedSourceAddressOptions

```ts
type QuicResolvedSourceAddressOptions = {
  readonly allow: readonly string[] | null;
  readonly deny: readonly string[];
}
```

## QuicResolvedTransportOptions

```ts
type QuicResolvedTransportOptions = {
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
}
```

## QuicRetryOptions

```ts
type QuicRetryOptions = false | {
  enabled: boolean;
  tokenSecret?: Uint8Array;
}
```

Server Retry and address-validation configuration. Enabled by default.

## QuicSessionState

```ts
type QuicSessionState = {
  ticket?: Uint8Array;
  addressToken?: Uint8Array;
  transportParameters?: Uint8Array;
  earlyDataMax?: number;
  version?: QuicVersion;
  expiresAt?: number;
}
```

Persisted TLS session material for future resumption and 0-RTT support.

## QuicSNIContextOptions

```ts
type QuicSNIContextOptions = {
  certificateFile: string;
  privateKeyFile: string;
  alpnProtocols?: string[];
  tlsGroups?: string[];
  verifyClient?: boolean;
  rejectUnauthorized?: boolean;
  ca?: QuicCaOptions;
}
```

## QuicSessionStore

```ts
interface QuicSessionStore {
```

Storage interface used by resumption and replay-checked 0-RTT policies.

### load

```ts
load(key: string): QuicSessionState | null | Promise<QuicSessionState | null>
```

Load a session by lookup key, or return `null` when no valid state exists.

### save

```ts
save(key: string, state: QuicSessionState): void | Promise<void>
```

Persist session state for a future connection attempt.

### delete

```ts
delete(key: string): void | Promise<void>
```

Delete a session after expiry, incompatibility, or application policy change.

## QuicSourceAddressOptions

```ts
type QuicSourceAddressOptions = {
  allow?: string[];
  deny?: string[];
}
```

Source-address allow/deny lists for incoming server packets.

## QuicStreamStats

```ts
type QuicStreamStats = {
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
}
```

## QuicTlsCipherSuite

```ts
type QuicTlsCipherSuite = 'TLS_AES_128_GCM_SHA256' | 'TLS_AES_256_GCM_SHA384' | 'TLS_CHACHA20_POLY1305_SHA256'
```

TLS 1.3 cipher suites that are compatible with QUIC packet protection.

## QuicTransportOptions

```ts
type QuicTransportOptions = {
  busy?: boolean;
  maxConnections?: number;
  maxConnectionsPerRemoteAddress?: number;
  sourceAddress?: QuicSourceAddressOptions;
  retryTokenTimeoutMs?: number;
  addressTokenTimeoutMs?: number;
  addressValidationCacheSize?: number;
  retryRateLimit?: QuicRateLimitOptions;
  versionNegotiationRateLimit?: QuicRateLimitOptions;
  statelessResetRateLimit?: QuicRateLimitOptions;
  immediateCloseRateLimit?: QuicRateLimitOptions;
  sessionCreationRateLimit?: QuicRateLimitOptions;
  disableStatelessReset?: boolean;
  ecn?: boolean;
}
```

Server-side QUIC transport controls and packet-defense tuning.

## QuicTransportParameterSnapshot

```ts
type QuicTransportParameterSnapshot = {
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
}
```

## QuicVersion

```ts
type QuicVersion = 'v1' | 'v2'
```

Supported QUIC wire versions accepted by public endpoint options.
