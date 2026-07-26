/**
 * Tests for internal:cluster/client — ClusterClient message handling and
 * ClusterPort._deliver, without spawning real reactor-pooled realms.
 *
 * Uses an in-memory TestClientTransport (similar to TestSeedTransport in
 * seed.test.ts) so we can inject messages as if they arrived from the seed
 * and inspect what the client sent back.
 */
import { describe, it } from 'fino:test/test';
import { ClusterClient, ClusterPort } from 'internal:cluster/client';
import { serialize } from 'internal:serializer';
import type { ClusterMessage } from 'internal:cluster/protocol';
// ---------------------------------------------------------------------------
// TestClientTransport — in-memory mock from the client's perspective
// ---------------------------------------------------------------------------
class TestClientTransport {
  readonly nodeId: string;
  #handlers: ((from: string, msg: ClusterMessage) => void)[] = [];
  sent: {
    to: string;
    msg: ClusterMessage;
  }[] = [];
  closeCalled = false;
  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }
  /**
   * Inject a message as if it arrived from `from` (typically '__seed__').
   * Delivers asynchronously via a microtask, matching the real transport
   * behaviour.
   */
  inject(from: string, msg: ClusterMessage): void {
    const handlers = this.#handlers.slice();
    Promise.resolve().then(() => {
      for (const h of handlers) h(from, msg);
    });
  }
  sentOfType<T extends ClusterMessage['t']>(
    t: T,
  ): Extract<
    ClusterMessage,
    {
      t: T;
    }
  >[] {
    return this.sent
      .filter((s) => s.msg.t === t)
      .map(
        (s) =>
          s.msg as Extract<
            ClusterMessage,
            {
              t: T;
            }
          >,
      );
  }
  // ClusterTransport interface
  send(to: string, msg: ClusterMessage): void {
    this.sent.push({
      to,
      msg,
    });
  }
  broadcast(msg: ClusterMessage): void {
    this.sent.push({
      to: '__broadcast__',
      msg,
    });
  }
  broadcastExcept(_except: string, msg: ClusterMessage): void {
    this.sent.push({
      to: '__broadcast__',
      msg,
    });
  }
  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }
  listen(): void {}
  close(): void {
    this.closeCalled = true;
    this.#handlers = [];
  }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Flush one microtask queue turn. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => Promise.resolve().then(resolve));
}
/** Flush N microtask turns to allow chained Promise.resolve() chains to settle. */
async function flush(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) await flushMicrotasks();
}
function base64ToUint8(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function decodePayload(payload: string): Uint8Array[] {
  return (JSON.parse(payload) as string[]).map(base64ToUint8);
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ClusterPort._deliver routes to registered port', () => {
  it('delivers a deserialized message to a started ClusterPort', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    const port = new ClusterPort('nodeA/p-0', client);
    let received: unknown = undefined;
    port.addEventListener('message', (e: Event) => {
      received = (e as any).data;
    });
    port.start();
    // Serialize a known value so _deliver has valid bytes
    const parts = (serialize as (v: unknown) => Uint8Array[])({ greet: 'hello' });
    port._deliver(parts);
    // _dispatchMessage is synchronous once called, but give microtasks a turn
    await flush(1);
    t.ok(received !== undefined, 'message was delivered to port');
    t.equal((received as any).greet, 'hello', 'deserialized payload matches');
    client.stop();
  });
  it('preserves transferred ArrayBuffer stores across PORT_MSG payloads', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    const sender = new ClusterPort('nodeA/p-send', client);
    sender._setChildPortId('nodeB/p-recv');
    const input = new Uint8Array([1, 3, 5, 7]).buffer;
    sender.postMessage({ input }, [input]);
    const sent = transport.sentOfType('PORT_MSG')[0]!;
    t.equal(sent.fromPort, 'nodeA/p-send', 'source port preserved');
    t.equal(sent.toPort, 'nodeB/p-recv', 'destination port preserved');
    const parts = decodePayload(sent.payload);
    t.ok(parts.length >= 2, 'payload includes main bytes and transfer store');
    const receiver = new ClusterPort('nodeB/p-recv-local', client);
    let received: unknown;
    receiver.onmessage = (e: Event) => {
      received = (e as any).data;
    };
    receiver._deliver(parts);
    await flush(1);
    const output = new Uint8Array(
      (
        received as {
          input: ArrayBuffer;
        }
      ).input,
    );
    t.deepEqual([...output], [1, 3, 5, 7], 'transferred buffer contents restored');
    client.stop();
  });
  it('rejects MessagePort transfer entries explicitly', (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    const sender = new ClusterPort('nodeA/p-send', client);
    sender._setChildPortId('nodeB/p-recv');
    const channel = new MessageChannel();
    t.throws(
      () => sender.postMessage({ ok: true }, [channel.port1 as any]),
      /ArrayBuffer/,
      'cluster relay rejects non-ArrayBuffer transfer entries',
    );
    t.equal(transport.sentOfType('PORT_MSG').length, 0, 'unsupported transfer was not sent');
    channel.port1.close();
    channel.port2.close();
    client.stop();
  });
});
describe('ClusterClient.onRealmExit fires on REALM_EXIT from seed', () => {
  it('calls the registered exit handler when REALM_EXIT arrives', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    let exitCalled = false;
    let exitError: string | undefined = 'NOT_SET';
    client.onRealmExit('nodeB/0', (err) => {
      exitCalled = true;
      exitError = err;
    });
    transport.inject('__seed__', {
      t: 'REALM_EXIT',
      realmId: 'nodeB/0',
      lastPortSeq: 0,
    });
    // Delivery is via microtask — flush to let it settle
    await flush(3);
    t.ok(exitCalled, 'exit handler was called');
    t.equal(exitError, undefined, 'no error string when realm exited cleanly');
    client.stop();
  });
  it('passes the error string when REALM_EXIT carries an error', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    let exitError: string | undefined = undefined;
    client.onRealmExit('nodeB/1', (err) => {
      exitError = err;
    });
    transport.inject('__seed__', {
      t: 'REALM_EXIT',
      realmId: 'nodeB/1',
      lastPortSeq: 0,
      error: 'crash',
    });
    await flush(3);
    t.equal(exitError, 'crash', 'error string propagated from REALM_EXIT');
    client.stop();
  });
  it('delivers the final port message before an earlier REALM_EXIT', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    const port = new ClusterPort('nodeA/p-parent', client);
    const events: string[] = [];
    port.onmessage = (event: Event) => {
      events.push(`message:${String((event as any).data)}`);
    };
    client.onRealmExit('nodeB/child', () => {
      events.push('exit');
    });
    transport.inject('__seed__', {
      t: 'REALM_EXIT',
      realmId: 'nodeB/child',
      lastPortSeq: 2,
    } as ClusterMessage);
    await flush(3);
    t.deepEqual(events, [], 'exit waits for the promised final message');
    const encodeResult = (result: string) =>
      JSON.stringify(
        (serialize as (value: unknown) => Uint8Array[])(result).map((part) => {
          let raw = '';
          for (const byte of part) raw += String.fromCharCode(byte);
          return btoa(raw);
        }),
      );
    transport.inject('__seed__', {
      t: 'PORT_MSG',
      fromPort: 'nodeB/child',
      toPort: 'nodeA/p-parent',
      payload: encodeResult('second'),
      seq: 2,
    } as ClusterMessage);
    await flush(3);
    t.deepEqual(events, [], 'out-of-order message waits for its predecessor');
    transport.inject('__seed__', {
      t: 'PORT_MSG',
      fromPort: 'nodeB/child',
      toPort: 'nodeA/p-parent',
      payload: encodeResult('first'),
      seq: 1,
    } as ClusterMessage);
    await flush(3);
    t.deepEqual(
      events,
      ['message:first', 'message:second', 'exit'],
      'messages are delivered in order before realm exit',
    );
    client.stop();
  });
});
describe('ClusterClient.spawnRemote — SPAWN_ACK resolves the pending Promise', () => {
  it('resolves with childPortId when SPAWN_ACK ok=true arrives', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    const spawnPromise = client.spawnRemote('nodeA/p-0', {
      entry: './fn.ts',
      root: '/app',
      rules: [],
      bootstrapData: { cliOtel: { endpoint: 'http://collector.example:4318/remote' } },
    });
    // The SPAWN message should have been sent immediately (synchronous in spawnRemote)
    const spawns = transport.sentOfType('SPAWN');
    t.equal(spawns.length, 1, 'one SPAWN sent to seed');
    t.deepEqual(
      spawns[0]?.config.bootstrapData,
      { cliOtel: { endpoint: 'http://collector.example:4318/remote' } },
      'bootstrap metadata is sent with SPAWN',
    );
    const { spawnReqId } = spawns[0]!;
    // Simulate SPAWN_ACK from seed
    transport.inject('__seed__', {
      t: 'SPAWN_ACK',
      spawnReqId,
      childPortId: 'nodeB/0',
      ok: true,
    });
    await flush(3);
    const childPortId = await spawnPromise;
    t.equal(childPortId, 'nodeB/0', 'spawnRemote resolved with correct childPortId');
    client.stop();
  });
  it('rejects when SPAWN_ACK ok=false arrives', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    const spawnPromise = client.spawnRemote('nodeA/p-1', {
      entry: './fn.ts',
      root: '/app',
      rules: [],
    });
    const spawns = transport.sentOfType('SPAWN');
    const { spawnReqId } = spawns[0]!;
    transport.inject('__seed__', {
      t: 'SPAWN_ACK',
      spawnReqId,
      childPortId: '',
      ok: false,
      error: 'no eligible peer',
    });
    await flush(3);
    let threw = false;
    let errorMsg = '';
    try {
      await spawnPromise;
    } catch (e: any) {
      threw = true;
      errorMsg = e.message;
    }
    t.ok(threw, 'spawnRemote rejected on SPAWN_ACK ok=false');
    t.ok(errorMsg.includes('no eligible peer'), 'rejection carries the error message');
    client.stop();
  });
});
describe('ClusterClient.stop() rejects all pending spawnRemote calls', () => {
  it('pending spawnRemote Promises reject when stop() is called', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    // Start a spawn but never send SPAWN_ACK — it stays pending
    const spawnPromise = client.spawnRemote('nodeA/p-2', {
      entry: './fn.ts',
      root: '/app',
      rules: [],
    });
    // Stop immediately, before any ACK arrives
    client.stop();
    let threw = false;
    try {
      await spawnPromise;
    } catch {
      threw = true;
    }
    t.ok(threw, 'pending spawnRemote rejected after stop()');
    t.ok(transport.closeCalled, 'transport.close() called by stop()');
  });
  it('pending spawnRemote has no implicit timeout before stop()', async (t) => {
    const transport = new TestClientTransport('nodeA');
    const client = new ClusterClient(transport as any, 'nodeA');
    client.start();
    const spawnPromise = client.spawnRemote('nodeA/p-3', {
      entry: './fn.ts',
      root: '/app',
      rules: [],
    });
    let settled = false;
    spawnPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush(5);
    t.equal(settled, false, 'spawn remains pending until ack or explicit client stop');
    client.stop();
    try {
      await spawnPromise;
      t.fail('spawnRemote should reject when stop() closes the pending request');
    } catch (err: any) {
      t.ok(
        String(err?.message ?? err).includes('cluster connection closed'),
        'stop rejects pending spawn',
      );
    }
  });
});
