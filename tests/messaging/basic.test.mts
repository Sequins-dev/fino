/**
 * Tests for MessagePort / MessageChannel — IntraPort basics.
 */

import { describe, it } from 'fino:test/test';
import { MessageChannel, MessagePort, MessageEvent } from 'fino:realm/messaging';

function isDataCloneError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'DataCloneError';
}

describe('MessageChannel', () => {
  it('is available on globalThis with MessagePort and MessageEvent', (t) => {
    t.equal(globalThis.MessageChannel, MessageChannel, 'global MessageChannel matches module export');
    t.equal(globalThis.MessagePort, MessagePort, 'global MessagePort matches module export');
    t.equal(globalThis.MessageEvent, MessageEvent, 'global MessageEvent matches module export');
  });

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

  it('transferred ports are neutered on the sender side', async (t) => {
    const carried = new MessageChannel();
    const carrier = new MessageChannel();
    const receivedPorts: MessagePort[] = [];

    carrier.port2.onmessage = (ev) => {
      receivedPorts.push(...ev.ports);
    };
    carrier.port1.postMessage('take-port', [carried.port1]);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const delivered: unknown[] = [];
    carried.port2.onmessage = (ev) => { delivered.push(ev.data); };
    carried.port1.postMessage('from old endpoint');
    receivedPorts[0]!.postMessage('from transferred endpoint');

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(receivedPorts.length, 1, 'one transferred port is exposed on MessageEvent.ports');
    t.equal(delivered.length, 1, 'only the transferred endpoint remains connected');
    t.equal(delivered[0], 'from transferred endpoint', 'transferred endpoint communicates with original partner');

    carried.port2.close();
    carrier.port1.close();
    carrier.port2.close();
    receivedPorts[0]?.close();
  });

  it('rejects duplicate transferred ports atomically', async (t) => {
    const carried = new MessageChannel();
    const carrier = new MessageChannel();
    let delivered: unknown = undefined;

    t.throws(
      () => carrier.port1.postMessage('duplicate-port', [carried.port1, carried.port1]),
      isDataCloneError,
      'duplicate transfer entry throws DataCloneError',
    );

    carried.port2.onmessage = (ev) => { delivered = ev.data; };
    carried.port1.postMessage('still-entangled');

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(delivered, 'still-entangled', 'failed duplicate transfer did not neuter the port');

    carried.port1.close();
    carried.port2.close();
    carrier.port1.close();
    carrier.port2.close();
  });

  it('rejects closed transferred ports', (t) => {
    const carried = new MessageChannel();
    const carrier = new MessageChannel();

    carried.port1.close();

    t.throws(
      () => carrier.port1.postMessage('closed-port', [carried.port1]),
      isDataCloneError,
      'closed port transfer throws DataCloneError',
    );

    carried.port2.close();
    carrier.port1.close();
    carrier.port2.close();
  });

  it('rejects already transferred ports', async (t) => {
    const carried = new MessageChannel();
    const firstCarrier = new MessageChannel();
    const secondCarrier = new MessageChannel();

    firstCarrier.port1.postMessage('first-transfer', [carried.port1]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.throws(
      () => secondCarrier.port1.postMessage('second-transfer', [carried.port1]),
      isDataCloneError,
      'already transferred port throws DataCloneError',
    );

    carried.port2.close();
    firstCarrier.port1.close();
    firstCarrier.port2.close();
    secondCarrier.port1.close();
    secondCarrier.port2.close();
  });

  it('rejects invalid transfer entries', (t) => {
    const carrier = new MessageChannel();

    t.throws(
      () => carrier.port1.postMessage('bad-transfer', [{} as Transferable]),
      isDataCloneError,
      'unsupported transfer entry throws DataCloneError',
    );

    carrier.port1.close();
    carrier.port2.close();
  });

  it('rejects mixed valid and invalid transfers atomically', async (t) => {
    const carried = new MessageChannel();
    const carrier = new MessageChannel();
    let carriedDelivered: unknown = undefined;
    let carrierDelivered = false;

    carrier.port2.onmessage = () => { carrierDelivered = true; };

    t.throws(
      () => carrier.port1.postMessage('mixed-transfer', [carried.port1, {} as Transferable]),
      isDataCloneError,
      'mixed valid and invalid transfers throw DataCloneError',
    );

    carried.port2.onmessage = (ev) => { carriedDelivered = ev.data; };
    carried.port1.postMessage('still-entangled');

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    t.equal(carriedDelivered, 'still-entangled', 'valid port remains usable after failed mixed transfer');
    t.equal(carrierDelivered, false, 'failed mixed transfer does not queue a message');

    carried.port1.close();
    carried.port2.close();
    carrier.port1.close();
    carrier.port2.close();
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

  it('MessageEvent.ports is a frozen array copy', (t) => {
    const { port1 } = new MessageChannel();
    const ports = [port1];
    const ev = new MessageEvent('message', { ports });

    ports.length = 0;

    t.ok(Array.isArray(ev.ports), 'ports is an array');
    t.equal(ev.ports.length, 1, 'ports is copied from init');
    t.ok(Object.isFrozen(ev.ports), 'ports array is frozen');
    t.ok(ev.ports[0] instanceof MessagePort, 'ports entries are MessagePorts');
    t.throws(() => (ev.ports as MessagePort[]).push(port1), null, 'frozen ports array rejects mutation');

    port1.close();
  });

  it('dispatches messageerror events to listeners and handler properties', (t) => {
    const { port1 } = new MessageChannel();
    const seen: string[] = [];

    port1.addEventListener('messageerror', (ev) => {
      seen.push((ev as MessageEvent).type);
    });
    port1.onmessageerror = (ev) => {
      seen.push(ev.type);
    };
    port1.dispatchEvent(new MessageEvent('messageerror', { data: new Error('bad message') }));

    t.deepEqual(seen, ['messageerror', 'messageerror'], 'messageerror dispatch reaches both listeners');
    port1.close();
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
