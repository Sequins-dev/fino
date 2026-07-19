/** Focused tests for node-level reactor orchestration. */
import { describe, it } from 'fino:test/test';
import { NodeOrchestrator } from 'internal:orchestrator/node-orchestrator';
import { availableParallelism } from 'internal:process';
import { mergeChildRules } from 'internal:realm-native';
import { ThreadPort } from 'internal:realm/transport-port';

const worker = new URL('../realm/fixtures/scaling-fn.ts', import.meta.url).pathname;

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
      rulesJson: mergeChildRules('[]') as string,
      localMobility: 'movable'
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
});
