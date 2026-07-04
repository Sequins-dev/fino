---
weight: 15
---
# Server-Sent Events

Server-sent events (SSE) are a one-way push channel from server to client carried inside a regular HTTP response. The server sets `Content-Type: text/event-stream` and writes a sequence of text frames; the client reads them and fires events. SSE reconnects automatically when the connection drops and resumes from the last received event ID.

## SSE routes with app.sse()

The primary way to serve SSE is an `app.sse()` route. The handler receives an `EventSourceWriter` wired to the response body: the route responds with `text/event-stream` immediately, streams every event the handler writes, and ends the stream when the handler returns. The route matches both GET (for `EventSource` clients) and POST (for fetch-based clients that send a request body):

```ts
import { App } from 'fino:net/http/app';

const app = new App();

app.sse('/ticks', async (events, ctx) => {
  await events.write({ data: 'connected' });

  for (let i = 0; i < 5; i++) {
    await events.write({ event: 'tick', data: String(i), id: String(i) });
    await new Promise((r) => setTimeout(r, 1000));
  }
  await events.comment('stream complete');
});

app.listen({ port: 3000 });
```

A handler error terminates the stream. Middleware and context values compose the same way as other routes: `app.sse(path, ...middleware, handler)`.

## Sending SSE from a raw server handler

Under `serveHttp()` — or when a route needs response headers `app.sse()` does not set — use an async generator as the response body and format the event frames manually:

```ts
import { serveHttp } from 'fino:net/http/server';

serveHttp({ port: 3000 }, async (req) => {
  const enc = new TextEncoder();

  async function* events(): AsyncGenerator<Uint8Array> {
    yield enc.encode('data: connected\n\n');

    for (let i = 0; ; i++) {
      yield enc.encode(`id: ${i}\ndata: tick ${i}\n\n`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return new Response(events(), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'transfer-encoding': 'chunked',
    },
  });
});
```

The event wire format is straightforward: each event is one or more field lines followed by a blank line. The `data:` field carries the payload; `event:` names the event type (defaults to `"message"`); `id:` sets the last-event-ID the client sends on reconnect; `retry:` updates the client's reconnection interval in milliseconds.

## EventSourceWriter

`EventSourceWriter` from `fino:net/http/eventstream` handles the formatting so you don't have to write SSE frame syntax manually. It is the writer that `app.sse()` hands to route handlers; to use it directly, wrap any byte writer — the writer end of a `Channel` pairs naturally with a streaming response body:

```ts
import { EventSourceWriter } from 'fino:net/http/eventstream';
import { Channel } from 'fino:stream';

serveHttp({ port: 3000 }, (req) => {
  const channel = new Channel<Uint8Array>();
  const writer = new EventSourceWriter(channel.writer);

  (async () => {
    await writer.write({ data: 'connected' });
    for (let i = 0; i < 5; i++) {
      await writer.write({ event: 'tick', data: String(i), id: String(i) });
      await new Promise((r) => setTimeout(r, 1000));
    }
    await writer.comment('stream complete');
    await channel.writer.close();
  })();

  return new Response(channel.reader, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
    },
  });
});
```

`EventSourceWriter` provides `write(opts)` / `event(opts)` (aliases) for dispatching events, `comment(text)` for comment lines used as heartbeats, and `retry(ms)` for updating the client's reconnection interval without dispatching an event. Multi-line `data` strings are split into separate `data:` lines automatically.

## Parsing a POST-body SSE stream

Some APIs return SSE from POST endpoints rather than GET. The global `EventSource` only makes GET requests, so you need to parse the response body directly. `parseEventStream` wraps any async iterable of byte chunks and returns an `EventSourceReader`:

```ts
import { parseEventStream } from 'fino:net/http/eventstream';
import { HttpClient } from 'fino:net/http/client';

const client = new HttpClient({ baseUrl: 'https://api.example.com' });

const response = await client.request('/stream', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'hello' }),
  headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
});

for await (const event of parseEventStream(response.body!)) {
  if (event.type === 'message') {
    process.stdout.write(event.data);
  }
  if (event.type === 'done') break;
}
```

`parseEventStream` returns an `EventSourceReader` that is also an async iterator of `SseEvent` objects: `{ type, data, id, retry }`. The `type` defaults to `"message"` when the event stream omits the `event:` field.

## EventSourceReader directly

`EventSourceReader` is the underlying class that `parseEventStream` wraps. Use it directly when you need access to `lastEventId` after the stream closes, or when you want the `Reader` base interface methods (`close()`, `closed`, `[Symbol.asyncDispose]()`):

```ts
import { EventSourceReader } from 'fino:net/http/eventstream';

const reader = new EventSourceReader(response.body!);

for await (const event of reader) {
  console.log(event.type, event.data, event.id);
}

console.log('last event ID:', reader.lastEventId);
```

## Client-side EventSource

`EventSource` is a global — no import is needed. It opens an HTTP GET request, parses the SSE stream, dispatches events, and reconnects automatically after network errors, EOF, or retriable server status codes (429, 500–504):

```ts
const es = new EventSource('https://api.example.com/events');

es.onopen = () => console.log('connected');

es.onmessage = (event) => {
  console.log('message:', event.data);
};

es.addEventListener('update', (event) => {
  const data = JSON.parse((event as MessageEvent).data);
  console.log('update:', data);
});

es.onerror = () => console.log('error — will reconnect');

// Stop the connection
es.close();
```

Named events sent by the server with `event: update` arrive as `'update'` events on the client and are not caught by `onmessage`. The `lastEventId` property reflects the most recently received `id:` field and is sent as `Last-Event-ID` on reconnect.

The `EventSource` client can also be imported from `fino:net/http/eventsource` when an explicit import is needed (for example, in a module that needs the class reference for a type check or factory pattern).

## SSE vs WebSockets

SSE is better than WebSockets when the client only consumes data and never sends messages during the stream. SSE is a plain HTTP response: it works through caches and HTTP proxies that understand chunked encoding, reconnects automatically by spec, and requires no protocol upgrade handshake. Use WebSockets when the application needs to send messages in both directions after the connection is established.
