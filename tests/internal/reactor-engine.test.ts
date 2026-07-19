/** Direct integration tests for the native multi-realm reactor. */
import { describe, it } from 'fino:test/test';
import * as engine from 'internal:reactor-engine';
import { mergeChildRules } from 'internal:realm-native';
import { ThreadPort } from 'internal:realm/transport-port';

const worker = new URL('../realm/fixtures/scaling-fn.ts', import.meta.url).pathname;
const rules = mergeChildRules('[]') as string;

function place(reactorId: number, workloadId: number): ThreadPort {
  const info = engine.placeRealm(reactorId, {
    realmId: workloadId,
    entryPath: worker,
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

async function waitForReport(reactorId: number, type: string, workloadId: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await engine.nextReport(reactorId);
    const report = (engine.drainReports(reactorId) as Array<Record<string, unknown>>)
      .find((item) => item.type === type && item.workloadId === workloadId);
    if (report !== undefined) return report;
  }
  throw new Error(`missing ${type} report for ${workloadId}`);
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

  it('transfers one live isolate between reactors', async (t) => {
    const source = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const destination = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    const port = place(source, 10);
    try {
      const before = await call(port, 1);
      engine.moveRealm(source, destination, 10);
      await waitForReport(destination, 'moved', 10);
      const after = await call(port, 2);
      t.equal(after, before, 'the destination continued the same isolate');
    } finally {
      port.close();
      stop(source);
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

  it('joins a shut down reactor before releasing its native handle', (t) => {
    const reactorId = engine.spawnReactor({ reactorClass: 'latency' }) as number;
    stop(reactorId);
    t.equal(engine.reactorAlive(reactorId), false);
  });
});
