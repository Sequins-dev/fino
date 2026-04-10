/**
 * Tests for fino:realm — multi-event messaging via realm.port.
 */

import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';

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
    const { MessagePort } = await import('fino:messaging') as typeof import('fino:messaging');
    const realm = new Realm({
      entry: new URL('./fixtures/hello.mts', import.meta.url).pathname,
    });
    t.ok(realm.port instanceof MessagePort, 'realm.port is a MessagePort');
    realm.terminate();
  });
});
