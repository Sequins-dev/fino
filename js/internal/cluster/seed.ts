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
 * Workers send HEARTBEAT messages; the seed only records when each node was
 * last seen and periodically sweeps for silent peers. The sweep cadence and
 * expiry default to 2500 ms / 7500 ms and can be overridden through the
 * `FINO_CLUSTER_HEARTBEAT_INTERVAL_MS` and `FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS`
 * environment variables (useful for fast failure-detection tests).
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
/** Default milliseconds between heartbeat timeout sweeps. */
const HEARTBEAT_INTERVAL_MS = 2500;
/** Default milliseconds of heartbeat silence before a peer is declared down. */
const HEARTBEAT_TIMEOUT_MS = 7500;
/**
 * Read a positive millisecond duration from an environment variable.
 *
 * Returns `fallback` when the variable is unset, empty, non-numeric, zero, or
 * negative, so a malformed override can never disable heartbeat monitoring.
 */
function envMs(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
/**
 * Effective sweep interval: `FINO_CLUSTER_HEARTBEAT_INTERVAL_MS` or 2500 ms.
 *
 * Read at `start()` time, so the override must be set before the seed starts.
 */
function heartbeatIntervalMs(): number {
  return envMs('FINO_CLUSTER_HEARTBEAT_INTERVAL_MS', HEARTBEAT_INTERVAL_MS);
}
/**
 * Effective heartbeat expiry: `FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS` or 7500 ms.
 *
 * Read on every sweep, so changes to the environment take effect immediately.
 */
function heartbeatTimeoutMs(): number {
  return envMs('FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS);
}
/**
 * Cluster seed router for membership, spawn, and port-message routing.
 *
 * The server owns the authoritative registry of which node hosts each port. It
 * listens on a `ClusterSeedTransport` (WebTransport in production), sweeps for
 * missed worker heartbeats every 2500 ms, and treats a peer as down after
 * 7500 ms of silence (both durations are env-overridable; see the module
 * header). When a peer dies — by disconnect or by heartbeat expiry — the seed
 * broadcasts `PEER_DOWN`, fails any spawns in flight toward that node, and
 * sends `TERMINATE` for every orphaned descendant realm.
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
   * Seed-side transport the router listens and routes on.
   *
   * Provided by the constructor; `start()` registers the message handler and
   * calls `listen()`, `stop()` closes it. All sends, broadcasts, and the seed's
   * own `nodeId` go through this object.
   *
   * @internal
   */
  #transport: ClusterSeedTransport;
  /**
   * Authoritative realm ownership tree (portId, parent edge, hosting node).
   *
   * Populated on SPAWN/SPAWN_ACK, pruned on REALM_EXIT and node death. Its
   * removal snapshots drive `TERMINATE` propagation to descendant hosts.
   *
   * @internal
   */
  #registry = new RealmRegistry();
  /**
   * Live worker membership keyed by node ID.
   *
   * Each entry holds the load snapshot reported in the node's HELLO; spawn
   * placement (`#selectTarget`) picks the member with the lowest CPU load.
   * Entries are removed on disconnect (`PEER_DOWN`) or heartbeat expiry.
   *
   * @internal
   */
  #peers = new Map<
    string,
    {
      load: {
        cpu: number;
        memory: number;
      };
    }
  >();
  /**
   * `Date.now()` timestamp of the last HELLO or HEARTBEAT per node ID.
   *
   * `#checkHeartbeats` declares a peer down once its entry is older than the
   * heartbeat timeout.
   *
   * @internal
   */
  #lastSeen = new Map<string, number>();
  // spawnReqId -> { requesterNodeId, parentPortId, targetNodeId }
  /**
   * In-flight SPAWN requests keyed by `spawnReqId`.
   *
   * Records who asked, which parent port the child attaches to, and which node
   * was chosen, so the eventual SPAWN_ACK can be routed back to the requester
   * and registered under the right parent. `#handleNodeDown` synthesizes a
   * failed SPAWN_ACK when the target dies mid-spawn and silently drops entries
   * whose requester died.
   *
   * @internal
   */
  #pendingSpawns = new Map<
    string,
    {
      requesterNodeId: string;
      parentPortId: string;
      targetNodeId: string;
    }
  >();
  // portId -> nodeId for PORT_MSG routing and death propagation.
  // Maintained separately from the registry because nodeDown() removes entries
  // from the registry before we can look up parent nodeIds for TERMINATE routing.
  // Could be consolidated with registry.getNodeId() if registry exposed a
  // "snapshot before remove" operation, but the parallel map is simpler.
  /**
   * Flat portId -> hosting nodeId map for PORT_MSG and TERMINATE routing.
   *
   * Deliberately parallel to `#registry` (see the comment above): node-down
   * handling removes registry entries before parent hosts are looked up, so
   * this map must survive long enough to answer "which node hosts the parent
   * port of the realm that just died".
   *
   * @internal
   */
  #portNodes = new Map<string, string>();
  /**
   * Interval handle for the periodic heartbeat sweep.
   *
   * `null` until `start()` and again after `stop()`, which uses it to make
   * repeated `stop()` calls harmless.
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
   * Dispatch a single inbound `ClusterMessage` from node `from`.
   *
   * - `HELLO`: record the peer and its load, reply with `WELCOME` (current
   *   peer list), broadcast `PEER_UP` to everyone else.
   * - `PEER_DOWN`: synthetic message from the transport on connection drop;
   *   forget the peer, rebroadcast, and run the node-down cascade.
   * - `HEARTBEAT`: refresh the peer's last-seen timestamp.
   * - `SPAWN`: pick the least-loaded other node and forward the request, or
   *   reply immediately with a failed `SPAWN_ACK` when no worker is eligible.
   *   The parent port is registered before forwarding so replies can route.
   * - `SPAWN_ACK`: register the child port under its parent (on success) and
   *   forward the ack to the original requester.
   * - `REALM_EXIT`: prune the realm's subtree from the registry, notify the
   *   parent port's host, and send `TERMINATE` to each descendant's host
   *   (skipping the exiting realm itself, which is already gone).
   * - `PORT_MSG`: forward to the node hosting `toPort`; dropped silently when
   *   the port is unknown.
   *
   * Unknown message types are ignored.
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
          peer: {
            nodeId: from,
            load: msg.load,
          },
        });
        break;
      }
      case 'PEER_DOWN': {
        // Synthetic message emitted by the transport layer on connection drop.
        this.#peers.delete(from);
        this.#lastSeen.delete(from);
        this.#transport.broadcastExcept(from, {
          t: 'PEER_DOWN',
          nodeId: from,
        });
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
        const portId = msg.realmId;
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
            this.#transport.send(hostNodeId, {
              t: 'TERMINATE',
              realmId: p,
            });
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
   * Run the cleanup cascade after a node disconnects or times out.
   *
   * Pending spawns requested by the dead node are dropped; pending spawns
   * targeting it are failed with a synthesized error `SPAWN_ACK` back to the
   * requester. Every port hosted on the node (and all descendants) is removed
   * from the registry, and for each orphaned realm a `TERMINATE` is sent to
   * the host of its parent port - the dead node itself can no longer receive
   * messages, so notification goes to the surviving side of each edge.
   *
   * Callers are responsible for peer bookkeeping and the `PEER_DOWN`
   * broadcast; this method only handles spawn and realm-tree fallout.
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
          this.#transport.send(parentHostId, {
            t: 'TERMINATE',
            realmId: portId,
          });
        }
      }
    }
  }
  /**
   * Choose the spawn target: the peer with the lowest reported CPU load.
   *
   * The requesting node is excluded so spawns always land on a different node.
   * Returns `null` when no other peer is connected, which callers turn into an
   * immediate failed `SPAWN_ACK`. Load figures come from each peer's HELLO and
   * are not refreshed afterwards, so placement is best-effort.
   *
   * @internal
   */
  #selectTarget(excludeNodeId: string): string | null {
    // Pick the peer with the lowest CPU load; return null if no eligible peer.
    let best: string | null = null;
    let bestLoad = Infinity;
    for (const [nId, peer] of this.#peers) {
      if (nId === excludeNodeId) continue;
      if (peer.load.cpu < bestLoad) {
        best = nId;
        bestLoad = peer.load.cpu;
      }
    }
    return best;
  }
  /**
   * Sweep for peers whose last heartbeat is older than the timeout.
   *
   * Each expired peer is removed from membership, announced to the rest of the
   * cluster with `PEER_DOWN`, and put through the same node-down cascade as a
   * hard disconnect. Runs on the interval started by `start()`; tests invoke
   * it directly via `_checkHeartbeatsForTest()`.
   *
   * @internal
   */
  #checkHeartbeats(): void {
    const now = Date.now();
    for (const [nodeId, ts] of this.#lastSeen) {
      if (now - ts > heartbeatTimeoutMs()) {
        this.#lastSeen.delete(nodeId);
        this.#peers.delete(nodeId);
        this.#transport.broadcastExcept(nodeId, {
          t: 'PEER_DOWN',
          nodeId,
        });
        this.#handleNodeDown(nodeId);
      }
    }
  }
}
