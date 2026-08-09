/**
 * internal:cluster/client - worker node cluster client.
 *
 * A `ClusterClient` is the worker-side half of the cluster protocol. It sits
 * on top of a `ClusterTransport` — the transport owns the connection and the
 * HELLO handshake — and:
 *
 * - Tracks peer membership from the seed's WELCOME / PEER_UP / PEER_DOWN
 *   messages.
 * - Accepts SPAWN messages and creates reactor-pooled Realm isolates for them.
 * - Bridges each spawned realm's scheduled port <-> cluster PORT_MSG transport
 *   (the relay pattern - the relay is transparent to all message content,
 *   so __rpc_req / __rpc_res travel as opaque PORT_MSG payloads).
 * - Sends HEARTBEAT to the seed every 2.5 s.
 * - Exposes spawnRemote() so the cluster public API can spawn realms onto
 *   remote nodes by sending SPAWN through the seed.
 * - Exposes registerPort() so ClusterPort instances can receive PORT_MSG.
 *
 * `ClusterPort` is the parent-side handle for a remotely spawned realm: a
 * `RealmPort` whose messages travel as PORT_MSG cluster frames
 * instead of an in-process channel. Ports register themselves with the
 * client on construction, queue outbound messages until SPAWN_ACK assigns
 * the child port ID, and preserve transferred ArrayBuffers end-to-end as raw
 * protobuf byte fields.
 *
 * ## Example
 *
 * ```ts no_run
 * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
 *
 * const transport = {
 *   nodeId: 'worker-a',
 *   send(to, msg) { void to; void msg; },
 *   broadcast(msg) { void msg; },
 *   on(handler) { void handler; },
 *   close() {},
 * };
 *
 * const client = new ClusterClient(transport, 'worker-a');
 * client.start();
 *
 * // Spawn a realm on another node and talk to it through a port.
 * const port = new ClusterPort('worker-a/p-1', client);
 * const childPortId = await client.spawnRemote(port.portId, {
 *   entry: '/app/child.ts',
 *   root: '/app',
 *   rules: [],
 * });
 * port._setChildPortId(childPortId);
 * port.postMessage({ hello: 'child' });
 * ```
 *
 * @internal
 */
import type { ClusterTransport } from './transport.ts';
import {
  type ClusterMessage,
  type DeploymentInfo,
  type NodeLoad,
  type SerializedSpawnConfig,
  type PeerInfo,
  encode,
  decode,
  nodeIdFromId,
} from './protocol.ts';
import { serialize, deserialize } from 'internal:serializer';
import {
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeKind,
  messageEnvelope,
} from 'internal:realm/envelope';
import { PayloadFormat } from './protocol.ts';

/**
 * V8 structured-clone wire version produced by this build.
 *
 * The serializer stamps its format version into every payload it produces, so
 * one probe gives the value to compare incoming frames against. Computed on
 * first use rather than at module load: this module is imported during realm
 * bootstrap, and reaching into the serializer while the module graph is still
 * being evaluated is a side effect worth not having.
 */
let _localPayloadVersion: number | undefined;
function localPayloadVersion(): number {
  if (_localPayloadVersion === undefined) {
    const probe = (serialize as (value: unknown) => Uint8Array[])(null)[0]!;
    _localPayloadVersion = probe.length >= 2 && probe[0] === 0xff ? probe[1]! : -1;
  }
  return _localPayloadVersion;
}

/**
 * Wire version stamped into a structured-clone payload, or `null` when the
 * bytes do not carry one.
 */
function payloadVersion(part: Uint8Array | undefined): number | null {
  if (part === undefined || part.length < 2 || part[0] !== 0xff) return null;
  return part[1]!;
}

/**
 * Reject a frame this node cannot decode.
 *
 * The cluster frame is protobuf and version-tolerant, but the realm payload it
 * carries is V8's structured-clone format, which is tied to the V8 build that
 * produced it. Without this check a peer built against a different V8 hands
 * over bytes that deserialize into corruption rather than failing cleanly.
 */
function assertDecodablePayload(message: {
  payload: Uint8Array[];
  payloadFormat?: number;
  fromPort: string;
}): void {
  const format = message.payloadFormat ?? PayloadFormat.Unspecified;
  if (format !== PayloadFormat.Unspecified && format !== PayloadFormat.V8StructuredClone) {
    throw new Error(
      `fino:cluster — port payload from ${message.fromPort} uses unsupported encoding ${format}`,
    );
  }
  // payload[0] is the envelope header, which is our own fixed layout; the realm
  // payload is the part after it.
  const version = payloadVersion(message.payload[1]);
  const local = localPayloadVersion();
  if (version !== null && local !== -1 && version !== local) {
    throw new Error(
      `fino:cluster — port payload from ${message.fromPort} was serialized by structured-clone ` +
        `version ${version}, but this node reads version ${local}`,
    );
  }
}
import {
  closeScheduledRealm,
  createScheduledRealm,
  dropShedWorkload,
  registerReactorWake,
  resubmitShedWorkload,
  scheduledRealmRecv,
  scheduledRealmSend,
  shedComplete,
  shedRecvFromParent,
  shedSendToParent,
  shedWorkloadConfig,
  shedWorkloadWakeFd,
  takeScheduledRealmStatus,
} from 'internal:scheduler-native';
import type { PeerMesh } from './webtransport-transport.ts';
import { readable, removeRead } from 'internal:runtime/loop';
import { RealmPort, type RealmLink } from 'internal:realm/transport-port';
import { env } from 'internal:process';
import { DiskFileSystem } from 'fino:file';
import {
  caskSha256Hex,
  concatCaskChunks,
  unpackCask,
  type UnpackedCask,
} from './cask.ts';
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Resolve a cask-relative entry path, refusing anything that escapes the cask.
 *
 * A workload names its children's entries, and a workload is untrusted code.
 * Absolute paths and `..` segments are rejected outright rather than
 * normalised: a containment check on a normalised path is easy to write
 * subtly wrong, and no legitimate entry inside a cask needs either.
 */
export function caskRelativeEntry(caskDir: string, entry: string): string {
  if (entry.startsWith('/')) {
    throw new Error(`spawn entry must be relative to the cask, got absolute "${entry}"`);
  }
  const segments = entry.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`spawn entry must not escape the cask, got "${entry}"`);
  }
  return `${caskDir}/${entry}`;
}

