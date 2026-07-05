/**
* Tests for the internal scheduler shard components.
*/
import { describe, it } from 'fino:test/test';
import { Facade, ImportMap, Realm } from 'fino:realm';
import { DiskFileSystem } from 'fino:file';
import { firstWake, removeWake, selectNextWorkload } from 'internal:scheduler/selection';

type Lease = {
  leaseId: string;
  workloadId: string;
  epoch: number;
  priority: 'interactive' | 'service' | 'background';
  entryPath?: string;
  data?: unknown;
};

type Wake = {
  workloadId: string;
  reason: 'message' | 'facade_completion' | 'timer' | 'io' | 'backpressure' | 'child_event' | 'v8_task' | 'control';
  sourceId: string;
  deadlineNanos?: number | null;
  priorityBoost?: number;
};

type DispatchResult = {
  result: 'idle' | 'runnable' | 'budget_yield' | 'terminated' | 'failed';
  costMicros?: number;
};

type LoadSummary = {
  debtMicros: number;
  dispatches: number;
  heldLeases: number;
  runnableWorkloads: number;
  shardId: string;
};

const schedulerSource = `
  import { runSchedulerShard } from 'internal:scheduler/shard';
  import { DiskFileSystem } from 'fino:file';
  export default async function(config) {
    const summary = await runSchedulerShard(config);
    if (config.ioProofOutput) {
      const fs = new DiskFileSystem();
      await fs.writeFile(config.ioProofOutput, new TextEncoder().encode(JSON.stringify(summary)));
    }
    return summary;
  }
`;

function schedulerRealm(host: Facade, options: { thread?: boolean } = {}): Realm<(config: unknown) => Promise<unknown>> {
  return Realm.fromSource(schedulerSource, {
    ...options.thread === true ? { thread: true } : {},
    overrides: ImportMap.deny([{
      pattern: 'fino:*',
      directive: 'inherit'
    }, {
      pattern: 'internal:*',
      directive: 'inherit'
    }, {
      pattern: 'internal:scheduler/shard',
      directive: 'inherit'
    }, {
      pattern: 'internal:scheduler/selection',
      directive: 'inherit'
    }, {
      pattern: 'internal:scheduler/types',
      directive: 'inherit'
    }, {
      pattern: 'internal:scheduler/isolate',
      directive: 'inherit'
    }, {
      pattern: 'internal:scheduler/facade-ops',
      directive: 'inherit'
    }, {
      pattern: 'internal:scheduler-native',
      directive: 'inherit'
    }, {
      pattern: 'internal:runtime/loop',
      directive: 'inherit'
    }, {
      pattern: 'internal:scheduler/host',
      directive: host
    }])
  });
}

function createHost(options: {
  leases: Lease[];
  wakes: Wake[][];
  results: Record<string, DispatchResult[]>;
  renew?: Record<string, boolean>;
}) {
  const claimed: string[] = [];
  const dispatched: string[] = [];
  const released: Array<{ leaseId: string; reason: string }> = [];
  const load: unknown[] = [];
  let wakePoll = 0;

  const facade = new Facade('internal:scheduler/host', [
    'claimWorkloads',
    'pollWakes',
    'dispatchWorkload',
    'renewLease',
    'releaseLease',
    'recordShardLoad'
  ]);

  facade.handle('claimWorkloads', async (_shardId: unknown, capacity: unknown) => {
    const max = Number(capacity);
    const next = options.leases.slice(0, max);
    for (const lease of next) claimed.push(lease.leaseId);
    return next;
  });
  facade.handle('pollWakes', async () => options.wakes[wakePoll++] ?? []);
  facade.handle('dispatchWorkload', async (leaseId: unknown) => {
    const id = String(leaseId);
    dispatched.push(id);
    return options.results[id]?.shift() ?? { result: 'idle', costMicros: 1 };
  });
  facade.handle('renewLease', async (leaseId: unknown) => options.renew?.[String(leaseId)] ?? true);
  facade.handle('releaseLease', async (leaseId: unknown, reason: unknown) => {
    released.push({ leaseId: String(leaseId), reason: String(reason) });
  });
  facade.handle('recordShardLoad', async (_shardId: unknown, summary: unknown) => {
    load.push(summary);
  });

  return {
    facade,
    claimed,
    dispatched,
    released,
    load
  };
}

