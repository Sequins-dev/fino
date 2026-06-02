# websocket

fino:net/http/websocket — WebSocket client and server.

Implements RFC 6455 in two composable layers:

## WebSocketConnection (lower-level engine)

Extends EventTarget. Handles framing, masking, UTF-8 validation, close
handshakes, PING/PONG, and subprotocol negotiation. Used directly by
server code or wrapped by the WHATWG `WebSocket` facade.

```ts
// CLIENT
const conn = WebSocketConnection.connect('wss://example.com/ws', {
  protocols: ['chat.v1'],
});
conn.addEventListener('open',    () => conn.send('hello'));
conn.addEventListener('message', (e) => console.log(e.data));
conn.addEventListener('close',   (e) => console.log(e.code));

// SERVER (inside a serve() handler)
import { serve } from 'fino:net/http/server';
import { WebSocketConnection } from 'fino:net/http/websocket';

serve({ port: 3000 }, (req) => {
  if (req.headers.get('upgrade') === 'websocket') {
    const ws = WebSocketConnection.accept(req, { protocol: 'chat.v1' });
    ws.addEventListener('message', (e) => ws.send(`echo: ${e.data}`));
    return ws;    // serve() writes the 101 and hands over the socket
  }
  return new Response('hello');
});
```

## WebSocket (WHATWG facade)

Strict spec-compliant global. Wraps a WebSocketConnection.
No extra methods — spec surface only.

```ts
const ws = new WebSocket('wss://example.com/ws', ['chat.v1']);
ws.binaryType = 'arraybuffer';
ws.onopen    = () => ws.send('hello');
ws.onmessage = (e) => console.log(e.data);
ws.onclose   = (e) => console.log('closed', e.code, e.wasClean);
```

## Close handshake

Both sides share the same handshake: the initiator sends a CLOSE frame,
the peer echoes one back, then the underlying socket is closed. A 5-second
timeout is applied after the initiator sends its CLOSE — if the peer does
not echo within that time, the socket is torn down unilaterally.

## Spec compliance (RFC 6455)

- RSV bits must be 0 (no extensions negotiated) → 1002
- Unknown/reserved opcodes → 1002
- Control frames must not be fragmented, payload ≤ 125 → 1002
- Client→server frames must be masked; server→client must not → 1002
- CONTINUATION without an active fragment → 1002
- New data frame during an active fragment → 1002
- Payload > maxPayloadSize (default 16 MiB) → 1009
- Invalid UTF-8 in TEXT messages → 1007
- PING → automatic PONG with echoed payload

## CloseEvent

```ts
class CloseEvent extends Event {
```

WebSocket close event carrying close code, reason, and cleanliness.

Instances are dispatched for both protocol close handshakes and local
teardown. Code `1006` may be used internally to report abnormal closure.

```ts
ws.onclose = (event) => console.log(event.code, event.reason, event.wasClean);
```

### constructor

```ts
constructor(type: string, init?: CloseEventInit)
```

Create a close event.

Missing fields default to code `0`, empty reason, and `wasClean: false`.

```ts
const event = new CloseEvent('close', { code: 1000, reason: 'done', wasClean: true });
```

### code

```ts
get code()
```

Close status code.

```ts
console.log(event.code);
```

### reason

```ts
get reason()
```

UTF-8 close reason string.

```ts
console.log(event.reason);
```

### wasClean

```ts
get wasClean()
```

Whether the close handshake completed cleanly.

```ts
console.log(event.wasClean);
```

## ErrorEvent

```ts
class ErrorEvent extends Event {
```

WebSocket error event carrying the underlying error value when available.

The `error` value may be any thrown value, or `null` when no concrete error
was captured.

```ts
ws.onerror = (event) => console.log(event.error);
```

### constructor

```ts
constructor(type: string, init?: {
  error?: unknown;
})
```

Create an error event.

```ts
const event = new ErrorEvent('error', { error: new Error('failed') });
```

### error

```ts
get error()
```

Underlying error value, or `null`.

```ts
console.log(event.error);
```

## WebSocketMessage

```ts
interface WebSocketMessage {
```

Parsed WebSocket message payload used by lower-level connection helpers.

Text messages expose a string. Binary messages expose raw bytes and are not
converted to Blob by `WebSocketConnection`.

```ts
for await (const message of conn) console.log(message.type, message.data);
```

### type

```ts
type: 'text' | 'binary'
```

Message kind.

```ts
if (message.type === 'binary') console.log(message.data);
```

### data

```ts
data: string | Uint8Array
```

Message payload.

