import { describe, it } from 'fino:test/test';
import {
  asByteView,
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
    t.deepEqual(dataBytes, new Uint8Array([10, 20, 30, 40]));
    dataBytes[1] = 99;
    t.equal(bytes[3], 99, 'view mutations reach the original buffer');

    const words = new Uint16Array(buffer, 2, 2);
    const wordBytes = asByteView(words);
    t.equal(wordBytes.byteOffset, 2);
    t.equal(wordBytes.byteLength, 4);
    wordBytes[2] = 77;
    t.equal(bytes[4], 77, 'typed-array views share the visible storage');

    const allBytes = asByteView(buffer);
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

  it('concatenates into fresh storage for every part count', (t) => {
    const empty = concatBytes([]);
    const anotherEmpty = concatBytes([]);
    t.deepEqual(empty, new Uint8Array());
    t.notEqual(empty.buffer, anotherEmpty.buffer, 'empty results own distinct buffers');

    const only = new Uint8Array([1, 2]);
    const single = concatBytes([only]);
    t.deepEqual(single, only);
    t.notEqual(single, only, 'single-part concatenation owns its result');
    single[0] = 9;
    t.equal(only[0], 1);

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
});
