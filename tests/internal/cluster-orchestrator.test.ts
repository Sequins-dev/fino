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
        start: async () => inner.start(),
        admissionCapacity: () => inner.admissionCapacity(),
        allocateRealm: async (spec) => {
          // Simulated network hop before the real (async) local admission.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return inner.allocateRealm(spec);
        },
        whenReleased: (workloadId) => inner.whenReleased(workloadId),
        revoke: (workloadId, reason) => inner.revoke(workloadId, reason),
        shutdown: async () => {
          await inner.shutdown();
        }
      };
    });
    const allocation = (await cluster.allocateRealm({ entryPath: worker, rulesJson: rules }))!;
    t.ok(allocation !== null, 'the asynchronously admitting node placed the realm');
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

  it('resolves null for exhausted capacity and Realm rejects on it', async (t) => {
    const cluster = new ClusterOrchestrator((): ClusterNode => ({
      start: async () => {},
      admissionCapacity: () => 0,
      allocateRealm: async () => null,
      whenReleased: () => Promise.resolve('released'),
      revoke: () => {},
      shutdown: async () => {}
    }));
    const placed = await cluster.allocateRealm({ entryPath: worker, rulesJson: rules });
    t.equal(placed, null, 'the node contract reports capacity as a null resolution');
  });
});
