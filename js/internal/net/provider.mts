/**
 * internal:net/provider — Abstract NetworkProvider interface.
 *
 * Defines the contract all network providers must satisfy. The interface
 * operates at the **connection and stream level**, not at the fd/syscall level.
 * Virtual network providers (in-memory channels between Realms) do not have
 * file descriptors — the abstract interface must not expose that detail.
 *
 * Concrete implementations include:
 *   - DiskNetworkProvider — real POSIX sockets backed by libc (fino:net/socket)
 *   - VirtualNetworkProvider — in-memory byte channels between Realms (future)
 *   - RestrictedNetworkProvider — host/CIDR allowlist enforcement (future)
 *
 * The concrete reader/writer returned by `Connection.split()` may be backed by
 * real fds (FdReader/FdWriter) or by in-memory channels — callers only see the
 * BufferedBytesReader / BufferedBytesWriter interface from fino:stream.
 *
 * @internal
 */

import type { BufferedBytesReader, BufferedBytesWriter } from '../stream.mts';

// ---------------------------------------------------------------------------
// Address types
// ---------------------------------------------------------------------------

export interface IPv4Address { family: 'ipv4'; ip: string; port: number; }
export interface IPv6Address { family: 'ipv6'; ip: string; port: number; }
export interface UnixAddress  { family: 'unix'; path: string; }

/** A resolved network address — TCP/UDP endpoint or Unix socket path. */
export type SocketAddress = IPv4Address | IPv6Address | UnixAddress;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for outbound TCP connections. */
export interface ConnectOptions {
  /** Disable Nagle's algorithm on the connection. */
  noDelay?: boolean;
}

/** Options for TCP listeners. */
export interface ListenOptions {
  reuseAddr?: boolean;
  reusePort?: boolean;
  backlog?: number;
}

// ---------------------------------------------------------------------------
// Connection — a connected bidirectional byte stream
// ---------------------------------------------------------------------------

/**
 * A connected bidirectional byte stream.
 *
 * Backed by a real socket fd (DiskNetworkProvider) or an in-memory channel pair
 * (VirtualNetworkProvider). Callers see only the stream interface.
 */
export interface Connection {
  readonly remoteAddress: SocketAddress | null;
  readonly localAddress: SocketAddress | null;
  readonly closed: boolean;
  /**
   * Split the connection into independent read and write halves.
   * After splitting, use `reader` and `writer` independently.
   * Close both halves to fully close the connection.
   */
  split(): [BufferedBytesReader, BufferedBytesWriter];
  /** Close the connection immediately, releasing resources. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Listener — accepts inbound connections
// ---------------------------------------------------------------------------

/**
 * A listening server. Accepts inbound TCP connections.
 */
export interface Listener {
  readonly address: SocketAddress;
  /**
   * Accept the next incoming connection.
   * Returns null when the listener is closed.
   */
  accept(): Promise<Connection | null>;
  /** Stop listening and release the bound address. */
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<Connection>;
}

// ---------------------------------------------------------------------------
// DatagramSocket — connectionless UDP endpoint
// ---------------------------------------------------------------------------

/**
 * A bound UDP socket for sending and receiving datagrams.
 */
export interface DatagramSocket {
  readonly address: SocketAddress;
  /** Send a datagram to a remote address. Returns bytes sent. */
  send(data: Uint8Array, dest: SocketAddress): Promise<number>;
  /** Receive the next incoming datagram. */
  recv(maxBytes?: number): Promise<{ data: Uint8Array; addr: SocketAddress }>;
  /** Close the socket and release the bound address. */
  close(): void;
}

// ---------------------------------------------------------------------------
// NetworkProvider — abstract factory
// ---------------------------------------------------------------------------

/**
 * Abstract base class for network providers.
 *
 * A provider creates Connections, Listeners, and DatagramSockets. The
 * mechanism is provider-specific (real sockets vs in-memory channels vs
 * proxied connections), but the returned types are identical.
 */
export abstract class NetworkProvider {
  /** Create an outbound TCP connection to `addr`. */
  abstract connect(addr: SocketAddress, opts?: ConnectOptions): Promise<Connection>;

  /** Start a TCP listener bound to `addr`. */
  abstract listen(addr: SocketAddress, opts?: ListenOptions): Listener;

  /** Create a bound UDP endpoint at `addr`. */
  abstract datagram(addr: SocketAddress): Promise<DatagramSocket>;
}
