/**
 * fino:net/quic — low-level QUIC client and server endpoints.
 *
 * Learn more:
 * - QUIC transport: https://www.rfc-editor.org/rfc/rfc9000
 * - QUIC TLS mapping: https://www.rfc-editor.org/rfc/rfc9001
 * - QUIC loss detection and congestion control: https://www.rfc-editor.org/rfc/rfc9002
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
 * This is intentionally transport-level only and does not implement HTTP/3 or
 * WebTransport. Endpoints advertise `h3` by default so callers can build raw
 * HTTP/3-compatible transports, but no `fino:net/http` integration is performed
 * here. QUIC DATAGRAM and controlled key updates are exposed for lower protocol
 * work. Replay-sensitive features such as 0-RTT stay disabled unless callers
 * explicitly provide the required policy and storage.
 *
 * Release verification has required and gated lanes. Local QUIC loopback and
 * simulator tests are required for release builds. External ngtcp2 HQ interop,
 * Node QUIC interop via `NODE_QUIC_BIN`, and the loopback throughput benchmark
 * are gated lanes: they run when the corresponding tools or baseline binaries
 * are configured and otherwise skip explicitly.
 *
 * Deferred advanced scope remains visible but is not a release blocker: Node
 * DATAGRAM interop parity still depends on Node's experimental API shape,
 * resumed-session external interop is not proven by `NODE_QUIC_BIN`, and
 * active migration/version-negotiation external interop depends on peer
 * tooling. Backend-specific TLS constraints are explicit release scope:
 * OpenSSL-only SNI context and TLS group controls are tested, while GnuTLS
 * parity for those controls is deferred.
 *
 * ```ts no_run
 * import { QuicEndpoint } from 'fino:net/quic';
 *
 * const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
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
export * from './availability.ts';
export * from './connection.ts';
export * from './endpoint.ts';
export * from './events.ts';
export * from './listener.ts';
export * from './stream.ts';
export type * from './types.ts';
