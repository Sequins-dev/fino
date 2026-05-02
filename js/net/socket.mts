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
 *   { family: 'ipv6', ip: '::1',       port: 8080 }
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
 */

import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import { encodeUtf8, decodeUtf8 } from '../internal/globals/encoding.mts';
import * as loop from '../runtime/loop.mts';
import { FdReader, FdWriter, BufferedBytesReader, BufferedBytesWriter } from '../internal/stream.mts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IPv4Address { family: 'ipv4'; ip: string; port: number; }
export interface IPv6Address { family: 'ipv6'; ip: string; port: number; }
export interface UnixAddress  { family: 'unix'; path: string; }
export type Address = IPv4Address | IPv6Address | UnixAddress;
export interface UnknownAddress { family: string; }

export interface ConnectOptions { noDelay?: boolean; }
export interface ListenOptions  { reuseAddr?: boolean; reusePort?: boolean; backlog?: number; }

/** Server object returned by Socket.listen(). */
export interface Server {
  fd:       number;
  address:  Address;
  accept(): Promise<Socket | null>;
  close():  void;
  [Symbol.asyncIterator](): AsyncIterator<Socket>;
}

const isDarwin = os === 'darwin';
const isLinux  = os === 'linux';
const errnoFn = isDarwin ? '__error' : '__errno_location';

// ---------------------------------------------------------------------------
// Open libc
// ---------------------------------------------------------------------------

const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

const _defs = {
  socket:     { parameters: ['i32', 'i32', 'i32'],              result: 'i32' },
  bind:       { parameters: ['i32', 'buffer', 'u32'],           result: 'i32' },
  getsockname:{ parameters: ['i32', 'buffer', 'buffer'],        result: 'i32' },
  connect:    { parameters: ['i32', 'buffer', 'u32'],           result: 'i32' },
  listen:     { parameters: ['i32', 'i32'],                     result: 'i32' },
  accept:     { parameters: ['i32', 'buffer', 'buffer'],        result: 'i32' },
  send:       { parameters: ['i32', 'buffer', 'usize', 'i32'],  result: 'isize' },
  recv:       { parameters: ['i32', 'buffer', 'usize', 'i32'],  result: 'isize' },
  sendto:     { parameters: ['i32', 'buffer', 'usize', 'i32', 'buffer', 'u32'], result: 'isize' },
  recvfrom:   { parameters: ['i32', 'buffer', 'usize', 'i32', 'buffer', 'buffer'], result: 'isize' },
  setsockopt: { parameters: ['i32', 'i32', 'i32', 'buffer', 'u32'], result: 'i32' },
  getsockopt: { parameters: ['i32', 'i32', 'i32', 'buffer', 'buffer'], result: 'i32' },
  shutdown:   { parameters: ['i32', 'i32'],                     result: 'i32' },
  close:      { parameters: ['i32'],                            result: 'i32' },
  unlink:     { parameters: ['buffer'],                         result: 'i32' },
  fcntl:      { parameters: ['i32', 'i32', 'i32'],              result: 'i32' },
  inet_pton:  { parameters: ['i32', 'buffer', 'buffer'],        result: 'i32' },
  inet_ntop:  { parameters: ['i32', 'buffer', 'buffer', 'u32'], result: 'pointer' },
  [errnoFn]:  { parameters: [],                                 result: 'pointer' },
};

// accept4 is Linux-only (sets SOCK_NONBLOCK atomically on the accepted socket)
if (isLinux) {
  _defs.accept4 = { parameters: ['i32', 'buffer', 'buffer', 'i32'], result: 'i32' };
}

const lib = dlopen(LIBC, _defs);
const errnoPtr = lib.symbols[errnoFn]!() as ArrayBuffer;

function getErrno(): number {
  return Pointer.readI32(errnoPtr, 0);
}

// ---------------------------------------------------------------------------
// Constants — platform-specific where they differ
// ---------------------------------------------------------------------------

export const AF_INET  = 2;
export const AF_INET6 = isDarwin ? 30 : 10;
export const AF_UNIX  = 1;

export const SOCK_STREAM = 1;
export const SOCK_DGRAM  = 2;

// Linux-only: OR into socket type to set non-blocking at creation time
export const SOCK_NONBLOCK = isLinux ? 0x80000 : 0;

export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;

