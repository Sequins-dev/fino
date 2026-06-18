# socket

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

```ts
import { Socket } from 'fino:socket';

const socket = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: 8080 });
const [reader, writer] = socket.split();
await writer.write(new TextEncoder().encode('ping'));
const reply = await reader.read();
```

## IPv4Address

```ts
interface IPv4Address {
```

IPv4 socket address.

Used with TCP and UDP helpers. `ip` must be a numeric IPv4 literal accepted
by `inet_pton`; hostnames are not resolved here.

```ts
const addr: IPv4Address = { family: 'ipv4', ip: '127.0.0.1', port: 8080 };
```

### family

```ts
family: 'ipv4'
```

Literal IPv4 family tag.

```ts
if (addr.family === 'ipv4') console.log(addr.ip);
```

### ip

```ts
ip: string
```

Numeric IPv4 address string.

```ts
const addr = { family: 'ipv4', ip: '0.0.0.0', port: 3000 } as const;
```

### port

```ts
port: number
```

TCP or UDP port number; encoded as an unsigned 16-bit network-order field.

```ts
console.log(addr.port);
```

## IPv6Address

```ts
interface IPv6Address {
```

IPv6 socket address.

`ip` must be a numeric IPv6 literal. Scope IDs are not represented in this
public shape and encode as zero.

```ts
const addr: IPv6Address = { family: 'ipv6', ip: '::1', port: 8080 };
```

### family

```ts
family: 'ipv6'
```

Literal IPv6 family tag.

```ts
if (addr.family === 'ipv6') console.log(addr.ip);
```

### ip

```ts
ip: string
```

Numeric IPv6 address string.

```ts
const loopback = { family: 'ipv6', ip: '::1', port: 3000 } as const;
```

### port

```ts
port: number
```

TCP or UDP port number.

```ts
console.log(addr.port);
```

## UnixAddress

```ts
interface UnixAddress {
```

Unix domain socket address.

Paths must fit the platform `sockaddr_un` limit after UTF-8 encoding and a
trailing NUL byte. `Socket.listen()` unlinks stale paths before binding.

```ts
const addr: UnixAddress = { family: 'unix', path: '/tmp/fino.sock' };
```

### family

```ts
family: 'unix'
```

Literal Unix-domain family tag.

```ts
if (addr.family === 'unix') console.log(addr.path);
```

### path

```ts
path: string
```

Filesystem path for the socket node.

```ts
const addr = { family: 'unix', path: '/tmp/app.sock' } as const;
```

## Address

```ts
type Address = IPv4Address | IPv6Address | UnixAddress
```

Supported socket address shapes accepted by high-level and low-level APIs.

```ts
const addr: Address = { family: 'ipv4', ip: '127.0.0.1', port: 80 };
```

## UnknownAddress

```ts
interface UnknownAddress {
```

Address returned when the native family is not recognized by this module.

This can appear when decoding a kernel-filled sockaddr with an address family
this module does not support.

```ts
const decoded = decodeAddr(raw);
if (decoded.family.startsWith('unknown')) console.log(decoded.family);
```

### family

```ts
family: string
```

String form such as `unknown(123)`.

```ts
console.log(addr.family);
```

## ConnectOptions

```ts
interface ConnectOptions {
```

Options for high-level TCP connection setup.

```ts
const fd = await connectTcp(addr, { noDelay: true });
```

### noDelay

```ts
noDelay?: boolean
```

Enable TCP_NODELAY after creating the socket.

```ts
await Socket.connect(addr, { noDelay: true });
```

## ListenOptions

```ts
interface ListenOptions {
```

Options for high-level server socket setup.

Defaults are `reuseAddr: true`, `reusePort: false`, and `backlog: 128` in the
high-level listener.

```ts
const server = Socket.listen({ family: 'ipv4', ip: '0.0.0.0', port: 3000 }, { backlog: 256 });
```

