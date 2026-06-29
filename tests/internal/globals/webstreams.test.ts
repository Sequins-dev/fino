import { describe, it } from 'fino:test/test';

type ReadableStreamWithFrom = typeof ReadableStream & {
  from<T>(iterable: AsyncIterable<T> | Iterable<T>): ReadableStream<T>;
};
type WritableControllerWithAbortReason = WritableStreamDefaultController & {
  abortReason?: unknown;
};
type SymbolRecord = Record<symbol, unknown>;
const ReadableStreamCtor = ReadableStream as ReadableStreamWithFrom;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadable<T>(chunks: Iterable<T>) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(readable: AsyncIterable<T>) {
  const results: T[] = [];
  for await (const chunk of readable) results.push(chunk);
  return results;
}

function makeSinkWritable<T = unknown>() {
  const chunks: T[] = [];
  let closedResolve: (() => void) | undefined;
  const closed = new Promise<void>(r => { closedResolve = r; });
  const stream = new WritableStream({
    write(chunk) { chunks.push(chunk); },
    close() { closedResolve?.(); },
  });
  return { stream, chunks, closed };
}

// ---------------------------------------------------------------------------

describe('ReadableStream basics', () => {
  it('source-backed — getReader + read chunks', async (t) => {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.close();
      },
    });

    const reader = rs.getReader();
    t.deepEqual(await reader.read(), { done: false, value: 'a' });
    t.deepEqual(await reader.read(), { done: false, value: 'b' });
    t.deepEqual(await reader.read(), { done: true,  value: undefined });
    reader.releaseLock();
    t.ok(true, 'no throw');
  });

  it('source-backed — async iteration', async (t) => {
    const rs = makeReadable([1, 2, 3]);
    t.deepEqual(await collect(rs), [1, 2, 3]);
  });

  it('ReadableStream.from() — async iterable fast path', async (t) => {
    async function* gen() { yield 'x'; yield 'y'; }
    const rs = ReadableStreamCtor.from(gen());
    t.deepEqual(await collect(rs), ['x', 'y']);
  });

  it('ReadableStream.from() — array iteration', async (t) => {
    async function* gen() { for (const x of [10, 20, 30]) yield x; }
    const rs = ReadableStreamCtor.from(gen());
    t.deepEqual(await collect(rs), [10, 20, 30]);
  });

  it('locked after getReader()', (t) => {
    const rs = makeReadable([1]);
    const reader = rs.getReader();
    t.ok(rs.locked, 'locked');
    reader.releaseLock();
    t.ok(!rs.locked, 'unlocked after release');
  });

  it('getReader() throws if already locked', (t) => {
    const rs = makeReadable([]);
    rs.getReader();
    t.throws(() => rs.getReader(), /locked/, 'throws');
  });

  it('[Symbol.asyncIterator] throws if locked', (t) => {
    const rs = makeReadable([]);
    rs.getReader();
    t.throws(() => rs[Symbol.asyncIterator](), /locked/, 'throws');
  });

  it('[Symbol.asyncIterator] return() cancels the stream by default', async (t) => {
    let cancelReason: unknown;
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('first');
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });

    const iter = rs[Symbol.asyncIterator]();
    t.deepEqual(await iter.next(), { done: false, value: 'first' });
    await iter.return?.('stop');
    t.equal(cancelReason, 'stop', 'early iterator return forwards cancel reason');
    t.ok(!rs.locked, 'return releases the stream lock');
  });

  it('values({ preventCancel: true }) releases the lock without canceling', async (t) => {
    let cancelCount = 0;
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('first');
      },
      cancel() {
        cancelCount++;
      },
    });

    const iter = rs.values({ preventCancel: true });
    t.deepEqual(await iter.next(), { done: false, value: 'first' });
    await iter.return?.('stop');
    t.equal(cancelCount, 0, 'preventCancel suppresses source cancel');
    t.ok(!rs.locked, 'return releases the stream lock');
  });

  it('pull is called when queue is empty', async (t) => {
    let pullCount = 0;
    const values = [1, 2, 3];
    const rs = new ReadableStream({
      pull(controller) {
        if (values.length > 0) {
          controller.enqueue(values.shift());
        } else {
          controller.close();
        }
        pullCount++;
      },
    });
    const result = await collect(rs);
    t.deepEqual(result, [1, 2, 3]);
    t.ok(pullCount >= 3, 'pull called at least 3 times');
  });

  it('cancel() resolves and calls underlyingSource.cancel', async (t) => {
    let cancelReason = null;
    const rs = new ReadableStream({
      cancel(reason) { cancelReason = reason; },
    });
    await rs.cancel('stop');
    t.equal(cancelReason, 'stop', 'cancel reason forwarded');
  });

  it('ReadableStreamDefaultReader.closed resolves when stream closes', async (t) => {
    const rs = makeReadable(['x']);
    const reader = rs.getReader();
    let closedResolved = false;
    reader.closed.then(() => { closedResolved = true; });
    await reader.read(); // 'x'
    await reader.read(); // done
    await Promise.resolve();
    await Promise.resolve();
    t.ok(closedResolved, 'closed promise resolved');
    reader.releaseLock();
  });
});

describe('ReadableStream tee', () => {
  it('tee() splits into two branches', async (t) => {
    const rs = makeReadable(['a', 'b', 'c']);
    const [b1, b2] = rs.tee();
    const [r1, r2] = await Promise.all([collect(b1), collect(b2)]);
    t.deepEqual(r1, ['a', 'b', 'c'], 'branch 1');
    t.deepEqual(r2, ['a', 'b', 'c'], 'branch 2');
  });

  it('tee() throws if locked', (t) => {
    const rs = makeReadable([]);
    rs.getReader();
    t.throws(() => rs.tee(), /locked/, 'throws when locked');
  });

  it('byte tee() does not pull until a branch reads', async (t) => {
    let pullCount = 0;
    const rs = new ReadableStream({
      type: 'bytes',
      pull() {
        pullCount++;
      },
    });
    rs.tee();

    await Promise.resolve();
    await Promise.resolve();

    t.equal(pullCount, 0, 'source pull is lazy');
  });

  it('byte tee() creates BYOB-capable branches with cloned chunks', async (t) => {
    let pullCount = 0;
    const enqueuedChunk = new Uint8Array([0x41]);
    const rs = new ReadableStream({
      type: 'bytes',
      pull(controller) {
        pullCount++;
        if (pullCount === 1) controller.enqueue(enqueuedChunk);
      },
    });
    const [branch1, branch2] = rs.tee();
    const reader1 = branch1.getReader({ mode: 'byob' });
    const reader2 = branch2.getReader();

    const [result1, result2] = await Promise.all([
      reader1.read(new Uint8Array(1)),
      reader2.read(),
    ]);

    t.equal(result1.done, false, 'BYOB branch receives a chunk');
    t.equal(result2.done, false, 'default branch receives a chunk');
    t.deepEqual(Array.from(result1.value!), [0x41], 'BYOB branch bytes');
    t.deepEqual(Array.from(result2.value!), [0x41], 'default branch bytes');
    t.notEqual(result1.value!.buffer, result2.value!.buffer, 'branch buffers are distinct');
    t.notEqual(result1.value!.buffer, enqueuedChunk.buffer, 'branch1 does not reuse source buffer');
    t.notEqual(result2.value!.buffer, enqueuedChunk.buffer, 'branch2 does not reuse source buffer');

    reader1.releaseLock();
    reader2.releaseLock();
  });
});

