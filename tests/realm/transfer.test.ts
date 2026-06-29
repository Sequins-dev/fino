/**
* Tests for ArrayBuffer transfer across thread-realm boundaries.
*
* Transferred ArrayBuffers are detached on the sender side and reconstructed
* on the receiver side so the data travels without a structured-clone copy.
*
* The round-trip test uses a pool worker (which has __pool_call wiring) to
* echo the received ArrayBuffer back to the parent.
*/
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import { RealmPool } from 'fino:realm/pool';
import type echoFn from './fixtures/echo-fn.ts';
function unsupportedValues(): unknown[] {
  return [
    () => undefined,
    Symbol('unsupported'),
    new WeakMap()
  ];
}
describe('ArrayBuffer transfer via ThreadPort', () => {
  it('detaches the sender ArrayBuffer after postMessage with transfer list', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    const buf = new ArrayBuffer(8);
    const view = new Uint8Array(buf);
    view[0] = 42;
    view[7] = 99;
    // Send via port.postMessage with a transfer list — this exercises the
    // ThreadPort.postMessage → serialize(msg, transferABs) path.
    realm.port.start();
    realm.port.postMessage({ data: buf }, [buf]);
    // The sender's ArrayBuffer must be detached (neutered) immediately.
    t.equal(buf.byteLength, 0, 'sender ArrayBuffer is detached after transfer');
    realm.terminate();
  });
  it('round-trips an ArrayBuffer through a pool call (copy path)', async (t) => {
    // Use the pool echo call() to verify the data arrives on the child side
    // correctly. Pool call() uses structured clone (no transfer), so the AB
    // is copied — but the content must match exactly.
    const pool = new RealmPool<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
      size: 1
    });
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf)[0] = 123;
    new Uint8Array(buf)[3] = 200;
    const result = await pool.call((buf as unknown) as string);
    t.ok(result instanceof ArrayBuffer, 'result is an ArrayBuffer');
    t.equal(new Uint8Array((result as unknown) as ArrayBuffer)[0], 123, 'first byte correct');
    t.equal(new Uint8Array((result as unknown) as ArrayBuffer)[3], 200, 'last byte correct');
    await pool.close();
  });
  it('detaches multiple ArrayBuffers in one postMessage', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    const a = new ArrayBuffer(4);
    new Uint8Array(a)[0] = 10;
    const b = new ArrayBuffer(4);
    new Uint8Array(b)[0] = 20;
    realm.port.start();
    realm.port.postMessage({ data: {
      a,
      b
    } }, [a, b]);
    t.equal(a.byteLength, 0, 'a is detached');
    t.equal(b.byteLength, 0, 'b is detached');
    realm.terminate();
  });
  it('rejects ReadableStream transfer entries explicitly', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    realm.port.start();
    try {
      t.throws(() => realm.port.postMessage('stream transfer', [new ReadableStream() as any]), /transfer|ArrayBuffer|MessagePort|ReadableStream/i, 'thread realm stream transfer rejects synchronously');
    } finally {
      realm.terminate();
    }
  });
  it('rejects unsupported structured-clone payloads synchronously', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    realm.port.start();
    try {
      for (const value of unsupportedValues()) {
        t.throws(() => realm.port.postMessage({ value }), null, 'thread realm rejects unsupported structured-clone payload');
      }
    } finally {
      realm.terminate();
    }
  });
});
describe('Process realm transfer behavior', () => {
  it('round-trips ArrayBuffer data over the process realm port', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/port-echo.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    const buf = new ArrayBuffer(4);
    const view = new Uint8Array(buf);
    view[0] = 7;
    view[3] = 9;
    const reply = new Promise<ArrayBuffer>((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error('timeout')), 5e3);
      realm.port.onmessage = (ev) => {
        clearTimeout(tid);
        resolve((ev as MessageEvent).data.data as ArrayBuffer);
      };
    });
    realm.port.start();
    realm.port.postMessage({
      tag: 1,
      data: buf
    });
    const echoed = new Uint8Array(await reply);
    t.deepEqual(Array.from(echoed), [
      7,
      0,
      0,
      9
    ], 'process realm port preserves ArrayBuffer bytes');
    t.equal(buf.byteLength, 4, 'process realm port copies ArrayBuffer when no transfer list is supplied');
    realm.terminate();
  });
  it('rejects MessagePort transfer to a process realm explicitly', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/port-echo-transfer.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    const { port1, port2 } = new MessageChannel();
    realm.port.start();
    t.throws(() => realm.port.postMessage('use this port', [port1]), /transfer|ArrayBuffer|MessagePort/i, 'process realm MessagePort transfer rejects synchronously');
    realm.terminate();
    port1.close();
    port2.close();
  });
  it('rejects ReadableStream transfer entries explicitly', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/port-echo.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    realm.port.start();
    try {
      t.throws(() => realm.port.postMessage('stream transfer', [new ReadableStream() as any]), /transfer|ArrayBuffer|ReadableStream/i, 'process realm stream transfer rejects synchronously');
    } finally {
      realm.terminate();
    }
  });
  it('rejects unsupported structured-clone payloads synchronously', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/port-echo.ts', import.meta.url).pathname
    });
    realm.run().catch(() => {    /* terminated after test */});
    realm.port.start();
    try {
      for (const value of unsupportedValues()) {
        t.throws(() => realm.port.postMessage({ value }), null, 'process realm rejects unsupported structured-clone payload');
      }
    } finally {
      realm.terminate();
    }
  });
});
