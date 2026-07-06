/**
* internal:net/simulated-provider - deterministic in-memory network provider.
*
* This module provides a test-only `NetworkProvider` implementation for
* protocol conformance harnesses that need scripted network behavior without
* real sockets, Docker, or operating-system timing. It models bound addresses,
* UDP-like datagram sockets, stream listeners, accepted stream connections, a
* manual clock, and packet-level impairments such as latency, MTU drops, loss,
* duplication, corruption, reordering, queue overflow, and NAT-style source
* rewriting.
*
* The simulator intentionally sits at the provider/datagram boundary instead
* of pretending to be POSIX. That keeps it reusable for QUIC, DNS, clustered
* transports, and future virtual-I/O tests while avoiding fake fd semantics.
* Tests control time with `advance()` and then call `runUntilIdle()` to deliver
* every event due at the current simulated time.
*
* ```ts
* import { SimulatedNetworkProvider } from 'internal:net/simulated-provider';
*
* const net = new SimulatedNetworkProvider({
*   defaultLink: { latencyMs: 20, lossRate: 0.1 },
* });
* const client = await net.datagram({ family: 'ipv4', ip: '10.0.0.1', port: 0 });
* const server = await net.datagram({ family: 'ipv4', ip: '10.0.0.2', port: 4433 });
*
* await client.send(new TextEncoder().encode('ping'), server.address);
* net.advance(20);
* net.runUntilIdle();
* console.log(await server.recv());
* ```
*
* Useful background:
* - RFC 9000 QUIC transport: https://www.rfc-editor.org/rfc/rfc9000
* - RFC 9221 QUIC DATAGRAM: https://www.rfc-editor.org/rfc/rfc9221
*
* @internal
*/
import { NetworkProvider, type Connection, type ConnectOptions, type DatagramSocket, type ListenOptions, type Listener, type SocketAddress } from './provider.ts';
type QueueResolver<T> = {
  resolve(value: T): void;
  reject(error: unknown): void;
};
type DatagramPacket = {
  data: Uint8Array;
  addr: SocketAddress;
  ecn?: number;
};
type ScheduledDatagram = {
  id: number;
  dueAt: number;
  linkKey: string;
  releaseQueueSlot: boolean;
  localAddress: SocketAddress;
  from: SocketAddress;
  to: SocketAddress;
  data: Uint8Array;
  ecn?: number;
};
type LinkState = {
  options: RequiredLinkOptions;
  queued: number;
};
type LinkPair = {
  key: string;
  state: LinkState;
};
type ScriptedDropRule = {
  remaining: number;
  fromKey?: string;
  toKey?: string;
};
type ScriptedCorruptionRule = {
  remaining: number;
  fromKey?: string;
  toKey?: string;
  corruptByte?: number;
};
type StreamPair = {
  clientInbound: SimulatedByteQueue;
  serverInbound: SimulatedByteQueue;
};
type SimulatedDatagramDropReason = 'closed' | 'loss' | 'mtu' | 'queue-overflow' | 'unbound-destination';
type SimulatedNetworkTraceBase = {
  /** Simulated timestamp at which the event was recorded. */
  at: number;
  /** Original local address before NAT rewriting. */
  localAddress: SocketAddress;
  /** Source address visible to the receiver after NAT rewriting. */
  from: SocketAddress;
  /** Destination address requested by the sender. */
  to: SocketAddress;
  /** Datagram payload size associated with the event. */
  bytes: number;
  /** Copied datagram payload for packet-level test assertions. */
  data: Uint8Array;
  /** Optional ECN codepoint carried with the datagram. */
  ecn?: number;
};
/**
* Packet and stream trace event emitted by `SimulatedNetworkProvider`.
*
* Trace events are append-only snapshots intended for assertions and debugging.
* Address objects and payload byte counts are copied when the event is created,
* so later socket mutation or packet corruption does not alter previous trace
* entries. The union is discriminated by `type`: datagram lifecycle events
* (`datagram:queued`, `datagram:duplicated`, `datagram:dropped`,
* `datagram:delivered`) carry the full packet fields, while stream events
* (`stream:listen`, `stream:connect`, `stream:accepted`) carry only their
* relevant addresses. Every event is pushed onto `SimulatedNetworkProvider.trace`
* in the order it occurred at the current simulated time.
*
* ```ts no_run
* import { SimulatedNetworkProvider } from 'internal:net/simulated-provider';
* import type { SimulatedNetworkTraceEvent } from 'internal:net/simulated-provider';
*
* const net = new SimulatedNetworkProvider({ defaultLink: { latencyMs: 5 } });
* const a = await net.datagram({ family: 'ipv4', ip: '10.0.0.1', port: 0 });
* const b = await net.datagram({ family: 'ipv4', ip: '10.0.0.2', port: 4433 });
*
* await a.send(new TextEncoder().encode('ping'), b.address);
* net.advance(5);
* net.runUntilIdle();
*
* const dropped = net.trace.filter(
*   (event: SimulatedNetworkTraceEvent) => event.type === 'datagram:dropped',
* );
* console.log('drops so far:', dropped.length);
* ```
*
* @internal
*/
export type SimulatedNetworkTraceEvent = (SimulatedNetworkTraceBase & {
  type: 'datagram:queued';
  dueAt: number;
}) | (SimulatedNetworkTraceBase & {
  type: 'datagram:duplicated';
  dueAt: number;
}) | (SimulatedNetworkTraceBase & {
  type: 'datagram:dropped';
  reason: SimulatedDatagramDropReason;
}) | (SimulatedNetworkTraceBase & {
  type: 'datagram:delivered';
}) | {
  type: 'stream:listen';
  at: number;
  address: SocketAddress;
} | {
  type: 'stream:connect';
  at: number;
  localAddress: SocketAddress;
  remoteAddress: SocketAddress;
} | {
  type: 'stream:accepted';
  at: number;
  localAddress: SocketAddress;
  remoteAddress: SocketAddress;
};
/**
* Link impairment options for one source/destination pair.
*
* Values are deterministic for a given provider seed. Rates are clamped to the
* inclusive range `0..1`; `1` means the impairment always applies and `0` means
* it never applies. `queueLimit` counts original datagrams accepted for a link,
* not duplicate copies created by the duplication impairment. Every field is
* optional; omitted fields inherit from the provider's default link, and unset
* delay/size fields mean "no impairment" (zero delay, unbounded MTU/queue).
*
* Pass these to the constructor's `defaultLink` to impair all traffic, or to
* `setLink(from, to, options)` to override a single source/destination path.
*
* ```ts no_run
* import { SimulatedNetworkProvider } from 'internal:net/simulated-provider';
*
* // A lossy, high-latency mobile-style uplink with a 1200-byte path MTU.
* const net = new SimulatedNetworkProvider({
*   defaultLink: {
*     latencyMs: 40,
*     jitterMs: 15,
*     lossRate: 0.05,
*     mtu: 1200,
*     reorderRate: 0.1,
*   },
* });
*
* // Make one specific path drop everything larger than a tiny MTU.
* net.setLink(
*   { family: 'ipv4', ip: '10.0.0.1', port: 5000 },
*   { family: 'ipv4', ip: '10.0.0.2', port: 4433 },
*   { mtu: 8, duplicateRate: 1 },
* );
* ```
*
* @internal
*/
export interface SimulatedLinkOptions {
  /** Base one-way delivery delay in simulated milliseconds. Defaults to `0`. */
  latencyMs?: number;
  /** Symmetric random jitter added around `latencyMs`. Defaults to `0`. */
  jitterMs?: number;
  /** Maximum payload size accepted by the link. Oversized packets are dropped. */
  mtu?: number;
  /** Throughput cap in payload bytes per simulated millisecond. */
  bandwidthBytesPerMs?: number;
  /** Maximum original datagrams queued on this link at once. */
  queueLimit?: number;
  /** Probability that an accepted datagram is dropped before queueing. */
  lossRate?: number;
  /** Probability that an accepted datagram is delivered twice. */
  duplicateRate?: number;
  /** Probability that the first payload byte is corrupted. */
  corruptionRate?: number;
  /** Byte value written to the first payload byte when corruption applies. */
  corruptByte?: number;
  /** Probability that a datagram is delayed by `reorderDelayMs`. */
  reorderRate?: number;
  /** Extra delay used when reordering applies. Defaults to `1`. */
  reorderDelayMs?: number;
}
/**
* Constructor options for `SimulatedNetworkProvider`.
*
* `defaultLink` applies to traffic without a more specific `setLink()` rule.
* `seed` controls jitter, rates, and reordering decisions so test runs are
* reproducible: two providers built with the same seed and the same sequence of
* sends make identical loss, duplication, corruption, and reorder choices.
*
* ```ts no_run
* import { SimulatedNetworkProvider } from 'internal:net/simulated-provider';
*
* // Reproducible 10% loss across every link, pinned to seed 42.
* const net = new SimulatedNetworkProvider({
*   seed: 42,
*   defaultLink: { latencyMs: 20, lossRate: 0.1 },
* });
* ```
*
* @internal
*/
export interface SimulatedNetworkProviderOptions {
  /** Deterministic random seed. Defaults to `1`. */
  seed?: number;
  /** Default impairment options for all links. */
  defaultLink?: SimulatedLinkOptions;
}
type RequiredLinkOptions = {
  latencyMs: number;
  jitterMs: number;
  mtu: number;
  bandwidthBytesPerMs: number;
  queueLimit: number;
  lossRate: number;
  duplicateRate: number;
  corruptionRate: number;
  corruptByte: number | null;
  reorderRate: number;
  reorderDelayMs: number;
};
const DEFAULT_LINK: RequiredLinkOptions = {
  latencyMs: 0,
  jitterMs: 0,
  mtu: Infinity,
  bandwidthBytesPerMs: Infinity,
  queueLimit: Infinity,
  lossRate: 0,
  duplicateRate: 0,
  corruptionRate: 0,
  corruptByte: null,
  reorderRate: 0,
  reorderDelayMs: 1
};
function clampRate(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
function nonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(0, value);
}
function resolveLinkOptions(input: SimulatedLinkOptions | undefined, base: RequiredLinkOptions = DEFAULT_LINK): RequiredLinkOptions {
  return {
    latencyMs: nonNegative(input?.latencyMs, base.latencyMs),
    jitterMs: nonNegative(input?.jitterMs, base.jitterMs),
    mtu: input?.mtu === undefined ? base.mtu : Math.max(0, input.mtu),
    bandwidthBytesPerMs: input?.bandwidthBytesPerMs === undefined ? base.bandwidthBytesPerMs : Math.max(0, input.bandwidthBytesPerMs),
    queueLimit: input?.queueLimit === undefined ? base.queueLimit : Math.max(0, input.queueLimit),
    lossRate: input?.lossRate === undefined ? base.lossRate : clampRate(input.lossRate),
    duplicateRate: input?.duplicateRate === undefined ? base.duplicateRate : clampRate(input.duplicateRate),
    corruptionRate: input?.corruptionRate === undefined ? base.corruptionRate : clampRate(input.corruptionRate),
    corruptByte: input?.corruptByte === undefined ? base.corruptByte : input.corruptByte & 255,
    reorderRate: input?.reorderRate === undefined ? base.reorderRate : clampRate(input.reorderRate),
    reorderDelayMs: nonNegative(input?.reorderDelayMs, base.reorderDelayMs)
  };
}
function copyAddress<T extends SocketAddress>(addr: T): T {
  if (addr.family === 'unix') return {
    family: 'unix',
    path: addr.path
  } as T;
  return {
    family: addr.family,
    ip: addr.ip,
    port: addr.port
  } as T;
}
function addressKey(addr: SocketAddress): string {
  if (addr.family === 'unix') return `unix:${addr.path}`;
  return `${addr.family}:${addr.ip}:${addr.port}`;
}
function ensureIpAddress(addr: SocketAddress, operation: string): Extract<SocketAddress, {
  family: 'ipv4' | 'ipv6';
}> {
  if (addr.family !== 'ipv4' && addr.family !== 'ipv6') {
    throw new TypeError(`${operation} requires an IPv4 or IPv6 address`);
  }
  return addr;
}
function cloneBytes(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}
function maybeTruncate(data: Uint8Array, maxBytes: number): Uint8Array {
  if (data.byteLength <= maxBytes) return data;
  return data.subarray(0, maxBytes);
}
class DeterministicRandom {
  #state: number;
  constructor(seed: number) {
    this.#state = seed >>> 0;
    if (this.#state === 0) this.#state = 1;
  }
  next(): number {
    this.#state = Math.imul(1664525, this.#state) + 1013904223 >>> 0;
    return this.#state / 4294967296;
  }
  chance(rate: number): boolean {
    if (rate <= 0) return false;
    if (rate >= 1) return true;
    return this.next() < rate;
  }
}
class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: QueueResolver<T | null>[] = [];
  #closed = false;
  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(item);
    else this.#items.push(item);
  }
  shift(): Promise<T | null> {
    if (this.#items.length > 0) return Promise.resolve(this.#items.shift()!);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.#waiters.push({
        resolve,
        reject
      });
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(null);
  }
}
class SimulatedByteQueue {
  #chunks: Uint8Array[] = [];
  #waiters: QueueResolver<Uint8Array | null>[] = [];
  #closed = false;
  #error: Error | null = null;
  #take(maxBytes: number): Uint8Array | null {
    const first = this.#chunks[0];
    if (first === undefined) return null;
    if (first.byteLength <= maxBytes) return this.#chunks.shift()!;
    this.#chunks[0] = first.subarray(maxBytes);
    return first.subarray(0, maxBytes);
  }
  push(data: Uint8Array): void {
    if (this.#closed) return;
    const copy = cloneBytes(data);
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(copy);
    else this.#chunks.push(copy);
  }
  read(maxBytes = 65536): Promise<Uint8Array | null> {
    if (maxBytes <= 0) return Promise.resolve(new Uint8Array(0));
    const chunk = this.#take(maxBytes);
    if (chunk !== null) return Promise.resolve(chunk);
    if (this.#error !== null) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.#waiters.push({
        resolve,
        reject
      });
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(null);
  }
  error(error: Error): void {
    if (this.#closed && this.#error !== null) return;
    this.#closed = true;
    this.#error = error;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}
class SimulatedStreamReader implements AsyncIterable<Uint8Array> {
  #queue: SimulatedByteQueue;
  #closed = false;
  constructor(queue: SimulatedByteQueue) {
    this.#queue = queue;
  }
  get closed(): boolean {
    return this.#closed;
  }
  read(input?: number | {
    maxBytes?: number;
  }): Promise<Uint8Array | null> {
    if (this.#closed) return Promise.resolve(null);
    const maxBytes = typeof input === 'number' ? input : input?.maxBytes;
    return this.#queue.read(maxBytes ?? 65536);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.close();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      const chunk = await this.read();
      if (chunk === null) {
        await this.close();
        return;
      }
      yield chunk;
    }
  }
}
class SimulatedStreamWriter {
  #queue: SimulatedByteQueue;
  #closed = false;
  constructor(queue: SimulatedByteQueue) {
    this.#queue = queue;
  }
  get closed(): boolean {
    return this.#closed;
  }
  async write(data: Uint8Array | ArrayBuffer): Promise<void> {
    if (this.#closed) throw new Error('Writer is closed');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.#queue.push(bytes);
  }
  async writev(vecs: Uint8Array[], count: number = vecs.length): Promise<void> {
    for (let i = 0; i < count; i++) {
      const vec = vecs[i];
      if (vec !== undefined && vec.byteLength > 0) await this.write(vec);
    }
  }
  async pipe(iterable: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<void> {
    for await (const chunk of iterable) await this.write(chunk);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.close();
  }
}
class SimulatedConnection implements Connection {
  readonly remoteAddress: SocketAddress | null;
  readonly localAddress: SocketAddress | null;
  #inbound: SimulatedByteQueue;
  #outbound: SimulatedByteQueue;
  #closed = false;
  #split = false;
  constructor(localAddress: SocketAddress | null, remoteAddress: SocketAddress | null, inbound: SimulatedByteQueue, outbound: SimulatedByteQueue) {
    this.localAddress = localAddress === null ? null : copyAddress(localAddress);
    this.remoteAddress = remoteAddress === null ? null : copyAddress(remoteAddress);
    this.#inbound = inbound;
    this.#outbound = outbound;
  }
  get closed(): boolean {
    return this.#closed;
  }
  split(): [any, any] {
    if (this.#split) throw new Error('Simulated connection has already been split');
    if (this.#closed) throw new Error('Simulated connection is closed');
    this.#split = true;
    return [new SimulatedStreamReader(this.#inbound), new SimulatedStreamWriter(this.#outbound)];
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#inbound.close();
    this.#outbound.close();
  }
}
class SimulatedListener implements Listener {
  readonly address: SocketAddress;
  #provider: SimulatedNetworkProvider;
  #queue = new AsyncQueue<Connection>();
  #closed = false;
  constructor(provider: SimulatedNetworkProvider, address: SocketAddress) {
    this.#provider = provider;
    this.address = copyAddress(address);
  }
  get closed(): boolean {
    return this.#closed;
  }
  accept(): Promise<Connection | null> {
    return this.#queue.shift();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#provider._removeListener(this.address, this);
    this.#queue.close();
  }
  _push(connection: Connection): void {
    this.#queue.push(connection);
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Connection> {
    for (;;) {
      const connection = await this.accept();
      if (connection === null) return;
      yield connection;
    }
  }
}
class SimulatedDatagramSocket implements DatagramSocket {
  readonly address: SocketAddress;
  #provider: SimulatedNetworkProvider;
  #queue: DatagramPacket[] = [];
  #waiters: Array<QueueResolver<DatagramPacket> & {
    maxBytes: number;
  }> = [];
  #readableWaiters: QueueResolver<void>[] = [];
  #closed = false;
  constructor(provider: SimulatedNetworkProvider, address: SocketAddress) {
    this.#provider = provider;
    this.address = copyAddress(address);
  }
  get closed(): boolean {
    return this.#closed;
  }
  send(data: Uint8Array, dest: SocketAddress, ecn?: number): Promise<number> {
    if (this.#closed) return Promise.reject(new Error('Simulated datagram socket is closed'));
    if (!(data instanceof Uint8Array)) return Promise.reject(new TypeError('Simulated datagram send data must be a Uint8Array'));
    this.#provider._sendDatagram(this.address, data, dest, ecn);
    return Promise.resolve(data.byteLength);
  }
  sendNow(data: Uint8Array, dest: SocketAddress, ecn?: number): number {
    if (this.#closed) return -1;
    if (!(data instanceof Uint8Array)) throw new TypeError('Simulated datagram send data must be a Uint8Array');
    this.#provider._sendDatagram(this.address, data, dest, ecn);
    return data.byteLength;
  }
  recv(maxBytes = 65536): Promise<{
    data: Uint8Array;
    addr: SocketAddress;
  }> {
    if (this.#closed) return Promise.reject(new Error('Simulated datagram socket is closed'));
    if (!Number.isInteger(maxBytes) || maxBytes < 0) return Promise.reject(new RangeError('maxBytes must be a non-negative integer'));
    const packet = this.#queue.shift();
    if (packet !== undefined) {
      return Promise.resolve({
        data: maybeTruncate(packet.data, maxBytes),
        addr: copyAddress(packet.addr),
        ecn: packet.ecn
      });
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({
        resolve,
        reject,
        maxBytes
      });
    });
  }
  recvNow(maxBytes = 65536): {
    data: Uint8Array;
    addr: SocketAddress;
  } | null {
    if (this.#closed) return null;
    if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
    const packet = this.#queue.shift();
    if (packet === undefined) return null;
    return {
      data: maybeTruncate(packet.data, maxBytes),
      addr: copyAddress(packet.addr),
      ecn: packet.ecn
    };
  }
  waitReadable(): Promise<void> {
    if (this.#queue.length > 0) return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error('Simulated datagram socket is closed'));
    return new Promise((resolve, reject) => {
      this.#readableWaiters.push({
        resolve,
        reject
      });
    });
  }
  waitWritable(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Simulated datagram socket is closed'));
    return Promise.resolve();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#provider._removeDatagram(this.address, this);
    const error = new Error('Simulated datagram socket is closed');
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
    const readableWaiters = this.#readableWaiters.splice(0);
    for (const waiter of readableWaiters) waiter.reject(error);
  }
  _enqueue(data: Uint8Array, addr: SocketAddress, ecn?: number): void {
    if (this.#closed) return;
    const packet = {
      data: cloneBytes(data),
      addr: copyAddress(addr),
      ecn
    };
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({
        data: maybeTruncate(packet.data, waiter.maxBytes),
        addr: copyAddress(packet.addr),
        ecn: packet.ecn
      });
    } else {
      this.#queue.push(packet);
      const readableWaiters = this.#readableWaiters.splice(0);
      for (const readableWaiter of readableWaiters) readableWaiter.resolve(undefined);
    }
  }
}
/**
* Deterministic in-memory implementation of `NetworkProvider`.
*
* The provider is designed for tests. It does not perform DNS resolution,
* expose file descriptors, or use the host event loop. All datagram delivery is
* controlled by simulated time; stream connections are accepted immediately but
* still use the normal Fino `BufferedBytesReader`/`BufferedBytesWriter` shapes.
*
* The datagram model is fully manual: `send()` accepts a packet and schedules it
* for a future simulated time based on the link's latency, jitter, bandwidth, and
* reorder impairments, but nothing is handed to a receiver until the test both
* moves time forward with `advance(ms)` and drains due events with
* `runUntilIdle()`. Splitting time movement from delivery lets a test assert
* exactly which packets are in flight at each instant. Stream `connect()`/
* `listen()` bypass the clock entirely — a connect immediately pushes an accepted
* peer onto the matching listener and returns a wired in-memory byte pipe.
*
* Impairments compose from a default link plus per-path overrides, and scripted
* one-shot hooks (`dropNextDatagrams`, `corruptNextDatagrams`) fire before the
* probabilistic link rules. NAT-style source rewriting (`rewriteSource`) changes
* the address a receiver sees and routes replies back to the original socket.
* Every scheduling decision, drop, duplication, and delivery is recorded on
* `trace` for packet-level assertions.
*
* ```ts no_run
* import { SimulatedNetworkProvider } from 'internal:net/simulated-provider';
*
* const net = new SimulatedNetworkProvider({
*   seed: 7,
*   defaultLink: { latencyMs: 15, lossRate: 0.2 },
* });
*
* const client = await net.datagram({ family: 'ipv4', ip: '10.0.0.1', port: 0 });
* const server = await net.datagram({ family: 'ipv4', ip: '10.0.0.2', port: 4433 });
*
* net.dropNextDatagrams(1);                       // force the first send to be lost
* await client.send(new TextEncoder().encode('hello'), server.address);
* await client.send(new TextEncoder().encode('world'), server.address);
*
* net.advance(15);
* console.log('delivered', net.runUntilIdle(), 'datagrams');
* const packet = await server.recv();
* console.log(new TextDecoder().decode(packet.data)); // 'world'
*
* client.close();
* server.close();
* ```
*
* @internal
*/
export class SimulatedNetworkProvider extends NetworkProvider {
  #clock = 0;
  #rng: DeterministicRandom;
  #defaultLink: RequiredLinkOptions;
  #links = new Map<string, LinkState>();
  #datagrams = new Map<string, SimulatedDatagramSocket>();
  #listeners = new Map<string, SimulatedListener>();
  #sourceRewrites = new Map<string, SocketAddress>();
  #destinationRewrites = new Map<string, SocketAddress>();
  #scriptedDrops: ScriptedDropRule[] = [];
  #scriptedCorruptions: ScriptedCorruptionRule[] = [];
  #scheduled: ScheduledDatagram[] = [];
  #nextEventId = 1;
  #nextEphemeralPort = 49152;
  /**
  * Append-only log of every datagram and stream event, in occurrence order.
  *
  * Each entry is a copied snapshot, so mutating a socket or corrupting a later
  * packet never rewrites earlier history. Tests typically map this to `.type`
  * to assert the exact sequence of scheduling, drops, duplication, and delivery,
  * or filter it to inspect the payload of a specific delivered datagram. The
  * array is never cleared automatically; create a fresh provider for a fresh log.
  *
  * ```ts no_run
  * const kinds = net.trace.map((event) => event.type);
  * // e.g. ['datagram:queued', 'datagram:dropped', 'datagram:delivered']
  * ```
  */
  readonly trace: SimulatedNetworkTraceEvent[] = [];
  /**
  * Construct a provider with an optional seed and default link impairments.
  *
  * The clock starts at `0`. `options.seed` (default `1`) makes every random
  * impairment decision reproducible, and `options.defaultLink` supplies the
  * baseline impairments applied to any path without a `setLink()` override.
  *
  * ```ts no_run
  * const net = new SimulatedNetworkProvider({ seed: 3, defaultLink: { latencyMs: 10 } });
  * ```
  */
  constructor(options: SimulatedNetworkProviderOptions = {}) {
    super();
    this.#rng = new DeterministicRandom(options.seed ?? 1);
    this.#defaultLink = resolveLinkOptions(options.defaultLink);
  }
  /** Current simulated time in milliseconds. */
  get now(): number {
    return this.#clock;
  }
  /**
  * Advance the manual clock by `ms`.
  *
  * This does not deliver packets by itself. Call `runUntilIdle()` afterwards
  * so assertions can separate time movement from event delivery.
  */
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance(ms) requires a non-negative finite number');
    this.#clock += ms;
    return this.#clock;
  }
  /**
  * Deliver every queued datagram due at the current simulated time.
  *
  * Returns the number of datagram copies actually delivered. Drops caused by a
  * receiver closing after scheduling are traced but not counted as deliveries.
  */
  runUntilIdle(): number {
    let delivered = 0;
    for (;;) {
      this.#scheduled.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
      const next = this.#scheduled[0];
      if (next === undefined || next.dueAt > this.#clock) return delivered;
      this.#scheduled.shift();
      if (next.releaseQueueSlot) {
        const link = this.#links.get(next.linkKey);
        if (link !== undefined) link.queued = Math.max(0, link.queued - 1);
      }
      const targetAddress = this.#destinationRewrites.get(addressKey(next.to)) ?? next.to;
      const target = this.#datagrams.get(addressKey(targetAddress));
      if (target === undefined || target.closed) {
        this.#traceDatagramDrop(next.localAddress, next.from, next.to, next.data.byteLength, 'unbound-destination');
        continue;
      }
      target._enqueue(next.data, next.from, next.ecn);
      this.#trace({
        type: 'datagram:delivered',
        at: this.#clock,
        localAddress: copyAddress(next.localAddress),
        from: copyAddress(next.from),
        to: copyAddress(next.to),
        bytes: next.data.byteLength,
        data: cloneBytes(next.data),
        ecn: next.ecn
      });
      delivered++;
    }
  }
  /** Next scheduled datagram delivery time, or `null` when no datagrams are queued. */
  nextDueAt(): number | null {
    let nextDueAt: number | null = null;
    for (const event of this.#scheduled) {
      if (nextDueAt === null || event.dueAt < nextDueAt) nextDueAt = event.dueAt;
    }
    return nextDueAt;
  }
  /**
  * Configure impairments for one exact source/destination datagram path.
  *
  * Later calls replace previous options for that pair while inheriting missing
  * fields from the provider default link.
  */
  setLink(from: SocketAddress, to: SocketAddress, options: SimulatedLinkOptions): void {
    const key = this.#linkKey(from, to);
    const existing = this.#links.get(key);
    this.#links.set(key, {
      queued: existing?.queued ?? 0,
      options: resolveLinkOptions(options, this.#defaultLink)
    });
  }
  /**
  * Rewrite the source address visible to receivers for datagrams sent by
  * `from`.
  *
  * Calling this again changes the mapping, which lets tests simulate NAT
  * rebinding and path changes without creating a new socket. Replies sent to
  * the rewritten address are routed back to the original bound socket.
  */
  rewriteSource(from: SocketAddress, rewritten: SocketAddress): void {
    const fromKey = addressKey(from);
    const existing = this.#sourceRewrites.get(fromKey);
    if (existing !== undefined) this.#destinationRewrites.delete(addressKey(existing));
    this.#sourceRewrites.set(fromKey, copyAddress(rewritten));
    this.#destinationRewrites.set(addressKey(rewritten), copyAddress(from));
  }
  /** Remove a NAT/source rewrite installed with `rewriteSource()`. */
  clearSourceRewrite(from: SocketAddress): void {
    const fromKey = addressKey(from);
    const existing = this.#sourceRewrites.get(fromKey);
    if (existing !== undefined) this.#destinationRewrites.delete(addressKey(existing));
    this.#sourceRewrites.delete(fromKey);
  }
  /**
  * Drop a fixed number of future datagrams before normal link scheduling.
  *
  * Optional `from` and `to` filters match the original bound sender address
  * and requested destination address, before NAT source rewriting is applied.
  * Dropped packets are traced as `datagram:dropped` with reason `loss`.
  */
  dropNextDatagrams(count = 1, filters: {
    from?: SocketAddress;
    to?: SocketAddress;
  } = {}): void {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('dropNextDatagrams(count) requires a non-negative integer');
    if (count === 0) return;
    this.#scriptedDrops.push({
      remaining: count,
      ...filters.from === undefined ? {} : { fromKey: addressKey(filters.from) },
      ...filters.to === undefined ? {} : { toKey: addressKey(filters.to) }
    });
  }
  /**
  * Corrupt a fixed number of future datagrams before normal link scheduling.
  *
  * Optional `from` and `to` filters match the original bound sender address
  * and requested destination address, before NAT source rewriting is applied.
  * The datagram is still delivered, but its first byte is overwritten.
  */
  corruptNextDatagrams(count = 1, filters: {
    from?: SocketAddress;
    to?: SocketAddress;
    corruptByte?: number;
  } = {}): void {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('corruptNextDatagrams(count) requires a non-negative integer');
    if (count === 0) return;
    this.#scriptedCorruptions.push({
      remaining: count,
      ...filters.from === undefined ? {} : { fromKey: addressKey(filters.from) },
      ...filters.to === undefined ? {} : { toKey: addressKey(filters.to) },
      ...filters.corruptByte === undefined ? {} : { corruptByte: filters.corruptByte & 255 }
    });
  }
  /**
  * Open a stream connection to a listener bound at `addr`.
  *
  * Connections are wired synchronously and are not subject to the simulated
  * clock or link impairments: a fresh in-memory byte pipe is created, the server
  * half is pushed onto the matching listener's accept queue, and the client half
  * is returned resolved. `_opts` is accepted for interface compatibility but
  * ignored. Throws if no open listener is bound at `addr`.
  *
  * ```ts no_run
  * const listener = net.listen({ family: 'ipv4', ip: '127.0.0.1', port: 8080 });
  * const client = await net.connect({ family: 'ipv4', ip: '127.0.0.1', port: 8080 });
  * const server = await listener.accept();
  * ```
  */
  async connect(addr: SocketAddress, _opts?: ConnectOptions): Promise<Connection> {
    const listener = this.#listeners.get(addressKey(addr));
    if (listener === undefined || listener.closed) {
      throw new Error(`No simulated listener bound at ${addressKey(addr)}`);
    }
    const localAddress = this.#allocateStreamLocal(addr);
    const pair: StreamPair = {
      clientInbound: new SimulatedByteQueue(),
      serverInbound: new SimulatedByteQueue()
    };
    const client = new SimulatedConnection(localAddress, addr, pair.clientInbound, pair.serverInbound);
    const server = new SimulatedConnection(addr, localAddress, pair.serverInbound, pair.clientInbound);
    this.#trace({
      type: 'stream:connect',
      at: this.#clock,
      localAddress: copyAddress(localAddress),
      remoteAddress: copyAddress(addr)
    });
    this.#trace({
      type: 'stream:accepted',
      at: this.#clock,
      localAddress: copyAddress(addr),
      remoteAddress: copyAddress(localAddress)
    });
    listener._push(server);
    return client;
  }
  /**
  * Bind a stream listener at `addr` and return it synchronously.
  *
  * A `port: 0` bind is assigned a deterministic ephemeral port; the actual bound
  * address is available on `listener.address`. `_opts` is accepted for interface
  * compatibility but ignored. Throws if a listener is already bound at the
  * resolved address.
  *
  * ```ts no_run
  * const listener = net.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
  * console.log('bound on', listener.address);
  * ```
  */
  listen(addr: SocketAddress, _opts?: ListenOptions): Listener {
    const bound = this.#allocateAddress(addr, this.#listeners);
    const key = addressKey(bound);
    if (this.#listeners.has(key)) throw new Error(`Simulated listener already bound at ${key}`);
    const listener = new SimulatedListener(this, bound);
    this.#listeners.set(key, listener);
    this.#trace({
      type: 'stream:listen',
      at: this.#clock,
      address: copyAddress(bound)
    });
    return listener;
  }
  /**
  * Bind a datagram socket at `addr`.
  *
  * Only IPv4 and IPv6 addresses are accepted; Unix datagrams are unsupported and
  * throw a `TypeError`. A `port: 0` bind receives a deterministic ephemeral port.
  * Sends from the returned socket are queued and delivered through the simulated
  * clock, so a receiver only observes them after `advance()` plus `runUntilIdle()`.
  * Throws if a datagram socket is already bound at the resolved address.
  *
  * ```ts no_run
  * const socket = await net.datagram({ family: 'ipv4', ip: '10.0.0.1', port: 0 });
  * console.log('bound on port', socket.address);
  * ```
  */
  async datagram(addr: SocketAddress): Promise<DatagramSocket> {
    ensureIpAddress(addr, 'Simulated datagram bind');
    const bound = this.#allocateAddress(addr, this.#datagrams);
    const key = addressKey(bound);
    if (this.#datagrams.has(key)) throw new Error(`Simulated datagram socket already bound at ${key}`);
    const socket = new SimulatedDatagramSocket(this, bound);
    this.#datagrams.set(key, socket);
    return socket;
  }
  /**
  * Unbind a datagram socket during its own `close()`.
  *
  * Internal wiring called by `SimulatedDatagramSocket`; the address is only
  * released if it still maps to this exact socket, so a rebind under the same
  * address is never clobbered. Not part of the public provider surface.
  */
  _removeDatagram(addr: SocketAddress, socket: SimulatedDatagramSocket): void {
    const key = addressKey(addr);
    if (this.#datagrams.get(key) === socket) this.#datagrams.delete(key);
  }
  /**
  * Unbind a stream listener during its own `close()`.
  *
  * Internal wiring called by `SimulatedListener`; the address is only released
  * if it still maps to this exact listener. Not part of the public provider
  * surface.
  */
  _removeListener(addr: SocketAddress, listener: SimulatedListener): void {
    const key = addressKey(addr);
    if (this.#listeners.get(key) === listener) this.#listeners.delete(key);
  }
  /**
  * Route one datagram from a bound socket through the impairment pipeline.
  *
  * Internal wiring called by `SimulatedDatagramSocket.send()`. It applies, in
  * order, scripted drops, MTU limits, probabilistic loss, queue overflow, then
  * schedules the packet (and an optional duplicate) at its computed due time and
  * records the corresponding trace events. Not called directly by tests.
  */
  _sendDatagram(localAddress: SocketAddress, data: Uint8Array, dest: SocketAddress, ecn?: number): void {
    const source = this.#sourceRewrites.get(addressKey(localAddress)) ?? localAddress;
    const link = this.#link(localAddress, dest);
    const options = link.state.options;
    const bytes = data.byteLength;
    if (this.#consumeScriptedDrop(localAddress, dest)) {
      this.#traceDatagramDrop(localAddress, source, dest, bytes, 'loss');
      return;
    }
    if (bytes > options.mtu) {
      this.#traceDatagramDrop(localAddress, source, dest, bytes, 'mtu');
      return;
    }
    if (this.#rng.chance(options.lossRate)) {
      this.#traceDatagramDrop(localAddress, source, dest, bytes, 'loss');
      return;
    }
    if (link.state.queued >= options.queueLimit) {
      this.#traceDatagramDrop(localAddress, source, dest, bytes, 'queue-overflow');
      return;
    }
    link.state.queued++;
    const dueAt = this.#dueAt(options, bytes);
    const scriptedCorruptByte = this.#consumeScriptedCorruption(localAddress, dest);
    const payload = scriptedCorruptByte === undefined ? this.#maybeCorrupt(data, options) : this.#corruptPayload(data, scriptedCorruptByte);
    this.#schedule(link.key, localAddress, source, dest, payload, dueAt, true, 'datagram:queued', ecn);
    if (this.#rng.chance(options.duplicateRate)) {
      this.#schedule(link.key, localAddress, source, dest, payload, dueAt, false, 'datagram:duplicated', ecn);
    }
  }
  /**
  * Inject one datagram from an arbitrary simulated address.
  *
  * This test-only hook lets protocol harnesses model packets that are valid at
  * the UDP layer but are not emitted by a bound socket, for example forged QUIC
  * Version Negotiation packets sent from the server tuple.
  *
  * @internal
  */
  _injectDatagram(localAddress: SocketAddress, data: Uint8Array, dest: SocketAddress): void {
    ensureIpAddress(localAddress, 'Simulated datagram injection source');
    ensureIpAddress(dest, 'Simulated datagram injection destination');
    this._sendDatagram(localAddress, data, dest);
  }
  #allocateAddress<T extends Map<string, unknown>>(addr: SocketAddress, occupied: T): SocketAddress {
    if (addr.family === 'unix') return copyAddress(addr);
    if (addr.port !== 0) return copyAddress(addr);
    for (;;) {
      const candidate = {
        family: addr.family,
        ip: addr.ip,
        port: this.#nextEphemeralPort++
      } as SocketAddress;
      if (!occupied.has(addressKey(candidate))) return candidate;
    }
  }
  #allocateStreamLocal(remote: SocketAddress): SocketAddress {
    if (remote.family === 'unix') {
      return {
        family: 'unix',
        path: `${remote.path}.client.${this.#nextEphemeralPort++}`
      };
    }
    const ip = remote.family === 'ipv6' ? '::' : '0.0.0.0';
    return this.#allocateAddress({
      family: remote.family,
      ip,
      port: 0
    }, new Map());
  }
  #link(from: SocketAddress, to: SocketAddress): LinkPair {
    const key = this.#linkKey(from, to);
    let state = this.#links.get(key);
    if (state === undefined) {
      state = {
        options: this.#defaultLink,
        queued: 0
      };
      this.#links.set(key, state);
    }
    return {
      key,
      state
    };
  }
  #linkKey(from: SocketAddress, to: SocketAddress): string {
    return `${addressKey(from)}->${addressKey(to)}`;
  }
  #consumeScriptedDrop(from: SocketAddress, to: SocketAddress): boolean {
    const fromKey = addressKey(from);
    const toKey = addressKey(to);
    for (const rule of this.#scriptedDrops) {
      if (rule.remaining <= 0) continue;
      if (rule.fromKey !== undefined && rule.fromKey !== fromKey) continue;
      if (rule.toKey !== undefined && rule.toKey !== toKey) continue;
      rule.remaining--;
      if (rule.remaining === 0) {
        const index = this.#scriptedDrops.indexOf(rule);
        if (index !== -1) this.#scriptedDrops.splice(index, 1);
      }
      return true;
    }
    return false;
  }
  #consumeScriptedCorruption(from: SocketAddress, to: SocketAddress): number | null | undefined {
    const fromKey = addressKey(from);
    const toKey = addressKey(to);
    for (const rule of this.#scriptedCorruptions) {
      if (rule.remaining <= 0) continue;
      if (rule.fromKey !== undefined && rule.fromKey !== fromKey) continue;
      if (rule.toKey !== undefined && rule.toKey !== toKey) continue;
      rule.remaining--;
      if (rule.remaining === 0) {
        const index = this.#scriptedCorruptions.indexOf(rule);
        if (index !== -1) this.#scriptedCorruptions.splice(index, 1);
      }
      return rule.corruptByte ?? null;
    }
    return undefined;
  }
  #dueAt(options: RequiredLinkOptions, bytes: number): number {
    const jitter = options.jitterMs === 0 ? 0 : (this.#rng.next() * 2 - 1) * options.jitterMs;
    const bandwidthDelay = options.bandwidthBytesPerMs === Infinity || options.bandwidthBytesPerMs <= 0 ? 0 : Math.ceil(bytes / options.bandwidthBytesPerMs);
    const reorderDelay = this.#rng.chance(options.reorderRate) ? options.reorderDelayMs : 0;
    return this.#clock + Math.max(0, options.latencyMs + jitter) + bandwidthDelay + reorderDelay;
  }
  #maybeCorrupt(data: Uint8Array, options: RequiredLinkOptions): Uint8Array {
    const out = cloneBytes(data);
    if (out.byteLength > 0 && this.#rng.chance(options.corruptionRate)) {
      out[0] = options.corruptByte ?? out[0]! ^ 255;
    }
    return out;
  }
  #corruptPayload(data: Uint8Array, corruptByte: number | null): Uint8Array {
    const out = cloneBytes(data);
    if (out.byteLength > 0) out[0] = corruptByte ?? out[0]! ^ 255;
    return out;
  }
  #schedule(linkKey: string, localAddress: SocketAddress, from: SocketAddress, to: SocketAddress, data: Uint8Array, dueAt: number, releaseQueueSlot: boolean, traceType: 'datagram:queued' | 'datagram:duplicated', ecn?: number): void {
    this.#scheduled.push({
      id: this.#nextEventId++,
      dueAt,
      linkKey,
      releaseQueueSlot,
      localAddress: copyAddress(localAddress),
      from: copyAddress(from),
      to: copyAddress(to),
      data: cloneBytes(data),
      ecn
    });
    this.#trace({
      type: traceType,
      at: this.#clock,
      dueAt,
      localAddress: copyAddress(localAddress),
      from: copyAddress(from),
      to: copyAddress(to),
      bytes: data.byteLength,
      data: cloneBytes(data),
      ecn
    });
  }
  #traceDatagramDrop(localAddress: SocketAddress, from: SocketAddress, to: SocketAddress, bytes: number, reason: SimulatedDatagramDropReason, data = new Uint8Array()): void {
    this.#trace({
      type: 'datagram:dropped',
      at: this.#clock,
      localAddress: copyAddress(localAddress),
      from: copyAddress(from),
      to: copyAddress(to),
      bytes,
      data: cloneBytes(data),
      reason
    });
  }
  #trace(event: SimulatedNetworkTraceEvent): void {
    this.trace.push(event);
  }
}
