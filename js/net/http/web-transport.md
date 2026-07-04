---
weight: 16
---
# WebTransport

WebTransport provides multiplexed, low-latency communication over HTTP/3. Unlike WebSockets — which are one TCP-backed channel per connection — WebTransport runs over QUIC and exposes multiple independent streams and unreliable datagrams within a single session. This makes it well-suited for applications where head-of-line blocking is a problem: gaming, real-time telemetry, media delivery.

WebTransport requires HTTP/3 and QUIC, which in turn requires a valid TLS certificate. Plain HTTP or HTTP/2 cannot carry WebTransport.

## Client-side WebTransport

`WebTransport` from `fino:net/http/webtransport` mirrors the W3C WebTransport interface. Construct it with an `https:` URL; `ready` resolves when the HTTP/3 extended CONNECT handshake completes:

```ts
import { WebTransport } from 'fino:net/http/webtransport';

const wt = new WebTransport('https://example.com/session');
await wt.ready;
```

The constructor returns immediately in the `connecting` state. Await `wt.ready` before using streams or datagrams. If setup fails, `wt.ready` rejects and `wt.closed` rejects with the same error.

## Bidirectional streams

Bidirectional streams carry ordered, reliable, independent byte sequences:

```ts
const bidi = await wt.createBidirectionalStream();

// Write to the stream
const writer = bidi.writable.getWriter();
await writer.write(new TextEncoder().encode('hello'));
await writer.close();
writer.releaseLock();

// Read from the stream
const reader = bidi.readable.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log('received:', new TextDecoder().decode(value));
}
reader.releaseLock();
```

The server can also open streams; incoming bidirectional streams arrive on `wt.incomingBidirectionalStreams`:

```ts
const biReader = wt.incomingBidirectionalStreams.getReader();
const { value: incomingStream } = await biReader.read();
biReader.releaseLock();
```

## Unidirectional streams

Unidirectional streams carry data in one direction only. The client creates outgoing send streams; incoming receive streams arrive from the server:

```ts
// Outgoing send stream (client → server)
const sendStream = await wt.createUnidirectionalStream();
const writer = sendStream.getWriter();
await writer.write(new Uint8Array([1, 2, 3]));
await writer.close();
writer.releaseLock();

// Incoming receive streams (server → client)
const uniReader = wt.incomingUnidirectionalStreams.getReader();
const { value: receiveStream } = await uniReader.read();
const rdr = receiveStream.getReader();
const { value: chunk } = await rdr.read();
rdr.releaseLock();
uniReader.releaseLock();
```

## Datagrams

Datagrams are unreliable and unordered, but low-latency. Use them for data where a dropped packet is better than a delayed one:

```ts
// Send a datagram
const datagramWriter = wt.datagrams.createWritable().getWriter();
await datagramWriter.write(new Uint8Array([0x01, 0x02, 0x03]));
datagramWriter.releaseLock();

// Receive datagrams
const datagramReader = wt.datagrams.readable.getReader();
while (true) {
  const { done, value } = await datagramReader.read();
  if (done) break;
  console.log('datagram:', value);
}
datagramReader.releaseLock();
```

`wt.datagrams.maxDatagramSize` reflects the maximum payload size; writing a datagram larger than this throws `RangeError`.

## Closing the session

`wt.close()` initiates a clean shutdown with an optional application close code and human-readable reason:

```ts
wt.close({ closeCode: 0, reason: 'done' });
```

`wt.closed` resolves with `{ closeCode, reason }` when the session ends cleanly, and rejects when it ends due to a transport error. `wt.draining` resolves when the session enters the draining state before full close.

`wt.getStats()` returns a snapshot of datagram and byte counters:

```ts
const stats = await wt.getStats();
console.log(stats.datagramsSent, stats.datagramsReceived, stats.bytesSent, stats.bytesReceived);
```

## Server-side WebTransport

On the server, WebTransport sessions arrive through `serve()` as `IncomingWebTransportRequest` incoming values. The `kind` discriminant is `'webtransport'`. Call `accept()` to get the live `WebTransport` session:

```ts
import { serve } from 'fino:net/http/server';
import type { WebTransport } from 'fino:net/http/webtransport';

serve({
  port: 443,
  tls: { cert: './server.crt', key: './server.key' },
  h3: true,
}, async (incoming) => {
  if (incoming.kind !== 'webtransport') {
    await incoming.reject();
    return;
  }

  const session: WebTransport = await incoming.accept();

  // Handle incoming bidirectional streams
  const reader = session.incomingBidirectionalStreams.getReader();
  const { value: bidi } = await reader.read();
  reader.releaseLock();

  if (bidi !== undefined) {
    const r = bidi.readable.getReader();
    const { value } = await r.read();
    r.releaseLock();

    const w = bidi.writable.getWriter();
    await w.write(value ?? new Uint8Array());
    await w.close();
    w.releaseLock();
  }

  session.close({ closeCode: 0, reason: 'finished' });
});
```

`IncomingWebTransportRequest` also exposes `protocols` — the list of application protocol tokens the client offered via `sec-webtransport-protocol`. Use these to select a subprotocol before calling `accept()`.

## Using App for WebTransport routes

`route().webtransport()` from `fino:net/http/app` registers a WebTransport operation. It is a terminal: branch middleware runs before the session is accepted. The session is already accepted when the handler is called:

```ts
import { App } from 'fino:net/http/app';

const app = new App();

app.route('/game').webtransport(async (session, ctx) => {
  await session.ready;
  const rdr = session.incomingBidirectionalStreams.getReader();
  // handle streams
});

app.listen({ port: 443, tls: { cert: './server.crt', key: './server.key' }, h3: true });
```

## HttpClient.webtransport

`HttpClient` from `fino:net/http/client` opens a WebTransport session through an H3 logical session, reusing the QUIC connection for all subsequent requests in that session:

```ts
import { HttpClient } from 'fino:net/http/client';

const client = new HttpClient({ baseUrl: 'https://example.com' });
const wt = await client.webtransport('/session', {
  protocols: ['game.v1'],
});
await wt.ready;
```

## Requirements

WebTransport requires:
- A TLS certificate on the server (`tls.cert` and `tls.key` in `ServeOptions`)
- `h3: true` in `ServeOptions` to open the HTTP/3 QUIC listener
- `https:` URLs on the client side
- libnghttp3 available at runtime (checked by `h3Available` internally)

When HTTP/3 is not available, `new WebTransport(url)` rejects `wt.ready` with a clear error.
