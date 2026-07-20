/** Focused tests for node-level reactor orchestration. */
import { describe, it } from 'fino:test/test';
import { NodeOrchestrator } from 'internal:orchestrator/node-orchestrator';
import { availableParallelism } from 'internal:process';
import { mergeChildRules } from 'internal:realm-native';
import { ThreadPort } from 'internal:realm/transport-port';

const worker = new URL('../realm/fixtures/scaling-fn.ts', import.meta.url).pathname;
const blockingWorker = new URL('../realm/fixtures/blocking-fn.ts', import.meta.url).pathname;

function call(port: ThreadPort, correlationId: number, delay: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const handler = (event: Event) => {
      const message = (event as MessageEvent).data as {
        __call_result?: boolean;
        __call_error?: boolean;
        correlationId?: number;
        result?: string;
        message?: string;
      };
      if (message.correlationId !== correlationId) return;
      port.removeEventListener('message', handler);
      if (message.__call_error) reject(new Error(message.message));
      else resolve(message.result!);
    };
    port.addEventListener('message', handler);
    port.start();
    port.postMessage({ __call: true, correlationId, args: [delay] });
  });
}

async function eventually<T>(fn: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before timeout');
}

describe('NodeOrchestrator', () => {
  it('sizes the default reactor set from native OS parallelism', async (t) => {
    t.equal(Number.isInteger(availableParallelism), true);
    t.equal(availableParallelism > 0, true);
    const orchestrator = new NodeOrchestrator();
    t.equal(orchestrator.reactorIds().length, availableParallelism);
    await orchestrator.shutdown();
  });

  it('executes realms on multiple reactors', async (t) => {
    const orchestrator = new NodeOrchestrator({ reactorCount: 2, capacity: 2 });
    orchestrator.start();
    const placements = [0, 1].map((index) => orchestrator.deployRealm({
      entryPath: worker,
      rulesJson: mergeChildRules('[]') as string,
    }));
    try {
      t.equal(placements.every((placement) => placement !== null), true);
      const reactors = placements.map((placement) => orchestrator.collection().placementOf(placement!.workloadId));
      t.equal(new Set(reactors).size, 2, 'placement used both reactors');
      const ports = placements.map((placement) => new ThreadPort(placement!.portWakeFd, placement!.portHandle));
      const ids = await Promise.all(ports.map((port, index) => call(port, index, 0)));
      t.notEqual(ids[0], ids[1], 'each reactor hosted an independent isolate');
      for (const port of ports) port.close();
    } finally {
      await orchestrator.shutdown();
    }
  });

  it('moves the same live realm between reactors', async (t) => {
    const orchestrator = new NodeOrchestrator({ reactorCount: 2, capacity: 2 });
    orchestrator.start();
    const placement = orchestrator.deployRealm({
      entryPath: worker,
      rulesJson: mergeChildRules('[]') as string
    });
    if (placement === null) throw new Error('realm was not placed');
    const port = new ThreadPort(placement.portWakeFd, placement.portHandle);
    try {
      const before = await call(port, 1, 0);
      const source = orchestrator.collection().placementOf(placement.workloadId)!;
      const destination = orchestrator.reactorIds().find((id) => id !== source)!;
      const outcome = await orchestrator.move(placement.workloadId, destination);
      t.equal(outcome.status, 'moved');
      const after = await call(port, 2, 0);
      t.equal(after, before, 'migration preserved the isolate heap');
      t.equal(orchestrator.collection().placementOf(placement.workloadId), destination);
    } finally {
      port.close();
      orchestrator.revoke(placement.workloadId, 'test-done');
      await orchestrator.shutdown();
    }
  });

  it('promotes a repeatedly blocking isolate to batch capacity', async (t) => {
    const orchestrator = new NodeOrchestrator({
      reactorCount: 1,
      capacity: 2,
      syncSliceThresholdMicros: 1_000,
      batchPool: { minReactors: 0, maxReactors: 1, idleTimeoutMs: 10 }
    });
    orchestrator.start();
    const placement = orchestrator.deployRealm({
      entryPath: blockingWorker,
      rulesJson: mergeChildRules('[]') as string
    });
    if (placement === null) throw new Error('realm was not placed');
    const port = new ThreadPort(placement.portWakeFd, placement.portHandle);
    try {
      await call(port, 20, 10);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await call(port, 21, 10);
      const destination = await eventually(() => {
        const reactor = orchestrator.collection().placementOf(placement.workloadId);
        return reactor !== null && orchestrator.collection().reactorClassOf(reactor) === 'batch'
          ? reactor
          : null;
      });
      t.match(destination, /^batch-/);
    } finally {
      port.close();
      orchestrator.revoke(placement.workloadId, 'test-done');
      await orchestrator.shutdown();
    }
  });

  it('places background-priority realms on the batch pool', async (t) => {
    const orchestrator = new NodeOrchestrator({ reactorCount: 2, capacity: 4, batchPool: { minReactors: 1 } });
    orchestrator.start();
    try {
      const background = orchestrator.deployRealm({
        entryPath: worker,
        rulesJson: mergeChildRules('[]') as string,
        priority: 'background'
      });
      const service = orchestrator.deployRealm({
        entryPath: worker,
        rulesJson: mergeChildRules('[]') as string
      });
      t.ok(background !== null && service !== null, 'both realms placed');
      const backgroundReactor = orchestrator.collection().placementOf(background!.workloadId)!;
      const serviceReactor = orchestrator.collection().placementOf(service!.workloadId)!;
      t.equal(orchestrator.collection().reactorClassOf(backgroundReactor), 'batch', 'background realm landed on a batch reactor');
      t.equal(orchestrator.collection().reactorClassOf(serviceReactor), 'latency', 'service realm stayed on a latency reactor');
    } finally {
      await orchestrator.shutdown();
    }
  });

  it('provisions a batch reactor on demand for background priority', async (t) => {
    const orchestrator = new NodeOrchestrator({ reactorCount: 1, capacity: 4, batchPool: { minReactors: 0 } });
    orchestrator.start();
    try {
      const placed = orchestrator.deployRealm({
        entryPath: worker,
        rulesJson: mergeChildRules('[]') as string,
        priority: 'background'
      });
      t.ok(placed !== null, 'background realm placed');
      const reactor = orchestrator.collection().placementOf(placed!.workloadId)!;
      t.equal(orchestrator.collection().reactorClassOf(reactor), 'batch', 'a batch reactor was provisioned for it');
    } finally {
      await orchestrator.shutdown();
    }
  });

  it('terminates a realm that nears its per-workload heap cap', async (t) => {
    const orchestrator = new NodeOrchestrator({
      reactorCount: 1,
      capacity: 4,
      // Small enough that an unbounded allocator trips it fast; large enough
      // to bootstrap (bootstrap alone needs a few MiB of old space).
      heapLimitBytes: 48 * 1024 * 1024
    });
    orchestrator.start();
    const hog = new URL('../realm/fixtures/heap-hog.ts', import.meta.url).pathname;
    try {
      const placed = orchestrator.deployRealm({
        entryPath: hog,
        rulesJson: mergeChildRules('[]') as string
      });
      t.ok(placed !== null, 'heap hog placed');
      const reason = await orchestrator.whenReleased(placed!.workloadId);
      t.ok(/terminated|failed/.test(reason), `containment released the workload (${reason}) instead of OOMing the process`);
    } finally {
      await orchestrator.shutdown();
    }
  });

  it('contains a hard-budget overrun without losing sibling isolates', async (t) => {
    const orchestrator = new NodeOrchestrator({
      reactorCount: 1,
      capacity: 2,
      hardBudgetMicros: 10_000
    });
    orchestrator.start();
    const runaway = orchestrator.deployRealm({
      entryPath: blockingWorker,
      rulesJson: mergeChildRules('[]') as string
    });
    const survivor = orchestrator.deployRealm({
      entryPath: worker,
      rulesJson: mergeChildRules('[]') as string
    });
    if (runaway === null || survivor === null) throw new Error('realms were not placed');
    const runawayPort = new ThreadPort(runaway.portWakeFd, runaway.portHandle);
    const survivorPort = new ThreadPort(survivor.portWakeFd, survivor.portHandle);
    try {
      void call(runawayPort, 30, 1_000).catch(() => {});
      t.equal(await orchestrator.whenReleased(runaway.workloadId), 'terminated');
      t.equal(typeof await call(survivorPort, 31, 0), 'string');
      t.equal(orchestrator.collection().placementOf(survivor.workloadId), 'reactor-0');
    } finally {
      runawayPort.close();
      survivorPort.close();
      await orchestrator.shutdown();
    }
  });

  it('replaces reactor capacity after a reactor exits', async (t) => {
    const orchestrator = new NodeOrchestrator({ reactorCount: 1, capacity: 1 });
    orchestrator.start();
    const first = orchestrator.deployRealm({
      entryPath: worker,
      rulesJson: mergeChildRules('[]') as string
    });
    if (first === null) throw new Error('realm was not placed');
    try {
      orchestrator._killReactor('reactor-0');
      t.equal(await orchestrator.whenReleased(first.workloadId), 'reactor-exited');
      const replacement = await eventually(() => orchestrator.deployRealm({
        entryPath: worker,
        rulesJson: mergeChildRules('[]') as string
      }));
      const port = new ThreadPort(replacement.portWakeFd, replacement.portHandle);
      t.equal(typeof await call(port, 3, 0), 'string', 'replacement reactor executes realms');
      port.close();
    } finally {
      await orchestrator.shutdown();
    }
  });

  it('replaces only the physical reactor after one isolate crashes', async (t) => {
    const orchestrator = new NodeOrchestrator({ reactorCount: 1, capacity: 2 });
    orchestrator.start();
    const failed = orchestrator.deployRealm({
      entryPath: worker,
      rulesJson: mergeChildRules('[]') as string
    });
    const survivor = orchestrator.deployRealm({
      entryPath: worker,
      rulesJson: mergeChildRules('[]') as string
    });
    if (failed === null || survivor === null) throw new Error('realms were not placed');
    const survivorPort = new ThreadPort(survivor.portWakeFd, survivor.portHandle);
    try {
      const heap = await call(survivorPort, 10, 0);
      const generation = orchestrator._reactorGeneration('reactor-0');
      orchestrator._crashRealm(failed.workloadId);

      t.equal(await orchestrator.whenReleased(failed.workloadId), 'reactor-workload-panicked');
      await eventually(() => orchestrator._reactorGeneration('reactor-0') > generation ? true : null);
      t.equal(orchestrator.collection().placementOf(survivor.workloadId), 'reactor-0');
      t.equal(await call(survivorPort, 11, 0), heap, 'survivor was moved intact, not reconstructed');
    } finally {
      survivorPort.close();
      await orchestrator.shutdown();
    }
  });

  it('is one-shot after shutdown', async (t) => {
    const orchestrator = new NodeOrchestrator({ reactorCount: 1 });
    orchestrator.start();
    await orchestrator.shutdown();
    t.throws(() => orchestrator.start(), /shut down|one-shot/i);
  });
});
