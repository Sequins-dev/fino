/**
 * fino:cluster - public API for cluster participation.
 *
 * Cluster transport uses WebTransport over HTTP/3, with realm port payloads
 * modeled after HTML channel messaging where the cluster serializer supports
 * the same value shape.
 *
 * Learn more:
 *
 * - WebTransport: https://www.w3.org/TR/webtransport/
 * - HTML channel messaging: https://html.spec.whatwg.org/multipage/web-messaging.html#channel-messaging
 *
 * A node joins the cluster in one of two roles:
 *
 * `startCluster({ port })` - Start a seed server on the given port AND
 *   participate as a worker. The calling node becomes both the coordinator
 *   and an execution target. This is the entry point for the first node.
 *
 * `joinCluster({ seed })` - Connect to an existing seed node. The calling
 *   node becomes a worker: it accepts realm spawns and hosts them locally.
 *   It can also spawn remote realms onto other workers.
 *
 * After either call, `new Realm({ ..., remote: true })` routes through the
 * active cluster client to spawn onto a remote worker.
 *
 * Only one cluster connection per process is supported. Calling either
 * function when already connected throws.
 *
 * Current release scope uses one trusted seed node. Seed election and cluster
 * authentication are not implemented in this release. Direct peer-to-peer
 * `PORT_MSG` delivery remains deferred; control-plane and data-plane messages
 * route through the seed-backed WebTransport cluster.
 *
 * Remote realm messaging conformance:
 *
 * | Topic | Current behavior |
 * | --- | --- |
 * | Trust model | A single trusted seed routes membership, spawn, and port traffic. Hostile-peer handling, authentication failures, seed election, and peer authorization are unsupported. |
 * | Spawn routing | `Realm({ remote: true })` sends `SPAWN` through the seed, which selects a worker and returns `SPAWN_ACK`; failures reject the pending spawn. |
 * | Port routing | `PORT_MSG` frames route through the seed by destination port ID. Direct peer-to-peer port delivery and transport negotiation are not part of the public protocol. |
 * | Ordering | Messages sent over one routed port pair are delivered in send order by the reliable WebTransport stream path used for each `PORT_MSG`; the API does not promise global ordering across unrelated ports. |
 * | Transfers | `ArrayBuffer` transfer stores are preserved through the serializer and cluster payload. `MessagePort` and other live handle transfers are rejected for remote realms. |
 * | Close and errors | Local port close unregisters the parent-side port, remote realm exit rejects or resolves the waiting `run()` / `call()`, and connection close rejects pending spawns and active remote calls. |
 *
 * @example
 * ```ts no_run
 * import { startCluster, leaveCluster } from 'fino:cluster';
 * import { Realm } from 'fino:realm';
 *
 * await startCluster({ port: 9999, nodeId: 'seed-a', tls: { cert: './cert.pem', key: './key.pem' } });
 * const realm = new Realm({ entry: './worker.ts', remote: true });
 * await realm.call('healthcheck');
 * leaveCluster();
 * ```
 */
import {
  DEFAULT_CLUSTER_PATH,
  PeerMesh,
  WebTransportSeedTransport,
  WebTransportWorkerTransport,
  type WebTransportWorkerConnectOptions,
} from 'internal:cluster/webtransport-transport';
import { SeedServer } from 'internal:cluster/seed';
import { ClusterClient, ClusterPort } from 'internal:cluster/client';
import { capacityCores, capacityMemoryBytes, sampleNodeLoad } from 'internal:runtime/stats';
import { availableParallelism, reactorQueueDepth } from 'internal:scheduler-native';
import { WorkloadLedger } from 'internal:cluster/ledger';
import { gcCasks, gcCaskStore } from 'internal:cluster/cask';
import { env } from 'internal:process';
import { SystemRealmAgent, type NodeReport } from 'internal:cluster/agent';
import { drainQueue, eligiblePeers, type DrainReport } from 'internal:cluster/balance-loop';
import { mintJoinString, parseJoinString } from 'internal:cluster/join-string';
import { DiskFileSystem } from 'fino:file';
import { generateSelfSignedCertificate, isPemText } from 'internal:openssl';
import { h3Available } from 'internal:net/http/h3';
import { quicAvailable } from 'fino:net/quic';
import type { WebTransportHash } from 'fino:net/http/webtransport';
/**
 * Transport port that routes realm channel messages through the cluster.
 *
 * This is an internal support export for `fino:realm`, which binds a
 * `ClusterPort` to each `Realm({ remote: true })` so structured messages
 * flow over the seed-routed WebTransport connection. Application code should
 * not construct one directly — use `startCluster()` / `joinCluster()` and
 * spawn remote realms instead.
 *
 * ```ts no_run
 * import { startCluster } from 'fino:cluster';
 * import { Realm } from 'fino:realm';
 *
 * await startCluster({ port: 9999, tls: { cert: './cert.pem', key: './key.pem' } });
 * const realm = new Realm({ entry: './worker.ts', remote: true });
 * realm.port.postMessage({ hello: 'cluster' });
 * ```
 */
