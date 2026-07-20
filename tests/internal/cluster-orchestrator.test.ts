/** Cluster orchestration over the ClusterNode contract. */
import { describe, it } from 'fino:test/test';
import { ClusterOrchestrator, type ClusterNode } from 'internal:orchestrator/cluster-orchestrator';
import { NodeOrchestrator } from 'internal:orchestrator/node-orchestrator';
import { mergeChildRules } from 'internal:realm-native';
import { ThreadPort } from 'internal:realm/transport-port';

const worker = new URL('../realm/fixtures/scaling-fn.ts', import.meta.url).pathname;
const rules = mergeChildRules('[]') as string;

function call(port: ThreadPort, correlationId: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const handler = (event: Event) => {
      const message = (event as MessageEvent).data as Record<string, unknown>;
      if (message.correlationId !== correlationId) return;
      port.removeEventListener('message', handler);
      if (message.__call_error === true) reject(new Error(String(message.message)));
      else resolve(message.result);
    };
    port.addEventListener('message', handler);
    port.start();
    port.postMessage({ __call: true, correlationId, args: [0] });
  });
}

describe('ClusterOrchestrator over the ClusterNode contract', () => {
  it('flows an asynchronously admitting node end to end', async (t) => {
    // A stand-in for a remote node: the same local substrate answering the
    // contract asynchronously, the way a control-channel RPC peer would.
    let inner!: NodeOrchestrator;
    const cluster = new ClusterOrchestrator((): ClusterNode => {
      inner = new NodeOrchestrator({ reactorCount: 1, capacity: 2 });
      return {
        start: () => inner.start(),
        admissionCapacity: () => inner.admissionCapacity(),
        allocateRealm: async (spec) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return inner.allocateRealm(spec);
        },
        whenReleased: (workloadId) => inner.whenReleased(workloadId),
        revoke: (workloadId, reason) => inner.revoke(workloadId, reason),
        shutdown: () => inner.shutdown()
      };
    });
    const placed = cluster.allocateRealm({ entryPath: worker, rulesJson: rules });
    t.ok(placed instanceof Promise, 'asynchronous admission surfaces as a promise');
    const allocation = await placed!;
    const port = new ThreadPort(allocation.portWakeFd, allocation.portHandle);
    try {
      const result = await call(port, 1);
      t.ok(result !== undefined, 'the asynchronously admitted realm answers calls');
    } finally {
      port.close();
      allocation.revoke('test-cleanup');
      await allocation.released;
      await inner.shutdown();
    }
  });

  it('rejects asynchronous admission that resolves to exhausted capacity', async (t) => {
    const cluster = new ClusterOrchestrator((): ClusterNode => ({
      start: () => {},
      admissionCapacity: () => 0,
      allocateRealm: async () => null,
      whenReleased: () => Promise.resolve('released'),
      revoke: () => {},
      shutdown: () => {}
    }));
    const placed = cluster.allocateRealm({ entryPath: worker, rulesJson: rules });
    t.ok(placed instanceof Promise, 'the capacity answer is asynchronous');
    await t.rejects(async () => { await placed; }, /capacity is exhausted/, 'promise-of-null becomes a capacity rejection');
  });
});
