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
 * function while connected or while a previous connection is closing throws.
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
 * await leaveCluster();
 * ```
 */
import {
  DEFAULT_CLUSTER_PATH,
  WebTransportSeedTransport,
  WebTransportWorkerTransport,
  type WebTransportWorkerConnectOptions,
} from 'internal:cluster/webtransport-transport';
import { SeedServer } from 'internal:cluster/seed';
import { ClusterClient, ClusterPort } from 'internal:cluster/client';
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
let _closing: Promise<void> | null = null;
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
   * HTTPS WebTransport URL of the seed node.
   *
   * The URL must include the `https://` scheme and a reachable host and port.
   * When the path is omitted, `/__fino_cluster` is used.
   *
   * ```ts no_run
   * import { joinCluster } from 'fino:cluster';
   *
   * await joinCluster({ seed: 'https://seed.example.test:9999/__fino_cluster' });
   * ```
   */
  seed: string | URL;
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
 * await leaveCluster();
 * ```
 */
export async function startCluster(opts: StartClusterOptions): Promise<void> {
  if (_client !== null || _seed !== null || _closing !== null) {
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
  _seed = new SeedServer(seedTransport);
  try {
    await _seed.start();
    // Also join as a worker (connect to self) - seeds participate as workers.
    const workerTransport = new WebTransportWorkerTransport(nodeId);
    const selfJoinHost = clusterSelfJoinHost(opts.hostname);
    await workerTransport.connect(
      `https://${selfJoinHost}:${opts.port}${path}`,
      {
        cpu: 0,
        memory: 0,
      },
      { tls: { rejectUnauthorized: false } },
    );
    _client = new ClusterClient(workerTransport, nodeId);
    _client.start();
  } catch (error) {
    await leaveCluster();
    throw error;
  }
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
 * await leaveCluster();
 * ```
 */
export async function joinCluster(opts: JoinClusterOptions): Promise<void> {
  if (_client !== null || _seed !== null || _closing !== null) {
    throw new Error('fino:cluster — already connected to a cluster');
  }
  const nodeId = opts.nodeId ?? `worker-${Math.random().toString(36).slice(2, 9)}`;
  const seed = normalizeClusterSeed(opts.seed);
  const transport = new WebTransportWorkerTransport(nodeId);
  const connectOptions: WebTransportWorkerConnectOptions = {
    tls: opts.tls,
    quic: opts.quic,
    serverCertificateHashes: opts.serverCertificateHashes,
  };
  await transport.connect(
    seed,
    {
      cpu: 0,
      memory: 0,
    },
    connectOptions,
  );
  _client = new ClusterClient(transport, nodeId);
  _client.start();
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
 * The call is asynchronous and idempotent. It makes the active cluster
 * unavailable immediately, then resolves after the worker client, seed server,
 * WebTransport streams, and underlying HTTP/3/QUIC resources have closed.
 * Concurrent calls share the same shutdown. Remote realm users should
 * terminate or await their realms separately. The promise rejects if an
 * underlying transport cannot complete its cleanup.
 *
 * ```ts no_run
 * import { startCluster, leaveCluster } from 'fino:cluster';
 *
 * await startCluster({ port: 9999 });
 * await leaveCluster();
 * ```
 */
export function leaveCluster(): Promise<void> {
  if (_closing !== null) return _closing;
  const client = _client;
  const seed = _seed;
  _client = null;
  _seed = null;
  if (client === null && seed === null) return Promise.resolve();
  const closing = Promise.all([client?.stop(), seed?.stop()]).then(() => {});
  const tracked = closing.finally(() => {
    if (_closing === tracked) _closing = null;
  });
  _closing = tracked;
  return tracked;
}
