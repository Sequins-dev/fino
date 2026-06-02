# js/net/socket

fino:socket — POSIX socket API for TCP, UDP, and Unix domain sockets.

This module wraps the POSIX socket syscalls via `fino:ffi` and provides
both a low-level procedural API (raw fd integers) and a higher-level
`Socket` class with async `connect()` / `listen()` and a `split()` method
that divides a connection into independent `Reader` and `Writer` halves
(from `fino:stream`).

## Address families and address objects

Addresses are plain JS objects rather than classes. The `family` field
selects the address type:
  { family: 'ipv4', ip: '127.0.0.1', port: 8080 }
  { family: 'ipv6', ip: '::1',       port: 8080 }
  { family: 'unix', path: '/tmp/app.sock' }

`encodeAddr()` translates these to C `sockaddr_in` / `sockaddr_in6` /
`sockaddr_un` buffers using `inet_pton(3)` for IP parsing.
`decodeAddr()` is the reverse, using `inet_ntop(3)` for IP formatting.

## Platform differences in sockaddr layout

**macOS** struct sockaddr includes a `sa_len` byte at offset 0:
  offset 0: sa_len    (uint8)  — total size of the struct
  offset 1: sa_family (uint8)  — AF_INET / AF_INET6 / AF_UNIX

**Linux** struct sockaddr has no `sa_len` field:
  offset 0: sa_family (uint16 LE) — AF_INET / AF_INET6 / AF_UNIX

`writeFamily()` and `readFamily()` handle this difference. All `encodeAddr()`
and `decodeAddr()` code goes through these helpers.

## Non-blocking connect

`Socket.connect()` uses non-blocking sockets for async connection setup:
  1. Create a socket, set O_NONBLOCK.
  2. Call `connect()` — returns immediately with EINPROGRESS.
  3. `await loop.writable(lp, fd)` — suspend until the kernel signals
     that the connection attempt completed (success or failure).
  4. `getsockopt(fd, SOL_SOCKET, SO_ERROR)` — check the actual result.
     Zero means success; nonzero is an errno value.

This approach never blocks the Fino process, even for connections to remote
hosts that may be slow to respond.

## accept4 on Linux

Linux provides `accept4(2)` which sets `SOCK_NONBLOCK` on the accepted
socket atomically, avoiding a separate `fcntl(F_SETFL)` call. On macOS,
we call `accept(2)` followed by `setNonblocking(fd)`. The `accept` function
in this module handles the platform difference automatically.

## EAGAIN values differ by platform

When a non-blocking call would block, the kernel returns EAGAIN or
EWOULDBLOCK (same value on most platforms). But the numeric errno differs:
  Linux:  EAGAIN = 11  (returned as -11 from our FFI functions)
  macOS:  EAGAIN = 35  (returned as -35)

Similarly, EINPROGRESS is -115 on Linux and -36 on macOS. The errno
constants exported by this module use the correct values for the current
platform.

## Socket.split() and fd lifecycle

`Socket.split()` returns `[Reader, Writer]` that share the underlying fd.
The fd should only be `close()`d when both halves are done. The `onClose`
callbacks implement a reference-count of 2:
  - Reader's close: `shutdown(fd, SHUT_RD)` + decrement ref. This sends an
    EOF to any in-flight `read(2)` call, unblocking the Reader cleanly.
  - Writer's close: `shutdown(fd, SHUT_WR)` + decrement ref. This sends a
    TCP FIN to the remote peer.
  - When both have closed (ref reaches 0): `close(fd)` releases the fd.

`shutdown(SHUT_RD)` is a local operation — it doesn't send anything on the
wire; it just makes the read side of the socket return 0 (EOF) immediately.
`shutdown(SHUT_WR)` sends a FIN packet, signalling to the peer that we're
done sending but may still be reading.

## Server (Socket.listen)

`Socket.listen()` returns a plain object (not a class) with:
  - `accept()` — async function that awaits the next incoming connection
  - `close()` — closes the server socket
  - `[Symbol.asyncIterator]` — iterate incoming connections

The server socket is set non-blocking after `listen(2)`, and
`loop.readable()` is used to await the next connection before calling
`accept()`. If `accept()` returns null (spurious wakeup), the loop retries.

Unix domain sockets: `Socket.listen()` calls `unlink(path)` before `bind()`
to remove any stale socket file from a previous run.

## Contributing

- All socket fds must be set to non-blocking mode before use with the event
  loop. `setNonblocking()` is called automatically by `Socket.connect()` and
  `Socket.listen()`, but callers using the low-level API must call it
  themselves.
- `send()` and `recv()` are provided for connected sockets (TCP). For UDP,
  use `sendto()` and `recvfrom()`.
