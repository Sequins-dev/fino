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

const DEFAULT_INTERVAL_MS = 2500;

function intervalMs(): number {
  const configured = Number(env.FINO_SYSTEM_REALM_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;
}

let running = true;
port.onmessage = (event) => {
  const data = (event as MessageEvent).data as {
    __system_stop?: boolean;
    __terminate?: boolean;
  } | null;
  // Stop re-arming the sampling timer on either signal: the child loop only
  // exits once the realm is done AND has no live handles, so an interval
  // that keeps re-arming would pin the realm alive through terminate().
  if (data !== null && typeof data === 'object' && (data.__system_stop === true || data.__terminate === true)) {
    running = false;
  }
};
port.start();

while (running) {
  port.postMessage({
    __system_report: {
      at: Date.now(),
      load: sampleNodeLoad(),
      queue: reactorQueueDepth(),
      workloads: takeReactorLoadSample(),
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, intervalMs()));
}