/** Per-workload cap on spawned children; a runaway must not take the node. */
function workloadSpawnQuota(): number {
  const configured = Number(env.FINO_WORKLOAD_SPAWN_QUOTA);
  return Number.isFinite(configured) && configured > 0 ? configured : 64;
}
const HEARTBEAT_MS = 2500;
function heartbeatIntervalMs(): number {
  const configured = Number(env.FINO_CLUSTER_HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : HEARTBEAT_MS;
}
// ---------------------------------------------------------------------------
// Local relay - bridges a scheduled Realm port to cluster PORT_MSG
// ---------------------------------------------------------------------------
interface RealmRelay {
  childPortId: string;
  parentPortId: string;
  /** Cask backing this realm, when it was spawned from one. */
  caskHash?: string;
  realmHandle: number;
  wakeReadFd: number;
  completionFd: number;
  closed: boolean;
  finalized: boolean;
  cancel?: () => void;
  pendingSends: Promise<void>[];
  lastPortSeq: number;
  /**
   * Highest sequence number sent to the parent *through the seed*.
   *
   * The seed holds a realm's exit until it has routed that realm's last port
   * message, which it can only do for frames it actually saw. Once a direct
   * session carries some of them, gating on `lastPortSeq` would wait forever
   * for frames that were never going to arrive.
   */
  lastRelayedSeq: number;
  lastCallError?: string;
  /** Children this workload has spawned, for the per-workload quota. */
  spawnedChildren: number;
  /**
   * The import rules this workload itself was granted.
   *
   * A child inherits them verbatim. Taking rules from the spawn request would
   * let a workload grant its children capabilities it was denied, which is the
   * narrowing rule the realm layer already enforces locally.
   */
  spawnRules: unknown[];
}
type PortMessage = Extract<ClusterMessage, { t: 'PORT_MSG' }>;
type RealmExitMessage = Extract<ClusterMessage, { t: 'REALM_EXIT' }>;
interface PortSequenceState {
  next: number;
  pending: Map<number, PortMessage>;
}
// ---------------------------------------------------------------------------
// ClusterClient
// ---------------------------------------------------------------------------
/**
 * Worker-side cluster coordinator.
 *
 * `ClusterClient` tracks peer membership, sends heartbeats, forwards local
 * `ClusterPort` messages, and starts reactor-pooled child realms when the seed
 * routes a `SPAWN` message to this node.
 *
 * ```ts no_run
 * import { ClusterClient } from 'internal:cluster/client';
 * import { WebTransportWorkerTransport } from 'internal:cluster/webtransport-transport';
 * const transport = new WebTransportWorkerTransport('worker-1');
 * const client = new ClusterClient(transport, 'worker-1');
 * client.start();
 * ```
 *
 * @internal
 */
export class ClusterClient {
  /**
   * Local node ID used to generate spawn request and port IDs.
   *
   * The value should match `transport.nodeId`. The client does not validate or
   * normalize it, so callers must pass a bare cluster node ID.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * client.nodeId;
   * ```
   */
  readonly nodeId: string;
  /**
   * Transport used to reach the seed and peers. The client assumes it is
   * already connected where the implementation requires it, and closes it in
   * `stop()`.
   *
   * @internal
   */
  #transport: ClusterTransport;
  /**
   * Peer membership keyed by node ID, populated from the seed's WELCOME
   * message and kept current by PEER_UP / PEER_DOWN.
   *
   * @internal
   */
  #peers = new Map<string, PeerInfo>();
  /**
   * Active child-realm relays keyed by childPortId. Each relay bridges a
   * locally scheduled Realm port to cluster PORT_MSG traffic; entries are
   * removed when the realm exits or `stop()` runs.
   *
   * @internal
   */
  #relays = new Map<string, RealmRelay>();
  /**
   * Parent-side `ClusterPort` instances keyed by portId, consulted first when
   * routing an inbound PORT_MSG.
   *
   * @internal
   */
  #portHandlers = new Map<string, ClusterPort>();
  /**
   * One-shot realm-exit callbacks keyed by childPortId, registered through
   * `onRealmExit()` and consumed on REALM_EXIT, TERMINATE, PEER_DOWN, or
   * `stop()`.
   *
   * @internal
   */
  #exitHandlers = new Map<string, (error?: string) => void>();
  /**
   * Exit results (error string or undefined for clean exit) for realms that
   * exited before any `onRealmExit()` handler was registered, replayed once a
   * handler arrives.
   */
  #exitedRealms = new Map<string, string | undefined>();
  /** Inbound frames buffered until each source port's next sequence arrives. */
  #inboundPortSequences = new Map<string, PortSequenceState>();
  /** Exit frames waiting for every preceding port message to be delivered. */
  #pendingRealmExits = new Map<string, RealmExitMessage>();
  /** Next sequence number for each local source port. */
  #outboundPortSequences = new Map<string, number>();
  /**
   * In-flight `spawnRemote()` requests keyed by spawnReqId, settled by the
   * matching SPAWN_ACK or rejected en masse by `stop()`.
   *
   * @internal
   */
  #pendingSpawns = new Map<
    string,
    {
      resolve: (childPortId: string) => void;
      reject: (err: Error) => void;
    }
  >();
  /**
   * Monotonic counter used to mint node-unique spawn-request IDs and child
   * port IDs.
   *
   * @internal
   */
  #localHandle = 0;
  /**
   * Interval handle for the 2.5 s HEARTBEAT to the seed; null before `start()`
   * and after `stop()`.
   *
   * @internal
   */
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Create a worker-side cluster client.
   *
   * Construction only stores references and initializes maps. Call `start()` to
   * register transport handlers and heartbeat timers; call `stop()` to release
   * relays and reject pending work.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const transport = { nodeId: 'worker-1', send() {}, broadcast() {}, on() {}, close() {} };
   * const client = new ClusterClient(transport, 'worker-1');
   * ```
   */
  constructor(
    transport: ClusterTransport,
    nodeId: string,
    options: {
      loadSampler?: () => NodeLoad;
      incarnation?: number;
      mesh?: PeerMesh;
      admission?: () => { accept: true } | { accept: false; reason: string };
    } = {},
  ) {
    this.nodeId = nodeId;
    this.#transport = transport;
    this.#loadSampler = options.loadSampler ?? null;
    this.#incarnation = options.incarnation;
    this.#mesh = options.mesh ?? null;
    this.#mesh?.on((from, msg) => this.#handle(from, msg));
    this.#admissionCheck = options.admission ?? null;
  }
  /**
   * Admission control consulted before creating a routed realm. A rejection
   * is reported to the seed as a retryable SPAWN_ACK so the spawn moves to a
   * less pressured node instead of failing.
   *
   * @internal
   */
  #admissionCheck: (() => { accept: true } | { accept: false; reason: string }) | null;
  /** In-flight shed offers keyed by request id. @internal */
  #pendingOffers = new Map<
    string,
    { resolve: (result: { accepted: boolean; reason?: string }) => void }
  >();
  /**
   * Deploy a named application from an uploaded cask and resolve with the
   * child port id once the target node has fetched the artifact and created
   * the realm — the `--wait` semantic.
   *
   * @internal
   */
  deployRemote(name: string, caskHash: string, parentPortId: string): Promise<string> {
    const spawnReqId = `${this.nodeId}-${this.#localHandle++}`;
    return new Promise((resolve, reject) => {
      this.#pendingSpawns.set(spawnReqId, { resolve, reject });
      this.#transport.send('__seed__', {
        t: 'DEPLOY',
        spawnReqId,
        parentPortId,
        name,
        hash: caskHash,
      });
    });
  }

  /** `Date.now()` of the last fetch per cask hash — the GC grace input. @internal */
  #caskFetchedAt = new Map<string, number>();

  /**
   * Cask hashes this node must not garbage-collect: everything backing a
   * realm currently relayed here, plus anything fetched within `graceMs`.
   * Everything else is re-fetchable from the control plane by content hash,
   * which is what makes cache GC a purely local decision.
   *
   * @internal
   */
  caskKeepSet(graceMs: number, now = Date.now()): Set<string> {
    const keep = new Set<string>();
    for (const relay of this.#relays.values()) {
      if (relay.caskHash !== undefined) keep.add(relay.caskHash);
    }
    for (const [hash, at] of this.#caskFetchedAt) {
      if (now - at < graceMs) keep.add(hash);
      else this.#caskFetchedAt.delete(hash);
    }
    return keep;
  }

  /** Deployment-history queries in flight, keyed by request id. @internal */
  #pendingDeploymentsGets = new Map<string, (records: DeploymentInfo[]) => void>();

  /** Fetch deployment history from the seed; `name` narrows to one app. @internal */
  listDeployments(name?: string): Promise<DeploymentInfo[]> {
    const spawnReqId = `${this.nodeId}-${this.#localHandle++}`;
    return new Promise((resolve) => {
      this.#pendingDeploymentsGets.set(spawnReqId, resolve);
      this.#transport.send('__seed__', {
        t: 'DEPLOYMENTS_GET',
        spawnReqId,
        ...(name === undefined ? {} : { name }),
      });
    });
  }

  /**
   * Roll a named deployment back one generation and resolve with the child
   * port id once the previous cask is running again.
   *
   * @internal
   */
  rollbackRemote(name: string, parentPortId: string): Promise<string> {
    const spawnReqId = `${this.nodeId}-${this.#localHandle++}`;
    return new Promise((resolve, reject) => {
      this.#pendingSpawns.set(spawnReqId, { resolve, reject });
      this.#transport.send('__seed__', { t: 'ROLLBACK', spawnReqId, parentPortId, name });
    });
  }

  /** Cask uploads awaiting the seed's verification ack, keyed by hash. @internal */
  #pendingCaskUploads = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  /** Cask downloads in flight, keyed by hash. @internal */
  #pendingCaskFetches = new Map<
    string,
    { chunks: Uint8Array[]; resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void }
  >();

  /**
   * Upload a packed cask to the control plane and resolve with its hash once
   * the seed has verified and stored it. The seed checks the bytes against
   * the hash before storing, so a successful upload means the artifact is
   * durably fetchable by that identity.
   *
   * @internal
   */
  async uploadCask(path: string): Promise<string> {
    const bytes = await new DiskFileSystem().readFile(path);
    const hash = await caskSha256Hex(bytes);
    const CHUNK = 256 * 1024;
    const done = new Promise<void>((resolve, reject) => {
      this.#pendingCaskUploads.set(hash, { resolve, reject });
    });
    for (let offset = 0, seq = 0; offset < bytes.length || seq === 0; offset += CHUNK, seq++) {
      this.#transport.send('__seed__', {
        t: 'CASK_PUT',
        hash,
        seq,
        chunk: bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length)),
        last: offset + CHUNK >= bytes.length,
      });
    }
    await done;
    return hash;
  }

  /**
   * Fetch a cask from the control plane by hash and unpack it into this
   * node's content-addressed cache. The bytes are re-verified locally before
   * unpacking — the transport is trusted for delivery, never for content.
   *
   * @internal
   */
  async fetchCask(hash: string, cacheDir: string): Promise<UnpackedCask> {
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      this.#pendingCaskFetches.set(hash, { chunks: [], resolve, reject });
      this.#transport.send('__seed__', { t: 'CASK_GET', hash });
    });
    const tmp = `${cacheDir}/.fetch-${hash}-${Math.random().toString(36).slice(2, 8)}.cask`;
    const fs = new DiskFileSystem();
    try {
      await fs.stat(cacheDir);
    } catch {
      await fs.mkdir(cacheDir);
    }
    await fs.writeFile(tmp, bytes);
    try {
      const slot = await unpackCask(tmp, cacheDir, { expectedHash: hash });
      this.#caskFetchedAt.set(hash, Date.now());
      return slot;
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  /** Proxies for workloads shed away from this node, keyed by parent port. @internal */
  #shedProxies = new Map<
    string,
    { shedHandle: number; remotePortId: string | null; cancel?: () => void }
  >();

  /**
   * Offer a shed spec to a peer and relay the parent's port to it on
   * acceptance. Resolves with the peer's answer; a refusal leaves the spec
   * for the caller to resubmit.
   *
   * @internal
   */
  offerShed(
    toNodeId: string,
    shedHandle: number,
    workloadId: number,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const spawnReqId = `${this.nodeId}-o-${this.#localHandle++}`;
    const parentPortId = `${this.nodeId}/p-shed-${workloadId}`;
    const config = shedWorkloadConfig(shedHandle);
    const offer: ClusterMessage = {
      t: 'SHED_OFFER',
      toNode: toNodeId,
      spawnReqId,
      parentPortId,
      config: {
        entry: config.entry,
        root: config.root,
        rules: JSON.parse(config.rules) as unknown[],
        ...(config.bootstrapData === null
          ? {}
          : { bootstrapData: JSON.parse(config.bootstrapData) as unknown }),
      },
    };
    return new Promise((resolve) => {
      this.#pendingOffers.set(spawnReqId, {
        resolve: (result) => {
          if (result.accepted) {
            this.#shedProxies.set(parentPortId, { shedHandle, remotePortId: null });
            this.#startShedProxy(parentPortId, shedHandle);
          }
          resolve(result);
        },
      });
      if (this.#mesh?.send(toNodeId, offer) !== true) this.#transport.send(toNodeId, offer);
    });
  }

  /**
   * Pump the local port of a shed workload to and from its new host, so the
   * parent keeps using the port it already holds.
   *
   * @internal
   */
  #startShedProxy(parentPortId: string, shedHandle: number): void {
    const wakeFd = shedWorkloadWakeFd(shedHandle);
    if (wakeFd < 0) return;
    let stopped = false;
    const proxy = this.#shedProxies.get(parentPortId);
    if (proxy !== undefined) {
      proxy.cancel = () => {
        stopped = true;
        removeRead(wakeFd);
      };
    }
    const pump = (): void => {
      if (stopped) return;
      void readable(wakeFd).then(() => {
        if (stopped) return;
        const target = this.#shedProxies.get(parentPortId);
        for (const [parts] of shedRecvFromParent(shedHandle)) {
          if (target?.remotePortId == null) continue;
          this.sendPortMsg(parentPortId, target.remotePortId, parts);
        }
        pump();
      });
    };
    pump();
  }
  /**
   * Direct peer sessions. When a session to the destination exists, realm
   * traffic goes straight there and never touches the seed; otherwise the
   * seed relays as before.
   *
   * @internal
   */
  #mesh: PeerMesh | null;
  /** Incarnation echoed in every heartbeat so the seed can fence stale processes. @internal */
  #incarnation: number | undefined;
  /**
   * Fresh load sample attached to every HEARTBEAT so the seed's placement
   * view tracks reality instead of the value advertised once at HELLO.
   *
   * @internal
   */
  #loadSampler: (() => NodeLoad) | null;
  /**
   * Cluster identity from WELCOME, or null before admission (or when the
   * seed predates cluster identities).
   */
  clusterId: string | null = null;
  /** Settlers for `ready()` waiters. @internal */
  #readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  /** 'pending' until WELCOME or JOIN_DENIED arrives. @internal */
  #admission: 'pending' | 'admitted' | { denied: string } = 'pending';
  /**
   * Resolve once the seed has admitted this node (WELCOME), or reject when
   * admission is denied or `timeoutMs` elapses first.
   */
  ready(timeoutMs = 10_000): Promise<void> {
    if (this.#admission === 'admitted') return Promise.resolve();
    if (typeof this.#admission === 'object') {
      return Promise.reject(new Error(`cluster join denied: ${this.#admission.denied}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for cluster admission'));
      }, timeoutMs);
      this.#readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }
  /** Settle admission state and any `ready()` waiters. @internal */
  #settleAdmission(outcome: 'admitted' | { denied: string }): void {
    if (this.#admission !== 'pending') return;
    this.#admission = outcome;
    const waiters = this.#readyWaiters.splice(0);
    for (const waiter of waiters) {
      if (outcome === 'admitted') waiter.resolve();
      else waiter.reject(new Error(`cluster join denied: ${outcome.denied}`));
    }
  }
  /**
   * Snapshot of peers currently known to this client.
   *
   * The returned array is copied from the internal map, so mutating it does not
   * affect membership state. Before a `WELCOME` message arrives the array is
   * empty.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * client.peers.length;
   * ```
   */
  get peers(): PeerInfo[] {
    return [...this.#peers.values()];
  }
  /**
   * Open a direct session to a peer the control plane just introduced.
   *
   * Nothing used to call this, which made the peer mesh dead code in a running
   * cluster: both sides could advertise an endpoint and still send every frame
   * through the seed, because no one ever dialed. `PeerMesh.dial` decides for
   * itself whether this node is the one that should dial (the smaller node ID
   * connects, so a pair opens one session, not two) and returns false rather
   * than throwing when it should not or cannot — a peer that will not accept
   * is not an error, it just means the seed keeps relaying for that pair.
   */
  #dialPeer(peer: PeerInfo): void {
    if (this.#mesh === null || peer.endpoint === undefined) return;
    void this.#mesh.dial(peer);
  }
  /**
   * Register a parent-side port for inbound `PORT_MSG` delivery.
   *
   * Later registrations for the same `portId` replace earlier entries. The
   * client does not validate the ID; malformed IDs may fail when the seed or
   * transport attempts to route a message.
   *
   * ```ts no_run
   * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * const port = new ClusterPort('n/p-1', client);
   * client.registerPort('n/p-1', port);
   * ```
   */
  registerPort(portId: string, port: ClusterPort): void {
    this.#portHandlers.set(portId, port);
  }
  /**
   * Remove a parent-side port registration.
   *
   * Unknown IDs are ignored. This is called automatically by `ClusterPort` when
   * it closes so subsequent `PORT_MSG` deliveries for the ID are dropped.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * client.unregisterPort('n/p-1');
   * ```
   */
  unregisterPort(portId: string): void {
    this.#portHandlers.delete(portId);
    this.#outboundPortSequences.delete(portId);
  }
  /**
   * Register a one-shot callback for when the realm identified by childPortId exits.
   * Used by Realm.run() and Realm.call() to await remote realm completion.
   *
   * A later handler for the same `childPortId` replaces the previous one. The
   * handler receives an optional error string from the remote realm; missing
   * error means normal completion. If the realm already exited before the
   * handler was registered, the buffered exit result is replayed and the
   * handler fires asynchronously on the microtask queue.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * client.onRealmExit('remote/p-2', (error) => { void error; });
   * ```
   */
  onRealmExit(childPortId: string, handler: (error?: string) => void): void {
    if (this.#exitedRealms.has(childPortId)) {
      const error = this.#exitedRealms.get(childPortId);
      this.#exitedRealms.delete(childPortId);
      Promise.resolve().then(() => handler(error));
      return;
    }
    this.#exitHandlers.set(childPortId, handler);
  }
  /**
   * Send serialized port payload parts to a remote port.
   *
   * Payload parts remain binary protobuf `bytes` fields so ArrayBuffer transfer
   * stores survive the cluster hop without base64 expansion.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * client.sendPortMsg('n/p-1', 'remote/p-2', [new Uint8Array([1, 2])]);
   * ```
   *
   * @internal
   */
  sendPortMsg(fromPort: string, toPort: string, parts: Uint8Array[]): void {
    const targetNodeId = nodeIdFromId(toPort);
    const seq = (this.#outboundPortSequences.get(fromPort) ?? 0) + 1;
    this.#outboundPortSequences.set(fromPort, seq);
    const msg: ClusterMessage = {
      t: 'PORT_MSG',
      fromPort,
      toPort,
      payload: parts,
      seq,
      payloadFormat: PayloadFormat.V8StructuredClone,
    };
    // Per-port sequencing is assigned before the path is chosen, so a pair
    // that gains a direct session mid-stream stays correctly ordered at the
    // receiver even though earlier frames arrived via the seed.
    if (this.#mesh?.send(targetNodeId, msg) === true) return;
    this.#transport.send(targetNodeId, msg);
  }
  /**
   * Spawn a realm on a remote node by sending SPAWN through the seed.
   * Returns the assigned childPortId on success.
   *
   * The returned promise rejects if the seed reports failure, if `stop()` closes
   * the client while the spawn is pending, or if the target fails to create the
   * child realm. No timeout is applied by this layer.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * await client.spawnRemote('n/p-parent', { entry: 'main.ts', root: '.', rules: [] });
   * ```
   */
  /**
   * Spawn a realm on behalf of a workload running on this node.
   *
   * The capability is deliberately mediated rather than handed over. A
   * workload has no cluster client of its own — module state is per isolate —
   * and giving it one would also give it the node's identity. Instead it asks
   * its host, and the host supplies the three things the workload must not
   * choose for itself:
   *
   * - **Parentage.** The child is spawned with the workload's own port as its
   *   parent, so it lands under the workload in the ownership tree and dies
   *   with it. This is what makes the tree structured rather than flat.
   * - **The cask.** The parent's artifact hash is propagated and the entry is
   *   resolved against that cask on the target, so a workload cannot name a
   *   path outside the code it was deployed as.
   * - **A quota.** Unbounded self-spawning is a denial of service against
   *   whichever node the workload happens to sit on.
   *
   * Import rules come from the parent's own spawn config, never from the
   * request: a child cannot be granted what its parent was denied.
   */
  async #handleWorkloadSpawn(relay: RealmRelay, request: Record<string, unknown>): Promise<void> {
    const id = request.id;
    const reply = (result: Record<string, unknown>): void => {
      if (!relay.closed) {
        this.#sendToRealm(relay.realmHandle, EnvelopeKind.ClusterSpawnResult, { id, ...result });
      }
    };
    try {
      const entry = request.entry;
      if (typeof entry !== 'string' || entry === '') {
        throw new Error('spawn requires an entry path relative to the cask');
      }
      if (relay.caskHash === undefined) {
        // Without a cask there is no root to constrain the entry against, so
        // there is no safe way to honour the request.
        throw new Error('only workloads deployed from a cask may spawn realms');
      }
      const quota = workloadSpawnQuota();
      if (relay.spawnedChildren >= quota) {
        throw new Error(`workload spawn quota of ${quota} reached`);
      }
      relay.spawnedChildren++;
      const childPortId = await this.spawnRemote(
        relay.childPortId,
        {
          entry,
          root: '',
          rules: relay.spawnRules,
          ...(request.bootstrapData === undefined
            ? {}
            : { bootstrapData: request.bootstrapData }),
        },
        relay.caskHash,
      );
      reply({ childPortId });
    } catch (error) {
      relay.spawnedChildren = Math.max(0, relay.spawnedChildren - 1);
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  spawnRemote(
    parentPortId: string,
    config: SerializedSpawnConfig,
    caskHash?: string,
  ): Promise<string> {
    const spawnReqId = `${this.nodeId}-${this.#localHandle++}`;
    return new Promise<string>((resolve, reject) => {
      this.#pendingSpawns.set(spawnReqId, {
        resolve,
        reject,
      });
      this.#transport.send('__seed__', {
        t: 'SPAWN',
        spawnReqId,
        parentPortId,
        config,
        ...(caskHash === undefined ? {} : { caskHash }),
      });
    });
  }
  /**
   * Register the transport message handler and start periodic heartbeats.
   *
   * Heartbeats are sent to `__seed__` every 2500 ms by default. The
   * `FINO_CLUSTER_HEARTBEAT_INTERVAL_MS` override also controls this sender so
   * short seed timeouts cannot expire otherwise healthy clients. Calling
   * `start()` more than once adds another handler and timer.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * client.start();
   * ```
   */
  start(): void {
    this.#transport.on((from, msg) => this.#handle(from, msg));
    this.#heartbeatTimer = setInterval(() => {
      const load = this.#loadSampler?.();
      this.#transport.send('__seed__', {
        t: 'HEARTBEAT',
        ts: Date.now(),
        ...(load !== undefined ? { load } : {}),
        ...(this.#incarnation !== undefined ? { incarnation: this.#incarnation } : {}),
      });
    }, heartbeatIntervalMs());
  }
  /**
   * Stop heartbeats, close relays, reject pending spawns, and close transport.
   *
   * Realm-exit waiters are invoked with an error message so `Realm.run()` and
   * `Realm.call()` settle instead of hanging. Calling `stop()` repeatedly is
   * tolerated, but the closed transport cannot be reused.
   *
   * ```ts no_run
   * import { ClusterClient } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * client.stop();
   * ```
   */
  stop(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    for (const upload of this.#pendingCaskUploads.values()) {
      upload.reject(new Error('cluster client stopped'));
    }
    this.#pendingCaskUploads.clear();
    for (const fetch of this.#pendingCaskFetches.values()) {
      fetch.reject(new Error('cluster client stopped'));
    }
    this.#pendingCaskFetches.clear();
    for (const relay of this.#relays.values()) {
      if (!relay.closed) this.#sendToRealm(relay.realmHandle, EnvelopeKind.Terminate, null);
      relay.cancel?.();
    }
    this.#relays.clear();
    // Reject all pending realm-exit waiters so Realm.run() / Realm.call() settle.
    const err = new Error('fino:cluster — cluster connection closed');
    for (const handler of this.#exitHandlers.values()) {
      try {
        handler(err.message);
      } catch {}
    }
    this.#exitHandlers.clear();
    this.#inboundPortSequences.clear();
    this.#pendingRealmExits.clear();
    this.#outboundPortSequences.clear();
    for (const pending of this.#pendingSpawns.values()) {
      pending.reject(err);
    }
    this.#pendingSpawns.clear();
    this.#transport.close();
  }
  /**
   * Dispatch one inbound cluster message.
   *
   * Membership messages update `#peers` (PEER_DOWN also fails exit waiters
   * for realms on the lost node), SPAWN_ACK settles the matching pending
   * spawn, SPAWN creates a local child realm (failures are reported back as a
   * failed SPAWN_ACK), TERMINATE forwards `__terminate` into a live relay or
   * settles/buffers the exit waiter, REALM_EXIT notifies or buffers the
   * parent-side waiter, and PORT_MSG routes to a registered `ClusterPort`
   * first, then to a child-realm relay. Unknown message types are ignored.
   *
   * @internal
   */
  #handle(from: string, msg: ClusterMessage): void {
    switch (msg.t) {
      case 'WELCOME': {
        for (const p of msg.peers) {
          this.#peers.set(p.nodeId, p);
          this.#dialPeer(p);
        }
        this.clusterId = msg.clusterId ?? null;
        this.#settleAdmission('admitted');
        break;
      }
      case 'JOIN_DENIED': {
        this.#settleAdmission({ denied: msg.reason });
        break;
      }
      case 'SHED_OFFER': {
        void this.#handleShedOffer(from, msg);
        break;
      }
      case 'DEPLOYMENTS': {
        const pending = this.#pendingDeploymentsGets.get(msg.spawnReqId);
        if (pending !== undefined) {
          this.#pendingDeploymentsGets.delete(msg.spawnReqId);
          pending(msg.deployments);
        }
        break;
      }
      case 'CASK_ACK': {
        const upload = this.#pendingCaskUploads.get(msg.hash);
        if (upload !== undefined) {
          this.#pendingCaskUploads.delete(msg.hash);
          if (msg.ok) upload.resolve();
          else upload.reject(new Error(msg.error ?? 'cask upload refused'));
          break;
        }
        const fetch = this.#pendingCaskFetches.get(msg.hash);
        if (fetch !== undefined && !msg.ok) {
          this.#pendingCaskFetches.delete(msg.hash);
          fetch.reject(new Error(msg.error ?? 'cask fetch refused'));
        }
        break;
      }
      case 'CASK_DATA': {
        const fetch = this.#pendingCaskFetches.get(msg.hash);
        if (fetch === undefined) break;
        if (msg.seq !== fetch.chunks.length) {
          this.#pendingCaskFetches.delete(msg.hash);
          fetch.reject(new Error(`cask fetch: out-of-order chunk ${msg.seq}`));
          break;
        }
        fetch.chunks.push(msg.chunk);
        if (msg.last) {
          this.#pendingCaskFetches.delete(msg.hash);
          fetch.resolve(concatCaskChunks(fetch.chunks));
        }
        break;
      }
      case 'SHED_RESULT': {
        const pending = this.#pendingOffers.get(msg.spawnReqId);
        this.#pendingOffers.delete(msg.spawnReqId);
        if (pending === undefined) break;
        if (msg.ok) {
          // Point the proxy at the accepted workload before reporting
          // success, so the first forwarded message has somewhere to go.
          for (const proxy of this.#shedProxies.values()) {
            if (proxy.remotePortId === null) proxy.remotePortId = msg.childPortId;
          }
          pending.resolve({ accepted: true });
        } else {
          pending.resolve({ accepted: false, ...(msg.error === undefined ? {} : { reason: msg.error }) });
        }
        break;
      }
      case 'PEER_UP': {
        this.#peers.set(msg.peer.nodeId, msg.peer);
        this.#dialPeer(msg.peer);
        break;
      }
      case 'PEER_DOWN': {
        this.#peers.delete(msg.nodeId);
        const error = `fino:cluster — peer ${msg.nodeId} disconnected`;
        for (const [realmId, handler] of [...this.#exitHandlers.entries()]) {
          if (nodeIdFromId(realmId) !== msg.nodeId) continue;
          this.#exitHandlers.delete(realmId);
          try {
            handler(error);
          } catch {}
        }
        for (const portId of [...this.#inboundPortSequences.keys()]) {
          if (nodeIdFromId(portId) === msg.nodeId) this.#inboundPortSequences.delete(portId);
        }
        for (const realmId of [...this.#pendingRealmExits.keys()]) {
          if (nodeIdFromId(realmId) === msg.nodeId) this.#pendingRealmExits.delete(realmId);
        }
        break;
      }
      case 'SPAWN_ACK': {
        const pending = this.#pendingSpawns.get(msg.spawnReqId);
        this.#pendingSpawns.delete(msg.spawnReqId);
        if (!pending) break;
        if (msg.ok) {
          pending.resolve(msg.childPortId);
        } else {
          pending.reject(new Error(msg.error ?? 'Spawn failed'));
        }
        break;
      }
      case 'SPAWN': {
        this.#handleSpawn(msg).catch((err: unknown) => {
          this.#transport.send('__seed__', {
            t: 'SPAWN_ACK',
            spawnReqId: msg.spawnReqId,
            childPortId: '',
            ok: false,
            error: String(err),
          });
        });
        break;
      }
      case 'TERMINATE': {
        const relay = this.#relays.get(msg.realmId);
        if (relay && !relay.closed) {
          this.#sendToRealm(relay.realmHandle, EnvelopeKind.Terminate, null);
          break;
        }
        const handler = this.#exitHandlers.get(msg.realmId);
        if (handler) {
          this.#exitHandlers.delete(msg.realmId);
          handler(`fino:cluster — peer ${nodeIdFromId(msg.realmId)} disconnected`);
        } else {
          this.#exitedRealms.set(
            msg.realmId,
            `fino:cluster — peer ${nodeIdFromId(msg.realmId)} disconnected`,
          );
        }
        this.#pendingRealmExits.delete(msg.realmId);
        this.#inboundPortSequences.delete(msg.realmId);
        break;
      }
      case 'REALM_EXIT': {
        if (this.#deliveredPortSequence(msg.realmId) < msg.lastPortSeq) {
          this.#pendingRealmExits.set(msg.realmId, msg);
        } else {
          this.#deliverRealmExit(msg);
        }
        break;
      }
      case 'PORT_MSG': {
        for (const ready of this.#takeOrderedPortMessages(msg)) {
          this.#deliverPortMessage(ready);
        }
        const pendingExit = this.#pendingRealmExits.get(msg.fromPort);
        if (pendingExit && this.#deliveredPortSequence(msg.fromPort) >= pendingExit.lastPortSeq) {
          this.#pendingRealmExits.delete(msg.fromPort);
          this.#deliverRealmExit(pendingExit);
        }
        break;
      }
      default:
        // The seed-directed kinds (HELLO, HEARTBEAT, DEPLOY, CASK_PUT, …) never
        // travel this way. One arriving here means it was routed to the wrong
        // node, and dropping it silently is how a hung balancer looked like a
        // deadlock rather than a missing case.
        console.error(
          `fino:cluster client has no handler for ${msg.t} from ${from} — message dropped`,
        );
        break;
    }
  }
  /** Buffer out-of-order streams and return the newly contiguous frames. */
  #takeOrderedPortMessages(msg: PortMessage): PortMessage[] {
    let state = this.#inboundPortSequences.get(msg.fromPort);
    if (!state) {
      state = { next: 1, pending: new Map() };
      this.#inboundPortSequences.set(msg.fromPort, state);
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
  #deliveredPortSequence(fromPort: string): number {
    return (this.#inboundPortSequences.get(fromPort)?.next ?? 1) - 1;
  }
  /** Deliver one ordered port frame to its local parent port or child relay. */
  #deliverPortMessage(msg: PortMessage): void {
    try {
      assertDecodablePayload(msg);
    } catch (err: unknown) {
      // Refuse the frame rather than handing mismatched bytes to a
      // deserializer; a decode failure here is a peer compatibility problem,
      // not a malformed message from a healthy peer.
      console.error(String(err));
      return;
    }
    const localPort = this.#portHandlers.get(msg.toPort);
    if (localPort) {
      try {
        localPort._deliver(msg.payload);
      } catch (err: unknown) {
        console.error(`fino:cluster PORT_MSG decode error (parent port): ${err}`);
      }
      return;
    }
    const relay = this.#relays.get(msg.toPort);
    if (!relay || relay.closed) return;
    try {
      const [header, mainBuf, ...stores] = msg.payload;
      if (mainBuf) {
        scheduledRealmSend(relay.realmHandle, header ?? new Uint8Array(), mainBuf, stores, []);
      }
    } catch (err: unknown) {
      console.error(`fino:cluster PORT_MSG decode error (relay): ${err}`);
    }
  }
  /** Notify or buffer the parent-side waiter after its final message arrived. */
  #deliverRealmExit(msg: RealmExitMessage): void {
    const handler = this.#exitHandlers.get(msg.realmId);
    if (handler) {
      this.#exitHandlers.delete(msg.realmId);
      handler(msg.error);
    } else {
      this.#exitedRealms.set(msg.realmId, msg.error);
    }
    this.#pendingRealmExits.delete(msg.realmId);
    this.#inboundPortSequences.delete(msg.realmId);
  }
  /**
   * Create a reactor-pooled child Realm for an inbound SPAWN.
   *
   * Mints a childPortId, submits the isolate to the process reactor pool,
   * registers a relay, acknowledges with a successful SPAWN_ACK, and starts
   * the relay loop.
   *
   * @internal
   */
  /**
   * Accept or refuse a peer's shed offer. Acceptance runs the same admission
   * check as a routed spawn, so an overloaded node never becomes the dumping
   * ground for a neighbour's queue.
   *
   * @internal
   */
  async #handleShedOffer(
    from: string,
    msg: Extract<ClusterMessage, { t: 'SHED_OFFER' }>,
  ): Promise<void> {
    const verdict = this.#admissionCheck?.();
    const reply = (ok: boolean, childPortId: string, error?: string): void => {
      const result: ClusterMessage = {
        t: 'SHED_RESULT',
        toNode: from,
        spawnReqId: msg.spawnReqId,
        childPortId,
        ok,
        ...(error === undefined ? {} : { error }),
      };
      if (this.#mesh?.send(from, result) !== true) this.#transport.send(from, result);
    };
    if (verdict !== undefined && verdict.accept === false) {
      reply(false, '', verdict.reason);
      return;
    }
    try {
      await this.#handleSpawn(
        {
          t: 'SPAWN',
          spawnReqId: msg.spawnReqId,
          parentPortId: msg.parentPortId,
          config: msg.config,
        },
        (childPortId) => reply(true, childPortId),
      );
    } catch (err) {
      reply(false, '', err instanceof Error ? err.message : String(err));
    }
  }

  async #handleSpawn(
    msg: Extract<
      ClusterMessage,
      {
        t: 'SPAWN';
      }
    >,
    ack?: (childPortId: string) => void,
  ): Promise<void> {
    const verdict = this.#admissionCheck?.();
    if (verdict !== undefined && verdict.accept === false) {
      this.#transport.send('__seed__', {
        t: 'SPAWN_ACK',
        spawnReqId: msg.spawnReqId,
        childPortId: '',
        ok: false,
        error: verdict.reason,
        retryable: true,
      });
      return;
    }
    let config = msg.config;
    let caskHash: string | undefined;
    if (msg.caskHash !== undefined) {
      caskHash = msg.caskHash;
      // Deployment spawn: materialize the artifact before the realm exists.
      // fetchCask is a cache no-op when this node already holds the hash.
      const cacheDir = env.FINO_CASK_CACHE_DIR ?? `/tmp/fino-cask-cache-${this.nodeId}`;
      const slot = await this.fetchCask(msg.caskHash, cacheDir);
      // A workload spawning a sibling names its entry relative to the cask it
      // came from; the manifest entry is the default for a deployment root.
      // The path is resolved here, on the target, so the requester never gets
      // to name a host path — see caskRelativeEntry.
      const entry =
        config.entry === '' ? slot.entryPath : caskRelativeEntry(slot.dir, config.entry);
      config = { ...config, entry, root: slot.dir };
    }
    const childPortId = `${this.nodeId}/${this.#localHandle++}`;
    const scheduled = createScheduledRealm(
      config.root ?? '',
      config.entry,
      config.rules,
      false,
      undefined,
      config.bootstrapData,
      false,
    );
    registerReactorWake(scheduled.owner, scheduled.wakeFd);
    const relay: RealmRelay = {
      childPortId,
      parentPortId: msg.parentPortId,
      realmHandle: scheduled.handle,
      wakeReadFd: scheduled.portWakeFd,
      completionFd: scheduled.completionFd,
      closed: false,
      finalized: false,
      pendingSends: [],
      lastPortSeq: 0,
      lastRelayedSeq: 0,
      spawnedChildren: 0,
      spawnRules: config.rules,
      ...(caskHash === undefined ? {} : { caskHash }),
    };
    this.#relays.set(childPortId, relay);
    // Acknowledge so the requester learns the childPortId. A routed spawn
    // answers the seed; a shed offer answers the offering peer directly.
    if (ack !== undefined) {
      ack(childPortId);
    } else {
      this.#transport.send('__seed__', {
        t: 'SPAWN_ACK',
        spawnReqId: msg.spawnReqId,
        childPortId,
        ok: true,
      });
    }
    // Forward scheduled-port messages to the parent via PORT_MSG.
    this.#runRelayLoop(relay);
  }
  /**
   * Drive a child realm's relay until the realm finishes.
   *
   * The process reactor drives the child isolate. This relay waits only for
   * outbound port traffic and the scalar completion signal, then sends
   * REALM_EXIT after any in-flight PORT_MSG sends settle.
   *
   * @internal
   */
  async #runRelayLoop(relay: RealmRelay): Promise<void> {
    const { wakeReadFd, completionFd, realmHandle } = relay;
    let stepError: string | undefined;
    const finalize = (notify = true) => {
      if (relay.finalized) return;
      relay.finalized = true;
      this.#drainInbound(relay, () => {});
      relay.closed = true;
      relay.cancel = undefined;
      removeRead(wakeReadFd);
      removeRead(completionFd);
      this.#relays.delete(relay.childPortId);
      this.#inboundPortSequences.delete(relay.parentPortId);
      const status = takeScheduledRealmStatus(realmHandle);
      if (status.kind === 'error') stepError = status.error ?? 'remote Realm failed';
      closeScheduledRealm(realmHandle);
      const msg: ClusterMessage =
        stepError !== undefined
          ? {
              t: 'REALM_EXIT',
              realmId: relay.childPortId,
              lastPortSeq: relay.lastRelayedSeq,
              error: stepError,
            }
          : relay.lastCallError !== undefined
            ? {
                t: 'REALM_EXIT',
                realmId: relay.childPortId,
                lastPortSeq: relay.lastRelayedSeq,
                error: relay.lastCallError,
              }
            : {
                t: 'REALM_EXIT',
                realmId: relay.childPortId,
                lastPortSeq: relay.lastRelayedSeq,
              };
      const pending = relay.pendingSends.splice(0);
      // Frames that went direct are only ordered ahead of this exit if they
      // have reached the wire, so wait for the session to drain too.
      const parentNodeId = nodeIdFromId(relay.parentPortId);
      if (this.#mesh !== null) pending.push(this.#mesh.flush(parentNodeId));
      if (!notify) return;
      Promise.allSettled(pending)
        .then(() => {
          this.#transport.send('__seed__', msg);
        })
        .catch(() => {
          this.#transport.send('__seed__', msg);
        });
    };
    relay.cancel = () => finalize(false);
    try {
      while (!relay.closed) {
        const source = await Promise.race([
          readable(wakeReadFd).then(() => 'message' as const),
          readable(completionFd).then(() => 'complete' as const),
        ]);
        if (relay.closed) break;
        if (source === 'complete') break;
        this.#drainInbound(relay, finalize);
      }
    } catch (err: unknown) {
      stepError = String(err);
    } finally {
      finalize();
    }
  }
  /**
   * Drain messages the child realm has written to its thread port and forward
   * them to the parent as PORT_MSG frames.
   *
   * Raw serialized bytes are forwarded unmodified so ArrayBuffer transfer
   * stores survive the hop. Each message is peeked (deserialized without
   * stores) to detect the `__terminate` sentinel, which triggers `finalize`
   * instead of forwarding, and to record `__call_error` messages for the
   * eventual REALM_EXIT. Per-message errors are logged and skipped so one bad
   * frame cannot stall the relay.
   *
   * @internal
   */
  #drainInbound(relay: RealmRelay, finalize: () => void): void {
    const messages = scheduledRealmRecv(relay.realmHandle);
    for (const [byteArr, , header] of messages) {
      try {
        const parts = byteArr as Uint8Array[];
        const mainBuf = parts[0];
        if (!mainBuf) continue;
        // The envelope is readable on its own, so classifying a frame no longer
        // costs a deserialize of the payload it describes.
        const envelope = decodeEnvelope(header);
        // A workload asking its host to spawn on its behalf. The request stops
        // here rather than travelling to the parent: the capability belongs to
        // the node hosting the workload, which is the only party that knows
        // the workload's cask root and can enforce it. It carries its own
        // envelope kind so this stays a header read.
        if (envelope.kind === EnvelopeKind.ClusterSpawnRequest) {
          try {
            const request = (deserialize as (b: Uint8Array) => unknown)(mainBuf);
            if (isRecord(request)) void this.#handleWorkloadSpawn(relay, request);
          } catch {}
          continue;
        }
        if (envelope.kind === EnvelopeKind.Terminate) {
          finalize();
          return;
        }
        if (envelope.kind === EnvelopeKind.CallError) {
          try {
            const failure = (deserialize as (b: Uint8Array) => unknown)(mainBuf) as {
              message?: unknown;
            };
            relay.lastCallError = String(failure?.message ?? 'Realm call failed');
          } catch {}
        }
        // Forward the raw serialized bytes (preserving stores for ArrayBuffer
        // transfers) behind the envelope header, so the receiving node can
        // classify the frame without decoding the payload either.
        const seq = ++relay.lastPortSeq;
        const msg: ClusterMessage = {
          t: 'PORT_MSG',
          fromPort: relay.childPortId,
          toPort: relay.parentPortId,
          payload: [header ?? encodeEnvelope(messageEnvelope()), ...parts],
          seq,
        };
        // The child-to-parent direction is half of every realm conversation.
        // Sending it unconditionally to the seed left the seed carrying that
        // half no matter how well the mesh worked.
        const parentNodeId = nodeIdFromId(relay.parentPortId);
        if (this.#mesh?.send(parentNodeId, msg) === true) continue;
        relay.lastRelayedSeq = seq;
        const sent = this.#transport.send('__seed__', msg);
        if (sent instanceof Promise) relay.pendingSends.push(sent);
      } catch (err: unknown) {
        console.error(`fino:cluster relay drain error: ${err}`);
      }
    }
  }
  /**
   * Serialize a value and push it into a child Realm's scheduled port. Used for
   * control messages like `__terminate` and for delivering
   * inbound PORT_MSG payloads after transferred buffers have been
   * reconstructed; the value is re-serialized as a single part with no
   * separate transfer stores.
   *
   * @internal
   */
  #sendToRealm(handle: number, kind: number, value: unknown): void {
    const bytes = (serialize as (v: unknown) => Uint8Array[])(value)[0]!;
    scheduledRealmSend(handle, encodeEnvelope({ kind: kind as 0, correlation: 0 }), bytes, [], []);
  }
}
// ---------------------------------------------------------------------------
// ClusterPort - parent-side port for communicating with a remote child realm
// ---------------------------------------------------------------------------
/**
 * Parent-side port for communicating with a remote clustered child realm.
 *
 * Outbound messages are serialized and sent as `PORT_MSG` cluster messages;
 * inbound payloads are deserialized and dispatched through the shared
 * shared realm-port machinery. Messages posted before the child port ID is
 * assigned are queued and flushed once `SPAWN_ACK` delivers the ID.
 *
 * ```ts no_run
 * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
 * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
 * const port = new ClusterPort('n/p-parent', client);
 * port.postMessage({ ready: true });
 * ```
 *
 * @internal
 */
