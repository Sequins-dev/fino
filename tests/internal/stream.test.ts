import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
import * as loop from 'internal:runtime/loop';
import {
  BufferedBytesChannelState,
  BytesChannelState,
  UnboundedBytesChannelState,
} from 'internal:stream';
import {
  BufferedBytesChannel,
  BufferedBytesReader,
  BufferedBytesWriter,
  BytesChannel,
  BytesReader,
  BytesWriter,
  Channel,
  FdReader,
  FdWriter,
  Reader,
  UnboundedBytesChannel,
  UnboundedChannel,
  Writer,
} from 'fino:stream';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = os === 'darwin' ? 4 : 2048;
const lib = dlopen(LIBC, {
  pipe: {
    parameters: ['buffer'],
    result: 'i32',
  },
  fcntl: {
    parameters: ['i32', 'i32', 'i32'],
    result: 'i32',
    variadic: 2,
  },
  read: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  write: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  close: {
    parameters: ['i32'],
    result: 'i32',
  },
});
interface TestPipe {
  readFd: number;
  writeFd: number;
  closeRead(): void;
  closeWrite(): void;
}
function makePipe(): TestPipe {
  const fds = new ArrayBuffer(8);
  const rc = lib.symbols.pipe(fds) as number;
  if (rc !== 0) throw new Error('pipe failed');
  const view = new Int32Array(fds);
  const readFd = view[0]!;
  const writeFd = view[1]!;
  for (const fd of [readFd, writeFd]) {
    const flags = lib.symbols.fcntl(fd, F_GETFL, 0) as number;
    if (flags < 0) throw new Error('fcntl get failed');
    if ((lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK) as number) < 0) {
      throw new Error('fcntl set failed');
    }
  }
  let readOpen = true;
  let writeOpen = true;
  return {
    readFd,
    writeFd,
    closeRead() {
      if (!readOpen) return;
      readOpen = false;
      lib.symbols.close(readFd);
    },
    closeWrite() {
      if (!writeOpen) return;
      writeOpen = false;
      lib.symbols.close(writeFd);
    },
  };
}
function rawWrite(fd: number, bytes: Uint8Array): number {
  return lib.symbols.write(fd, bytes, bytes.byteLength) as number;
}
function rawRead(fd: number, maxBytes = 65536): Uint8Array | null {
  const buf = new ArrayBuffer(maxBytes);
  const n = lib.symbols.read(fd, buf, maxBytes) as number;
  if (n > 0) return new Uint8Array(buf).subarray(0, n).slice();
  if (n === 0) return null;
  return new Uint8Array(0);
}
function fillPipe(writeFd: number, maxBytes = 1024 * 1024): number {
  const chunk = patternedBytes(16384);
  let total = 0;
  while (total < maxBytes) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, maxBytes - total));
    const n = rawWrite(writeFd, slice);
    if (n <= 0) return total;
    total += n;
  }
  return total;
}
async function drainUntilDone(
  readFd: number,
  done: () => boolean,
  chunks: Uint8Array[],
): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    let drained = false;
    while (true) {
      const chunk = rawRead(readFd);
      if (chunk === null) return;
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      drained = true;
    }
    if (!drained) await delay(1);
  }
}
async function drainToEof(readFd: number): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < 200; i++) {
    const chunk = rawRead(readFd);
    if (chunk === null) return chunks;
    if (chunk.byteLength === 0) {
      await delay(1);
      continue;
    }
    chunks.push(chunk);
  }
  throw new Error('drainToEof timed out');
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
function patternedBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < out.length; i++) out[i] = i & 255;
  return out;
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withTimeout<T>(promise: Promise<T>, label: string, ms = 2e3): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
class MemoryBytesReader extends BytesReader {
  chunks: Uint8Array[];
  consumed: number[] = [];
  constructor(chunks: Uint8Array[]) {
    super();
    this.chunks = chunks.slice();
  }
  protected async doReadInto(buffer: Uint8Array): Promise<number | null> {
    const chunk = this.chunks.shift();
    if (chunk === undefined) return null;
    const n = Math.min(chunk.byteLength, buffer.byteLength);
    buffer.set(chunk.subarray(0, n));
    if (n < chunk.byteLength) this.chunks.unshift(chunk.subarray(n));
    return n;
  }
  protected onConsume(bytes: number): void {
    this.consumed.push(bytes);
  }
}
class PendingBytesReader extends BytesReader {
  pending: {
    maxBytes: number;
    resolve(value: Uint8Array | null): void;
    reject(error: unknown): void;
  } | null = null;
  protected doReadInto(
    buffer: Uint8Array,
    options?: {
      signal?: AbortSignal | null;
    },
  ): Promise<number | null> {
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise((resolve, reject) => {
      this.pending = {
        maxBytes: buffer.byteLength,
        resolve: (value) => {
          if (value === null) return resolve(null);
          const n = Math.min(value.byteLength, buffer.byteLength);
          buffer.set(value.subarray(0, n));
          resolve(n);
        },
        reject,
      };
      options?.signal?.addEventListener(
        'abort',
        () => {
          if (this.pending === null) return;
          this.pending = null;
          reject(options.signal!.reason);
        },
        { once: true },
      );
    });
  }
}
class MemoryBytesWriter extends BytesWriter {
  chunks: Uint8Array[] = [];
  closeCount = 0;
  constructor() {
    super(() => {
      this.closeCount++;
    });
  }
  protected async doWrite(buf: Uint8Array): Promise<void> {
    this.chunks.push(buf.slice());
  }
}
class RecordingBufferedWriter extends BufferedBytesWriter {
  chunks: Uint8Array[] = [];
  closeCount = 0;
  constructor(bufferSize = 4) {
    super(() => {
      this.closeCount++;
    }, bufferSize);
  }
  protected async doFlush(buf: Uint8Array): Promise<void> {
    this.chunks.push(buf.slice());
  }
}
class CountingWriteBufferedWriter extends RecordingBufferedWriter {
  writeCalls = 0;
  override async write(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    this.writeCalls++;
    await super.write(data);
  }
}
describe('Reader', () => {
  it('uses an async iterable as its pull state and closes it once', async (t) => {
    let closed = 0;
    const reader = Reader.from(
      (async function* () {
        try {
          yield 1;
          yield 2;
        } finally {
          closed++;
        }
      })(),
    );

    t.equal(await reader.read(), 1);
    await Promise.all([reader.close(), reader.close()]);
    t.equal(await reader.read(), null, 'reads after close remain at EOF');
    t.equal(closed, 1, 'the iterable is closed once');
  });
});
describe('Writer', () => {
  it('delegates lifecycle operations to its writable state', async (t) => {
    const events: string[] = [];
    const writer = new Writer<number>({
      async write(value) {
        events.push(`write ${value}`);
      },
      async flush() {
        events.push('flush');
      },
      async closeWriter() {
        events.push('close');
      },
      fail(error) {
        events.push(`fail ${String(error)}`);
      },
    });

    await writer.write(1);
    await writer.flush();
    writer.fail('broken');
    await Promise.all([writer.close(), writer.close()]);
    await t.rejects(() => writer.write(2), /closed/, 'a later write is rejected');
    t.deepEqual(events, ['write 1', 'flush', 'fail broken', 'close']);
  });
});
describe('Channel', () => {
  it('uses stable Reader and Writer prototype methods', (t) => {
    const channel = new Channel<number>();

    t.equal(
      Object.hasOwn(channel.reader, 'read'),
      false,
      'the reader does not replace read in its constructor',
    );
    t.equal(
      Object.hasOwn(channel.writer, 'write'),
      false,
      'the writer does not replace write in its constructor',
    );
  });

  it('wraps async iterable transforms without adding transform channel semantics', async (t) => {
    async function* source() {
      yield 1;
      yield 2;
    }
    async function* double(values: AsyncIterable<number>) {
      for await (const value of values) yield value * 2;
    }

    const reader = Reader.from(double(source()));

    t.deepEqual(
      [await reader.read(), await reader.read(), await reader.read()],
      [2, 4, null],
      'the Reader facade pulls transformed values from the iterable',
    );
  });

  it('holds each write until a reader accepts its value', async (t) => {
    const channel = new Channel<number>();
    let settled = false;
    const write = channel.writer.write(1).then(() => {
      settled = true;
    });

    await delay(0);
    t.equal(settled, false, 'an unread value applies backpressure');
    t.equal(await channel.reader.read(), 1, 'the reader receives the written value');
    await write;
    t.equal(settled, true, 'the write settles after the matching read');
  });

  it('pairs overlapping reads and writes in FIFO order', async (t) => {
    const channel = new Channel<number>();
    const settled: number[] = [];
    const writes = [1, 2, 3].map((value) =>
      channel.writer.write(value).then(() => settled.push(value)),
    );

    await delay(0);
    t.deepEqual(settled, [], 'no write settles before consumption');
    t.equal(await channel.reader.read(), 1, 'the first read receives the first write');
    await writes[0];
    t.deepEqual(settled, [1], 'only the consumed write settles');
    t.deepEqual(
      await Promise.all([channel.reader.read(), channel.reader.read()]),
      [2, 3],
      'later reads preserve write order',
    );
    await Promise.all(writes);
    t.deepEqual(settled, [1, 2, 3], 'writes settle in handoff order');
  });

  it('rejects unread writes when the reader closes', async (t) => {
    const channel = new Channel<number>();
    const first = channel.writer.write(1);
    const second = channel.writer.write(2);

    await channel.reader.close();
    await t.rejects(() => first, /reader.*closed/i, 'the active write is rejected');
    await t.rejects(() => second, /reader.*closed/i, 'the queued write is rejected');
  });

  it('delivers admitted writes before writer close reaches EOF', async (t) => {
    const channel = new Channel<number>();
    const write = channel.writer.write(1);
    const close = channel.writer.close();

    t.equal(await channel.reader.read(), 1, 'the admitted value is delivered');
    await Promise.all([write, close]);
    t.equal(await channel.reader.read(), null, 'EOF follows the admitted value');
  });

  it('propagates failure to pending readers and writes', async (t) => {
    const readChannel = new Channel<number>();
    const read = readChannel.reader.read();
    readChannel.writer.fail(new Error('read failure'));
    await t.rejects(() => read, /read failure/);

    const writeChannel = new Channel<number>();
    const write = writeChannel.writer.write(1);
    writeChannel.writer.fail(new Error('write failure'));
    await t.rejects(() => write, /write failure/);
  });

  it('does not replace a terminal failure with clean EOF', async (t) => {
    const channel = new Channel<number>();
    channel.writer.fail(new Error('terminal failure'));
    await channel.writer.close();

    await t.rejects(() => channel.reader.read(), /terminal failure/);
  });
});
describe('UnboundedChannel', () => {
  it('accepts writes before reads and preserves FIFO order', async (t) => {
    const channel = new UnboundedChannel<number>();
    await Promise.all([channel.writer.write(1), channel.writer.write(2), channel.writer.write(3)]);

    t.deepEqual(
      await Promise.all([channel.reader.read(), channel.reader.read(), channel.reader.read()]),
      [1, 2, 3],
      'buffered values retain write order',
    );
  });

  it('drains accepted values before writer close produces EOF', async (t) => {
    const channel = new UnboundedChannel<number>();
    await channel.writer.write(1);
    await channel.writer.write(2);
    await channel.writer.close();

    t.equal(await channel.reader.read(), 1);
    t.equal(await channel.reader.read(), 2);
    t.equal(await channel.reader.read(), null);
  });
});
describe('BytesReader', () => {
  it('adapts direct chunk sources for structural and readInto operations', async (t) => {
    class DirectChunkReader extends BytesReader {
      chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
      protected doRead(maxBytes: number): Promise<Uint8Array | null> {
        const chunk = this.chunks.shift();
        if (chunk === undefined) return Promise.resolve(null);
        const result = chunk.subarray(0, maxBytes);
        if (result.byteLength < chunk.byteLength) this.chunks.unshift(chunk.subarray(maxBytes));
        return Promise.resolve(result);
      }
    }
    const reader = new DirectChunkReader();
    t.equal(await reader.readByte(), 1);
    const target = new Uint8Array(2);
    t.equal(await reader.readInto(target), 1);
    t.deepEqual([...target], [2, 0]);
  });
  it('keeps a compound read in one state operation', async (t) => {
    const requests: number[] = [];
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    class ControlledBytesReader extends BytesReader {
      protected async doReadInto(buffer: Uint8Array): Promise<number | null> {
        requests.push(buffer.byteLength);
        if (requests.length === 1) {
          markStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        buffer[0] = requests.length;
        return 1;
      }
    }
    const reader = new ControlledBytesReader();
    const exact = reader.readExactly(2);
    const next = reader.read({ maxBytes: 4 });
    await started;
    t.deepEqual(requests, [2], 'the later read cannot enter during readExactly');
    releaseFirst();
    await Promise.all([exact, next]);
    t.deepEqual(requests, [2, 1, 4], 'readExactly retains every source turn it needs');
  });
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
  it('uses destination-filling reads for read() and readInto()', async (t) => {
    class DestinationReader extends BytesReader {
      readonly destinations: Uint8Array[] = [];
      #next = 1;

      protected async doReadInto(buffer: Uint8Array): Promise<number | null> {
        this.destinations.push(buffer);
        buffer[0] = this.#next++;
        return 1;
      }
    }

    const reader = new DestinationReader();
    const first = await reader.read({ maxBytes: 8 });
    const destination = new Uint8Array(4);
    const secondLength = await reader.readInto(destination);
    t.deepEqual([...first!], [1], 'read returns only the filled prefix');
    t.equal(reader.destinations[0]?.byteLength, 8, 'read allocates the requested capacity once');
    t.equal(secondLength, 1, 'readInto returns the filled byte count');
    t.equal(
      reader.destinations[1]?.buffer,
      destination.buffer,
      'readInto preserves the caller backing buffer',
    );
    t.equal(
      reader.destinations[1]?.byteOffset,
      destination.byteOffset,
      'readInto preserves offset',
    );
    t.equal(
      reader.destinations[1]?.byteLength,
      destination.byteLength,
      'readInto preserves length',
    );
    t.equal(destination[0], 2, 'the source fills caller storage directly');
  });
  it('preserves byte offsets when reading into arbitrary views', async (t) => {
    const arena = new Uint8Array(8);
    arena.fill(255);
    const view = new DataView(arena.buffer, 3, 2);
    const reader = new MemoryBytesReader([new Uint8Array([7, 8, 9])]);
    const n = await reader.readInto(view);
    t.equal(n, 2, 'readInto reports bytes written into a DataView');
    t.deepEqual([...arena], [255, 255, 255, 7, 8, 255, 255, 255], 'only the view region changes');
    t.deepEqual([...(await reader.read())!], [9], 'bytes beyond the view remain readable');
  });
  it('supports abortable pending reads without consuming future bytes', async (t) => {
    const reader = new PendingBytesReader();
    const controller = new AbortController();
    const pending = reader.read({
      maxBytes: 1,
      signal: controller.signal,
    });
    controller.abort(new Error('stop-read'));
    await t.rejects(() => pending, /stop-read/, 'aborted read rejects with the abort reason');
    t.equal(reader.pending, null, 'aborted read is removed from the source pending slot');
  });
});
describe('BufferedBytesReader', () => {
  it('peek, scanBuffered, and takeBuffered inspect without over-consuming', async (t) => {
    const reader = BufferedBytesReader.over(
      new MemoryBytesReader([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
    );
    t.deepEqual(
      [...(await reader.peek(3))],
      [1, 2, 3],
      'peek pulls enough bytes without consuming',
    );
    t.equal(reader.buffered, 4, 'peek leaves pulled bytes buffered');
    t.equal(reader.scanBuffered(new Uint8Array([2, 3])), 3, 'scanBuffered matches across chunks');
    t.deepEqual([...reader.takeBuffered(2)], [1, 2], 'takeBuffered consumes only requested bytes');
    t.deepEqual(
      [...(await reader.readExactly(2))!],
      [3, 4],
      'remaining buffered bytes stay readable',
    );
  });
  it('readUntil preserves bytes on short EOF', async (t) => {
    const reader = BufferedBytesReader.over(
      new MemoryBytesReader([new TextEncoder().encode('partial')]),
    );
    t.equal(await reader.readUntil(new Uint8Array([10])), null, 'missing delimiter returns null');
    t.equal(reader.buffered, 7, 'short read keeps bytes buffered');
    t.equal(
      new TextDecoder().decode(reader.takeBuffered(7)),
      'partial',
      'caller can recover buffered bytes',
    );
  });
  it('readUntil consumes through a delimiter', async (t) => {
    const reader = BufferedBytesReader.over(
      new MemoryBytesReader([
        new TextEncoder().encode('hello'),
        new TextEncoder().encode('\nworld'),
      ]),
    );
    const line = await reader.readUntil(new Uint8Array([10]));
    t.equal(new TextDecoder().decode(line!), 'hello\n', 'readUntil includes the delimiter');
    t.equal(
      new TextDecoder().decode(await reader.readExactly(5)!),
      'world',
      'tail bytes remain readable',
    );
  });
  it('readUntil throws when max is exceeded and preserves buffered bytes', async (t) => {
    const reader = BufferedBytesReader.over(
      new MemoryBytesReader([new TextEncoder().encode('abcdef')]),
    );
    await t.rejects(
      () => reader.readUntil(new Uint8Array([10]), 3),
      /max 3 bytes exceeded/,
      'readUntil rejects on max overflow',
    );
    t.equal(reader.buffered, 6, 'overflow does not consume buffered bytes');
    t.equal(
      new TextDecoder().decode(reader.takeBuffered(6)),
      'abcdef',
      'overflow bytes are replayable from the buffer',
    );
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
    t.deepEqual(
      writer.chunks.map((chunk) => [...chunk]),
      [
        [1, 2, 3],
        [2, 3, 4],
        [8, 9],
        [1, 2],
      ],
      'writer normalizes ArrayBuffer, DataView, typed-array, and shared-buffer views',
    );
  });
  it('writev writes selected vectors in order', async (t) => {
    const writer = new MemoryBytesWriter();
    await writer.writev(
      [new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]), new Uint8Array([4])],
      3,
    );
    t.deepEqual(
      writer.chunks.map((chunk) => [...chunk]),
      [[1], [2, 3]],
      'writev skips empty vectors and honors count',
    );
  });
  it('keeps writev in one writer operation', async (t) => {
    const writer = new MemoryBytesWriter();
    const batch = writer.writev([new Uint8Array([1]), new Uint8Array([2])]);
    const single = writer.write(new Uint8Array([3]));
    await Promise.all([batch, single]);
    t.deepEqual(
      writer.chunks.map((chunk) => [...chunk]),
      [[1], [2], [3]],
      'a later write cannot interleave between vectors',
    );
  });
  it('close() is idempotent and rejects writes after close', async (t) => {
    const writer = new MemoryBytesWriter();
    await writer.close();
    await writer.close();
    t.equal(writer.closeCount, 1, 'close callback runs once');
    await t.rejects(() => writer.write(new Uint8Array([1])), /closed/, 'write after close rejects');
  });
});
describe('BytesChannelState', () => {
  it('reserves exactly the destination supplied by readInto', async (t) => {
    const state = new BytesChannelState();
    const backing = new Uint8Array(6);
    const target = new DataView(backing.buffer, 1, 4);
    const read = state.readInto(target);
    const region = await state.reserve();

    t.equal(region.buffer, target.buffer, 'writer receives the reader-owned allocation');
    t.equal(region.byteOffset, target.byteOffset, 'writer receives the exact view offset');
    t.equal(region.byteLength, target.byteLength, 'writer receives the exact view length');
    region.set([1, 2, 3]);
    state.commit(3);
    t.equal(await read, 3);
    t.deepEqual([...backing], [0, 1, 2, 3, 0, 0]);
  });

  it('implements read(n) as allocated readInto sugar', async (t) => {
    const state = new BytesChannelState();
    const read = state.read({ maxBytes: 4 });
    const region = await state.reserve();
    t.equal(region.byteLength, 4, 'read allocates exactly the requested writable region');
    region.set([4, 5]);
    state.commit(2);

    const bytes = await read;
    t.deepEqual([...bytes!], [4, 5]);
    t.equal(bytes!.buffer, region.buffer, 'read returns a view over its original allocation');
  });
});

describe('byte channel endpoints', () => {
  it('exposes the unbuffered rendezvous through BytesReader and BytesWriter', async (t) => {
    const channel = new BytesChannel();
    const read = channel.reader.read(3);
    const write = channel.writer.write(new Uint8Array([1, 2, 3]));
    t.deepEqual([...(await read)!], [1, 2, 3]);
    await write;
  });

  it('uses the same endpoint types for fixed and unbounded buffering', async (t) => {
    const fixed = new BufferedBytesChannel(4);
    await fixed.writer.write(new Uint8Array([1, 2]));
    t.deepEqual([...(await fixed.reader.read())!], [1, 2]);

    const unbounded = new UnboundedBytesChannel(2);
    await unbounded.writer.write(new Uint8Array([3, 4, 5]));
    t.deepEqual([...(await unbounded.reader.read())!], [3, 4]);
    t.deepEqual([...(await unbounded.reader.read())!], [5]);
    t.ok(fixed.reader instanceof BytesReader);
    t.ok(unbounded.writer instanceof BytesWriter);
  });
});

describe('BufferedBytesChannelState', () => {
  it('reserves one full segment and returns committed bytes as a view', async (t) => {
    const state = new BufferedBytesChannelState(4);
    const region = await state.reserve();
    t.equal(region.byteLength, 4, 'reservation exposes the configured segment capacity');
    region.set([1, 2, 3, 99]);
    state.commit(3);

    const bytes = await state.read({ maxBytes: 2 });
    t.deepEqual([...bytes!], [1, 2], 'read returns at most the requested bytes');
    t.equal(bytes!.buffer, region.buffer, 'read returns a view over the committed segment');
  });

  it('does not reuse fixed storage while a returned view is leased', async (t) => {
    const state = new BufferedBytesChannelState(4);
    const first = await state.reserve();
    first.set([1, 2]);
    state.commit(2);
    const leased = await state.read();
    let reserved = false;
    const nextReservation = state.reserve().then((region) => {
      reserved = true;
      return region;
    });
    await Promise.resolve();
    t.equal(reserved, false, 'fixed capacity remains occupied by the returned view');
    t.deepEqual([...leased!], [1, 2], 'leased contents remain stable');

    const nextRead = state.read();
    const second = await nextReservation;
    second[0] = 3;
    state.commit(1);
    t.equal(second.buffer, first.buffer, 'the next read releases the segment for reuse');
    t.deepEqual([...(await nextRead)!], [3]);
  });

  it('releases an uncommitted reservation when the writer closes', async (t) => {
    const state = new BufferedBytesChannelState(4);
    await state.reserve();
    const read = state.read();
    await state.closeWriter();
    t.equal(await read, null, 'an abandoned writable region does not prevent EOF');
    t.throws(() => state.commit(1), /No active/, 'the abandoned reservation is invalid');
  });

  it('grows by capacity-sized segments without waiting for reads', async (t) => {
    const state = new UnboundedBytesChannelState(3);
    const first = await state.reserve();
    first.set([1, 2, 3]);
    state.commit(3);
    const second = await state.reserve();
    second.set([4, 5]);
    state.commit(2);

    t.equal(first.byteLength, 3);
    t.equal(second.byteLength, 3);
    t.ok(first.buffer !== second.buffer, 'producer-ahead storage appends another segment');
    t.deepEqual([...(await state.read())!], [1, 2, 3]);
    t.deepEqual([...(await state.read())!], [4, 5]);
  });

  it('readInto fills arbitrary views across committed segments', async (t) => {
    const state = new UnboundedBytesChannelState(2);
    for (const values of [
      [1, 2],
      [3, 4],
    ]) {
      const region = await state.reserve();
      region.set(values);
      state.commit(values.length);
    }
    const backing = new Uint8Array(6);
    const target = new DataView(backing.buffer, 1, 4);

    t.equal(await state.readInto(target), 4);
    t.deepEqual([...backing], [0, 1, 2, 3, 4, 0]);
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
    t.deepEqual(
      sink.chunks.map((chunk) => [...chunk]),
      [[1, 2]],
      'overflow flushes pending bytes',
    );
    await writer.close();
    t.deepEqual(
      sink.chunks.map((chunk) => [...chunk]),
      [
        [1, 2],
        [3, 4, 5],
      ],
      'close flushes the remaining bytes',
    );
    t.ok(sink.closed, 'closing the buffered wrapper closes the target writer');
  });
  it('flush() and close() are idempotent with no pending bytes', async (t) => {
    const writer = new RecordingBufferedWriter(4);
    await writer.flush();
    await writer.write(new Uint8Array([1, 2]));
    await writer.flush();
    await writer.flush();
    await writer.close();
    await writer.close();
    t.deepEqual(
      writer.chunks.map((chunk) => [...chunk]),
      [[1, 2]],
      'pending bytes flush once',
    );
    t.equal(writer.closeCount, 1, 'close callback runs once');
  });
  it('large writes flush pending bytes first and then bypass the coalesce buffer', async (t) => {
    const writer = new RecordingBufferedWriter(4);
    await writer.write(new Uint8Array([1, 2]));
    await writer.write(new Uint8Array([3, 4, 5, 6]));
    await writer.close();
    t.deepEqual(
      writer.chunks.map((chunk) => [...chunk]),
      [
        [1, 2],
        [3, 4, 5, 6],
      ],
      'large write preserves ordering around short pending write',
    );
  });
  it('writev coalesces small vectors without per-vector public writes', async (t) => {
    const writer = new CountingWriteBufferedWriter(8);
    await writer.writev([
      new Uint8Array([1]),
      new Uint8Array([]),
      new Uint8Array([2, 3]),
      new Uint8Array([4]),
    ]);
    t.equal(writer.writeCalls, 0, 'writev uses the buffered vector path directly');
    t.deepEqual(writer.chunks, [], 'small vectors remain buffered before flush');
    await writer.flush();
    t.deepEqual(
      writer.chunks.map((chunk) => [...chunk]),
      [[1, 2, 3, 4]],
      'small vectors flush as one coalesced chunk',
    );
  });
});
describe('FdReader / FdWriter', { exclusive: true }, () => {
  it('exposes borrowed descriptor metadata', (t) => {
    const reader = new FdReader(0, () => {});
    const writer = new FdWriter(1, () => {});
    t.equal(reader.fd, 0, 'FdReader exposes its borrowed fd');
    t.equal(writer.fd, 1, 'FdWriter exposes its borrowed fd');
  });
  it('DiskFileSystem writers expose FdWriter.writev', async (t) => {
    const fs = new DiskFileSystem();
    const path = `/tmp/fino-stream-writev-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const file = await fs.open(path, 'w');
    try {
      const writer = file.writer();
      t.ok(writer instanceof FdWriter, 'file.writer() returns an FdWriter');
      await writer.writev([new TextEncoder().encode('ab'), new TextEncoder().encode('cd')]);
      await writer.close();
    } finally {
      await file.close();
    }
    try {
      t.equal(
        new TextDecoder().decode(await fs.readFile(path)),
        'abcd',
        'FdWriter.writev writes all vectors in order',
      );
    } finally {
      await fs.unlink(path).catch(() => {});
    }
  });
  it('invalid borrowed descriptors reject reads and writes', async (t) => {
    const reader = new FdReader(-1, () => {});
    const writer = new FdWriter(-1, () => {});
    await t.rejects(() => reader.readAtMost(1), null, 'invalid fd read rejects');
    await t.rejects(
      () => writer.write(new Uint8Array(65536)),
      /write failed/,
      'invalid fd write rejects',
    );
    await reader.close();
    await writer.close().catch(() => {});
  });
  it('FdWriter.writev rejects vector counts over the internal iovec limit', async (t) => {
    const writer = new FdWriter(1, () => {});
    const vecs = Array.from({ length: 17 }, () => new Uint8Array([1]));
    await t.rejects(
      () => writer.writev(vecs),
      /too many vectors/,
      'too many vectors reject before writing',
    );
    await writer.close();
  });
  it('FdReader returns partial reads and EOF from a nonblocking pipe', async (t) => {
    const pipe = makePipe();
    const writer = new FdWriter(pipe.writeFd, () => pipe.closeWrite());
    const reader = new FdReader(pipe.readFd, () => pipe.closeRead());
    try {
      await writer.write(new TextEncoder().encode('abcdef'));
      await writer.close();
      const first = await reader.readAtMost(2);
      const second = await reader.readAtMost(16);
      const eof = await reader.readAtMost(1);
      t.equal(new TextDecoder().decode(first!), 'ab', 'readAtMost returns only requested bytes');
      t.equal(
        new TextDecoder().decode(second!),
        'cdef',
        'remaining pipe bytes are delivered later',
      );
      t.equal(eof, null, 'closed write end produces EOF');
    } finally {
      await reader.close();
      await writer.close().catch(() => {});
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
  it('FdReader waits through EAGAIN until a pipe becomes readable', async (t) => {
    const pipe = makePipe();
    const writer = new FdWriter(pipe.writeFd, () => pipe.closeWrite());
    const reader = new FdReader(pipe.readFd, () => pipe.closeRead());
    try {
      const pending = reader.readAtMost(4);
      await delay(5);
      await writer.write(new TextEncoder().encode('ping'));
      await writer.close();
      const chunk = await pending;
      t.equal(
        new TextDecoder().decode(chunk!),
        'ping',
        'pending read resolves after data is written',
      );
      t.equal(await reader.readAtMost(1), null, 'reader observes EOF after writer closes');
    } finally {
      await reader.close();
      await writer.close().catch(() => {});
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
  it('FdReader close cancels a pending readability watch', async (t) => {
    const pipe = makePipe();
    const reader = new FdReader(pipe.readFd, () => pipe.closeRead());
    const baselineReads = loop._activeHandleCounts().reads;
    try {
      const pending = reader.readAtMost(1);
      await delay(5);
      t.equal(
        loop._activeHandleCounts().reads,
        baselineReads + 1,
        'the empty pipe installs one read watch',
      );
      await reader.close();
      t.equal(await withTimeout(pending, 'closed fd reader'), null, 'the pending read reaches EOF');
      t.equal(
        loop._activeHandleCounts().reads,
        baselineReads,
        'close removes the pending read watch',
      );
    } finally {
      await reader.close();
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
  it('FdReader handles large transfers over a nonblocking pipe', async (t) => {
    const pipe = makePipe();
    const reader = new FdReader(pipe.readFd, () => pipe.closeRead());
    const payload = patternedBytes(256 * 1024);
    try {
      for (let offset = 0; offset < payload.byteLength; offset += 8192) {
        const part = payload.subarray(offset, offset + 8192);
        const pending = reader.readAtMost(part.byteLength);
        t.equal(
          rawWrite(pipe.writeFd, part),
          part.byteLength,
          'raw pipe write accepts one reader chunk',
        );
        const receivedPart = await pending;
        t.deepEqual([...receivedPart!], [...part], 'FdReader delivers each large-transfer chunk');
      }
      pipe.closeWrite();
      const received = payload;
      t.equal(received.byteLength, payload.byteLength, 'large pipe transfer length matches');
      t.deepEqual(
        [...received.subarray(0, 16)],
        [...payload.subarray(0, 16)],
        'large transfer preserves prefix bytes',
      );
      t.deepEqual(
        [...received.subarray(received.byteLength - 16)],
        [...payload.subarray(payload.byteLength - 16)],
        'large transfer preserves suffix bytes',
      );
      t.equal(await reader.readAtMost(1), null, 'reader reaches EOF after large transfer');
    } finally {
      await reader.close();
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
  it('FdWriter retries EAGAIN and completes a large pipe write', async (t) => {
    const pipe = makePipe();
    const writer = new FdWriter(pipe.writeFd, () => pipe.closeWrite());
    const payload = patternedBytes(96 * 1024);
    try {
      const fillerBytes = fillPipe(pipe.writeFd);
      t.ok(fillerBytes > 0, 'pipe was filled before the writer retry');
      let done = false;
      const drained: Uint8Array[] = [];
      const writePromise = writer.write(payload).then(() => {
        done = true;
      });
      await drainUntilDone(pipe.readFd, () => done, drained);
      await withTimeout(writePromise, 'large fd writer retry');
      await writer.close();
      drained.push(...(await drainToEof(pipe.readFd)));
      const received = concat(drained).subarray(fillerBytes);
      t.equal(received.byteLength, payload.byteLength, 'all large write bytes are readable');
      t.deepEqual(
        [...received.subarray(0, 32)],
        [...payload.subarray(0, 32)],
        'large write prefix matches',
      );
      t.deepEqual(
        [...received.subarray(received.byteLength - 32)],
        [...payload.subarray(payload.byteLength - 32)],
        'large write suffix matches',
      );
    } finally {
      await writer.close().catch(() => {});
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
  it('FdWriter close drains a write already waiting on backpressure', async (t) => {
    const pipe = makePipe();
    const writer = new FdWriter(pipe.writeFd, () => pipe.closeWrite());
    const payload = patternedBytes(96 * 1024);
    try {
      const fillerBytes = fillPipe(pipe.writeFd);
      t.ok(fillerBytes > 0, 'pipe was filled before close');
      let done = false;
      const write = writer.write(payload);
      const close = writer.close().then(() => {
        done = true;
      });
      const drained: Uint8Array[] = [];
      await drainUntilDone(pipe.readFd, () => done, drained);
      await withTimeout(Promise.all([write, close]), 'fd writer close drain');
      drained.push(...(await drainToEof(pipe.readFd)));
      t.equal(
        concat(drained).subarray(fillerBytes).byteLength,
        payload.byteLength,
        'close waits for every admitted byte',
      );
    } finally {
      await writer.close().catch(() => {});
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
  it('FdWriter.writev advances cursors after partial nonblocking writes', async (t) => {
    const pipe = makePipe();
    const writer = new FdWriter(pipe.writeFd, () => pipe.closeWrite());
    const vecs = [
      patternedBytes(80 * 1024),
      patternedBytes(96 * 1024).map((byte) => byte ^ 170),
      patternedBytes(112 * 1024).map((byte) => byte ^ 85),
    ];
    const total = vecs.reduce((sum, vec) => sum + vec.byteLength, 0);
    const expected = new Uint8Array(total);
    let offset = 0;
    for (const vec of vecs) {
      expected.set(vec, offset);
      offset += vec.byteLength;
    }
    try {
      const fillerBytes = fillPipe(pipe.writeFd);
      t.ok(fillerBytes > 0, 'pipe was filled before writev retry');
      let done = false;
      const drained: Uint8Array[] = [];
      const writePromise = writer.writev(vecs).then(() => {
        done = true;
      });
      await drainUntilDone(pipe.readFd, () => done, drained);
      await withTimeout(writePromise, 'large fd writev');
      await writer.close();
      drained.push(...(await drainToEof(pipe.readFd)));
      const received = concat(drained).subarray(fillerBytes);
      t.equal(received.byteLength, expected.byteLength, 'writev large transfer length matches');
      t.deepEqual(
        [...received.subarray(0, 32)],
        [...expected.subarray(0, 32)],
        'writev preserves first vector prefix',
      );
      t.deepEqual(
        [...received.subarray(vecs[0]!.byteLength - 16, vecs[0]!.byteLength + 16)],
        [...expected.subarray(vecs[0]!.byteLength - 16, vecs[0]!.byteLength + 16)],
        'writev cursor crosses vector boundary correctly',
      );
      t.deepEqual(
        [...received.subarray(received.byteLength - 32)],
        [...expected.subarray(expected.byteLength - 32)],
        'writev preserves final vector suffix',
      );
    } finally {
      await writer.close().catch(() => {});
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
  it('keeps overlapping callers in order when the buffer fills', async (t) => {
    const seen: number[] = [];
    class SlowSink extends BufferedBytesWriter {
      protected async doFlush(buf: Uint8Array): Promise<void> {
        await delay(1);
        seen.push(...buf);
      }
    }
    const writer = new SlowSink(() => {}, 4);
    // Eight two-byte writes into a four-byte buffer: every third caller has to
    // wait for room, and that is where later callers can take the room it was
    // waiting for and reach the descriptor ahead of it.
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => writer.write(new Uint8Array([index, index]))),
    );
    await writer.flush();
    t.deepEqual(
      seen,
      [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7],
      'bytes leave in call order however often the buffer fills',
    );
  });
  it('never hands doFlush bytes the next write can overwrite', async (t) => {
    const seen: number[][] = [];
    class SlowSink extends BufferedBytesWriter {
      protected async doFlush(buf: Uint8Array): Promise<void> {
        await delay(5);
        seen.push([...buf]);
      }
    }
    const writer = new SlowSink(() => {}, 8);
    await writer.write(new Uint8Array([1, 2, 3, 4]));
    // Flushed but not awaited: the emission is still in flight when the next
    // write lands, and the coalesce buffer refills from offset zero.
    const inFlight = writer.flush();
    await writer.write(new Uint8Array([5, 6, 7, 8]));
    await Promise.all([inFlight, writer.flush()]);
    t.deepEqual(
      seen,
      [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ],
      'each flush emits the bytes it was given, in order',
    );
  });
  it('serializes overlapping unawaited writes through backpressure', async (t) => {
    const pipe = makePipe();
    const writer = new FdWriter(pipe.writeFd, () => pipe.closeWrite());
    // Six independent write/flush pairs started in one turn, the way callers
    // that do not await their writes issue them — a terminal painting frames,
    // a logger. Each is larger than the coalesce buffer, so each is its own
    // emission rather than being merged into a neighbour's.
    const chunks = Array.from({ length: 6 }, (_, index) =>
      new Uint8Array(96 * 1024).fill(index + 1),
    );
    try {
      const fillerBytes = fillPipe(pipe.writeFd);
      t.ok(fillerBytes > 0, 'pipe was filled so the writes have to wait out EAGAIN');
      let done = 0;
      const writes = chunks.map(async (chunk) => {
        await writer.write(chunk);
        await writer.flush();
        done += 1;
      });
      const drained: Uint8Array[] = [];
      await drainUntilDone(pipe.readFd, () => done === chunks.length, drained);
      for (const [index, write] of writes.entries()) {
        await withTimeout(write, `overlapping write ${index}`);
      }
      await writer.close();
      drained.push(...(await drainToEof(pipe.readFd)));
      const received = concat(drained).subarray(fillerBytes);
      const expected = concat(chunks);
      t.equal(received.byteLength, expected.byteLength, 'no write was stranded on a lost wakeup');
      t.ok(
        received.every((byte, index) => byte === expected[index]),
        'partial writes stay in call order instead of interleaving',
      );
    } finally {
      await writer.close().catch(() => {});
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
});
