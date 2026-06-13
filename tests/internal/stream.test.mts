import { describe, it } from 'fino:test/test';
import { BytesReader, BytesWriter } from 'internal:stream';

class MemoryBytesReader extends BytesReader {
  chunks: Uint8Array[];
  consumed: number[] = [];

  constructor(chunks: Uint8Array[]) {
    super();
    this.chunks = chunks.slice();
  }

  protected async doRead(maxBytes: number): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk === undefined) return null;
    if (chunk.byteLength <= maxBytes) return chunk;
    this.chunks.unshift(chunk.subarray(maxBytes));
    return chunk.subarray(0, maxBytes);
  }

  protected onConsume(bytes: number): void {
    this.consumed.push(bytes);
  }
}

class PendingBytesReader extends BytesReader {
  pending: { maxBytes: number; resolve(value: Uint8Array | null): void; reject(error: unknown): void } | null = null;

  protected doRead(maxBytes: number, options?: { signal?: AbortSignal | null }): Promise<Uint8Array | null> {
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise((resolve, reject) => {
      this.pending = { maxBytes, resolve, reject };
      options?.signal?.addEventListener('abort', () => {
        if (this.pending === null) return;
        this.pending = null;
        reject(options.signal!.reason);
      }, { once: true });
    });
  }
}

class MemoryBytesWriter extends BytesWriter {
  chunks: Uint8Array[] = [];

  protected async doWrite(buf: Uint8Array): Promise<void> {
    this.chunks.push(buf.slice());
  }
}

describe('BytesReader', () => {
  it('readAtMost limits returned bytes and preserves the remainder', async (t) => {
    const reader = new MemoryBytesReader([new Uint8Array([1, 2, 3, 4])]);

    const first = await reader.readAtMost(2);
    const second = await reader.read();

    t.deepEqual([...first!], [1, 2], 'readAtMost returns at most the requested bytes');
    t.deepEqual([...second!], [3, 4], 'remaining bytes are readable later');
    t.deepEqual(reader.consumed, [2, 2], 'consume hook follows delivered byte counts');
  });

  it('readExactly reports consumption only after a complete result is delivered', async (t) => {
    const reader = new MemoryBytesReader([new Uint8Array([1, 2])]);

    t.equal(await reader.readExactly(4), null, 'short EOF does not produce a partial result');
    t.deepEqual(reader.consumed, [], 'short read does not report consumption');
    t.deepEqual([...(await reader.read())!], [1, 2], 'partial bytes are replayed after short EOF');
    t.deepEqual(reader.consumed, [2], 'replayed bytes report consumption when delivered');
  });

  it('readInto fills caller storage without over-consuming', async (t) => {
    const reader = new MemoryBytesReader([new Uint8Array([10, 11, 12])]);
    const out = new Uint8Array(2);

    const n = await reader.readInto(out);

    t.equal(n, 2, 'readInto returns the byte count copied');
    t.deepEqual([...out], [10, 11], 'readInto writes into caller storage');
    t.deepEqual([...(await reader.read())!], [12], 'tail byte remains readable');
    t.deepEqual(reader.consumed, [2, 1], 'consume hook matches copied and later delivered bytes');
  });

  it('supports abortable pending reads without consuming future bytes', async (t) => {
    const reader = new PendingBytesReader();
    const controller = new AbortController();
    const pending = reader.read({ maxBytes: 1, signal: controller.signal });

    controller.abort(new Error('stop-read'));

    await t.rejects(() => pending, /stop-read/, 'aborted read rejects with the abort reason');
    t.equal(reader.pending, null, 'aborted read is removed from the source pending slot');
  });
});

describe('BytesWriter', () => {
  it('accepts ArrayBufferView sources with their byte offsets', async (t) => {
    const writer = new MemoryBytesWriter();
    const backing = new Uint8Array([0, 1, 2, 3, 4, 0]);
    const view = new DataView(backing.buffer, 2, 3);
    const shared = new SharedArrayBuffer(4);
    const sharedView = new Uint8Array(shared, 1, 2);
    sharedView.set([8, 9]);

    await writer.write(backing.subarray(1, 4));
    await writer.write(view);
    await writer.write(sharedView);
    await writer.write(backing.buffer.slice(1, 3));

    t.deepEqual(writer.chunks.map((chunk) => [...chunk]), [
      [1, 2, 3],
      [2, 3, 4],
      [8, 9],
      [1, 2],
    ], 'writer normalizes ArrayBuffer, DataView, typed-array, and shared-buffer views');
  });
});