export const SOL_SOCKET   = isDarwin ? 0xFFFF : 1;
export const SO_REUSEADDR = isDarwin ? 0x0004 : 2;
export const SO_REUSEPORT = isDarwin ? 0x0200 : 15;
export const SO_KEEPALIVE = isDarwin ? 0x0008 : 9;
export const SO_ERROR     = isDarwin ? 0x1007 : 4;

export const IPPROTO_TCP_LEVEL = 6;   // same as IPPROTO_TCP, used with setsockopt
export const TCP_NODELAY = 1;

export const SHUT_RD   = 0;
export const SHUT_WR   = 1;
export const SHUT_RDWR = 2;

// fcntl constants
const F_GETFL    = 3;
const F_SETFL    = 4;
const O_NONBLOCK = isDarwin ? 0x0004 : 0x0800;

// Sockaddr sizes
const SOCKADDR_IN_SIZE  = 16;
const SOCKADDR_IN6_SIZE = 28;
// macOS adds a 1-byte sun_len prefix; Linux does not
const SOCKADDR_UN_SIZE  = isDarwin ? 106 : 110;
const INET_ADDRSTRLEN   = 16;
const INET6_ADDRSTRLEN  = 46;

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
    view.setUint8(0, structSize); // sa_len
    view.setUint8(1, family);     // sa_family
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

export function encodeAddr(addr: Address): { buf: ArrayBuffer; len: number } {
  if (addr.family === 'ipv4') {
    const buf  = new ArrayBuffer(SOCKADDR_IN_SIZE);
    const view = new DataView(buf);
    writeFamily(view, AF_INET, SOCKADDR_IN_SIZE);
    // port is big-endian at offset 2
    view.setUint16(2, addr.port & 0xFFFF, false);
    // parse IP into the 4-byte in_addr field at offset 4
    const addrBuf = new ArrayBuffer(4);
    const rc = lib.symbols.inet_pton(AF_INET, encodeUtf8(addr.ip + '\0'), addrBuf);
    if (rc !== 1) throw new Error(`invalid IPv4 address: '${addr.ip}'`);
    new Uint8Array(buf, 4, 4).set(new Uint8Array(addrBuf));
    return { buf, len: SOCKADDR_IN_SIZE };

  } else if (addr.family === 'ipv6') {
    const buf  = new ArrayBuffer(SOCKADDR_IN6_SIZE);
    const view = new DataView(buf);
    writeFamily(view, AF_INET6, SOCKADDR_IN6_SIZE);
    view.setUint16(2, addr.port & 0xFFFF, false); // big-endian port
    // flowinfo at offset 4 (4 bytes, zeroed)
    // sin6_addr at offset 8 (16 bytes)
    const addrBuf = new ArrayBuffer(16);
    const rc = lib.symbols.inet_pton(AF_INET6, encodeUtf8(addr.ip + '\0'), addrBuf);
    if (rc !== 1) throw new Error(`invalid IPv6 address: '${addr.ip}'`);
    new Uint8Array(buf, 8, 16).set(new Uint8Array(addrBuf));
    // scope_id at offset 24 (zeroed)
    return { buf, len: SOCKADDR_IN6_SIZE };

  } else if (addr.family === 'unix') {
    const pathBytes = encodeUtf8(addr.path);
    // header = 2 bytes (len+family on macOS, uint16 family on Linux)
    const maxPath = SOCKADDR_UN_SIZE - 2;
    if (pathBytes.length + 1 > maxPath) {
      throw new Error(`Unix socket path too long (max ${maxPath - 1} bytes)`);
    }
    const structLen = 2 + pathBytes.length + 1; // header + path + NUL
    const buf  = new ArrayBuffer(SOCKADDR_UN_SIZE);
    const view = new DataView(buf);
    if (isDarwin) {
      view.setUint8(0, structLen); // sun_len
      view.setUint8(1, AF_UNIX);
    } else {
      view.setUint16(0, AF_UNIX, true);
    }
    new Uint8Array(buf, 2, pathBytes.length).set(pathBytes);
    // NUL terminator already present (ArrayBuffer is zeroed)
    return { buf, len: structLen };

  }
  const unknownFamily = (addr as never as { family: string }).family;
  throw new Error(`Unknown address family: ${unknownFamily}`);
}

/**
 * Decode a sockaddr ArrayBuffer into a JS address object.
 *
 * @param {ArrayBuffer} buf
 * @returns {{ family: 'ipv4'|'ipv6'|'unix', ip?: string, port?: number, path?: string }}
 */