### reuseAddr

```ts
reuseAddr?: boolean
```

Set SO_REUSEADDR before bind.

```ts
Socket.listen(addr, { reuseAddr: true });
```

### reusePort

```ts
reusePort?: boolean
```

Set SO_REUSEPORT before bind where supported.

```ts
Socket.listen(addr, { reusePort: true });
```

### backlog

```ts
backlog?: number
```

Listen backlog passed to `listen(2)`.

```ts
Socket.listen(addr, { backlog: 512 });
```

## Server

```ts
interface Server {
```

Server object returned by `Socket.listen()`.

The server owns a non-blocking listening fd. `accept()` waits for a
connection and returns `null` only for a spurious non-blocking wakeup; async
iteration skips those nulls.

```ts
const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
for await (const conn of server) conn.close();
```

### fd

```ts
fd: number
```

Listening file descriptor.

```ts
console.log(server.fd);
```

### address

```ts
address: Address
```

Bound address, including the assigned port when port zero was used.

```ts
console.log(server.address);
```

### closed

```ts
readonly closed: boolean
```

Whether the listening fd has been closed.

### accept

```ts
accept(): Promise<Socket | null>
```

Accept the next connection, or `null` after a spurious wakeup.

```ts
const conn = await server.accept();
if (conn !== null) conn.close();
```

### close

```ts
close(): void
```

Close the listening fd. In-flight accepted sockets are not closed.

```ts
server.close();
```

## AF_INET

```ts
const AF_INET
```

IPv4 address family constant.

```ts
const fd = socket(AF_INET, SOCK_STREAM, 0);
```

## AF_INET6

```ts
const AF_INET6
```

IPv6 address family constant.

```ts
const fd = socket(AF_INET6, SOCK_STREAM, 0);
```

## AF_UNIX

```ts
const AF_UNIX
```

Unix domain socket address family constant.

```ts
const fd = socket(AF_UNIX, SOCK_STREAM, 0);
```

## SOCK_STREAM

```ts
const SOCK_STREAM
```

Stream socket type, typically TCP.

```ts
const fd = socket(AF_INET, SOCK_STREAM, 0);
```

## SOCK_DGRAM

```ts
const SOCK_DGRAM
```

Datagram socket type, typically UDP.

```ts
const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
```

## SOCK_NONBLOCK

```ts
const SOCK_NONBLOCK
```

Linux socket type flag for atomic non-blocking creation; zero elsewhere.

```ts
const type = SOCK_STREAM | SOCK_NONBLOCK;
```

## IPPROTO_TCP

```ts
const IPPROTO_TCP
```

TCP protocol number.

```ts
const fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
```

## IPPROTO_IP

```ts
const IPPROTO_IP
```

IPv4 option level used with setsockopt.

## IPPROTO_IPV6

```ts
const IPPROTO_IPV6
```

IPv6 option level used with setsockopt.

## IPPROTO_UDP

```ts
const IPPROTO_UDP
```

UDP protocol number.

```ts
const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
```

## SOL_SOCKET

```ts
const SOL_SOCKET
```

Socket option level for `setsockopt` and `getsockopt`.

```ts
setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, true);
```

## SO_REUSEADDR

```ts
const SO_REUSEADDR
```

Allow reusing a recently-bound local address.

```ts
setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, true);
```

## SO_REUSEPORT

```ts
const SO_REUSEPORT
```

Allow multiple listeners to share a local address where supported.

```ts
setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, true);
```

## SO_KEEPALIVE

```ts
const SO_KEEPALIVE
```

Enable TCP keepalive probes.

```ts
setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, true);
```

## SO_RCVBUF

```ts
const SO_RCVBUF
```

Receive buffer size socket option.

## SO_SNDBUF

```ts
const SO_SNDBUF
```

Send buffer size socket option.

## SO_ERROR

```ts
const SO_ERROR
```

Socket option used to read pending connection errors.

