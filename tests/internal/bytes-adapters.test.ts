import { describe, it } from 'fino:test/test';
import { concat as concatCompressionBytes, toU8 } from 'internal:compress/common';
import { timingSafeEqual, toBytes } from 'internal:security/encoding';

describe('internal byte compatibility adapters', () => {
  it('preserves compression input acceptance and aliasing', (t) => {
    const bytes = new Uint8Array([1, 2]);
    t.equal(toU8(bytes), bytes, 'Uint8Array identity is preserved');

    const buffer = new ArrayBuffer(2);
    const view = toU8(buffer);
    view[0] = 9;
    t.equal(new Uint8Array(buffer)[0], 9, 'ArrayBuffer input remains aliased');

    t.throws(() => toU8(new DataView(new ArrayBuffer(1)) as never), /compression binary input/);
  });

  it('preserves compression concatenation compatibility paths', (t) => {
    const only = new Uint8Array([1, 2]);
    t.equal(concatCompressionBytes([only]), only, 'single-part identity remains stable');
    t.deepEqual(concatCompressionBytes([]), new Uint8Array());

    const combined = concatCompressionBytes([new Uint8Array([1]), new Uint8Array([2])]);
    t.deepEqual(combined, new Uint8Array([1, 2]));

    const padded = concatCompressionBytes([new Uint8Array([1]), new Uint8Array([2])], 4);
    t.deepEqual(padded, new Uint8Array([1, 2, 0, 0]), 'trusted total still controls sizing');
  });

  it('preserves security coercion and timing comparison semantics', (t) => {
    t.deepEqual(toBytes('hi'), new Uint8Array([104, 105]));

    const buffer = new Uint8Array([0, 1, 2, 0]).buffer;
    const visible = new DataView(buffer, 1, 2);
    const bytes = toBytes(visible);
    t.deepEqual(bytes, new Uint8Array([1, 2]));
    bytes[0] = 9;
    t.equal(visible.getUint8(0), 9, 'binary views retain aliasing');

    t.throws(() => toBytes({} as never), /Expected string, ArrayBuffer, or ArrayBufferView/);
    t.equal(timingSafeEqual('secret', new TextEncoder().encode('secret')), true);
    t.equal(timingSafeEqual('secret', 'secreu'), false);
    t.equal(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 0])), false);
  });
});