export function decodeAddr(buf: ArrayBuffer): Address | UnknownAddress {
  const view   = new DataView(buf);
  const family = readFamily(view);

  if (family === AF_INET) {
    const port    = view.getUint16(2, false); // big-endian
    const addrBuf = buf.slice(4, 8);
    const strBuf  = new ArrayBuffer(INET_ADDRSTRLEN);
    lib.symbols.inet_ntop(AF_INET, addrBuf, strBuf, INET_ADDRSTRLEN);
    const ip = decodeUtf8(new Uint8Array(strBuf).subarray(0, nullTermIdx(strBuf)));
    return { family: 'ipv4', ip, port };

  } else if (family === AF_INET6) {
    const port    = view.getUint16(2, false);
    const addrBuf = buf.slice(8, 24);
    const strBuf  = new ArrayBuffer(INET6_ADDRSTRLEN);
    lib.symbols.inet_ntop(AF_INET6, addrBuf, strBuf, INET6_ADDRSTRLEN);
    const ip = decodeUtf8(new Uint8Array(strBuf).subarray(0, nullTermIdx(strBuf)));
    return { family: 'ipv6', ip, port };

  } else if (family === AF_UNIX) {
    const offset = isDarwin ? 2 : 2;
    const bytes  = new Uint8Array(buf, offset);
    const end    = bytes.indexOf(0);
    const path   = decodeUtf8(end >= 0 ? bytes.subarray(0, end) : bytes);
    return { family: 'unix', path };

  } else {
    return { family: `unknown(${family})` };
  }
}

function nullTermIdx(buf: ArrayBuffer): number {
  const bytes = new Uint8Array(buf);
  const idx   = bytes.indexOf(0);
  return idx >= 0 ? idx : bytes.length;
}

function isKnownAddress(addr: Address | UnknownAddress): addr is Address {
  return addr.family === 'ipv4' || addr.family === 'ipv6' || addr.family === 'unix';
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Create a socket.
 *
 * @param {number} [family=AF_INET]
 * @param {number} [type=SOCK_STREAM]
 * @param {number} [protocol=0]
 * @returns {number} file descriptor
 */
export function socket(family: number = AF_INET, type: number = SOCK_STREAM, protocol: number = 0): number {
  const fd = lib.symbols.socket(family, type, protocol);
  if (fd < 0) throw new Error(`socket() failed: errno=${getErrno()}`);
  return fd;
}

/**
 * Set socket option. Value can be a boolean/number (written as 4-byte int)
 * or an ArrayBuffer for raw option data.
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
 */
export function getsockopt(fd: number, level: number, optname: number, bufSize: number = 4): ArrayBuffer {
  const buf     = new ArrayBuffer(bufSize);
  const lenBuf  = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, bufSize, true);
  const rc = lib.symbols.getsockopt(fd, level, optname, buf, lenBuf);
  if (rc < 0) throw new Error(`getsockopt() failed: errno=${getErrno()}`);
  return buf;
}

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
 * Set a socket to non-blocking mode via fcntl(F_SETFL, O_NONBLOCK).
 */
export function setNonblocking(fd: number): void {
  const flags = lib.symbols.fcntl(fd, F_GETFL, 0);
  if (flags < 0) throw new Error(`fcntl(F_GETFL) failed: errno=${getErrno()}`);
  const rc = lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  if (rc < 0) throw new Error(`fcntl(F_SETFL, O_NONBLOCK) failed: errno=${getErrno()}`);
}

/**
 * Bind a socket to an address.
 *
 * @param {number} fd
 * @param {{ family, ip, port }|{ family, path }} addr
 */
export function bind(fd: number, addr: Address): void {
  const { buf, len } = encodeAddr(addr);
  const rc = lib.symbols.bind(fd, buf, len);
  if (rc < 0) {
    const errno = getErrno();
    const addrInUse = isDarwin ? 48 : 98;
    const msg = errno === addrInUse
      ? `bind() failed: address already in use${(addr as any).port !== undefined ? ` (port ${(addr as any).port})` : ''}`
      : `bind() failed: errno=${errno}`;
    throw new Error(msg);
  }
}

/**
 * Mark a socket as passive (server socket).
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
 * @param {number} serverFd
 * @param {boolean} [setNonblock=true]  Make the accepted fd non-blocking.
 * @returns {{ fd: number, addr: object }|null}
 */