- `setsockopt()` with a boolean or number value writes a 4-byte little-endian
  int. For raw option buffers (e.g. `struct linger`), pass an ArrayBuffer.

## IPv4Address

```ts
interface IPv4Address {
```

IPv4 socket address.

### family

```ts
family: 'ipv4'
```

### ip

```ts
ip: string
```

### port

```ts
port: number
```

## IPv6Address

```ts
interface IPv6Address {
```

IPv6 socket address.

### family

```ts
family: 'ipv6'
```

### ip

```ts
ip: string
```

### port

```ts
port: number
```

## UnixAddress

```ts
interface UnixAddress {
```

Unix domain socket address.

### family

```ts
family: 'unix'
```

### path

```ts
path: string
```

## Address

```ts
type Address = IPv4Address | IPv6Address | UnixAddress
```

Supported socket address shapes.

## UnknownAddress

```ts
interface UnknownAddress {
```

Address returned when the native family is not recognized by this module.

### family

```ts
family: string
```

## ConnectOptions

```ts
interface ConnectOptions {
```

Options for high-level TCP connection setup.

### noDelay

```ts
noDelay?: boolean
```

## ListenOptions

```ts
interface ListenOptions {
```

Options for high-level server socket setup.

### reuseAddr

```ts
reuseAddr?: boolean
```

### reusePort

```ts
reusePort?: boolean
```

### backlog

```ts
backlog?: number
```

## Server

```ts
interface Server {
```

Server object returned by Socket.listen().

### fd

```ts
fd: number
```

### address

```ts
address: Address
```

### accept

```ts
accept(): Promise<Socket | null>
```

### close

```ts
close(): void
```

## AF_INET

```ts
const AF_INET
```

IPv4 address family constant.

## AF_INET6

```ts
const AF_INET6
```

IPv6 address family constant.

## AF_UNIX

```ts
const AF_UNIX
```

Unix domain socket address family constant.

## SOCK_STREAM

```ts
const SOCK_STREAM
```

Stream socket type, typically TCP.

## SOCK_DGRAM

```ts
const SOCK_DGRAM
```

Datagram socket type, typically UDP.

## SOCK_NONBLOCK

```ts
const SOCK_NONBLOCK
```

## IPPROTO_TCP

```ts
const IPPROTO_TCP
```

TCP protocol number.

## IPPROTO_UDP

```ts
const IPPROTO_UDP
```

UDP protocol number.

## SOL_SOCKET

```ts
const SOL_SOCKET
```

Socket option level for `setsockopt` and `getsockopt`.

## SO_REUSEADDR

```ts
const SO_REUSEADDR
```

Allow reusing a recently-bound local address.

## SO_REUSEPORT

```ts
const SO_REUSEPORT
```

Allow multiple listeners to share a local address where supported.

## SO_KEEPALIVE

```ts
const SO_KEEPALIVE
```

Enable TCP keepalive probes.

## SO_ERROR

```ts
const SO_ERROR
```

Socket option used to read pending connection errors.

## IPPROTO_TCP_LEVEL

```ts
const IPPROTO_TCP_LEVEL
```

TCP option level used with `setsockopt`.

## TCP_NODELAY

```ts
const TCP_NODELAY
```

Disable Nagle's algorithm for TCP sockets.

## SHUT_RD

```ts
const SHUT_RD
```

Shut down the read side of a socket.

## SHUT_WR

```ts
const SHUT_WR
```

Shut down the write side of a socket.

## SHUT_RDWR

```ts
const SHUT_RDWR
```

Shut down both sides of a socket.

## encodeAddr

```ts
function encodeAddr(addr: Address): { buf: ArrayBuffer; len: number }
```

Encode a JS socket address into a native `sockaddr` buffer and byte length.

## decodeAddr

```ts
function decodeAddr(buf: ArrayBuffer): Address | UnknownAddress
```

Decode a sockaddr ArrayBuffer into a JS address object.

## socket

```ts
function socket(family: number = AF_INET, type: number = SOCK_STREAM, protocol: number = 0): number
```

Create a socket.

## setNonblocking

```ts
function setNonblocking(fd: number): void
```

Set a socket to non-blocking mode via fcntl(F_SETFL, O_NONBLOCK).

## setsockopt

```ts
function setsockopt(fd: number, level: number, optname: number, value: boolean | number | ArrayBuffer): void
```

Set socket option. Value can be a boolean/number (written as 4-byte int)
or an ArrayBuffer for raw option data.

## getsockopt

```ts
function getsockopt(fd: number, level: number, optname: number, bufSize: number = 4): ArrayBuffer
```

