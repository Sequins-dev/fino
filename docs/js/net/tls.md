# tls

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

```ts
import { TlsSocket } from 'fino:tls';

const socket = await TlsSocket.connect(
  { family: 'ipv4', ip: '93.184.216.34', port: 443 },
  { hostname: 'example.com', alpn: ['h2', 'http/1.1'] },
);
const [reader, writer] = socket.split();
```

## TlsConnectOptions

```ts
interface TlsConnectOptions extends ConnectOptions {
```

Options for opening or upgrading a TLS socket.

`rejectUnauthorized` defaults to `true`; pass `false` only for local testing
or explicitly trusted endpoints. `hostname` is used for SNI and certificate
verification when provided.

```ts
const tls = await TlsSocket.connect(addr, {
  hostname: 'example.com',
  alpn: ['h2', 'http/1.1'],
});
```

### hostname

```ts
hostname?: string
```

Hostname used for SNI and peer certificate checks.

```ts
await TlsSocket.connect(addr, { hostname: 'example.com' });
```

### ca

```ts
ca?: string
```

Path to a PEM CA bundle or file loaded with OpenSSL verify locations.

```ts
await TlsSocket.connect(addr, { hostname: 'internal.test', ca: '/etc/ssl/internal-ca.pem' });
```

### rejectUnauthorized

```ts
rejectUnauthorized?: boolean
```

Whether to verify the peer certificate; defaults to `true`.

```ts
await TlsSocket.connect(addr, { rejectUnauthorized: false });
```

### alpn

```ts
alpn?: string[]
```

ALPN protocol list offered by the client in preference order.

```ts
await TlsSocket.connect(addr, { hostname: 'example.com', alpn: ['h2', 'http/1.1'] });
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

```ts
const [reader] = tls.split();
const bytes = await reader.read();
```

### constructor

```ts
constructor(ssl: object, fd: number, onClose: () => void | Promise<void>)
```

Wrap OpenSSL state and a non-blocking fd as a TLS reader.

The reader does not own the SSL pointer by itself; the close callback
coordinates cleanup with the paired `TlsWriter`.

```ts
const reader = new TlsReader(ssl, fd, onClose);
```

### fd

```ts
get fd(): number
```

Underlying socket file descriptor.

```ts
console.log(reader.fd);
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

```ts
const [, writer] = tls.split();
await writer.write(new TextEncoder().encode('hello'));
await writer.flush();
```

### constructor

```ts
constructor(ssl: object, fd: number, onClose: () => void | Promise<void>)
```

Wrap OpenSSL state and a non-blocking fd as a TLS writer.

The writer shares SSL ownership with a `TlsReader`; cleanup runs through
the supplied close callback.

```ts
const writer = new TlsWriter(ssl, fd, onClose);
```

### fd

```ts
get fd(): number
```

Underlying socket file descriptor.

```ts
console.log(writer.fd);
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
const tls = await TlsSocket.connect({ family: 'ipv4', ip: '93.184.216.34', port: 443 }, { hostname: 'example.com' });
const [reader, writer] = tls.split();
```

### constructor

```ts
constructor(fd: number, remoteAddr: Address | null, ssl: object, sslCtx: object | null)
```

Wrap an established TLS session.

The constructor takes ownership of `ssl` and, when non-null, `sslCtx`.
Prefer `connect()`, `upgrade()`, or `accept()` so handshakes and cleanup
are coordinated.

```ts
const tls = new TlsSocket(fd, remoteAddr, ssl, sslCtx);
```

### negotiatedProtocol

```ts
get negotiatedProtocol(): string | null
```

The ALPN protocol negotiated during the TLS handshake, or `null` if none.

```ts
if (tls.negotiatedProtocol === 'h2') console.log('HTTP/2');
```

### split

```ts
split(): [TlsReader, TlsWriter]
```

Split into a [TlsReader, TlsWriter] pair. SSL cleanup and fd close happen
automatically when both halves have been closed.

Note: TLS does not support half-close (no SHUT_RD/SHUT_WR per half).
Both sides must close before SSL_shutdown is issued.

```ts
const [reader, writer] = tls.split();
await writer.close();
await reader.close();
```

### close

```ts
close()
```

Close both directions immediately. Performs SSL teardown, then delegates
fd cleanup to `Socket.close()`. Idempotent.

```ts
tls.close();
```

### connect

```ts
static async connect(addr: Address, opts: TlsConnectOptions = {}): Promise<TlsSocket>
```

Connect to a remote address over TLS.
Uses `connectTcp()` for the TCP layer (same helper as `Socket.connect()`),
then performs the TLS handshake.

Throws when OpenSSL is unavailable, TCP connection fails, certificate
verification fails, or the TLS handshake fails.

```ts
const tls = await TlsSocket.connect(addr, { hostname: 'example.com' });
```

### upgrade

```ts
static async upgrade(socket: Socket, opts: TlsConnectOptions = {}): Promise<TlsSocket>
```

Upgrade an existing connected Socket to TLS (client side).
The original Socket should not be used after this call.

On failure, the original socket fd remains caller-owned. This allows the
caller to decide whether to close or recover it.

```ts
const raw = await Socket.connect(addr);
const tls = await TlsSocket.upgrade(raw, { hostname: 'example.com' });
```

### accept

```ts
static async accept(fd: number, sslCtx: object): Promise<TlsSocket>
```

Accept a TLS connection (server side) on an already-accepted TCP fd.

`sslCtx` is borrowed from the server and is not freed by the returned
socket. On handshake failure, the SSL object is freed and the fd remains
caller-owned.

```ts
const tls = await TlsSocket.accept(fd, sslCtx);
```