```ts
if (message.type === 'text') console.log(message.data.toUpperCase());
```

## WebSocketAcceptOptions

```ts
interface WebSocketAcceptOptions {
```

Options used when accepting a WebSocket upgrade from an HTTP handler.

If both `protocol` and `selectProtocol` are omitted, no subprotocol is
selected. Invalid upgrade requests throw synchronously.

```ts
const conn = WebSocketConnection.accept(req, { protocol: 'chat.v1' });
```

### protocol

```ts
protocol?: string
```

Single subprotocol to accept; must be offered by the client when present.

```ts
WebSocketConnection.accept(req, { protocol: 'chat.v1' });
```

### selectProtocol

```ts
selectProtocol?: (offered: string[]) => string | null
```

Callback to select a subprotocol from the list offered by the client.

Return `null` to accept no subprotocol.

```ts
WebSocketConnection.accept(req, { selectProtocol: (offered) => offered[0] ?? null });
```

### maxPayloadSize

```ts
maxPayloadSize?: number
```

Maximum payload size in bytes; defaults to 16 MiB.

Frames exceeding this cause close code 1009.

```ts
WebSocketConnection.accept(req, { maxPayloadSize: 1024 * 1024 });
```

## WebSocketConnectOptions

```ts
interface WebSocketConnectOptions {
```

Options used when opening a WebSocket client connection.

Headers are added to the HTTP upgrade request. Duplicate protocol names throw
synchronously.

```ts
const conn = WebSocketConnection.connect('wss://example.com/ws', { protocols: ['chat.v1'] });
```

### protocols

```ts
protocols?: string | string[]
```

Requested subprotocols, joined as `Sec-WebSocket-Protocol`.

```ts
WebSocketConnection.connect(url, { protocols: ['chat.v1', 'chat.v2'] });
```

### headers

```ts
headers?: Record<string, string> | Headers
```

Extra request headers sent with the upgrade request.

```ts
WebSocketConnection.connect(url, { headers: { authorization: 'Bearer token' } });
```

### maxPayloadSize

```ts
maxPayloadSize?: number
```

Maximum incoming payload size in bytes; defaults to 16 MiB.

```ts
WebSocketConnection.connect(url, { maxPayloadSize: 1024 * 1024 });
```

## WebSocketConnection

```ts
class WebSocketConnection extends EventTarget implements ConnectionTakeover {
```

A WebSocket connection, client or server side. Extends EventTarget.

Events dispatched: 'open', 'message' (MessageEvent), 'close' (CloseEvent),
'error' (ErrorEvent), 'ping', 'pong'.

Use the static factories:
  - `WebSocketConnection.connect(url, opts)` — client (async via events)
  - `WebSocketConnection.accept(req, opts)` — server (from a serve() handler)

```ts
const conn = WebSocketConnection.connect('wss://example.com/ws');
conn.onmessage = (event) => console.log(event.data);
```

### CONNECTING

```ts
static readonly CONNECTING
```

Ready state before the handshake completes.

```ts
if (conn.readyState === WebSocketConnection.CONNECTING) console.log('connecting');
```

### OPEN

```ts
static readonly OPEN
```

Ready state while messages may be sent.

```ts
if (conn.readyState === WebSocketConnection.OPEN) await conn.send('hello');
```

### CLOSING

```ts
static readonly CLOSING
```

Ready state after close has started.

```ts
if (conn.readyState === WebSocketConnection.CLOSING) console.log('closing');
```

### CLOSED

```ts
static readonly CLOSED
```

Ready state after the connection is closed.

```ts
if (conn.readyState === WebSocketConnection.CLOSED) console.log('closed');
```

### compatibleProtocols

```ts
readonly compatibleProtocols: ReadonlySet<string>
```

HTTP protocols this takeover can run under.

WebSocketConnection currently supports HTTP/1.1 upgrade takeovers.

```ts
console.log(conn.compatibleProtocols.has('http/1.1'));
```

### constructor

```ts
constructor()
```

Create an unconnected WebSocketConnection.

Prefer `connect()` or `accept()` because the constructor does not perform a
handshake or attach I/O.

```ts
const conn = new WebSocketConnection();
```

### role

```ts
get role(): 'client' | 'server'
```

Role: `client` sends masked frames; `server` sends unmasked frames.

```ts
console.log(conn.role);
```

### readyState

```ts
get readyState(): number
```

Current ready state.

```ts
console.log(conn.readyState);
```

### url

```ts
get url(): string
```

WebSocket URL string for this connection.

```ts
console.log(conn.url);
```

