/**
 * internal:cluster/transport — ClusterTransport interface.
 *
 * All cluster logic depends only on this interface. Switching from WebSocket
 * to QUIC (or any other transport) requires only a new implementation, not
 * changes to the protocol or routing layers.
 *
 * @internal
 */

import type { ClusterMessage } from './protocol.mts';

export interface ClusterTransport {
  readonly nodeId: string;

  /**
   * Send a message to a specific peer identified by nodeId.
   * On seed nodes this routes directly to the peer's connection.
   * On worker nodes this sends through the seed which routes it onward.
   */
  send(to: string, msg: ClusterMessage): void;

  /**
   * Broadcast a message to all connected peers.
   * Seed-only: throws if called on a worker transport.
   */
  broadcast(msg: ClusterMessage): void;

  /**
   * Register a message handler. Multiple handlers may be registered; all
   * are called in registration order for every incoming message.
   *
   * @param handler — receives (fromNodeId, message). On worker transports
   *   fromNodeId is the seed's nodeId for control-plane messages, or the
   *   originating nodeId embedded in data-plane messages.
   */
  on(handler: (from: string, msg: ClusterMessage) => void): void;

  /** Close all connections and release resources. */
  close(): void;
}
