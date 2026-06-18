import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import {
  BufferedBytesReader,
  BufferedBytesWriter,
  BytesReader,
  BytesWriter,
  FdReader,
  FdWriter,
} from 'fino:stream';

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

describe('BufferedBytesReader', () => {
  it('peek, scanBuffered, and takeBuffered inspect without over-consuming', async (t) => {
    const reader = BufferedBytesReader.over(new MemoryBytesReader([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
    ]));

    t.deepEqual([...(await reader.peek(3))], [1, 2, 3], 'peek pulls enough bytes without consuming');
    t.equal(reader.buffered, 4, 'peek leaves pulled bytes buffered');
    t.equal(reader.scanBuffered(new Uint8Array([2, 3])), 3, 'scanBuffered matches across chunks');
    t.deepEqual([...reader.takeBuffered(2)], [1, 2], 'takeBuffered consumes only requested bytes');
    t.deepEqual([...(await reader.readExactly(2))!], [3, 4], 'remaining buffered bytes stay readable');
  });

  it('readUntil preserves bytes on short EOF', async (t) => {
    const reader = BufferedBytesReader.over(new MemoryBytesReader([
      new TextEncoder().encode('partial'),
    ]));

    t.equal(await reader.readUntil(new Uint8Array([10])), null, 'missing delimiter returns null');
    t.equal(reader.buffered, 7, 'short read keeps bytes buffered');
    t.equal(new TextDecoder().decode(reader.takeBuffered(7)), 'partial', 'caller can recover buffered bytes');
  });

  it('readUntil consumes through a delimiter', async (t) => {
    const reader = BufferedBytesReader.over(new MemoryBytesReader([
      new TextEncoder().encode('hello'),
      new TextEncoder().encode('\nworld'),
    ]));

    const line = await reader.readUntil(new Uint8Array([10]));

    t.equal(new TextDecoder().decode(line!), 'hello\n', 'readUntil includes the delimiter');
    t.equal(new TextDecoder().decode(await reader.readExactly(5)!), 'world', 'tail bytes remain readable');
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

  it('writev writes selected vectors in order', async (t) => {
    const writer = new MemoryBytesWriter();

    await writer.writev([
      new Uint8Array([1]),
      new Uint8Array([]),
      new Uint8Array([2, 3]),
      new Uint8Array([4]),
    ], 3);

    t.deepEqual(writer.chunks.map((chunk) => [...chunk]), [
      [1],
      [2, 3],
    ], 'writev skips empty vectors and honors count');
  });
});

describe('BufferedBytesWriter', () => {
  it('coalesces small writes and flushes on close', async (t) => {
    const sink = new MemoryBytesWriter();
    const writer = BufferedBytesWriter.over(sink, 4);

    await writer.write(new Uint8Array([1]));
    await writer.write(new Uint8Array([2]));
    t.deepEqual(sink.chunks, [], 'small writes stay buffered before flush');

    await writer.write(new Uint8Array([3, 4, 5]));
    t.deepEqual(sink.chunks.map((chunk) => [...chunk]), [[1, 2]], 'overflow flushes pending bytes');

    await writer.close();
    t.deepEqual(sink.chunks.map((chunk) => [...chunk]), [[1, 2], [3, 4, 5]], 'close flushes the remaining bytes');
    t.ok(sink.closed, 'closing the buffered wrapper closes the target writer');
  });
});

describe('FdReader / FdWriter', () => {
  it('exposes borrowed descriptor metadata', (t) => {
    const reader = new FdReader(0, () => {});
    const writer = new FdWriter(1, () => {});

    t.equal(reader.fd, 0, 'FdReader exposes its borrowed fd');
    t.equal(writer.fd, 1, 'FdWriter exposes its borrowed fd');
  });

  it('DiskFileSystem writers expose FdWriter.writev', async (t) => {
    const fs = new DiskFileSystem();
    const path = `/tmp/fino-stream-writev-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const file = await fs.open(path, 'w');
    try {
      const writer = file.writer();
      t.ok(writer instanceof FdWriter, 'file.writer() returns an FdWriter');

      await writer.writev([
        new TextEncoder().encode('ab'),
        new TextEncoder().encode('cd'),
      ]);
      await writer.close();
    } finally {
      await file.close();
    }

    try {
      t.equal(await fs.readFile(path), 'abcd', 'FdWriter.writev writes all vectors in order');
    } finally {
      await fs.unlink(path).catch(() => {});
    }
  });
});
