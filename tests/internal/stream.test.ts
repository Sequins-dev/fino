import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
import { BufferedBytesReader, BufferedBytesWriter, BytesReader, BytesWriter, FdReader, FdWriter } from 'fino:stream';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = os === 'darwin' ? 4 : 2048;
const lib = dlopen(LIBC, {
  pipe: {
    parameters: ['buffer'],
    result: 'i32'
  },
  fcntl: {
    parameters: [
      'i32',
      'i32',
      'i32'
    ],
    result: 'i32',
    variadic: 2
  },
  read: {
    parameters: [
      'i32',
      'buffer',
      'i32'
    ],
    result: 'i32'
  },
  write: {
    parameters: [
      'i32',
      'buffer',
      'i32'
    ],
    result: 'i32'
  },
  close: {
    parameters: ['i32'],
    result: 'i32'
  }
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
    if (lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK) as number < 0) {
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
    }
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
async function drainUntilDone(readFd: number, done: () => boolean, chunks: Uint8Array[]): Promise<void> {
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
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
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
  pending: {
    maxBytes: number;
    resolve(value: Uint8Array | null): void;
    reject(error: unknown): void;
  } | null = null;
  protected doRead(maxBytes: number, options?: {
    signal?: AbortSignal | null;
  }): Promise<Uint8Array | null> {
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise((resolve, reject) => {
      this.pending = {
        maxBytes,
        resolve,
        reject
      };
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
describe('BytesReader', () => {
  it('readAtMost limits returned bytes and preserves the remainder', async (t) => {
    const reader = new MemoryBytesReader([new Uint8Array([
      1,
      2,
      3,
      4
    ])]);
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
    const reader = new MemoryBytesReader([new Uint8Array([
      10,
      11,
      12
    ])]);
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
    const pending = reader.read({
      maxBytes: 1,
      signal: controller.signal
    });
    controller.abort(new Error('stop-read'));
    await t.rejects(() => pending, /stop-read/, 'aborted read rejects with the abort reason');
    t.equal(reader.pending, null, 'aborted read is removed from the source pending slot');
  });
});
describe('BufferedBytesReader', () => {
  it('peek, scanBuffered, and takeBuffered inspect without over-consuming', async (t) => {
    const reader = BufferedBytesReader.over(new MemoryBytesReader([new Uint8Array([1, 2]), new Uint8Array([3, 4])]));
    t.deepEqual([...await reader.peek(3)], [
      1,
      2,
      3
    ], 'peek pulls enough bytes without consuming');
    t.equal(reader.buffered, 4, 'peek leaves pulled bytes buffered');
    t.equal(reader.scanBuffered(new Uint8Array([2, 3])), 3, 'scanBuffered matches across chunks');
    t.deepEqual([...reader.takeBuffered(2)], [1, 2], 'takeBuffered consumes only requested bytes');
    t.deepEqual([...(await reader.readExactly(2))!], [3, 4], 'remaining buffered bytes stay readable');
  });
  it('readUntil preserves bytes on short EOF', async (t) => {
    const reader = BufferedBytesReader.over(new MemoryBytesReader([new TextEncoder().encode('partial')]));
    t.equal(await reader.readUntil(new Uint8Array([10])), null, 'missing delimiter returns null');
    t.equal(reader.buffered, 7, 'short read keeps bytes buffered');
    t.equal(new TextDecoder().decode(reader.takeBuffered(7)), 'partial', 'caller can recover buffered bytes');
  });
  it('readUntil consumes through a delimiter', async (t) => {
    const reader = BufferedBytesReader.over(new MemoryBytesReader([new TextEncoder().encode('hello'), new TextEncoder().encode('\nworld')]));
    const line = await reader.readUntil(new Uint8Array([10]));
    t.equal(new TextDecoder().decode(line!), 'hello\n', 'readUntil includes the delimiter');
    t.equal(new TextDecoder().decode(await reader.readExactly(5)!), 'world', 'tail bytes remain readable');
  });
  it('readUntil throws when max is exceeded and preserves buffered bytes', async (t) => {
    const reader = BufferedBytesReader.over(new MemoryBytesReader([new TextEncoder().encode('abcdef')]));
    await t.rejects(() => reader.readUntil(new Uint8Array([10]), 3), /max 3 bytes exceeded/, 'readUntil rejects on max overflow');
    t.equal(reader.buffered, 6, 'overflow does not consume buffered bytes');
    t.equal(new TextDecoder().decode(reader.takeBuffered(6)), 'abcdef', 'overflow bytes are replayable from the buffer');
  });
});
describe('BytesWriter', () => {
  it('accepts ArrayBufferView sources with their byte offsets', async (t) => {
    const writer = new MemoryBytesWriter();
    const backing = new Uint8Array([
      0,
      1,
      2,
      3,
      4,
      0
    ]);
    const view = new DataView(backing.buffer, 2, 3);
    const shared = new SharedArrayBuffer(4);
    const sharedView = new Uint8Array(shared, 1, 2);
    sharedView.set([8, 9]);
    await writer.write(backing.subarray(1, 4));
    await writer.write(view);
    await writer.write(sharedView);
    await writer.write(backing.buffer.slice(1, 3));
    t.deepEqual(writer.chunks.map((chunk) => [...chunk]), [
      [
        1,
        2,
        3
      ],
      [
        2,
        3,
        4
      ],
      [8, 9],
      [1, 2]
    ], 'writer normalizes ArrayBuffer, DataView, typed-array, and shared-buffer views');
  });
  it('writev writes selected vectors in order', async (t) => {
    const writer = new MemoryBytesWriter();
    await writer.writev([
      new Uint8Array([1]),
      new Uint8Array([]),
      new Uint8Array([2, 3]),
      new Uint8Array([4])
    ], 3);
    t.deepEqual(writer.chunks.map((chunk) => [...chunk]), [[1], [2, 3]], 'writev skips empty vectors and honors count');
  });
  it('close() is idempotent and rejects writes after close', async (t) => {
    const writer = new MemoryBytesWriter();
    await writer.close();
    await writer.close();
    t.equal(writer.closeCount, 1, 'close callback runs once');
    await t.rejects(() => writer.write(new Uint8Array([1])), /closed/, 'write after close rejects');
  });
});
describe('BufferedBytesWriter', () => {
  it('coalesces small writes and flushes on close', async (t) => {
    const sink = new MemoryBytesWriter();
    const writer = BufferedBytesWriter.over(sink, 4);
    await writer.write(new Uint8Array([1]));
    await writer.write(new Uint8Array([2]));
    t.deepEqual(sink.chunks, [], 'small writes stay buffered before flush');
    await writer.write(new Uint8Array([
      3,
      4,
      5
    ]));
    t.deepEqual(sink.chunks.map((chunk) => [...chunk]), [[1, 2]], 'overflow flushes pending bytes');
    await writer.close();
    t.deepEqual(sink.chunks.map((chunk) => [...chunk]), [[1, 2], [
      3,
      4,
      5
    ]], 'close flushes the remaining bytes');
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
    t.deepEqual(writer.chunks.map((chunk) => [...chunk]), [[1, 2]], 'pending bytes flush once');
    t.equal(writer.closeCount, 1, 'close callback runs once');
  });
  it('large writes flush pending bytes first and then bypass the coalesce buffer', async (t) => {
    const writer = new RecordingBufferedWriter(4);
    await writer.write(new Uint8Array([1, 2]));
    await writer.write(new Uint8Array([
      3,
      4,
      5,
      6
    ]));
    await writer.close();
    t.deepEqual(writer.chunks.map((chunk) => [...chunk]), [[1, 2], [
      3,
      4,
      5,
      6
    ]], 'large write preserves ordering around short pending write');
  });
  it('writev coalesces small vectors without per-vector public writes', async (t) => {
    const writer = new CountingWriteBufferedWriter(8);
    await writer.writev([
      new Uint8Array([1]),
      new Uint8Array([]),
      new Uint8Array([2, 3]),
      new Uint8Array([4])
    ]);
    t.equal(writer.writeCalls, 0, 'writev uses the buffered vector path directly');
    t.deepEqual(writer.chunks, [], 'small vectors remain buffered before flush');
    await writer.flush();
    t.deepEqual(writer.chunks.map((chunk) => [...chunk]), [[1, 2, 3, 4]], 'small vectors flush as one coalesced chunk');
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
      t.equal(new TextDecoder().decode(await fs.readFile(path)), 'abcd', 'FdWriter.writev writes all vectors in order');
    } finally {
      await fs.unlink(path).catch(() => {});
    }
  });
  it('invalid borrowed descriptors reject reads and writes', async (t) => {
    const reader = new FdReader(-1, () => {});
    const writer = new FdWriter(-1, () => {});
    await t.rejects(() => reader.readAtMost(1), null, 'invalid fd read rejects');
    await t.rejects(() => writer.write(new Uint8Array(65536)), /write failed/, 'invalid fd write rejects');
    await reader.close();
    await writer.close().catch(() => {});
  });
  it('FdWriter.writev rejects vector counts over the internal iovec limit', async (t) => {
    const writer = new FdWriter(1, () => {});
    const vecs = Array.from({ length: 17 }, () => new Uint8Array([1]));
    await t.rejects(() => writer.writev(vecs), /too many vectors/, 'too many vectors reject before writing');
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
      t.equal(new TextDecoder().decode(second!), 'cdef', 'remaining pipe bytes are delivered later');
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
      t.equal(new TextDecoder().decode(chunk!), 'ping', 'pending read resolves after data is written');
      t.equal(await reader.readAtMost(1), null, 'reader observes EOF after writer closes');
    } finally {
      await reader.close();
      await writer.close().catch(() => {});
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
        t.equal(rawWrite(pipe.writeFd, part), part.byteLength, 'raw pipe write accepts one reader chunk');
        const receivedPart = await pending;
        t.deepEqual([...receivedPart!], [...part], 'FdReader delivers each large-transfer chunk');
      }
      pipe.closeWrite();
      const received = payload;
      t.equal(received.byteLength, payload.byteLength, 'large pipe transfer length matches');
      t.deepEqual([...received.subarray(0, 16)], [...payload.subarray(0, 16)], 'large transfer preserves prefix bytes');
      t.deepEqual([...received.subarray(received.byteLength - 16)], [...payload.subarray(payload.byteLength - 16)], 'large transfer preserves suffix bytes');
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
      drained.push(...await drainToEof(pipe.readFd));
      const received = concat(drained).subarray(fillerBytes);
      t.equal(received.byteLength, payload.byteLength, 'all large write bytes are readable');
      t.deepEqual([...received.subarray(0, 32)], [...payload.subarray(0, 32)], 'large write prefix matches');
      t.deepEqual([...received.subarray(received.byteLength - 32)], [...payload.subarray(payload.byteLength - 32)], 'large write suffix matches');
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
      patternedBytes(112 * 1024).map((byte) => byte ^ 85)
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
      drained.push(...await drainToEof(pipe.readFd));
      const received = concat(drained).subarray(fillerBytes);
      t.equal(received.byteLength, expected.byteLength, 'writev large transfer length matches');
      t.deepEqual([...received.subarray(0, 32)], [...expected.subarray(0, 32)], 'writev preserves first vector prefix');
      t.deepEqual([...received.subarray(vecs[0]!.byteLength - 16, vecs[0]!.byteLength + 16)], [...expected.subarray(vecs[0]!.byteLength - 16, vecs[0]!.byteLength + 16)], 'writev cursor crosses vector boundary correctly');
      t.deepEqual([...received.subarray(received.byteLength - 32)], [...expected.subarray(expected.byteLength - 32)], 'writev preserves final vector suffix');
    } finally {
      await writer.close().catch(() => {});
      pipe.closeRead();
      pipe.closeWrite();
    }
  });
});
