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
import type { WorkloadLedger } from './ledger.ts';
import { RealmRegistry } from './registry.ts';
import { DiskFileSystem } from 'fino:file';
import { caskSha256Hex, concatCaskChunks, inspectCask } from './cask.ts';
import { env } from 'internal:process';
type PortMessage = Extract<ClusterMessage, { t: 'PORT_MSG' }>;

type RealmExitMessage = Extract<ClusterMessage, { t: 'REALM_EXIT' }>;
interface PortSequenceState {
  next: number;
  pending: Map<number, PortMessage>;
}
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
/** Optional identity and authentication configuration for a seed. */
export interface SeedServerOptions {
  /**
   * Join token every HELLO must present. When set, a HELLO with a missing or
   * mismatched token receives JOIN_DENIED and is never registered. When
   * absent, the seed admits any HELLO (development mode).
   */
  joinToken?: string;
  /** Cluster identity advertised in every WELCOME. */
  clusterId?: string;
  /**
   * Durable workload ledger. When present, every routed spawn is committed
   * before it is forwarded — the commit-before-acknowledge guarantee — with
   * ownership leased to the chosen node and renewed by its heartbeats.
   */
  ledger?: WorkloadLedger;
  /** Lease duration for ledger ownership; defaults to 30 seconds. */
  leaseMs?: number;
  /** Directory for uploaded casks; cask transfer is refused when absent. */
  caskDir?: string;
}

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
        loopIdle?: number;
      };
      incarnation?: number;
      endpoint?: string;
      certHash?: string;
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
      /** The original spawn, retained so a refusal can be routed elsewhere. */
      spawn: Extract<ClusterMessage, { t: 'SPAWN' }>;
      /** Nodes already tried; excluded from retries. */
      attempted: Set<string>;
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
  /** Per-source ordering for PORT_MSG frames received on independent streams. */
  #portSequences = new Map<string, PortSequenceState>();
  /** Realm exits held until their declared final port message is routed. */
  #pendingRealmExits = new Map<string, RealmExitMessage>();
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
  constructor(transport: ClusterSeedTransport, options: SeedServerOptions = {}) {
    this.#transport = transport;
    this.#joinToken = options.joinToken ?? null;
    this.#clusterId = options.clusterId ?? null;
    this.#ledger = options.ledger ?? null;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#caskDir = options.caskDir ?? null;
  }
  /** Cask artifact store directory, or null when the seed is stateless. */
  #caskDir: string | null;
  /** In-flight cask uploads keyed by `{from}/{hash}`. */
  #caskUploads = new Map<string, { chunks: Uint8Array[]; nextSeq: number }>();
  /**
   * Accept one chunk of a cask upload; on the last chunk, verify the whole
   * artifact against its claimed hash before it enters the store. A mismatch
   * or out-of-order chunk drops the transfer and tells the uploader why —
   * the store never holds bytes whose name lies about their content.
   */
  async #handleCaskPut(
    from: string,
    msg: Extract<ClusterMessage, { t: 'CASK_PUT' }>,
  ): Promise<void> {
    const nack = (error: string): void => {
      this.#transport.send(from, { t: 'CASK_ACK', hash: msg.hash, ok: false, error });
    };
    if (this.#caskDir === null) {
      nack('this seed has no cask store (start it with --state)');
      return;
    }
    const key = `${from}/${msg.hash}`;
    const upload = this.#caskUploads.get(key) ?? { chunks: [], nextSeq: 0 };
    if (msg.seq !== upload.nextSeq) {
      this.#caskUploads.delete(key);
      nack(`out-of-order chunk ${msg.seq}, expected ${upload.nextSeq}`);
      return;
    }
    upload.chunks.push(msg.chunk);
    upload.nextSeq++;
    if (!msg.last) {
      this.#caskUploads.set(key, upload);
      return;
    }
    this.#caskUploads.delete(key);
    const bytes = concatCaskChunks(upload.chunks);
    if ((await caskSha256Hex(bytes)) !== msg.hash) {
      nack('cask bytes do not match their claimed hash');
      return;
    }
    const fs = new DiskFileSystem();
    try {
      await fs.stat(this.#caskDir);
    } catch {
      await fs.mkdir(this.#caskDir);
    }
    await fs.writeFile(`${this.#caskDir}/${msg.hash}.cask`, bytes);
    this.#transport.send(from, { t: 'CASK_ACK', hash: msg.hash, ok: true });
  }
  /**
   * Deploy a named application from an uploaded cask.
   *
   * Records the generation first — a deployment the cluster acknowledged is
   * always in history, even if placement then fails — and forwards the spawn
   * with the cask hash attached so the target fetches the artifact before it
   * spawns. Everything after the record rides the normal spawn machinery:
   * pressure placement, retryable admission, node-down rerouting,
   * commit-before-ack.
   */
  async #handleDeploy(
    from: string,
    msg: Extract<ClusterMessage, { t: 'DEPLOY' }>,
  ): Promise<void> {
    const fail = (error: string): void => {
      this.#transport.send(from, {
        t: 'SPAWN_ACK',
        spawnReqId: msg.spawnReqId,
        childPortId: '',
        ok: false,
        error,
      });
    };
    if (this.#caskDir === null || this.#ledger === null) {
      fail('deploy requires a seed with durable state (--state)');
      return;
    }
    let entry: string;
    try {
      const inspected = await inspectCask(`${this.#caskDir}/${msg.hash}.cask`);
      entry = inspected.manifest.entry;
    } catch {
      fail(`unknown cask ${msg.hash}; upload it first`);
      return;
    }
    try {
      await this.#ledger.recordDeployment(msg.name, msg.hash, entry);
    } catch (err) {
      fail(`deployment record failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.#placeDeployment(from, msg.spawnReqId, msg.parentPortId, msg.name, msg.hash, entry, fail);
  }

  /**
   * Place a recorded deployment generation onto a node.
   *
   * The requester is excluded: deploy and rollback CLIs are ephemeral
   * joiners, and a deployment must not land on a process that leaves after
   * the ack. The SEED owns the deployment's parent port for the same reason —
   * the requester's node-down must not cascade a TERMINATE into the
   * application it just deployed.
   */
  #placeDeployment(
    from: string,
    spawnReqId: string,
    parentPortId: string,
    name: string,
    hash: string,
    entry: string,
    fail: (error: string) => void,
  ): void {
    const target = this.#selectTarget(new Set([from]));
    if (target === null) {
      const peers = [...this.#peers.entries()]
        .map(([id, p]) => `${id}(draining=${p.load.draining === true})`)
        .join(', ');
      fail(`no available node to run the deployment (from=${from}; peers: ${peers || 'none'})`);
      return;
    }
    const spawn: Extract<ClusterMessage, { t: 'SPAWN' }> = {
      t: 'SPAWN',
      spawnReqId,
      parentPortId,
      config: { entry, root: '', rules: [] },
      caskHash: hash,
    };
    this.#pendingSpawns.set(spawnReqId, {
      requesterNodeId: from,
      parentPortId,
      targetNodeId: target,
      spawn,
      attempted: new Set([from, target]),
    });
    this.#portNodes.set(parentPortId, this.#transport.nodeId);
    this.#registry.register(parentPortId, null, this.#transport.nodeId);
    this.#ledgerOp(async (ledger) => {
      await ledger.commit(spawnReqId, JSON.stringify({ deploy: name, cask: hash }));
      await ledger.claim(
        spawnReqId,
        target,
        this.#peers.get(target)?.incarnation ?? 0,
        this.#leaseMs,
      );
    });
    this.#transport.send(target, spawn);
  }

  /** Answer a deployment-history query from the ledger. */
  async #handleDeploymentsGet(from: string, spawnReqId: string, name?: string): Promise<void> {
    const records = this.#ledger === null ? [] : await this.#ledger.deployments(name);
    this.#transport.send(from, {
      t: 'DEPLOYMENTS',
      spawnReqId,
      deployments: records.map((record) => ({
        name: record.name,
        generation: record.generation,
        caskHash: record.caskHash,
        entry: record.entry,
        state: record.state,
        createdAt: record.createdAt,
      })),
    });
  }

  /**
   * Record a rollback generation — a new generation pointing at the previous
   * cask — and place it like any deploy. Instant by construction: the
   * artifact is content-addressed and already cached wherever it ever ran.
   */
  async #handleRollback(
    from: string,
    msg: Extract<ClusterMessage, { t: 'ROLLBACK' }>,
  ): Promise<void> {
    const fail = (error: string): void => {
      this.#transport.send(from, {
        t: 'SPAWN_ACK',
        spawnReqId: msg.spawnReqId,
        childPortId: '',
        ok: false,
        error,
      });
    };
    if (this.#ledger === null || this.#caskDir === null) {
      fail('rollback requires a seed with durable state (--state)');
      return;
    }
    const record = await this.#ledger.rollbackDeployment(msg.name);
    if (record === null) {
      fail(`nothing to roll back: ${msg.name} has fewer than two generations`);
      return;
    }
    this.#placeDeployment(
      from,
      msg.spawnReqId,
      msg.parentPortId,
      msg.name,
      record.caskHash,
      record.entry,
      fail,
    );
  }
  /** Stream a stored cask back to a fetching node in order, last flagged. */
  async #handleCaskGet(from: string, hash: string): Promise<void> {
    const nack = (error: string): void => {
      this.#transport.send(from, { t: 'CASK_ACK', hash, ok: false, error });
    };
    if (this.#caskDir === null) {
      nack('this seed has no cask store (start it with --state)');
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await new DiskFileSystem().readFile(`${this.#caskDir}/${hash}.cask`);
    } catch {
      nack('unknown cask');
      return;
    }
    const CHUNK = 256 * 1024;
    for (let offset = 0, seq = 0; offset < bytes.length || seq === 0; offset += CHUNK, seq++) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
      this.#transport.send(from, {
        t: 'CASK_DATA',
        hash,
        seq,
        chunk,
        last: offset + CHUNK >= bytes.length,
      });
    }
  }
  /** Durable workload ledger, or null in soft (stateless) mode. */
  #ledger: WorkloadLedger | null;
  /** Ledger lease duration in milliseconds. */
  #leaseMs: number;
  /** Serialized ledger operations, preserving per-run write order. */
  #ledgerQueue: Promise<void> = Promise.resolve();
  /** Enqueue a ledger operation; failures are logged, never routing-fatal. */
  #ledgerOp(op: (ledger: WorkloadLedger) => Promise<unknown>): void {
    const ledger = this.#ledger;
    if (ledger === null) return;
    this.#ledgerQueue = this.#ledgerQueue
      .then(() => op(ledger))
      .then(
        () => undefined,
        (err: unknown) => {
          console.error(`fino:cluster seed ledger operation failed: ${err}`);
        },
      );
  }
  /** Test hook: resolves after previously enqueued ledger ops settle. @internal */
  _ledgerSettled(): Promise<void> {
    return this.#ledgerQueue.then(() => undefined);
  }
  /**
   * Reclaim expired leases and reroute the in-flight spawns they belonged to.
   *
   * This catches the failure the node-down path cannot: a target that goes
   * silent without disconnecting. Its lease lapses, the record returns to the
   * unclaimed pool, and any spawn still waiting on it moves to another node.
   * Reclaimed records with no pending spawn are left for reconciliation —
   * their requester is gone or they were initialized, which make-before-break
   * replacement handles rather than blind re-execution.
   */
  async #sweepLedger(ledger: WorkloadLedger): Promise<void> {
    const reclaimed = await ledger.sweepExpired();
    for (const record of reclaimed) {
      const pending = this.#pendingSpawns.get(record.id);
      if (pending === undefined) continue;
      const next = this.#selectTarget(pending.attempted);
      if (next === null) continue;
      pending.attempted.add(next);
      pending.targetNodeId = next;
      await ledger.claim(record.id, next, this.#peers.get(next)?.incarnation ?? 0, this.#leaseMs);
      this.#transport.send(next, pending.spawn);
    }
  }
  /** Test hook: run one ledger sweep and resolve when it settles. @internal */
  _sweepLedgerForTest(): Promise<void> {
    this.#ledgerOp((ledger) => this.#sweepLedger(ledger));
    return this._ledgerSettled();
  }
  /** childPortId -> ledger record id, so realm exits can settle records. */
  #ledgerIdsByChildPort = new Map<string, string>();
  /** Join token every HELLO must present, or null when auth is disabled. */
  #joinToken: string | null;
  /** Cluster identity advertised in WELCOME, or null when unset. */
  #clusterId: string | null;
  /** The cluster identity advertised to joiners, or null when unset. */
  get clusterId(): string | null {
    return this.#clusterId;
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
    this.#portSequences.clear();
    this.#pendingRealmExits.clear();
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
        if (this.#joinToken !== null && msg.token !== this.#joinToken) {
          this.#transport.send(from, {
            t: 'JOIN_DENIED',
            reason: 'invalid join token',
          });
          break;
        }
        const existing = this.#peers.get(from);
        if (
          existing?.incarnation !== undefined &&
          (msg.incarnation === undefined || msg.incarnation < existing.incarnation)
        ) {
          // A replacement process must present an incarnation at least as
          // new as the member it replaces; anything older is a zombie.
          this.#transport.send(from, {
            t: 'JOIN_DENIED',
            reason: 'stale incarnation',
          });
          break;
        }
        if (msg.observer === true) {
          // Observers see the membership snapshot but never join it: no
          // registration, no PEER_UP broadcast, no heartbeat tracking.
          this.#transport.send(from, {
            t: 'WELCOME',
            nodeId: this.#transport.nodeId,
            peers: [
              ...Array.from(this.#peers.entries()).map(([nodeId, p]) => ({
                nodeId,
                load: p.load,
                ...(p.incarnation !== undefined ? { incarnation: p.incarnation } : {}),
                ...(p.endpoint !== undefined ? { endpoint: p.endpoint } : {}),
                ...(p.certHash !== undefined ? { certHash: p.certHash } : {}),
              })),
            ],
            ...(this.#clusterId !== null ? { clusterId: this.#clusterId } : {}),
          });
          break;
        }
        this.#peers.set(from, {
          load: msg.load,
          ...(msg.incarnation !== undefined ? { incarnation: msg.incarnation } : {}),
          ...(msg.endpoint !== undefined ? { endpoint: msg.endpoint } : {}),
          ...(msg.certHash !== undefined ? { certHash: msg.certHash } : {}),
        });
        this.#lastSeen.set(from, Date.now());
        // WELCOME: send current peer list to the new node
        this.#transport.send(from, {
          t: 'WELCOME',
          nodeId: this.#transport.nodeId,
          peers: [
            ...Array.from(this.#peers.entries()).map(([nodeId, p]) => ({
              nodeId,
              load: p.load,
              ...(p.incarnation !== undefined ? { incarnation: p.incarnation } : {}),
              ...(p.endpoint !== undefined ? { endpoint: p.endpoint } : {}),
              ...(p.certHash !== undefined ? { certHash: p.certHash } : {}),
            })),
          ],
          ...(this.#clusterId !== null ? { clusterId: this.#clusterId } : {}),
        });
        // Notify existing peers of the new arrival (excluding the new peer)
        this.#transport.broadcastExcept(from, {
          t: 'PEER_UP',
          peer: {
            nodeId: from,
            load: msg.load,
            ...(msg.incarnation !== undefined ? { incarnation: msg.incarnation } : {}),
            ...(msg.endpoint !== undefined ? { endpoint: msg.endpoint } : {}),
            ...(msg.certHash !== undefined ? { certHash: msg.certHash } : {}),
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
        const peer = this.#peers.get(from);
        if (
          peer?.incarnation !== undefined &&
          msg.incarnation !== undefined &&
          msg.incarnation < peer.incarnation
        ) {
          // A beat from a replaced process must not keep its ghost alive.
          break;
        }
        this.#lastSeen.set(from, Date.now());
        // Refresh the placement view: without this, load is only ever the
        // value advertised once at HELLO and target selection is arbitrary.
        if (peer !== undefined && msg.load !== undefined) peer.load = msg.load;
        if (peer !== undefined) {
          const incarnation = peer.incarnation ?? 0;
          this.#ledgerOp((ledger) => ledger.renewAll(from, incarnation, this.#leaseMs));
        }
        break;
      }
      case 'SPAWN': {
        const target = this.#selectTarget(new Set([from]));
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
          spawn: msg,
          attempted: new Set([from, target]),
        });
        this.#portNodes.set(msg.parentPortId, from);
        this.#registry.register(msg.parentPortId, null, from);
        // Commit before the spawn is forwarded: if every node vanished right
        // now, the ledger still remembers this workload.
        this.#ledgerOp(async (ledger) => {
          await ledger.commit(msg.spawnReqId, JSON.stringify(msg.config));
          await ledger.claim(
            msg.spawnReqId,
            target,
            this.#peers.get(target)?.incarnation ?? 0,
            this.#leaseMs,
          );
        });
        this.#transport.send(target, msg);
        break;
      }
      case 'SPAWN_ACK': {
        const spawnInfo = this.#pendingSpawns.get(msg.spawnReqId);
        if (spawnInfo === undefined) break;
        if (!msg.ok && msg.retryable === true) {
          // The destination refused admission (overload, not error): route
          // the same spawn to the next-best node instead of failing it.
          const next = this.#selectTarget(spawnInfo.attempted);
          if (next !== null) {
            spawnInfo.attempted.add(next);
            spawnInfo.targetNodeId = next;
            this.#ledgerOp(async (ledger) => {
              await ledger.release(msg.spawnReqId, from);
              await ledger.claim(
                msg.spawnReqId,
                next,
                this.#peers.get(next)?.incarnation ?? 0,
                this.#leaseMs,
              );
            });
            this.#transport.send(next, spawnInfo.spawn);
            break;
          }
        }
        this.#pendingSpawns.delete(msg.spawnReqId);
        if (msg.ok) {
          this.#portNodes.set(msg.childPortId, from);
          this.#registry.register(msg.childPortId, spawnInfo.parentPortId, from);
          this.#ledgerIdsByChildPort.set(msg.childPortId, msg.spawnReqId);
          this.#ledgerOp(async (ledger) => {
            await ledger.markInitialized(
              msg.spawnReqId,
              from,
              this.#peers.get(from)?.incarnation ?? 0,
            );
          });
        } else {
          this.#ledgerOp((ledger) => ledger.settle(msg.spawnReqId));
        }
        this.#transport.send(spawnInfo.requesterNodeId, msg);
        break;
      }
      case 'REALM_EXIT': {
        if (this.#routedPortSequence(msg.realmId) < msg.lastPortSeq) {
          this.#pendingRealmExits.set(msg.realmId, msg);
        } else {
          this.#handleRealmExit(msg);
        }
        break;
      }
      case 'DEPLOY': {
        void this.#handleDeploy(from, msg);
        break;
      }
      case 'DEPLOYMENTS_GET': {
        void this.#handleDeploymentsGet(from, msg.spawnReqId, msg.name);
        break;
      }
      case 'ROLLBACK': {
        void this.#handleRollback(from, msg);
        break;
      }
      case 'CASK_PUT': {
        void this.#handleCaskPut(from, msg);
        break;
      }
      case 'CASK_GET': {
        void this.#handleCaskGet(from, msg.hash);
        break;
      }
      case 'PORT_MSG': {
        for (const ready of this.#takeOrderedPortMessages(msg)) {
          const targetNodeId = this.#portNodes.get(ready.toPort);
          if (targetNodeId) this.#transport.send(targetNodeId, ready);
        }
        const pendingExit = this.#pendingRealmExits.get(msg.fromPort);
        if (
          pendingExit &&
          this.#routedPortSequence(msg.fromPort) >= pendingExit.lastPortSeq
        ) {
          this.#pendingRealmExits.delete(msg.fromPort);
          this.#handleRealmExit(pendingExit);
        }
        break;
      }
      default:
        break;
    }
  }
  /** Buffer frames until the next sequence for a source port is available. */
  #takeOrderedPortMessages(msg: PortMessage): PortMessage[] {
    let state = this.#portSequences.get(msg.fromPort);
    if (!state) {
      state = { next: 1, pending: new Map() };
      this.#portSequences.set(msg.fromPort, state);
    }
    if (msg.seq < state.next || state.pending.has(msg.seq)) return [];
    state.pending.set(msg.seq, msg);
    const ready: PortMessage[] = [];
    while (state.pending.has(state.next)) {
      ready.push(state.pending.get(state.next)!);
      state.pending.delete(state.next++);
    }
    return ready;
  }
  #routedPortSequence(fromPort: string): number {
    return (this.#portSequences.get(fromPort)?.next ?? 1) - 1;
  }
  /** Forward an ordered exit and remove the exited realm subtree. */
  #handleRealmExit(msg: RealmExitMessage): void {
    const ledgerId = this.#ledgerIdsByChildPort.get(msg.realmId);
    if (ledgerId !== undefined) {
      this.#ledgerIdsByChildPort.delete(msg.realmId);
      this.#ledgerOp((ledger) => ledger.settle(ledgerId));
    }
    const portId = msg.realmId;
    const parentPortId = this.#registry.getParentPortId(portId);
    const removed = this.#registry.exit(portId);
    if (parentPortId) {
      const parentHostId = this.#portNodes.get(parentPortId);
      if (parentHostId) this.#transport.send(parentHostId, msg);
    }
    for (const p of removed) {
      const hostNodeId = this.#portNodes.get(p);
      this.#portNodes.delete(p);
      this.#portSequences.delete(p);
      this.#pendingRealmExits.delete(p);
      if (hostNodeId && p !== portId) {
        this.#transport.send(hostNodeId, {
          t: 'TERMINATE',
          realmId: p,
        });
      }
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
        // The chosen node died mid-spawn. The workload record is durable and
        // uninitialized, so route it to the next-best node when one exists.
        pending.attempted.add(nodeId);
        const next = this.#selectTarget(pending.attempted);
        if (next !== null) {
          pending.attempted.add(next);
          pending.targetNodeId = next;
          this.#ledgerOp(async (ledger) => {
            await ledger.release(spawnReqId, nodeId);
            await ledger.claim(
              spawnReqId,
              next,
              this.#peers.get(next)?.incarnation ?? 0,
              this.#leaseMs,
            );
          });
          this.#transport.send(next, pending.spawn);
          continue;
        }
        this.#pendingSpawns.delete(spawnReqId);
        this.#ledgerOp((ledger) => ledger.settle(spawnReqId));
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
      this.#portSequences.delete(portId);
      this.#pendingRealmExits.delete(portId);
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
  #selectTarget(excluded: ReadonlySet<string>): string | null {
    // Lowest pressure wins. Each queued pre-init spec counts like a fully
    // saturated core: specs are the balancing unit, and a node with a deep
    // pending queue is oversubscribed for new work regardless of current CPU.
    let best: string | null = null;
    let bestScore = Infinity;
    for (const [nId, peer] of this.#peers) {
      if (excluded.has(nId)) continue;
      if (peer.load.draining === true) continue;
      const score = peer.load.cpu + (peer.load.pendingSpecs ?? 0);
      if (score < bestScore) {
        best = nId;
        bestScore = score;
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
    this.#ledgerOp((ledger) => this.#sweepLedger(ledger));
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
