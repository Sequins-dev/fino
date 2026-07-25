/**
* fino:net/quic/connection — QUIC connection state and stream creation.
*
* A `QuicConnection` represents one negotiated QUIC connection. It accepts
* inbound streams, opens outbound streams, sends datagrams when negotiated, and
* exposes connection lifecycle events through `EventTarget`.
*
* ```ts no_run
* import { QuicEndpoint } from 'fino:net/quic/endpoint';
* import type { QuicConnection } from 'fino:net/quic/connection';
*
* const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
* const connection: QuicConnection = await endpoint.connect({
*   address: { family: 'ipv4', ip: '127.0.0.1', port: 4433 },
*   serverName: 'localhost',
* });
*
* const stream = await connection.openStream();
* await stream.writer.write(new TextEncoder().encode('ping'));
* await connection.close();
* await endpoint.close();
* ```
*/
export { QuicConnection } from '../../internal/net/quic/connection.ts';
export type { QuicConnectionOptions, QuicConnectionState, QuicConnectionStats, QuicPeerVerification, QuicTransportParameterSnapshot } from '../../internal/net/quic/connection.ts';
