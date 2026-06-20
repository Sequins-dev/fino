/**
 * fino:cluster - public API for cluster participation.
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
 * Current release scope uses the WebSocket transport with one trusted seed
 * node. Seed election and cluster authentication are not implemented in this
 * release. Direct peer-to-peer `PORT_MSG` delivery and QUIC transport remain
 * deferred; control-plane and data-plane messages continue to route through
 * the seed-backed WebSocket cluster.
 *
 * @example
 * ```ts no_run
 * import { startCluster, leaveCluster } from 'fino:cluster';
 * import { Realm } from 'fino:realm';
 *
 * await startCluster({ port: 9999, nodeId: 'seed-a' });
 * const realm = new Realm({ entry: './worker.mts', remote: true });
 * await realm.call('healthcheck');
 * leaveCluster();
 * ```
 */

import { WebSocketSeedTransport, WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
import { SeedServer } from 'internal:cluster/seed';
import { ClusterClient, ClusterPort } from 'internal:cluster/client';

// Internal support export for fino:realm. Application code should use
// startCluster(), joinCluster(), leaveCluster(), and Realm({ remote: true }).
export { ClusterPort };

// ---------------------------------------------------------------------------
// Module-level active cluster state
// ---------------------------------------------------------------------------

let _client: ClusterClient | null = null;
let _seed:   SeedServer    | null = null;

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
   * TCP port the seed WebSocket server will listen on.
   *
   * The port must be available on the local host. There is no default because
   * the first cluster node must advertise a stable address to workers.
   *
   * ```ts no_run
   * import { startCluster } from 'fino:cluster';
   *
   * await startCluster({ port: 9999 });
   * ```
   */
  port: number;
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
}

/**
 * Options for joining an existing cluster seed.
 *
 * ```ts no_run
 * import { joinCluster, type JoinClusterOptions } from 'fino:cluster';
 *
 * const opts: JoinClusterOptions = { seed: 'ws://127.0.0.1:9999' };
 * await joinCluster(opts);
 * ```
 */
export interface JoinClusterOptions {
  /**
   * WebSocket URL of the seed node.
   *
   * The URL must include the `ws://` scheme and a reachable host and port. The
   * call fails if the connection cannot be established.
   *
   * ```ts no_run
   * import { joinCluster } from 'fino:cluster';
   *
   * await joinCluster({ seed: 'ws://seed.example.test:9999' });
   * ```
   */
  seed: string;
  /**
   * Optional worker node identifier.
   *
   * When omitted, a short random `worker-*` ID is generated. Provide a stable
   * value for predictable logs or cluster placement diagnostics.
   *
   * ```ts no_run
   * import { joinCluster } from 'fino:cluster';
   *
   * await joinCluster({ seed: 'ws://127.0.0.1:9999', nodeId: 'worker-a' });
   * ```
   */
  nodeId?: string;
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
  const seedTransport = new WebSocketSeedTransport(nodeId, opts.port);
  _seed = new SeedServer(seedTransport);
  _seed.start();

  // Also join as a worker (connect to self) - seeds participate as workers.
  const workerTransport = new WebSocketWorkerTransport(nodeId);
  await workerTransport.connect(`ws://127.0.0.1:${opts.port}`);
  _client = new ClusterClient(workerTransport, nodeId);
  _client.start();
}

/**
 * Connect to an existing seed and register this node as a worker.
 *
 * After this call the node accepts remote realm spawns and can spawn realms
 * onto other nodes in the cluster.
 *
 * Throws if this process is already connected or if the seed URL cannot be
 * reached. The returned promise resolves once the worker transport is
 * connected and the client loop has started.
 *
 * ```ts no_run
 * import { joinCluster, leaveCluster } from 'fino:cluster';
 *
 * await joinCluster({ seed: 'ws://127.0.0.1:9999', nodeId: 'worker-a' });
 * leaveCluster();
 * ```
 */
export async function joinCluster(opts: JoinClusterOptions): Promise<void> {
  if (_client !== null) {
    throw new Error('fino:cluster — already connected to a cluster');
  }

  const nodeId = opts.nodeId ?? `worker-${Math.random().toString(36).slice(2, 9)}`;
  const transport = new WebSocketWorkerTransport(nodeId);
  await transport.connect(opts.seed);
  _client = new ClusterClient(transport, nodeId);
  _client.start();
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
  _client?.stop();
  _client = null;
  _seed?.stop();
  _seed = null;
}