export { ClusterPort };
// ---------------------------------------------------------------------------
// Module-level active cluster state
// ---------------------------------------------------------------------------
let _client: ClusterClient | null = null;
let _seed: SeedServer | null = null;
let _joinString: string | null = null;
let _agent: SystemRealmAgent | null = null;
let _mesh: PeerMesh | null = null;
let _ledger: WorkloadLedger | null = null;
let _seedCaskDir: string | null = null;
let _stopBalance: (() => void) | null = null;
let _stopCaskGc: (() => void) | null = null;
let _draining = false;

/** Spawn the node's system realm and return the heartbeat load sampler. */
function startNodeAgent(): () => ReturnType<typeof sampleNodeLoad> {
  _agent = new SystemRealmAgent();
  _agent.start();
  return () => {
    // Prefer the system realm's observation when fresh; fall back to a local
    // sample so heartbeats never go silent while it restarts. Queue counts
    // ride along either way — they are the seed's placement signal.
    const report: NodeReport | null = _agent?.latest() ?? null;
    const depth =
      report !== null && Date.now() - report.at < 10_000 ? report.queue : reactorQueueDepth();
    const load =
      report !== null && Date.now() - report.at < 10_000 ? report.load : sampleNodeLoad();
    return {
      ...load,
      pendingSpecs: depth.pendingSpecs,
      activeWorkloads: depth.active + depth.parkedLive,
      ...(_draining ? { draining: true } : {}),
      ...clusterCapacity(),
    };
  };
}

/**
 * This node's static capacity, attached to every load sample it sends.
 *
 * Capacity is the denominator that makes cpu and memory comparable across
 * heterogeneous nodes. A zero total memory means the platform refused to
 * say, and the field is omitted rather than sent as a lie.
 */
function clusterCapacity(): { capacityCores: number; capacityMemory?: number } {
  const memory = capacityMemoryBytes();
  return {
    capacityCores: capacityCores(),
    ...(memory > 0 ? { capacityMemory: memory } : {}),
  };
}

