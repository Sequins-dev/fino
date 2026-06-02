/**
 * Tests for MessagePort / MessageChannel — IntraPort basics.
 */

import { describe, it } from 'fino:test/test';
import { MessageChannel, MessagePort, MessageEvent } from 'fino:realm/messaging';

describe('MessageChannel', () => {
  it('creates two entangled ports', (t) => {
    const { port1, port2 } = new MessageChannel();
    t.ok(port1 instanceof MessagePort, 'port1 is a MessagePort');
    t.ok(port2 instanceof MessagePort, 'port2 is a MessagePort');
  });

  it('delivers a message from port1 to port2', async (t) => {
    const { port1, port2 } = new MessageChannel();
    let received: unknown = undefined;

    port2.onmessage = (ev) => {
      received = ev.data;
    };
    port1.postMessage('hello');

    // Messages are dispatched on the next _flushPorts() call (next loop tick).
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(received, 'hello', 'port2 received the message');
  });

  it('delivers a message from port2 to port1', async (t) => {
    const { port1, port2 } = new MessageChannel();
    let received: unknown = undefined;

    port1.onmessage = (ev) => {
      received = ev.data;
    };
    port2.postMessage(42);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(received, 42, 'port1 received the message');
  });

  it('clones sent values (structuredClone semantics)', async (t) => {
    const { port1, port2 } = new MessageChannel();
    const original = { x: 1 };
    let received: { x: number } | undefined;

    port2.onmessage = (ev) => {
      received = ev.data as { x: number };
    };
    port1.postMessage(original);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.ok(received !== undefined, 'message received');
    t.equal(received!.x, 1, 'value correct');
    t.ok(received !== original, 'value was cloned (not same reference)');
  });

  it('does not deliver if start() is not called', async (t) => {
    const { port1, port2 } = new MessageChannel();
    let received = false;

    port2.addEventListener('message', () => { received = true; });
    // NOT calling port2.start() — messages should queue but not dispatch
    port1.postMessage('should not arrive yet');

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(received, false, 'message not dispatched without start()');
  });

  it('delivers queued messages after start() is called', async (t) => {
    const { port1, port2 } = new MessageChannel();
    const msgs: unknown[] = [];

    port2.addEventListener('message', (ev) => { msgs.push((ev as MessageEvent).data); });
    port1.postMessage(1);
    port1.postMessage(2);

    // Messages are queued; start() should trigger dispatch on next flush
    port2.start();

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(msgs.length, 2, 'both messages delivered after start()');
    t.equal(msgs[0], 1, 'first message in order');
    t.equal(msgs[1], 2, 'second message in order');
  });

  it('close() stops message delivery', async (t) => {
    const { port1, port2 } = new MessageChannel();
    let received = false;

    port2.onmessage = () => { received = true; };
    port2.close();
    port1.postMessage('should not arrive');

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(received, false, 'no message delivered after close()');
  });

  it('postMessage after close() on sender is silently dropped', async (t) => {
    const { port1, port2 } = new MessageChannel();
    let received = false;

    port2.onmessage = () => { received = true; };
    port1.close();
    port1.postMessage('dropped');

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(received, false, 'postMessage after close() is silently dropped');
  });

  it('MessageEvent has correct data and default properties', async (t) => {
    const { port1, port2 } = new MessageChannel();
    let ev: MessageEvent | undefined;

    port2.onmessage = (e) => { ev = e; };
    port1.postMessage({ key: 'value' });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.ok(ev instanceof MessageEvent, 'event is MessageEvent');
    t.ok(ev!.data && (ev!.data as { key: string }).key === 'value', 'data correct');
    t.equal(ev!.origin, '', 'origin defaults to empty string');
    t.equal(ev!.lastEventId, '', 'lastEventId defaults to empty string');
    t.equal(ev!.source, null, 'source defaults to null');
  });

  it('bidirectional echo works', async (t) => {
    const { port1, port2 } = new MessageChannel();
    const responses: string[] = [];

    port2.onmessage = (ev) => {
      port2.postMessage(`echo:${ev.data as string}`);
    };

    port1.onmessage = (ev) => {
      responses.push(ev.data as string);
    };

    port1.postMessage('ping');

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    t.equal(responses.length, 1, 'one response');
    t.equal(responses[0], 'echo:ping', 'correct echo');
  });
});
