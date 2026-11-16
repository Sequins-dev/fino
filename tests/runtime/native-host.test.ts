/** Reactor-local byte I/O with independent native readiness. */
import { describe, it } from 'fino:test/test';
import { reactorPoolStats, currentWorkloadOwner } from 'internal:scheduler-native';
import { Socket } from 'fino:net/socket';
import { os } from 'fino:process';

describe('Native main-thread readiness host', () => {
  it('runs application JavaScript on reactors', async (t) => {
    t.ok(currentWorkloadOwner() > 0);
    t.equal(reactorPoolStats()?.nativeReadiness, true);
    if (os === 'linux') t.equal(reactorPoolStats()?.ioBackend, 'io_uring');
    await new Promise((resolve) => setTimeout(resolve, 5));
    t.ok(currentWorkloadOwner() > 0);
  });
  it('borrows write storage and reads directly into the caller view', async (t) => {
    const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const client = await Socket.connect(listener.address);
    const peer = await listener.accept();
    try {
      const [, writer] = client.split();
      const [reader] = peer!.split();
      const source = new Uint8Array([1, 2, 3, 4]);
      const target = new Uint8Array([9, 9, 9, 9]);
      await writer.write(source.subarray(1, 3));
      await writer.flush();
      const result = await reader.readInto(target.subarray(1, 3));
      t.equal(result.value, 2);
      t.deepEqual([...target], [9, 2, 3, 9]);
      t.deepEqual([...source], [1, 2, 3, 4], 'writes never detach caller storage');
    } finally {
      client.close();
      peer?.close();
      listener.close();
    }
  });
  it('cancels a readiness wait without consuming later input', async (t) => {
    const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const client = await Socket.connect(listener.address);
    const peer = await listener.accept();
    try {
      const [, writer] = client.split();
      const [reader] = peer!.split();
      const controller = new AbortController();
      const reason = new Error('cancel read');
      const pending = reader.read({ maxBytes: 16, signal: controller.signal });
      const rejected = pending.then(
        () => false,
        (error) => error === reason,
      );
      controller.abort(reason);
      t.equal(await rejected, true);
      await writer.write(new Uint8Array([7]));
      await writer.flush();
      const next = await reader.read(16);
      t.deepEqual([...(next.value ?? [])], [7]);
    } finally {
      client.close();
      peer?.close();
      listener.close();
    }
  });
});
