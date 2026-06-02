# js/net/tls

fino:tls — TLS socket layer.

`TlsSocket` extends `Socket` from `fino:socket`. TCP connection setup is
shared via `connectTcp()` — no duplication. TlsSocket overrides `split()`
to return `TlsReader`/`TlsWriter` (which handle SSL_read/SSL_write), and
overrides `close()` to perform SSL teardown before the fd close.

`TlsReader` and `TlsWriter` extend the base `Reader`/`Writer` from
`fino:stream`, implementing the template methods with SSL-specific I/O.
All loop machinery (readability waiting, retry, backpressure, async
iteration, pipe) is inherited — no duplication.

## TLS options

  {
    hostname: 'example.com',    // SNI + hostname verification
    ca: '/path/to/ca.pem',      // custom CA file (optional)
    rejectUnauthorized: true,   // verify peer cert (default: true)
  }

## Close coordination

When `split()` is used, both TlsReader and TlsWriter share the SSL* pointer.
When both halves close, SSL is shut down and freed, then the fd is closed via
`super.close()`. When `close()` is called directly (without splitting), SSL
teardown happens before calling `super.close()`.

## TlsConnectOptions

```ts
interface TlsConnectOptions extends ConnectOptions {
```

Options for opening or upgrading a TLS socket.

### hostname

```ts
hostname?: string
```

### ca

```ts
ca?: string
```

### rejectUnauthorized

```ts
rejectUnauthorized?: boolean
```

### alpn

```ts
alpn?: string[]
```

## TlsReader

```ts
class TlsReader extends BufferedBytesReader {
```

Read half of a TLS connection. Extends BufferedBytesReader with SSL-specific
I/O: uses SSL_read instead of read(2), checks SSL_pending before waiting
for fd readability, and classifies SSL error codes correctly.

Buffering, structural reads (readExactly, readUntil, etc.), and the async
iterator protocol are all inherited from BufferedBytesReader.

### constructor

```ts
constructor(ssl: object, fd: number, onClose: () => void | Promise<void>)
```

### fd

```ts
get fd(): number
```

### doPull

```ts
protected async doPull(): Promise<Uint8Array | null>
```

## TlsWriter

```ts
class TlsWriter extends BufferedBytesWriter {
```

Write half of a TLS connection. Extends BufferedBytesWriter with SSL-specific
I/O: uses SSL_write instead of write(2) and handles SSL_ERROR_WANT_READ
during TLS renegotiation.

Write coalescing, pipe(), and async close() are inherited from
BufferedBytesWriter.

### constructor

```ts
constructor(ssl: object, fd: number, onClose: () => void | Promise<void>)
```

### fd

```ts
get fd(): number
```

### doFlush

```ts
protected async doFlush(buf: Uint8Array): Promise<void>
```

## TlsSocket

```ts
class TlsSocket extends Socket {
```

A connected TLS socket. Extends `Socket` with SSL state.
TCP connection setup is shared with `Socket` via `connectTcp()`.
`split()` and `close()` are overridden to handle SSL teardown.

`tls instanceof Socket` is true.

Use the static factories rather than the constructor directly:

```ts
const tls = await TlsSocket.connect(lp, { family: 'ipv4', ip: '…', port: 443 });
const [reader, writer] = tls.split();
```

### constructor

```ts
constructor(fd: number, remoteAddr: Address | null, ssl: object, sslCtx: object | null)
```

### negotiatedProtocol

```ts
get negotiatedProtocol(): string | null
```

The ALPN protocol negotiated during the TLS handshake, or null if none.

### split

```ts
split(): [TlsReader, TlsWriter]
```

Split into a [TlsReader, TlsWriter] pair. SSL cleanup and fd close happen
automatically when both halves have been closed.

Note: TLS does not support half-close (no SHUT_RD/SHUT_WR per half).
Both sides must close before SSL_shutdown is issued.

### close

```ts
close()
```

Close both directions immediately. Performs SSL teardown, then delegates
fd cleanup to `Socket.close()`. Idempotent.

### connect

```ts
static async connect(addr: Address, opts: TlsConnectOptions = {}): Promise<TlsSocket>
```

Connect to a remote address over TLS.
Uses `connectTcp()` for the TCP layer (same helper as `Socket.connect()`),
then performs the TLS handshake.

### upgrade

```ts
static async upgrade(socket: Socket, opts: TlsConnectOptions = {}): Promise<TlsSocket>
```

Upgrade an existing connected Socket to TLS (client side).
The original Socket should not be used after this call.

### accept

```ts
static async accept(fd: number, sslCtx: object): Promise<TlsSocket>
```

Accept a TLS connection (server side) on an already-accepted TCP fd.

### _handshakeClient

```ts
static async _handshakeClient(fd: number, remoteAddr: Address | null, hostname: string | null, opts: TlsConnectOptions): Promise<TlsSocket>
```
