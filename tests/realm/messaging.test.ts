/**
* Tests for fino:realm — multi-event messaging via realm.port.
*/
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import { MessagePort } from 'fino:realm/messaging';
interface PortReport {
  selfPort: boolean;
  realmPort: boolean;
  samePort: boolean;
  constructorName: string | null;
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
  it('delivers a final message before run() settles', async (t) => {
    const realm = new Realm({ entry: new URL('./fixtures/post-and-exit.ts', import.meta.url).pathname });
    let received: unknown;
    realm.port.onmessage = (event) => { received = event.data; };
    await realm.run();
    t.equal(received, 'final-message', 'the terminal pump drained the child port before release');
  });
  it('parent and child can exchange messages via realm.port', async (t) => {
    const realm = new Realm({ entry: new URL('./fixtures/messaging-echo.ts', import.meta.url).pathname });
    const responses: string[] = [];
    realm.port.onmessage = (ev) => {
      responses.push(ev.data as string);
    };
    const p = realm.run();
    // Post immediately: the child buffers messages that arrive while its
    // entry module is still loading and replays them to its first listener.
    realm.port.postMessage('hello');
    realm.port.postMessage('world');
    const deadline = Date.now() + 5e3;
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
  it('realm.port presents the MessagePort surface', async (t) => {
    const realm = new Realm({ entry: new URL('./fixtures/hello.ts', import.meta.url).pathname });
    t.equal(typeof realm.port.postMessage, 'function', 'port has postMessage');
    t.equal(typeof realm.port.addEventListener, 'function', 'port has addEventListener');
    t.equal(typeof realm.port.start, 'function', 'port has start');
    t.equal(typeof realm.port.close, 'function', 'port has close');
    realm.terminate();
  });
  it('allocated child exposes fino:realm/self.port as the bootstrap realmPort', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/self-port-report.ts', import.meta.url).pathname
    });
    const first = readFirstMessage(realm) as Promise<PortReport>;
    const run = realm.run().catch(() => {    /* terminated after test */});
    const report = await first;
    t.equal(report.selfPort, true, 'child exposes fino:realm/self.port');
    t.equal(report.realmPort, true, 'child exposes bootstrap realmPort');
    t.equal(report.samePort, true, 'self port and realmPort are the same object');
    realm.terminate();
    await run;
  });
  it('process child exposes fino:realm/self.port as the bootstrap realmPort', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/self-port-report.ts', import.meta.url).pathname
    });
    const first = readFirstMessage(realm) as Promise<PortReport>;
    const run = realm.run().catch(() => {    /* terminated after test */});
    const report = await first;
    t.equal(report.selfPort, true, 'process child exposes fino:realm/self.port');
    t.equal(report.realmPort, true, 'process child exposes bootstrap realmPort');
    t.equal(report.samePort, true, 'self port and realmPort are the same object');
    realm.terminate();
    await run;
  });
});