describe('WritableStream', () => {
  it('sink-backed — getWriter + write + close', async (t) => {
    const { stream, chunks, closed } = makeSinkWritable();
    const writer = stream.getWriter();
    await writer.write('hello');
    await writer.write('world');
    await writer.close();
    await closed;
    t.deepEqual(chunks, ['hello', 'world'], 'chunks received in order');
  });

  it('locked after getWriter()', (t) => {
    const { stream } = makeSinkWritable();
    const writer = stream.getWriter();
    t.ok(stream.locked, 'locked');
    writer.releaseLock();
    t.ok(!stream.locked, 'unlocked after release');
  });

  it('getWriter() throws if already locked', (t) => {
    const { stream } = makeSinkWritable();
    stream.getWriter();
    t.throws(() => stream.getWriter(), /locked/, 'throws');
  });

  it('writes are serialized (not concurrent)', async (t) => {
    const order: string[] = [];
    const stream = new WritableStream({
      write(chunk) {
        order.push(`start:${chunk}`);
        return new Promise(r => setTimeout(r, 0)).then(() => {
          order.push(`end:${chunk}`);
        });
      },
    });
    const writer = stream.getWriter();
    const p1 = writer.write(1);
    const p2 = writer.write(2);
    await Promise.all([p1, p2]);
    t.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2'], 'serialized');
  });

  it('abort() puts stream into errored state', async (t) => {
    const { stream } = makeSinkWritable();
    await stream.abort(new Error('oops'));
    const writer = stream.getWriter();
    let threw = false;
    try { await writer.write('x'); } catch (_) { threw = true; }
    t.ok(threw, 'write after abort throws');
    writer.releaseLock();
  });
});

describe('pipeTo', () => {
  it('source to sink', async (t) => {
    const { stream, chunks, closed } = makeSinkWritable();
    await makeReadable([1, 2, 3]).pipeTo(stream);
    await closed;
    t.deepEqual(chunks, [1, 2, 3], 'all chunks piped');
  });

  it('prevents duplicate consumption', async (t) => {
    const rs = makeReadable([1]);
    const { stream: ws1 } = makeSinkWritable();
    ws1.getWriter(); // lock ws1
    let threw = false;
    try { await rs.pipeTo(ws1); } catch (_) { threw = true; }
    t.ok(threw, 'throws because WritableStream is locked');
  });

  it('iterable→sink uses general pump', async (t) => {
    const { stream, chunks } = makeSinkWritable();
    async function* gen() { yield 'a'; yield 'b'; }
    await ReadableStreamCtor.from(gen()).pipeTo(stream);
    t.deepEqual(chunks, ['a', 'b'], 'chunks received');
  });

  it('preventClose keeps writable open', async (t) => {
    const chunks: string[] = [];
    let closeCalled = false;
    const ws = new WritableStream({
      write(chunk) { chunks.push(chunk); },
      close() { closeCalled = true; },
    });
    await makeReadable(['x']).pipeTo(ws, { preventClose: true });
    t.ok(!closeCalled, 'close not called');
    t.deepEqual(chunks, ['x'], 'chunk received');
  });

  it('multiple chunks, stream closes', async (t) => {
    const received: number[] = [];
    let closedCount = 0;
    const ws = new WritableStream({
      write(c) { received.push(c); },
      close() { closedCount++; },
    });
    await makeReadable([10, 20, 30]).pipeTo(ws);
    t.deepEqual(received, [10, 20, 30]);
    t.equal(closedCount, 1, 'close called once');
  });

  it('does not observe Object.prototype.then on read result records', async (t) => {
    const intercepted: unknown[] = [];
    const originalThen = Object.prototype.then;
    try {
      Object.prototype.then = function interceptedThen(resolve: (value: unknown) => void) {
        if (!(this as { done?: boolean }).done) {
          intercepted.push((this as { value?: unknown }).value);
        }
        const result = Object.create(null);
        result.done = true;
        result.value = undefined;
        resolve(result);
      };
      const received: string[] = [];
      const ws = new WritableStream<string>({
        write(chunk) { received.push(chunk); },
      });
      await makeReadable(['a']).pipeTo(ws);

      t.deepEqual(intercepted, [], 'then was not intercepted');
      t.deepEqual(received, ['a'], 'chunk was written');
    } finally {
      if (originalThen === undefined) delete Object.prototype.then;
      else Object.prototype.then = originalThen;
    }
  });

  it('reads pipeTo options in spec order', async (t) => {
    const touched: string[] = [];
    const options = {
      get preventAbort() { touched.push('preventAbort'); return false; },
      get preventCancel() { touched.push('preventCancel'); return false; },
      get preventClose() { touched.push('preventClose'); return false; },
      get signal() { touched.push('signal'); return undefined; },
    };
    const ws = new WritableStream();
    await makeReadable([]).pipeTo(ws, options);
    t.deepEqual(touched, ['preventAbort', 'preventCancel', 'preventClose', 'signal']);
  });

  it('AbortSignal cancels mid-stream', async (t) => {
    const { AbortController } = globalThis;
    const controller = new AbortController();

    const received = [];
    let errorReason = null;

    const ws = new WritableStream({
      write(c) {
        received.push(c);
        if (received.length === 1) controller.abort(new Error('stop'));
      },
    });

    const rs = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(1);
        ctrl.enqueue(2);
        ctrl.enqueue(3);
        ctrl.close();
      },
    });

    try {
      await rs.pipeTo(ws, { signal: controller.signal });
    } catch (e) {
      errorReason = e;
    }

    t.ok(errorReason != null, 'throws on abort');
    t.ok(received.length >= 1, 'at least one chunk received');
  });
});