```ts
const errno = new DataView(getsockopt(fd, SOL_SOCKET, SO_ERROR)).getInt32(0, true);
```

## IPPROTO_TCP_LEVEL

```ts
const IPPROTO_TCP_LEVEL
```

TCP option level used with `setsockopt`.

```ts
setsockopt(fd, IPPROTO_TCP_LEVEL, TCP_NODELAY, true);
```

## TCP_NODELAY

```ts
const TCP_NODELAY
```

Disable Nagle's algorithm for TCP sockets.

```ts
setsockopt(fd, IPPROTO_TCP_LEVEL, TCP_NODELAY, true);
```

## IP_TTL

```ts
const IP_TTL
```

IPv4 unicast TTL option.

## IP_TOS

```ts
const IP_TOS
```

IPv4 type-of-service / traffic-class option.

## IP_RECVTOS

```ts
const IP_RECVTOS
```

IPv4 receive type-of-service ancillary-data option.

## IPV6_V6ONLY

```ts
const IPV6_V6ONLY
```

IPv6-only bind option.

## IPV6_UNICAST_HOPS

```ts
const IPV6_UNICAST_HOPS
```

IPv6 unicast hop-limit option.

## IPV6_RECVTCLASS

```ts
const IPV6_RECVTCLASS
```

IPv6 receive traffic-class ancillary-data option.

## IPV6_TCLASS

```ts
const IPV6_TCLASS
```

IPv6 traffic-class option.

## SHUT_RD

```ts
const SHUT_RD
```

Shut down the read side of a socket.

```ts
shutdown(fd, SHUT_RD);
```

## SHUT_WR

```ts
const SHUT_WR
```

Shut down the write side of a socket.

```ts
shutdown(fd, SHUT_WR);
```

## SHUT_RDWR

```ts
const SHUT_RDWR
```

Shut down both sides of a socket.

```ts
shutdown(fd, SHUT_RDWR);
```

## encodeAddr

```ts
function encodeAddr(addr: Address): {
  buf: ArrayBuffer;
  len: number;
}
```

Encode a JS socket address into a native `sockaddr` buffer and byte length.

Throws when IP literals fail `inet_pton`, Unix socket paths exceed the native
limit, or the address family is unknown. The returned buffer is ready for
`bind`, `connect`, or `sendto`.

```ts
const { buf, len } = encodeAddr({ family: 'ipv4', ip: '127.0.0.1', port: 80 });
```

## decodeAddr

```ts
function decodeAddr(buf: ArrayBuffer): Address | UnknownAddress
```

Decode a sockaddr ArrayBuffer into a JS address object.

Unknown native address families return `{ family: 'unknown(n)' }` instead of
throwing. IP addresses are formatted via `inet_ntop`.

```ts
const addr = decodeAddr(sockaddrBuffer);
console.log(addr.family);
```

## socket

```ts
function socket(family: number = AF_INET, type: number = SOCK_STREAM, protocol: number = 0): number
```

Create a socket.

Returns a raw file descriptor on success and throws when `socket(2)` fails.
Low-level callers should set non-blocking mode before integrating with the
event loop.

```ts
const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
close(fd);
```

## setNonblocking

```ts
function setNonblocking(fd: number): void
```

Set a socket to non-blocking mode via fcntl(F_SETFL, O_NONBLOCK).

Throws if either `fcntl` call fails. High-level `Socket.connect()` and
`Socket.listen()` call this automatically.

```ts
const fd = socket();
setNonblocking(fd);
```

## setsockopt

```ts
function setsockopt(
  fd: number,
  level: number,
  optname: number,
  value: boolean | number | ArrayBuffer
): void
```

Set socket option. Value can be a boolean/number (written as 4-byte int)
or an ArrayBuffer for raw option data.

Throws when `setsockopt(2)` fails. Boolean and number values are encoded as
little-endian 32-bit integers for common POSIX socket options.