### protocol

```ts
get protocol(): string
```

Negotiated subprotocol, or an empty string.

```ts
console.log(conn.protocol || 'none');
```

### extensions

```ts
get extensions(): string
```

Negotiated extension string, currently always empty.

```ts
console.log(conn.extensions);
```

### bufferedAmount

```ts
get bufferedAmount(): number
```

Best-effort count of bytes queued for writing.

```ts
console.log(conn.bufferedAmount);
```

### socket

```ts
get socket(): Socket | null
```

The underlying socket, available once `open` fires and `null` before that.

```ts
conn.onopen = () => console.log(conn.socket?.fd);
```

### onopen

```ts
get onopen()
```

Callback for `open` events.

```ts
conn.onopen = () => conn.send('hello');
```

### onmessage

```ts
get onmessage()
```

Callback for `message` events.

```ts
conn.onmessage = (event) => console.log(event.data);
```

### onerror

```ts
get onerror()
```

Callback for `error` events.

```ts
conn.onerror = (event) => console.log(event.error);
```

### onclose

```ts
get onclose()
```

Callback for `close` events.

```ts
conn.onclose = (event) => console.log(event.code);
```

### onopen

```ts
set onopen(fn: ((e: Event) => void) | null)
```

Set the `open` callback, or `null` to clear it.

```ts
conn.onopen = null;
```

### onmessage

```ts
set onmessage(fn: ((e: MessageEvent) => void) | null)
```

Set the `message` callback, or `null` to clear it.

```ts
conn.onmessage = null;
```

### onerror

```ts
set onerror(fn: ((e: ErrorEvent) => void) | null)
```

Set the `error` callback, or `null` to clear it.

```ts
conn.onerror = null;
```

### onclose

```ts
set onclose(fn: ((e: CloseEvent) => void) | null)
```

Set the `close` callback, or `null` to clear it.

```ts
conn.onclose = null;
```

### send

```ts
send(data: string | ArrayBuffer | ArrayBufferView | Blob): Promise<void>
```

Send a text, binary, or Blob message.
Returns a Promise that resolves when the frame has been written.
Throws if readyState is CONNECTING; silently returns if CLOSING or CLOSED.

```ts
await conn.send('hello');
await conn.send(new Uint8Array([1, 2, 3]));
```

### ping

```ts
ping(data?: Uint8Array): Promise<void>
```

Send a PING control frame. The peer should respond with a PONG.
Payload must be ≤ 125 bytes.

```ts
await conn.ping(new Uint8Array([1]));
```

### pong

```ts
pong(data?: Uint8Array): Promise<void>
```

Send a PONG control frame.
Payload must be ≤ 125 bytes.

```ts
await conn.pong();
```

### close

```ts
async close(code: number = 1e3, reason: string = ''): Promise<void>
```

Initiate the WebSocket close handshake.

`code` defaults to 1000 and must be 1000 or 3000-4999. `reason` must encode
to at most 123 UTF-8 bytes. Resolves when the peer close arrives or the
close timeout tears down the socket.

```ts
await conn.close(1000, 'done');
```

### accept

```ts
static accept(req: {
  method: string;
  url: string;
  headers: Headers;
}, opts: WebSocketAcceptOptions = {}): WebSocketConnection
```

SERVER FACTORY — Synchronously validate an HTTP upgrade request and return
a WebSocketConnection in the CONNECTING state. The 'open' event fires after
serve() writes the 101 response and hands over the socket.

Throws a plain Error (name='SyntaxError') if the request is not a valid
WebSocket upgrade. The handler can catch this and return a 400 Response.

```ts
serve({ port: 3000 }, (req) => {
  if (req.headers.get('upgrade') === 'websocket') {
    const ws = WebSocketConnection.accept(req, { protocol: 'chat.v1' });
    ws.addEventListener('message', (e) => ws.send(`echo: ${e.data}`));
    return ws;
  }
  return new Response('hello');
});
```

### connect

```ts
static connect(url: string | URL, opts: WebSocketConnectOptions = {}): WebSocketConnection
```

CLIENT FACTORY — Open a WebSocket connection to a remote URL.
Returns a WebSocketConnection immediately in the CONNECTING state.
The 'open' event fires when the handshake completes; 'error' + 'close'
fire if the connection fails.

```ts
const ws = WebSocketConnection.connect('wss://example.com/chat', {
  protocols: ['chat.v1'],
});
ws.addEventListener('open',    () => ws.send('hello'));
ws.addEventListener('message', (e) => console.log(e.data));
```

## WebSocket