describe('TransformStream / pipeThrough', () => {
  it('identity (no transformer) passes chunks through', async (t) => {
    const ts = new TransformStream();
    const readable = makeReadable([1, 2, 3]).pipeThrough(ts);
    t.deepEqual(await collect(readable), [1, 2, 3]);
  });

  it('transform function applied to each chunk', async (t) => {
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk * 2);
      },
    });
    const readable = makeReadable([1, 2, 3]).pipeThrough(ts);
    t.deepEqual(await collect(readable), [2, 4, 6]);
  });

  it('transformer methods are called with the transformer as this', async (t) => {
    class PrefixTransformer {
      prefix = 'x:';

      transform(chunk: string, controller: TransformStreamDefaultController) {
        controller.enqueue(this.prefix + chunk);
      }

      flush(controller: TransformStreamDefaultController) {
        controller.enqueue(this.prefix + 'done');
      }
    }

    const ts = new TransformStream(new PrefixTransformer());
    const writer = ts.writable.getWriter();
    const output = collect(ts.readable);
    await writer.write('a');
    await writer.close();
    t.deepEqual(await output, ['x:a', 'x:done']);
  });

  it('readable strategy size runs synchronously during transform enqueue', async (t) => {
    let sizeCalls = 0;
    const ts = new TransformStream(undefined, undefined, {
      highWaterMark: Infinity,
      size() {
        sizeCalls++;
        return 1;
      },
    });
    const writer = ts.writable.getWriter();
    const write = writer.write('a');
    t.equal(sizeCalls, 1, 'size is called before write settles');
    await write;
    await writer.close();
    t.deepEqual(await collect(ts.readable), ['a']);
  });

  it('readable strategy size can enqueue reentrantly', async (t) => {
    let controller: TransformStreamDefaultController | undefined;
    let calls = 0;
    const ts = new TransformStream({
      start(c) { controller = c; },
    }, undefined, {
      highWaterMark: Infinity,
      size() {
        calls++;
        if (calls === 1) controller!.enqueue('b');
        return 1;
      },
    });

    const writer = ts.writable.getWriter();
    await writer.write('a');
    await writer.close();
    t.deepEqual(await collect(ts.readable), ['b', 'a']);
  });

  it('readable strategy size can terminate or error reentrantly', async (t) => {
    let terminateController: TransformStreamDefaultController | undefined;
    const terminated = new TransformStream({
      start(c) { terminateController = c; },
    }, undefined, {
      highWaterMark: Infinity,
      size() {
        terminateController!.terminate();
        return 1;
      },
    });
    const terminatedWriter = terminated.writable.getWriter();
    await terminatedWriter.write('a');
    t.deepEqual(await collect(terminated.readable), [], 'terminated readable has no chunks');

    const error = new Error('boom');
    let errorController: TransformStreamDefaultController | undefined;
    const errored = new TransformStream({
      start(c) { errorController = c; },
    }, undefined, {
      highWaterMark: Infinity,
      size() {
        errorController!.error(error);
        return 1;
      },
    });
    const erroredWriter = errored.writable.getWriter();
    await erroredWriter.write('a');
    const reader = errored.readable.getReader();
    await t.rejects(() => reader.read(), error, 'readable errors reentrantly');
  });

  it('readable strategy size can create demand for a pending transform write', async (t) => {
    let controller: TransformStreamDefaultController | undefined;
    let reader: ReadableStreamDefaultReader;
    let readPromise: Promise<ReadableStreamReadResult<string>> | undefined;
    let sizeCalls = 0;
    const ts = new TransformStream({
      start(c) { controller = c; },
    }, undefined, {
      highWaterMark: 0,
      size() {
        readPromise = reader.read() as Promise<ReadableStreamReadResult<string>>;
        sizeCalls++;
        return 1;
      },
    });
    reader = ts.readable.getReader();
    const writer = ts.writable.getWriter();
    let writeResolved = false;
    const writePromise = writer.write('b').then(() => { writeResolved = true; });
    await Promise.resolve();
    await Promise.resolve();
    t.equal(writeResolved, false, 'write waits for readable demand');

    controller!.enqueue('a');
    t.equal(sizeCalls, 1, 'size called only for the manual enqueue');
    await writePromise;
    t.equal(writeResolved, true, 'write resolves after reentrant read creates demand');
    const read = await readPromise!;
    t.equal(read.done, false, 'reentrant read receives a chunk');
    t.equal(read.value, 'b', 'pending transform write wins the reentrant read');
  });

  it('flush called at end of stream', async (t) => {
    let flushed = false;
    const ts = new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
      flush(controller) { flushed = true; controller.enqueue('END'); },
    });
    const readable = makeReadable(['a', 'b']).pipeThrough(ts);
    t.deepEqual(await collect(readable), ['a', 'b', 'END']);
    t.ok(flushed, 'flush was called');
  });

  it('start called with controller', async (t) => {
    let startedWith = null;
    const ts = new TransformStream({
      start(controller) { startedWith = controller; controller.enqueue('FIRST'); },
      transform(chunk, controller) { controller.enqueue(chunk); },
    });
    const readable = makeReadable(['a']).pipeThrough(ts);
    t.deepEqual(await collect(readable), ['FIRST', 'a']);
    t.ok(startedWith != null, 'start called');
  });

  it('pipeThrough returns the transform readable', (t) => {
    const ts = new TransformStream();
    const result = makeReadable([]).pipeThrough(ts);
    t.ok(result instanceof ReadableStream, 'returns ReadableStream');
    t.ok(result === ts.readable, 'is the transform readable');
  });

  it('pipeThrough throws if source is locked', (t) => {
    const rs = makeReadable([]);
    rs.getReader();
    t.throws(() => rs.pipeThrough(new TransformStream()), /locked/, 'throws');
  });

  it('pipeThrough validates readable before accessing writable', (t) => {
    const rs = new ReadableStream();
    let writableAccessed = false;
    t.throws(
      () => rs.pipeThrough({
        readable: null as unknown as ReadableStream,
        get writable() {
          writableAccessed = true;
          return new WritableStream();
        },
      }),
      /ReadableStream/,
      'invalid readable throws',
    );
    t.equal(writableAccessed, false, 'writable getter is not accessed');
  });

  it('pipeThrough rejects invalid signal values synchronously', (t) => {
    const rs = new ReadableStream();
    t.throws(
      () => rs.pipeThrough(new TransformStream(), { signal: null as unknown as AbortSignal }),
      /AbortSignal/,
      'null signal throws',
    );
    t.throws(
      () => rs.pipeThrough(new TransformStream(), { signal: Object.create(AbortSignal.prototype) }),
      /AbortSignal/,
      'unbranded AbortSignal prototype object throws',
    );
  });

  it('pipeThrough uses the internal pipe algorithm, not patched pipeTo methods', (t) => {
    let called = false;
    const originalPipeTo = ReadableStream.prototype.pipeTo;
    try {
      ReadableStream.prototype.pipeTo = function patchedPipeTo() {
        called = true;
        return undefined as unknown as Promise<void>;
      };
      const readable = new ReadableStream();
      const writable = new WritableStream();
      const result = new ReadableStream().pipeThrough({ readable, writable });
      t.equal(result, readable, 'returns transform readable');
      t.equal(called, false, 'patched pipeTo was not called');
    } finally {
      ReadableStream.prototype.pipeTo = originalPipeTo;
    }
  });
});

describe('Queuing strategies', () => {
  it('CountQueuingStrategy: highWaterMark and size', (t) => {
    const s = new CountQueuingStrategy({ highWaterMark: 4 });
    t.equal(s.highWaterMark, 4, 'highWaterMark');
    t.equal(s.size('anything'), 1, 'size always 1');
    t.equal(s.size(42), 1, 'size always 1 regardless of chunk type');
  });

  it('queuing strategy constructors require an object with highWaterMark', (t) => {
    for (const Strategy of [CountQueuingStrategy, ByteLengthQueuingStrategy]) {
      t.throws(() => new Strategy(undefined as any), TypeError, `${Strategy.name} rejects undefined`);
      t.throws(() => new Strategy(null as any), TypeError, `${Strategy.name} rejects null`);
      t.throws(() => new Strategy(true as any), TypeError, `${Strategy.name} rejects primitive`);
      t.throws(() => new Strategy({} as any), TypeError, `${Strategy.name} rejects missing highWaterMark`);
    }
  });

  it('ByteLengthQueuingStrategy: highWaterMark and size', (t) => {
    const s = new ByteLengthQueuingStrategy({ highWaterMark: 16384 });
    t.equal(s.highWaterMark, 16384, 'highWaterMark');
    const chunk = new Uint8Array(128);
    t.equal(s.size(chunk), 128, 'size = chunk.byteLength');
  });
});

