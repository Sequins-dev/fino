/**
* WebTransport global constructors.
*
* The WebTransport slice of the globals barrel. It re-exports the public
* WebTransport surface from `fino:net/http/webtransport` so that runtime
* bootstrap can install `WebTransport` and `WebTransportDatagramDuplexStream`
* as constructors on `globalThis`. That installation is what lets browser-style
* code reference the bare `WebTransport` constructor without an explicit
* import, matching the W3C object model.
*
* This module contains no logic of its own — every behavior (session setup over
* HTTP/3, datagrams, streams, certificate pinning, statistics) lives in
* `fino:net/http/webtransport`. Two of the re-exports are values: the
* `WebTransport` session class and the `WebTransportDatagramDuplexStream`
* datagram facade, which the globals registry pulls in and bootstrap
* registers as globals. The rest are type-only re-exports carrying the standard
* dictionary and statistics shapes (`WebTransportOptions`,
* `WebTransportCloseInfo`, `WebTransportHash`, the stream and stats types) for
* TypeScript consumers.
*
* Application code should not import this module by name. Use the installed
* globals directly, or import from `fino:net/http/webtransport` when you want an
* explicit dependency and access to the full type surface. The HTTP/3 driver
* wiring helpers in that module are `@internal` and are deliberately not
* re-exported here.
*
* WebTransport API: https://w3c.github.io/webtransport/
*
* ```ts no_run
* // Bootstrap installs these as globals; no import is needed at the call site.
* const transport = new WebTransport('https://example.test/session');
* await transport.ready;
*
* const writer = transport.datagrams.createWritable().getWriter();
* await writer.write(new Uint8Array([1, 2, 3]));
* writer.releaseLock();
*
* transport.close({ closeCode: 0, reason: 'done' });
* ```
*/
export {
  WebTransport,
  WebTransportDatagramDuplexStream,
  type WebTransportBidirectionalStream,
  type WebTransportCloseInfo,
  type WebTransportHash,
  type WebTransportOptions,
  type WebTransportReceiveStream,
  type WebTransportReceiveStreamStats,
  type WebTransportSendStream,
  type WebTransportSendStreamStats,
  type WebTransportStats
} from '../net/http/webtransport.ts';