```ts
setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, true);
```

## getsockopt

```ts
function getsockopt(fd: number, level: number, optname: number, bufSize: number = 4): ArrayBuffer
```

Get socket option. Returns the raw ArrayBuffer (4 bytes for int options).

Throws when `getsockopt(2)` fails. Interpret integer options with a
little-endian `DataView`.

```ts
const buf = getsockopt(fd, SOL_SOCKET, SO_ERROR);
const errno = new DataView(buf).getInt32(0, true);
```

## getsockname

```ts
function getsockname(fd: number): Address | UnknownAddress
```

Return the local address currently bound to a socket fd.

This is useful after binding port `0` to discover the assigned port. Unknown
address families are represented with `UnknownAddress`.

```ts
const addr = getsockname(fd);
console.log(addr);
```

## bind

```ts
function bind(fd: number, addr: Address): void
```

Bind a socket to an address.

Throws on native bind errors. When the address is already in use, the error
message includes the port when available.

```ts
bind(fd, { family: 'ipv4', ip: '127.0.0.1', port: 3000 });
```

## listen

```ts
function listen(fd: number, backlog: number = 128): void
```

Mark a socket as passive (server socket).

`backlog` defaults to 128. The socket must already be bound. Throws when
`listen(2)` fails.

```ts
listen(fd, 128);
```

## accept

```ts
function accept(serverFd: number, setNonblock: boolean = true): {
  fd: number;
  addr: Address | UnknownAddress;
} | null
```

Accept a pending connection. Returns `{ fd, addr }`.
If the socket is non-blocking and no connection is pending, returns null.

On Linux, the accepted socket is made non-blocking atomically via accept4.

Throws for accept errors other than EAGAIN/EWOULDBLOCK.

```ts
const accepted = accept(serverFd);
if (accepted !== null) close(accepted.fd);
```

## connect

```ts
function connect(fd: number, addr: Address): number
```

Initiate a connection to a remote address.
For non-blocking sockets, returns -115 (EINPROGRESS) on Linux or
-36 (EINPROGRESS) on macOS — use fino:loop addWrite() to wait for
completion, then check SO_ERROR via getsockopt().

```ts
const rc = connect(fd, { family: 'ipv4', ip: '127.0.0.1', port: 80 });
if (rc === EINPROGRESS) await loop.writable(fd);
```

## send

```ts
function send(fd: number, data: Uint8Array | ArrayBuffer, flags: number = 0): number
```

Send data on a connected socket.

Returns bytes sent or a negative errno. Short writes are possible and must be
handled by low-level callers.

```ts
const n = send(fd, new TextEncoder().encode('GET / HTTP/1.1\\r\\n\\r\\n'));
```

## recv

```ts
function recv(fd: number, maxBytes: number = 65536, flags: number = 0): Uint8Array | number | null
```

Receive data from a connected socket.

Returns `Uint8Array` bytes, `null` on EOF, or a negative errno on error. For
non-blocking fds, EAGAIN is returned as the platform-specific negative errno.

```ts
const chunk = recv(fd);
if (chunk === null) console.log('peer closed');
```

## sendto

```ts
function sendto(
  fd: number,
  data: Uint8Array | ArrayBuffer,
  destAddr: Address,
  flags: number = 0
): number
```

Send a datagram to a specific address (UDP).

Returns bytes sent or a negative errno. The socket does not need to be
connected.

```ts
sendto(fd, packet, { family: 'ipv4', ip: '8.8.8.8', port: 53 });
```

## sendmsgEcn

```ts
function sendmsgEcn(
  fd: number,
  data: Uint8Array | ArrayBuffer,
  destAddr: Address,
  ecn: number,
  flags: number = 0
): number
```

Send one UDP datagram with ECN traffic-class ancillary data.

The ECN value is masked to its low two bits. IPv4 sends `IP_TOS`; IPv6 sends
`IPV6_TCLASS`. Returns bytes sent or a negative errno.