describe('ReadableStream desiredSize', () => {
  it('CountQueuingStrategy: desiredSize tracks queue', async (t) => {
    let ctrl: ReadableStreamDefaultController<string> | undefined;
    const rs = new ReadableStream(
      { start(c) { ctrl = c; } },
      new CountQueuingStrategy({ highWaterMark: 3 }),
    );
    if (!ctrl) throw new Error('controller not set');
    t.equal(ctrl.desiredSize, 3, 'starts at hwm');
    ctrl.enqueue('a');
    t.equal(ctrl.desiredSize, 2, 'after one enqueue');
    ctrl.enqueue('b');
    t.equal(ctrl.desiredSize, 1, 'after two enqueues');
    ctrl.enqueue('c');
    t.equal(ctrl.desiredSize, 0, 'full');
    ctrl.close();
    t.deepEqual(await collect(rs), ['a', 'b', 'c']);
  });

  it('ReadableStreamDefaultController.desiredSize is null when errored', (t) => {
    let ctrl: ReadableStreamDefaultController<unknown> | undefined;
    const rs = new ReadableStream({ start(c) { ctrl = c; } });
    if (!ctrl) throw new Error('controller not set');
    ctrl.error(new Error('oops'));
    t.equal(ctrl.desiredSize, null, 'null when errored');
  });

  it('ReadableStreamDefaultController.desiredSize is 0 when closed', async (t) => {
    let ctrl: ReadableStreamDefaultController<unknown> | undefined;
    const rs = new ReadableStream({ start(c) { ctrl = c; ctrl.close(); } });
    await collect(rs);
    if (!ctrl) throw new Error('controller not set');
    t.equal(ctrl.desiredSize, 0, 'zero when closed');
  });

  it('ReadableStreamDefaultController: enqueue after close throws', (t) => {
    let ctrl: ReadableStreamDefaultController<unknown> | undefined;
    new ReadableStream({ start(c) { ctrl = c; ctrl.close(); } });
    if (!ctrl) throw new Error('controller not set');
    const controller = ctrl;
    t.throws(() => controller.enqueue('x'), /close/, 'throws after close');
  });

  it('pull called proactively when desiredSize > 0', async (t) => {
    let pullCount = 0;
    let ctrl: ReadableStreamDefaultController<number> | undefined;
    const rs = new ReadableStream(
      {
        start(c) { ctrl = c; },
        pull() {
          if (!ctrl) throw new Error('controller not set');
          pullCount++;
          ctrl.enqueue(pullCount);
          if (pullCount >= 3) ctrl.close();
        },
      },
      new CountQueuingStrategy({ highWaterMark: 3 }),
    );
    const result = await collect(rs);
    t.deepEqual(result, [1, 2, 3], 'all pulled chunks received');
    t.ok(pullCount >= 3, 'pull called enough times');
  });
});

describe('WritableStream desiredSize / ready', () => {
  it('ByteLengthQueuingStrategy: desiredSize', async (t) => {
    const writes: ArrayBufferView[] = [];
    const ws = new WritableStream(
      { write(c) { writes.push(c); } },
      new ByteLengthQueuingStrategy({ highWaterMark: 10 }),
    );
    const writer = ws.getWriter();
    t.equal(writer.desiredSize, 10, 'starts at hwm');
    const p = writer.write(new Uint8Array(6));
    t.ok(writer.desiredSize !== null && writer.desiredSize <= 4, 'desiredSize reduced after write');
    await p;
    writer.releaseLock();
  });

  it('WritableStreamDefaultWriter.desiredSize tracks queue', async (t) => {
    const writes: string[] = [];
    let resolveWrite: (() => void) | undefined;
    const ws = new WritableStream({
      write(c) {
        writes.push(c);
        return new Promise(r => { resolveWrite = r; });
      },
    }, new CountQueuingStrategy({ highWaterMark: 2 }));

    const writer = ws.getWriter();
    t.equal(writer.desiredSize, 2, 'starts at hwm');
    writer.write('a'); // size 1, queued
    t.equal(writer.desiredSize, 1, 'after first write');
    writer.write('b'); // size 1, queued
    t.equal(writer.desiredSize, 0, 'at hwm');
    resolveWrite?.();
    await Promise.resolve();
    await Promise.resolve();
    writer.releaseLock();
  });

  it('WritableStreamDefaultWriter.desiredSize is null when errored', async (t) => {
    const ws = new WritableStream();
    await ws.abort(new Error('bad'));
    const writer = ws.getWriter();
    t.equal(writer.desiredSize, null, 'null when errored');
    writer.releaseLock();
  });

  it('WritableStreamDefaultWriter.desiredSize is 0 when closed', async (t) => {
    const ws = new WritableStream();
    const writer = ws.getWriter();
    await writer.close();
    t.equal(writer.desiredSize, 0, 'zero when closed');
  });

  it('WritableStreamDefaultWriter.ready resolves initially', async (t) => {
    const ws = new WritableStream();
    const writer = ws.getWriter();
    let resolved = false;
    writer.ready.then(() => { resolved = true; });
    await Promise.resolve();
    await Promise.resolve();
    t.ok(resolved, 'ready resolves when stream has capacity');
    writer.releaseLock();
  });

  it('WritableStreamDefaultWriter.ready: pending when backpressure, resolves after write', async (t) => {
    let resolveWrite: (() => void) | undefined;
    const ws = new WritableStream(
      { write() { return new Promise(r => { resolveWrite = r; }); } },
      new CountQueuingStrategy({ highWaterMark: 1 }),
    );
    const writer = ws.getWriter();

    const wp = writer.write('a');
    let readyResolved = false;
    const rp = writer.ready.then(() => { readyResolved = true; });

    resolveWrite?.();
    await wp;
    await rp;
    t.ok(readyResolved, 'ready resolved after write completed');
    writer.releaseLock();
  });
});