function envMsOr(name: string, fallback: number): number {
  const configured = Number(env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/**
 * Periodically garbage-collect cask storage.
 *
 * The node cache is a purely local decision: keep what backs a running realm
 * plus anything fetched inside the grace window — everything else is
 * re-fetchable from the control plane by content hash. The seed's artifact
 * store additionally keeps every hash any deployment generation references,
 * so rollback targets survive for as long as their history does.
 */
function startCaskGc(client: ClusterClient): () => void {
  const intervalMs = envMsOr('FINO_CASK_GC_INTERVAL_MS', 600_000);
  const graceMs = envMsOr('FINO_CASK_GC_GRACE_MS', 3_600_000);
  const cacheDir = env.FINO_CASK_CACHE_DIR ?? `/tmp/fino-cask-cache-${client.nodeId}`;
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const keep = client.caskKeepSet(graceMs);
      await gcCasks(cacheDir, keep);
      if (_ledger !== null && _seedCaskDir !== null) {
        const referenced = await _ledger.referencedCaskHashes();
        for (const hash of keep) referenced.add(hash);
        await gcCaskStore(_seedCaskDir, referenced, graceMs);
      }
    } catch (err) {
      console.error(`fino:cluster cask GC failed: ${err}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void pass(), intervalMs);
  return () => clearInterval(timer);
}

/**
 * Connect the system realm's balancer to the cluster: peer pressure flows
 * down on a timer, shed offers flow back up and execute on the client. The
 * decision loop itself lives in the system realm — this is only its network.
 */
function wireSystemRealmBalancer(client: ClusterClient): () => void {
  const agent = _agent;
  if (agent === null) return () => {};
  agent.onShedOffer = (offer) =>
    _draining
      ? Promise.resolve({ accepted: false, reason: 'draining' })
      : client.offerShed(offer.toNodeId, offer.shedHandle, offer.workloadId);
  const timer = setInterval(() => {
    agent.postPeers(eligiblePeers(client));
  }, envMsOr('FINO_CLUSTER_BALANCE_INTERVAL_MS', 5000));
  return () => {
    clearInterval(timer);
    agent.onShedOffer = null;
  };
}

/**
 * Pending-spec watermark above which this node refuses new routed spawns.
 * Refusals are retryable, so the seed routes them to lighter nodes.
 */
function admissionLimit(): number {
  const configured = Number(env.FINO_CLUSTER_MAX_PENDING_SPECS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return Math.max(4, availableParallelism() * 2);
}

function defaultAdmission(): { accept: true } | { accept: false; reason: string } {
  if (_draining) return { accept: false, reason: 'draining: node is leaving the cluster' };
  const depth = reactorQueueDepth();
  if (depth.pendingSpecs >= admissionLimit()) {
    return {
      accept: false,
      reason: `overloaded: ${depth.pendingSpecs} pending specs (limit ${admissionLimit()})`,
    };
  }
  return { accept: true };
}

/** The node's system-realm agent, or null when not participating. @internal */
export function getNodeAgent(): SystemRealmAgent | null {
  return _agent;
}

/**
 * Offload this node's movable work before leaving the cluster.
 *
 * Entering the drain: the node advertises `draining` on its next heartbeat so
 * the seed stops placing onto it and peers stop offering to it, its own
 * admission refuses every incoming spawn, and normal balancing stops in
 * favour of shedding everything pre-init to any peer with headroom. At the
 * deadline (default 30 s, `FINO_CLUSTER_DRAIN_DEADLINE_MS`) each spec nobody
 * accepted fails its parent with an explicit error — never a silent loss.
 * Live workloads stay: they are pinned here by design and exit with the
 * process. The caller decides when to actually `leaveCluster()`.
 *
 * A drained node that rejoins with the same state directory gets a fresh
 * incarnation, so anything still addressed to the drained lifetime is fenced.
 */
export async function drainCluster(options: { deadlineMs?: number } = {}): Promise<DrainReport> {
  if (_client === null) throw new Error('drainCluster: not participating in a cluster');
  _draining = true;
  _stopBalance?.();
  _stopBalance = null;
  return drainQueue(_client, options);
}

/** Random URL-safe secret for join tokens and minted cluster identities. */
function randomHandle(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of the first certificate in a PEM file or PEM string, as lowercase hex. */
async function certificateSha256Hex(cert: string): Promise<string> {
  const pem = isPemText(cert)
    ? cert
    : new TextDecoder().decode(await new DiskFileSystem().readFile(cert));
  const match = pem.match(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/);
  if (match === null) {
    throw new Error(`no certificate found in ${isPemText(cert) ? 'the supplied PEM' : cert}`);
  }
  const base64 = match[1]!.replace(/\s+/g, '');
  const binary = atob(base64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read and bump the persisted process incarnation under `stateDir`, or derive
 * one from the clock when no state directory is configured. Wall-clock
 * incarnations are monotonic enough across restarts for fencing; persistence
 * makes them robust to clock skew.
 */
async function nextIncarnation(stateDir: string | undefined): Promise<number> {
  if (stateDir === undefined) return Date.now();
  const fs = new DiskFileSystem();
  const path = `${stateDir}/incarnation`;
  let previous = 0;
  try {
    previous = Number(new TextDecoder().decode(await fs.readFile(path)));
    if (!Number.isFinite(previous) || previous < 0) previous = 0;
  } catch {
    // First run: no incarnation file yet.
  }
  const next = previous + 1;
  try {
    await fs.mkdir(stateDir);
  } catch {
    // Directory may already exist.
  }
  await fs.writeFile(path, new TextEncoder().encode(String(next)));
  return next;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Options for starting the first cluster seed node.
 *
 * ```ts no_run
 * import { startCluster, type StartClusterOptions } from 'fino:cluster';
 *
 * const opts: StartClusterOptions = { port: 9999, nodeId: 'seed-a' };
 * await startCluster(opts);
 * ```
 */
export interface StartClusterOptions {
  /**
   * Whether the seed node also accepts workload placements. Default true —
   * a small cluster's seed is a useful worker. Set false for a dedicated
   * control plane: the node advertises `draining` from its first HELLO, so
   * placement skips it and application load can never starve the event loop
   * that routes the cluster.
   */
  acceptWorkloads?: boolean;
  /**
   * TCP/UDP port the seed HTTP/3 WebTransport server will listen on.
   *
   * The port must be available on the local host. There is no default because
   * the first cluster node must advertise a stable address to workers.
   *
   * ```ts no_run
   * import { startCluster } from 'fino:cluster';
   *
   * await startCluster({ port: 9999, tls: { cert: './cert.pem', key: './key.pem' } });
   * ```
   */
  port: number;
  /**
   * Interface address the seed server binds.
   *
   * Defaults to all interfaces (`0.0.0.0`, or `::` when an IPv6 hostname
   * selects the IPv6 family). The seed also joins itself as a worker; for
   * that self-connection wildcard binds (`0.0.0.0`, `::`) are mapped to the
   * matching loopback address, and bare IPv6 literals are bracketed.
   */
  hostname?: string;
  /**
   * Optional node identifier.
   *
   * When omitted, the seed uses `seed-{port}`. Choose a stable ID if logs or
   * cluster diagnostics need to correlate restarts.
   *
   * ```ts no_run
   * import { startCluster } from 'fino:cluster';
   *
   * await startCluster({ port: 9999, nodeId: 'primary-seed' });
   * ```
   */
  nodeId?: string;
  /**
   * TLS certificate and key files for the seed's HTTPS/HTTP/3 server.
   *
   * `cert` and `key` are filesystem paths to PEM files, not inline PEM text.
   * TLS is required — WebTransport rides on HTTP/3 over QUIC, so there is no
   * plaintext mode. For certificates not signed by a system-trusted CA,
   * joining workers should trust the issuing CA via `tls.ca` or pin the
   * certificate via `serverCertificateHashes`.
   *
   * ```ts no_run
   * import { startCluster } from 'fino:cluster';
   *
   * await startCluster({ port: 9999, tls: { cert: './cert.pem', key: './key.pem' } });
   * ```
   */
  tls: {
    /** Path to the PEM certificate chain file presented by the seed. */
    cert: string;
    /** Path to the PEM private key file matching `cert`. */
    key: string;
  };
  /**
   * URL path of the cluster WebTransport endpoint on the seed server.
   *
   * Defaults to `/__fino_cluster`. A missing leading slash is added. Workers
   * must connect to this exact path; WebTransport sessions requested on any
   * other path are rejected with a 404, and plain HTTP requests receive a
   * placeholder response.
   */
  path?: string;
  /**
   * Join token workers must present in HELLO.
   *
   * When set, HELLOs without this exact token are denied and the token is
   * embedded in `clusterJoinString()`. When omitted the seed admits any HELLO
   * (development mode) — `fino cluster start` always mints one.
   */
  joinToken?: string;
  /**
   * Stable cluster identity advertised in WELCOME and embedded in the join
   * string. Minted randomly when omitted.
   */
  clusterId?: string;
  /**
   * Directory for durable node state (currently the process incarnation).
   * Without it, incarnations derive from the wall clock — good enough for
   * fencing, but persistence is robust to clock skew.
   */
  stateDir?: string;
  /**
   * HTTP/3 listener configuration forwarded to the underlying server.
   *
   * HTTP/3 is always enabled — the cluster transport requires it — so the
   * only useful form is an object whose `quic` field tunes the QUIC
   * transport (timeouts, flow control, and similar low-level knobs).
   * Omitting this or passing `true` uses the defaults.
   */
  h3?:
    | true
    | {
        quic?: Record<string, unknown>;
      };
}
/**
 * Options for joining an existing cluster seed.
 *
 * ```ts no_run
 * import { joinCluster, type JoinClusterOptions } from 'fino:cluster';
 *
 * const opts: JoinClusterOptions = { seed: 'https://127.0.0.1:9999/__fino_cluster' };
 * await joinCluster(opts);
 * ```
 */
export interface JoinClusterOptions {
  /**
   * Whether this node accepts workload placements. Ephemeral control
   * connections — deploy and rollback CLIs — must join with `false`: they
   * advertise `draining` from their very first HELLO, so the seed never
   * places onto a process that exits after its command completes.
   */
  acceptWorkloads?: boolean;
  /**
   * Join string minted by the seed (`clusterJoinString()` / `fino cluster
   * start`). Supplies the seed endpoint, cluster identity to verify, join
   * token, and pinned certificate hashes in one secret value; individual
   * options below override its parts when both are given.
   */
  joinString?: string;
  /**
   * Join token presented in HELLO when the seed enforces authentication.
   * Usually supplied via `joinString`.
   */
  token?: string;
  /**
   * Directory for durable node state (currently the process incarnation).
   * Without it, incarnations derive from the wall clock.
   */
  stateDir?: string;
  /**
   * Listen for direct peer sessions so realm traffic bypasses the seed.
   *
   * The node advertises this endpoint and its certificate hash through the
   * control plane; peers dial it and send `PORT_MSG` straight here. On by
   * default: without a listener every realm-to-realm message is relayed by the
   * seed, which makes the seed the data plane for the whole cluster.
   *
   * Defaults bind an ephemeral port and mint a per-node certificate whose key
   * is never written anywhere. That certificate is a channel binding rather
   * than a credential — peers admit each other by the pinned hash advertised
   * here, and cluster membership is the seed's to grant — so it is born and
   * dies with the process, exactly like the incarnation it is fenced by.
   *
   * Pass `false` to stay seed-relayed.
   */
  peerListener?:
    | false
    | {
        /** UDP port for this node's own HTTP/3 listener. Defaults to ephemeral. */
        port?: number;
        /** Bind address; also advertised to peers. */
        hostname?: string;
        /** TLS material for the peer listener. Defaults to a minted identity. */
        tls?: { cert: string; key: string };
        /** URL path for peer sessions. Defaults to the cluster path. */
        path?: string;
      };
  /**
   * HTTPS WebTransport URL of the seed node.
   *
   * The URL must include the `https://` scheme and a reachable host and port.
   * When the path is omitted, `/__fino_cluster` is used. Optional when
   * `joinString` is given.
   *
   * ```ts no_run
   * import { joinCluster } from 'fino:cluster';
   *
   * await joinCluster({ seed: 'https://seed.example.test:9999/__fino_cluster' });
   * ```
   */
  seed?: string | URL;
  /**
   * Optional worker node identifier.
   *
   * When omitted, a short random `worker-*` ID is generated. Provide a stable
   * value for predictable logs or cluster placement diagnostics.
   *
   * ```ts no_run
   * import { joinCluster } from 'fino:cluster';
   *
   * await joinCluster({ seed: 'https://127.0.0.1:9999/__fino_cluster', nodeId: 'worker-a' });
   * ```
   */
  nodeId?: string;
  /**
   * TLS verification settings for the connection to the seed.
   *
   * `ca` is a filesystem path to a PEM CA bundle trusted for the seed's
   * certificate — use it when the seed's certificate is not signed by a
   * system-trusted CA. `rejectUnauthorized: false` skips verification
   * entirely; avoid it outside local development, since it permits
   * man-in-the-middle attacks — prefer `ca` or `serverCertificateHashes`.
   *
   * ```ts no_run
   * import { joinCluster } from 'fino:cluster';
   *
   * await joinCluster({
   *   seed: 'https://seed.example.test:9999/__fino_cluster',
   *   tls: { ca: './cluster-ca.pem' },
   * });
   * ```
   */
  tls?: {
    /** Path to a PEM CA bundle trusted for the seed's certificate. */
    ca?: string;
    /** Whether certificate verification failures abort the connection. Defaults to `true`. */
    rejectUnauthorized?: boolean;
  };
  /**
   * QUIC transport tuning forwarded to the WebTransport session.
   *
   * Low-level knobs (timeouts, flow control, and similar) applied to the
   * QUIC connection under the WebTransport session. Most deployments should
   * omit this and use the defaults.
   */
  quic?: Record<string, unknown>;
  /**
   * Certificate pinning hashes for the seed's certificate.
   *
   * Follows the WebTransport `serverCertificateHashes` model: the connection
   * is accepted when the seed's certificate matches one of the given hashes,
   * bypassing CA-based validation. Useful for self-signed deployments where
   * distributing a CA bundle is impractical.
   *
   * ```ts no_run
   * import { joinCluster } from 'fino:cluster';
   *
   * const certSha256 = new Uint8Array(32); // SHA-256 digest of the seed certificate
   * await joinCluster({
   *   seed: 'https://127.0.0.1:9999/__fino_cluster',
   *   serverCertificateHashes: [{ algorithm: 'sha-256', value: certSha256 }],
   * });
   * ```
   */
  serverCertificateHashes?: readonly WebTransportHash[];
}
/**
 * Start the cluster seed server and participate as a worker on this node.
 *
 * The seed is the current routing hub: it routes SPAWN requests, tracks realm
 * ownership, propagates deaths, and forwards PORT_MSG frames to the node that
 * owns the destination port. Direct peer-to-peer delivery is deferred.
 *
 * This call returns immediately after the seed starts listening. The event
 * loop keeps the server alive as long as there are connected peers.
 *
 * Throws if this process is already connected to a cluster. The function
 * resolves with `void` after the seed transport is listening and the local
 * worker client has connected to it.
 *
 * ```ts no_run
 * import { startCluster, leaveCluster } from 'fino:cluster';
 *
 * await startCluster({ port: 9999, nodeId: 'seed-a' });
 * leaveCluster();
 * ```
 */
export async function startCluster(opts: StartClusterOptions): Promise<void> {
  if (_client !== null) {
    throw new Error('fino:cluster — already connected to a cluster');
  }
  const nodeId = opts.nodeId ?? `seed-${opts.port}`;
  const path = normalizeClusterPath(opts.path);
  const seedTransport = new WebTransportSeedTransport(nodeId, {
    port: opts.port,
    hostname: opts.hostname,
    tls: opts.tls,
    path,
    h3: opts.h3 ?? true,
  });
  const clusterId = opts.clusterId ?? `c-${randomHandle(8)}`;
  const joinToken = opts.joinToken;
  const certHash = await certificateSha256Hex(opts.tls.cert);
  if (opts.acceptWorkloads === false) _draining = true;
  const incarnation = await nextIncarnation(opts.stateDir);
  const advertisedHost = clusterAdvertisedHost(opts.hostname);
  const advertisedEndpoint = `https://${advertisedHost}:${opts.port}${path}`;
  // With durable state configured, every routed spawn is committed to the
  // workload ledger before it is forwarded — commit-before-acknowledge.
  _ledger = opts.stateDir !== undefined ? await WorkloadLedger.open(`${opts.stateDir}/ledger.db`) : null;
  _seed = new SeedServer(seedTransport, {
    ...(joinToken !== undefined ? { joinToken } : {}),
    clusterId,
    ...(_ledger !== null ? { ledger: _ledger } : {}),
    ...(opts.stateDir !== undefined ? { caskDir: `${opts.stateDir}/casks` } : {}),
  });
  _seedCaskDir = opts.stateDir !== undefined ? `${opts.stateDir}/casks` : null;
  await _seed.start();
  // Also join as a worker (connect to self) - seeds participate as workers.
  // The self-join pins the seed's own certificate hash rather than disabling
  // verification, and advertises the externally dialable endpoint so peers
  // can be introduced to the seed's listener directly.
  const workerTransport = new WebTransportWorkerTransport(nodeId);
  const selfJoinHost = clusterSelfJoinHost(opts.hostname);
  await workerTransport.connect(
    `https://${selfJoinHost}:${opts.port}${path}`,
    { ...sampleNodeLoad(), ...(_draining ? { draining: true } : {}), ...clusterCapacity() },
    {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: hexToBytes(certHash) }],
      ...(joinToken !== undefined ? { token: joinToken } : {}),
      incarnation,
      endpoint: advertisedEndpoint,
      certHash,
    },
  );
  _mesh = new PeerMesh({
    nodeId,
    clusterId,
    ...(joinToken !== undefined ? { token: joinToken } : {}),
    incarnation,
  });
  _client = new ClusterClient(workerTransport, nodeId, {
    loadSampler: startNodeAgent(),
    incarnation,
    mesh: _mesh,
    admission: defaultAdmission,
  });
  _stopBalance = wireSystemRealmBalancer(_client);
  _stopCaskGc = startCaskGc(_client);
  _client.start();
  await _client.ready();
  _joinString = mintJoinString({
    seed: advertisedEndpoint,
    clusterId,
    ...(joinToken !== undefined ? { token: joinToken } : {}),
    certHashes: [certHash],
  });
}

/**
 * The join string minted by `startCluster()`, or null when this node is not
 * the seed.
 *
 * The string embeds the seed endpoint, cluster identity, join token, and the
 * seed certificate's sha-256 hash — everything `joinCluster({ joinString })`
 * needs to enroll with pinned TLS identity. It contains a secret: hand it to
 * operators, never publish it through discovery.
 *
 * ```ts no_run
 * import { startCluster, clusterJoinString } from 'fino:cluster';
 *
 * await startCluster({ port: 9999, tls: { cert: './cert.pem', key: './key.pem' } });
 * console.log(clusterJoinString());
 * ```
 */
export function clusterJoinString(): string | null {
  return _joinString;
}
/**
 * Connect to an existing seed and register this node as a worker.
 *
 * After this call the node accepts remote realm spawns and can spawn realms
 * onto other nodes in the cluster.
 *
 * Throws if this process is already connected or if the seed URL cannot be
 * reached, and throws a `TypeError` when the seed URL does not use the
 * `https:` scheme. The returned promise resolves once the worker transport
 * is connected and the client loop has started.
 *
 * ```ts no_run
 * import { joinCluster, leaveCluster } from 'fino:cluster';
 *
 * await joinCluster({ seed: 'https://127.0.0.1:9999/__fino_cluster', nodeId: 'worker-a' });
 * leaveCluster();
 * ```
 */
export async function joinCluster(opts: JoinClusterOptions): Promise<void> {
  if (_client !== null) {
    throw new Error('fino:cluster — already connected to a cluster');
  }
  if (opts.acceptWorkloads === false) _draining = true;
  const nodeId = opts.nodeId ?? `worker-${Math.random().toString(36).slice(2, 9)}`;
  const joinInfo = opts.joinString !== undefined ? parseJoinString(opts.joinString) : null;
  if (joinInfo === null && opts.seed === undefined) {
    throw new TypeError('fino:cluster — joinCluster requires seed or joinString');
  }
  const seed = normalizeClusterSeed(joinInfo?.seed ?? opts.seed!);
  const pinnedHashes: WebTransportHash[] | undefined =
    joinInfo !== null && joinInfo.certHashes.length > 0
      ? joinInfo.certHashes.map((hex) => ({ algorithm: 'sha-256', value: hexToBytes(hex) }))
      : undefined;
  const incarnation = await nextIncarnation(opts.stateDir);
  const listener = resolvePeerListener(nodeId, opts.peerListener);
  const peerCertHash =
    listener !== null ? await certificateSha256Hex(listener.tls.cert) : undefined;
  const peerPath = normalizeClusterPath(listener?.path);
  const token = opts.token ?? joinInfo?.token;
  _mesh = new PeerMesh({
    nodeId,
    clusterId: joinInfo?.clusterId ?? null,
    ...(token !== undefined ? { token } : {}),
    incarnation,
    ...(listener !== null
      ? {
          listen: {
            port: listener.port,
            hostname: listener.hostname,
            path: peerPath,
            tls: listener.tls,
          },
        }
      : {}),
  });
  // Listen before announcing: an ephemeral port is not knowable until the
  // listener is up, and advertising an endpoint nobody can dial is worse than
  // advertising none at all.
  if (listener !== null) {
    try {
      await _mesh.listen();
    } catch (err) {
      if (opts.peerListener !== undefined) throw err;
      // The default listener is a bandwidth optimisation, not a requirement,
      // so a bound port or a missing QUIC stack must not stop the node from
      // joining. It is still loud: silently relaying everything through the
      // seed is the bottleneck this exists to remove.
      console.error(
        `fino:cluster — peer listener failed to start, falling back to seed relay: ${err}`,
      );
      _mesh.close();
      _mesh = new PeerMesh({
        nodeId,
        clusterId: joinInfo?.clusterId ?? null,
        ...(token !== undefined ? { token } : {}),
        incarnation,
      });
    }
  }
  const boundPort = _mesh.port;
  const peerEndpoint =
    boundPort !== null
      ? `https://${clusterAdvertisedHost(listener!.hostname)}:${boundPort}${peerPath}`
      : undefined;
  const transport = new WebTransportWorkerTransport(nodeId);
  const connectOptions: WebTransportWorkerConnectOptions = {
    tls: opts.tls,
    quic: opts.quic,
    serverCertificateHashes: opts.serverCertificateHashes ?? pinnedHashes,
    ...(joinInfo !== null && joinInfo.token !== undefined ? { token: joinInfo.token } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    incarnation,
    ...(peerEndpoint !== undefined ? { endpoint: peerEndpoint } : {}),
    ...(peerEndpoint !== undefined && peerCertHash !== undefined
      ? { certHash: peerCertHash }
      : {}),
  };
  await transport.connect(
    seed,
    { ...sampleNodeLoad(), ...(_draining ? { draining: true } : {}), ...clusterCapacity() },
    connectOptions,
  );
  _client = new ClusterClient(transport, nodeId, {
    loadSampler: startNodeAgent(),
    incarnation,
    mesh: _mesh,
    admission: defaultAdmission,
  });
  _stopBalance = wireSystemRealmBalancer(_client);
  _stopCaskGc = startCaskGc(_client);
  _client.start();
  try {
    await _client.ready();
    if (joinInfo !== null && _client.clusterId !== null && _client.clusterId !== joinInfo.clusterId) {
      throw new Error(
        `fino:cluster — joined cluster "${_client.clusterId}" but the join string names "${joinInfo.clusterId}"`,
      );
    }
  } catch (err) {
    const failed = _client;
    _client = null;
    failed.stop();
    void _agent?.stop();
    _agent = null;
    _mesh?.close();
    _mesh = null;
    throw err;
  }
}
function normalizeClusterSeed(seed: string | URL): URL {
  const url = new URL(String(seed));
  if (url.protocol !== 'https:')
    throw new TypeError('WebTransport cluster seeds must use https: URLs');
  if (url.pathname === '/') url.pathname = normalizeClusterPath(undefined);
  return url;
}
function normalizeClusterPath(path: string | undefined): string {
  if (path === undefined || path === '') return DEFAULT_CLUSTER_PATH;
  return path.startsWith('/') ? path : `/${path}`;
}
/**
 * Host embedded in the minted join string. A wildcard or omitted bind cannot
 * be advertised to other machines, so it falls back to loopback — operators
 * running multi-machine clusters should pass an externally reachable
 * `hostname`.
 */
type ResolvedPeerListener = {
  port: number;
  hostname: string | undefined;
  tls: { cert: string; key: string };
  path: string | undefined;
};
/**
 * Decide whether this node listens for direct peer sessions, and on what.
 *
 * Returns `null` when the node should stay seed-relayed: either it asked to,
 * or the host has no QUIC/HTTP3 stack to listen with. Otherwise it fills in
 * the defaults — an ephemeral port and a freshly minted certificate whose key
 * exists only in this process's memory.
 */
function resolvePeerListener(
  nodeId: string,
  option: JoinClusterOptions['peerListener'],
): ResolvedPeerListener | null {
  if (option === false) return null;
  const config = option ?? {};
  if (!quicAvailable || !h3Available) {
    if (option !== undefined) {
      throw new Error(
        'fino:cluster — peerListener requires QUIC and HTTP/3 (libngtcp2 and libnghttp3)',
      );
    }
    return null;
  }
  return {
    port: config.port ?? 0,
    hostname: config.hostname,
    tls:
      config.tls ??
      mintPeerIdentity(nodeId, clusterAdvertisedHost(config.hostname)),
    path: config.path,
  };
}
/**
 * Mint this node's peer-mesh certificate.
 *
 * Deliberately not persisted. The certificate authenticates a channel, not a
 * node: peers accept it because its hash arrived over the seed's authenticated
 * control plane, and the seed decides membership. Keeping it in memory means a
 * restart cannot present the identity of the incarnation it replaced, and a
 * key that is never written cannot be read off a shared volume or baked into
 * an image.
 */
function mintPeerIdentity(nodeId: string, advertisedHost: string): { cert: string; key: string } {
  const host = advertisedHost.startsWith('[') ? advertisedHost.slice(1, -1) : advertisedHost;
  const isIp = /^[0-9.]+$/.test(host) || host.includes(':');
  const identity = generateSelfSignedCertificate({
    commonName: nodeId,
    subjectAltNames: `DNS:${nodeId},${isIp ? 'IP' : 'DNS'}:${host}`,
    days: 1,
  });
  return { cert: identity.certPem, key: identity.keyPem };
}
function clusterAdvertisedHost(hostname: string | undefined): string {
  return clusterSelfJoinHost(hostname);
}
function clusterSelfJoinHost(hostname: string | undefined): string {
  if (hostname === undefined || hostname === '') return '127.0.0.1';
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  if (host.includes(':')) return `[${host}]`;
  return hostname;
}
/**
 * Return the active cluster client, or null if not connected.
 * Used by `fino:realm` to route `remote: true` realm creation.
 *
 * This is an internal support hook for `fino:realm`; application code usually
 * does not need the client directly. The return value is `null` before
 * `startCluster()` or `joinCluster()` succeeds and after `leaveCluster()` runs.
 *
 * ```ts no_run
 * import { getCluster } from 'fino:cluster';
 *
 * if (getCluster() === null) {
 *   console.log('not connected');
 * }
 * ```
 *
 * @internal
 */
export function getCluster(): ClusterClient | null {
  return _client;
}
/**
 * Disconnect from the cluster. Active remote realms are not terminated.
 *
 * The call is synchronous and idempotent. It stops the active worker client and
 * seed server, if present, then clears module-level cluster state. Remote
 * realm users should terminate or await their realms separately.
 *
 * ```ts no_run
 * import { startCluster, leaveCluster } from 'fino:cluster';
 *
 * await startCluster({ port: 9999 });
 * leaveCluster();
 * ```
 */
export function leaveCluster(): void {
  _joinString = null;
  void _agent?.stop();
  _agent = null;
  _mesh?.close();
  _mesh = null;
  _stopBalance?.();
  _stopBalance = null;
  _stopCaskGc?.();
  _stopCaskGc = null;
  _seedCaskDir = null;
  _draining = false;
  void _ledger?.close().catch(() => {});
  _ledger = null;
  _client?.stop();
  _client = null;
  _seed?.stop();
  _seed = null;
}
