# driver

fino:net/http/driver — shared interfaces for HTTP server and client drivers.

Both H1ServerDriver and H2ServerDriver implement ServerDriver. Both
H1ClientDriver and H2ClientDriver implement ClientDriver. serve() and
fetch() dispatch to the right driver based on ALPN negotiation or h2c
preface detection.

ConnectionTakeover is the base class for protocol-level connection hijacks
(e.g. WebSocket). The h1 driver checks `result instanceof ConnectionTakeover`
and calls _takeOver(reader, writer). The h2 driver additionally checks
compatibleProtocols before allowing the upgrade.

```ts
import { isConnectionTakeover } from 'fino:net/http/driver';

const takeover = {
  compatibleProtocols: new Set(['http/1.1']),
  async _takeOver(reader, writer) {
    await writer.flush();
  },
};
if (isConnectionTakeover(takeover)) {
  console.log('takeover is compatible');
}
```

## ServerResult

```ts
type ServerResult = Response | ConnectionTakeover
```

Value returned from an HTTP server handler.

A normal `Response` is serialized by the active protocol driver. A
`ConnectionTakeover` transfers the underlying connection to another protocol
such as WebSocket.

```ts
const result: ServerResult = new Response('ok');
```

## ServerHandler

```ts
type ServerHandler = (req: Request) => ServerResult | Promise<ServerResult>
```

Function invoked for each server-side HTTP request.

The handler may be async. Throwing lets the driver produce a generic 500 for
HTTP/1; application-level error shaping should happen in middleware.

```ts
const handler: ServerHandler = async (req) => new Response(req.method);
```

## ServerDriverOptions

```ts
interface ServerDriverOptions {
```

Shared server driver options supplied by `serve`.

```ts
const opts: ServerDriverOptions = { maxConcurrent: 32, allowH2cUpgrade: true };
```

### maxConcurrent

```ts
maxConcurrent: number
```

Max concurrent in-flight requests or HTTP/2 streams.

```ts
const opts = { maxConcurrent: 16 };
```

### allowH2cUpgrade

```ts
allowH2cUpgrade?: boolean
```

If true, recognize the h2c Upgrade dance in the H1 driver.

```ts
const opts = { maxConcurrent: 32, allowH2cUpgrade: true };
```

## ServerDriver

```ts
interface ServerDriver {
```

Server protocol driver contract for HTTP/1 and HTTP/2.

Drivers own one accepted connection until it is closed, upgraded, or fails.

```ts
await driver.run(reader, writer, handler, { maxConcurrent: 32 });
```

### run

```ts
run( reader: BytesReader, writer: BytesWriter, handler: ServerHandler, opts: ServerDriverOptions, ): Promise<void>
```

Process one accepted connection. Resolves when the connection is fully
closed (all in-flight requests done, buffers flushed).

```ts
await driver.run(reader, writer, async () => new Response('ok'), { maxConcurrent: 8 });
```

## CancelSignal

```ts
interface CancelSignal {
```

Minimal abort signal contract accepted by client drivers.

This mirrors the `AbortSignal` surface used by HTTP client code without
depending on a specific global implementation.

```ts
const signal: CancelSignal | null = controller.signal;
```

### aborted

```ts
readonly aborted: boolean
```

True once cancellation has been requested.

```ts
if (signal.aborted) throw signal.reason;
```

### reason

```ts
readonly reason: unknown
```

Cancellation reason propagated to rejected driver operations.

```ts
console.log(signal.reason);
```

### addEventListener

```ts
addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void
```

Subscribe to cancellation events.

```ts
signal.addEventListener('abort', onAbort, { once: true });
```

### removeEventListener

```ts
removeEventListener(type: string, fn: () => void): void
```

Remove a cancellation listener.

```ts
signal.removeEventListener('abort', onAbort);
```

## ClientDriverOptions

```ts
interface ClientDriverOptions {
```

Shared client driver options supplied by fetch and pool callers.

```ts
const opts: ClientDriverOptions = { signal: null };
```

### signal

```ts
signal: CancelSignal | null
```

Optional cancellation signal; `null` disables abort racing.

```ts
await driver.send(req, reader, writer, { signal: null });
```

## ClientDriver

```ts
interface ClientDriver {
```

Client protocol driver contract for HTTP/1 and HTTP/2.

Drivers send one logical request over an already-open connection. Connection
pooling, DNS, TLS, redirects, and retries are handled by callers.

```ts
const res = await driver.send(req, reader, writer, { signal: null });
```

### send

```ts
send( req: Request, reader: BytesReader, writer: BytesWriter, opts: ClientDriverOptions, ): Promise<Response>
```

Send one logical request on an already-connected reader/writer pair.
Resolves with the parsed Response. Does NOT close the connection — the
caller decides lifetime (for pooling).

```ts
const response = await driver.send(request, reader, writer, { signal: null });
```

### multiplexed

```ts
readonly multiplexed: boolean
```

True if the underlying connection supports multiple concurrent streams.

```ts
if (driver.multiplexed) console.log('can share connection');
```

## ConnectionTakeover

```ts
interface ConnectionTakeover {
```

Interface for anything that hijacks a connection at the protocol level.
serve() detects `result instanceof ConnectionTakeover` via isConnectionTakeover()
and calls _takeOver(reader, writer).

Implementors declare compatibleProtocols. The h2 driver rejects takeovers
that do not include 'h2' with a stream RST_STREAM + INTERNAL_ERROR.

```ts
const takeover: ConnectionTakeover = WebSocketConnection.accept(req);
```

### compatibleProtocols

```ts
readonly compatibleProtocols: ReadonlySet<string>
```

Set of HTTP protocol versions this takeover is compatible with.

```ts
if (takeover.compatibleProtocols.has('http/1.1')) return takeover;
```

### _takeOver

```ts
_takeOver(reader: BytesReader, writer: BytesWriter): Promise<void>
```

Take ownership of the connection's reader/writer. Called by the server
driver after it has written any handshake response (e.g. "101 Switching
Protocols"). Resolves when the takeover is fully closed.

```ts
await takeover._takeOver(reader, writer);
```

## isConnectionTakeover

```ts
function isConnectionTakeover(v: unknown): v is ConnectionTakeover
```

Duck-type check for ConnectionTakeover. Use instead of instanceof
since ConnectionTakeover is an interface.

Returns `true` only for objects with a function `_takeOver` and a Set-valued
`compatibleProtocols`. It does not validate protocol names.

```ts
if (isConnectionTakeover(result)) return result;
```