describe('Byte streams (BYOB)', () => {
  it('ReadableByteStreamController: enqueue Uint8Array, default reader', async (t) => {
    const rs = new ReadableStream({
      type: 'bytes',
      start(ctrl) {
        ctrl.enqueue(new Uint8Array([1, 2, 3]));
        ctrl.close();
      },
    });
    const reader = rs.getReader();
    const { done, value } = await reader.read();
    t.ok(!done, 'not done');
    if (value === undefined) throw new Error('expected value');
    t.deepEqual(Array.from(value), [1, 2, 3], 'chunk received');
    const { done: done2 } = await reader.read();
    t.ok(done2, 'stream closed');
    reader.releaseLock();
  });

  it('ReadableByteStreamController: desiredSize tracks byte queue', (t) => {
    let ctrl: ReadableByteStreamController | undefined;
    const rs = new ReadableStream(
      { type: 'bytes', start(c) { ctrl = c; } },
      { highWaterMark: 10 },
    );
    if (!ctrl) throw new Error('controller not set');
    t.equal(ctrl.desiredSize, 10, 'starts at hwm');
    ctrl.enqueue(new Uint8Array(4));
    t.equal(ctrl.desiredSize, 6, 'after 4 bytes');
    ctrl.enqueue(new Uint8Array(6));
    t.equal(ctrl.desiredSize, 0, 'full');
    ctrl.close();
  });

  it('ReadableByteStreamController: byobRequest is null when no BYOB reader', (t) => {
    let ctrl: ReadableByteStreamController | undefined;
    new ReadableStream({ type: 'bytes', start(c) { ctrl = c; } });
    if (!ctrl) throw new Error('controller not set');
    t.equal(ctrl.byobRequest, null, 'null when no BYOB reader');
  });

  it('getReader({mode:"byob"}) returns ReadableStreamBYOBReader', (t) => {
    const rs = new ReadableStream({ type: 'bytes', start(c) { c.close(); } });
    const reader = rs.getReader({ mode: 'byob' });
    t.ok(reader instanceof ReadableStreamBYOBReader, 'is BYOB reader');
    reader.releaseLock();
  });

  it('getReader({mode:"byob"}) throws on non-byte stream', (t) => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    t.throws(() => rs.getReader({ mode: 'byob' }), /byte stream/, 'throws');
  });

  it('ReadableStreamBYOBReader.read(view): fills from enqueued bytes', async (t) => {
    const rs = new ReadableStream({
      type: 'bytes',
      start(ctrl) {
        ctrl.enqueue(new Uint8Array([10, 20, 30, 40]));
        ctrl.close();
      },
    });
    const reader = rs.getReader({ mode: 'byob' });
    const view = new Uint8Array(4);
    const { done, value } = await reader.read(view);
    t.ok(!done, 'not done');
    if (value === undefined) throw new Error('expected value');
    t.deepEqual(Array.from(value), [10, 20, 30, 40], 'bytes filled');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBReader.read(view): partial fill', async (t) => {
    const rs = new ReadableStream({
      type: 'bytes',
      start(ctrl) {
        ctrl.enqueue(new Uint8Array([1, 2]));
        ctrl.close();
      },
    });
    const reader = rs.getReader({ mode: 'byob' });
    const view = new Uint8Array(8);
    const { done, value } = await reader.read(view, { min: 1 });
    t.ok(!done, 'not done');
    if (value === undefined) throw new Error('expected value');
    t.equal(value.byteLength, 2, 'partial fill returned');
    t.deepEqual(Array.from(value), [1, 2], 'correct bytes');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBReader: byobRequest provided to pull', async (t) => {
    let byobReq: ReadableStreamBYOBRequest | null = null;
    const rs = new ReadableStream({
      type: 'bytes',
      pull(ctrl) {
        byobReq = ctrl.byobRequest;
        if (byobReq && byobReq.view !== null) {
          new Uint8Array(byobReq.view.buffer, byobReq.view.byteOffset, 3).set([7, 8, 9]);
          byobReq.respond(3);
        } else {
          ctrl.enqueue(new Uint8Array([7, 8, 9]));
          ctrl.close();
        }
      },
    });
    const reader = rs.getReader({ mode: 'byob' });
    const view = new Uint8Array(3);
    const { done, value } = await reader.read(view);
    t.ok(!done, 'not done');
    if (value === undefined) throw new Error('expected value');
    t.deepEqual(Array.from(value), [7, 8, 9], 'bytes filled via byobRequest.respond');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBRequest direct construction throws', (t) => {
    t.throws(
      () => new ReadableStreamBYOBRequest(undefined as any, undefined as any),
      TypeError,
      'direct construction is illegal',
    );
  });

  it('byte streams reject non-transferable WebAssembly memory buffers', async (t) => {
    let pullCalled = false;
    const rs = new ReadableStream({
      type: 'bytes',
      pull() { pullCalled = true; },
    });
    const reader = rs.getReader({ mode: 'byob' });
    const memory = new WebAssembly.Memory({ initial: 1 });
    await t.rejects(
      () => reader.read(new Uint8Array(memory.buffer, 0, 1)),
      TypeError,
      'read rejects non-transferable BYOB views',
    );
    t.equal(pullCalled, false, 'pull is not called');
    reader.releaseLock();

    let controller: ReadableByteStreamController | undefined;
    new ReadableStream({
      type: 'bytes',
      start(c) { controller = c; },
    });
    t.throws(
      () => controller!.enqueue(new Uint8Array(memory.buffer, 0, 1)),
      TypeError,
      'enqueue rejects non-transferable byte chunks',
    );
  });

  it('byte stream enqueue clears all pending BYOB descriptors before resolving reads', async (t) => {
    let controller: ReadableByteStreamController | undefined;
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) { controller = c; },
    });
    const reader = rs.getReader({ mode: 'byob' });
    const firstRead = reader.read(new Uint8Array(new ArrayBuffer(4)));
    const buffer = new ArrayBuffer(16);
    const secondRead = reader.read(new BigUint64Array(buffer, 8, 1));
    let sawThen = false;
    const originalThen = Object.prototype.then;
    try {
      Object.defineProperty(Object.prototype, 'then', {
        get() {
          if (!sawThen) {
            sawThen = true;
            t.equal(controller!.byobRequest, null, 'byobRequest is cleared before read resolution');
          }
          return undefined;
        },
        configurable: true,
      });
      controller!.enqueue(new Uint8Array(12).fill(0x42));
      t.equal(sawThen, true, 'patched then getter was observed');
    } finally {
      if (originalThen === undefined) delete Object.prototype.then;
      else Object.defineProperty(Object.prototype, 'then', {
        value: originalThen,
        configurable: true,
        writable: true,
      });
    }

    const first = await firstRead;
    const second = await secondRead;
    t.deepEqual(Array.from(first.value!), [0x42, 0x42, 0x42, 0x42], 'first BYOB read filled');
    t.ok(second.value instanceof BigUint64Array, 'second BYOB read preserves view constructor');
    reader.releaseLock();
  });

  it('default byte reader auto-allocates BYOB requests for multiple pending reads', async (t) => {
    const rs = new ReadableStream({
      type: 'bytes',
      autoAllocateChunkSize: 10,
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.byobRequest!.respond(2);
      },
    });
    const reader = rs.getReader();
    const [first, second] = await Promise.all([reader.read(), reader.read()]);
    t.deepEqual(Array.from(first.value!), [1, 2, 3], 'first read receives enqueued bytes');
    t.deepEqual(Array.from(second.value!), [0, 0], 'second read receives BYOB response bytes');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBReader.closed resolves when stream closes', async (t) => {
    const rs = new ReadableStream({
      type: 'bytes',
      start(ctrl) { ctrl.enqueue(new Uint8Array([1])); ctrl.close(); },
    });
    const reader = rs.getReader({ mode: 'byob' });
    let closedResolved = false;
    reader.closed.then(() => { closedResolved = true; });
    await reader.read(new Uint8Array(1));
    const { done } = await reader.read(new Uint8Array(1), { min: 1 });
    t.ok(done, 'stream closed');
    await Promise.resolve();
    await Promise.resolve();
    t.ok(closedResolved, 'closed promise resolved');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBReader.read: throws on zero-length view', async (t) => {
    const rs = new ReadableStream({ type: 'bytes', start(c) { c.close(); } });
    const reader = rs.getReader({ mode: 'byob' });
    await t.rejects(() => reader.read(new Uint8Array(0)), TypeError, 'throws');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBReader.read: min > view.byteLength throws', async (t) => {
    const rs = new ReadableStream({ type: 'bytes', start(c) { c.close(); } });
    const reader = rs.getReader({ mode: 'byob' });
    await t.rejects(() => reader.read(new Uint8Array(4), { min: 10 }), /min/, 'throws');
    reader.releaseLock();
  });

  it('byte stream enqueue rejects zero-length chunks', (t) => {
    let controller: ReadableByteStreamController | undefined;
    new ReadableStream({
      type: 'bytes',
      start(c) { controller = c; },
    });

    t.throws(() => controller!.enqueue(new Uint8Array()), TypeError, 'zero-length buffer rejects');
    t.throws(
      () => controller!.enqueue(new Uint8Array(new ArrayBuffer(8), 0, 0)),
      TypeError,
      'zero-length view rejects',
    );
  });

  it('BYOB respond validates detached and replacement views', async (t) => {
    let controller: ReadableByteStreamController | undefined;
    const rs = new ReadableStream({
      type: 'bytes',
      pull(c) { controller = c; },
    });
    const reader = rs.getReader({ mode: 'byob' });
    const pending = reader.read(new Uint8Array(4));
    await Promise.resolve();
    await Promise.resolve();

    t.throws(
      () => controller!.byobRequest!.respondWithNewView(new Uint8Array()),
      TypeError,
      'zero-length replacement rejects while readable',
    );
    t.throws(
      () => controller!.byobRequest!.respondWithNewView(new Uint8Array(new ArrayBuffer(8), 1, 1)),
      RangeError,
      'replacement offset must match',
    );

    (controller!.byobRequest!.view!.buffer as ArrayBuffer & { transfer(): ArrayBuffer }).transfer();
    t.throws(() => controller!.byobRequest!.respond(1), TypeError, 'detached BYOB view rejects');
    reader.releaseLock();
    await t.rejects(() => pending, /released|detached|lock/i, 'pending read is rejected after release');
  });
});

describe('Edge cases', () => {
  it('enqueue before closeRequested flushes to readers', async (t) => {
    const rs = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue('x');
        ctrl.enqueue('y');
        ctrl.close();
      },
    });
    t.deepEqual(await collect(rs), ['x', 'y'], 'all chunks received before close');
  });
});

