/**
* fino:net/http — public HTTP API barrel.
*
* This module gathers the stable public HTTP APIs: server helpers (`serve`,
* `serveHttp`), reusable clients (`HttpClient`, `HttpSession`, `HttpResponse`),
* application routing (`App`), Server-Sent Events (`EventSource`), WebSockets
* (`WebSocket`, `WebSocketConnection`), WebTransport, and raw request/response
* parse and serialize helpers (`parseRequest`, `serializeResponse`, and the
* `Arena` backing them). Fetch-compatible `Headers`, `Request`, and `Response`
* are globals and are not re-exported here. Protocol drivers and implementation
* modules live behind `internal:net/http/*`.
*
* Import from this barrel when you want the ergonomic entry points without
* reaching into a specific submodule; the same symbols are also available from
* their home modules (`fino:net/http/server`, `fino:net/http/client`,
* `fino:net/http/app`, and so on) when a narrower import is preferable. All the
* named exports here are re-exports — the symbols are documented in the module
* that defines them.
*
* ```ts no_run
* import { serveHttp, HttpClient, App } from 'fino:net/http';
*
* // A minimal server: every request gets the same JSON response.
* const server = serveHttp({ port: 3000 }, (request) =>
*   Response.json({ method: request.method, url: request.url }));
*
* // A pooled client for making outbound requests.
* const client = new HttpClient();
* const res = await client.fetch('http://127.0.0.1:3000/health');
* console.log(res.status, await res.json());
*
* // A routed application when you need middleware and OpenAPI.
* const app = new App({ name: 'Example' });
* app.get('/hello').handle(() => new Response('hi'));
* app.listen({ port: 3001 });
*
* await server.close();
* ```
*
* Learn more:
* - Fetch: https://fetch.spec.whatwg.org/
* - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
* - Server-Sent Events: https://html.spec.whatwg.org/multipage/server-sent-events.html
* - WebSocket: https://websockets.spec.whatwg.org/
* - WebTransport: https://w3c.github.io/webtransport/
*/
export * from './http/app.ts';
export * from './http/client.ts';
export * from '../globals/eventsource.ts';
export * from './http/server.ts';
export * from './http/websocket.ts';
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
} from '../globals/webtransport.ts';
export { Arena, parseRequest, parseResponse, serializeRequest, serializeResponse } from './http/index.ts';
