/**
 * internal:cluster/balance-loop — drives the tail-shedding balancer on a node.
 *
 * This is the host layer: it binds the pure `QueueBalancer` policy to the
 * real workload queue natives and to the cluster client's shed-offer path,
 * and runs a pass on a timer. Peer pressure comes from the membership view
 * the client already maintains — no new replication channel is needed,
 * because `pendingSpecs` rides the heartbeats every node sends anyway.
 *
 * The loop runs alongside the cluster client today and moves into the system
 * realm with it; the policy underneath does not change when that happens.
 *
 * @internal
 */
import {
  clearSheddingWorkload,
  markSheddingWorkload,
  reactorQueueDepth,
  resubmitShedWorkload,
  shedWorkloadConfig,
  takeShedWorkload,
} from 'internal:scheduler-native';
import { QueueBalancer, type PeerPressure, type ShedQueue } from './balancer.ts';
import type { PeerInfo } from './protocol.ts';
import { env } from 'internal:process';

/** What the loop needs from the cluster client. */
export interface BalanceClient {
  nodeId: string;
  peers: PeerInfo[];
  offerShed(
    toNodeId: string,
    shedHandle: number,
    workloadId: number,
  ): Promise<{ accepted: boolean; reason?: string }>;
}

export interface BalanceLoopOptions {
  /** Milliseconds between passes; `FINO_CLUSTER_BALANCE_INTERVAL_MS` or 5000. */
  intervalMs?: number;
  /** Queue override for tests; defaults to the process pool natives. */
  queue?: ShedQueue;
  /** Peer sampler override for tests. */
  samplePeers?: (candidates: PeerPressure[]) => PeerPressure | null;
}

function intervalMs(): number {
  const configured = Number(env.FINO_CLUSTER_BALANCE_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 5000;
}

function envCount(name: string, fallback: number): number {
  const configured = Number(env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/**
 * The process-pool queue, adapted to the balancer's port.
 *
 * `drop` is deliberately a no-op: after a peer accepts, the shed handle stays
 * alive as the parent-port proxy for the workload's remote lifetime, so
 * releasing it here would sever the port mid-migration.
 */
function poolQueue(): ShedQueue {
  return {
    depth: () => reactorQueueDepth(),
    markLowest: () => markSheddingWorkload(),
    take: (owner) => takeShedWorkload(undefined, owner),
    clear: (owner) => clearSheddingWorkload(undefined, owner),
    resubmit: (handle) => resubmitShedWorkload(undefined, handle),
    config: (handle) => shedWorkloadConfig(handle),
    drop() {},
  };
}

/** Track owner -> shed handle across take, so the offer can find its handle. */
function trackHandles(base: ShedQueue, handles: Map<number, number>): ShedQueue {
  return {
    ...base,
    take(owner) {
      const handle = base.take(owner);
      if (handle !== null) handles.set(owner, handle);
      return handle;
    },
  };
}

/**
 * Start balancing this node's queue against the cluster. Returns a stop
 * function. Passes never overlap: a slow offer defers the next pass rather
 * than stacking a second one on top.
 */
export function startBalanceLoop(client: BalanceClient, options: BalanceLoopOptions = {}): () => void {
  const handles = new Map<number, number>();
  const queue = trackHandles(options.queue ?? poolQueue(), handles);
  const balancer = new QueueBalancer(
    queue,
    {
      offer(nodeId, _spec, workloadId) {
        const handle = handles.get(workloadId);
        if (handle === undefined) {
          return Promise.resolve({ accepted: false, reason: 'no shed handle for workload' });
        }
        return client.offerShed(nodeId, handle, workloadId);
      },
    },
    {
      highWatermark: envCount('FINO_CLUSTER_SHED_WATERMARK', 2),
      minDelta: envCount('FINO_CLUSTER_SHED_MIN_DELTA', 2),
      ...(options.samplePeers === undefined ? {} : { samplePeers: options.samplePeers }),
    },
  );

  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const peers: PeerPressure[] = client.peers
        .filter((peer) => peer.nodeId !== client.nodeId)
        .map((peer) => ({ nodeId: peer.nodeId, pendingSpecs: peer.load.pendingSpecs ?? 0 }));
      await balancer.balance(peers);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void pass(), options.intervalMs ?? intervalMs());
  return () => clearInterval(timer);
}
