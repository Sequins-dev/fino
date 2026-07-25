/**
* internal:cluster/transport - ClusterTransport interface.
*
* Defines the wire-agnostic contract between the cluster's protocol layers and
* whatever actually moves bytes between nodes. The cluster client
* (`internal:cluster/client`) and seed router (`internal:cluster/seed`) depend
* only on these interfaces, so swapping the wire — WebTransport today, an
* in-memory channel in tests, some other provider tomorrow — means writing a
* new transport, not changing membership, spawn, or port-routing logic.
*
* The two interfaces mirror the cluster's star topology. Every node holds a
* plain `ClusterTransport`; the seed additionally implements
* `ClusterSeedTransport`, which can accept inbound connections and fan
* messages out to connected workers. The production implementations of both
* live in `internal:cluster/webtransport-transport`.
*
* Transports exchange already-decoded `ClusterMessage` values (see
* `internal:cluster/protocol`). Encoding, framing, and connection lifecycle
* are implementation details hidden behind this boundary; the one lifecycle
* event that leaks through by design is peer loss, which transports surface
* as a synthetic `PEER_DOWN` message to their handlers.
*
* ## Example
*
* ```ts no_run
* import type { ClusterMessage } from 'internal:cluster/protocol';
* import type { ClusterTransport } from 'internal:cluster/transport';
*
* class LoopbackTransport implements ClusterTransport {
*   readonly nodeId: string;
*   #peer: LoopbackTransport | null = null;
*   #handlers: Array<(from: string, msg: ClusterMessage) => void> = [];
*   constructor(nodeId: string) { this.nodeId = nodeId; }
*   link(peer: LoopbackTransport): void { this.#peer = peer; }
*   send(_to: string, msg: ClusterMessage): void {
*     this.#peer?.deliver(this.nodeId, msg);
*   }
*   broadcast(msg: ClusterMessage): void {
*     this.#peer?.deliver(this.nodeId, msg);
*   }
*   on(handler: (from: string, msg: ClusterMessage) => void): void {
*     this.#handlers.push(handler);
*   }
*   close(): void { this.#peer = null; }
*   deliver(from: string, msg: ClusterMessage): void {
*     for (const handler of this.#handlers) handler(from, msg);
*   }
* }
*
* const seed = new LoopbackTransport('seed');
* const worker = new LoopbackTransport('worker-1');
* seed.link(worker);
* worker.link(seed);
*
* seed.on((from, msg) => console.log(`${from} -> seed: ${msg.t}`));
* worker.send('seed', { t: 'HEARTBEAT', ts: Date.now() });
* ```
*
* @internal
*/
import type { ClusterMessage } from './protocol.ts';
/**
* Minimal transport contract used by the cluster client and seed router.
*
* Implementations may route over WebTransport, QUIC, in-memory channels, or a
* future provider. The transport owns connection state and emits decoded
* `ClusterMessage` values; higher layers own membership, spawn, and port
* routing semantics.
*
* When a peer connection drops, the transport synthesizes a `PEER_DOWN`
* message and delivers it through the registered handlers, so consumers
* observe peer loss the same way they observe any other cluster message.
*
* The typical consumer is `ClusterClient`, which wraps a connected transport
* and layers the membership and messaging protocol on top:
*
* ```ts no_run
* import { ClusterClient } from 'internal:cluster/client';
* import { WebTransportWorkerTransport } from 'internal:cluster/webtransport-transport';
*
* const transport = new WebTransportWorkerTransport('worker-1');
* await transport.connect('https://seed.internal:4433/cluster');
*
* const client = new ClusterClient(transport, 'worker-1');
* ```
*
* @internal
*/
export interface ClusterTransport {
  /**
  * Local node identifier advertised on the cluster.
  *
  * The value is a bare node ID, not a realm or port ID. Implementations should
  * keep it stable for the life of the transport because routing maps key on
  * this string.
  *
  * ```ts
  * const transport = { nodeId: 'seed', send() {}, broadcast() {}, on() {}, close() {} };
  * transport.nodeId;
  * ```
  */
  readonly nodeId: string;
  /**
  * Send a message to a specific peer identified by nodeId.
  * On seed nodes this routes directly to the peer's connection.
  * On worker nodes this sends through the seed which routes it onward.
  *
  * Missing or closed peers are transport-defined; WebTransport transports drop the
  * send silently because connection-close handling emits `PEER_DOWN`
  * separately.
  *
  * ```ts
  * const transport = { nodeId: 'n', send(to, msg) { void to; void msg; }, broadcast() {}, on() {}, close() {} };
  * transport.send('seed', { t: 'HEARTBEAT', ts: Date.now() });
  * ```
  */
  send(to: string, msg: ClusterMessage): void | Promise<void>;
  /**
  * Broadcast a message to all connected peers.
  * Seed-only: throws if called on a worker transport.
  *
  * Implementations should not deliver the message back to themselves unless
  * explicitly documented. WebTransport worker transport throws because workers
  * have a single upstream seed connection.
  *
  * ```ts
  * const transport = { nodeId: 'seed', send() {}, broadcast(msg) { void msg; }, on() {}, close() {} };
  * transport.broadcast({ t: 'PEER_DOWN', nodeId: 'worker-a' });
  * ```
  */
  broadcast(msg: ClusterMessage): void;
  /**
  * Register a message handler. Multiple handlers may be registered; all
  * are called in registration order for every incoming message.
  *
  * The handler receives the sending node's ID and the decoded message. On
  * worker transports the `from` value is the seed's nodeId for control-plane
  * messages, or the originating nodeId embedded in data-plane (port)
  * messages. The WebTransport worker transport buffers messages that arrive
  * before any handler is registered and flushes them to the first handler,
  * so registering after `connect()` does not lose early messages.
  *
  * ```ts
  * const transport = { nodeId: 'n', send() {}, broadcast() {}, on(handler) { handler('seed', { t: 'HEARTBEAT', ts: 1 }); }, close() {} };
  * transport.on((from, msg) => { void from; void msg; });
  * ```
  */
  on(handler: (from: string, msg: ClusterMessage) => void): void;
  /**
  * Close all connections and release transport-owned resources.
  *
  * `close()` is synchronous at the interface level. Implementations may start
  * asynchronous close work internally, and callers should treat the transport
  * as unusable immediately after this method returns.
  *
  * ```ts
  * const transport = { nodeId: 'n', send() {}, broadcast() {}, on() {}, close() { this.closed = true; }, closed: false };
  * transport.close();
  * ```
  */
  close(): void;
}
/**
* Seed-side extension used by the cluster router.
*
* The seed is the hub of the cluster's star topology: it accepts inbound
* worker connections and relays messages between them. On top of the base
* transport contract, a seed transport can start accepting connections
* (`listen`) and fan a message out to every connected peer except one
* (`broadcastExcept`) — the router uses the latter to gossip `PEER_UP` and
* `PEER_DOWN` events without echoing them back to the node they concern.
*
* `ClusterSeed` drives this interface directly; construct a seed transport
* and hand it over:
*
* ```ts no_run
* import { ClusterSeed } from 'internal:cluster/seed';
* import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
*
* const transport = new WebTransportSeedTransport('seed', {
*   port: 4433,
*   tls: { cert: '/etc/cluster/cert.pem', key: '/etc/cluster/key.pem' },
* });
* const seed = new ClusterSeed(transport);
* await seed.start(); // calls transport.listen() internally
* ```
*/
export interface ClusterSeedTransport extends ClusterTransport {
  /**
  * Start accepting inbound worker connections.
  *
  * The returned promise resolves once the transport is ready to accept
  * connections (for the WebTransport implementation, once the underlying
  * HTTP/3 server is listening). Rejects if the listener cannot be set up —
  * for example when the port is already in use or the TLS material is
  * invalid. Call it once per transport; `close()` shuts the listener down.
  *
  * ```ts no_run
  * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
  *
  * const transport = new WebTransportSeedTransport('seed', {
  *   port: 4433,
  *   tls: { cert: '/etc/cluster/cert.pem', key: '/etc/cluster/key.pem' },
  * });
  * await transport.listen(); // now accepting inbound worker connections
  * ```
  */
  listen(): Promise<void>;
  /**
  * Broadcast a message to every connected peer except `exceptNodeId`.
  *
  * Used by the seed router to gossip membership changes: when a worker
  * joins or drops, all other peers are notified without sending the event
  * back to the node it describes. An `exceptNodeId` that matches no
  * connected peer makes this equivalent to `broadcast`.
  *
  * ```ts no_run
  * transport.broadcastExcept('worker-a', {
  *   t: 'PEER_UP',
  *   peer: { nodeId: 'worker-a' },
  * });
  * ```
  */
  broadcastExcept(exceptNodeId: string, msg: ClusterMessage): void;
}