```ts
sendmsgEcn(fd, packet, { family: 'ipv4', ip: '127.0.0.1', port: 4433 }, 2);
```

## SendmsgBatchPacket

```ts
type SendmsgBatchPacket = {
  data: Uint8Array | ArrayBuffer;
  dest: Address;
  ecn?: number;
}
```

## sendmmsgBatch

```ts
function sendmmsgBatch(fd: number, packets: SendmsgBatchPacket[], flags: number = 0): {
  sent: number;
  errno: number | null;
} | null
```

Send a batch of UDP datagrams with Linux `sendmmsg(2)`.

Returns `null` on platforms without `sendmmsg`, otherwise returns the number
of messages accepted by the kernel or a negative errno when none were sent.
Per-message ECN values are carried as ancillary traffic-class data.

## recvfrom

```ts
function recvfrom(fd: number, maxBytes: number = 65536, flags: number = 0): {
  data: Uint8Array;
  addr: Address | UnknownAddress;
} | number
```

Receive a datagram (UDP). Returns `{ data, addr }` or null on EAGAIN.

This implementation returns a negative errno for receive errors, including
EAGAIN, rather than `null`. Successful results include the sender address.

```ts
const packet = recvfrom(fd, 4096);
if (typeof packet !== 'number') console.log(packet.addr, packet.data);
```

## recvmsgEcn

```ts
function recvmsgEcn(fd: number, maxBytes: number = 65536, flags: number = 0): {
  data: Uint8Array;
  addr: Address | UnknownAddress;
  ecn?: number;
} | number
```

Receive one UDP datagram and parse ECN traffic-class ancillary data.

The socket must have `IP_RECVTOS` or `IPV6_RECVTCLASS` enabled first. The
returned `ecn` value is masked to the two ECN bits when present; kernels may
omit ancillary data for packets that arrived without a traffic-class mark.

```ts
setsockopt(fd, IPPROTO_IP, IP_RECVTOS, true);
const packet = recvmsgEcn(fd, 4096);
```

## recvmmsgBatch

```ts
function recvmmsgBatch(fd: number, maxPackets: number, maxBytes: number = 65536, flags: number = 0): Array<{
  data: Uint8Array;
  addr: Address | UnknownAddress;
  ecn?: number;
}> | number | null
```

Receive multiple UDP datagrams with Linux `recvmmsg(2)`.

Returns `null` on platforms without `recvmmsg`, a negative errno when no
packet was received, or an array of datagrams with optional ECN metadata.

## shutdown

```ts
function shutdown(fd: number, how: number = SHUT_RDWR): void
```

Shut down part or all of a socket connection.

Errors from `shutdown(2)` are ignored to keep close paths idempotent. Use
`SHUT_RD`, `SHUT_WR`, or `SHUT_RDWR`.

```ts
shutdown(fd, SHUT_WR);
```

## close

```ts
function close(fd: number): void
```

Close a socket.

Errors from `close(2)` are ignored. After calling this, the fd must not be
reused by user code.

```ts
close(fd);
```

## EAGAIN

```ts
const EAGAIN
```

Negative errno returned when a non-blocking operation would block.

```ts
if (recv(fd) === EAGAIN) await loop.readable(fd);
```

## EINPROGRESS

```ts
const EINPROGRESS
```

Negative errno returned while a non-blocking connect is in progress.

```ts
if (connect(fd, addr) === EINPROGRESS) await loop.writable(fd);
```

## ECONNRESET

```ts
const ECONNRESET
```

Negative errno returned when a peer resets the connection.

```ts
if (err === ECONNRESET) console.log('peer reset');
```

## EPIPE

```ts
const EPIPE
```

Negative errno returned when writing to a closed pipe/socket.

```ts
if (send(fd, bytes) === EPIPE) console.log('closed');
```