```ts
class WebSocket extends EventTarget {
```

WHATWG WebSocket — strict spec surface, no runtime extensions.

For server-side or lower-level control, use `WebSocketConnection` directly.

```ts
const ws = new WebSocket('wss://example.com/ws', ['chat.v1']);
ws.onopen = () => ws.send('hello');
```

### CONNECTING

```ts
static readonly CONNECTING
```

Ready state before the handshake completes.

```ts
if (ws.readyState === WebSocket.CONNECTING) console.log('connecting');
```

### OPEN

```ts
static readonly OPEN
```

Ready state while messages can be sent.

```ts
if (ws.readyState === WebSocket.OPEN) ws.send('hello');
```

### CLOSING

```ts
static readonly CLOSING
```

Ready state after close has started.

```ts
if (ws.readyState === WebSocket.CLOSING) console.log('closing');
```

### CLOSED

```ts
static readonly CLOSED
```

Ready state after the connection is closed.

```ts
if (ws.readyState === WebSocket.CLOSED) console.log('closed');
```

### constructor

```ts
constructor(url: string | URL, protocols?: string | string[])
```

Create a WebSocket and immediately start connecting.

`url` must use `ws:` or `wss:` and must not include a fragment. Duplicate
requested protocols throw synchronously through the underlying connection
factory.

```ts
const ws = new WebSocket('wss://example.com/chat', 'chat.v1');
```

### url

```ts
get url(): string
```

WebSocket URL string.

```ts
console.log(ws.url);
```

### readyState

```ts
get readyState(): number
```

Current ready state.

```ts
console.log(ws.readyState);
```

### bufferedAmount

```ts
get bufferedAmount(): number
```

Best-effort bytes queued for sending.

```ts
console.log(ws.bufferedAmount);
```

### extensions

```ts
get extensions(): string
```

Negotiated extensions, currently an empty string.

```ts
console.log(ws.extensions);
```

### protocol

```ts
get protocol(): string
```

Negotiated subprotocol, or an empty string.

```ts
console.log(ws.protocol);
```

### binaryType

```ts
get binaryType(): 'blob' | 'arraybuffer'
```

Binary message conversion mode.

Defaults to `blob`. Set to `arraybuffer` to receive binary messages as
ArrayBuffer values.

```ts
ws.binaryType = 'arraybuffer';
```

### binaryType

```ts
set binaryType(v: 'blob' | 'arraybuffer')
```

Set binary message conversion mode.

Throws `TypeError` for values other than `blob` or `arraybuffer`.

```ts
ws.binaryType = 'blob';
```

### onopen

```ts
get onopen()
```

Callback for `open` events.

```ts
ws.onopen = () => ws.send('hello');
```

### onmessage

```ts
get onmessage()
```

Callback for `message` events.

```ts
ws.onmessage = (event) => console.log(event.data);
```

### onerror

```ts
get onerror()
```

Callback for `error` events.

```ts
ws.onerror = (event) => console.log(event.error);
```

### onclose

```ts
get onclose()
```

Callback for `close` events.

```ts
ws.onclose = (event) => console.log(event.code);
```

### onopen

```ts
set onopen(fn: ((e: Event) => void) | null)
```

Set the `open` callback, or `null` to clear it.

```ts
ws.onopen = null;
```

### onmessage

```ts
set onmessage(fn: ((e: MessageEvent) => void) | null)
```

Set the `message` callback, or `null` to clear it.

```ts
ws.onmessage = null;
```

### onerror

```ts
set onerror(fn: ((e: ErrorEvent) => void) | null)
```

Set the `error` callback, or `null` to clear it.

```ts
ws.onerror = null;
```

### onclose

```ts
set onclose(fn: ((e: CloseEvent) => void) | null)
```

Set the `close` callback, or `null` to clear it.

```ts
ws.onclose = null;
```

### send

```ts
send(data: string | ArrayBuffer | ArrayBufferView | Blob): void
```

Queue data to be sent. Throws InvalidStateError if CONNECTING;
silently drops if CLOSING or CLOSED.

Errors after queuing are surfaced through `error` events, matching the
fire-and-forget WHATWG API shape.

```ts
ws.send('hello');
ws.send(new Uint8Array([1, 2, 3]));
```

### close

```ts
close(code: number = 1000, reason: string = ''): void
```

Initiate the close handshake.

`code` defaults to 1000 and must be 1000 or 3000-4999. `reason` must encode
to at most 123 UTF-8 bytes. Invalid values throw synchronously.

```ts
ws.close(1000, 'done');
```
