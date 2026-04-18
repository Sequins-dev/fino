/**
 * Tests for BroadcastChannel — same-Realm and cross-Realm pub/sub.
 */

import { describe, it } from 'fino:test/test';

describe('BroadcastChannel', () => {
  it('is available as a global', (t) => {
    t.ok(typeof BroadcastChannel === 'function', 'BroadcastChannel is a constructor');
  });

  it('name property reflects constructor argument', (t) => {
    const bc = new BroadcastChannel('test-name');
    t.equal(bc.name, 'test-name', 'name matches constructor arg');
    bc.close();
  });

  it('sender does not receive its own messages', async (t) => {
    const bc = new BroadcastChannel('self-test');
    let received = false;
    bc.onmessage = () => { received = true; };
    bc.postMessage('hello');
    // Give a couple of event-loop turns to verify no self-delivery.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    t.equal(received, false, 'sender did not receive its own message');
    bc.close();
  });

  it('two channels on the same name deliver messages to each other', async (t) => {
    const ch1 = new BroadcastChannel('pair-test');
    const ch2 = new BroadcastChannel('pair-test');

    const received: unknown[] = [];
    ch2.onmessage = (ev) => { received.push(ev.data); };

    ch1.postMessage('ping');

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    t.equal(received.length, 1, 'ch2 received one message');
    t.equal(received[0], 'ping', 'correct message delivered');

    ch1.close();
    ch2.close();
  });

  it('messages can be received via addEventListener', async (t) => {
    const sender = new BroadcastChannel('listener-test');
    const receiver = new BroadcastChannel('listener-test');

    const received: unknown[] = [];
    receiver.addEventListener('message', (ev) => {
      received.push((ev as MessageEvent).data);
    });

    sender.postMessage({ value: 42 });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    t.equal(received.length, 1, 'received one message');
    t.deepEqual(received[0], { value: 42 }, 'structured data is cloned correctly');

    sender.close();
    receiver.close();
  });

  it('closed channel does not receive messages', async (t) => {
    const sender = new BroadcastChannel('close-test');
    const receiver = new BroadcastChannel('close-test');

    const received: unknown[] = [];
    receiver.onmessage = (ev) => { received.push(ev.data); };

    receiver.close();

    sender.postMessage('after-close');

    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    t.equal(received.length, 0, 'closed channel received nothing');

    sender.close();
  });

  it('postMessage on closed channel throws', (t) => {
    const bc = new BroadcastChannel('throw-test');
    bc.close();
    t.throws(() => bc.postMessage('oops'), /closed/, 'throws on closed channel');
  });

  it('channels on different names are isolated', async (t) => {
    const a1 = new BroadcastChannel('ch-A');
    const b1 = new BroadcastChannel('ch-B');

    const crossReceived: unknown[] = [];
    b1.onmessage = (ev) => { crossReceived.push(ev.data); };

    a1.postMessage('for-A-only');

    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    t.equal(crossReceived.length, 0, 'ch-B did not receive ch-A message');

    a1.close();
    b1.close();
  });

  it('multiple receivers on the same channel all get the message', async (t) => {
    const sender = new BroadcastChannel('multi-test');
    const r1 = new BroadcastChannel('multi-test');
    const r2 = new BroadcastChannel('multi-test');
    const r3 = new BroadcastChannel('multi-test');

    const counts = [0, 0, 0];
    r1.onmessage = () => { counts[0]++; };
    r2.onmessage = () => { counts[1]++; };
    r3.onmessage = () => { counts[2]++; };

    sender.postMessage('broadcast');

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    t.equal(counts[0], 1, 'r1 received the message');
    t.equal(counts[1], 1, 'r2 received the message');
    t.equal(counts[2], 1, 'r3 received the message');

    sender.close();
    r1.close();
    r2.close();
    r3.close();
  });
});
