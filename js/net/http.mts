/**
 * fino:net/http — public HTTP API barrel.
 *
 * This module gathers the stable public HTTP APIs: server helpers, reusable
 * clients, application routing, Server-Sent Events, WebSockets, and raw
 * request/response parse and serialize helpers. Fetch-compatible `Headers`,
 * `Request`, and `Response` are globals. Protocol drivers and implementation
 * modules live behind `internal:net/http/*`.
 *
 * Learn more:
 * - Fetch: https://fetch.spec.whatwg.org/
 * - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
 * - Server-Sent Events: https://html.spec.whatwg.org/multipage/server-sent-events.html
 * - WebSocket: https://websockets.spec.whatwg.org/
 * - WebTransport: https://w3c.github.io/webtransport/
 */

export * from './http/app.mts';
export * from './http/client.mts';
export * from '../globals/eventsource.mts';
export * from './http/server.mts';
export * from '../globals/websocket.mts';
export * from './http/webtransport.mts';

export {
  parseRequest,
  parseResponse,
  serializeRequest,
  serializeResponse,
} from './http/index.mts';
