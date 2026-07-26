/**
 * fino:net/quic/endpoint — QUIC endpoint ownership and routing.
 *
 * This module exposes the endpoint object that owns UDP listeners, outbound
 * connection setup, and connection ID routing. Import
 * `fino:net/quic/connection`, `fino:net/quic/listener`, or
 * `fino:net/quic/stream` when code needs those class-specific public modules.
 *
 * ```ts no_run
 * import { QuicEndpoint } from 'fino:net/quic/endpoint';
 *
 * const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
 * const listener = await endpoint.listen({
 *   address: { family: 'ipv4', ip: '127.0.0.1', port: 4433 },
 * });
 *
 * await listener.close();
 * await endpoint.close();
 * ```
 */
export {
  CidRoutingTable,
  QuicEndpoint,
  __inspectQuicCallbackTable,
  __inspectQuicRuntimeTuning,
} from '../../internal/net/quic/core.ts';
