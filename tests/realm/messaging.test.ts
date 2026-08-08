/**
 * Tests for fino:realm — multi-event messaging via realm.port.
 */
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
interface PortReport {
  selfPort: boolean;
  realmPort: boolean;
  samePort: boolean;
  transport: string | null;
}
async function readFirstMessage(realm: Realm, timeoutMs = 5e3): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    realm.port.onmessage = (ev) => {
      clearTimeout(tid);
      resolve((ev as MessageEvent).data);
    };
    realm.port.start();
  });
}
/**
 * Wait for a condition, or fail saying what it was still waiting for.
 *
 * This replaces two fixed sleeps — 20ms for a child realm to boot and 30ms for two round
 * trips — which are generous on a developer's machine and not on a two-core CI runner.
 * There the first message was posted before the child had installed its handler, was
 * lost, and the test reported one echo where it wanted two.
 */
async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('Realm messaging', { exclusive: true }, () => {
  it('parent and child can exchange messages via realm.port', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/messaging-echo.ts', import.meta.url).pathname,
    });
    const responses: string[] = [];
    let markReady!: () => void;
    let markComplete!: () => void;
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    const complete = new Promise<void>((resolve) => (markComplete = resolve));
    realm.port.onmessage = (ev) => {
      if (ev.data === 'ready') {
        markReady();
        return;
      }
      responses.push(ev.data as string);
      if (responses.length === 2) markComplete();
    };
    const p = realm.run();
    await ready;
    realm.port.postMessage('hello');
    realm.port.postMessage('world');
    await complete;
    t.equal(responses.length, 2, 'received both responses');
    t.equal(responses[0], 'echo:hello', 'first response correct');
    t.equal(responses[1], 'echo:world', 'second response correct');
    realm.terminate();
    await p;
    t.ok(true, 'realm terminated cleanly');
  });
  it('realm.port uses the scheduled transport', async (t) => {
    const realm = new Realm({ entry: new URL('./fixtures/hello.ts', import.meta.url).pathname });
    t.equal(
      (realm.port as { transport?: string }).transport,
      'scheduled',
      'realm.port is backed by the process scheduler',
    );
    realm.terminate();
  });
  it('scheduled child exposes fino:realm/self.port and realmPort', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/self-port-report.ts', import.meta.url).pathname,
    });
    const first = readFirstMessage(realm) as Promise<PortReport>;
    const run = realm.run();
    const report = await first;
    t.equal(report.selfPort, true, 'scheduled child exposes fino:realm/self.port');
    t.equal(report.realmPort, true, 'scheduled child also exposes bootstrap realmPort');
    t.equal(report.samePort, true, 'scheduled child self port and realmPort are the same object');
    t.equal(report.transport, 'parent', 'scheduled child talks back over its parent link');
    realm.terminate();
    await run;
  });
  it('process child uses bootstrap realmPort and leaves fino:realm/self.port undefined', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/self-port-report.ts', import.meta.url).pathname,
    });
    const first = readFirstMessage(realm) as Promise<PortReport>;
    const run = realm.run().catch(() => {
      /* terminated after test */
    });
    const report = await first;
    t.equal(report.selfPort, false, 'process child does not expose fino:realm/self.port');
    t.equal(report.realmPort, true, 'process child exposes bootstrap realmPort');
    t.equal(report.samePort, false, 'process child has no self port to compare');
    t.equal(report.transport, 'parent', 'process child talks back over its parent link');
    realm.terminate();
    await run;
  });
});