describe('scheduler selection', () => {
  it('orders runnable workloads by priority before age', (t) => {
    const selected = selectNextWorkload([{
      workloadId: 'background-old',
      priority: 'background',
      wakes: [{ workloadId: 'background-old', reason: 'message', sourceId: 'm1', sequence: 1 }],
      debtMicros: 0,
      sequence: 1
    }, {
      workloadId: 'interactive-new',
      priority: 'interactive',
      wakes: [{ workloadId: 'interactive-new', reason: 'message', sourceId: 'm2', sequence: 2 }],
      debtMicros: 0,
      sequence: 2
    }]);
    t.equal(selected?.workloadId, 'interactive-new');
  });

  it('penalizes budget debt between equal priority workloads', (t) => {
    const selected = selectNextWorkload([{
      workloadId: 'debt-heavy',
      priority: 'service',
      wakes: [{ workloadId: 'debt-heavy', reason: 'message', sourceId: 'm1', sequence: 1 }],
      debtMicros: 500,
      sequence: 1
    }, {
      workloadId: 'debt-light',
      priority: 'service',
      wakes: [{ workloadId: 'debt-light', reason: 'message', sourceId: 'm2', sequence: 2 }],
      debtMicros: 0,
      sequence: 2
    }]);
    t.equal(selected?.workloadId, 'debt-light');
  });

  it('consumes the dispatched (earliest-deadline) wake, not the queue head', (t) => {
    // wakes[0] has a later deadline than wakes[1]; the scheduler dispatches the
    // earliest-deadline wake, and must consume exactly that one.
    const wakes = [
      { workloadId: 'w', reason: 'io' as const, sourceId: 'io', deadlineNanos: 100, sequence: 1 },
      { workloadId: 'w', reason: 'timer' as const, sourceId: 'timer', deadlineNanos: 10, sequence: 2 }
    ];
    const dispatched = firstWake({ workloadId: 'w', priority: 'service', wakes, debtMicros: 0, sequence: 0 });
    t.equal(dispatched?.sourceId, 'timer', 'earliest-deadline wake is dispatched');
    const remaining = removeWake(wakes, dispatched);
    t.deepEqual(remaining.map((w) => w.sourceId), ['io'], 'the out-of-order io wake survives, the serviced timer wake is gone');
  });

  it('removeWake leaves the queue unchanged when nothing was dispatched', (t) => {
    const wakes = [{ workloadId: 'w', reason: 'message' as const, sourceId: 'm', sequence: 1 }];
    t.equal(removeWake(wakes, null), wakes, 'no dispatched wake is a no-op');
  });
});