export function accept(serverFd: number, setNonblock: boolean = true): { fd: number; addr: Address | UnknownAddress } | null {
  const addrBuf = new ArrayBuffer(128); // large enough for any sockaddr
  const lenBuf  = new ArrayBuffer(4);
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
  const addr    = decodeAddr(addrBuf.slice(0, addrLen));
  return { fd: clientFd, addr };
}

/**
 * Initiate a connection to a remote address.
 * For non-blocking sockets, returns -115 (EINPROGRESS) on Linux or
 * -36 (EINPROGRESS) on macOS — use fino:loop addWrite() to wait for
 * completion, then check SO_ERROR via getsockopt().
 *
 * @param {number} fd
 * @param {{ family, ip, port }|{ family, path }} addr
 * @returns {number} 0 on immediate success, negative errno otherwise
 */
export function connect(fd: number, addr: Address): number {
  const { buf, len } = encodeAddr(addr);
  const rc = lib.symbols.connect(fd, buf, len);
  return rc < 0 ? -getErrno() : rc;
}

/**
 * Send data on a connected socket.
 *
 * @param {number} fd
 * @param {Uint8Array|ArrayBuffer} data
 * @param {number} [flags=0]
 * @returns {number} bytes sent, or negative errno
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
 * @param {number} fd
 * @param {number} [maxBytes=65536]
 * @param {number} [flags=0]
 * @returns {Uint8Array|null} received bytes, or null if connection closed, or negative number on error
 */
export function recv(fd: number, maxBytes: number = 65536, flags: number = 0): Uint8Array | number | null {
  const buf = new ArrayBuffer(maxBytes);
  const n   = Number(lib.symbols.recv(fd, buf, maxBytes, flags));
  if (n === 0)  return null; // connection closed
  if (n < 0)   return -getErrno();
  return new Uint8Array(buf, 0, n);
}

/**
 * Send a datagram to a specific address (UDP).
 *
 * @param {number} fd
 * @param {Uint8Array|ArrayBuffer} data
 * @param {{ family, ip, port }} destAddr
 * @param {number} [flags=0]
 * @returns {number} bytes sent, or negative errno
 */
export function sendto(fd: number, data: Uint8Array | ArrayBuffer, destAddr: Address, flags: number = 0): number {
  const { buf: addrBuf, len: addrLen } = encodeAddr(destAddr);
  const dataBuf = data instanceof ArrayBuffer ? data : data.buffer;
  const dataLen = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
  const rc = Number(lib.symbols.sendto(fd, dataBuf, dataLen, flags, addrBuf, addrLen));
  return rc < 0 ? -getErrno() : rc;
}

/**
 * Receive a datagram (UDP). Returns `{ data, addr }` or null on EAGAIN.
 *
 * @param {number} fd
 * @param {number} [maxBytes=65536]
 * @param {number} [flags=0]
 * @returns {{ data: Uint8Array, addr: object }|null}
 */
export function recvfrom(fd: number, maxBytes: number = 65536, flags: number = 0): { data: Uint8Array; addr: Address | UnknownAddress } | number {
  const dataBuf = new ArrayBuffer(maxBytes);
  const addrBuf = new ArrayBuffer(128);
  const lenBuf  = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, 128, true);

  const n = Number(lib.symbols.recvfrom(fd, dataBuf, maxBytes, flags, addrBuf, lenBuf));
  if (n < 0) return -getErrno();
  const addrLen = new DataView(lenBuf).getUint32(0, true);
  return {
    data: new Uint8Array(dataBuf, 0, n),
    addr: decodeAddr(addrBuf.slice(0, addrLen)),
  };
}

/**
 * Shut down part or all of a socket connection.
 */
export function shutdown(fd: number, how: number = SHUT_RDWR): void {
  lib.symbols.shutdown(fd, how);
}

/**
 * Close a socket.
 */
export function close(fd: number): void {
  lib.symbols.close(fd);
}

// ---------------------------------------------------------------------------
// Convenience: errno constants (returned as negative values by the above)
// ---------------------------------------------------------------------------

export const EAGAIN      = isDarwin ? -35  : -11;
export const EINPROGRESS = isDarwin ? -36  : -115;
export const ECONNRESET  = isDarwin ? -54  : -104;
export const EPIPE       = isDarwin ? -32  : -32;
export const EADDRINUSE  = isDarwin ? -48  : -98;
export const ECONNREFUSED = isDarwin ? -61 : -111;


