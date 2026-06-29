/**
* internal:cluster/transport - ClusterTransport interface.
*
* All cluster logic depends only on this interface. Switching transport implementations (or any other transport) requires only a new implementation, not
* changes to the protocol or routing layers.
*
* ## Example
*
* ```ts no_run
* import { encode } from 'internal:cluster/protocol';
*
* const transport = {
*   nodeId: 'worker-a',
*   send(to, msg) {
*     const frame = encode(msg);
*     void to;
*     void frame;
*   },
*   broadcast(msg) { void msg; },
*   on(handler) { void handler; },
*   close() {},
* };
*
* transport.send('__seed__', { t: 'HEARTBEAT', ts: Date.now() });
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
* ```ts
* const transport = {
*   nodeId: 'node-a',
*   send() {},
*   broadcast() {},
*   on() {},
*   close() {},
* };
* transport.nodeId;
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
  * @param handler - receives (fromNodeId, message). On worker transports
  *   fromNodeId is the seed's nodeId for control-plane messages, or the
  *   originating nodeId embedded in data-plane messages.
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
/** Seed-side extension used by the cluster router. */
export interface ClusterSeedTransport extends ClusterTransport {
  listen(): Promise<void>;
  broadcastExcept(exceptNodeId: string, msg: ClusterMessage): void;
}
