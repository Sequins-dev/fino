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

async function readFirstMessage(realm: Realm, timeoutMs = 5000): Promise<unknown> {
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
      entry: new URL('./fixtures/messaging-echo.mts', import.meta.url).pathname,
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

    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    t.equal(responses.length, 2, 'received both responses');
    t.equal(responses[0], 'echo:hello', 'first response correct');
    t.equal(responses[1], 'echo:world', 'second response correct');

    realm.terminate();
    await p;
    t.ok(true, 'realm terminated cleanly');
  });

  it('realm.port is a MessagePort', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/hello.mts', import.meta.url).pathname,
    });
    t.ok(realm.port instanceof MessagePort, 'realm.port is a MessagePort');
    realm.terminate();
  });

  it('embedded child exposes fino:realm/self.port and realmPort', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/self-port-report.mts', import.meta.url).pathname,
    });
    const first = readFirstMessage(realm) as Promise<PortReport>;
    const run = realm.run();

    const report = await first;
    t.equal(report.selfPort, true, 'embedded child exposes fino:realm/self.port');
    t.equal(report.realmPort, true, 'embedded child also exposes bootstrap realmPort');
    t.equal(report.samePort, true, 'embedded child self port and realmPort are the same object');
    t.equal(report.constructorName, 'MessagePort', 'embedded child active port is MessagePort');

    realm.terminate();
    await run;
  });

  it('thread child uses bootstrap realmPort and leaves fino:realm/self.port undefined', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/self-port-report.mts', import.meta.url).pathname,
    });
    const first = readFirstMessage(realm) as Promise<PortReport>;
    const run = realm.run().catch(() => {/* terminated after test */});

    const report = await first;
    t.equal(report.selfPort, false, 'thread child does not expose fino:realm/self.port');
    t.equal(report.realmPort, true, 'thread child exposes bootstrap realmPort');
    t.equal(report.samePort, false, 'thread child has no self port to compare');
    t.equal(report.constructorName, 'ThreadPort', 'thread child active port is ThreadPort');

    realm.terminate();
    await run;
  });

  it('process child uses bootstrap realmPort and leaves fino:realm/self.port undefined', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/self-port-report.mts', import.meta.url).pathname,
    });
    const first = readFirstMessage(realm) as Promise<PortReport>;
    const run = realm.run().catch(() => {/* terminated after test */});

    const report = await first;
    t.equal(report.selfPort, false, 'process child does not expose fino:realm/self.port');
    t.equal(report.realmPort, true, 'process child exposes bootstrap realmPort');
    t.equal(report.samePort, false, 'process child has no self port to compare');
    t.equal(report.constructorName, 'ThreadPort', 'process child active port uses the transport-backed ThreadPort wrapper');

    realm.terminate();
    await run;
  });
});
