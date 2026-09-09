import { describe, it } from 'fino:test/test';
import { reactorPoolStats, currentWorkloadOwner } from 'internal:scheduler-native';
import * as loop from 'internal:runtime/loop';
import { Socket } from 'fino:net/socket';

describe('Native main-thread host', () => {
  it('runs JavaScript on reactors with a native I/O controller', async (t) => {
    t.ok(currentWorkloadOwner() > 0);
    t.equal(reactorPoolStats()?.nativeIo, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    t.ok(currentWorkloadOwner() > 0);
  });
  it('consumes writes and returns stable reads through native completions', async (t) => {
    const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const client = await Socket.connect(listener.address);
    const peer = await listener.accept();
    try {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const written = loop.writeOwned(client.fd, bytes.subarray(1, 3));
      t.equal(bytes.buffer.byteLength, 0, 'submission detaches all source views');
      const received = await loop.readOwned(peer!.fd, 16);
      await written;
      t.deepEqual([...received], [2, 3]);
      const next = loop.writeOwned(client.fd, new Uint8Array([9]));
      t.deepEqual([...(await loop.readOwned(peer!.fd, 16))], [9]);
      await next;
      t.deepEqual([...received], [2, 3], 'later reads do not overwrite previous results');
    } finally {
      client.close();
      peer?.close();
      listener.close();
    }
  });
  it('cancels a pending native read without consuming later input', async (t) => {
    const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const client = await Socket.connect(listener.address);
    const peer = await listener.accept();
    try {
      const controller = new AbortController();
      const reason = new Error('cancel native read');
      const pending = loop.readOwned(peer!.fd, 32, controller.signal);
      const rejected = pending.then(
        () => false,
        (error) => error === reason,
      );
      controller.abort(reason);
      t.equal(await rejected, true);
      const write = loop.writeOwned(client.fd, new Uint8Array([7]));
      t.deepEqual([...(await loop.readOwned(peer!.fd, 32))], [7]);
      await write;
    } finally {
      client.close();
      peer?.close();
      listener.close();
    }
  });
  it('refuses invalid submissions without detaching their buffers', async (t) => {
    const bytes = new Uint8Array([1, 2]);
    t.throws(() => loop.writeOwned(-1, bytes));
    t.equal(bytes.byteLength, 2);
    t.throws(() => loop.readOwned(-1, -1));
    const aborted = new AbortController();
    aborted.abort(new Error('before admission'));
    t.throws(() => loop.writeOwned(-1, bytes, aborted.signal));
    t.equal(bytes.byteLength, 2);
  });
  it('cancels a queued read without disturbing the earlier reader', async (t) => {
    const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const client = await Socket.connect(listener.address);
    const peer = await listener.accept();
    try {
      const first = loop.readOwned(peer!.fd, 1);
      const controller = new AbortController();
      const reason = new Error('cancel queued read');
      const second = loop.readOwned(peer!.fd, 1, controller.signal).then(
        () => false,
        (error) => error === reason,
      );
      controller.abort(reason);
      const write = loop.writeOwned(client.fd, new Uint8Array([7]));
      t.deepEqual([...(await first)], [7]);
      t.equal(await second, true);
      await write;
    } finally {
      client.close();
      peer?.close();
      listener.close();
    }
  });
  it('rejects shared, resizable, and oversized backing stores before transfer', async (t) => {
    const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const client = await Socket.connect(listener.address);
    const peer = await listener.accept();
    try {
      for (const buffer of [new SharedArrayBuffer(8), new ArrayBuffer(8, { maxByteLength: 16 })]) {
        t.throws(() => loop.writeOwned(client.fd, new Uint8Array(buffer)));
        t.equal(buffer.byteLength, 8);
      }
      const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
      t.throws(() => loop.writeOwned(client.fd, oversized.subarray(0, 1)), /admission limit/);
      t.equal(
        oversized.byteLength,
        64 * 1024 * 1024 + 1,
        'budget charges the entire retained backing store',
      );
    } finally {
      client.close();
      peer?.close();
      listener.close();
    }
  });
  it('cancels a backpressured write while retaining native ownership until completion', async (t) => {
    const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const client = await Socket.connect(listener.address);
    const peer = await listener.accept();
    try {
      const controller = new AbortController();
      const reason = new Error('cancel stalled write');
      const bytes = new Uint8Array(16 * 1024 * 1024);
      const writing = loop.writeOwned(client.fd, bytes, controller.signal).then(
        () => false,
        (error) => error === reason,
      );
      t.equal(bytes.byteLength, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort(reason);
      t.equal(await writing, true);
    } finally {
      client.close();
      peer?.close();
      listener.close();
    }
  });
});