## EADDRINUSE

```ts
const EADDRINUSE
```

Negative errno returned when a local address is already in use.

```ts
if (rc === EADDRINUSE) console.log('address busy');
```

## ECONNREFUSED

```ts
const ECONNREFUSED
```

Negative errno returned when a remote endpoint refuses a connection.

```ts
if (rc === ECONNREFUSED) console.log('refused');
```

## connectTcp

```ts
async function connectTcp(addr: Address, opts: ConnectOptions = {}): Promise<number>
```

Establish a non-blocking TCP connection and return the raw fd.
Used by both Socket.connect() and TlsSocket.connect() (in fino:tls)
to avoid duplicating the connect/SO_ERROR dance.

Throws if socket creation, connection, or SO_ERROR checking fails. On error,
the temporary fd is closed before the error is rethrown.

```ts
const fd = await connectTcp({ family: 'ipv4', ip: '127.0.0.1', port: 80 }, { noDelay: true });
```

## Socket

```ts
class Socket {
```

A connected socket that can be split into independent Reader and Writer
halves. The underlying fd is closed automatically when both halves close.

Use the static factories rather than the constructor directly:

```ts
const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: 80 });
const server = Socket.listen({ family: 'ipv6', ip: '::', port: 8080 });
```

### constructor

```ts
constructor(fd: number, remoteAddr: Address | null, localAddr: Address | null)
```

Wrap an already-open socket fd.

The constructor does not set non-blocking mode and does not duplicate the
fd. Prefer `Socket.connect()` or `Socket.listen()` unless integrating with
a lower-level accept/connect path.

```ts
const sock = new Socket(fd, remoteAddr, localAddr);
```

### fd

```ts
get fd()
```

Raw file descriptor for advanced use with the low-level API.

```ts
console.log(socket.fd);
```

### remoteAddress

```ts
get remoteAddress()
```

Remote address object passed to `Socket.connect()`, or the peer address for
accepted sockets when known.

```ts
console.log(socket.remoteAddress);
```

### localAddress

```ts
get localAddress()
```

Local bound address when known.

Client sockets created by `Socket.connect()` currently expose `null`;
accepted sockets expose the listener address.

```ts
console.log(socket.localAddress);
```

### closed

```ts
get closed()
```

Whether `close()` has been called or both split halves have closed.

```ts
if (!socket.closed) socket.close();
```

### split

```ts
split(): [BufferedBytesReader, BufferedBytesWriter]
```

Split into a [Reader, Writer] pair. The underlying fd is closed
automatically when both halves have been closed.

The Reader's close sends SHUT_RD (wakes any in-flight read with EOF).
The Writer's close sends SHUT_WR (sends FIN to the peer).

```ts
const [reader, writer] = socket.split();
await writer.write(new TextEncoder().encode('hello'));
await writer.close();
await reader.close();
```

### close

```ts
close(): void
```

Immediately close the socket (both directions). Calls shutdown(SHUT_RDWR)
then close(fd). Idempotent.

```ts
socket.close();
socket.close();
```

### connect

```ts
static async connect(addr: Address, opts: ConnectOptions = {}): Promise<Socket>
```

Open a non-blocking TCP or Unix-domain client connection.

Resolves with a connected `Socket`. Throws on connection errors; temporary
fds are closed before the error is rethrown.

```ts
const socket = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: 80 }, { noDelay: true });
```

### listen

```ts
static listen(addr: Address, opts: ListenOptions = {}): Server
```

Create a listening server. Returns a Server object that is an async
iterable of incoming Socket connections.

Supports IPv4, IPv6, and Unix domain sockets via `addr.family`.

If `addr.port` is zero, the returned server address contains the assigned
port. Unix-domain paths are unlinked before binding. Throws if bind/listen
fails or if `getsockname()` returns an unsupported address family.

```ts
const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
const conn = await server.accept();
conn?.close();
server.close();
```