export class ClusterPort extends RealmPort {
  /**
   * Parent-side port ID used for seed routing and inbound lookup.
   *
   * The value is assigned by the caller and is not parsed by the constructor.
   * It should include a node prefix, for example `node-a/p-1`.
   *
   * ```ts no_run
   * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * new ClusterPort('n/p-parent', client).portId;
   * ```
   */
  readonly portId: string;
  /**
   * Owning `ClusterClient`, used for registration and outbound `sendPortMsg()`
   * calls.
   *
   * @internal
   */
  #client: ClusterClient;
  /**
   * Remote child port ID assigned by SPAWN_ACK via `_setChildPortId()`; null
   * until then, during which outbound messages accumulate in the pre-spawn
   * queue.
   *
   * @internal
   */
  #childPortId: string | null = null;
  /**
   * Outbound messages serialized before `_setChildPortId()` ran, flushed in
   * order once the child port ID arrives. Spawn is asynchronous (SPAWN_ACK),
   * so early sends — including a prompt `terminate()` — must not be lost.
   *
   * @internal
   */
  #preSpawnQueue: Uint8Array[][] = [];
  /**
   * Create and register a cluster port with its owning client.
   *
   * The constructor immediately calls `client.registerPort()`. Close the port
   * to unregister it; until `_setChildPortId()` runs, outbound `postMessage()`
   * calls are queued and flushed on assignment.
   *
   * ```ts no_run
   * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * const port = new ClusterPort('n/p-parent', client);
   * ```
   */
  constructor(portId: string, client: ClusterClient) {
    // A cluster hop leaves the process, so no transit channel can follow it and
    // there is no descriptor to poll — inbound frames are pushed in by the
    // transport through `_deliver`.
    const link: RealmLink = {
      transport: 'cluster',
      wakeFd: -1,
      supportsPortTransfer: false,
      send: (header, data, stores) => this.#route([header, data, ...stores]),
      drain: () => [],
      close: () => this.#client.unregisterPort(this.portId),
    };
    super(link);
    this.portId = portId;
    this.#client = client;
    client.registerPort(portId, this);
  }
  /**
   * Send a framed message to the child, or queue it until the child port ID
   * arrives.
   *
   * Spawn is asynchronous, so early sends — including a prompt `terminate()` —
   * must not be lost.
   *
   * @internal
   */
  #route(parts: Uint8Array[]): void {
    if (this.#childPortId === null) {
      this.#preSpawnQueue.push(parts);
      return;
    }
    this.#client.sendPortMsg(this.portId, this.#childPortId, parts);
  }
  /**
   * Set the remote child port ID after a successful `SPAWN_ACK`.
   *
   * This internal method enables future `postMessage()` calls to route to the
   * child realm. It may be called again to retarget the port, though normal
   * spawn flow calls it exactly once.
   *
   * ```ts no_run
   * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * const port = new ClusterPort('n/p-parent', client);
   * port._setChildPortId('remote/p-child');
   * ```
   *
   * @internal
   */
  _setChildPortId(childPortId: string): void {
    this.#childPortId = childPortId;
    for (const parts of this.#preSpawnQueue.splice(0)) {
      this.#client.sendPortMsg(this.portId, childPortId, parts);
    }
  }
  /**
   * Serialize and send a message to the remote child realm.
   *
   * If the port is closed the call is a no-op. If the child port ID has not
   * arrived yet, the serialized message is queued and flushed in order once
   * `_setChildPortId()` runs. Transferable `ArrayBuffer`s are preserved as
   * serialized store parts and forwarded through the cluster payload.
   * MessagePort transfer is not supported by the cluster relay and
   * non-ArrayBuffer transfer entries throw.
   *
   * ```ts no_run
   * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * const port = new ClusterPort('n/p-parent', client);
   * port._setChildPortId('remote/p-child');
   * port.postMessage({ ok: true });
   * ```
   */
  /**
   * Deliver raw serialized payload parts from an incoming `PORT_MSG`.
   *
   * Empty payload arrays are ignored. When store parts are present they are
   * passed to `_dispatchMessage()` so transferred buffers are reconstructed.
   *
   * ```ts no_run
   * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
   * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
   * const port = new ClusterPort('n/p-parent', client);
   * port._deliver([new Uint8Array()]);
   * ```
   *
   * @internal
   */
  _deliver(parts: Uint8Array[]): void {
    const [header, mainBuf, ...stores] = parts;
    if (!mainBuf) return;
    this._dispatchMessage(mainBuf, stores.length > 0 ? stores : undefined, [], header);
  }
}
