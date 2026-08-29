import { describe, it } from 'fino:test/test';
import { ChunkBuffer, ChunkBufferClosedError } from 'internal:chunk-buffer';

function values(bytes: Uint8Array | null): number[] | null {
  return bytes === null ? null : Array.from(bytes);
}

describe('ChunkBuffer lifecycle', () => {
  it('copies by default and retains explicitly owned chunks', async (t) => {
    const copied = new ChunkBuffer();
    const source = new Uint8Array([1, 2, 3]);
    await copied.write(source);
    source[0] = 9;
    t.deepEqual(values(await copied.read()), [1, 2, 3], 'default write owns a copy');

    const retained = new ChunkBuffer();
    const owned = new Uint8Array([4, 5, 6]);
    await retained.write(owned, { owned: true });
    owned[0] = 8;
    t.deepEqual(values(await retained.read()), [8, 5, 6], 'owned write retains the view');
  });

  it('splits and coalesces chunks while preserving byte order', async (t) => {
    const buffer = new ChunkBuffer();
    await buffer.write(new Uint8Array([1, 2]));
    await buffer.write(new Uint8Array([3, 4, 5]));
    t.deepEqual(values(await buffer.read(4)), [1, 2, 3, 4]);
    t.equal(buffer.bufferedBytes, 1, 'partial suffix remains buffered');
    t.deepEqual(values(await buffer.read(4)), [5]);
    t.deepEqual(values(await buffer.read(0)), [], 'zero-byte read consumes nothing');
  });

  it('blocks writers at the byte bound and admits them as reads free capacity', async (t) => {
    const buffer = new ChunkBuffer({ maxBufferedBytes: 3 });
    await buffer.write(new Uint8Array([1, 2, 3]));
    let admitted = false;
    const blocked = buffer.write(new Uint8Array([4, 5])).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    t.equal(admitted, false, 'write waits at capacity');
    t.equal(buffer.tryWrite(new Uint8Array([6])), false, 'tryWrite cannot bypass a writer');
    t.deepEqual(values(await buffer.read(2)), [1, 2]);
    await blocked;
    t.equal(buffer.bufferedBytes, 3, 'freed bytes admit the whole pending chunk');
    t.deepEqual(values(await buffer.read(8)), [3, 4, 5]);
  });

  it('drains on close and fails immediately with the original reason', async (t) => {
    const closed = new ChunkBuffer({ maxBufferedBytes: 4 });
    await closed.write(new Uint8Array([1, 2, 3]));
    closed.close();
    closed.fail(new Error('late failure'));
    t.deepEqual(values(await closed.read(2)), [1, 2]);
    t.deepEqual(values(await closed.read(2)), [3]);
    t.equal(await closed.read(), null, 'graceful close reaches EOF after draining');
    await t.rejects(() => closed.write(new Uint8Array([4])), ChunkBufferClosedError);

    const waiting = new ChunkBuffer();
    const pendingClose = waiting.read();
    waiting.close();
    t.equal(await pendingClose, null, 'close settles a waiting reader');

    const failed = new ChunkBuffer();
    await failed.write(new Uint8Array([9]));
    const reason = new Error('transport failed');
    failed.fail(reason);
    let received: unknown;
    try {
      await failed.read();
    } catch (error) {
      received = error;
    }
    t.equal(received, reason, 'failure preserves the exact reason');
    t.equal(failed.bufferedBytes, 0, 'failure releases buffered chunks');

    const pendingFailure = new ChunkBuffer();
    const pendingRead = pendingFailure.read();
    pendingFailure.fail(reason);
    let pendingReason: unknown;
    try {
      await pendingRead;
    } catch (error) {
      pendingReason = error;
    }
    t.equal(pendingReason, reason, 'failure rejects a waiting reader');
  });

  it('settles aborted reads and writes and remains usable', async (t) => {
    const buffer = new ChunkBuffer({ maxBufferedBytes: 2 });
    await buffer.write(new Uint8Array([1, 2]));
    const writeAbort = new AbortController();
    const blockedWrite = buffer.write(new Uint8Array([3]), { signal: writeAbort.signal });
    writeAbort.abort(new Error('cancel write'));
    await t.rejects(() => blockedWrite, /cancel write/);
    t.deepEqual(values(await buffer.read()), [1, 2]);

    const readAbort = new AbortController();
    const blockedRead = buffer.read(1, { signal: readAbort.signal });
    readAbort.abort(new Error('cancel read'));
    await t.rejects(() => blockedRead, /cancel read/);

    const winningReadAbort = new AbortController();
    const read = buffer.read(1, { signal: winningReadAbort.signal });
    await buffer.write(new Uint8Array([4]));
    winningReadAbort.abort(new Error('too late'));
    t.deepEqual(values(await read), [4], 'settlement wins the abort race');
  });

  it('iterator return releases chunks and rejects blocked producers', async (t) => {
    const buffer = new ChunkBuffer({ maxBufferedBytes: 2 });
    await buffer.write(new Uint8Array([1, 2]));
    const blocked = buffer.write(new Uint8Array([3]));
    const rejected = t.rejects(() => blocked, ChunkBufferClosedError);
    await buffer.return();
    await rejected;
    t.equal(buffer.bufferedBytes, 0, 'return releases retained bytes');
    t.deepEqual(await buffer.next(), { done: true, value: undefined });
    await buffer.return();
  });

  it('iterates with the configured partial-read size', async (t) => {
    const buffer = new ChunkBuffer({ maxBufferedBytes: 5, iterationChunkBytes: 2 });
    await buffer.write(new Uint8Array([1, 2, 3, 4, 5]));
    buffer.close();
    const chunks: number[][] = [];
    for await (const chunk of buffer) chunks.push(Array.from(chunk));
    t.deepEqual(chunks, [[1, 2], [3, 4], [5]]);
  });

  it('validates byte bounds and read sizes', (t) => {
    for (const maxBufferedBytes of [0, -1, 1.5, Number.NaN]) {
      t.throws(() => new ChunkBuffer({ maxBufferedBytes }), /maxBufferedBytes/);
    }
    const buffer = new ChunkBuffer({ maxBufferedBytes: 2 });
    t.throws(() => buffer.write(new Uint8Array(3)), /maximum/);
    t.throws(() => buffer.read(-1), /read size/);
  });
});
