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
  it('process entry Realm exposes the same parent port as other reactor Realms', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/self-port-report.ts', import.meta.url).pathname,
    });
    const first = readFirstMessage(realm) as Promise<PortReport>;
    const run = realm.run().catch(() => {
      /* terminated after test */
    });
    const report = await first;
    t.equal(report.selfPort, true, 'process entry exposes fino:realm/self.port');
    t.equal(report.realmPort, true, 'process child exposes bootstrap realmPort');
    t.equal(report.samePort, true, 'process entry uses one parent port');
    t.equal(report.transport, 'parent', 'process child talks back over its parent link');
    realm.terminate();
    await run;
  });
});
