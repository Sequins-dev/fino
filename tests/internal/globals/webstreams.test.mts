import { describe, it } from 'boats:test/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadable(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(readable) {
  const results = [];
  for await (const chunk of readable) results.push(chunk);
  return results;
}

function makeSinkWritable() {
  const chunks = [];
  let closedResolve;
  const closed = new Promise(r => { closedResolve = r; });
  const stream = new WritableStream({
    write(chunk) { chunks.push(chunk); },
    close() { closedResolve(); },
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
    const rs = ReadableStream.from(gen());
    t.deepEqual(await collect(rs), ['x', 'y']);
  });

  it('ReadableStream.from() — array iteration', async (t) => {
    async function* gen() { for (const x of [10, 20, 30]) yield x; }
    const rs = ReadableStream.from(gen());
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
    const order = [];
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
    await ReadableStream.from(gen()).pipeTo(stream);
    t.deepEqual(chunks, ['a', 'b'], 'chunks received');
  });

  it('preventClose keeps writable open', async (t) => {
    const chunks = [];
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
    const received = [];
    let closedCount = 0;
    const ws = new WritableStream({
      write(c) { received.push(c); },
      close() { closedCount++; },
    });
    await makeReadable([10, 20, 30]).pipeTo(ws);
    t.deepEqual(received, [10, 20, 30]);
    t.equal(closedCount, 1, 'close called once');
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
});

describe('Queuing strategies', () => {
  it('CountQueuingStrategy: highWaterMark and size', (t) => {
    const s = new CountQueuingStrategy({ highWaterMark: 4 });
    t.equal(s.highWaterMark, 4, 'highWaterMark');
    t.equal(s.size('anything'), 1, 'size always 1');
    t.equal(s.size(42), 1, 'size always 1 regardless of chunk type');
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
    let ctrl;
    const rs = new ReadableStream(
      { start(c) { ctrl = c; } },
      new CountQueuingStrategy({ highWaterMark: 3 }),
    );
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
    let ctrl;
    const rs = new ReadableStream({ start(c) { ctrl = c; } });
    ctrl.error(new Error('oops'));
    t.equal(ctrl.desiredSize, null, 'null when errored');
  });

  it('ReadableStreamDefaultController.desiredSize is 0 when closed', async (t) => {
    let ctrl;
    const rs = new ReadableStream({ start(c) { ctrl = c; ctrl.close(); } });
    await collect(rs);
    t.equal(ctrl.desiredSize, 0, 'zero when closed');
  });

  it('ReadableStreamDefaultController: enqueue after close throws', (t) => {
    let ctrl;
    new ReadableStream({ start(c) { ctrl = c; ctrl.close(); } });
    t.throws(() => ctrl.enqueue('x'), /close/, 'throws after close');
  });

  it('pull called proactively when desiredSize > 0', async (t) => {
    let pullCount = 0;
    let ctrl;
    const rs = new ReadableStream(
      {
        start(c) { ctrl = c; },
        pull() { pullCount++; ctrl.enqueue(pullCount); if (pullCount >= 3) ctrl.close(); },
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
    const writes = [];
    const ws = new WritableStream(
      { write(c) { writes.push(c); } },
      new ByteLengthQueuingStrategy({ highWaterMark: 10 }),
    );
    const writer = ws.getWriter();
    t.equal(writer.desiredSize, 10, 'starts at hwm');
    const p = writer.write(new Uint8Array(6));
    t.ok(writer.desiredSize <= 4, 'desiredSize reduced after write');
    await p;
    writer.releaseLock();
  });

  it('WritableStreamDefaultWriter.desiredSize tracks queue', async (t) => {
    const writes = [];
    let resolveWrite;
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
    let resolveWrite;
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
    t.deepEqual(Array.from(value), [1, 2, 3], 'chunk received');
    const { done: done2 } = await reader.read();
    t.ok(done2, 'stream closed');
    reader.releaseLock();
  });

  it('ReadableByteStreamController: desiredSize tracks byte queue', (t) => {
    let ctrl;
    const rs = new ReadableStream(
      { type: 'bytes', start(c) { ctrl = c; } },
      { highWaterMark: 10 },
    );
    t.equal(ctrl.desiredSize, 10, 'starts at hwm');
    ctrl.enqueue(new Uint8Array(4));
    t.equal(ctrl.desiredSize, 6, 'after 4 bytes');
    ctrl.enqueue(new Uint8Array(6));
    t.equal(ctrl.desiredSize, 0, 'full');
    ctrl.close();
  });

  it('ReadableByteStreamController: byobRequest is null when no BYOB reader', (t) => {
    let ctrl;
    new ReadableStream({ type: 'bytes', start(c) { ctrl = c; } });
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
    t.equal(value.byteLength, 2, 'partial fill returned');
    t.deepEqual(Array.from(value), [1, 2], 'correct bytes');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBReader: byobRequest provided to pull', async (t) => {
    let byobReq = null;
    const rs = new ReadableStream({
      type: 'bytes',
      pull(ctrl) {
        byobReq = ctrl.byobRequest;
        if (byobReq) {
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
    t.deepEqual(Array.from(value), [7, 8, 9], 'bytes filled via byobRequest.respond');
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
    await t.rejects(() => reader.read(new Uint8Array(0)), /byteLength/, 'throws');
    reader.releaseLock();
  });

  it('ReadableStreamBYOBReader.read: min > view.byteLength throws', async (t) => {
    const rs = new ReadableStream({ type: 'bytes', start(c) { c.close(); } });
    const reader = rs.getReader({ mode: 'byob' });
    await t.rejects(() => reader.read(new Uint8Array(4), { min: 10 }), /min/, 'throws');
    reader.releaseLock();
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
    const rs = ReadableStream.from(gen());
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
    const rs = ReadableStream.from([1, 2, 3]);
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
    t.throws(() => ReadableStream.from(null), /must be an async iterable/, 'null throws');
  });

  it('throws TypeError for a plain number', (t) => {
    t.throws(() => ReadableStream.from(42 as any), /must be an async iterable/, 'number throws');
  });

  it('throws TypeError for a plain object without iterator', (t) => {
    t.throws(() => ReadableStream.from({} as any), /must be an async iterable/, 'plain object throws');
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
    let ctrl;
    const ws = new WritableStream({
      start(c) { ctrl = c; },
    });
    t.equal(ctrl.abortReason, undefined, 'abortReason is undefined before abort');
    ws.abort(); // clean up
  });

  it('abortReason reflects the abort reason after abort', async (t) => {
    let ctrl;
    const reason = new Error('cancelled');
    const ws = new WritableStream({
      start(c) { ctrl = c; },
      abort(r) {},
    });
    ws.abort(reason);
    // Give the abort a chance to propagate
    await new Promise(r => setTimeout(r, 0));
    t.equal(ctrl.signal.aborted, true, 'signal is aborted');
    t.equal(ctrl.abortReason, reason, 'abortReason matches abort reason');
  });
});

describe('[Symbol.toStringTag]', () => {
  it('ReadableStream has correct toStringTag', (t) => {
    const rs = new ReadableStream({ start(c) { c.close(); } });
    t.equal(rs[Symbol.toStringTag], 'ReadableStream', 'ReadableStream toStringTag');
  });

  it('WritableStream has correct toStringTag', (t) => {
    const ws = new WritableStream();
    t.equal(ws[Symbol.toStringTag], 'WritableStream', 'WritableStream toStringTag');
  });

  it('TransformStream has correct toStringTag', (t) => {
    const ts = new TransformStream();
    t.equal(ts[Symbol.toStringTag], 'TransformStream', 'TransformStream toStringTag');
  });
});

describe('ReadableStreamDefaultReader.releaseLock() rejects pending reads', () => {
  it('pending read() rejected when releaseLock() is called', async (t) => {
    let resolveChunk!: (v: Uint8Array) => void;
    const rs = new ReadableStream({
      start(controller) {
        // Don't enqueue anything yet — reads will be pending
        (globalThis as any).__resolveChunk = (v) => controller.enqueue(v);
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
