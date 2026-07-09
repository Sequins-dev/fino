/**
* Tests for MessagePort transfer across same-Isolate and cross-Isolate
* (thread realm) boundaries.
*
* Same-Isolate: port passed via realm.port.postMessage to an embedded child;
* child uses it to communicate directly with a third party.
*
* Cross-Isolate: port transferred via thread realm's ThreadPort; the
* thread realm receives the port and posts a message back through it.
*/
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
function isDataCloneError(err: unknown): boolean {
  return err instanceof Error && err.name === 'DataCloneError';
}
function nextMessage(port: MessagePort, timeout = 2e3): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error('timeout')), timeout);
    port.onmessage = (ev) => {
      clearTimeout(tid);
      resolve(ev);
    };
  });
}
describe('MessagePort transfer', () => {
  it('structuredClone rejects direct MessagePort transfer with DataCloneError', (t) => {
    const { port1, port2 } = new MessageChannel();
    try {
      t.throws(() => structuredClone({ port: port1 }, { transfer: [port1 as any] }), isDataCloneError, 'direct structuredClone MessagePort transfer throws');
    } finally {
      port1.close();
      port2.close();
    }
  });
  it('same-Isolate: transferred port is neutered on sender', async (t) => {
    const { port1: a, port2: b } = new MessageChannel();
    const { port1: c, port2: d } = new MessageChannel();
    // Transfer `a` via `c`
    c.postMessage('hello', [a]);
    // a should be neutered — sending on it is a no-op
    a.start();
    a.postMessage('should be dropped');
    // Wait for d to receive the message with the transferred port
    const received: MessagePort[] = [];
    await new Promise<void>((resolve) => {
      d.onmessage = (ev) => {
        received.push(...ev.ports);
        resolve();
      };
    });
    t.equal(received.length, 1, 'received one transferred port');
    t.ok(received[0] instanceof MessagePort, 'transferred port is a MessagePort');
    // The received port (re-entangled with b) should communicate with b
    const msgs: unknown[] = [];
    await new Promise<void>((resolve) => {
      b.onmessage = (ev) => {
        msgs.push(ev.data);
        resolve();
      };
      received[0].postMessage('from receiver to b');
    });
    t.equal(msgs[0], 'from receiver to b', 'transferred port communicates with b');
    c.close();
    d.close();
    b.close();
    received[0]?.close();
  });
  it('same-Isolate: transferred port re-entangles correctly', async (t) => {
    // Set up two channels:
    //   mc1: port1 ↔ port2   (mc1.port1 will be transferred)
    //   mc2: port1 ↔ port2   (used to carry the message with the transferred port)
    const mc1 = new MessageChannel();
    const mc2 = new MessageChannel();
    // Transfer mc1.port1 through mc2.port1 to mc2.port2
    mc2.port1.postMessage('payload', [mc1.port1]);
    // mc2.port2 receives the message and the transferred port (re-entangled with mc1.port2)
    let receivedPort: MessagePort | null = null;
    let receivedData: unknown = null;
    await new Promise<void>((resolve) => {
      mc2.port2.onmessage = (ev) => {
        receivedData = ev.data;
        receivedPort = ev.ports[0] ?? null;
        resolve();
      };
    });
    t.equal(receivedData, 'payload', 'message data preserved');
    t.ok(receivedPort !== null, 'port was transferred');
    // Now verify receivedPort ↔ mc1.port2 are properly entangled
    const echoed: unknown[] = [];
    await new Promise<void>((resolve) => {
      mc1.port2.onmessage = (ev) => {
        echoed.push(ev.data);
        resolve();
      };
      receivedPort!.postMessage('hello from receiver');
    });
    t.equal(echoed[0], 'hello from receiver', 'transferred port communicates with mc1.port2');
  });
  it('same-Isolate: transferred port inside message data is reconstructed', async (t) => {
    const carried = new MessageChannel();
    const carrier = new MessageChannel();
    carrier.port1.postMessage({ port: carried.port1 }, [carried.port1]);
    const event = await nextMessage(carrier.port2);
    t.ok(event.data.port instanceof MessagePort, 'message data contains a reconstructed MessagePort');
    t.equal(event.data.port, event.ports[0], 'event.data.port is the same object as event.ports[0]');
    event.data.port.postMessage('from data port');
    const reply = await nextMessage(carried.port2);
    t.equal(reply.data, 'from data port', 'reconstructed data port communicates with original partner');
    carrier.port1.close();
    carrier.port2.close();
    carried.port2.close();
    event.data.port.close();
  });
  it('same-Isolate: duplicate transferred port references in message data preserve identity', async (t) => {
    const carried = new MessageChannel();
    const carrier = new MessageChannel();
    carrier.port1.postMessage({
      first: carried.port1,
      nested: { second: carried.port1 },
      list: [carried.port1]
    }, [carried.port1]);
    const event = await nextMessage(carrier.port2);
    t.equal(event.data.first, event.ports[0], 'first reference uses transferred port object');
    t.equal(event.data.nested.second, event.ports[0], 'nested reference preserves transferred port identity');
    t.equal(event.data.list[0], event.ports[0], 'array reference preserves transferred port identity');
    carrier.port1.close();
    carrier.port2.close();
    carried.port2.close();
    event.ports[0]?.close();
  });
  it('same-Isolate: MessagePort in data without transfer list throws DataCloneError', (t) => {
    const carried = new MessageChannel();
    const carrier = new MessageChannel();
    try {
      t.throws(() => carrier.port1.postMessage({ port: carried.port1 }), isDataCloneError, 'MessagePort data without transfer list throws');
    } finally {
      carried.port1.close();
      carried.port2.close();
      carrier.port1.close();
      carrier.port2.close();
    }
  });
  it('same-Isolate: transferring the source port throws DataCloneError', (t) => {
    const channel = new MessageChannel();
    try {
      t.throws(() => channel.port1.postMessage('ports', [channel.port1]), isDataCloneError, 'source port transfer throws DataCloneError');
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
  it('same-Isolate: delivered MessagePort events are trusted', async (t) => {
    const channel = new MessageChannel();
    try {
      channel.port1.postMessage('ping');
      const event = await nextMessage(channel.port2);
      t.equal(event.isTrusted, true, 'message event is trusted');
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
  it('cross-Isolate: port transferred to thread realm receives message', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/port-echo-transfer.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    // Create a channel; transfer port1 to the thread realm via realm.port
    const { port1, port2 } = new MessageChannel();
    realm.port.start();
    realm.port.postMessage('use this port', [port1]);
    // port2 should receive the message the thread realm sends through port1
    const reply = await new Promise<string>((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error('timeout')), 5e3);
      port2.onmessage = (ev) => {
        clearTimeout(tid);
        resolve(ev.data as string);
      };
    });
    t.equal(reply, 'echo from thread', 'thread realm sent message via transferred port');
    realm.terminate();
    port2.close();
  });
});
