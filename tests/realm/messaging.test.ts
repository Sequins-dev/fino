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
describe('Realm messaging', () => {
  it('parent and child can exchange messages via realm.port', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/messaging-echo.ts', import.meta.url).pathname,
    });
    const responses: string[] = [];
    realm.port.onmessage = (ev) => {
      responses.push(ev.data as string);
    };
    const p = realm.run();
    // Give child time to set up its onmessage handler
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    realm.port.postMessage('hello');
    realm.port.postMessage('world');
    // Isolate construction happens on the claiming reactor, concurrently with
    // this realm — wait for the echoes rather than assuming a fixed delay.
    const deadline = Date.now() + 5000;
    while (responses.length < 2 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
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