describe('ReadableStream cancel on iterable-backed stream', () => {
  it('cancel() on generator-backed stream triggers finally block', async (t) => {
    let finallyCalled = false;
    async function* gen() {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        finallyCalled = true;
      }
    }
    const rs = ReadableStreamCtor.from(gen());
    const reader = rs.getReader();
    await reader.read(); // consume first chunk
    await reader.cancel('stop');
    reader.releaseLock();
    // Allow any pending microtasks to settle
    await Promise.resolve();
    await Promise.resolve();
    t.ok(finallyCalled, 'generator finally block ran on cancel');
  });

  it('ReadableStream.from() with a sync iterable (array)', async (t) => {
    const rs = ReadableStreamCtor.from([1, 2, 3]);
    t.deepEqual(await collect(rs), [1, 2, 3], 'all array values yielded');
  });
});

describe('WritableStream abort callback', () => {
  it('WritableStream.abort() calls underlyingSink.abort callback', async (t) => {
    let abortReason = null;
    const stream = new WritableStream({
      abort(reason) { abortReason = reason; },
    });
    const err = new Error('abort!');
    await stream.abort(err);
    t.equal(abortReason, err, 'abort callback called with reason');
  });

  it('WritableStreamDefaultWriter.closed resolves when stream closes', async (t) => {
    const stream = new WritableStream();
    const writer = stream.getWriter();
    let closedResolved = false;
    writer.closed.then(() => { closedResolved = true; });
    await writer.close();
    await Promise.resolve();
    await Promise.resolve();
    t.ok(closedResolved, 'closed promise resolved after close');
  });

  it('WritableStreamDefaultWriter.abort() aborts the stream', async (t) => {
    const stream = new WritableStream();
    const writer = stream.getWriter();
    await writer.abort(new Error('writer abort'));
    let threw = false;
    // After abort the writer's desiredSize should be null (errored)
    t.equal(writer.desiredSize, null, 'desiredSize null after abort');
    writer.releaseLock();
  });
});

describe('TransformStreamDefaultController extras', () => {
  it('terminate() closes the readable side', async (t) => {
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        controller.terminate(); // close after first chunk
      },
    });
    const readable = makeReadable([1, 2, 3]).pipeThrough(ts);
    const result = await collect(readable);
    t.equal(result.length, 1, 'only first chunk before terminate');
    t.equal(result[0], 1, 'first chunk value correct');
  });

  it('error() errors both sides', async (t) => {
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.error(new Error('transform error'));
      },
    });
    const readable = makeReadable([1]).pipeThrough(ts);
    let threw = false;
    try {
      await collect(readable);
    } catch (_) {
      threw = true;
    }
    t.ok(threw, 'readable errors after controller.error()');
  });
});

describe('pipeTo options: preventAbort / preventCancel', () => {
  it('preventAbort: true — writable is not aborted on readable error', async (t) => {
    let abortCalled = false;
    const ws = new WritableStream({
      write() {},
      abort() { abortCalled = true; },
    });

    const rs = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(1);
        ctrl.error(new Error('source error'));
      },
    });

    let threw = false;
    try {
      await rs.pipeTo(ws, { preventAbort: true });
    } catch (_) {
      threw = true;
    }
    t.ok(threw, 'pipeTo rejects on source error');
    t.ok(!abortCalled, 'writable abort not called with preventAbort:true');
  });

  it('preventCancel: true — readable is not cancelled on writable error', async (t) => {
    let cancelCalled = false;
    const rs = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(1);
        ctrl.enqueue(2);
        ctrl.close();
      },
      cancel() { cancelCalled = true; },
    });

    const ws = new WritableStream({
      write() { throw new Error('sink error'); },
    });

    let threw = false;
    try {
      await rs.pipeTo(ws, { preventCancel: true });
    } catch (_) {
      threw = true;
    }
    t.ok(threw, 'pipeTo rejects on sink error');
    t.ok(!cancelCalled, 'readable cancel not called with preventCancel:true');
  });

  it('does not write to a destination that never desires chunks before source error', async (t) => {
    const events: unknown[] = [];
    let controller: ReadableStreamDefaultController<string> | undefined;
    const error = new Error('source failed');
    const rs = new ReadableStream<string>({
      start(c) { controller = c; },
    });
    const ws = new WritableStream<string>({
      write(chunk) { events.push('write', chunk); },
      abort(reason) { events.push('abort', reason); },
    }, new CountQueuingStrategy({ highWaterMark: 0 }));

    const pipePromise = rs.pipeTo(ws);
    controller!.enqueue('queued');
    controller!.error(error);

    await t.rejects(() => pipePromise, (reason) => reason === error, 'pipe rejects with source error');
    t.deepEqual(events, ['abort', error], 'destination is aborted without writing queued chunk');
  });

  it('does not abort or read from a zero-capacity destination that errors while pipe waits', async (t) => {
    const events: unknown[] = [];
    let writableController: WritableStreamDefaultController | undefined;
    const error = new Error('destination failed');
    const rs = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.close();
      },
    });
    const ws = new WritableStream<string>({
      start(controller) { writableController = controller; },
      write(chunk) { events.push('write', chunk); },
      abort(reason) { events.push('abort', reason); },
    }, new CountQueuingStrategy({ highWaterMark: 0 }));

    const pipePromise = rs.pipeTo(ws, { preventCancel: true });
    await Promise.resolve();
    await Promise.resolve();
    writableController!.error(error);

    await t.rejects(() => pipePromise, (reason) => reason === error, 'pipe rejects with destination error');
    t.deepEqual(events, [], 'destination error does not call abort or write');
  });

  it('reads up to writable capacity before previous writes finish', async (t) => {
    const unreadChunks = ['b', 'c', 'd'];
    let resolveFirstWrite: (() => void) | undefined;
    const rs = new ReadableStream<string>({
      pull(controller) {
        controller.enqueue(unreadChunks.shift()!);
        if (unreadChunks.length === 0) controller.close();
      },
    }, new CountQueuingStrategy({ highWaterMark: 0 }));
    const ws = new WritableStream<string>({
      write() {
        if (!resolveFirstWrite) {
          return new Promise<void>((resolve) => { resolveFirstWrite = resolve; });
        }
      },
    }, new CountQueuingStrategy({ highWaterMark: 3 }));
    const writer = ws.getWriter();
    const firstWritePromise = writer.write('a');
    writer.releaseLock();

    const pipePromise = rs.pipeTo(ws);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    t.equal(unreadChunks.length, 1, 'pipe reads chunks until destination capacity is reached');
    resolveFirstWrite!();
    await Promise.all([firstWritePromise, pipePromise]);
  });
});

describe('tee() cancellation', () => {
  it('canceling both branches cancels the source', async (t) => {
    let sourceCancelled = false;
    const rs = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(1);
        ctrl.enqueue(2);
      },
      cancel() { sourceCancelled = true; },
    });

    const [b1, b2] = rs.tee();
    const r1 = b1.getReader();
    const r2 = b2.getReader();

    await r1.read(); // consume one chunk from branch 1
    await r1.cancel('done1');
    r1.releaseLock();
    await r2.cancel('done2');
    r2.releaseLock();

    // Allow async cancel propagation to settle
    await Promise.resolve();
    await Promise.resolve();
    t.ok(sourceCancelled, 'source cancelled after both branches cancel');
  });
});

describe('ReadableStream — no-argument constructor', () => {
  it('ReadableStream() with no arguments creates an empty readable', async (t) => {
    // Spec: ReadableStream() with no source creates an empty stream that immediately closes
    let threw = false;
    let rs;
    try {
      rs = new ReadableStream();
    } catch (_) {
      threw = true;
    }
    t.equal(threw, false, 'no-argument constructor does not throw');
    if (rs) {
      t.ok(rs instanceof ReadableStream, 'returns ReadableStream');
    }
  });
});


