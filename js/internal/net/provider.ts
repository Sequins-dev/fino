/**
* internal:net/provider - Abstract NetworkProvider interface.
*
* Defines the contract all network providers must satisfy. The interface
* operates at the **connection and stream level**, not at the fd/syscall level.
* Virtual network providers (in-memory channels between Realms) do not have
* file descriptors - the abstract interface must not expose that detail.
*
* Current callers use OS-backed socket adapters and the deterministic
* `SimulatedNetworkProvider` test implementation. Dedicated disk, virtual,
* and restricted provider classes are possible future implementations of this
* same connection/listener/datagram contract.
*
* The concrete reader/writer returned by `Connection.split()` may be backed by
* real fds (FdReader/FdWriter) or by in-memory channels - callers only see the
* BufferedBytesReader / BufferedBytesWriter interface from fino:stream.
*
* ## Example
*
* ```ts no_run
* import { NetworkProvider } from 'internal:net/provider';
* import type { NetworkProvider as NetworkProviderInstance } from 'internal:net/provider';
* void NetworkProvider;
*
* async function fetchFromLoopback(provider: NetworkProviderInstance) {
*   const conn = await provider.connect({
*     family: 'ipv4',
*     ip: '127.0.0.1',
*     port: 8080,
*   });
*
*   const [reader, writer] = conn.split();
*   await writer.write(new TextEncoder().encode('ping'));
*   await writer.flush();
*
*   const bytes = await reader.read();
*   conn.close();
*   return bytes;
* }
* ```
*
* @internal
*/
import type { BufferedBytesReader, BufferedBytesWriter } from '../stream.ts';
// ---------------------------------------------------------------------------
// Address types
// ---------------------------------------------------------------------------
/**
* IPv4 TCP or UDP endpoint address.
*
* Providers expect `ip` to be a numeric dotted-quad address and `port` to be a
* valid transport port. Hostname resolution is handled by DNS providers before
* this shape reaches the network provider.
*
* ```ts
* const addr = { family: 'ipv4', ip: '127.0.0.1', port: 8080 };
* addr.family;
* ```
*
* @internal
*/
export interface IPv4Address {
  /**
  * Address-family discriminator for IPv4 sockets.
  *
  * ```ts
  * const addr = { family: 'ipv4', ip: '127.0.0.1', port: 80 };
  * addr.family;
  * ```
  */
  family: 'ipv4';
  /**
  * Numeric IPv4 address string.
  *
  * Invalid strings fail in the concrete provider when it attempts to bind,
  * connect, send, or receive; this interface does not parse them.
  *
  * ```ts
  * const addr = { family: 'ipv4', ip: '0.0.0.0', port: 0 };
  * addr.ip;
  * ```
  */
  ip: string;
  /**
  * TCP or UDP port number.
  *
  * Port `0` is allowed for binds that should let the provider choose an
  * ephemeral port. Negative or out-of-range values fail in concrete providers.
  *
  * ```ts
  * const addr = { family: 'ipv4', ip: '127.0.0.1', port: 443 };
  * addr.port;
  * ```
  */
  port: number;
}
/**
* IPv6 TCP or UDP endpoint address.
*
* The `ip` field is a numeric IPv6 literal. Zone identifiers and formatting
* rules are provider-specific; callers should pass canonical addresses where
* possible.
*
* ```ts
* const addr = { family: 'ipv6', ip: '::1', port: 8080 };
* addr.ip;
* ```
*
* @internal
*/
export interface IPv6Address {
  /**
  * Address-family discriminator for IPv6 sockets.
  *
  * ```ts
  * const addr = { family: 'ipv6', ip: '::1', port: 80 };
  * addr.family;
  * ```
  */
  family: 'ipv6';
  /**
  * Numeric IPv6 address string.
  *
  * Concrete providers perform actual validation and may reject unsupported
  * zone or scope syntax.
  *
  * ```ts
  * const addr = { family: 'ipv6', ip: '::', port: 0 };
  * addr.ip;
  * ```
  */
  ip: string;
  /**
  * TCP or UDP port number.
  *
  * Port `0` may request an ephemeral bind port. Connection attempts require a
  * concrete remote port.
  *
  * ```ts
  * const addr = { family: 'ipv6', ip: '::1', port: 8443 };
  * addr.port;
  * ```
  */
  port: number;
}
/**
* Unix domain socket path address.
*
* This address family is stream-oriented for current providers. UDP-style
* datagram semantics for Unix sockets are provider-specific and may be
* unsupported.
*
* ```ts
* const addr = { family: 'unix', path: '/tmp/fino.sock' };
* addr.path;
* ```
*
* @internal
*/
export interface UnixAddress {
  /**
  * Address-family discriminator for Unix domain sockets.
  *
  * ```ts
  * const addr = { family: 'unix', path: '/tmp/fino.sock' };
  * addr.family;
  * ```
  */
  family: 'unix';
  /**
  * Filesystem path for the socket.
  *
  * Path existence, cleanup, permissions, and maximum length are handled by the
  * concrete provider and underlying operating system.
  *
  * ```ts
  * const addr = { family: 'unix', path: '/tmp/fino.sock' };
  * addr.path;
  * ```
  */
  path: string;
}
/**
* Resolved network address accepted by network providers.
*
* The union intentionally excludes hostnames; callers should use a DNS
* provider before connecting to a named host. Concrete providers may reject a
* member for operations they do not support, such as Unix datagrams.
*
* ```ts
* const addr = { family: 'ipv4', ip: '127.0.0.1', port: 3000 };
* addr.family;
* ```
*
* @internal
*/
export type SocketAddress = IPv4Address | IPv6Address | UnixAddress;
// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
/**
* Options for outbound stream connections.
*
* Providers may ignore options they cannot apply. Defaults are provider
* specific; the disk provider uses OS defaults unless an option is present.
*
* ```ts
* const opts = { noDelay: true };
* opts.noDelay;
* ```
*
* @internal
*/
export interface ConnectOptions {
  /**
  * Disable Nagle's algorithm when supported.
  *
  * `true` requests low-latency writes for TCP. `false` or `undefined` leaves
  * the provider default in place.
  *
  * ```ts
  * const opts = { noDelay: true };
  * opts.noDelay;
  * ```
  */
  noDelay?: boolean;
}
/**
* Options for stream listeners.
*
* These values map to common socket options for POSIX-backed providers.
* Virtual providers may treat them as hints or ignore them.
*
* ```ts
* const opts = { reuseAddr: true, backlog: 128 };
* opts.backlog;
* ```
*
* @internal
*/
export interface ListenOptions {
  /**
  * Request address reuse for a listener bind.
  *
  * `undefined` uses the provider default. Exact semantics vary by operating
  * system and address family.
  *
  * ```ts
  * const opts = { reuseAddr: true };
  * opts.reuseAddr;
  * ```
  */
  reuseAddr?: boolean;
  /**
  * Request port reuse for a listener bind.
  *
  * Some operating systems do not support this option or apply stronger rules
  * than `reuseAddr`; providers may reject or ignore it.
  *
  * ```ts
  * const opts = { reusePort: false };
  * opts.reusePort;
  * ```
  */
  reusePort?: boolean;
  /**
  * Requested accept backlog.
  *
  * `undefined` uses the provider default. The operating system may clamp the
  * final backlog to a configured maximum.
  *
  * ```ts
  * const opts = { backlog: 64 };
  * opts.backlog;
  * ```
  */
  backlog?: number;
}
// ---------------------------------------------------------------------------
// Connection - a connected bidirectional byte stream
// ---------------------------------------------------------------------------
/**
* A connected bidirectional byte stream produced by `connect` or `accept`.
*
* A connection may be backed by a real socket fd (`FdReader`/`FdWriter`) or by
* an in-memory channel pair; callers never see that distinction and interact
* only through the reader/writer pair returned by `split`. The connection
* carries the resolved `remoteAddress` and `localAddress` when the transport can
* report them, and a `closed` snapshot flag.
*
* Typical use is to split once into a reader and writer, drive them
* independently, and close when finished. The two halves may observe closure at
* slightly different times as buffered data drains.
*
* ```ts no_run
* import type { Connection } from 'internal:net/provider';
*
* async function echo(conn: Connection): Promise<void> {
*   const [reader, writer] = conn.split();
*   const chunk = await reader.read();
*   if (chunk) {
*     await writer.write(chunk);
*     await writer.flush();
*   }
*   conn.close();
* }
* ```
*/
export interface Connection {
  /**
  * Peer address for the connected stream, or `null` when unavailable.
  *
  * Virtual providers and some accepted Unix sockets may not expose a remote
  * address. The value should remain stable for the life of the connection.
  *
  * ```ts
  * const remoteAddress = null;
  * remoteAddress;
  * ```
  */
  readonly remoteAddress: SocketAddress | null;
  /**
  * Local bound address for the connected stream, or `null` when unavailable.
  *
  * Providers should fill this after connect or accept when the underlying
  * transport can report it.
  *
  * ```ts
  * const localAddress = { family: 'ipv4', ip: '127.0.0.1', port: 5000 };
  * localAddress.port;
  * ```
  */
  readonly localAddress: SocketAddress | null;
  /**
  * Whether the connection has been closed.
  *
  * The flag is a snapshot. Split reader and writer halves may observe closure
  * at different times while buffered data drains.
  *
  * ```ts
  * const closed = false;
  * closed;
  * ```
  */
  readonly closed: boolean;
  /**
  * Split the connection into independent read and write halves.
  * After splitting, use `reader` and `writer` independently.
  * Close both halves to fully close the connection.
  *
  * Repeated calls are provider-specific; consumers should split once and retain
  * the returned pair.
  *
  * ```ts no_run
  * const pair = connection.split();
  * pair.length;
  * ```
  */
  split(): [BufferedBytesReader, BufferedBytesWriter];
  /**
  * Close the connection immediately, releasing resources.
  *
  * Buffered writes may be discarded depending on the provider. Calling `close`
  * after the connection is already closed should be harmless.
  *
  * ```ts no_run
  * connection.close();
  * ```
  */
  close(): void;
}
// ---------------------------------------------------------------------------
// Listener - accepts inbound connections
// ---------------------------------------------------------------------------
/**
* A bound stream server that accepts inbound connections.
*
* A listener is created synchronously by `NetworkProvider.listen` and exposes
* the actual bound `address` (including any ephemeral port chosen for
* `port: 0`). Accept the next connection with `accept`, which resolves `null`
* once the listener is closed, or iterate the listener directly with
* `for await` to consume connections until it shuts down.
*
* Closing the listener releases the bound address and unblocks pending accepts
* with `null` so accept loops terminate cleanly.
*
* ```ts no_run
* import type { NetworkProvider } from 'internal:net/provider';
*
* async function serve(provider: NetworkProvider): Promise<void> {
*   const listener = provider.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
*   console.log('listening on', listener.address);
*
*   for await (const conn of listener) {
*     const [reader, writer] = conn.split();
*     const req = await reader.read();
*     if (req) await writer.write(req);
*     conn.close();
*   }
* }
* ```
*/
export interface Listener {
  /**
  * Bound listener address.
  *
  * Providers should expose the actual address after binding, including an
  * ephemeral port chosen for `port: 0` where applicable.
  *
  * ```ts
  * const address = { family: 'ipv4', ip: '127.0.0.1', port: 3000 };
  * address.port;
  * ```
  */
  readonly address: SocketAddress;
  /**
  * Accept the next incoming connection.
  * Returns null when the listener is closed.
  *
  * Provider errors reject the promise. A graceful listener close resolves
  * pending accepts with `null` so loops can terminate cleanly.
  *
  * ```ts no_run
  * const conn = await listener.accept();
  * conn?.close();
  * ```
  */
  accept(): Promise<Connection | null>;
  /**
  * Stop listening and release the bound address.
  *
  * Pending accepts should unblock with `null`. Repeated closes should be
  * tolerated by concrete implementations.
  *
  * ```ts no_run
  * listener.close();
  * ```
  */
  close(): void;
  /**
  * Iterate accepted connections until the listener closes.
  *
  * The iterator yields only non-null connections. Provider errors surface as
  * iterator rejections.
  *
  * ```ts no_run
  * for await (const conn of listener) {
  *   conn.close();
  * }
  * ```
  */
  [Symbol.asyncIterator](): AsyncIterator<Connection>;
}
// ---------------------------------------------------------------------------
// DatagramSocket - connectionless UDP endpoint
// ---------------------------------------------------------------------------
/**
* A bound connectionless endpoint for sending and receiving datagrams.
*
* Created by `NetworkProvider.datagram`, a datagram socket has a fixed local
* `address` and exchanges individual packets with arbitrary peers: `send`
* delivers one datagram to a destination address and `recv` yields the next
* inbound packet together with its sender address. There is no connection state
* and no delivery guarantee — datagrams may be lost, reordered, or duplicated
* depending on the underlying transport.
*
* ```ts no_run
* import type { DatagramSocket, SocketAddress } from 'internal:net/provider';
*
* async function ping(socket: DatagramSocket, peer: SocketAddress): Promise<string> {
*   await socket.send(new TextEncoder().encode('ping'), peer);
*   const { data, addr } = await socket.recv();
*   console.log('reply from', addr);
*   return new TextDecoder().decode(data);
* }
* ```
*/
export interface DatagramSocket {
  /**
  * Bound datagram address.
  *
  * Providers should expose the actual local endpoint, including an ephemeral
  * port selected by the OS when binding to port `0`.
  *
  * ```ts
  * const address = { family: 'ipv4', ip: '127.0.0.1', port: 5353 };
  * address.family;
  * ```
  */
  readonly address: SocketAddress;
  /**
  * Send a datagram to a remote address.
  *
  * The returned promise resolves with the number of payload bytes accepted for
  * send, or rejects on provider or OS errors. No delivery guarantee is implied.
  *
  * ```ts no_run
  * const bytes = await socket.send(new Uint8Array([1, 2, 3]), { family: 'ipv4', ip: '127.0.0.1', port: 9 });
  * bytes;
  * ```
  */
  send(data: Uint8Array, dest: SocketAddress): Promise<number>;
  /**
  * Receive the next incoming datagram.
  *
  * `maxBytes` defaults to the provider's datagram buffer size. The promise
  * resolves with payload bytes and the sender address, or rejects when the
  * socket is closed or the provider reports an error.
  *
  * ```ts no_run
  * const packet = await socket.recv(1500);
  * packet.data.byteLength;
  * ```
  */
  recv(maxBytes?: number): Promise<{
    data: Uint8Array;
    addr: SocketAddress;
  }>;
  /**
  * Close the socket and release the bound address.
  *
  * Pending receives should reject or resolve according to the concrete
  * provider's close semantics; callers should not send after close.
  *
  * ```ts no_run
  * socket.close();
  * ```
  */
  close(): void;
}
// ---------------------------------------------------------------------------
// NetworkProvider - abstract factory
// ---------------------------------------------------------------------------
/**
* Abstract factory that every network provider implementation extends.
*
* A provider is the single entry point for creating the three transport
* primitives: outbound `Connection`s via `connect`, stream `Listener`s via
* `listen`, and `DatagramSocket`s via `datagram`. Concrete subclasses decide how
* those primitives are realized — the OS-backed provider wraps real sockets, the
* `SimulatedNetworkProvider` uses deterministic in-memory channels, and future
* virtual, disk, or restricted providers may proxy or gate the same operations.
* Because the contract is stated in terms of connections and streams rather than
* file descriptors, providers without real fds (in-memory channels between
* Realms) satisfy the same interface.
*
* Higher-level code accepts a `NetworkProvider` and stays agnostic to which
* implementation backs it, so the same client or server logic runs against real
* sockets in production and against a scripted simulator in tests.
*
* ```ts no_run
* import { NetworkProvider } from 'internal:net/provider';
* import type { SocketAddress } from 'internal:net/provider';
*
* async function httpGet(provider: NetworkProvider, addr: SocketAddress): Promise<Uint8Array | null> {
*   const conn = await provider.connect(addr, { noDelay: true });
*   const [reader, writer] = conn.split();
*   await writer.write(new TextEncoder().encode('GET / HTTP/1.0\r\n\r\n'));
*   await writer.flush();
*   const response = await reader.read();
*   conn.close();
*   return response;
* }
* ```
*/
export abstract class NetworkProvider {
  /**
  * Create an outbound stream connection to `addr`.
  *
  * The returned promise resolves with a connected `Connection` or rejects on
  * DNS-free address, routing, permission, timeout, or provider errors. The
  * interface does not define a default timeout.
  *
  * ```ts no_run
  * const conn = await provider.connect({ family: 'ipv4', ip: '127.0.0.1', port: 80 });
  * conn.close();
  * ```
  */
  abstract connect(addr: SocketAddress, opts?: ConnectOptions): Promise<Connection>;
  /**
  * Start a stream listener bound to `addr`.
  *
  * The method returns synchronously with a `Listener`; bind failures are thrown
  * by concrete providers. The actual bound address is available on
  * `listener.address`.
  *
  * ```ts no_run
  * const listener = provider.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
  * listener.close();
  * ```
  */
  abstract listen(addr: SocketAddress, opts?: ListenOptions): Listener;
  /**
  * Create a bound datagram endpoint at `addr`.
  *
  * The returned promise resolves with a `DatagramSocket` or rejects if the
  * provider cannot bind the address. Unix address support is provider-specific.
  *
  * ```ts no_run
  * const socket = await provider.datagram({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
  * socket.close();
  * ```
  */
  abstract datagram(addr: SocketAddress): Promise<DatagramSocket>;
}
