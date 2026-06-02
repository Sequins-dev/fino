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

## ServerResult

```ts
type ServerResult = Response | ConnectionTakeover
```

Value returned from an HTTP server handler.

## ServerHandler

```ts
type ServerHandler = (req: Request) => ServerResult | Promise<ServerResult>
```

Function invoked for each server-side HTTP request.

## ServerDriverOptions

```ts
interface ServerDriverOptions {
```

Shared server driver options supplied by `serve`.

### maxConcurrent

```ts
maxConcurrent: number
```

Max concurrent in-flight requests / streams.

### allowH2cUpgrade

```ts
allowH2cUpgrade?: boolean
```

If true, recognise the h2c Upgrade dance in H1 driver.

## ServerDriver

```ts
interface ServerDriver {
```

Server protocol driver contract for HTTP/1 and HTTP/2.

### run

```ts
run( reader: BytesReader, writer: BytesWriter, handler: ServerHandler, opts: ServerDriverOptions, ): Promise<void>
```

Process one accepted connection. Resolves when the connection is fully
closed (all in-flight requests done, buffers flushed).

## CancelSignal

```ts
interface CancelSignal {
```

Minimal abort signal contract accepted by client drivers.

### aborted

```ts
readonly aborted: boolean
```

### reason

```ts
readonly reason: unknown
```

### addEventListener

```ts
addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void
```

### removeEventListener

```ts
removeEventListener(type: string, fn: () => void): void
```

## ClientDriverOptions

```ts
interface ClientDriverOptions {
```

Shared client driver options supplied by fetch/pool callers.

### signal

```ts
signal: CancelSignal | null
```

## ClientDriver

```ts
interface ClientDriver {
```

Client protocol driver contract for HTTP/1 and HTTP/2.

### send

```ts
send( req: Request, reader: BytesReader, writer: BytesWriter, opts: ClientDriverOptions, ): Promise<Response>
```

Send one logical request on an already-connected reader/writer pair.
Resolves with the parsed Response. Does NOT close the connection — the
caller decides lifetime (for pooling).

### multiplexed

```ts
readonly multiplexed: boolean
```

True if the underlying connection supports multiple concurrent streams.

## ConnectionTakeover

```ts
interface ConnectionTakeover {
```

Interface for anything that hijacks a connection at the protocol level.
serve() detects `result instanceof ConnectionTakeover` via isConnectionTakeover()
and calls _takeOver(reader, writer).

Implementors declare compatibleProtocols. The h2 driver rejects takeovers
that do not include 'h2' with a stream RST_STREAM + INTERNAL_ERROR.

### compatibleProtocols

```ts
readonly compatibleProtocols: ReadonlySet<string>
```

Set of HTTP protocol versions this takeover is compatible with.

### _takeOver

```ts
_takeOver(reader: BytesReader, writer: BytesWriter): Promise<void>
```

Take ownership of the connection's reader/writer. Called by the server
driver after it has written any handshake response (e.g. "101 Switching
Protocols"). Resolves when the takeover is fully closed.

## isConnectionTakeover

```ts
function isConnectionTakeover(v: unknown): v is ConnectionTakeover
```

Duck-type check for ConnectionTakeover. Use instead of instanceof
since ConnectionTakeover is an interface.
