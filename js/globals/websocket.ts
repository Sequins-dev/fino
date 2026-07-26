/**
 * internal:globals/websocket — the WHATWG WebSocket global surface.
 *
 * This module is the aggregation point for the browser-compatible WebSocket
 * API. It re-exports four symbols and installs none of them itself: the
 * globals bootstrap (`internal:globals/global`) pulls them from here and binds
 * `WebSocket`, `CloseEvent`, and `ErrorEvent` onto `globalThis`, while
 * `MessageEvent` is shared with the messaging subsystem. Application code
 * should reach these through the globals rather than importing this specifier
 * directly.
 *
 * The re-exported surface is:
 *
 * - `WebSocket` — the client class. Constructing one opens a connection to a
 *   `ws:`/`wss:` URL and drives it through the standard `readyState` lifecycle
 *   (`CONNECTING` → `OPEN` → `CLOSING` → `CLOSED`), delivering frames as
 *   `message` events and dispatching `open`, `error`, and `close`.
 * - `CloseEvent` — dispatched as the `close` event; carries the numeric close
 *   `code`, the `reason` string, and whether the closing handshake was `clean`.
 * - `ErrorEvent` — dispatched as the `error` event when the connection fails.
 * - `MessageEvent` — the shared event type carrying inbound frame payloads on
 *   `event.data` (a string for text frames, a `Blob` or `ArrayBuffer` for
 *   binary frames per `binaryType`).
 *
 * The lower-level server/client engine (`WebSocketConnection`), the
 * `WebSocketError` type, and the accept/connect option interfaces live in
 * `fino:net/http/websocket`; server-side upgrades flow through the `serve()`
 * handler rather than through this global. Reach for this module's exports when
 * you want the portable, spec-shaped client; reach for the engine when you are
 * accepting or multiplexing connections on the server.
 *
 * WebSocket API: https://websockets.spec.whatwg.org/
 *
 * ```ts no_run
 * const ws = new WebSocket('wss://example.com/ws', ['chat.v1']);
 * ws.binaryType = 'arraybuffer';
 *
 * ws.onopen = () => ws.send('hello');
 * ws.onmessage = (event) => console.log('frame:', event.data);
 * ws.onerror = (event) => console.error('socket error:', event.message);
 * ws.onclose = (event) => console.log(`closed ${event.code}: ${event.reason}`);
 * ```
 */
export { WebSocket, CloseEvent, ErrorEvent } from '../net/http/websocket.ts';
export { MessageEvent } from './messaging.ts';
