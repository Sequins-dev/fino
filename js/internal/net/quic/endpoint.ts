/**
 * internal:net/quic/endpoint — QUIC endpoint public-internal entry point.
 *
 * This module preserves the historical `internal:net/quic/endpoint` specifier
 * while the QUIC object model is split into focused modules. Import
 * `internal:net/quic/connection`, `internal:net/quic/listener`, or
 * `internal:net/quic/stream` when code needs a class-specific dependency.
 *
 * @internal
 */
export {
  CidRoutingTable,
  QuicEndpoint,
  quicAvailable,
  quicResetStreamAtAvailable,
  cryptoBackend,
  quicVersion,
  requireQuic,
  __inspectQuicCallbackTable,
  __inspectQuicRuntimeTuning,
  quicBytesWriterInternals,
  quicConnectionInternals,
  quicEndpointInternals,
  quicIncomingStreamHook,
  quicListenerInternals,
  quicStreamInternals,
} from './core.ts';
export type {
  QuicAddress,
  QuicCaOptions,
  QuicConnectOptions,
  QuicConnectionOptions,
  QuicConnectionState,
  QuicConnectionStats,
  QuicDatagramOptions,
  QuicDatagramStatus,
  QuicEarlyDataPolicy,
  QuicEndpointInternals,
  QuicEndpointOptions,
  QuicEndpointStats,
  QuicKeylogOptions,
  QuicListenOptions,
  QuicMigrationOptions,
  QuicPath,
  QuicPathValidationResult,
  QuicQlogOptions,
  QuicRateLimitOptions,
  QuicResolvedConnectionOptions,
  QuicResolvedRateLimitOptions,
  QuicResolvedSourceAddressOptions,
  QuicResolvedTransportOptions,
  QuicRetryOptions,
  QuicSessionState,
  QuicSessionStore,
  QuicSNIContextOptions,
  QuicStreamOpenOptions,
  QuicSocketOptions,
  QuicSourceAddressOptions,
  QuicTlsCipherSuite,
  QuicTransportOptions,
  QuicTransportParameterSnapshot,
  QuicVersion,
} from './core.ts';
export {
  QuicConnectionEvent,
  QuicDatagramEvent,
  QuicDatagramStatusEvent,
  QuicEarlyDataEvent,
  QuicErrorEvent,
  QuicNewTokenEvent,
  QuicPathValidationEvent,
  QuicStopSendingEvent,
  QuicStreamBlockedEvent,
  QuicStreamEvent,
  QuicStreamResetEvent,
  QuicVersionNegotiationError,
} from './core.ts';