describe('scheduler shard realm', () => {
  it('claims workloads and dispatches the highest-priority runnable lease', async (t) => {
    const host = createHost({
      leases: [{
        leaseId: 'lease-bg',
        workloadId: 'work-bg',
        epoch: 1,
        priority: 'background'
      }, {
        leaseId: 'lease-int',
        workloadId: 'work-int',
        epoch: 1,
        priority: 'interactive'
      }],
      wakes: [[{
        workloadId: 'work-bg',
        reason: 'message',
        sourceId: 'bg'
      }, {
        workloadId: 'work-int',
        reason: 'message',
        sourceId: 'int'
      }]],
      results: {
        'lease-bg': [{ result: 'idle' }],
        'lease-int': [{ result: 'idle' }]
      }
    });
    const realm = schedulerRealm(host.facade);
    const summary = await realm.call({ shardId: 'shard-1', capacity: 2, maxDispatches: 1, maxPolls: 1 }) as {
      dispatches: number;
    };
    t.equal(summary.dispatches, 1);
    t.deepEqual(host.claimed, ['lease-bg', 'lease-int']);
    t.deepEqual(host.dispatched, ['lease-int']);
    t.equal(host.load.length > 0, true);
  });

  it('budget-yielding workload accrues debt and lets another runnable workload run', async (t) => {
    const host = createHost({
      leases: [{
        leaseId: 'lease-a',
        workloadId: 'work-a',
        epoch: 1,
        priority: 'service'
      }, {
        leaseId: 'lease-b',
        workloadId: 'work-b',
        epoch: 1,
        priority: 'service'
      }],
      wakes: [[{
        workloadId: 'work-a',
        reason: 'message',
        sourceId: 'a'
      }, {
        workloadId: 'work-b',
        reason: 'message',
        sourceId: 'b'
      }]],
      results: {
        'lease-a': [{ result: 'budget_yield', costMicros: 100 }],
        'lease-b': [{ result: 'idle', costMicros: 1 }]
      }
    });
    const realm = schedulerRealm(host.facade);
    await realm.call({ shardId: 'shard-1', capacity: 2, maxDispatches: 2, maxPolls: 1 });
    t.deepEqual(host.dispatched, ['lease-a', 'lease-b']);
  });

  it('releases failed and terminated workloads', async (t) => {
    const host = createHost({
      leases: [{
        leaseId: 'lease-failed',
        workloadId: 'work-failed',
        epoch: 1,
        priority: 'service'
      }, {
        leaseId: 'lease-term',
        workloadId: 'work-term',
        epoch: 1,
        priority: 'service'
      }],
      wakes: [[{
        workloadId: 'work-failed',
        reason: 'message',
        sourceId: 'f'
      }, {
        workloadId: 'work-term',
        reason: 'message',
        sourceId: 't'
      }]],
      results: {
        'lease-failed': [{ result: 'failed' }],
        'lease-term': [{ result: 'terminated' }]
      }
    });
    const realm = schedulerRealm(host.facade);
    await realm.call({ shardId: 'shard-1', capacity: 2, maxDispatches: 2, maxPolls: 1 });
    t.deepEqual(host.released, [{
      leaseId: 'lease-failed',
      reason: 'failed'
    }, {
      leaseId: 'lease-term',
      reason: 'terminated'
    }]);
  });

  it('drops leases when renewal fails', async (t) => {
    const host = createHost({
      leases: [{
        leaseId: 'lease-a',
        workloadId: 'work-a',
        epoch: 1,
        priority: 'service'
      }],
      wakes: [[{
        workloadId: 'work-a',
        reason: 'message',
        sourceId: 'a'
      }]],
      results: {
        'lease-a': [{ result: 'idle' }]
      },
      renew: {
        'lease-a': false
      }
    });
    const realm = schedulerRealm(host.facade);
    await realm.call({ shardId: 'shard-1', capacity: 1, maxDispatches: 1, maxPolls: 1, renewEvery: 1 });
    t.deepEqual(host.dispatched, []);
    t.deepEqual(host.released, [{
      leaseId: 'lease-a',
      reason: 'renew_failed'
    }]);
  });

  it('releases held leases on shutdown when requested', async (t) => {
    const host = createHost({
      leases: [{
        leaseId: 'lease-a',
        workloadId: 'work-a',
        epoch: 1,
        priority: 'service'
      }],
      wakes: [],
      results: {}
    });
    const realm = schedulerRealm(host.facade);
    await realm.call({ shardId: 'shard-1', capacity: 1, maxDispatches: 0, maxPolls: 0, releaseOnShutdown: true });
    t.deepEqual(host.released, [{
      leaseId: 'lease-a',
      reason: 'shutdown'
    }]);
  });

  it('runs as a thread realm and directly pumps parked workload isolates with file I/O', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-scheduler-real-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    const proofOutput = `${root}/summary.json`;

    const workerEntry = new URL('./fixtures/scheduler-io-worker.ts', import.meta.url).pathname;
    const host = createHost({
      leases: [{
        leaseId: 'lease-low',
        workloadId: 'work-low',
        epoch: 1,
        priority: 'background',
        entryPath: workerEntry,
        data: {
          inputText: 'low-data',
          expectText: 'low-data',
          marker: 'low'
        }
      }, {
        leaseId: 'lease-high',
        workloadId: 'work-high',
        epoch: 1,
        priority: 'interactive',
        entryPath: workerEntry,
        data: {
          inputText: 'high-data',
          expectText: 'high-data',
          marker: 'high'
        }
      }],
      wakes: [[{
        workloadId: 'work-low',
        reason: 'io',
        sourceId: 'low'
      }, {
        workloadId: 'work-high',
        reason: 'io',
        sourceId: 'high'
      }]],
      results: {}
    });
    try {
      const realm = schedulerRealm(host.facade, { thread: true });
      const summary = await realm.call({ shardId: 'shard-real', capacity: 2, maxDispatches: 1, maxPolls: 1, releaseOnShutdown: true, ioProofOutput: proofOutput }) as {
        dispatches: number;
      };
      t.equal(summary.dispatches, 1);
      t.deepEqual(host.dispatched, [], 'host dispatch facade was not used for parked isolates');
      const proof = JSON.parse(new TextDecoder().decode(await fs.readFile(proofOutput)));
      t.equal(proof.dispatches, 1);
    } finally {
      await fs.unlink(proofOutput).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('applies budget debt across parked workload isolate dispatches', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-scheduler-debt-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    const proofOutput = `${root}/summary.json`;

    const workerEntry = new URL('./fixtures/scheduler-io-worker.ts', import.meta.url).pathname;
    const host = createHost({
      leases: [{
        leaseId: 'lease-a',
        workloadId: 'work-a',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          inputText: 'a-data',
          expectText: 'a-data',
          marker: 'a',
          result: 'budget_yield',
          costMicros: 100
        }
      }, {
        leaseId: 'lease-b',
        workloadId: 'work-b',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          inputText: 'b-data',
          expectText: 'b-data',
          marker: 'b'
        }
      }],
      wakes: [[{
        workloadId: 'work-a',
        reason: 'io',
        sourceId: 'a'
      }, {
        workloadId: 'work-b',
        reason: 'io',
        sourceId: 'b'
      }]],
      results: {}
    });
    try {
      const realm = schedulerRealm(host.facade, { thread: true });
      await realm.call({ shardId: 'shard-real', capacity: 2, maxDispatches: 2, maxPolls: 1, releaseOnShutdown: true, ioProofOutput: proofOutput });
      t.deepEqual(host.dispatched, [], 'host dispatch facade was not used for parked isolates');
      const proof = JSON.parse(new TextDecoder().decode(await fs.readFile(proofOutput)));
      t.equal(proof.dispatches, 2);
    } finally {
      await fs.unlink(proofOutput).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('keeps module state isolated across multiple live parked isolates', async (t) => {
    const workerEntry = new URL('./fixtures/scheduler-stateful-worker.ts', import.meta.url).pathname;
    const host = createHost({
      leases: [{
        leaseId: 'lease-a',
        workloadId: 'work-a',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          result: 'budget_yield',
          baseCost: 10
        }
      }, {
        leaseId: 'lease-b',
        workloadId: 'work-b',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          result: 'budget_yield',
          baseCost: 20
        }
      }],
      wakes: [[{
        workloadId: 'work-a',
        reason: 'message',
        sourceId: 'a'
      }, {
        workloadId: 'work-b',
        reason: 'message',
        sourceId: 'b'
      }]],
      results: {}
    });
    const realm = schedulerRealm(host.facade, { thread: true });
    await realm.call({ shardId: 'shard-state', capacity: 2, maxDispatches: 2, maxPolls: 1, releaseOnShutdown: true });
    t.deepEqual(host.dispatched, [], 'host dispatch facade was not used for parked isolates');
    t.equal(host.load.some((entry) => (entry as LoadSummary).debtMicros === 32), true);
  });

  it('alternates dispatches across concurrently held parked isolates without sharing counters', async (t) => {
    const workerEntry = new URL('./fixtures/scheduler-stateful-worker.ts', import.meta.url).pathname;
    const host = createHost({
      leases: [{
        leaseId: 'lease-a',
        workloadId: 'work-a',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          terminateAt: 2
        }
      }, {
        leaseId: 'lease-b',
        workloadId: 'work-b',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          terminateAt: 2
        }
      }],
      wakes: [[{
        workloadId: 'work-a',
        reason: 'message',
        sourceId: 'a-1'
      }], [{
        workloadId: 'work-b',
        reason: 'message',
        sourceId: 'b-1'
      }], [{
        workloadId: 'work-a',
        reason: 'message',
        sourceId: 'a-2'
      }], [{
        workloadId: 'work-b',
        reason: 'message',
        sourceId: 'b-2'
      }]],
      results: {}
    });
    const realm = schedulerRealm(host.facade, { thread: true });
    await realm.call({ shardId: 'shard-alternate', capacity: 2, maxDispatches: 4, maxPolls: 4 });
    t.deepEqual(host.dispatched, [], 'host dispatch facade was not used for parked isolates');
    t.deepEqual(host.released, [{
      leaseId: 'lease-a',
      reason: 'terminated'
    }, {
      leaseId: 'lease-b',
      reason: 'terminated'
    }]);
  });

  it('settles pending microtasks in one parked isolate and keeps another isolate schedulable', async (t) => {
    const workerEntry = new URL('./fixtures/scheduler-stateful-worker.ts', import.meta.url).pathname;
    const host = createHost({
      leases: [{
        leaseId: 'lease-async',
        workloadId: 'work-async',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          asyncDepth: 5,
          terminateAt: 1
        }
      }, {
        leaseId: 'lease-sync',
        workloadId: 'work-sync',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          terminateAt: 1
        }
      }],
      wakes: [[{
        workloadId: 'work-async',
        reason: 'message',
        sourceId: 'async'
      }, {
        workloadId: 'work-sync',
        reason: 'message',
        sourceId: 'sync'
      }]],
      results: {}
    });
    const realm = schedulerRealm(host.facade, { thread: true });
    await realm.call({ shardId: 'shard-async', capacity: 2, maxDispatches: 2, maxPolls: 1 });
    t.deepEqual(host.dispatched, [], 'host dispatch facade was not used for parked isolates');
    t.deepEqual(host.released, [{
      leaseId: 'lease-async',
      reason: 'terminated'
    }, {
      leaseId: 'lease-sync',
      reason: 'terminated'
    }]);
  });

  it('routes workload file operations through scheduler-owned host operations', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-scheduler-host-ops-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    const inputPath = `${root}/input.txt`;
    const outputPath = `${root}/output.txt`;
    await fs.writeFile(inputPath, new TextEncoder().encode('host-owned'));

    const workerEntry = new URL('./fixtures/scheduler-host-op-worker.ts', import.meta.url).pathname;
    const host = createHost({
      leases: [{
        leaseId: 'lease-host-op',
        workloadId: 'work-host-op',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: {
          inputPath,
          outputPath,
          marker: 'scheduled'
        }
      }],
      wakes: [[{
        workloadId: 'work-host-op',
        reason: 'io',
        sourceId: 'host-op'
      }]],
      results: {}
    });
    try {
      const realm = schedulerRealm(host.facade, { thread: true });
      const summary = await realm.call({ shardId: 'shard-host-op', capacity: 1, maxDispatches: 1, maxPolls: 1, releaseOnShutdown: true }) as {
        dispatches: number;
      };
      t.equal(summary.dispatches, 1);
      t.deepEqual(host.dispatched, [], 'host dispatch facade was not used for parked isolates');
      t.equal(new TextDecoder().decode(await fs.readFile(outputPath)), 'scheduled:host-owned');
    } finally {
      await fs.unlink(inputPath).catch(() => undefined);
      await fs.unlink(outputPath).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('blocks direct FFI inside scheduler-managed workload isolates', async (t) => {
    const workerEntry = new URL('./fixtures/scheduler-forbidden-file-worker.ts', import.meta.url).pathname;
    const host = createHost({
      leases: [{
        leaseId: 'lease-forbidden',
        workloadId: 'work-forbidden',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry
      }],
      wakes: [[{
        workloadId: 'work-forbidden',
        reason: 'message',
        sourceId: 'forbidden'
      }]],
      results: {}
    });
    const realm = schedulerRealm(host.facade, { thread: true });
    await realm.call({ shardId: 'shard-forbidden', capacity: 1, maxDispatches: 1, maxPolls: 1 });
    t.deepEqual(host.dispatched, [], 'host dispatch facade was not used for parked isolates');
    t.deepEqual(host.released, [{
      leaseId: 'lease-forbidden',
      reason: 'failed'
    }]);
  });

  it('performs tenant fino:file I/O through the scheduler-backed provider', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-scheduler-facade-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    const inputPath = `${root}/input.txt`;
    const outputPath = `${root}/output.txt`;
    const dir = `${root}/sub`;
    const handlePath = `${root}/handle.txt`;
    await fs.writeFile(inputPath, new TextEncoder().encode('facade-owned'));

    const workerEntry = new URL('./fixtures/scheduler-file-worker.ts', import.meta.url).pathname;
    const host = createHost({
      leases: [{
        leaseId: 'lease-file',
        workloadId: 'work-file',
        epoch: 1,
        priority: 'service',
        entryPath: workerEntry,
        data: { inputPath, outputPath, dir, handlePath, marker: 'scheduled' }
      }],
      wakes: [[{
        workloadId: 'work-file',
        reason: 'io',
        sourceId: 'file'
      }]],
      results: {}
    });
    try {
      const realm = schedulerRealm(host.facade, { thread: true });
      const summary = await realm.call({ shardId: 'shard-facade-file', capacity: 1, maxDispatches: 1, maxPolls: 1, releaseOnShutdown: true }) as { dispatches: number };
      t.equal(summary.dispatches, 1, 'the file workload dispatched');
      t.deepEqual(host.dispatched, [], 'host dispatch facade was not used for parked isolates');

      // The scheduler performed every operation on the real filesystem on the
      // tenant's behalf — verify the side effects it produced.
      t.equal(new TextDecoder().decode(await fs.readFile(outputPath)), 'scheduled:facade-owned', 'readFile + writeFile routed through the scheduler');
      const dirEntry = await fs.dir(dir);
      t.deepEqual((await dirEntry.entries()).map((e) => e.name).sort(), ['a.txt', 'b.txt'], 'mkdir + dir listing routed through the scheduler');
      t.equal(new TextDecoder().decode(await fs.readFile(handlePath)), 'handle-data', 'open handle write routed through the scheduler');
    } finally {
      await fs.unlink(inputPath).catch(() => undefined);
      await fs.unlink(outputPath).catch(() => undefined);
      await fs.unlink(handlePath).catch(() => undefined);
      await fs.unlink(`${dir}/a.txt`).catch(() => undefined);
      await fs.unlink(`${dir}/b.txt`).catch(() => undefined);
      await fs.rmdir(dir).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('settles I/O-bound isolates concurrently rather than serially', async (t) => {
    const workerEntry = new URL('./fixtures/scheduler-delay-worker.ts', import.meta.url).pathname;

    // Time a batch of two delay-worker isolates. Subtracting the zero-delay run
    // removes realm-spawn / isolate-creation overhead, isolating the I/O wait.
    async function timeBatch(shardId: string, ms: number): Promise<number> {
      const host = createHost({
        leases: [{
          leaseId: 'lease-a', workloadId: 'work-a', epoch: 1, priority: 'service', entryPath: workerEntry, data: { ms }
        }, {
          leaseId: 'lease-b', workloadId: 'work-b', epoch: 1, priority: 'service', entryPath: workerEntry, data: { ms }
        }],
        wakes: [[{
          workloadId: 'work-a', reason: 'io', sourceId: 'a'
        }, {
          workloadId: 'work-b', reason: 'io', sourceId: 'b'
        }]],
        results: {}
      });
      const realm = schedulerRealm(host.facade, { thread: true });
      const started = Date.now();
      const summary = await realm.call({ shardId, capacity: 2, maxDispatches: 2, maxPolls: 1, releaseOnShutdown: true }) as { dispatches: number };
      t.equal(summary.dispatches, 2, `both isolates dispatched (${shardId})`);
      return Date.now() - started;
    }

    const baseline = await timeBatch('shard-baseline', 0);
    const delayed = await timeBatch('shard-delayed', 300);
    const added = delayed - baseline;
    // Two 300ms I/O waits overlap on the scheduler loop, so the batch adds ~300ms
    // over the zero-delay baseline — not ~600ms as serial execution would.
    t.equal(added < 450, true, `two 300ms I/O waits overlapped (added ${added}ms, serial would add ~600ms)`);
  });
});