// ---------------------------------------------------------------------------
// connectTcp — shared TCP connection setup
// ---------------------------------------------------------------------------

/**
 * Establish a non-blocking TCP connection and return the raw fd.
 * Used by both Socket.connect() and TlsSocket.connect() (in fino:tls)
 * to avoid duplicating the connect/SO_ERROR dance.
 *
 * @param {object} lp — loop handle
 * @param {{ family: 'ipv4'|'ipv6'|'unix', ip?: string, port?: number, path?: string }} addr
 * @param {{ noDelay?: boolean }} [opts]
 * @returns {Promise<number>} connected file descriptor
 */
export async function connectTcp(addr: Address, opts: ConnectOptions = {}): Promise<number> {
  const family = addr.family === 'ipv6' ? AF_INET6
               : addr.family === 'unix' ? AF_UNIX
               : AF_INET;
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
 *   const sock = await Socket.connect(lp, { family: 'ipv4', ip: '…', port: 80 });
 *   const server = Socket.listen(lp, { family: 'ipv6', ip: '::', port: 8080 });
 */
export class Socket {
  #fd: number;
  #remoteAddr: Address | null;
  #localAddr: Address | null;
  #closed: boolean;

  constructor(fd: number, remoteAddr: Address | null, localAddr: Address | null) {
    this.#fd = fd;
    this.#remoteAddr = remoteAddr;
    this.#localAddr = localAddr;
    this.#closed = false;
  }

  /** Raw file descriptor — for advanced use with the low-level API. */
  get fd() { return this.#fd; }

  /** Remote address object, or null for server-side accepted sockets. */
  get remoteAddress() { return this.#remoteAddr; }

  /** Local address object, or null if not known. */
  get localAddress() { return this.#localAddr; }

  get closed() { return this.#closed; }

  /**
   * Split into a [Reader, Writer] pair. The underlying fd is closed
   * automatically when both halves have been closed.
   *
   * The Reader's close sends SHUT_RD (wakes any in-flight read with EOF).
   * The Writer's close sends SHUT_WR (sends FIN to the peer).
   *
   * @returns {[BufferedBytesReader, BufferedBytesWriter]}
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
    const onReadClose  = function onReadClose()  { shutdown(fd, SHUT_RD); onBothClosed(); };
    const onWriteClose = function onWriteClose() { shutdown(fd, SHUT_WR); onBothClosed(); };
    return [
      new FdReader(fd, onReadClose),
      new FdWriter(fd, onWriteClose),
    ];
  }

  /**
   * Immediately close the socket (both directions). Calls shutdown(SHUT_RDWR)
   * then close(fd). Idempotent.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    shutdown(this.#fd, SHUT_RDWR);
    close(this.#fd);
  }

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
   * @param {object} lp — loop handle from fino:loop
   * @param {{ family: 'ipv4'|'ipv6'|'unix', ip?: string, port?: number, path?: string }} addr
   * @param {{ reuseAddr?: boolean, reusePort?: boolean, backlog?: number }} [opts]
   * @returns {{ fd, address, accept(), close(), [Symbol.asyncIterator]() }}
   */
  static listen(addr: Address, opts: ListenOptions = {}): Server {
    const family = addr.family === 'ipv6' ? AF_INET6
                 : addr.family === 'unix' ? AF_UNIX
                 : AF_INET;
    const serverFd = socket(family, SOCK_STREAM, 0);
    if (opts.reuseAddr !== false) {
      setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, true);
    }
    if (opts.reusePort) {
      setsockopt(serverFd, SOL_SOCKET, SO_REUSEPORT, true);
    }
    if (addr.family === 'unix') {
      const pathBuf = encodeUtf8(addr.path + '\0');
      lib.symbols.unlink(pathBuf); // ignore error — file may not exist
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
        // Spurious wakeup — wait again.
      }
    }

    return {
      fd: serverFd,
      address: boundAddr,

      /** Await the next incoming connection. Returns a Socket, or null if closed. */
      accept: acceptOne,

      /** Stop accepting connections and close the server fd. */
      close() {
        if (serverClosed) return;
        serverClosed = true;
        loop.removeRead(serverFd);
        close(serverFd);
      },

      [Symbol.asyncIterator]() {
        return {
          async next() {
            const sock = await acceptOne();
            if (sock === null) return { done: true, value: undefined };
            return { done: false, value: sock };
          },
        };
      },
    };
  }
}
