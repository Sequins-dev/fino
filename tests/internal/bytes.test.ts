import { describe, it } from 'fino:test/test';
import {
  asByteView,
  collectBytes,
  concatBytes,
  copyArrayBuffer,
  copyBytes,
  equalBytes,
  timingSafeEqualBytes,
} from 'internal:bytes';

describe('internal byte primitives', () => {
  it('creates aliased views over exact visible byte spans', (t) => {
    const buffer = new ArrayBuffer(8);
    const bytes = new Uint8Array(buffer);
    bytes.set([10, 20, 30, 40], 2);

    const existing = bytes.subarray(2, 6);
    t.equal(asByteView(existing), existing, 'existing Uint8Array keeps its identity');

    const dataView = new DataView(buffer, 2, 4);
    const dataBytes = asByteView(dataView);
    t.equal(dataBytes.buffer, buffer, 'DataView conversion does not copy its backing store');
    t.deepEqual(dataBytes, new Uint8Array([10, 20, 30, 40]));
    dataBytes[1] = 99;
    t.equal(bytes[3], 99, 'view mutations reach the original buffer');

    const words = new Uint16Array(buffer, 2, 2);
    const wordBytes = asByteView(words);
    t.equal(wordBytes.buffer, buffer, 'typed-array conversion does not copy its backing store');
    t.equal(wordBytes.byteOffset, 2);
    t.equal(wordBytes.byteLength, 4);
    wordBytes[2] = 77;
    t.equal(bytes[4], 77, 'typed-array views share the visible storage');

    const allBytes = asByteView(buffer);
    t.equal(allBytes.buffer, buffer, 'ArrayBuffer conversion creates only a view');
    allBytes[0] = 5;
    t.equal(bytes[0], 5, 'ArrayBuffer views alias the complete buffer');

    const shared = new Uint8Array(new SharedArrayBuffer(2));
    const sharedView = asByteView(shared);
    sharedView[0] = 42;
    t.equal(shared[0], 42, 'SharedArrayBuffer-backed views remain shared');
  });

  it('rejects values that are not buffers or buffer views', (t) => {
    t.throws(() => asByteView('bytes' as never), TypeError);
    t.throws(() => asByteView({} as never), TypeError);
  });

  it('copies exact visible spans into independently owned byte arrays', (t) => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const visible = source.subarray(1, 4);
    const copied = copyBytes(visible);

    t.deepEqual(copied, new Uint8Array([2, 3, 4]));
    t.notEqual(copied, visible);
    t.equal(copied.byteOffset, 0);
    t.equal(copied.buffer.byteLength, copied.byteLength, 'copy owns a tight buffer');
    copied[0] = 9;
    source[2] = 8;
    t.deepEqual(copied, new Uint8Array([9, 3, 4]));
    t.deepEqual(visible, new Uint8Array([2, 8, 4]));

    const offsetView = new DataView(new Uint8Array([0, 6, 7, 0]).buffer, 1, 2);
    const viewCopy = copyBytes(offsetView);
    t.deepEqual(viewCopy, new Uint8Array([6, 7]));
    viewCopy[0] = 5;
    t.equal(offsetView.getUint8(0), 6, 'copied non-byte views do not alias their source');

    const empty = new Uint8Array();
    const emptyCopy = copyBytes(empty);
    t.notEqual(emptyCopy, empty, 'zero-length copies still have independent identity');
    t.notEqual(emptyCopy.buffer, empty.buffer, 'zero-length copies own a distinct buffer');
  });

  it('copies a view into an exact-length owned ArrayBuffer', (t) => {
    const source = new Uint8Array([10, 20, 30, 40]);
    const visible = source.subarray(1, 3);
    const copied = copyArrayBuffer(visible);

    t.ok(copied instanceof ArrayBuffer);
    t.equal(copied.byteLength, 2);
    t.deepEqual(new Uint8Array(copied), new Uint8Array([20, 30]));

    source[1] = 99;
    new Uint8Array(copied)[1] = 88;
    t.deepEqual(source, new Uint8Array([10, 99, 30, 40]));
    t.deepEqual(new Uint8Array(copied), new Uint8Array([20, 88]));
  });

  it('allocates concatenation storage only when parts must be joined', (t) => {
    const empty = concatBytes([]);
    const anotherEmpty = concatBytes([]);
    t.deepEqual(empty, new Uint8Array());
    t.notEqual(empty.buffer, anotherEmpty.buffer, 'empty results own distinct buffers');

    const only = new Uint8Array([1, 2]);
    const single = concatBytes([only]);
    t.equal(single, only, 'single-part concatenation preserves the existing view');
    single[0] = 9;
    t.equal(only[0], 9, 'single-part concatenation does not copy bytes');

    const multiple = concatBytes([
      new Uint8Array([1, 2]),
      new Uint8Array(),
      new Uint8Array([3, 4]),
    ]);
    t.deepEqual(multiple, new Uint8Array([1, 2, 3, 4]));
    t.equal(multiple.buffer.byteLength, multiple.byteLength, 'concatenation owns a tight buffer');
  });

  it('validates concatenation limits before producing a result', (t) => {
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3])];
    t.deepEqual(concatBytes(parts, { maxBytes: 3 }), new Uint8Array([1, 2, 3]));
    t.throws(() => concatBytes(parts, { maxBytes: 2 }), RangeError);

    for (const maxBytes of [-1, 1.5, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      t.throws(() => concatBytes([], { maxBytes }), RangeError);
    }
    t.throws(
      () => concatBytes([new Uint16Array([1]) as unknown as Uint8Array]),
      /parts must be Uint8Array/,
    );
  });

  it('compares visible byte spans with ordinary equality', (t) => {
    const padded = new Uint8Array([0, 1, 2, 3, 0]);
    const visible = padded.subarray(1, 4);
    t.equal(equalBytes(visible, new Uint8Array([1, 2, 3])), true);
    t.equal(equalBytes(visible, new Uint8Array([1, 9, 3])), false);
    t.equal(equalBytes(visible, new Uint8Array([1, 2])), false);
    t.equal(equalBytes(new Uint8Array(), new Uint8Array()), true);
  });

  it('defines timing-safe comparison semantics for content and length mismatches', (t) => {
    t.equal(timingSafeEqualBytes(new Uint8Array(), new Uint8Array()), true);
    t.equal(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
    t.equal(timingSafeEqualBytes(new Uint8Array([9, 2]), new Uint8Array([1, 2])), false);
    t.equal(timingSafeEqualBytes(new Uint8Array([1, 9]), new Uint8Array([1, 2])), false);
    t.equal(timingSafeEqualBytes(new Uint8Array([1]), new Uint8Array([1, 0])), false);
    t.equal(timingSafeEqualBytes(new Uint8Array([1, 0]), new Uint8Array([1])), false);
  });

  it('collects synchronous chunks as owned snapshots', async (t) => {
    const reused = new Uint8Array([1]);
    function* source(): IterableIterator<Uint8Array> {
      yield reused;
      reused[0] = 2;
      yield reused;
      reused[0] = 3;
    }

    const collected = await collectBytes(source());
    t.deepEqual(collected, new Uint8Array([1, 2]));
    t.equal(collected.byteOffset, 0);
    t.equal(collected.buffer.byteLength, collected.byteLength, 'collection owns a tight buffer');
    t.deepEqual(reused, new Uint8Array([3]));
    collected[0] = 9;
    t.equal(reused[0], 3, 'collected storage does not alias reused source chunks');

    const empty = await collectBytes([]);
    const anotherEmpty = await collectBytes([]);
    t.notEqual(empty.buffer, anotherEmpty.buffer, 'empty collections own distinct buffers');

    const shared = new Uint8Array(new SharedArrayBuffer(1));
    shared[0] = 7;
    const sharedCopy = await collectBytes([shared]);
    t.ok(sharedCopy.buffer instanceof ArrayBuffer, 'collected shared bytes use ordinary storage');
    t.deepEqual(sharedCopy, new Uint8Array([7]));
  });

  it('enforces limits and exact expected lengths', async (t) => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    t.deepEqual(
      await collectBytes(chunks, { expectedBytes: 3, maxBytes: 3 }),
      new Uint8Array([1, 2, 3]),
    );
    await t.rejects(() => collectBytes(chunks, { maxBytes: 2 }), /maxBytes \(2\)/);
    await t.rejects(() => collectBytes(chunks, { expectedBytes: 2 }), /expectedBytes \(2\)/);
    await t.rejects(() => collectBytes([new Uint8Array([1])], { expectedBytes: 2 }), /expected 2/);

    for (const value of [-1, 1.5, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await t.rejects(() => collectBytes([], { maxBytes: value }), RangeError);
      await t.rejects(() => collectBytes([], { expectedBytes: value }), RangeError);
    }
    await t.rejects(() => collectBytes([], { expectedBytes: 2, maxBytes: 1 }), RangeError);
    t.deepEqual(await collectBytes([new Uint8Array()], { maxBytes: 0 }), new Uint8Array());
    t.deepEqual(await collectBytes([], { expectedBytes: 0 }), new Uint8Array());
    await t.rejects(() => collectBytes([new Uint8Array([1])], { maxBytes: 0 }), RangeError);
    await t.rejects(() => collectBytes([new Uint8Array([1])], { expectedBytes: 0 }), RangeError);
  });

  it('closes synchronous iterators once on collection failure', async (t) => {
    let returns = 0;
    const limited: Iterable<Uint8Array> = {
      [Symbol.iterator]() {
        let index = 0;
        return {
          next() {
            index++;
            return { done: false, value: new Uint8Array([index]) };
          },
          return() {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await t.rejects(() => collectBytes(limited, { maxBytes: 1 }), RangeError);
    t.equal(returns, 1);
    await t.rejects(() => collectBytes(limited, { expectedBytes: 1 }), /expectedBytes \(1\)/);
    t.equal(returns, 2);

    const primary = new Error('source failed');
    const failing: Iterable<Uint8Array> = {
      [Symbol.iterator]() {
        return {
          next(): IteratorResult<Uint8Array> {
            throw primary;
          },
          return(): IteratorResult<Uint8Array> {
            returns++;
            throw new Error('cleanup failed');
          },
        };
      },
    };
    try {
      await collectBytes(failing);
      t.fail('source failure should propagate');
    } catch (error) {
      t.equal(error, primary, 'cleanup failure does not replace the source failure');
    }
    t.equal(returns, 3, 'each failed iterator is closed exactly once');
  });

  it('rejects invalid chunks and aborts before touching a synchronous source', async (t) => {
    let acquired = 0;
    const source: Iterable<Uint8Array> = {
      [Symbol.iterator]() {
        acquired++;
        return [new Uint8Array([1])][Symbol.iterator]();
      },
    };
    const reason = new Error('stop collection');
    const signal = AbortSignal.abort(reason);
    try {
      await collectBytes(source, { signal });
      t.fail('pre-aborted collection should throw');
    } catch (error) {
      t.equal(error, reason);
    }
    t.equal(acquired, 0, 'pre-abort is checked before iterator acquisition');

    await t.rejects(() => collectBytes(source, null as never), TypeError);
    await t.rejects(() => collectBytes(source, { signal: {} as AbortSignal }), TypeError);
    await t.rejects(() => collectBytes(source, { expectedBytes: 2, maxBytes: 1 }), RangeError);
    t.equal(acquired, 0, 'invalid options are checked before iterator acquisition');

    const stableSignal = new AbortController().signal;
    let signalReads = 0;
    const accessorOptions = Object.defineProperty({ maxBytes: 1 }, 'signal', {
      get() {
        signalReads++;
        return stableSignal;
      },
    }) as { maxBytes: number; signal: AbortSignal };
    t.deepEqual(await collectBytes(source, accessorOptions), new Uint8Array([1]));
    t.equal(signalReads, 1, 'collection snapshots its cancellation configuration');

    let reads = 0;
    let returns = 0;
    const invalid: Iterable<Uint8Array> = {
      [Symbol.iterator]() {
        return {
          next(): IteratorResult<Uint8Array> {
            reads++;
            if (reads === 1) return { done: false, value: new Uint8Array([1]) };
            if (reads === 2) {
              return { done: false, value: new Uint16Array([2]) as unknown as Uint8Array };
            }
            return { done: true, value: undefined };
          },
          return(): IteratorResult<Uint8Array> {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await t.rejects(() => collectBytes(invalid), /chunks must be Uint8Array/);
    t.equal(reads, 2, 'collection stops at the invalid chunk');
    t.equal(returns, 1, 'invalid chunks close the acquired iterator once');
  });

  it('collects asynchronous sources with the same ownership contract', async (t) => {
    const reused = new Uint8Array([3]);
    async function* source(): AsyncIterableIterator<Uint8Array> {
      yield reused;
      reused[0] = 4;
      yield reused;
      reused[0] = 5;
    }
    const fromAsync = await collectBytes(source(), { expectedBytes: 2 });
    t.deepEqual(fromAsync, new Uint8Array([3, 4]));
    t.equal(reused[0], 5);

    let protocol = '';
    const dual: AsyncIterable<Uint8Array> & Iterable<Uint8Array> = {
      *[Symbol.iterator]() {
        protocol = 'sync';
        yield new Uint8Array([1]);
      },
      async *[Symbol.asyncIterator]() {
        protocol = 'async';
        yield new Uint8Array([2]);
      },
    };
    t.deepEqual(await collectBytes(dual), new Uint8Array([2]));
    t.equal(protocol, 'async', 'the async protocol takes precedence');

    for (const asyncMethod of [undefined, null]) {
      const fallback = {
        [Symbol.asyncIterator]: asyncMethod,
        *[Symbol.iterator]() {
          yield new Uint8Array([6]);
        },
      } as unknown as Iterable<Uint8Array>;
      t.deepEqual(await collectBytes(fallback), new Uint8Array([6]));
    }
    const invalidAsyncMethod = {
      [Symbol.asyncIterator]: 1,
      *[Symbol.iterator]() {
        yield new Uint8Array([7]);
      },
    } as unknown as Iterable<Uint8Array>;
    await t.rejects(() => collectBytes(invalidAsyncMethod), /async iterator must be callable/);
  });

  it('closes asynchronous iterators once on limits, abort, and source failure', async (t) => {
    let returns = 0;
    const limited: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            index++;
            return { done: false, value: new Uint8Array([index]) };
          },
          async return() {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await t.rejects(() => collectBytes(limited, { maxBytes: 1 }), RangeError);
    t.equal(returns, 1);

    const controller = new AbortController();
    const aborted: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            controller.abort(new Error('async stop'));
            return { done: false, value: new Uint8Array([1]) };
          },
          async return() {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await t.rejects(() => collectBytes(aborted, { signal: controller.signal }), /async stop/);
    t.equal(returns, 2);

    const primary = new Error('async source failed');
    const failing: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            throw primary;
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            returns++;
            throw new Error('async cleanup failed');
          },
        };
      },
    };
    try {
      await collectBytes(failing);
      t.fail('async source failure should propagate');
    } catch (error) {
      t.equal(error, primary, 'cleanup failure does not replace the async source failure');
    }
    t.equal(returns, 3, 'each failed async iterator is closed exactly once');
  });

  it('races pending pulls with abort and awaits iterator cleanup', async (t) => {
    let resolveNext!: (result: IteratorResult<Uint8Array>) => void;
    let resolveReturn!: (result: IteratorResult<Uint8Array>) => void;
    let returnStarted!: () => void;
    const returnStartedPromise = new Promise<void>((resolve) => {
      returnStarted = resolve;
    });
    let returns = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<Uint8Array>>((resolve) => {
              resolveNext = resolve;
            });
          },
          return() {
            returns++;
            returnStarted();
            return new Promise<IteratorResult<Uint8Array>>((resolve) => {
              resolveReturn = resolve;
            });
          },
        };
      },
    };
    const controller = new AbortController();
    const reason = new Error('pending pull aborted');
    const pending = collectBytes(source, { signal: controller.signal });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    controller.abort(reason);
    await returnStartedPromise;
    t.equal(settled, false, 'collection remains pending until iterator cleanup completes');
    resolveReturn({ done: true, value: undefined });
    try {
      await pending;
      t.fail('pending collection should reject');
    } catch (error) {
      t.equal(error, reason);
    }
    t.equal(returns, 1, 'abort closes the acquired iterator once');

    resolveNext({ done: false, value: new Uint8Array([9]) });
    await Promise.resolve();
  });

  it('does not close iterators that reached natural EOF', async (t) => {
    let returns = 0;
    const source = (): Iterable<Uint8Array> => ({
      [Symbol.iterator]() {
        let done = false;
        return {
          next(): IteratorResult<Uint8Array> {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array([1]) };
          },
          return(): IteratorResult<Uint8Array> {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    });

    t.deepEqual(await collectBytes(source()), new Uint8Array([1]));
    await t.rejects(() => collectBytes(source(), { expectedBytes: 2 }), /expected 2/);
    t.equal(returns, 0, 'success and expected-length underflow both follow natural EOF');
  });
});
