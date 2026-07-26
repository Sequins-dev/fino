/**
 * fino:net/quic/listener — QUIC listener lifecycle.
 *
 * A `QuicListener` is created by `QuicEndpoint.listen()` and owns the server
 * side of a UDP binding until closed. Accepted connections are still delivered
 * by the endpoint through `connection` events and `accept()`.
 *
 * ```ts no_run
 * import { QuicEndpoint } from 'fino:net/quic/endpoint';
 * import type { QuicListener } from 'fino:net/quic/listener';
 *
 * const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
 * const listener: QuicListener = await endpoint.listen({
 *   address: { family: 'ipv4', ip: '127.0.0.1', port: 4433 },
 * });
 *
 * await listener.close();
 * await endpoint.close();
 * ```
 */
export { QuicListener } from '../../internal/net/quic/listener.ts';
export type { QuicListenOptions, QuicSNIContextOptions } from '../../internal/net/quic/listener.ts';