describe('TransformStreamDefaultController.desiredSize', () => {
  it('desiredSize is accessible from transform callback', async (t) => {
    let capturedDesiredSize: number | null = null;
    const ts = new TransformStream({
      transform(chunk, controller) {
        capturedDesiredSize = controller.desiredSize;
        controller.enqueue(chunk);
      },
    });
    const readable = makeReadable([1]).pipeThrough(ts);
    await collect(readable);
    t.ok(capturedDesiredSize !== undefined, 'desiredSize accessible in transform');
    t.ok(typeof capturedDesiredSize === 'number' || capturedDesiredSize === null, 'desiredSize is number or null');
  });
});

describe('ReadableStream start() error', () => {
  it('start() that throws errors the stream', async (t) => {
    const rs = new ReadableStream({
      start(ctrl) {
        ctrl.error(new Error('start failed'));
      },
    });
    let threw = false;
    try {
      await collect(rs);
    } catch (_) {
      threw = true;
    }
    t.ok(threw, 'stream errored when start() errors the controller');
  });
});

describe('ReadableStream.from() — validation', () => {
  it('throws TypeError for null', (t) => {
    t.throws(() => ReadableStreamCtor.from(null as never), /must be an async iterable/, 'null throws');
  });

  it('throws TypeError for a plain number', (t) => {
    t.throws(() => ReadableStreamCtor.from(42 as any), /must be an async iterable/, 'number throws');
  });

  it('throws TypeError for a plain object without iterator', (t) => {
    t.throws(() => ReadableStreamCtor.from({} as any), /must be an async iterable/, 'plain object throws');
  });
});

describe('ReadableStreamDefaultReader — releaseLock invalidates reader', () => {
  it('read() after releaseLock() rejects with TypeError', async (t) => {
    const rs = makeReadable([1, 2]);
    const reader = rs.getReader();
    reader.releaseLock();
    await t.rejects(() => reader.read(), /Reader is released/, 'read() after releaseLock() rejects');
  });
});

describe('WritableStreamDefaultWriter — releaseLock invalidates writer', () => {
  it('write() after releaseLock() rejects with TypeError', async (t) => {
    const ws = new WritableStream({ write() {} });
    const writer = ws.getWriter();
    writer.releaseLock();
    await t.rejects(() => writer.write('x'), /Writer is released/, 'write() after releaseLock() rejects');
  });
});

describe('pipeTo() — returns rejected promise for locked streams', () => {
  it('pipeTo() on locked ReadableStream returns rejected promise', async (t) => {
    const rs = makeReadable([]);
    rs.getReader(); // lock it
    const ws = new WritableStream({ write() {} });
    await t.rejects(() => rs.pipeTo(ws), /is locked/, 'pipeTo locked src → rejected promise');
  });

  it('pipeTo() to locked WritableStream returns rejected promise', async (t) => {
    const rs = makeReadable([]);
    const ws = new WritableStream({ write() {} });
    ws.getWriter(); // lock it
    await t.rejects(() => rs.pipeTo(ws), /is locked/, 'pipeTo locked dst → rejected promise');
  });
});

describe('WritableStreamDefaultController.abortReason', () => {
  it('abortReason is undefined before abort', async (t) => {
    let ctrl: WritableControllerWithAbortReason | undefined;
    const ws = new WritableStream({
      start(c) { ctrl = c; },
    });
    if (!ctrl) throw new Error('controller not set');
    t.equal(ctrl.abortReason, undefined, 'abortReason is undefined before abort');
    ws.abort(); // clean up
  });

  it('abortReason reflects the abort reason after abort', async (t) => {
    let ctrl: WritableControllerWithAbortReason | undefined;
    const reason = new Error('cancelled');
    const ws = new WritableStream({
      start(c) { ctrl = c; },
      abort(r) {},
    });
    ws.abort(reason);
    // Give the abort a chance to propagate
    await new Promise(r => setTimeout(r, 0));
    if (!ctrl) throw new Error('controller not set');
    t.equal(ctrl.signal.aborted, true, 'signal is aborted');
    t.equal(ctrl.abortReason, reason, 'abortReason matches abort reason');
  });
});

describe('[Symbol.toStringTag]', () => {
  it('ReadableStream has correct toStringTag', (t) => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    t.equal((rs as unknown as SymbolRecord)[Symbol.toStringTag], 'ReadableStream', 'ReadableStream toStringTag');
  });

  it('WritableStream has correct toStringTag', (t) => {
    const ws = new WritableStream();
    t.equal((ws as unknown as SymbolRecord)[Symbol.toStringTag], 'WritableStream', 'WritableStream toStringTag');
  });

  it('TransformStream has correct toStringTag', (t) => {
    const ts = new TransformStream();
    t.equal((ts as unknown as SymbolRecord)[Symbol.toStringTag], 'TransformStream', 'TransformStream toStringTag');
  });
});

describe('ReadableStreamDefaultReader.releaseLock() rejects pending reads', () => {
  it('pending read() rejected when releaseLock() is called', async (t) => {
    let resolveChunk!: (v: Uint8Array) => void;
    const rs = new ReadableStream({
      start(controller) {
        // Don't enqueue anything yet — reads will be pending
        (globalThis as any).__resolveChunk = (v: Uint8Array) => controller.enqueue(v);
      },
    });
    const reader = rs.getReader();
    // Start a read that won't resolve until a chunk is enqueued
    const readPromise = reader.read();
    // Release the lock before the read resolves
    reader.releaseLock();
    // The pending read should be rejected
    await t.rejects(async () => { await readPromise; }, undefined, 'pending read rejected on releaseLock');
    delete (globalThis as any).__resolveChunk;
  });
});

describe('WritableStream.close() when already closing', () => {
  it('close() rejects when called while already closing', async (t) => {
    let resolveSinkClose!: () => void;
    const ws = new WritableStream({
      close() {
        return new Promise<void>(r => { resolveSinkClose = r; });
      },
    });
    const writer = ws.getWriter();
    const close1 = writer.close();
    // Second close should reject
    await t.rejects(async () => { await writer.close(); }, undefined, 'second close() rejects');
    resolveSinkClose();
    await close1;
  });
});

describe('pipeTo with all prevent options', () => {
  it('pipeTo with preventClose + preventAbort + preventCancel', async (t) => {
    const chunks: string[] = [];
    const rs = new ReadableStream({
      start(c) { c.enqueue('a'); c.enqueue('b'); c.close(); },
    });
    const ws = new WritableStream({
      write(chunk) { chunks.push(chunk); },
    });
    await rs.pipeTo(ws, { preventClose: true, preventAbort: true, preventCancel: true });
    t.deepEqual(chunks, ['a', 'b'], 'chunks piped correctly');
    t.equal(ws.locked, false, 'writer unlocked after pipeTo');
  });
});

describe('ReadableStreamBYOBReader.releaseLock() rejects pending reads', () => {
  it('releaseLock() causes pending read() to reject', async (t) => {
    const rs = new ReadableStream({
      type: 'bytes',
      start(_ctrl) { /* never enqueue */ },
    });
    const reader = rs.getReader({ mode: 'byob' });
    const view = new Uint8Array(4);
    const pendingRead = reader.read(view);
    reader.releaseLock();
    await t.rejects(
      async () => { await pendingRead; },
      /released|lock/i,
      'pending BYOB read rejects on releaseLock()',
    );
  });
});

