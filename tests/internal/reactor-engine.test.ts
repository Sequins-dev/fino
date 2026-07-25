/** Direct integration tests for the native multi-realm reactor. */
import { describe, it } from 'fino:test/test';
import * as engine from 'internal:reactor-engine';
import { mergeChildRules } from 'internal:realm-native';
import { ThreadPort } from 'internal:realm/transport-port';

const worker = new URL('../realm/fixtures/scaling-fn.ts', import.meta.url).pathname;
const asyncFfiWorker = new URL('../realm/fixtures/async-ffi-fn.ts', import.meta.url).pathname;
const blockingWorker = new URL('../realm/fixtures/blocking-fn.ts', import.meta.url).pathname;
const rules = mergeChildRules('[]') as string;

function place(reactorId: number, workloadId: number, entryPath = worker): ThreadPort {
  const info = engine.placeRealm(reactorId, {
    realmId: workloadId,
    entryPath,
    rulesJson: rules,
    priority: 1,
    watch: false,
    repl: false
  }) as {
    portHandle: number;
    portWakeFd: number;
  };
  return new ThreadPort(info.portWakeFd, info.portHandle);
}

function call(port: ThreadPort, correlationId: number, delay = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const handler = (event: Event) => {
      const message = (event as MessageEvent).data as Record<string, unknown>;
      if (message.correlationId !== correlationId) return;
      port.removeEventListener('message', handler);
      if (message.__call_error === true) reject(new Error(String(message.message)));
      else resolve(message.result as number);
    };
    port.addEventListener('message', handler);
    port.start();
    port.postMessage({ __call: true, correlationId, args: [delay] });
  });
}

function waitForMessage(port: ThreadPort, type: string): Promise<void> {
  return new Promise((resolve) => {
    const handler = (event: Event) => {
      const message = (event as MessageEvent).data as Record<string, unknown>;
      if (message.type !== type) return;
      port.removeEventListener('message', handler);
      resolve();
    };
    port.addEventListener('message', handler);
    port.start();
  });
}

async function waitForReport(reactorId: number, type: string, workloadId: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await engine.nextReport(reactorId);
    const report = (engine.drainReports(reactorId) as Array<Record<string, unknown>>)
      .find((item) => item.type === type && item.workloadId === workloadId);
    if (report !== undefined) return report;
  }
  throw new Error(`missing ${type} report for ${workloadId}`);
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

function stop(reactorId: number): void {
  engine.shutdown(reactorId);
  (engine as any).joinReactor(reactorId);
}

describe('native reactor engine', () => {
  it('schedules independent realms on one reactor', async (t) => {
    const reactorId = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const first = place(reactorId, 1);
    const second = place(reactorId, 2);
    try {
      const ids = await Promise.all([call(first, 1), call(second, 2)]);
      t.notEqual(ids[0], ids[1], 'each realm retained its own module heap');
    } finally {
      first.close();
      second.close();
      stop(reactorId);
    }
  });

  it('transfers one live isolate with pending work across multiple hops', async (t) => {
    const source = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const destination = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const port = place(source, 10);
    try {
      const before = await call(port, 1);
      const pending = call(port, 2, 50);
      engine.moveRealm(source, destination, 10);
      await waitForReport(destination, 'moved', 10);
      t.equal(await pending, before, 'the pending timer completed after migration');
      engine.moveRealm(destination, source, 10);
      await waitForReport(source, 'moved', 10);
      const after = await call(port, 3);
      t.equal(after, before, 'the destination continued the same isolate');
    } finally {
      port.close();
      stop(source);
      stop(destination);
    }
  });

  it('routes a background wake directly to the destination during handoff', async (t) => {
    const source = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const destination = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const port = place(source, 12, asyncFfiWorker);
    const blocker = place(destination, 13, blockingWorker);
    try {
      const started = waitForMessage(port, 'ffi-started');
      const pending = call(port, 1, 200_000);
      const blocking = call(blocker, 2, 300);
      await started;
      engine.moveRealm(source, destination, 12);
      await new Promise((resolve) => setTimeout(resolve, 20));
      engine.shutdown(source);
      await eventually(() => engine.reactorAlive(source) ? null : true);
      await blocking;
      await waitForReport(destination, 'moved', 12);
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('background wake was lost')), 500))
      ]);
      t.equal(typeof result, 'string');
    } finally {
      port.close();
      blocker.close();
      (engine as any).joinReactor(source);
      stop(destination);
    }
  });

  it('reports a terminal rejection for every missing move source', async (t) => {
    const source = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const destination = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    try {
      engine.moveRealm(source, destination, 404);
      const report = await Promise.race([
        waitForReport(source, 'moveRejected', 404),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('move did not settle')), 100))
      ]);
      t.equal(report.reason, 'realm-not-found');
    } finally {
      stop(source);
      stop(destination);
    }
  });

  it('retains source ownership when the destination cannot accept a move', async (t) => {
    const source = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const destination = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const port = place(source, 15);
    try {
      const heap = await call(port, 1);
      engine.shutdown(destination);
      await eventually(() => engine.reactorAlive(destination) ? null : true);

      engine.moveRealm(source, destination, 15);

      const rejected = await waitForReport(source, 'moveRejected', 15);
      t.equal(rejected.reason, 'destination-unavailable');
      t.equal(await call(port, 2), heap, 'the source kept the live isolate');
    } finally {
      port.close();
      stop(source);
      (engine as any).joinReactor(destination);
    }
  });

  it('replaces a failed worker while preserving sibling isolates and pending work', async (t) => {
    const reactorId = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const failed = place(reactorId, 20);
    const survivor = place(reactorId, 21);
    let newcomer: ThreadPort | null = null;
    try {
      const failedHeap = await call(failed, 1);
      const survivorHeap = await call(survivor, 2);
      const pending = call(survivor, 3, 50);
      const generation = (engine as any).reactorGeneration(reactorId) as number;

      (engine as any).crashRealm(reactorId, 20);

      const release = await waitForReport(reactorId, 'released', 20);
      t.match(String(release.reason), /reactor-workload-panicked/);
      await eventually(() => (
        (engine as any).reactorGeneration(reactorId) > generation ? true : null
      ));
      t.equal(engine.reactorAlive(reactorId), true, 'logical reactor remains alive');
      t.equal(await pending, survivorHeap, 'pending timer survived worker replacement');
      t.equal(await call(survivor, 4), survivorHeap, 'survivor retained its module heap');
      t.notEqual(survivorHeap, failedHeap, 'the failed isolate was independently owned');
      newcomer = place(reactorId, 22);
      t.equal(typeof await call(newcomer, 5), 'string', 'control traffic targets the replacement reactor');
    } finally {
      failed.close();
      survivor.close();
      newcomer?.close();
      stop(reactorId);
    }
  });

  it('joins a shut down reactor before releasing its native handle', (t) => {
    const reactorId = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    stop(reactorId);
    t.equal(engine.reactorAlive(reactorId), false);
  });
});
