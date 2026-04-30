/**
 * internal:cluster/seed — seed server routing logic.
 *
 * The seed handles three responsibilities:
 *
 * 1. Membership: HELLO/WELCOME/PEER_UP/PEER_DOWN, heartbeat monitoring.
 * 2. Spawn routing: select target node for SPAWN, track spawnReqId→requester,
 *    forward SPAWN_ACK back to the spawning node.
 * 3. Data routing: forward PORT_MSG to the node that hosts the target portId.
 *    The registry maps portId → nodeId for O(1) lookup.
 *
 * The seed is NOT in the data-plane critical path once ports are established —
 * in future work nodes can establish direct peer connections. For now routing
 * through the seed is correct and sufficient.
 */

import type { ClusterTransport } from './transport.mts';
import { type ClusterMessage, nodeIdFromId } from './protocol.mts';
import { RealmRegistry } from './registry.mts';
import { WebSocketSeedTransport } from './websocket-transport.mts';

const HEARTBEAT_INTERVAL_MS = 2500;
const HEARTBEAT_TIMEOUT_MS  = 5000;

export class SeedServer {
  #transport: WebSocketSeedTransport;
  #registry = new RealmRegistry();
  #peers = new Map<string, { load: { cpu: number; memory: number } }>();
  #lastSeen = new Map<string, number>();
  // spawnReqId → { requesterNodeId, parentPortId }
  #pendingSpawns = new Map<string, { requesterNodeId: string; parentPortId: string }>();
  // portId → nodeId (for PORT_MSG routing)
  #portNodes = new Map<string, string>();
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(transport: WebSocketSeedTransport) {
    this.#transport = transport;
  }

  start(): void {
    this.#transport.on((from, msg) => this.#handle(from, msg));
    this.#transport.listen();
    this.#heartbeatTimer = setInterval(() => this.#checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#transport.close();
  }

  #handle(from: string, msg: ClusterMessage): void {
    switch (msg.t) {
      case 'HELLO': {
        this.#peers.set(from, { load: msg.load });
        this.#lastSeen.set(from, Date.now());
        // WELCOME: send current peer list to the new node
        this.#transport.send(from, {
          t: 'WELCOME',
          nodeId: this.#transport.nodeId,
          peers: [
            ...Array.from(this.#peers.entries()).map(([nodeId, p]) => ({
              nodeId,
              load: p.load,
            })),
          ],
        });
        // Notify existing peers of the new arrival (excluding the new peer)
        this.#transport.broadcastExcept(from, {
          t: 'PEER_UP',
          peer: { nodeId: from, load: msg.load },
        });
        break;
      }

      case 'PEER_DOWN': {
        // Synthetic message emitted by the transport layer on connection drop.
        this.#peers.delete(from);
        this.#lastSeen.delete(from);
        this.#transport.broadcastExcept(from, { t: 'PEER_DOWN', nodeId: from });
        this.#handleNodeDown(from);
        break;
      }

      case 'HEARTBEAT': {
        this.#lastSeen.set(from, msg.ts);
        break;
      }

      case 'SPAWN': {
        this.#pendingSpawns.set(msg.spawnReqId, { requesterNodeId: from, parentPortId: msg.parentPortId });
        this.#portNodes.set(msg.parentPortId, from);
        this.#registry.register(msg.parentPortId, null, from);
        const target = this.#selectTarget(from);
        this.#transport.send(target, msg);
        break;
      }

      case 'SPAWN_ACK': {
        const spawnInfo = this.#pendingSpawns.get(msg.spawnReqId);
        this.#pendingSpawns.delete(msg.spawnReqId);
        if (msg.ok && spawnInfo) {
          this.#portNodes.set(msg.childPortId, from);
          this.#registry.register(msg.childPortId, spawnInfo.parentPortId, from);
        }
        if (spawnInfo) this.#transport.send(spawnInfo.requesterNodeId, msg);
        break;
      }

      case 'REALM_EXIT': {
        const portId = msg.realmId; // realmId doubles as the child's portId
        const nodeId = this.#portNodes.get(portId);
        const removed = this.#registry.exit(portId);
        for (const p of removed) this.#portNodes.delete(p);
        // Propagate TERMINATE to all nodes that hosted descendants
        if (nodeId) {
          this.#transport.send(nodeId, { t: 'TERMINATE', realmId: portId });
        }
        break;
      }

      case 'PORT_MSG': {
        const targetNodeId = this.#portNodes.get(msg.toPort);
        if (targetNodeId) this.#transport.send(targetNodeId, msg);
        break;
      }

      default:
        break;
    }
  }

  #handleNodeDown(nodeId: string): void {
    const affected = this.#registry.nodeDown(nodeId);
    for (const portId of affected) {
      this.#portNodes.delete(portId);
      // Notify the node that owns the parent port
      const parentNodeId = this.#portNodes.get(portId);
      if (parentNodeId) {
        this.#transport.send(parentNodeId, { t: 'TERMINATE', realmId: portId });
      }
    }
  }

  #selectTarget(excludeNodeId: string): string {
    // Pick the peer with the lowest CPU load; fall back to the seed itself.
    let best: string | null = null;
    let bestLoad = Infinity;
    for (const [nodeId, peer] of this.#peers) {
      if (nodeId === excludeNodeId) continue;
      if (peer.load.cpu < bestLoad) { best = nodeId; bestLoad = peer.load.cpu; }
    }
    return best ?? excludeNodeId;
  }

  #checkHeartbeats(): void {
    const now = Date.now();
    for (const [nodeId, ts] of this.#lastSeen) {
      if (now - ts > HEARTBEAT_TIMEOUT_MS) {
        this.#lastSeen.delete(nodeId);
        this.#peers.delete(nodeId);
        this.#transport.broadcastExcept(nodeId, { t: 'PEER_DOWN', nodeId });
        this.#handleNodeDown(nodeId);
      }
    }
  }
}
