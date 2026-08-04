/**
 * internal:cluster/system-realm — the per-node system realm's entry module.
 *
 * Runs as a reactor workload in the scheduler's system priority class: it
 * outranks app realms whenever it has readiness signals and costs nothing
 * when idle. This realm is the node's cluster agent — it owns the periodic
 * work no app realm should be trusted with, starting with queue and load
 * observation; the cross-node balancer (tail-shedding) and drain execution
 * land here next.
 *
 * Reports flow upward over the realm port — children signal parents, parents
 * never observe children externally. Each report carries the node-load
 * sample, the queue-depth snapshot, and the per-workload load deltas drained
 * from the reactor pool.
 *
 * @internal
 */
import { port } from 'fino:realm/self';
import { reactorQueueDepth, takeReactorLoadSample } from 'internal:scheduler-native';
import { sampleNodeLoad } from 'internal:runtime/stats';
import { env } from 'internal:process';
import { QueueBalancer, type PeerPressure } from './balancer.ts';
import { poolQueue, trackHandles } from './balance-loop.ts';

const DEFAULT_INTERVAL_MS = 2500;

function intervalMs(): number {
  const configured = Number(env.FINO_SYSTEM_REALM_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;
}

let running = true;
/** Latest replicated peer-pressure view, pushed down by the cluster client. */
let peers: PeerPressure[] = [];
/** Offers awaiting a __shed_result from the parent, keyed by offer id. */
const pendingOffers = new Map<
  number,
  { resolve: (result: { accepted: boolean; reason?: string }) => void; timer: unknown }
>();
let offerSeq = 0;

const handles = new Map<number, number>();
const queue = trackHandles(poolQueue(), handles);
const balancer = new QueueBalancer(
  queue,
  {
    // The system realm decides; the main realm executes. Shed handles live
    // in a process-global store, so the handle taken here is directly usable
    // by the cluster client's offerShed on the other side of the port.
    offer(toNodeId, _spec, workloadId) {
      const handle = handles.get(workloadId);
      if (handle === undefined) {
        return Promise.resolve({ accepted: false, reason: 'no shed handle for workload' });
      }
      const id = ++offerSeq;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingOffers.delete(id);
          resolve({ accepted: false, reason: 'offer relay timed out' });
        }, 10_000);
        pendingOffers.set(id, { resolve, timer });
        port.postMessage({ __shed_offer: { id, toNodeId, shedHandle: handle, workloadId } });
      });
    },
  },
  {
    highWatermark: envCount('FINO_CLUSTER_SHED_WATERMARK', 2),
    minDelta: envCount('FINO_CLUSTER_SHED_MIN_DELTA', 2),
  },
);

function envCount(name: string, fallback: number): number {
  const configured = Number(env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

port.onmessage = (event) => {
  const data = (event as MessageEvent).data as {
    __system_stop?: boolean;
    __terminate?: boolean;
    __peers?: PeerPressure[];
    __shed_result?: { id: number; accepted: boolean; reason?: string };
  } | null;
  if (data === null || typeof data !== 'object') return;
  // Stop re-arming the sampling timer on either signal: the child loop only
  // exits once the realm is done AND has no live handles, so an interval
  // that keeps re-arming would pin the realm alive through terminate().
  if (data.__system_stop === true || data.__terminate === true) {
    running = false;
    for (const pending of pendingOffers.values()) {
      clearTimeout(pending.timer as number);
      pending.resolve({ accepted: false, reason: 'system realm stopping' });
    }
    pendingOffers.clear();
    return;
  }
  if (Array.isArray(data.__peers)) {
    peers = data.__peers;
    return;
  }
  if (data.__shed_result !== undefined) {
    const pending = pendingOffers.get(data.__shed_result.id);
    if (pending !== undefined) {
      pendingOffers.delete(data.__shed_result.id);
      clearTimeout(pending.timer as number);
      pending.resolve({
        accepted: data.__shed_result.accepted,
        ...(data.__shed_result.reason === undefined ? {} : { reason: data.__shed_result.reason }),
      });
    }
  }
};
port.start();

function balanceEveryMs(): number {
  const configured = Number(env.FINO_CLUSTER_BALANCE_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 5000;
}

let balancing = false;
let lastBalance = 0;
while (running) {
  port.postMessage({
    __system_report: {
      at: Date.now(),
      load: sampleNodeLoad(),
      queue: reactorQueueDepth(),
      workloads: takeReactorLoadSample(),
    },
  });
  if (env.FINO_BALANCE_TRACE === '1') {
    console.error(
      `fino:balance trace peers=${JSON.stringify(peers)} pending=${reactorQueueDepth().pendingSpecs} balancing=${balancing}`,
    );
  }
  if (!balancing && peers.length > 0 && Date.now() - lastBalance >= balanceEveryMs()) {
    lastBalance = Date.now();
    balancing = true;
    // Deliberately not awaited: a slow offer must not stall reporting, and
    // the guard keeps passes from overlapping.
    void balancer
      .balance(peers)
      .then((outcome) => {
        if (env.FINO_BALANCE_TRACE === '1') {
          console.error(`fino:balance outcome ${JSON.stringify(outcome)}`);
        }
      })
      .catch((err: unknown) => {
        if (env.FINO_BALANCE_TRACE === '1') console.error(`fino:balance threw ${err}`);
      })
      .finally(() => {
        balancing = false;
      });
  }
  await new Promise<void>((resolve) => setTimeout(resolve, intervalMs()));
}
