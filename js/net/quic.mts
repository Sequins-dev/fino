/**
 * fino:net/quic — low-level QUIC client and server endpoints.
 *
 * This module exposes QUIC as an EventTarget-first transport API. A
 * `QuicEndpoint` owns one or more UDP listeners and delivers accepted
 * connections through both `connection` events and the pull-based `accept()`
 * method. Each `QuicConnection` similarly delivers incoming streams through
 * `stream` events and `acceptStream()`.
 *
 * Streams expose Web Streams as the primary public interface:
 * `QuicStream.readable` and `QuicStream.writable` move `Uint8Array` chunks.
 * The lower-level `reader` and `writer` properties expose Fino byte reader and
 * writer objects for code that needs direct structural reads or explicit write
 * control.
 *
 * Phase 1 is intentionally transport-level only. It does not implement HTTP/3,
 * QUIC DATAGRAM, 0-RTT, WebTransport, qlog, migration, or GSO. The default
 * ALPN for local HQ validation fixtures is `fino-hq`.
 *
 * ```ts no_run
 * import { QuicEndpoint } from 'fino:net/quic';
 *
 * const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
 * const listener = await endpoint.listen({
 *   address: { family: 'ipv4', ip: '127.0.0.1', port: 4433 },
 * });
 *
 * endpoint.addEventListener('connection', async (event) => {
 *   const stream = await event.connection.acceptStream();
 *   await stream.writer.write(new TextEncoder().encode('ok'));
 * });
 *
 * await listener.close();
 * await endpoint.close();
 * ```
 */

export {
  CidRoutingTable,
  QuicConnection,
  QuicConnectionEvent,
  QuicEndpoint,
  QuicErrorEvent,
  QuicListener,
  QuicStream,
  QuicStreamEvent,
  cryptoBackend,
  quicAvailable,
  quicVersion,
  requireQuic,
  type QuicAddress,
  type QuicConnectOptions,
  type QuicConnectionState,
  type QuicEndpointOptions,
  type QuicListenOptions,
} from '../internal/net/quic/endpoint.mts';
