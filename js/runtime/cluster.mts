/**
 * fino:cluster — public API for cluster participation.
 *
 * A node joins the cluster in one of two roles:
 *
 * `startCluster({ port })` — Start a seed server on the given port AND
 *   participate as a worker. The calling node becomes both the coordinator
 *   and an execution target. This is the entry point for the first node.
 *
 * `joinCluster({ seed })` — Connect to an existing seed node. The calling
 *   node becomes a worker: it accepts realm spawns and hosts them locally.
 *   It can also spawn remote realms onto other workers.
 *
 * After either call, `new Realm({ ..., remote: true })` routes through the
 * active cluster client to spawn onto a remote worker.
 *
 * Only one cluster connection per process is supported. Calling either
 * function when already connected throws.
 */

import { WebSocketSeedTransport, WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
import { SeedServer } from 'internal:cluster/seed';
import { ClusterClient, ClusterPort } from 'internal:cluster/client';

// Re-export ClusterPort as a public type so fino:realm can import it from
// fino:cluster rather than reaching into internal:cluster/client directly.
export { ClusterPort };

// ---------------------------------------------------------------------------
// Module-level active cluster state
// ---------------------------------------------------------------------------

let _client: ClusterClient | null = null;
let _seed:   SeedServer    | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartClusterOptions {
  /** TCP port the seed WebSocket server will listen on. */
  port: number;
  /** Node identifier. Defaults to `seed-{port}`. */
  nodeId?: string;
}

export interface JoinClusterOptions {
  /** WebSocket URL of the seed node, e.g. `ws://host:9999`. */
  seed: string;
  /** Node identifier. Defaults to a random string. */
  nodeId?: string;
}

/**
 * Start the cluster seed server and participate as a worker on this node.
 *
 * The seed is the control-plane hub: it routes SPAWN requests, tracks realm
 * ownership, and propagates deaths. It does NOT relay data-plane messages in
 * steady state.
 *
 * This call returns immediately after the seed starts listening. The event
 * loop keeps the server alive as long as there are connected peers.
 */
export async function startCluster(opts: StartClusterOptions): Promise<void> {
  if (_client !== null) {
    throw new Error('fino:cluster — already connected to a cluster');
  }

  const nodeId = opts.nodeId ?? `seed-${opts.port}`;
  const seedTransport = new WebSocketSeedTransport(nodeId, opts.port);
  _seed = new SeedServer(seedTransport);
  _seed.start();

  // Also join as a worker (connect to self) — seeds participate as workers.
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
 * @internal
 */
export function getCluster(): ClusterClient | null {
  return _client;
}

/**
 * Disconnect from the cluster. Active remote realms are not terminated.
 */
export function leaveCluster(): void {
  _client?.stop();
  _client = null;
  _seed?.stop();
  _seed = null;
}
