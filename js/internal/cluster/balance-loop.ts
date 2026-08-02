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
  dropShedWorkload,
  markSheddingWorkload,
  reactorQueueDepth,
  resubmitShedWorkload,
  shedComplete,
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
 *
 * @internal
 */
export function poolQueue(): ShedQueue {
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

/** Track owner -> shed handle across take, so offers can find handles. @internal */
export function trackHandles(base: ShedQueue, handles: Map<number, number>): ShedQueue {
  return {
    ...base,
    take(owner) {
      const handle = base.take(owner);
      if (handle !== null) handles.set(owner, handle);
      return handle;
    },
  };
}

/** A queue that can also forcibly fail a taken spec — the drain deadline path. */
export interface DrainQueue extends ShedQueue {
  /** Settle the spec's parent with an error and release the spec. */
  fail(handle: number, reason: string): void;
}

/** What happened during a drain. */
export interface DrainReport {
  /** Specs successfully handed to peers. */
  shed: number;
  /** Specs forcibly failed at the deadline, each reported to its parent. */
  failed: number;
  /** Queue state at the end: live workloads a drain cannot move. */
  remaining: { pendingSpecs: number; parkedLive: number; active: number };
}

function poolDrainQueue(): DrainQueue {
  return {
    ...poolQueue(),
    fail(handle, reason) {
      shedComplete(handle, reason);
      dropShedWorkload(handle);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shed everything pre-init to peers, then forcibly fail what nobody took.
 *
 * This is the shed-everything degenerate case of balancing: watermarks are
 * ignored and every peer with any headroom is a candidate. Passes repeat
 * until the queue holds no pre-init specs or the deadline passes; at the
 * deadline, each remaining spec's parent gets an explicit error instead of a
 * silent disappearance. Live workloads are reported, not touched — they are
 * pinned to this node by design and exit with the process.
 */
export async function drainQueue(
  client: BalanceClient,
  options: {
    deadlineMs?: number;
    queue?: DrainQueue;
    samplePeers?: (candidates: PeerPressure[]) => PeerPressure | null;
  } = {},
): Promise<DrainReport> {
  const handles = new Map<number, number>();
  const base = options.queue ?? poolDrainQueue();
  const queue = trackHandles(base, handles);
  const deadline = Date.now() + (options.deadlineMs ?? envCount('FINO_CLUSTER_DRAIN_DEADLINE_MS', 30_000));
  const transport = {
    offer(nodeId: string, _spec: unknown, workloadId: number) {
      const handle = handles.get(workloadId);
      if (handle === undefined) {
        return Promise.resolve({ accepted: false, reason: 'no shed handle for workload' });
      }
      return client.offerShed(nodeId, handle, workloadId);
    },
  };
  let shed = 0;
  while (Date.now() < deadline && queue.depth().pendingSpecs > 0) {
    // A fresh balancer per pass keeps the batch bounded by the current queue
    // depth, so a wall of refusals cannot spin the pass forever.
    const balancer = new QueueBalancer(queue, transport, {
      highWatermark: 0,
      minDelta: Number.NEGATIVE_INFINITY,
      batch: queue.depth().pendingSpecs,
      ...(options.samplePeers === undefined ? {} : { samplePeers: options.samplePeers }),
    });
    const outcome = await balancer.balance(eligiblePeers(client));
    shed += outcome.shed;
    if (queue.depth().pendingSpecs === 0) break;
    if (outcome.shed === 0) {
      // Nobody is taking right now; back off briefly within the deadline.
      const wait = Math.min(200, deadline - Date.now());
      if (wait <= 0) break;
      await sleep(wait);
    }
  }
  let failed = 0;
  for (;;) {
    const owner = queue.markLowest();
    if (owner === 0) break;
    const handle = queue.take(owner);
    if (handle === null) continue;
    base.fail(handle, 'node drained: no peer accepted the workload before the deadline');
    failed++;
  }
  return { shed, failed, remaining: queue.depth() };
}

/** Peers this node may offer work to: everyone but itself and the draining. @internal */
export function eligiblePeers(client: BalanceClient): PeerPressure[] {
  return client.peers
    .filter((peer) => peer.nodeId !== client.nodeId && peer.load.draining !== true)
    .map((peer) => ({ nodeId: peer.nodeId, pendingSpecs: peer.load.pendingSpecs ?? 0 }));
}

/**
 * Start balancing this node's queue against the cluster. Returns a stop
 * function. Passes never overlap: a slow offer defers the next pass rather
 * than stacking a second one on top.
 *
 * Production hosts this decision loop inside the system realm
 * (`internal:cluster/system-realm`); this in-realm variant remains for tests
 * and for embedders running without a system realm.
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
      const peers: PeerPressure[] = eligiblePeers(client);
      await balancer.balance(peers);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void pass(), options.intervalMs ?? intervalMs());
  return () => clearInterval(timer);
}
