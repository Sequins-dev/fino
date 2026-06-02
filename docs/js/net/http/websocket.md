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

### constructor

```ts
constructor(type: string, init?: CloseEventInit)
```

### code

```ts
get code()
```

### reason

```ts
get reason()
```

### wasClean

```ts
get wasClean()
```

## ErrorEvent

```ts
class ErrorEvent extends Event {
```

WebSocket error event carrying the underlying error value when available.

### constructor

```ts
constructor(type: string, init?: { error?: unknown })
```

### error

```ts
get error()
```

## WebSocketMessage

```ts
interface WebSocketMessage {
```

Parsed WebSocket message payload used by lower-level connection helpers.

### type

```ts
type: 'text' | 'binary'
```

### data

```ts
data: string | Uint8Array
```

## WebSocketAcceptOptions

```ts
interface WebSocketAcceptOptions {
```

Options used when accepting a WebSocket upgrade from an HTTP handler.

### protocol

```ts
protocol?: string
```

Single subprotocol to accept (must appear in Sec-WebSocket-Protocol header).

### selectProtocol

```ts
selectProtocol?: (offered: string[]) => string | null
```

Callback to select a subprotocol from the list offered by the client.

### maxPayloadSize

```ts
maxPayloadSize?: number
```

Maximum payload size in bytes (default 16 MiB). Frames exceeding this cause close 1009.

## WebSocketConnectOptions

```ts
interface WebSocketConnectOptions {
```

Options used when opening a WebSocket client connection.

### protocols

```ts
protocols?: string | string[]
```

Requested subprotocols (joined as Sec-WebSocket-Protocol header).

### headers

```ts
headers?: Record<string, string> | Headers
```

Extra request headers sent with the upgrade request.

### maxPayloadSize

```ts
maxPayloadSize?: number
```

Maximum incoming payload size in bytes (default 16 MiB).

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

### CONNECTING

```ts
static readonly CONNECTING
```

### OPEN

```ts
static readonly OPEN
```

### CLOSING

```ts
static readonly CLOSING
```

### CLOSED

```ts
static readonly CLOSED
```

### compatibleProtocols

```ts
readonly compatibleProtocols: ReadonlySet<string>
```

### constructor

```ts
constructor()
```

### role

```ts
get role(): 'client' | 'server'
```

Role: 'client' sends masked frames; 'server' sends unmasked frames.

### readyState

```ts
get readyState(): number
```

### url

```ts
get url(): string
```

### protocol

```ts
get protocol(): string
```

### extensions

```ts
get extensions(): string
```

### bufferedAmount

```ts
get bufferedAmount(): number
```

### socket

```ts
get socket(): Socket | null
```

The underlying socket (available once 'open' fires, null before that).

### onopen

```ts
get onopen()
```

### onmessage

```ts
get onmessage()
```

### onerror

```ts
get onerror()
```

### onclose

```ts
get onclose()
```

### onopen

```ts
set onopen(fn: ((e: Event) => void) | null)
```

### onmessage

```ts
set onmessage(fn: ((e: MessageEvent) => void) | null)
```

### onerror

```ts
set onerror(fn: ((e: ErrorEvent) => void) | null)
```

### onclose

```ts
set onclose(fn: ((e: CloseEvent) => void) | null)
```

### send

```ts
send(data: string | ArrayBuffer | ArrayBufferView | Blob): Promise<void>
```

Send a text, binary, or Blob message.
Returns a Promise that resolves when the frame has been written.
Throws if readyState is CONNECTING; silently returns if CLOSING or CLOSED.

### ping

```ts
ping(data?: Uint8Array): Promise<void>
```

Send a PING control frame. The peer should respond with a PONG.
Payload must be ≤ 125 bytes.

### pong

```ts
pong(data?: Uint8Array): Promise<void>
```

Send a PONG control frame.
Payload must be ≤ 125 bytes.

### close

```ts
async close(code: number = 1000, reason: string = ''): Promise<void>
```

Initiate the WebSocket close handshake.
Returns a Promise that resolves when the connection is fully closed.

### accept

```ts
static accept(req: { method: string; url: string; headers: Headers }, opts: WebSocketAcceptOptions = {}): WebSocketConnection
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

### CONNECTING

```ts
static readonly CONNECTING
```

### OPEN

```ts
static readonly OPEN
```

### CLOSING

```ts
static readonly CLOSING
```

### CLOSED

```ts
static readonly CLOSED
```

### constructor

```ts
constructor(url: string | URL, protocols?: string | string[])
```

### url

```ts
get url(): string
```

### readyState

```ts
get readyState(): number
```

### bufferedAmount

```ts
get bufferedAmount(): number
```

### extensions

```ts
get extensions(): string
```

### protocol

```ts
get protocol(): string
```

### binaryType

```ts
get binaryType(): 'blob' | 'arraybuffer'
```

### binaryType

```ts
set binaryType(v: 'blob' | 'arraybuffer')
```

### onopen

```ts
get onopen()
```

### onmessage

```ts
get onmessage()
```

### onerror

```ts
get onerror()
```

### onclose

```ts
get onclose()
```

### onopen

```ts
set onopen(fn: ((e: Event) => void) | null)
```

### onmessage

```ts
set onmessage(fn: ((e: MessageEvent) => void) | null)
```

### onerror

```ts
set onerror(fn: ((e: ErrorEvent) => void) | null)
```

### onclose

```ts
set onclose(fn: ((e: CloseEvent) => void) | null)
```

### send

```ts
send(data: string | ArrayBuffer | ArrayBufferView | Blob): void
```

Queue data to be sent. Throws InvalidStateError if CONNECTING;
silently drops if CLOSING or CLOSED.

### close

```ts
close(code: number = 1000, reason: string = ''): void
```

Initiate the close handshake.
