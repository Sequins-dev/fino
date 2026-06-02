# eventsource

fino:net/http/eventsource — Server-Sent Events (SSE) client and server.

Implements the SSE wire protocol (W3C EventSource spec) in two composable
layers, following the same thin-primitive philosophy as fino:stream and
fino:http.

## EventSourceReader (composable parser primitive)

Wraps any async iterable of byte chunks and yields parsed SSE events.
No connection or reconnection logic — purely a wire-format parser, analogous
to how `parseResponse()` consumes a byte stream.

```ts
import { EventSourceReader } from './eventsource.mts';

const reader = new EventSourceReader(response.body);
for await (const event of reader) {
  // event: { type, data, id, retry }
}
reader.lastEventId; // persists across all events in the stream
```

## EventSourceWriter (composable formatter primitive)

Formats and writes SSE events to any Writer (from fino:stream).
Server-side counterpart to EventSourceReader.

```ts
import { EventSourceWriter } from './eventsource.mts';

const esw = new EventSourceWriter(writer);
await esw.event({ data: 'hello' });
await esw.event({ event: 'update', data: 'multi\nline', id: '42' });
await esw.comment('keep-alive');
await esw.retry(5000);
```

## EventSource (spec-compliant SSE client)

Full W3C EventSource with connection management, automatic reconnection with
Last-Event-ID resumption, and EventTarget-based event dispatch. Extends
EventTarget so `addEventListener` / `removeEventListener` work as expected.

```ts
import { EventSource } from './eventsource.mts';

const es = new EventSource('http://localhost:3000/events');
es.onopen    = () => { ... };
es.onmessage = (e) => { console.log(e.data); };
es.onerror   = (e) => { ... };
es.addEventListener('update', (e) => { ... });
// later:
es.close();
```

## SSE wire format

Each event is one or more field lines followed by a blank line:
  event: <type>\n       ← optional; defaults to "message"
  data: <line1>\n
  data: <line2>\n       ← multi-line data: joined with "\n"
  id: <id>\n            ← optional; updates lastEventId buffer
  retry: <ms>\n         ← optional; integer ms reconnection interval
  \n                    ← blank line dispatches the event

Lines starting with `:` are comments (ignored). Unknown field names are
ignored. Line terminators: LF, CRLF, or bare CR (per W3C spec).

## EventSourceReader parser rules (W3C spec)

- `id:` field value must not contain null (U+0000); otherwise ignored.
- `retry:` value must be all ASCII digits; otherwise ignored.
- An empty `id:` field (i.e. `id:\n`) sets lastEventId to "".
- Events without any `data:` lines are not dispatched.
- A field name with no colon means the entire line is the field name and
  the value is empty string.
- A single leading space after the colon is stripped from field values.

## EventSource reconnection (W3C spec + pragmatic additions)

- Reconnects on: EOF (stream ended normally), network errors, and HTTP
  status codes 429, 500, 502, 503, 504 (retriable errors).
- Does NOT reconnect on: wrong Content-Type, other HTTP error statuses.
- HTTP 204 closes the stream gracefully without reconnecting.
- Reconnection uses a configurable retry interval (default: 3000ms),
  updated dynamically by `retry:` fields in the event stream.
- The `Last-Event-ID` header is sent on every reconnect attempt if
  a non-empty last event ID has been seen.

## Contributing

- EventSourceReader is a single-use async iterator — do not call
  `[Symbol.asyncIterator]()` more than once on the same instance.
- EventSourceWriter does not own the Writer; callers are responsible

```ts
for closing it.
```

- EventSource connects immediately upon construction.
- Keep EventSourceReader and EventSourceWriter free of connection logic.
  Network concerns belong in EventSource only.

## SseEvent

```ts
interface SseEvent {
```

Parsed server-sent event yielded by `EventSourceReader`.

### type

```ts
type: string
```

### data

```ts
data: string
```

### id

```ts
id: string | null
```

### retry

```ts
retry: number | null
```

## EventSourceInit

```ts
interface EventSourceInit {
```

Options for the EventSource client connection.

### headers

```ts
headers?: Record<string, string> | Headers
```

## EventSourceReader

```ts
class EventSourceReader {
```

Parses an SSE byte stream into discrete events.

Accepts any async iterable of Uint8Array/ArrayBuffer chunks — e.g. a Reader
from fino:stream or an HTTP response body from fino:http.

Implements `[Symbol.asyncIterator]` for `for await` consumption.

```ts
const reader = new EventSourceReader(response.body);
for await (const event of reader) {
  console.log(event.type, event.data);
}
```

### constructor

```ts
constructor(source: AsyncIterable<Uint8Array | ArrayBuffer>)
```

### lastEventId

```ts
get lastEventId()
```

The last event ID seen in the stream. Updated as events are yielded,
so it reflects the ID of the most recently yielded event that had an
`id:` field. Persists across all events in the stream.

## EventSourceWriter

```ts
class EventSourceWriter {
```

Formats and writes SSE events to a Writer.

The writer must have an async `write(Uint8Array)` method compatible with
the Writer interface from fino:stream.

```ts
const esw = new EventSourceWriter(writer);
await esw.event({ data: 'hello' });
await esw.event({ event: 'update', data: 'line1\nline2', id: '42' });
await esw.comment('keep-alive');
await esw.retry(5000);
```

### constructor

```ts
constructor(writer: WriterLike)
```

### event

```ts
async event(opts: SseEventOptions): Promise<void>
```

Write an SSE event.

Multi-line `data` strings are automatically split into separate `data:`
lines. All fields are optional except `data`.

### comment

```ts
async comment(text: string = ''): Promise<void>
```

Write a comment line. Useful for keep-alive heartbeats that prevent
proxies from closing idle connections.

### retry

```ts
async retry(ms: number): Promise<void>
```

Write a standalone `retry:` field to update the client's reconnection
interval without dispatching an event.

## EventSource

```ts
class EventSource extends EventTarget {
```

W3C EventSource — a spec-compliant SSE client.

Manages its own HTTP connection (plain or TLS), handles reconnection with
exponential retry intervals, resumes from the last event ID, and dispatches
events through the EventTarget interface.

```ts
loop.run(async () => {
  const es = new EventSource('http://localhost:3000/events');
  es.onmessage = (e) => console.log(e.data);
  await someShutdownSignal;
  es.close();
});
```

### CONNECTING

```ts
static CONNECTING
```

### OPEN

```ts
static OPEN
```

### CLOSED

```ts
static CLOSED
```

### constructor

```ts
constructor(url: string, init?: EventSourceInit)
```

### readyState

```ts
get readyState()
```

Current ready state: CONNECTING (0), OPEN (1), or CLOSED (2).

### url

```ts
get url()
```

The URL passed to the constructor.

### lastEventId

```ts
get lastEventId()
```

The last event ID received from the server. Sent as Last-Event-ID on reconnect. Empty string before any id: field is received.

### onopen

```ts
get onopen()
```

Callback for `open` events (connection established).

### onopen

```ts
set onopen(fn: ((e: Event) => void) | null)
```

### onmessage

```ts
get onmessage()
```

Callback for `message` events (default-type SSE events).

### onmessage

```ts
set onmessage(fn: ((e: MessageEvent) => void) | null)
```

### onerror

```ts
get onerror()
```

Callback for `error` events (connection errors and fatal failures).

### onerror

```ts
set onerror(fn: ((e: Event) => void) | null)
```

### close

```ts
close()
```

Close the connection and prevent any further reconnection.
Idempotent — safe to call multiple times.