Get socket option. Returns the raw ArrayBuffer (4 bytes for int options).

## getsockname

```ts
function getsockname(fd: number): Address | UnknownAddress
```

Return the local address currently bound to a socket fd.

## bind

```ts
function bind(fd: number, addr: Address): void
```

Bind a socket to an address.

## listen

```ts
function listen(fd: number, backlog: number = 128): void
```

Mark a socket as passive (server socket).

## accept

```ts
function accept(serverFd: number, setNonblock: boolean = true): { fd: number; addr: Address | UnknownAddress } | null
```

Accept a pending connection. Returns `{ fd, addr }`.
If the socket is non-blocking and no connection is pending, returns null.

On Linux, the accepted socket is made non-blocking atomically via accept4.

## connect

```ts
function connect(fd: number, addr: Address): number
```

Initiate a connection to a remote address.
For non-blocking sockets, returns -115 (EINPROGRESS) on Linux or
-36 (EINPROGRESS) on macOS — use fino:loop addWrite() to wait for
completion, then check SO_ERROR via getsockopt().

## send

```ts
function send(fd: number, data: Uint8Array | ArrayBuffer, flags: number = 0): number
```

Send data on a connected socket.

## recv

```ts
function recv(fd: number, maxBytes: number = 65536, flags: number = 0): Uint8Array | number | null
```

Receive data from a connected socket.

## sendto

```ts
function sendto(fd: number, data: Uint8Array | ArrayBuffer, destAddr: Address, flags: number = 0): number
```

Send a datagram to a specific address (UDP).

## recvfrom

```ts
function recvfrom(fd: number, maxBytes: number = 65536, flags: number = 0): { data: Uint8Array; addr: Address | UnknownAddress } | number
```

Receive a datagram (UDP). Returns `{ data, addr }` or null on EAGAIN.

## shutdown

```ts
function shutdown(fd: number, how: number = SHUT_RDWR): void
```

Shut down part or all of a socket connection.

## close

```ts
function close(fd: number): void
```

Close a socket.

## EAGAIN

```ts
const EAGAIN
```

Negative errno returned when a non-blocking operation would block.

## EINPROGRESS

```ts
const EINPROGRESS
```

Negative errno returned while a non-blocking connect is in progress.

## ECONNRESET

```ts
const ECONNRESET
```

Negative errno returned when a peer resets the connection.

## EPIPE

```ts
const EPIPE
```

Negative errno returned when writing to a closed pipe/socket.

## EADDRINUSE

```ts
const EADDRINUSE
```

Negative errno returned when a local address is already in use.

## ECONNREFUSED

```ts
const ECONNREFUSED
```

Negative errno returned when a remote endpoint refuses a connection.

## connectTcp

```ts
async function connectTcp(addr: Address, opts: ConnectOptions = {}): Promise<number>
```

Establish a non-blocking TCP connection and return the raw fd.
Used by both Socket.connect() and TlsSocket.connect() (in fino:tls)
to avoid duplicating the connect/SO_ERROR dance.

## Socket

```ts
class Socket {
```

A connected socket that can be split into independent Reader and Writer
halves. The underlying fd is closed automatically when both halves close.

Use the static factories rather than the constructor directly:

```ts
const sock = await Socket.connect(lp, { family: 'ipv4', ip: '…', port: 80 });
const server = Socket.listen(lp, { family: 'ipv6', ip: '::', port: 8080 });
```

### constructor

```ts
constructor(fd: number, remoteAddr: Address | null, localAddr: Address | null)
```

### fd

```ts
get fd()
```

Raw file descriptor — for advanced use with the low-level API.

### remoteAddress

```ts
get remoteAddress()
```

Remote address object, or null for server-side accepted sockets.

### localAddress

```ts
get localAddress()
```

Local address object, or null if not known.

### closed

```ts
get closed()
```

### split

```ts
split(): [BufferedBytesReader, BufferedBytesWriter]
```

Split into a [Reader, Writer] pair. The underlying fd is closed
automatically when both halves have been closed.

The Reader's close sends SHUT_RD (wakes any in-flight read with EOF).
The Writer's close sends SHUT_WR (sends FIN to the peer).

### close

```ts
close(): void
```

Immediately close the socket (both directions). Calls shutdown(SHUT_RDWR)
then close(fd). Idempotent.

### connect

```ts
static async connect(addr: Address, opts: ConnectOptions = {}): Promise<Socket>
```

### listen

```ts
static listen(addr: Address, opts: ListenOptions = {}): Server
```

Create a listening server. Returns a Server object that is an async
iterable of incoming Socket connections.

Supports IPv4, IPv6, and Unix domain sockets via `addr.family`.
