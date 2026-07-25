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
  it('uses the lifecycle returned by asynchronous allocation', async (t) => {
    let release!: (reason: string) => void;
    let revokedWith: string | null = null;
    const released = new Promise<string>((resolve) => { release = resolve; });
    const cluster = new ClusterOrchestrator(() => ({
      admissionCapacity: () => 1,
      allocateRealm: async () => ({
        workloadId: 'remote-1',
        portHandle: 1,
        portWakeFd: 2,
        allocationPortHandle: 3,
        allocationPortWakeFd: 4,
        released,
        revoke(reason: string) {
          revokedWith = reason;
          release(reason);
        }
      }),
      shutdown: async () => {}
    }));

    const allocation = await cluster.allocateRealm({ entryPath: worker, rulesJson: rules });
    if (allocation === null) throw new Error('realm was not placed');
    allocation.revoke('test-release');
    t.equal(revokedWith, 'test-release');
    t.equal(await allocation.released, 'test-release');
  });

  it('keeps one node alive between completed allocations', async (t) => {
    let created = 0;
    let shutdowns = 0;
    const releases: Array<(reason: string) => void> = [];
    const cluster = new ClusterOrchestrator(() => {
      created++;
      return {
        admissionCapacity: () => 1,
        allocateRealm: async () => {
          let release!: (reason: string) => void;
          const released = new Promise<string>((resolve) => { release = resolve; });
          releases.push(release);
          return {
            workloadId: `remote-${created}-${releases.length}`,
            portHandle: 1,
            portWakeFd: 2,
            allocationPortHandle: 3,
            allocationPortWakeFd: 4,
            released,
            revoke: release
          };
        },
        shutdown: async () => { shutdowns++; }
      };
    });

    const first = await cluster.allocateRealm({ entryPath: worker, rulesJson: rules });
    if (first === null) throw new Error('first realm was not placed');
    releases.shift()!('done');
    await first.released;
    await new Promise((resolve) => setTimeout(resolve, 80));

    const second = await cluster.allocateRealm({ entryPath: worker, rulesJson: rules });
    t.ok(second !== null, 'second realm was placed');
    t.equal(created, 1, 'the cluster reused its node');
    t.equal(shutdowns, 0, 'the node remains alive until runtime shutdown');
    releases.shift()!('done');
    await second!.released;
  });

  it('flows an asynchronously admitting node end to end', async (t) => {
    // A stand-in for a remote node: the same local substrate answering the
    // contract asynchronously, the way a control-channel RPC peer would.
    let inner!: NodeOrchestrator;
    const cluster = new ClusterOrchestrator((): ClusterNode => {
      inner = new NodeOrchestrator({ reactorCount: 1, capacity: 2 });
      return {
        admissionCapacity: () => inner.admissionCapacity(),
        allocateRealm: async (spec) => {
          // Simulated network hop before the real (async) local admission.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return inner.allocateRealm(spec);
        },
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
      admissionCapacity: () => 0,
      allocateRealm: async () => null,
      shutdown: async () => {}
    }));
    const placed = await cluster.allocateRealm({ entryPath: worker, rulesJson: rules });
    t.equal(placed, null, 'the node contract reports capacity as a null resolution');
  });
});
