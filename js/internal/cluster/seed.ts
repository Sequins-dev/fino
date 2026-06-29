/**
 * internal:cluster/seed - seed server routing logic.
 *
 * The seed handles three responsibilities:
 *
 * 1. Membership: HELLO/WELCOME/PEER_UP/PEER_DOWN, heartbeat monitoring.
 * 2. Spawn routing: select target node for SPAWN, track spawnReqId->requester,
 *    forward SPAWN_ACK back to the spawning node.
 * 3. Data routing: forward PORT_MSG to the node that hosts the target portId.
 *    The registry maps portId -> nodeId for O(1) lookup.
 *
 * The seed is NOT in the data-plane critical path once ports are established -
 * in future work nodes can establish direct peer connections. For now routing
 * through the seed is correct and sufficient.
 *
 * ## Example
 *
 * ```ts no_run
 * import { SeedServer } from 'internal:cluster/seed';
 * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
 *
 * const transport = new WebTransportSeedTransport('__seed__', 8787);
 * const seed = new SeedServer(transport);
 *
 * seed.start();
 * // Workers connect to https://127.0.0.1:8787/__fino_cluster and send HELLO.
 * seed.stop();
 * ```
 *
 * @internal
 */

import type { ClusterSeedTransport } from './transport.ts';
import { type ClusterMessage } from './protocol.ts';
import { RealmRegistry } from './registry.ts';
import { env } from 'internal:process';

const HEARTBEAT_INTERVAL_MS = 2500;
const HEARTBEAT_TIMEOUT_MS  = 7500; // 3x interval - tolerate one missed beat

