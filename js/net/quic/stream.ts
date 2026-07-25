/**
* fino:net/quic/stream — bidirectional and unidirectional QUIC streams.
*
* A `QuicStream` exposes QUIC stream data through Web Streams and lower-level
* Fino byte reader and writer objects. Streams are created by
* `QuicConnection.openStream()` or accepted with
* `QuicConnection.acceptStream()`.
*
* ```ts no_run
* import type { QuicConnection } from 'fino:net/quic/connection';
* import type { QuicStream } from 'fino:net/quic/stream';
*
* export async function send(connection: QuicConnection, data: Uint8Array) {
*   const stream: QuicStream = await connection.openStream();
*   await stream.writer.write(data);
*   await stream.close();
* }
* ```
*/
export { QuicStream } from '../../internal/net/quic/stream.ts';
export type { QuicStreamStats } from '../../internal/net/quic/stream.ts';