describe('ReadableStream.tee() — composite cancel reason', () => {
  it('cancelling both branches cancels source with [reason1, reason2]', async (t) => {
    let cancelReason: unknown;
    const rs = new ReadableStream({
      cancel(reason) { cancelReason = reason; },
    });
    const [b1, b2] = rs.tee();
    await b1.cancel('reason1');
    await b2.cancel('reason2');
    t.ok(Array.isArray(cancelReason), 'cancel reason is an array');
    t.deepEqual(cancelReason as unknown[], ['reason1', 'reason2'], 'composite cancel reasons');
  });
});

describe('Web Streams release/cancel conformance edges', () => {
  it('methods and getters reject invalid receivers through brand checks', async (t) => {
    const readableLocked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'locked')!.get!;
    const writableLocked = Object.getOwnPropertyDescriptor(WritableStream.prototype, 'locked')!.get!;
    const readerClosed = Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, 'closed')!.get!;
    const byobClosed = Object.getOwnPropertyDescriptor(ReadableStreamBYOBReader.prototype, 'closed')!.get!;
    const writerClosed = Object.getOwnPropertyDescriptor(WritableStreamDefaultWriter.prototype, 'closed')!.get!;

    t.throws(() => readableLocked.call({}), /receiver expected/, 'ReadableStream.locked brand-checks receiver');
    t.throws(() => writableLocked.call({}), /receiver expected/, 'WritableStream.locked brand-checks receiver');
    t.throws(() => readerClosed.call({}), /receiver expected/, 'ReadableStreamDefaultReader.closed brand-checks receiver');
    t.throws(() => byobClosed.call({}), /receiver expected/, 'ReadableStreamBYOBReader.closed brand-checks receiver');
    t.throws(() => writerClosed.call({}), /receiver expected/, 'WritableStreamDefaultWriter.closed brand-checks receiver');
    await t.rejects(
      () => (ReadableStream.prototype.pipeTo as any).call(new ReadableStream(), {}),
      /WritableStream expected/,
      'pipeTo validates destination brand',
    );
  });

  it('tee() waits for both branches before canceling the source', async (t) => {
    let cancelCount = 0;
    const rs = new ReadableStream({
      cancel() { cancelCount++; },
    });
    const [b1, b2] = rs.tee();

    const firstCancel = b1.cancel('first');
    await Promise.resolve();
    await Promise.resolve();
    t.equal(cancelCount, 0, 'source not canceled after one branch');

    await b2.cancel('second');
    await firstCancel;
    t.equal(cancelCount, 1, 'source canceled exactly once after both branches');
  });

  it('BYOB pending read rejects when the stream is canceled', async (t) => {
    const rs = new ReadableStream({
      type: 'bytes',
      start() {},
      cancel(reason) {
        t.equal(reason, 'stop', 'cancel reason forwarded to byte source');
      },
    });
    const reader = rs.getReader({ mode: 'byob' });
    const pendingRead = reader.read(new Uint8Array(8));
    await reader.cancel('stop');
    const result = await pendingRead;
    t.equal(result.done, true, 'pending BYOB read closes on cancel');
    t.equal(result.value?.byteLength, 0, 'cancel resolves with an empty BYOB view');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBReader.closed rejects when a pending BYOB read lock is released', async (t) => {
    const rs = new ReadableStream({
      type: 'bytes',
      start() {},
    });
    const reader = rs.getReader({ mode: 'byob' });
    const pendingRead = reader.read(new Uint8Array(4));
    const closed = reader.closed;
    reader.releaseLock();

    await t.rejects(() => pendingRead, /released|lock/i, 'pending BYOB read rejects');
    await t.rejects(() => closed, /released|lock/i, 'closed rejects for released reader with pending read');
  });

  it('ReadableStreamDefaultReader.closed rejects asynchronously after releaseLock()', async (t) => {
    const reader = new ReadableStream({ start() {} }).getReader();
    const closed = reader.closed;
    let rejected = false;
    closed.catch(() => { rejected = true; });
    reader.releaseLock();

    t.equal(rejected, false, 'closed rejection is not observed synchronously');
    await t.rejects(() => closed, /released|lock/i, 'closed rejects after release');
  });

  it('WritableStreamDefaultWriter.closed rejects when the writer lock is released before close', async (t) => {
    const ws = new WritableStream();
    const writer = ws.getWriter();
    const closed = writer.closed;
    writer.releaseLock();
    await t.rejects(() => closed, /released|lock/i, 'closed rejects for released writer');
  });

  it('WritableStreamDefaultWriter.ready rejects when a pending ready promise is released', async (t) => {
    let finishWrite!: () => void;
    const ws = new WritableStream({
      write() { return new Promise<void>(resolve => { finishWrite = resolve; }); },
    }, new CountQueuingStrategy({ highWaterMark: 0 }));
    const writer = ws.getWriter();
    const write = writer.write('x');
    const ready = writer.ready;
    writer.releaseLock();

    await t.rejects(() => ready, /released|lock/i, 'pending ready rejects after release');
    finishWrite();
    await write;
  });

  it('BYOB read rejects detached resizable transfer views', async (t) => {
    const rs = new ReadableStream({ type: 'bytes', start() {} });
    const reader = rs.getReader({ mode: 'byob' });
    const buffer = new ArrayBuffer(4, { maxByteLength: 4 });
    const view = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });

    t.equal(view.byteLength, 0, 'runtime transfer limitation makes resizable view unusable');
    await t.rejects(() => reader.read(view), /byteLength|detached/i, 'detached BYOB view rejects');
    reader.releaseLock();
  });

  it('pipeTo() already-aborted signals honor preventAbort and preventCancel', async (t) => {
    const reason = new Error('already aborted');

    {
      const controller = new AbortController();
      controller.abort(reason);
      let cancelReason: unknown;
      let abortCalled = false;
      const rs = new ReadableStream({ cancel(r) { cancelReason = r; } });
      const ws = new WritableStream({ abort() { abortCalled = true; } });
      await t.rejects(() => rs.pipeTo(ws, { signal: controller.signal, preventAbort: true }), /already aborted/, 'pipe rejects with abort reason');
      t.equal(cancelReason, reason, 'source cancel still runs without preventCancel');
      t.equal(abortCalled, false, 'destination abort is suppressed by preventAbort');
    }

    {
      const controller = new AbortController();
      controller.abort(reason);
      let cancelCalled = false;
      let abortReason: unknown;
      const rs = new ReadableStream({ cancel() { cancelCalled = true; } });
      const ws = new WritableStream({ abort(r) { abortReason = r; } });
      await t.rejects(() => rs.pipeTo(ws, { signal: controller.signal, preventCancel: true }), /already aborted/, 'pipe rejects with abort reason');
      t.equal(cancelCalled, false, 'source cancel is suppressed by preventCancel');
      t.equal(abortReason, reason, 'destination abort still runs without preventAbort');
    }
  });

  it('TransformStream transform throw rejects write and errors readable', async (t) => {
    const reason = new Error('transform failed');
    const ts = new TransformStream({
      transform() { throw reason; },
    });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();

    await Promise.all([
      t.rejects(() => writer.write('x'), /transform failed/, 'write rejects with transform error'),
      t.rejects(() => reader.read(), /transform failed/, 'readable errors with transform error'),
    ]);
  });

  it('TransformStream flush throw rejects close and errors readable', async (t) => {
    const ts = new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
      flush() { throw new Error('flush failed'); },
    });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();

    const [writeResult, readResult] = await Promise.all([
      writer.write('x'),
      reader.read(),
    ]);
    t.equal(writeResult, undefined, 'write resolves');
    t.deepEqual(readResult, { done: false, value: 'x' }, 'transformed chunk is readable');
    await t.rejects(() => writer.close(), /flush failed/, 'close rejects with flush error');
    await t.rejects(() => reader.read(), /flush failed/, 'readable errors with flush error');
  });
});