function envMs(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function heartbeatIntervalMs(): number {
  return envMs('FINO_CLUSTER_HEARTBEAT_INTERVAL_MS', HEARTBEAT_INTERVAL_MS);
}

function heartbeatTimeoutMs(): number {
  return envMs('FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS);
}

/**
 * Cluster seed router for membership, spawn, and port-message routing.
 *
 * The server owns the authoritative registry of which node hosts each port. It
 * listens on a `WebTransportSeedTransport`, sends heartbeats checks every 2500 ms,
 * and treats peers as down after 7500 ms without a heartbeat.
 *
 * ```ts no_run
 * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
 * import { SeedServer } from 'internal:cluster/seed';
 * const seed = new SeedServer(new WebTransportSeedTransport('__seed__', 8787));
 * seed.start();
 * ```
 *
 * @internal
 */
export class SeedServer {
  /**
   * Private property `#transport` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #transport = undefined;
   *
   *   readInternalState() {
   *     return this.#transport;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #transport: ClusterSeedTransport;
  /**
   * Private property `#registry` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #registry = undefined;
   *
   *   readInternalState() {
   *     return this.#registry;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #registry = new RealmRegistry();
  /**
   * Private property `#peers` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #peers = undefined;
   *
   *   readInternalState() {
   *     return this.#peers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #peers = new Map<string, { load: { cpu: number; memory: number } }>();
  /**
   * Private property `#lastSeen` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #lastSeen = undefined;
   *
   *   readInternalState() {
   *     return this.#lastSeen;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #lastSeen = new Map<string, number>();
  // spawnReqId -> { requesterNodeId, parentPortId, targetNodeId }
  /**
   * Private property `#pendingSpawns` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #pendingSpawns = undefined;
   *
   *   readInternalState() {
   *     return this.#pendingSpawns;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #pendingSpawns = new Map<string, { requesterNodeId: string; parentPortId: string; targetNodeId: string }>();
  // portId -> nodeId for PORT_MSG routing and death propagation.
  // Maintained separately from the registry because nodeDown() removes entries
  // from the registry before we can look up parent nodeIds for TERMINATE routing.
  // Could be consolidated with registry.getNodeId() if registry exposed a
  // "snapshot before remove" operation, but the parallel map is simpler.
  /**
   * Private property `#portNodes` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #portNodes = undefined;
   *
   *   readInternalState() {
   *     return this.#portNodes;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #portNodes = new Map<string, string>();
  /**
   * Private property `#heartbeatTimer` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #heartbeatTimer = undefined;
   *
   *   readInternalState() {
   *     return this.#heartbeatTimer;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a seed server around an already-created WebTransport seed transport.
   *
   * The constructor does not listen, register handlers, or start timers. Call
   * `start()` once to begin accepting workers.
   *
   * ```ts no_run
   * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
   * import { SeedServer } from 'internal:cluster/seed';
   * const seed = new SeedServer(new WebTransportSeedTransport('__seed__', 8787));
   * ```
   */
  constructor(transport: ClusterSeedTransport) {
    this.#transport = transport;
  }

  /**
   * Start listening and begin heartbeat monitoring.
   *
   * The method registers one transport handler and calls `listen()`. It is not
   * idempotent: repeated calls add additional handlers and timers, so callers
   * should pair a single `start()` with `stop()`.
   *
   * ```ts no_run
   * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
   * import { SeedServer } from 'internal:cluster/seed';
   * const seed = new SeedServer(new WebTransportSeedTransport('__seed__', 8787));
   * seed.start();
   * ```
   */
  async start(): Promise<void> {
    this.#transport.on((from, msg) => this.#handle(from, msg));
    await this.#transport.listen();
    this.#heartbeatTimer = setInterval(() => this.#checkHeartbeats(), heartbeatIntervalMs());
  }

  /**
   * Stop heartbeat monitoring and close the underlying transport.
   *
   * Pending workers are not sent a graceful shutdown message; the transport
   * closes sockets and higher layers observe peer-down handling. Calling
   * `stop()` after the timer is already cleared is harmless.
   *
   * ```ts no_run
   * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
   * import { SeedServer } from 'internal:cluster/seed';
   * const seed = new SeedServer(new WebTransportSeedTransport('__seed__', 8787));
   * seed.stop();
   * ```
   */
  stop(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#transport.close();
  }

  /**
   * Run one heartbeat timeout sweep for deterministic internal tests.
   *
   * Production uses the periodic timer started by `start()`. Tests call this
   * hook after controlling `Date.now()` so heartbeat expiry can be asserted
   * without sleeping for the real timeout.
   *
   * @internal
   */
  _checkHeartbeatsForTest(): void {
    this.#checkHeartbeats();
  }

  /**
   * Private method `#handle` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #handle() {
   *     return 'handle';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#handle();
   *   }
   * }
   * ```
   *
   * @internal
   */
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
        this.#lastSeen.set(from, Date.now());
        break;
      }

      case 'SPAWN': {
        const target = this.#selectTarget(from);
        if (target === null) {
          // No eligible worker - reject immediately.
          this.#transport.send(from, {
            t: 'SPAWN_ACK',
            spawnReqId: msg.spawnReqId,
            childPortId: '',
            ok: false,
            error: 'no available worker node',
          });
          break;
        }
        this.#pendingSpawns.set(msg.spawnReqId, {
          requesterNodeId: from,
          parentPortId: msg.parentPortId,
          targetNodeId: target,
        });
        this.#portNodes.set(msg.parentPortId, from);
        this.#registry.register(msg.parentPortId, null, from);
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
        const parentPortId = this.#registry.getParentPortId(portId);
        const removed = this.#registry.exit(portId);
        if (parentPortId) {
          const parentHostId = this.#portNodes.get(parentPortId);
          if (parentHostId) this.#transport.send(parentHostId, msg);
        }
        // Propagate TERMINATE to every node hosting a descendant of the exiting
        // realm, mirroring the crash path in #handleNodeDown.  The exiting realm
        // itself has already left - skip it (p !== portId) to avoid redundant
        // TERMINATE delivery to a relay that is already closed.
        for (const p of removed) {
          const hostNodeId = this.#portNodes.get(p);
          this.#portNodes.delete(p);
          if (hostNodeId && p !== portId) {
            this.#transport.send(hostNodeId, { t: 'TERMINATE', realmId: p });
          }
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

  /**
   * Private method `#handleNodeDown` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #handleNodeDown() {
   *     return 'handleNodeDown';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#handleNodeDown();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #handleNodeDown(nodeId: string): void {
    for (const [spawnReqId, pending] of [...this.#pendingSpawns]) {
      if (pending.requesterNodeId === nodeId) {
        this.#pendingSpawns.delete(spawnReqId);
        continue;
      }
      if (pending.targetNodeId === nodeId) {
        this.#pendingSpawns.delete(spawnReqId);
        this.#transport.send(pending.requesterNodeId, {
          t: 'SPAWN_ACK',
          spawnReqId,
          childPortId: '',
          ok: false,
          error: `target node ${nodeId} went down before spawn completed`,
        });
      }
    }

    const affected = this.#registry.nodeDown(nodeId);
    for (const { portId, parentPortId } of affected) {
      this.#portNodes.delete(portId);
      // Notify the HOST OF THE PARENT PORT that its child is gone.
      // The dead node itself cannot receive messages.
      if (parentPortId) {
        const parentHostId = this.#portNodes.get(parentPortId);
        if (parentHostId && parentHostId !== nodeId) {
          this.#transport.send(parentHostId, { t: 'TERMINATE', realmId: portId });
        }
      }
    }
  }

  /**
   * Private method `#selectTarget` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #selectTarget() {
   *     return 'selectTarget';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#selectTarget();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #selectTarget(excludeNodeId: string): string | null {
    // Pick the peer with the lowest CPU load; return null if no eligible peer.
    let best: string | null = null;
    let bestLoad = Infinity;
    for (const [nId, peer] of this.#peers) {
      if (nId === excludeNodeId) continue;
      if (peer.load.cpu < bestLoad) { best = nId; bestLoad = peer.load.cpu; }
    }
    return best;
  }

  /**
   * Private method `#checkHeartbeats` used by `SeedServer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #checkHeartbeats() {
   *     return 'checkHeartbeats';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#checkHeartbeats();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #checkHeartbeats(): void {
    const now = Date.now();
    for (const [nodeId, ts] of this.#lastSeen) {
      if (now - ts > heartbeatTimeoutMs()) {
        this.#lastSeen.delete(nodeId);
        this.#peers.delete(nodeId);
        this.#transport.broadcastExcept(nodeId, { t: 'PEER_DOWN', nodeId });
        this.#handleNodeDown(nodeId);
      }
    }
  }
}
