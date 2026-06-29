---
weight: 14
---
# WebSockets

fino implements WebSockets (RFC 6455) in two composable layers. `WebSocket` is the WHATWG-compatible global, matching the browser API. `WebSocketConnection` from `fino:net/http/websocket` is the lower-level engine used both server-side and client-side, with an event-target interface and an async iterator.

## Client-side WebSocket

`WebSocket` is a global — no import is needed. It mirrors the browser API:

```ts
const ws = new WebSocket('wss://example.com/chat', ['chat.v1']);

ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  ws.send('hello');
};

ws.onmessage = (event) => {
  console.log('received:', event.data);
};

ws.onclose = (event) => {
  console.log('closed:', event.code, event.reason, event.wasClean);
};

ws.onerror = (event) => {
  console.error('error:', event);
};

// Later:
ws.close(1000, 'done');
```

`ws.send()` accepts strings, `ArrayBuffer`, typed arrays, and `Blob`. Binary messages arrive as `ArrayBuffer` when `binaryType` is `'arraybuffer'` (the default is `'blob'`). Sending before the connection opens throws `InvalidStateError`.

## Server-side WebSocket with serve

The `serve()` handler receives an `IncomingWebSocketRequest` when a client sends a WebSocket upgrade. Call `accept()` to get a `WebSocketConnection` and let it drive the upgrade handshake; call `reject()` to send an error response:

```ts
import { serve } from 'fino:net/http/server';
import type { WebSocketConnection } from 'fino:net/http/websocket';

const server = serve({ port: 3000 }, async (incoming) => {
  if (incoming.kind !== 'websocket') {
    const accepted = await incoming.accept();
    await accepted.respond(new Response('upgrade required', { status: 426 }));
    return;
  }

  const subprotocols = incoming.subprotocols; // offered by client
  const ws: WebSocketConnection = await incoming.accept({ protocol: 'chat.v1' });

  ws.addEventListener('open', () => {
    ws.send('welcome');
  });

  ws.addEventListener('message', (e) => {
    const msg = (e as MessageEvent).data;
    ws.send(`echo: ${msg}`);
  });
});
```

`accept()` takes an optional `WebSocketAcceptOptions`:

- `protocol` — the subprotocol to negotiate; throws if the client did not offer it
- `selectProtocol` — callback that picks from the offered list
- `maxPayloadSize` — limit per frame in bytes; oversized frames close with code 1009

If neither `protocol` nor `selectProtocol` is provided, no subprotocol is negotiated.

## Server-side WebSocket with App

`app.websocket()` from `fino:net/http/app` is a higher-level alternative when you already use the router:

```ts
import { App } from 'fino:net/http/app';

const app = new App();

app.websocket('/chat/:room', async (socket, ctx) => {
  const room = ctx.params?.room;
  socket.addEventListener('message', (e) => {
    socket.send(`[${room}] ${(e as MessageEvent).data}`);
  });
});

app.listen({ port: 3000 });
```

App middleware runs before the WebSocket handler; producers declared with `.value()` populate the context before the handler receives the socket.

## Message handling

`WebSocketConnection` fires events via `addEventListener` and also supports async iteration:

```ts
// Event-based
ws.addEventListener('message', (e) => {
  const event = e as MessageEvent;
  if (typeof event.data === 'string') {
    console.log('text:', event.data);
  } else {
    console.log('binary:', (event.data as Uint8Array).byteLength, 'bytes');
  }
});

// Async iteration
for await (const message of ws) {
  // message: { type: 'text' | 'binary', data: string | Uint8Array }
  if (message.type === 'text') {
    ws.send(message.data.toUpperCase());
  }
}
```

`ws.ping()` sends a PING frame; the peer responds with a PONG automatically. `ws.pong()` sends a PONG without waiting for a PING.

## The close handshake

Both sides share the same close sequence: the initiator sends a CLOSE frame, the peer echoes one back, then the underlying socket is torn down. `ws.close(code, reason)` starts the handshake from the local side. It resolves when the peer's echo arrives or a 5-second timeout tears the socket down:

```ts
await ws.close(1000, 'done');
```

Valid close codes are 1000 or in the range 3000–4999. Reasons must encode to at most 123 UTF-8 bytes. The `CloseEvent` on the `close` event carries the final `code`, `reason`, and `wasClean` flag.

## Event types

`CloseEvent`, `ErrorEvent`, and `WebSocketError` can be imported from `fino:net/http/websocket` for type checks:

```ts
import { CloseEvent, ErrorEvent, WebSocketError } from 'fino:net/http/websocket';

ws.addEventListener('close', (e) => {
  const closeEvt = e as CloseEvent;
  console.log(closeEvt.code, closeEvt.reason, closeEvt.wasClean);
});

ws.addEventListener('error', (e) => {
  const errEvt = e as ErrorEvent;
  console.error(errEvt.error);
});
```

`WebSocketError` is used by the stream API and carries a `closeCode` and `reason`. It extends `DOMException` with name `'WebSocketError'`.

## WebSocket vs server-sent events

Use WebSockets when the connection must carry messages in both directions — client pushes commands, server pushes responses or events. Use server-sent events (SSE) when only the server needs to push data; SSE is simpler because it is a plain HTTP response, reconnects automatically, and works through HTTP proxies that buffer WebSocket traffic.

WebSockets in fino currently require HTTP/1.1 Upgrade. HTTP/2 Extended CONNECT (RFC 8441) and WebSocket over HTTP/3 are deferred. If a WebSocket upgrade arrives over an HTTP/2 connection, the server rejects it.
