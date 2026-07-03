/**
* fino:socket — POSIX socket API for TCP, UDP, and Unix domain sockets.
*
* This module wraps the POSIX socket syscalls via `fino:ffi` and provides
* both a low-level procedural API (raw fd integers) and a higher-level
* `Socket` class with async `connect()` / `listen()` and a `split()` method
* that divides a connection into independent `Reader` and `Writer` halves
* (from `fino:stream`).
*
*
* ## Address families and address objects
*
* Addresses are plain JS objects rather than classes. The `family` field
* selects the address type:
*   { family: 'ipv4', ip: '127.0.0.1', port: 8080 }
*   { family: 'ipv6', ip: '::1',       port: 8080, scopeId: 0 }
*   { family: 'unix', path: '/tmp/app.sock' }
*
* `encodeAddr()` translates these to C `sockaddr_in` / `sockaddr_in6` /
* `sockaddr_un` buffers using `inet_pton(3)` for IP parsing.
* `decodeAddr()` is the reverse, using `inet_ntop(3)` for IP formatting.
*
*
* ## Platform differences in sockaddr layout
*
* **macOS** struct sockaddr includes a `sa_len` byte at offset 0:
*   offset 0: sa_len    (uint8)  — total size of the struct
*   offset 1: sa_family (uint8)  — AF_INET / AF_INET6 / AF_UNIX
*
* **Linux** struct sockaddr has no `sa_len` field:
*   offset 0: sa_family (uint16 LE) — AF_INET / AF_INET6 / AF_UNIX
*
* `writeFamily()` and `readFamily()` handle this difference. All `encodeAddr()`
* and `decodeAddr()` code goes through these helpers.
*
*
* ## Non-blocking connect
*
* `Socket.connect()` uses non-blocking sockets for async connection setup:
*   1. Create a socket, set O_NONBLOCK.
*   2. Call `connect()` — returns immediately with EINPROGRESS.
*   3. `await loop.writable(lp, fd)` — suspend until the kernel signals
*      that the connection attempt completed (success or failure).
*   4. `getsockopt(fd, SOL_SOCKET, SO_ERROR)` — check the actual result.
*      Zero means success; nonzero is an errno value.
*
* This approach never blocks the Fino process, even for connections to remote
* hosts that may be slow to respond.
*
*
* ## accept4 on Linux
*
* Linux provides `accept4(2)` which sets `SOCK_NONBLOCK` on the accepted
* socket atomically, avoiding a separate `fcntl(F_SETFL)` call. On macOS,
* we call `accept(2)` followed by `setNonblocking(fd)`. The `accept` function
* in this module handles the platform difference automatically.
*
*
* ## EAGAIN values differ by platform
*
* When a non-blocking call would block, the kernel returns EAGAIN or
* EWOULDBLOCK (same value on most platforms). But the numeric errno differs:
*   Linux:  EAGAIN = 11  (returned as -11 from our FFI functions)
*   macOS:  EAGAIN = 35  (returned as -35)
*
* Similarly, EINPROGRESS is -115 on Linux and -36 on macOS. The errno
* constants exported by this module use the correct values for the current
* platform.
*
*
* ## Socket.split() and fd lifecycle
*
* `Socket.split()` returns `[Reader, Writer]` that share the underlying fd.
* The fd should only be `close()`d when both halves are done. The `onClose`
* callbacks implement a reference-count of 2:
*   - Reader's close: `shutdown(fd, SHUT_RD)` + decrement ref. This sends an
*     EOF to any in-flight `read(2)` call, unblocking the Reader cleanly.
*   - Writer's close: `shutdown(fd, SHUT_WR)` + decrement ref. This sends a
*     TCP FIN to the remote peer.
*   - When both have closed (ref reaches 0): `close(fd)` releases the fd.
*
* `shutdown(SHUT_RD)` is a local operation — it doesn't send anything on the
* wire; it just makes the read side of the socket return 0 (EOF) immediately.
* `shutdown(SHUT_WR)` sends a FIN packet, signalling to the peer that we're
* done sending but may still be reading.
*
*
* ## Server (Socket.listen)
*
* `Socket.listen()` returns a plain object (not a class) with:
*   - `accept()` — async function that awaits the next incoming connection
*   - `close()` — closes the server socket
*   - `[Symbol.asyncIterator]` — iterate incoming connections
*
* The server socket is set non-blocking after `listen(2)`, and
* `loop.readable()` is used to await the next connection before calling
* `accept()`. If `accept()` returns null (spurious wakeup), the loop retries.
*
* Unix domain sockets: `Socket.listen()` calls `unlink(path)` before `bind()`
* to remove any stale socket file from a previous run.
*
*
* ## Contributing
*
* - All socket fds must be set to non-blocking mode before use with the event
*   loop. `setNonblocking()` is called automatically by `Socket.connect()` and
*   `Socket.listen()`, but callers using the low-level API must call it
*   themselves.
* - `send()` and `recv()` are provided for connected sockets (TCP). For UDP,
*   use `sendto()` and `recvfrom()`.
* - `setsockopt()` with a boolean or number value writes a 4-byte little-endian
*   int. For raw option buffers (e.g. `struct linger`), pass an ArrayBuffer.
*
* @example
* ```ts no_run
* import { Socket } from 'fino:socket';
*
* const socket = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: 8080 });
* const [reader, writer] = socket.split();
* await writer.write(new TextEncoder().encode('ping'));
* const reply = await reader.read();
* ```
*/
import { dlopen, Pointer } from 'fino:ffi';
import { networkInterfaces as nativeNetworkInterfaces } from 'internal:net-native';
import { os } from 'internal:process';
import { encodeUtf8, decodeUtf8 } from '../globals/encoding.ts';
import * as loop from '../internal/runtime/loop.ts';
import { FdReader, FdWriter, BufferedBytesReader, BufferedBytesWriter } from '../internal/stream.ts';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/**
* IPv4 socket address.
*
* Used with TCP and UDP helpers. `ip` must be a numeric IPv4 literal accepted
* by `inet_pton`; hostnames are not resolved here.
*
* ```ts no_run
* const addr: IPv4Address = { family: 'ipv4', ip: '127.0.0.1', port: 8080 };
* ```
*/
export interface IPv4Address {
  /** Literal IPv4 family tag.
  *
  * ```ts no_run
  * if (addr.family === 'ipv4') console.log(addr.ip);
  * ```
  */
  family: 'ipv4';
  /** Numeric IPv4 address string.
  *
  * ```ts no_run
  * const addr = { family: 'ipv4', ip: '0.0.0.0', port: 3000 } as const;
  * ```
  */
  ip: string;
  /** TCP or UDP port number; encoded as an unsigned 16-bit network-order field.
  *
  * ```ts no_run
  * console.log(addr.port);
  * ```
  */
  port: number;
}
/**
* IPv6 socket address.
*
* `ip` must be a numeric IPv6 literal. Scope IDs are not represented in this
* public shape through optional `scopeId`.
*
* ```ts no_run
* const addr: IPv6Address = { family: 'ipv6', ip: '::1', port: 8080 };
* ```
*/
export interface IPv6Address {
  /** Literal IPv6 family tag.
  *
  * ```ts no_run
  * if (addr.family === 'ipv6') console.log(addr.ip);
  * ```
  */
  family: 'ipv6';
  /** Numeric IPv6 address string.
  *
  * ```ts no_run
  * const loopback = { family: 'ipv6', ip: '::1', port: 3000 } as const;
  * ```
  */
  ip: string;
  /** TCP or UDP port number.
  *
  * ```ts no_run
  * console.log(addr.port);
  * ```
  */
  port: number;
  /** IPv6 scope ID for link-local and interface-scoped addresses.
  *
  * ```ts no_run
  * const addr: IPv6Address = { family: 'ipv6', ip: 'fe80::1', port: 5353, scopeId: 4 };
  * ```
  */
  scopeId?: number;
}
/**
* Unix domain socket address.
*
* Paths must fit the platform `sockaddr_un` limit after UTF-8 encoding and a
* trailing NUL byte. `Socket.listen()` unlinks stale paths before binding.
*
* ```ts no_run
* const addr: UnixAddress = { family: 'unix', path: '/tmp/fino.sock' };
* ```
*/
export interface UnixAddress {
  /** Literal Unix-domain family tag.
  *
  * ```ts no_run
  * if (addr.family === 'unix') console.log(addr.path);
  * ```
  */
  family: 'unix';
  /** Filesystem path for the socket node.
  *
  * ```ts no_run
  * const addr = { family: 'unix', path: '/tmp/app.sock' } as const;
  * ```
  */
  path: string;
}
/**
* Supported socket address shapes accepted by high-level and low-level APIs.
*
* ```ts no_run
* const addr: Address = { family: 'ipv4', ip: '127.0.0.1', port: 80 };
* ```
*/
export type Address = IPv4Address | IPv6Address | UnixAddress;
/**
* Address returned when the native family is not recognized by this module.
*
* This can appear when decoding a kernel-filled sockaddr with an address family
* this module does not support.
*
* ```ts no_run
* const decoded = decodeAddr(raw);
* if (decoded.family.startsWith('unknown')) console.log(decoded.family);
* ```
*/
export interface UnknownAddress {
  /** String form such as `unknown(123)`.
  *
  * ```ts no_run
  * console.log(addr.family);
  * ```
  */
  family: string;
}
/**
* Options for high-level TCP connection setup.
*
* ```ts no_run
* const fd = await connectTcp(addr, { noDelay: true });
* ```
*/
export interface ConnectOptions {
  /** Enable TCP_NODELAY after creating the socket.
  *
  * ```ts no_run
  * await Socket.connect(addr, { noDelay: true });
  * ```
  */
  noDelay?: boolean;
}
/**
* Options for high-level server socket setup.
*
* Defaults are `reuseAddr: true`, `reusePort: false`, and `backlog: 128` in the
* high-level listener.
*
* ```ts no_run
* const server = Socket.listen({ family: 'ipv4', ip: '0.0.0.0', port: 3000 }, { backlog: 256 });
* ```
*/
export interface ListenOptions {
  /** Set SO_REUSEADDR before bind.
  *
  * ```ts no_run
  * Socket.listen(addr, { reuseAddr: true });
  * ```
  */
  reuseAddr?: boolean;
  /** Set SO_REUSEPORT before bind where supported.
  *
  * ```ts no_run
  * Socket.listen(addr, { reusePort: true });
  * ```
  */
  reusePort?: boolean;
  /** Listen backlog passed to `listen(2)`.
  *
  * ```ts no_run
  * Socket.listen(addr, { backlog: 512 });
  * ```
  */
  backlog?: number;
}
/**
* Server object returned by `Socket.listen()`.
*
* The server owns a non-blocking listening fd. `accept()` waits for a
* connection and returns `null` only for a spurious non-blocking wakeup; async
* iteration skips those nulls.
*
* ```ts no_run
* const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
* for await (const conn of server) conn.close();
* ```
*/
export interface Server {
  /** Listening file descriptor.
  *
  * ```ts no_run
  * console.log(server.fd);
  * ```
  */
  fd: number;
  /** Bound address, including the assigned port when port zero was used.
  *
  * ```ts no_run
  * console.log(server.address);
  * ```
  */
  address: Address;
  /** Whether the listening fd has been closed. */
  readonly closed: boolean;
  /** Accept the next connection, or `null` after a spurious wakeup.
  *
  * ```ts no_run
  * const conn = await server.accept();
  * if (conn !== null) conn.close();
  * ```
  */
  accept(): Promise<Socket | null>;
  /** Close the listening fd. In-flight accepted sockets are not closed.
  *
  * ```ts no_run
  * server.close();
  * ```
  */
  close(): void;
  /** Explicit resource-management hook for `using` declarations. */
  [Symbol.dispose](): void;
  /** Iterate accepted sockets until the server is closed or accept throws.
  *
  * ```ts no_run
  * for await (const conn of server) conn.close();
  * ```
  */
  [Symbol.asyncIterator](): AsyncIterator<Socket>;
}
/**
* Network interface metadata returned by `networkInterfaces()`.
*
* The `index` value is the kernel interface index used by IPv6 scoped
* multicast APIs and link-local socket addresses.
*
* ```ts no_run
* const interfaces = networkInterfaces();
* console.log(interfaces[0]?.index, interfaces[0]?.name);
* ```
*/
export interface NetworkInterface {
  /** Kernel interface index. */
  index: number;
  /** Interface name such as `lo0` or `en0`. */
  name: string;
  /** Native interface flags, when supplied by callers or future platform helpers. */
  flags?: number;
  /** Whether the interface is marked up, when flags are available. */
  up?: boolean;
  /** Whether the interface is marked loopback, when flags are available. */
  loopback?: boolean;
  /** Whether the interface supports multicast, when flags are available. */
  multicast?: boolean;
  /** IPv4 and IPv6 addresses assigned to the interface, when supplied. */
  addresses?: Address[];
  /** Netmasks corresponding to `addresses`, when supplied. */
  netmasks?: Address[];
}
const isDarwin = os === 'darwin';
const isLinux = os === 'linux';
const errnoFn = isDarwin ? '__error' : '__errno_location';
// ---------------------------------------------------------------------------
// Open libc
// ---------------------------------------------------------------------------
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const _defs = {
  socket: {
    parameters: [
      'i32',
      'i32',
      'i32'
    ],
    result: 'i32'
  },
  bind: {
    parameters: [
      'i32',
      'buffer',
      'u32'
    ],
    result: 'i32'
  },
  getsockname: {
    parameters: [
      'i32',
      'buffer',
      'buffer'
    ],
    result: 'i32'
  },
  connect: {
    parameters: [
      'i32',
      'buffer',
      'u32'
    ],
    result: 'i32'
  },
  listen: {
    parameters: ['i32', 'i32'],
    result: 'i32'
  },
  accept: {
    parameters: [
      'i32',
      'buffer',
      'buffer'
    ],
    result: 'i32'
  },
  send: {
    parameters: [
      'i32',
      'buffer',
      'usize',
      'i32'
    ],
    result: 'isize'
  },
  recv: {
    parameters: [
      'i32',
      'buffer',
      'usize',
      'i32'
    ],
    result: 'isize'
  },
  sendto: {
    parameters: [
      'i32',
      'buffer',
      'usize',
      'i32',
      'buffer',
      'u32'
    ],
    result: 'isize'
  },
  recvfrom: {
    parameters: [
      'i32',
      'buffer',
      'usize',
      'i32',
      'buffer',
      'buffer'
    ],
    result: 'isize'
  },
  sendmsg: {
    parameters: [
      'i32',
      'buffer',
      'i32'
    ],
    result: 'isize'
  },
  recvmsg: {
    parameters: [
      'i32',
      'buffer',
      'i32'
    ],
    result: 'isize'
  },
  setsockopt: {
    parameters: [
      'i32',
      'i32',
      'i32',
      'buffer',
      'u32'
    ],
    result: 'i32'
  },
  getsockopt: {
    parameters: [
      'i32',
      'i32',
      'i32',
      'buffer',
      'buffer'
    ],
    result: 'i32'
  },
  shutdown: {
    parameters: ['i32', 'i32'],
    result: 'i32'
  },
  close: {
    parameters: ['i32'],
    result: 'i32'
  },
  unlink: {
    parameters: ['buffer'],
    result: 'i32'
  },
  fcntl: {
    parameters: [
      'i32',
      'i32',
      'i32'
    ],
    result: 'i32',
    variadic: 2
  },
  inet_pton: {
    parameters: [
      'i32',
      'buffer',
      'buffer'
    ],
    result: 'i32'
  },
  inet_ntop: {
    parameters: [
      'i32',
      'buffer',
      'buffer',
      'u32'
    ],
    result: 'pointer'
  },
  if_nameindex: {
    parameters: [],
    result: 'pointer'
  },
  if_freenameindex: {
    parameters: ['pointer'],
    result: 'void'
  },
  if_nametoindex: {
    parameters: ['buffer'],
    result: 'u32'
  },
  [errnoFn]: {
    parameters: [],
    result: 'pointer'
  }
};
// accept4 is Linux-only (sets SOCK_NONBLOCK atomically on the accepted socket)
if (isLinux) {
  _defs.accept4 = {
    parameters: [
      'i32',
      'buffer',
      'buffer',
      'i32'
    ],
    result: 'i32'
  };
  _defs.sendmmsg = {
    parameters: [
      'i32',
      'buffer',
      'u32',
      'i32'
    ],
    result: 'i32'
  };
  _defs.recvmmsg = {
    parameters: [
      'i32',
      'buffer',
      'u32',
      'i32',
      'buffer'
    ],
    result: 'i32'
  };
}
if (isDarwin) {
  _defs.sendmsg_x = {
    parameters: [
      'i32',
      'buffer',
      'u32',
      'i32'
    ],
    result: 'i32'
  };
  _defs.recvmsg_x = {
    parameters: [
      'i32',
      'buffer',
      'u32',
      'i32'
    ],
    result: 'i32'
  };
}
const lib = dlopen(LIBC, _defs);
const errnoPtr = lib.symbols[errnoFn]!() as ArrayBuffer;
function getErrno(): number {
  return Pointer.readI32(errnoPtr, 0);
}
// Native datagram ancillary-data layouts on supported 64-bit platforms.
const IOVEC_SIZE = 16;
const IOVEC_BASE = 0;
const IOVEC_LEN = 8;
const MSGHDR_SIZE = isDarwin ? 48 : 56;
const MSG_NAME = 0;
const MSG_NAMELEN = 8;
const MSG_IOV = 16;
const MSG_IOVLEN = 24;
const MSG_CONTROL = 32;
const MSG_CONTROLLEN = 40;
const MSG_FLAGS = isDarwin ? 44 : 48;
const CMSG_LEN = 0;
const CMSG_LEVEL = isDarwin ? 4 : 8;
const CMSG_TYPE = isDarwin ? 8 : 12;
const CMSG_DATA = isDarwin ? 12 : 16;
const CMSG_SPACE = 32;
const CMSG_SPACE_PACKET_INFO = 128;
const CMSG_DATA_LEN = 4;
const MSGHDR_X_SIZE = 56;
const MSGHDR_X_DATALEN = 48;
const MMSGHDR_SIZE = 64;
const MMSG_HDR = 0;
const MMSG_LEN = MSGHDR_SIZE;
function writePtrValue(view: DataView, offset: number, value: ArrayBuffer | ArrayBufferView | bigint | null): void {
  const addr = value === null ? 0n : typeof value === 'bigint' ? value : Pointer.addr(value) as bigint;
  view.setBigUint64(offset, addr, true);
}
function writeSize(view: DataView, offset: number, value: number): void {
  if (isDarwin) view.setUint32(offset, value, true);
  else view.setBigUint64(offset, BigInt(value), true);
}
function readSize(view: DataView, offset: number): number {
  return isDarwin ? view.getUint32(offset, true) : Number(view.getBigUint64(offset, true));
}
// ---------------------------------------------------------------------------
// Constants — platform-specific where they differ
// ---------------------------------------------------------------------------
/** IPv4 address family constant.
*
* ```ts no_run
* const fd = socket(AF_INET, SOCK_STREAM, 0);
* ```
*/
export const AF_INET = 2;
/** IPv6 address family constant.
*
* ```ts no_run
* const fd = socket(AF_INET6, SOCK_STREAM, 0);
* ```
*/
export const AF_INET6 = isDarwin ? 30 : 10;
/** Unix domain socket address family constant.
*
* ```ts no_run
* const fd = socket(AF_UNIX, SOCK_STREAM, 0);
* ```
*/
export const AF_UNIX = 1;
/** Stream socket type, typically TCP.
*
* ```ts no_run
* const fd = socket(AF_INET, SOCK_STREAM, 0);
* ```
*/
export const SOCK_STREAM = 1;
/** Datagram socket type, typically UDP.
*
* ```ts no_run
* const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
* ```
*/
export const SOCK_DGRAM = 2;
// Linux-only: OR into socket type to set non-blocking at creation time
/** Linux socket type flag for atomic non-blocking creation; zero elsewhere.
*
* ```ts no_run
* const type = SOCK_STREAM | SOCK_NONBLOCK;
* ```
*/
export const SOCK_NONBLOCK = isLinux ? 524288 : 0;
/** TCP protocol number.
*
* ```ts no_run
* const fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
* ```
*/
export const IPPROTO_TCP = 6;
/** IPv4 option level used with setsockopt. */
export const IPPROTO_IP = 0;
/** IPv6 option level used with setsockopt. */
export const IPPROTO_IPV6 = isDarwin ? 41 : 41;
/** UDP protocol number.
*
* ```ts no_run
* const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
* ```
*/
export const IPPROTO_UDP = 17;
/** Socket option level for `setsockopt` and `getsockopt`.
*
* ```ts no_run
* setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, true);
* ```
*/
export const SOL_SOCKET = isDarwin ? 65535 : 1;
/** Allow reusing a recently-bound local address.
*
* ```ts no_run
* setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, true);
* ```
*/
export const SO_REUSEADDR = isDarwin ? 4 : 2;
/** Allow multiple listeners to share a local address where supported.
*
* ```ts no_run
* setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, true);
* ```
*/
export const SO_REUSEPORT = isDarwin ? 512 : 15;
/** Enable TCP keepalive probes.
*
* ```ts no_run
* setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, true);
* ```
*/
export const SO_KEEPALIVE = isDarwin ? 8 : 9;
/** Receive buffer size socket option. */
export const SO_RCVBUF = isDarwin ? 4098 : 8;
/** Send buffer size socket option. */
export const SO_SNDBUF = isDarwin ? 4097 : 7;
/** Socket option used to read pending connection errors.
*
* ```ts no_run
* const errno = new DataView(getsockopt(fd, SOL_SOCKET, SO_ERROR)).getInt32(0, true);
* ```
*/
export const SO_ERROR = isDarwin ? 4103 : 4;
/** TCP option level used with `setsockopt`.
*
* ```ts no_run
* setsockopt(fd, IPPROTO_TCP_LEVEL, TCP_NODELAY, true);
* ```
*/
export const IPPROTO_TCP_LEVEL = 6;
/** Disable Nagle's algorithm for TCP sockets.
*
* ```ts no_run
* setsockopt(fd, IPPROTO_TCP_LEVEL, TCP_NODELAY, true);
* ```
*/
export const TCP_NODELAY = 1;
/** IPv4 unicast TTL option. */
export const IP_TTL = isDarwin ? 4 : 2;
/** Join an IPv4 multicast group with `setsockopt(IPPROTO_IP, IP_ADD_MEMBERSHIP, ...)`. */
export const IP_ADD_MEMBERSHIP = isDarwin ? 12 : 35;
/** Leave an IPv4 multicast group. */
export const IP_DROP_MEMBERSHIP = isDarwin ? 13 : 36;
/** Select the IPv4 multicast outbound interface. */
export const IP_MULTICAST_IF = isDarwin ? 9 : 32;
/** Set IPv4 multicast packet TTL. */
export const IP_MULTICAST_TTL = isDarwin ? 10 : 33;
/** Enable or disable IPv4 multicast loopback. */
export const IP_MULTICAST_LOOP = isDarwin ? 11 : 34;
/** IPv4 type-of-service / traffic-class option. */
export const IP_TOS = isDarwin ? 3 : 1;
/** IPv4 receive type-of-service ancillary-data option. */
export const IP_RECVTOS = isDarwin ? 27 : 13;
/** IPv4 receive packet-info ancillary-data option. */
export const IP_PKTINFO = isDarwin ? 26 : 8;
/** IPv4 receive packet-info socket option. */
export const IP_RECVPKTINFO = isDarwin ? IP_PKTINFO : IP_PKTINFO;
/** IPv6-only bind option. */
export const IPV6_V6ONLY = isDarwin ? 27 : 26;
/** IPv6 unicast hop-limit option. */
export const IPV6_UNICAST_HOPS = isDarwin ? 4 : 16;
/** Join an IPv6 multicast group. */
export const IPV6_JOIN_GROUP = isDarwin ? 12 : 20;
/** Leave an IPv6 multicast group. */
export const IPV6_LEAVE_GROUP = isDarwin ? 13 : 21;
/** Select the IPv6 multicast outbound interface by index. */
export const IPV6_MULTICAST_IF = isDarwin ? 9 : 17;
/** Set IPv6 multicast hop limit. */
export const IPV6_MULTICAST_HOPS = isDarwin ? 10 : 18;
/** Enable or disable IPv6 multicast loopback. */
export const IPV6_MULTICAST_LOOP = isDarwin ? 11 : 19;
/** IPv6 receive traffic-class ancillary-data option. */
export const IPV6_RECVTCLASS = isDarwin ? 35 : 66;
/** IPv6 traffic-class option. */
export const IPV6_TCLASS = isDarwin ? 36 : 67;
/** IPv6 receive packet-info socket option. */
export const IPV6_RECVPKTINFO = isDarwin ? 61 : 49;
/** IPv6 packet-info ancillary-data type. */
export const IPV6_PKTINFO = isDarwin ? 46 : 50;
/** Shut down the read side of a socket.
*
* ```ts no_run
* shutdown(fd, SHUT_RD);
* ```
*/
export const SHUT_RD = 0;
/** Shut down the write side of a socket.
*
* ```ts no_run
* shutdown(fd, SHUT_WR);
* ```
*/
export const SHUT_WR = 1;
/** Shut down both sides of a socket.
*
* ```ts no_run
* shutdown(fd, SHUT_RDWR);
* ```
*/
export const SHUT_RDWR = 2;
// fcntl constants
const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = isDarwin ? 4 : 2048;
// Sockaddr sizes
const SOCKADDR_IN_SIZE = 16;
const SOCKADDR_IN6_SIZE = 28;
// macOS adds a 1-byte sun_len prefix; Linux does not
const SOCKADDR_UN_SIZE = isDarwin ? 106 : 110;
const INET_ADDRSTRLEN = 16;
const INET6_ADDRSTRLEN = 46;
const IF_NAMEINDEX_SIZE = 16;
const IF_NAMEINDEX_INDEX = 0;
const IF_NAMEINDEX_NAME = 8;
// ---------------------------------------------------------------------------
// Address struct helpers
// ---------------------------------------------------------------------------
/**
* Encode a JS address object into an ArrayBuffer suitable for passing to
* bind() / connect() / sendto().
*
* @param {{ family: 'ipv4'|'ipv6'|'unix', ip?: string, port?: number, path?: string }} addr
* @returns {{ buf: ArrayBuffer, len: number }}
*/
/**
* Write the address-family field into a sockaddr buffer.
*
* macOS:  byte 0 = sa_len (uint8), byte 1 = sa_family (uint8)
* Linux:  bytes 0-1 = sa_family (uint16 LE)
*/
function writeFamily(view: DataView, family: number, structSize: number): void {
  if (isDarwin) {
    view.setUint8(0, structSize);
    view.setUint8(1, family);
  } else {
    view.setUint16(0, family, true);
  }
}
/**
* Read the address-family from a kernel-filled sockaddr buffer.
*
* macOS:  sa_family is uint8 at byte 1 (byte 0 is sa_len)
* Linux:  sa_family is uint16 LE at bytes 0-1
*/
function readFamily(view: DataView): number {
  return isDarwin ? view.getUint8(1) : view.getUint16(0, true);
}
/**
* Encode a JS socket address into a native `sockaddr` buffer and byte length.
*
* Throws when IP literals fail `inet_pton`, Unix socket paths exceed the native
* limit, or the address family is unknown. The returned buffer is ready for
* `bind`, `connect`, or `sendto`.
*
* ```ts no_run
* const { buf, len } = encodeAddr({ family: 'ipv4', ip: '127.0.0.1', port: 80 });
* ```
*/
export function encodeAddr(addr: Address): {
  buf: ArrayBuffer;
  len: number;
} {
  if (addr.family === 'ipv4') {
    const buf = new ArrayBuffer(SOCKADDR_IN_SIZE);
    const view = new DataView(buf);
    writeFamily(view, AF_INET, SOCKADDR_IN_SIZE);
    // port is big-endian at offset 2
    view.setUint16(2, addr.port & 65535, false);
    // parse IP into the 4-byte in_addr field at offset 4
    const addrBuf = new ArrayBuffer(4);
    const rc = lib.symbols.inet_pton(AF_INET, encodeUtf8(addr.ip + '\0'), addrBuf);
    if (rc !== 1) throw new Error(`invalid IPv4 address: '${addr.ip}'`);
    new Uint8Array(buf, 4, 4).set(new Uint8Array(addrBuf));
    return {
      buf,
      len: SOCKADDR_IN_SIZE
    };
  } else if (addr.family === 'ipv6') {
    const buf = new ArrayBuffer(SOCKADDR_IN6_SIZE);
    const view = new DataView(buf);
    writeFamily(view, AF_INET6, SOCKADDR_IN6_SIZE);
    view.setUint16(2, addr.port & 65535, false);
    // flowinfo at offset 4 (4 bytes, zeroed)
    // sin6_addr at offset 8 (16 bytes)
    const addrBuf = new ArrayBuffer(16);
    const rc = lib.symbols.inet_pton(AF_INET6, encodeUtf8(addr.ip + '\0'), addrBuf);
    if (rc !== 1) throw new Error(`invalid IPv6 address: '${addr.ip}'`);
    new Uint8Array(buf, 8, 16).set(new Uint8Array(addrBuf));
    view.setUint32(24, addr.scopeId ?? 0, true);
    return {
      buf,
      len: SOCKADDR_IN6_SIZE
    };
  } else if (addr.family === 'unix') {
    const pathBytes = encodeUtf8(addr.path);
    // header = 2 bytes (len+family on macOS, uint16 family on Linux)
    const maxPath = SOCKADDR_UN_SIZE - 2;
    if (pathBytes.length + 1 > maxPath) {
      throw new Error(`Unix socket path too long (max ${maxPath - 1} bytes)`);
    }
    const structLen = 2 + pathBytes.length + 1;
    const buf = new ArrayBuffer(SOCKADDR_UN_SIZE);
    const view = new DataView(buf);
    if (isDarwin) {
      view.setUint8(0, structLen);
      view.setUint8(1, AF_UNIX);
    } else {
      view.setUint16(0, AF_UNIX, true);
    }
    new Uint8Array(buf, 2, pathBytes.length).set(pathBytes);
    // NUL terminator already present (ArrayBuffer is zeroed)
    return {
      buf,
      len: structLen
    };
  }
  const unknownFamily = ((addr as never) as {
    family: string;
  }).family;
  throw new Error(`Unknown address family: ${unknownFamily}`);
}
/**
* Decode a sockaddr ArrayBuffer into a JS address object.
*
* Unknown native address families return `{ family: 'unknown(n)' }` instead of
* throwing. IP addresses are formatted via `inet_ntop`.
*
* ```ts no_run
* const addr = decodeAddr(sockaddrBuffer);
* console.log(addr.family);
* ```
*/
export function decodeAddr(buf: ArrayBuffer): Address | UnknownAddress {
  const view = new DataView(buf);
  const family = readFamily(view);
  if (family === AF_INET) {
    const port = view.getUint16(2, false);
    const addrBuf = buf.slice(4, 8);
    const strBuf = new ArrayBuffer(INET_ADDRSTRLEN);
    lib.symbols.inet_ntop(AF_INET, addrBuf, strBuf, INET_ADDRSTRLEN);
    const ip = decodeUtf8(new Uint8Array(strBuf).subarray(0, nullTermIdx(strBuf)));
    return {
      family: 'ipv4',
      ip,
      port
    };
  } else if (family === AF_INET6) {
    const port = view.getUint16(2, false);
    const addrBuf = buf.slice(8, 24);
    const strBuf = new ArrayBuffer(INET6_ADDRSTRLEN);
    lib.symbols.inet_ntop(AF_INET6, addrBuf, strBuf, INET6_ADDRSTRLEN);
    const ip = decodeUtf8(new Uint8Array(strBuf).subarray(0, nullTermIdx(strBuf)));
    return {
      family: 'ipv6',
      ip,
      port,
      scopeId: view.getUint32(24, true)
    };
  } else if (family === AF_UNIX) {
    const offset = isDarwin ? 2 : 2;
    const bytes = new Uint8Array(buf, offset);
    const end = bytes.indexOf(0);
    const path = decodeUtf8(end >= 0 ? bytes.subarray(0, end) : bytes);
    return {
      family: 'unix',
      path
    };
  } else {
    return { family: `unknown(${family})` };
  }
}
function nullTermIdx(buf: ArrayBuffer): number {
  const bytes = new Uint8Array(buf);
  const idx = bytes.indexOf(0);
  return idx >= 0 ? idx : bytes.length;
}
function isKnownAddress(addr: Address | UnknownAddress): addr is Address {
  return addr.family === 'ipv4' || addr.family === 'ipv6' || addr.family === 'unix';
}
function nativeCString(ptr: ArrayBuffer | null, maxBytes = 64): string {
  if (ptr === null) return '';
  const bytes = Pointer.copyFrom(ptr, maxBytes) as Uint8Array;
  const end = bytes.indexOf(0);
  return decodeUtf8(end >= 0 ? bytes.subarray(0, end) : bytes);
}
function readInterfacesFromNameIndex(): NetworkInterface[] {
  const ptr = lib.symbols.if_nameindex() as ArrayBuffer | null;
  if (ptr === null) throw new Error(`if_nameindex() failed: errno=${getErrno()}`);
  try {
    const out: NetworkInterface[] = [];
    for (let offset = 0; offset < IF_NAMEINDEX_SIZE * 4096; offset += IF_NAMEINDEX_SIZE) {
      const entry = Pointer.offset(ptr, offset) as ArrayBuffer | null;
      if (entry === null) break;
      const index = Pointer.readU32(entry, IF_NAMEINDEX_INDEX) as number;
      const namePtr = Pointer.readPointer(entry, IF_NAMEINDEX_NAME) as ArrayBuffer | null;
      if (index === 0 && namePtr === null) break;
      if (index === 0) continue;
      out.push({ index, name: nativeCString(namePtr) });
    }
    return out;
  } finally {
    lib.symbols.if_freenameindex(ptr);
  }
}
// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------
/**
* Create a socket.
*
* Returns a raw file descriptor on success and throws when `socket(2)` fails.
* Low-level callers should set non-blocking mode before integrating with the
* event loop.
*
* ```ts no_run
* const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
* close(fd);
* ```
*/
export function socket(family: number = AF_INET, type: number = SOCK_STREAM, protocol: number = 0): number {
  const fd = lib.symbols.socket(family, type, protocol);
  if (fd < 0) throw new Error(`socket() failed: errno=${getErrno()}`);
  return fd;
}
/**
* Set a socket to non-blocking mode via fcntl(F_SETFL, O_NONBLOCK).
*
* Throws if either `fcntl` call fails. High-level `Socket.connect()` and
* `Socket.listen()` call this automatically.
*
* ```ts no_run
* const fd = socket();
* setNonblocking(fd);
* ```
*/
export function setNonblocking(fd: number): void {
  const flags = lib.symbols.fcntl(fd, F_GETFL, 0);
  if (flags < 0) throw new Error(`fcntl(F_GETFL) failed: errno=${getErrno()}`);
  const rc = lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  if (rc < 0) throw new Error(`fcntl(F_SETFL, O_NONBLOCK) failed: errno=${getErrno()}`);
}
/**
* Set socket option. Value can be a boolean/number (written as 4-byte int)
* or an ArrayBuffer for raw option data.
*
* Throws when `setsockopt(2)` fails. Boolean and number values are encoded as
* little-endian 32-bit integers for common POSIX socket options.
*
* ```ts no_run
* setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, true);
* ```
*/
export function setsockopt(fd: number, level: number, optname: number, value: boolean | number | ArrayBuffer): void {
  let buf;
  if (typeof value === 'boolean' || typeof value === 'number') {
    buf = new ArrayBuffer(4);
    new DataView(buf).setInt32(0, value ? 1 : 0, true);
  } else {
    buf = value;
  }
  const rc = lib.symbols.setsockopt(fd, level, optname, buf, buf.byteLength);
  if (rc < 0) throw new Error(`setsockopt() failed: errno=${getErrno()}`);
}
/**
* Get socket option. Returns the raw ArrayBuffer (4 bytes for int options).
*
* Throws when `getsockopt(2)` fails. Interpret integer options with a
* little-endian `DataView`.
*
* ```ts no_run
* const buf = getsockopt(fd, SOL_SOCKET, SO_ERROR);
* const errno = new DataView(buf).getInt32(0, true);
* ```
*/
export function getsockopt(fd: number, level: number, optname: number, bufSize: number = 4): ArrayBuffer {
  const buf = new ArrayBuffer(bufSize);
  const lenBuf = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, bufSize, true);
  const rc = lib.symbols.getsockopt(fd, level, optname, buf, lenBuf);
  if (rc < 0) throw new Error(`getsockopt() failed: errno=${getErrno()}`);
  return buf;
}
function inetPtonBytes(family: number, ip: string, length: number): Uint8Array {
  const buf = new ArrayBuffer(length);
  const rc = lib.symbols.inet_pton(family, encodeUtf8(ip + '\0'), buf);
  if (rc !== 1) throw new Error(`invalid ${family === AF_INET ? 'IPv4' : 'IPv6'} address: '${ip}'`);
  return new Uint8Array(buf);
}
function ipv4MembershipBuffer(group: string, interfaceAddress?: string): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const bytes = new Uint8Array(buf);
  bytes.set(inetPtonBytes(AF_INET, group, 4), 0);
  bytes.set(inetPtonBytes(AF_INET, interfaceAddress ?? '0.0.0.0', 4), 4);
  return buf;
}
function ipv6MembershipBuffer(group: string, interfaceIndex?: number): ArrayBuffer {
  const buf = new ArrayBuffer(20);
  const bytes = new Uint8Array(buf);
  bytes.set(inetPtonBytes(AF_INET6, group, 16), 0);
  new DataView(buf).setUint32(16, interfaceIndex ?? 0, true);
  return buf;
}
/** Join an IPv4 or IPv6 multicast group on a datagram socket.
*
* IPv4 membership uses `interfaceAddress` when provided. IPv6 membership uses
* `interfaceIndex`, which is required for many link-local multicast cases.
*
* ```ts no_run
* joinMulticastGroup(fd, { group: '224.0.0.251' });
* ```
*/
export function joinMulticastGroup(fd: number, options: {
  group: string;
  interfaceAddress?: string;
  interfaceIndex?: number;
}): void {
  if (options.group.includes(':')) {
    setsockopt(fd, IPPROTO_IPV6, IPV6_JOIN_GROUP, ipv6MembershipBuffer(options.group, options.interfaceIndex));
  } else {
    setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, ipv4MembershipBuffer(options.group, options.interfaceAddress));
  }
}
/** Leave an IPv4 or IPv6 multicast group previously joined on a socket. */
export function leaveMulticastGroup(fd: number, options: {
  group: string;
  interfaceAddress?: string;
  interfaceIndex?: number;
}): void {
  if (options.group.includes(':')) {
    setsockopt(fd, IPPROTO_IPV6, IPV6_LEAVE_GROUP, ipv6MembershipBuffer(options.group, options.interfaceIndex));
  } else {
    setsockopt(fd, IPPROTO_IP, IP_DROP_MEMBERSHIP, ipv4MembershipBuffer(options.group, options.interfaceAddress));
  }
}
/** Set common multicast send options on a datagram socket.
*
* `ttl` maps to IPv4 TTL or IPv6 hop limit. `loopback` controls whether local
* multicast sends are looped back to local receivers. Interface selection uses
* IPv4 `interfaceAddress` or IPv6 `interfaceIndex`.
*/
export function setMulticastOptions(fd: number, options: {
  family?: 'ipv4' | 'ipv6';
  ttl?: number;
  loopback?: boolean;
  interfaceAddress?: string;
  interfaceIndex?: number;
}): void {
  const family = options.family ?? (options.interfaceIndex !== undefined ? 'ipv6' : 'ipv4');
  if (family === 'ipv6') {
    if (options.ttl !== undefined) setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_HOPS, options.ttl);
    if (options.loopback !== undefined) setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_LOOP, options.loopback);
    if (options.interfaceIndex !== undefined) setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_IF, options.interfaceIndex);
  } else {
    if (options.ttl !== undefined) setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, options.ttl);
    if (options.loopback !== undefined) setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, options.loopback);
    if (options.interfaceAddress !== undefined) setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, inetPtonBytes(AF_INET, options.interfaceAddress, 4).buffer);
  }
}
/**
* Return kernel network interfaces that have an interface index.
*
* This wraps `if_nameindex(3)` and is intentionally small: it returns the
* metadata needed for scoped IPv6 multicast sends and joins. Use
* `interfaceIndex()` when resolving a known interface name.
*
* ```ts no_run
* for (const iface of networkInterfaces()) console.log(iface.index, iface.name);
* ```
*/
export function networkInterfaces(): NetworkInterface[] {
  try {
    const interfaces = nativeNetworkInterfaces() as NetworkInterface[];
    if (Array.isArray(interfaces)) return interfaces;
  } catch {}
  return readInterfacesFromNameIndex();
}
/**
* Return the kernel interface index for an interface name.
*
* ```ts no_run
* const en0 = interfaceIndex('en0');
* ```
*/
export function interfaceIndex(name: string): number {
  const index = lib.symbols.if_nametoindex(encodeUtf8(name + '\0')) as number;
  if (index === 0) throw new Error(`if_nametoindex() failed for '${name}': errno=${getErrno()}`);
  return index;
}
/**
* Return network interface indexes, omitting names for allocation-light callers.
*
* ```ts no_run
* const indexes = networkInterfaceIndices();
* ```
*/
export function networkInterfaceIndices(): number[] {
  return networkInterfaces().map((iface) => iface.index);
}
/**
* Return the local address currently bound to a socket fd.
*
* This is useful after binding port `0` to discover the assigned port. Unknown
* address families are represented with `UnknownAddress`.
*
* ```ts no_run
* const addr = getsockname(fd);
* console.log(addr);
* ```
*/
export function getsockname(fd: number): Address | UnknownAddress {
  const addrBuf = new ArrayBuffer(128);
  const lenBuf = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, addrBuf.byteLength, true);
  const rc = lib.symbols.getsockname(fd, addrBuf, lenBuf);
  if (rc < 0) throw new Error(`getsockname() failed: errno=${getErrno()}`);
  const addrLen = new DataView(lenBuf).getUint32(0, true);
  return decodeAddr(addrBuf.slice(0, addrLen));
}
/**
* Bind a socket to an address.
*
* Throws on native bind errors. When the address is already in use, the error
* message includes the port when available.
*
* ```ts no_run
* bind(fd, { family: 'ipv4', ip: '127.0.0.1', port: 3000 });
* ```
*/
export function bind(fd: number, addr: Address): void {
  const { buf, len } = encodeAddr(addr);
  const rc = lib.symbols.bind(fd, buf, len);
  if (rc < 0) {
    const errno = getErrno();
    const addrInUse = isDarwin ? 48 : 98;
    const msg = errno === addrInUse ? `bind() failed: address already in use${(addr as any).port !== undefined ? ` (port ${(addr as any).port})` : ''}` : `bind() failed: errno=${errno}`;
    throw new Error(msg);
  }
}
/**
* Mark a socket as passive (server socket).
*
* `backlog` defaults to 128. The socket must already be bound. Throws when
* `listen(2)` fails.
*
* ```ts no_run
* listen(fd, 128);
* ```
*/
export function listen(fd: number, backlog: number = 128): void {
  const rc = lib.symbols.listen(fd, backlog);
  if (rc < 0) throw new Error(`listen() failed: errno=${getErrno()}`);
}
/**
* Accept a pending connection. Returns `{ fd, addr }`.
* If the socket is non-blocking and no connection is pending, returns null.
*
* On Linux, the accepted socket is made non-blocking atomically via accept4.
*
* Throws for accept errors other than EAGAIN/EWOULDBLOCK.
*
* ```ts no_run
* const accepted = accept(serverFd);
* if (accepted !== null) close(accepted.fd);
* ```
*/
export function accept(serverFd: number, setNonblock: boolean = true): {
  fd: number;
  addr: Address | UnknownAddress;
} | null {
  const addrBuf = new ArrayBuffer(128);
  const lenBuf = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, 128, true);
  let clientFd;
  if (isLinux && setNonblock) {
    clientFd = lib.symbols.accept4!(serverFd, addrBuf, lenBuf, SOCK_NONBLOCK);
  } else {
    clientFd = lib.symbols.accept(serverFd, addrBuf, lenBuf);
  }
  // EAGAIN / EWOULDBLOCK — no pending connection
  if (clientFd < 0) {
    const errno = getErrno();
    if (errno === 11 || errno === 35) return null;
    throw new Error(`accept() failed: errno=${errno}`);
  }
  if (setNonblock && !isLinux) {
    try {
      setNonblocking(clientFd);
    } catch (err) {
      lib.symbols.close(clientFd);
      throw err;
    }
  }
  const addrLen = new DataView(lenBuf).getUint32(0, true);
  const addr = decodeAddr(addrBuf.slice(0, addrLen));
  return {
    fd: clientFd,
    addr
  };
}
/**
* Initiate a connection to a remote address.
* For non-blocking sockets, returns -115 (EINPROGRESS) on Linux or
* -36 (EINPROGRESS) on macOS — use fino:loop addWrite() to wait for
* completion, then check SO_ERROR via getsockopt().
*
* ```ts no_run
* const rc = connect(fd, { family: 'ipv4', ip: '127.0.0.1', port: 80 });
* if (rc === EINPROGRESS) await loop.writable(fd);
* ```
*/
export function connect(fd: number, addr: Address): number {
  const { buf, len } = encodeAddr(addr);
  const rc = lib.symbols.connect(fd, buf, len);
  return rc < 0 ? -getErrno() : rc;
}
/**
* Send data on a connected socket.
*
* Returns bytes sent or a negative errno. Short writes are possible and must be
* handled by low-level callers.
*
* ```ts no_run
* const n = send(fd, new TextEncoder().encode('GET / HTTP/1.1\\r\\n\\r\\n'));
* ```
*/
export function send(fd: number, data: Uint8Array | ArrayBuffer, flags: number = 0): number {
  const buf = data instanceof ArrayBuffer ? data : data.buffer;
  const len = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
  const rc = Number(lib.symbols.send(fd, buf, len, flags));
  return rc < 0 ? -getErrno() : rc;
}
/**
* Receive data from a connected socket.
*
* Returns `Uint8Array` bytes, `null` on EOF, or a negative errno on error. For
* non-blocking fds, EAGAIN is returned as the platform-specific negative errno.
*
* ```ts no_run
* const chunk = recv(fd);
* if (chunk === null) console.log('peer closed');
* ```
*/
export function recv(fd: number, maxBytes: number = 65536, flags: number = 0): Uint8Array | number | null {
  const buf = new ArrayBuffer(maxBytes);
  const n = Number(lib.symbols.recv(fd, buf, maxBytes, flags));
  if (n === 0) return null;
  if (n < 0) return -getErrno();
  return new Uint8Array(buf, 0, n);
}
/**
* Send a datagram to a specific address (UDP).
*
* Returns bytes sent or a negative errno. The socket does not need to be
* connected.
*
* ```ts no_run
* sendto(fd, packet, { family: 'ipv4', ip: '8.8.8.8', port: 53 });
* ```
*/
export function sendto(fd: number, data: Uint8Array | ArrayBuffer, destAddr: Address, flags: number = 0): number {
  const { buf: addrBuf, len: addrLen } = encodeAddr(destAddr);
  const dataBuf = data instanceof ArrayBuffer ? data : data.buffer;
  const dataLen = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
  const rc = Number(lib.symbols.sendto(fd, dataBuf, dataLen, flags, addrBuf, addrLen));
  return rc < 0 ? -getErrno() : rc;
}
/**
* Send one UDP datagram with ECN traffic-class ancillary data.
*
* The ECN value is masked to its low two bits. IPv4 sends `IP_TOS`; IPv6 sends
* `IPV6_TCLASS`. Returns bytes sent or a negative errno.
*
* ```ts no_run
* sendmsgEcn(fd, packet, { family: 'ipv4', ip: '127.0.0.1', port: 4433 }, 2);
* ```
*/
export function sendmsgEcn(fd: number, data: Uint8Array | ArrayBuffer, destAddr: Address, ecn: number, flags: number = 0): number {
  const { buf: addrBuf, len: addrLen } = encodeAddr(destAddr);
  const dataView = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const controlBuf = new ArrayBuffer(CMSG_SPACE);
  const iovBuf = new ArrayBuffer(IOVEC_SIZE);
  const msgBuf = new ArrayBuffer(MSGHDR_SIZE);
  const control = new DataView(controlBuf);
  const iov = new DataView(iovBuf);
  const msg = new DataView(msgBuf);
  const cmsgLen = CMSG_DATA + CMSG_DATA_LEN;
  const family = destAddr.family === 'ipv6' ? IPPROTO_IPV6 : IPPROTO_IP;
  const type = destAddr.family === 'ipv6' ? IPV6_TCLASS : IP_TOS;
  const value = ecn & 3;
  writeSize(control, CMSG_LEN, cmsgLen);
  control.setInt32(CMSG_LEVEL, family, true);
  control.setInt32(CMSG_TYPE, type, true);
  control.setInt32(CMSG_DATA, value, true);
  writePtrValue(iov, IOVEC_BASE, dataView);
  iov.setBigUint64(IOVEC_LEN, BigInt(dataView.byteLength), true);
  writePtrValue(msg, MSG_NAME, addrBuf);
  msg.setUint32(MSG_NAMELEN, addrLen, true);
  writePtrValue(msg, MSG_IOV, iovBuf);
  writeSize(msg, MSG_IOVLEN, 1);
  writePtrValue(msg, MSG_CONTROL, controlBuf);
  writeSize(msg, MSG_CONTROLLEN, CMSG_SPACE);
  msg.setInt32(MSG_FLAGS, 0, true);
  const rc = Number(lib.symbols.sendmsg(fd, msgBuf, flags));
  return rc < 0 ? -getErrno() : rc;
}
export type SendmsgBatchPacket = {
  data: Uint8Array | ArrayBuffer;
  dest: Address;
  ecn?: number;
};
/**
* Datagram packet returned by a reusable batch receive helper.
*
* `data` and `addrBuffer` are views over helper-owned storage and remain valid
* only until the next receive call on the same helper.
*
* @internal
*/
export type RecvmsgBatchPacket = {
  /** Received datagram bytes. */
  data: Uint8Array;
  /** Peer address reported by the platform socket API. */
  addr: Address | UnknownAddress;
  /** Raw sockaddr storage reported by the platform socket API. */
  addrBuffer: ArrayBuffer;
  /** Number of valid bytes in `addrBuffer`. */
  addrLen: number;
  /** Optional ECN bits when ancillary data was present. */
  ecn?: number;
};
/**
* Datagram packet returned by raw reusable batch receive helpers.
*
* The packet carries raw sockaddr storage but intentionally does not decode it
* to an address object. This lets protocol hot paths avoid formatting peer
* addresses when routing already identified the packet.
*
* @internal
*/
export type RecvmsgBatchRawPacket = {
  /** Received datagram bytes. */
  data: Uint8Array;
  /** Raw sockaddr storage reported by the platform socket API. */
  addrBuffer: ArrayBuffer;
  /** Number of valid bytes in `addrBuffer`. */
  addrLen: number;
  /** Optional ECN bits when ancillary data was present. */
  ecn?: number;
};
/**
* Callback invoked for each datagram from raw reusable batch receive helpers.
*
* @internal
*/
export type RecvmsgBatchRawCallback = (data: Uint8Array, addrBuffer: ArrayBuffer, addrLen: number, ecn?: number) => void;
/**
* Reusable datagram receive batch for hot UDP loops.
*
* Packet byte and address views are valid until the next `recv()` call on this
* batch.
*
* @internal
*/
export interface DatagramRecvBatch {
  recv(fd: number, flags?: number): RecvmsgBatchPacket[] | number;
  recvRaw(fd: number, flags?: number): RecvmsgBatchRawPacket[] | number;
  recvRawEach(fd: number, callback: RecvmsgBatchRawCallback, flags?: number): number;
}
/**
* Send a batch of UDP datagrams with the platform batch-send primitive.
*
* Linux uses `sendmmsg(2)`. macOS uses Darwin `sendmsg_x`. Returns `null` on
* platforms without a batch primitive, otherwise returns the number of messages
* accepted by the kernel or a negative errno when none were sent. Per-message
* ECN values are carried as ancillary traffic-class data.
*/
export function sendmmsgBatch(fd: number, packets: SendmsgBatchPacket[], flags: number = 0): {
  sent: number;
  errno: number | null;
} | null {
  if (packets.length === 0) return isLinux || isDarwin ? {
    sent: 0,
    errno: null
  } : null;
  if (isDarwin) return sendmsgXBatch(fd, packets, flags);
  if (!isLinux) return null;
  const fn = (lib.symbols as any).sendmmsg;
  if (typeof fn !== 'function') return null;
  const msgvec = new ArrayBuffer(MMSGHDR_SIZE * packets.length);
  const msg = new DataView(msgvec);
  const addrs: ArrayBuffer[] = [];
  const iovs: ArrayBuffer[] = [];
  const controls: ArrayBuffer[] = [];
  const datas: Uint8Array[] = [];
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]!;
    const data = packet.data instanceof ArrayBuffer ? new Uint8Array(packet.data) : packet.data;
    const { buf: addrBuf, len: addrLen } = encodeAddr(packet.dest);
    const iovBuf = new ArrayBuffer(IOVEC_SIZE);
    const iov = new DataView(iovBuf);
    const base = i * MMSGHDR_SIZE + MMSG_HDR;
    addrs.push(addrBuf);
    iovs.push(iovBuf);
    datas.push(data);
    writePtrValue(iov, IOVEC_BASE, data);
    iov.setBigUint64(IOVEC_LEN, BigInt(data.byteLength), true);
    writePtrValue(msg, base + MSG_NAME, addrBuf);
    msg.setUint32(base + MSG_NAMELEN, addrLen, true);
    writePtrValue(msg, base + MSG_IOV, iovBuf);
    writeSize(msg, base + MSG_IOVLEN, 1);
    msg.setInt32(base + MSG_FLAGS, 0, true);
    if (packet.ecn !== undefined) {
      const controlBuf = new ArrayBuffer(CMSG_SPACE);
      const control = new DataView(controlBuf);
      const cmsgLen = CMSG_DATA + CMSG_DATA_LEN;
      const family = packet.dest.family === 'ipv6' ? IPPROTO_IPV6 : IPPROTO_IP;
      const type = packet.dest.family === 'ipv6' ? IPV6_TCLASS : IP_TOS;
      writeSize(control, CMSG_LEN, cmsgLen);
      control.setInt32(CMSG_LEVEL, family, true);
      control.setInt32(CMSG_TYPE, type, true);
      control.setInt32(CMSG_DATA, packet.ecn & 3, true);
      controls.push(controlBuf);
      writePtrValue(msg, base + MSG_CONTROL, controlBuf);
      writeSize(msg, base + MSG_CONTROLLEN, CMSG_SPACE);
    } else {
      writePtrValue(msg, base + MSG_CONTROL, null);
      writeSize(msg, base + MSG_CONTROLLEN, 0);
    }
  }
  const rc = Number(fn(fd, msgvec, packets.length, flags));
  if (rc < 0) return {
    sent: 0,
    errno: -getErrno()
  };
  return {
    sent: rc,
    errno: null
  };
}
function sendmsgXBatch(fd: number, packets: SendmsgBatchPacket[], flags: number): {
  sent: number;
  errno: number | null;
} | null {
  const fn = (lib.symbols as any).sendmsg_x;
  if (typeof fn !== 'function') return null;
  const msgvec = new ArrayBuffer(MSGHDR_X_SIZE * packets.length);
  const msg = new DataView(msgvec);
  const addrs: ArrayBuffer[] = [];
  const iovs: ArrayBuffer[] = [];
  const controls: ArrayBuffer[] = [];
  const datas: Uint8Array[] = [];
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]!;
    const data = packet.data instanceof ArrayBuffer ? new Uint8Array(packet.data) : packet.data;
    const { buf: addrBuf, len: addrLen } = encodeAddr(packet.dest);
    const iovBuf = new ArrayBuffer(IOVEC_SIZE);
    const iov = new DataView(iovBuf);
    const base = i * MSGHDR_X_SIZE;
    addrs.push(addrBuf);
    iovs.push(iovBuf);
    datas.push(data);
    writePtrValue(iov, IOVEC_BASE, data);
    iov.setBigUint64(IOVEC_LEN, BigInt(data.byteLength), true);
    writePtrValue(msg, base + MSG_NAME, addrBuf);
    msg.setUint32(base + MSG_NAMELEN, addrLen, true);
    writePtrValue(msg, base + MSG_IOV, iovBuf);
    writeSize(msg, base + MSG_IOVLEN, 1);
    msg.setInt32(base + MSG_FLAGS, 0, true);
    msg.setBigUint64(base + MSGHDR_X_DATALEN, BigInt(data.byteLength), true);
    if (packet.ecn !== undefined) {
      const controlBuf = new ArrayBuffer(CMSG_SPACE);
      const control = new DataView(controlBuf);
      const cmsgLen = CMSG_DATA + CMSG_DATA_LEN;
      const family = packet.dest.family === 'ipv6' ? IPPROTO_IPV6 : IPPROTO_IP;
      const type = packet.dest.family === 'ipv6' ? IPV6_TCLASS : IP_TOS;
      writeSize(control, CMSG_LEN, cmsgLen);
      control.setInt32(CMSG_LEVEL, family, true);
      control.setInt32(CMSG_TYPE, type, true);
      control.setInt32(CMSG_DATA, packet.ecn & 3, true);
      controls.push(controlBuf);
      writePtrValue(msg, base + MSG_CONTROL, controlBuf);
      writeSize(msg, base + MSG_CONTROLLEN, CMSG_SPACE);
    } else {
      writePtrValue(msg, base + MSG_CONTROL, null);
      writeSize(msg, base + MSG_CONTROLLEN, 0);
    }
  }
  const rc = Number(fn(fd, msgvec, packets.length, flags));
  if (rc < 0) return {
    sent: 0,
    errno: -getErrno()
  };
  return {
    sent: rc,
    errno: null
  };
}
/**
* Receive a datagram (UDP). Returns `{ data, addr }` or null on EAGAIN.
*
* This implementation returns a negative errno for receive errors, including
* EAGAIN, rather than `null`. Successful results include the sender address.
*
* ```ts no_run
* const packet = recvfrom(fd, 4096);
* if (typeof packet !== 'number') console.log(packet.addr, packet.data);
* ```
*/
export function recvfrom(fd: number, maxBytes: number = 65536, flags: number = 0): {
  data: Uint8Array;
  addr: Address | UnknownAddress;
} | number {
  const dataBuf = new ArrayBuffer(maxBytes);
  const addrBuf = new ArrayBuffer(128);
  const lenBuf = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, 128, true);
  const n = Number(lib.symbols.recvfrom(fd, dataBuf, maxBytes, flags, addrBuf, lenBuf));
  if (n < 0) return -getErrno();
  const addrLen = new DataView(lenBuf).getUint32(0, true);
  return {
    data: new Uint8Array(dataBuf, 0, n),
    addr: decodeAddr(addrBuf.slice(0, addrLen))
  };
}
/**
* Receive one UDP datagram and parse ECN traffic-class ancillary data.
*
* The socket must have `IP_RECVTOS` or `IPV6_RECVTCLASS` enabled first. The
* returned `ecn` value is masked to the two ECN bits when present; kernels may
* omit ancillary data for packets that arrived without a traffic-class mark.
*
* ```ts no_run
* setsockopt(fd, IPPROTO_IP, IP_RECVTOS, true);
* const packet = recvmsgEcn(fd, 4096);
* ```
*/
export function recvmsgEcn(fd: number, maxBytes: number = 65536, flags: number = 0): {
  data: Uint8Array;
  addr: Address | UnknownAddress;
  ecn?: number;
} | number {
  const dataBuf = new ArrayBuffer(maxBytes);
  const addrBuf = new ArrayBuffer(128);
  const controlBuf = new ArrayBuffer(CMSG_SPACE);
  const iovBuf = new ArrayBuffer(IOVEC_SIZE);
  const msgBuf = new ArrayBuffer(MSGHDR_SIZE);
  const iov = new DataView(iovBuf);
  const msg = new DataView(msgBuf);
  writePtrValue(iov, IOVEC_BASE, dataBuf);
  iov.setBigUint64(IOVEC_LEN, BigInt(maxBytes), true);
  writePtrValue(msg, MSG_NAME, addrBuf);
  msg.setUint32(MSG_NAMELEN, addrBuf.byteLength, true);
  writePtrValue(msg, MSG_IOV, iovBuf);
  writeSize(msg, MSG_IOVLEN, 1);
  writePtrValue(msg, MSG_CONTROL, controlBuf);
  writeSize(msg, MSG_CONTROLLEN, controlBuf.byteLength);
  msg.setInt32(MSG_FLAGS, flags, true);
  const n = Number(lib.symbols.recvmsg(fd, msgBuf, flags));
  if (n < 0) return -getErrno();
  const addrLen = msg.getUint32(MSG_NAMELEN, true);
  const controlLen = readSize(msg, MSG_CONTROLLEN);
  const ecn = readCmsgEcn(controlBuf, controlLen);
  return {
    data: new Uint8Array(dataBuf, 0, n),
    addr: decodeAddr(addrBuf.slice(0, addrLen)),
    ...ecn === undefined ? {} : { ecn }
  };
}
/**
* Receive one UDP datagram and parse packet-info ancillary data.
*
* Enable `IP_RECVPKTINFO` for IPv4 or `IPV6_RECVPKTINFO` for IPv6 before
* calling this helper. Kernels may omit packet-info metadata for some local
* paths; in that case `destination` and `interfaceIndex` are absent while the
* datagram payload and source address are still returned.
*
* ```ts no_run
* setsockopt(fd, IPPROTO_IP, IP_RECVPKTINFO, true);
* const packet = recvmsgPacketInfo(fd, 4096);
* ```
*/
export function recvmsgPacketInfo(fd: number, maxBytes: number = 65536, flags: number = 0): {
  data: Uint8Array;
  addr: Address | UnknownAddress;
  destination?: Address;
  interfaceIndex?: number;
} | number {
  const dataBuf = new ArrayBuffer(maxBytes);
  const addrBuf = new ArrayBuffer(128);
  const controlBuf = new ArrayBuffer(CMSG_SPACE_PACKET_INFO);
  const iovBuf = new ArrayBuffer(IOVEC_SIZE);
  const msgBuf = new ArrayBuffer(MSGHDR_SIZE);
  const iov = new DataView(iovBuf);
  const msg = new DataView(msgBuf);
  writePtrValue(iov, IOVEC_BASE, dataBuf);
  iov.setBigUint64(IOVEC_LEN, BigInt(maxBytes), true);
  writePtrValue(msg, MSG_NAME, addrBuf);
  msg.setUint32(MSG_NAMELEN, addrBuf.byteLength, true);
  writePtrValue(msg, MSG_IOV, iovBuf);
  writeSize(msg, MSG_IOVLEN, 1);
  writePtrValue(msg, MSG_CONTROL, controlBuf);
  writeSize(msg, MSG_CONTROLLEN, controlBuf.byteLength);
  msg.setInt32(MSG_FLAGS, flags, true);
  const n = Number(lib.symbols.recvmsg(fd, msgBuf, flags));
  if (n < 0) return -getErrno();
  const addrLen = msg.getUint32(MSG_NAMELEN, true);
  const controlLen = readSize(msg, MSG_CONTROLLEN);
  let destination: Address | undefined;
  let interfaceIndex: number | undefined;
  forEachCmsg(controlBuf, controlLen, (control, base, cmsgLen, level, type) => {
    if (level === IPPROTO_IP && type === IP_PKTINFO && cmsgLen >= CMSG_DATA + 12) {
      interfaceIndex = control.getUint32(base + CMSG_DATA, true);
      destination = addressFromBytes('ipv4', new Uint8Array(controlBuf, base + CMSG_DATA + 8, 4));
    } else if (level === IPPROTO_IPV6 && type === IPV6_PKTINFO && cmsgLen >= CMSG_DATA + 20) {
      destination = addressFromBytes('ipv6', new Uint8Array(controlBuf, base + CMSG_DATA, 16));
      interfaceIndex = control.getUint32(base + CMSG_DATA + 16, true);
    }
  });
  return {
    data: new Uint8Array(dataBuf, 0, n),
    addr: decodeAddr(addrBuf.slice(0, addrLen)),
    ...destination === undefined ? {} : { destination },
    ...interfaceIndex === undefined ? {} : { interfaceIndex }
  };
}
function readCmsgEcn(controlBuf: ArrayBuffer, controlLen: number): number | undefined {
  let ecn: number | undefined;
  forEachCmsg(controlBuf, controlLen, (control, base, cmsgLen, level, type) => {
    if ((level !== IPPROTO_IP || type !== IP_TOS) && (level !== IPPROTO_IPV6 || type !== IPV6_TCLASS)) return;
    ecn = (cmsgLen >= CMSG_DATA + CMSG_DATA_LEN ? control.getInt32(base + CMSG_DATA, true) : control.getUint8(base + CMSG_DATA)) & 3;
  });
  return ecn;
}
function cmsgAlign(length: number): number {
  return (length + 7) & ~7;
}
function forEachCmsg(controlBuf: ArrayBuffer, controlLen: number, cb: (control: DataView, base: number, cmsgLen: number, level: number, type: number) => void): void {
  const control = new DataView(controlBuf);
  for (let base = 0; base + CMSG_DATA <= controlLen;) {
    const cmsgLen = readSize(control, base + CMSG_LEN);
    if (cmsgLen < CMSG_DATA || base + cmsgLen > controlLen) break;
    const level = control.getInt32(base + CMSG_LEVEL, true);
    const type = control.getInt32(base + CMSG_TYPE, true);
    cb(control, base, cmsgLen, level, type);
    const next = base + cmsgAlign(cmsgLen);
    if (next <= base) break;
    base = next;
  }
}
function addressFromBytes(family: 'ipv4' | 'ipv6', bytes: Uint8Array): Address {
  if (family === 'ipv4') {
    const buf = new ArrayBuffer(SOCKADDR_IN_SIZE);
    const view = new DataView(buf);
    writeFamily(view, AF_INET, SOCKADDR_IN_SIZE);
    new Uint8Array(buf, 4, 4).set(bytes.subarray(0, 4));
    return decodeAddr(buf) as Address;
  }
  const buf = new ArrayBuffer(SOCKADDR_IN6_SIZE);
  const view = new DataView(buf);
  writeFamily(view, AF_INET6, SOCKADDR_IN6_SIZE);
  new Uint8Array(buf, 8, 16).set(bytes.subarray(0, 16));
  return decodeAddr(buf) as Address;
}
/**
* Receive multiple UDP datagrams with Linux `recvmmsg(2)`.
*
* Returns `null` on platforms without `recvmmsg`, a negative errno when no
* packet was received, or an array of datagrams with optional ECN metadata.
*/
export function recvmmsgBatch(fd: number, maxPackets: number, maxBytes: number = 65536, flags: number = 0): RecvmsgBatchPacket[] | number | null {
  const batch = createDatagramRecvBatch(maxPackets, maxBytes);
  return batch === null ? null : batch.recv(fd, flags);
}
class LinuxDatagramRecvBatch implements DatagramRecvBatch {
  #maxPackets: number;
  #msgvec: ArrayBuffer;
  #msg: DataView;
  #dataBufs: ArrayBuffer[] = [];
  #addrBufs: ArrayBuffer[] = [];
  #controlBufs: ArrayBuffer[] = [];
  #iovBufs: ArrayBuffer[] = [];
  #timeoutBuf = new ArrayBuffer(16);
  #timeout = new DataView(this.#timeoutBuf);
  constructor(maxPackets: number, maxBytes: number) {
    this.#maxPackets = maxPackets;
    this.#msgvec = new ArrayBuffer(MMSGHDR_SIZE * maxPackets);
    this.#msg = new DataView(this.#msgvec);
    for (let i = 0; i < maxPackets; i++) {
      const dataBuf = new ArrayBuffer(maxBytes);
      const addrBuf = new ArrayBuffer(128);
      const controlBuf = new ArrayBuffer(CMSG_SPACE);
      const iovBuf = new ArrayBuffer(IOVEC_SIZE);
      const iov = new DataView(iovBuf);
      const base = i * MMSGHDR_SIZE + MMSG_HDR;
      this.#dataBufs.push(dataBuf);
      this.#addrBufs.push(addrBuf);
      this.#controlBufs.push(controlBuf);
      this.#iovBufs.push(iovBuf);
      writePtrValue(iov, IOVEC_BASE, dataBuf);
      iov.setBigUint64(IOVEC_LEN, BigInt(maxBytes), true);
      writePtrValue(this.#msg, base + MSG_NAME, addrBuf);
      writePtrValue(this.#msg, base + MSG_IOV, iovBuf);
      writeSize(this.#msg, base + MSG_IOVLEN, 1);
      writePtrValue(this.#msg, base + MSG_CONTROL, controlBuf);
    }
  }
  recv(fd: number, flags: number = 0): RecvmsgBatchPacket[] | number {
    const packets: RecvmsgBatchPacket[] = [];
    const rc = this.#recvEach(fd, flags, (data, addrBuffer, addrLen, ecn) => {
      packets.push({
        data,
        addr: decodeAddr(addrBuffer.slice(0, addrLen)),
        addrBuffer,
        addrLen,
        ...ecn === undefined ? {} : { ecn }
      });
    });
    return rc < 0 ? rc : packets;
  }
  recvRaw(fd: number, flags: number = 0): RecvmsgBatchRawPacket[] | number {
    const packets: RecvmsgBatchRawPacket[] = [];
    const rc = this.#recvEach(fd, flags, (data, addrBuffer, addrLen, ecn) => {
      packets.push({
        data,
        addrBuffer,
        addrLen,
        ...ecn === undefined ? {} : { ecn }
      });
    });
    return rc < 0 ? rc : packets;
  }
  recvRawEach(fd: number, callback: RecvmsgBatchRawCallback, flags: number = 0): number {
    return this.#recvEach(fd, flags, callback);
  }
  #recvEach(fd: number, flags: number, callback: RecvmsgBatchRawCallback): number {
    const fn = (lib.symbols as any).recvmmsg;
    const msg = this.#msg;
    for (let i = 0; i < this.#maxPackets; i++) {
      const base = i * MMSGHDR_SIZE + MMSG_HDR;
      msg.setUint32(base + MSG_NAMELEN, 128, true);
      writeSize(msg, base + MSG_CONTROLLEN, CMSG_SPACE);
      msg.setInt32(base + MSG_FLAGS, 0, true);
    }
    this.#timeout.setBigUint64(0, 0n, true);
    this.#timeout.setBigUint64(8, 0n, true);
    const rc = Number(fn(fd, this.#msgvec, this.#maxPackets, flags, this.#timeoutBuf));
    if (rc < 0) return -getErrno();
    for (let i = 0; i < rc; i++) {
      const base = i * MMSGHDR_SIZE + MMSG_HDR;
      const n = msg.getUint32(i * MMSGHDR_SIZE + MMSG_LEN, true);
      const addrLen = msg.getUint32(base + MSG_NAMELEN, true);
      const controlLen = readSize(msg, base + MSG_CONTROLLEN);
      const ecn = readCmsgEcn(this.#controlBufs[i]!, controlLen);
      const addrBuffer = this.#addrBufs[i]!;
      callback(new Uint8Array(this.#dataBufs[i]!, 0, n), addrBuffer, addrLen, ecn);
    }
    return rc;
  }
}
class DarwinDatagramRecvBatch implements DatagramRecvBatch {
  #maxPackets: number;
  #msgvec: ArrayBuffer;
  #msg: DataView;
  #dataBufs: ArrayBuffer[] = [];
  #addrBufs: ArrayBuffer[] = [];
  #controlBufs: ArrayBuffer[] = [];
  #iovBufs: ArrayBuffer[] = [];
  constructor(maxPackets: number, maxBytes: number) {
    this.#maxPackets = maxPackets;
    this.#msgvec = new ArrayBuffer(MSGHDR_X_SIZE * maxPackets);
    this.#msg = new DataView(this.#msgvec);
    for (let i = 0; i < maxPackets; i++) {
      const dataBuf = new ArrayBuffer(maxBytes);
      const addrBuf = new ArrayBuffer(128);
      const controlBuf = new ArrayBuffer(CMSG_SPACE);
      const iovBuf = new ArrayBuffer(IOVEC_SIZE);
      const iov = new DataView(iovBuf);
      const base = i * MSGHDR_X_SIZE;
      this.#dataBufs.push(dataBuf);
      this.#addrBufs.push(addrBuf);
      this.#controlBufs.push(controlBuf);
      this.#iovBufs.push(iovBuf);
      writePtrValue(iov, IOVEC_BASE, dataBuf);
      iov.setBigUint64(IOVEC_LEN, BigInt(maxBytes), true);
      writePtrValue(this.#msg, base + MSG_NAME, addrBuf);
      writePtrValue(this.#msg, base + MSG_IOV, iovBuf);
      writeSize(this.#msg, base + MSG_IOVLEN, 1);
      writePtrValue(this.#msg, base + MSG_CONTROL, controlBuf);
    }
  }
  recv(fd: number, flags: number = 0): RecvmsgBatchPacket[] | number {
    const packets: RecvmsgBatchPacket[] = [];
    const rc = this.#recvEach(fd, flags, (data, addrBuffer, addrLen, ecn) => {
      packets.push({
        data,
        addr: decodeAddr(addrBuffer.slice(0, addrLen)),
        addrBuffer,
        addrLen,
        ...ecn === undefined ? {} : { ecn }
      });
    });
    return rc < 0 ? rc : packets;
  }
  recvRaw(fd: number, flags: number = 0): RecvmsgBatchRawPacket[] | number {
    const packets: RecvmsgBatchRawPacket[] = [];
    const rc = this.#recvEach(fd, flags, (data, addrBuffer, addrLen, ecn) => {
      packets.push({
        data,
        addrBuffer,
        addrLen,
        ...ecn === undefined ? {} : { ecn }
      });
    });
    return rc < 0 ? rc : packets;
  }
  recvRawEach(fd: number, callback: RecvmsgBatchRawCallback, flags: number = 0): number {
    return this.#recvEach(fd, flags, callback);
  }
  #recvEach(fd: number, flags: number, callback: RecvmsgBatchRawCallback): number {
    const fn = (lib.symbols as any).recvmsg_x;
    const msg = this.#msg;
    for (let i = 0; i < this.#maxPackets; i++) {
      const base = i * MSGHDR_X_SIZE;
      msg.setUint32(base + MSG_NAMELEN, 128, true);
      writeSize(msg, base + MSG_CONTROLLEN, CMSG_SPACE);
      msg.setInt32(base + MSG_FLAGS, 0, true);
      msg.setBigUint64(base + MSGHDR_X_DATALEN, 0n, true);
    }
    const rc = Number(fn(fd, this.#msgvec, this.#maxPackets, flags));
    if (rc < 0) return -getErrno();
    for (let i = 0; i < rc; i++) {
      const base = i * MSGHDR_X_SIZE;
      const n = Number(msg.getBigUint64(base + MSGHDR_X_DATALEN, true));
      const addrLen = msg.getUint32(base + MSG_NAMELEN, true);
      const controlLen = readSize(msg, base + MSG_CONTROLLEN);
      const ecn = readCmsgEcn(this.#controlBufs[i]!, controlLen);
      const addrBuffer = this.#addrBufs[i]!;
      callback(new Uint8Array(this.#dataBufs[i]!, 0, n), addrBuffer, addrLen, ecn);
    }
    return rc;
  }
}
/**
* Create a reusable batch datagram receiver for hot UDP loops.
*
* Returned packet byte and address views are overwritten by the next `recv()`
* call.
*
* @internal
*/
export function createDatagramRecvBatch(maxPackets: number, maxBytes: number = 65536): DatagramRecvBatch | null {
  if (maxPackets <= 0) return {
    recv() {
      return [];
    },
    recvRaw() {
      return [];
    },
    recvRawEach() {
      return 0;
    }
  };
  if (isDarwin) return typeof (lib.symbols as any).recvmsg_x === 'function' ? new DarwinDatagramRecvBatch(maxPackets, maxBytes) : null;
  if (isLinux) return typeof (lib.symbols as any).recvmmsg === 'function' ? new LinuxDatagramRecvBatch(maxPackets, maxBytes) : null;
  return null;
}
/**
* Shut down part or all of a socket connection.
*
* Errors from `shutdown(2)` are ignored to keep close paths idempotent. Use
* `SHUT_RD`, `SHUT_WR`, or `SHUT_RDWR`.
*
* ```ts no_run
* shutdown(fd, SHUT_WR);
* ```
*/
export function shutdown(fd: number, how: number = SHUT_RDWR): void {
  lib.symbols.shutdown(fd, how);
}
/**
* Close a socket.
*
* Errors from `close(2)` are ignored. After calling this, the fd must not be
* reused by user code.
*
* ```ts no_run
* close(fd);
* ```
*/
export function close(fd: number): void {
  lib.symbols.close(fd);
}
// ---------------------------------------------------------------------------
// Convenience: errno constants (returned as negative values by the above)
// ---------------------------------------------------------------------------
/** Negative errno returned when a non-blocking operation would block.
*
* ```ts no_run
* if (recv(fd) === EAGAIN) await loop.readable(fd);
* ```
*/
export const EAGAIN = isDarwin ? -35 : -11;
/** Negative errno returned while a non-blocking connect is in progress.
*
* ```ts no_run
* if (connect(fd, addr) === EINPROGRESS) await loop.writable(fd);
* ```
*/
export const EINPROGRESS = isDarwin ? -36 : -115;
/** Negative errno returned when a peer resets the connection.
*
* ```ts no_run
* if (err === ECONNRESET) console.log('peer reset');
* ```
*/
export const ECONNRESET = isDarwin ? -54 : -104;
/** Negative errno returned when writing to a closed pipe/socket.
*
* ```ts no_run
* if (send(fd, bytes) === EPIPE) console.log('closed');
* ```
*/
export const EPIPE = isDarwin ? -32 : -32;
/** Negative errno returned when a local address is already in use.
*
* ```ts no_run
* if (rc === EADDRINUSE) console.log('address busy');
* ```
*/
export const EADDRINUSE = isDarwin ? -48 : -98;
/** Negative errno returned when a remote endpoint refuses a connection.
*
* ```ts no_run
* if (rc === ECONNREFUSED) console.log('refused');
* ```
*/
export const ECONNREFUSED = isDarwin ? -61 : -111;
// ---------------------------------------------------------------------------
// connectTcp — shared TCP connection setup
// ---------------------------------------------------------------------------
/**
* Establish a non-blocking TCP connection and return the raw fd.
* Used by both Socket.connect() and TlsSocket.connect() (in fino:tls)
* to avoid duplicating the connect/SO_ERROR dance.
*
* Throws if socket creation, connection, or SO_ERROR checking fails. On error,
* the temporary fd is closed before the error is rethrown.
*
* ```ts no_run
* const fd = await connectTcp({ family: 'ipv4', ip: '127.0.0.1', port: 80 }, { noDelay: true });
* ```
*/
export async function connectTcp(addr: Address, opts: ConnectOptions = {}): Promise<number> {
  const family = addr.family === 'ipv6' ? AF_INET6 : addr.family === 'unix' ? AF_UNIX : AF_INET;
  const fd = socket(family, SOCK_STREAM, 0);
  try {
    setNonblocking(fd);
    if (opts.noDelay && family !== AF_UNIX) {
      setsockopt(fd, IPPROTO_TCP_LEVEL, TCP_NODELAY, true);
    }
    // Non-blocking connect returns immediately (EINPROGRESS).
    // Wait for writable, then check SO_ERROR for the actual result.
    connect(fd, addr);
    await loop.writable(fd);
    const errBuf = getsockopt(fd, SOL_SOCKET, SO_ERROR);
    const errno = new DataView(errBuf).getInt32(0, true);
    if (errno !== 0) {
      throw new Error('connect() failed: errno=' + errno);
    }
    return fd;
  } catch (err) {
    close(fd);
    throw err;
  }
}
// ---------------------------------------------------------------------------
// Socket — bidirectional connection that splits into Reader + Writer
// ---------------------------------------------------------------------------
/**
* A connected socket that can be split into independent Reader and Writer
* halves. The underlying fd is closed automatically when both halves close.
*
* Use the static factories rather than the constructor directly:
* ```ts no_run
* const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: 80 });
* const server = Socket.listen({ family: 'ipv6', ip: '::', port: 8080 });
* ```
*/
export class Socket {
  /**
  * Private property `#fd` used by `Socket`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #fd = undefined;
  *
  *   readInternalState() {
  *     return this.#fd;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #fd: number;
  /**
  * Private property `#remoteAddr` used by `Socket`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #remoteAddr = undefined;
  *
  *   readInternalState() {
  *     return this.#remoteAddr;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #remoteAddr: Address | null;
  /**
  * Private property `#localAddr` used by `Socket`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #localAddr = undefined;
  *
  *   readInternalState() {
  *     return this.#localAddr;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #localAddr: Address | null;
  /**
  * Private property `#closed` used by `Socket`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #closed = undefined;
  *
  *   readInternalState() {
  *     return this.#closed;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #closed: boolean;
  /**
  * Wrap an already-open socket fd.
  *
  * The constructor does not set non-blocking mode and does not duplicate the
  * fd. Prefer `Socket.connect()` or `Socket.listen()` unless integrating with
  * a lower-level accept/connect path.
  *
  * ```ts no_run
  * const sock = new Socket(fd, remoteAddr, localAddr);
  * ```
  */
  constructor(fd: number, remoteAddr: Address | null, localAddr: Address | null) {
    this.#fd = fd;
    this.#remoteAddr = remoteAddr;
    this.#localAddr = localAddr;
    this.#closed = false;
  }
  /**
  * Raw file descriptor for advanced use with the low-level API.
  *
  * ```ts no_run
  * console.log(socket.fd);
  * ```
  */
  get fd() {
    return this.#fd;
  }
  /**
  * Remote address object passed to `Socket.connect()`, or the peer address for
  * accepted sockets when known.
  *
  * ```ts no_run
  * console.log(socket.remoteAddress);
  * ```
  */
  get remoteAddress() {
    return this.#remoteAddr;
  }
  /**
  * Local bound address when known.
  *
  * Client sockets created by `Socket.connect()` currently expose `null`;
  * accepted sockets expose the listener address.
  *
  * ```ts no_run
  * console.log(socket.localAddress);
  * ```
  */
  get localAddress() {
    return this.#localAddr;
  }
  /**
  * Whether `close()` has been called or both split halves have closed.
  *
  * ```ts no_run
  * if (!socket.closed) socket.close();
  * ```
  */
  get closed() {
    return this.#closed;
  }
  /**
  * Split into a [Reader, Writer] pair. The underlying fd is closed
  * automatically when both halves have been closed.
  *
  * The Reader's close sends SHUT_RD (wakes any in-flight read with EOF).
  * The Writer's close sends SHUT_WR (sends FIN to the peer).
  *
  * ```ts no_run
  * const [reader, writer] = socket.split();
  * await writer.write(new TextEncoder().encode('hello'));
  * await writer.close();
  * await reader.close();
  * ```
  */
  split(): [BufferedBytesReader, BufferedBytesWriter] {
    const fd = this.#fd;
    const self = this;
    let closeCount = 0;
    const onBothClosed = function onBothClosed() {
      if (++closeCount === 2) {
        self.#closed = true;
        close(fd);
      }
    };
    const onReadClose = function onReadClose() {
      shutdown(fd, SHUT_RD);
      onBothClosed();
    };
    const onWriteClose = function onWriteClose() {
      shutdown(fd, SHUT_WR);
      onBothClosed();
    };
    return [new FdReader(fd, onReadClose), new FdWriter(fd, onWriteClose)];
  }
  /**
  * Immediately close the socket (both directions). Calls shutdown(SHUT_RDWR)
  * then close(fd). Idempotent.
  *
  * ```ts no_run
  * socket.close();
  * socket.close();
  * ```
  */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    shutdown(this.#fd, SHUT_RDWR);
    close(this.#fd);
  }
  [Symbol.dispose](): void {
    this.close();
  }
  /**
  * Open a non-blocking TCP or Unix-domain client connection.
  *
  * Resolves with a connected `Socket`. Throws on connection errors; temporary
  * fds are closed before the error is rethrown.
  *
  * ```ts no_run
  * const socket = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: 80 }, { noDelay: true });
  * ```
  */
  static async connect(addr: Address, opts: ConnectOptions = {}): Promise<Socket> {
    const fd = await connectTcp(addr, opts);
    return new Socket(fd, addr, null);
  }
  /**
  * Create a listening server. Returns a Server object that is an async
  * iterable of incoming Socket connections.
  *
  * Supports IPv4, IPv6, and Unix domain sockets via `addr.family`.
  *
  * If `addr.port` is zero, the returned server address contains the assigned
  * port. Unix-domain paths are unlinked before binding. Throws if bind/listen
  * fails or if `getsockname()` returns an unsupported address family.
  *
  * ```ts no_run
  * const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
  * const conn = await server.accept();
  * conn?.close();
  * server.close();
  * ```
  */
  static listen(addr: Address, opts: ListenOptions = {}): Server {
    const family = addr.family === 'ipv6' ? AF_INET6 : addr.family === 'unix' ? AF_UNIX : AF_INET;
    const serverFd = socket(family, SOCK_STREAM, 0);
    if (opts.reuseAddr !== false) {
      setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, true);
    }
    if (opts.reusePort) {
      setsockopt(serverFd, SOL_SOCKET, SO_REUSEPORT, true);
    }
    if (addr.family === 'unix') {
      const pathBuf = encodeUtf8(addr.path + '\0');
      lib.symbols.unlink(pathBuf);
    }
    bind(serverFd, addr);
    listen(serverFd, opts.backlog || 128);
    setNonblocking(serverFd);
    const decodedBoundAddr = getsockname(serverFd);
    if (!isKnownAddress(decodedBoundAddr)) {
      close(serverFd);
      throw new Error(`getsockname() returned unexpected family ${decodedBoundAddr.family}`);
    }
    const boundAddr: Address = decodedBoundAddr;
    if (boundAddr.family !== addr.family) {
      close(serverFd);
      throw new Error(`getsockname() returned unexpected family ${boundAddr.family}`);
    }
    let serverClosed = false;
    async function acceptOne() {
      while (true) {
        if (serverClosed) return null;
        await loop.readable(serverFd);
        if (serverClosed) return null;
        const result = accept(serverFd);
        if (result !== null) {
          if (!isKnownAddress(result.addr)) {
            close(result.fd);
            throw new Error(`accept() returned unexpected family ${result.addr.family}`);
          }
          return new Socket(result.fd, result.addr, boundAddr);
        }
      }
    }
    return {
      fd: serverFd,
      address: boundAddr,
      get closed() {
        return serverClosed;
      },
      accept: acceptOne,
      close() {
        if (serverClosed) return;
        serverClosed = true;
        loop.removeRead(serverFd);
        close(serverFd);
      },
      [Symbol.dispose]() {
        this.close();
      },
      [Symbol.asyncIterator]() {
        return { async next() {
          const sock = await acceptOne();
          if (sock === null) return {
            done: true,
            value: undefined
          };
          return {
            done: false,
            value: sock
          };
        } };
      }
    };
  }
}
