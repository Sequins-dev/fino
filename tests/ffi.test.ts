/**
* Tests for fino:ffi — dlopen/dlsym and Pointer operations.
*/
import { describe, it } from 'fino:test/test';
import { dlopen, Pointer, structType } from 'fino:ffi';
import { os } from 'fino:process';
describe('Pointer helpers', () => {
  it('Pointer.null() returns JS null', (t) => {
    t.equal(Pointer.null(), null, 'null pointer is null');
  });
  it('Pointer.addr returns the backing-store address as BigInt', (t) => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf);
    const expected = new DataView(ptr).getBigUint64(0, true);
    t.equal(Pointer.addr(buf), expected, 'address matches Pointer.of bytes');
  });
  it('Pointer.of returns an 8-byte ArrayBuffer', (t) => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf);
    t.ok(ptr instanceof ArrayBuffer, 'is an ArrayBuffer');
    t.equal(ptr.byteLength, 8, 'is exactly 8 bytes');
  });
  it('Pointer.of with TypedArray includes byteOffset', (t) => {
    const buf = new ArrayBuffer(16);
    const view = new Uint8Array(buf, 8, 8);
    const ptrBase = Pointer.of(buf);
    const ptrView = Pointer.of(view);
    const addrBase = new DataView(ptrBase).getBigUint64(0, true);
    const addrView = new DataView(ptrView).getBigUint64(0, true);
    t.equal(addrView - addrBase, 8n, 'view pointer is 8 bytes past the buffer start');
  });
  it('Pointer.addr with TypedArray includes byteOffset', (t) => {
    const buf = new ArrayBuffer(16);
    const view = new Uint8Array(buf, 8, 8);
    const addrBase = Pointer.addr(buf);
    const addrView = Pointer.addr(view);
    t.equal(addrView - addrBase, 8n, 'view address is 8 bytes past the buffer start');
  });
  it('Pointer.offset moves pointer by byte count', (t) => {
    const buf = new ArrayBuffer(32);
    const ptr = Pointer.of(buf);
    const off = Pointer.offset(ptr, 16);
    const addr0 = new DataView(ptr).getBigUint64(0, true);
    const addr1 = new DataView(off).getBigUint64(0, true);
    t.equal(addr1 - addr0, 16n, 'offset by 16 bytes');
  });
  it('Pointer.copyFromInto copies native bytes into an ArrayBufferView', (t) => {
    const source = new Uint8Array([
      1,
      2,
      3,
      4,
      5,
      6
    ]);
    const dest = new Uint8Array([
      9,
      9,
      9,
      9,
      9,
      9,
      9,
      9
    ]);
    Pointer.copyFromInto(dest.subarray(2, 6), Pointer.of(source.subarray(1)), 4);
    t.deepEqual(Array.from(dest), [
      9,
      9,
      2,
      3,
      4,
      5,
      9,
      9
    ], 'copies into the view byte range');
  });
});
const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  malloc: {
    parameters: ['usize'],
    result: 'pointer'
  },
  free: {
    parameters: ['pointer'],
    result: 'void'
  }
});
describe('read/write via malloc', () => {
  it('malloc returns an 8-byte pointer buffer (non-null)', (t) => {
    const ptr = libc.symbols.malloc(64);
    t.ok(ptr instanceof ArrayBuffer, 'returns ArrayBuffer');
    t.equal(ptr.byteLength, 8, '8 bytes');
    t.notEqual(ptr, null, 'not null');
    const addr = new DataView(ptr).getBigUint64(0, true);
    t.ok(addr > 0n, 'non-zero address');
    libc.symbols.free(ptr);
  });
  it('read/write u8 round-trip', (t) => {
    const buf = new ArrayBuffer(4);
    const ptr = Pointer.of(buf);
    Pointer.writeU8(ptr, 0, 171);
    t.equal(Pointer.readU8(ptr, 0), 171, 'u8 round-trip');
  });
  it('read/write i32 round-trip', (t) => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf);
    Pointer.writeI32(ptr, 0, -42);
    t.equal(Pointer.readI32(ptr, 0), -42, 'i32 round-trip');
  });
  it('read/write u64 round-trip via BigInt', (t) => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf);
    Pointer.writeU64(ptr, 0, 3735928559n);
    t.equal(Pointer.readU64(ptr, 0), 3735928559n, 'u64 round-trip');
  });
  it('read/write at offset', (t) => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf);
    Pointer.writeU16(ptr, 4, 4660);
    t.equal(Pointer.readU16(ptr, 4), 4660, 'u16 at offset 4');
    t.equal(Pointer.readU16(ptr, 0), 0, 'bytes before offset untouched');
  });
  it('readPointer returns 8-byte buffer', (t) => {
    const outer = new ArrayBuffer(8);
    const inner = new ArrayBuffer(4);
    const outerPtr = Pointer.of(outer);
    const innerPtr = Pointer.of(inner);
    Pointer.writePointer(outerPtr, 0, innerPtr);
    const readBack = Pointer.readPointer(outerPtr, 0);
    t.ok(readBack instanceof ArrayBuffer, 'readPointer returns ArrayBuffer');
    t.equal(readBack.byteLength, 8, '8 bytes');
    const a1 = new DataView(innerPtr).getBigUint64(0, true);
    const a2 = new DataView(readBack).getBigUint64(0, true);
    t.equal(a2, a1, 'round-trips the pointer address');
  });
  it('malloc / free via FFI', (t) => {
    const ptr = libc.symbols.malloc(64);
    t.notEqual(ptr, null, 'malloc returns non-null');
    Pointer.writeU8(ptr, 0, 42);
    t.equal(Pointer.readU8(ptr, 0), 42, 'write-read malloc\'d memory');
    libc.symbols.free(ptr);
    t.ok(true, 'free did not throw');
  });
  it('async pointer returns resolve to pointer buffers', async (t) => {
    const asyncLibc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      malloc: {
        parameters: ['usize'],
        result: 'pointer',
        async: true
      },
      free: {
        parameters: ['pointer'],
        result: 'void'
      }
    });
    const ptr = await asyncLibc.symbols.malloc(16) as ArrayBuffer;
    t.ok(ptr instanceof ArrayBuffer, 'returns ArrayBuffer');
    t.equal(ptr.byteLength, 8, 'pointer buffer is 8 bytes');
    asyncLibc.symbols.free(ptr);
  });
});
describe('Pointer.view', () => {
  it('aliases native memory without copying', (t) => {
    const ptr = libc.symbols.malloc(16);
    const view = Pointer.view(ptr, 16);
    t.ok(view instanceof ArrayBuffer, 'returns an ArrayBuffer');
    t.equal(view.byteLength, 16, 'has the requested length');
    const mallocAddr = new DataView(ptr as ArrayBuffer).getBigUint64(0, true);
    t.equal(Pointer.addr(view), mallocAddr, 'backing store is the malloc address (zero-copy)');
    Pointer.writeU8(ptr, 3, 42);
    t.equal(new Uint8Array(view)[3], 42, 'native write visible through the view');
    new Uint8Array(view)[5] = 7;
    t.equal(Pointer.readU8(ptr, 5), 7, 'view write visible through the pointer');
    libc.symbols.free(ptr);
  });
  it('supports zero-length views', (t) => {
    const ptr = libc.symbols.malloc(8);
    const view = Pointer.view(ptr, 0);
    t.equal(view.byteLength, 0, 'zero-length view');
    libc.symbols.free(ptr);
  });
  it('rejects invalid arguments', (t) => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf) as ArrayBuffer;
    t.throws(() => Pointer.view(null, 8), /null/, 'null pointer rejected');
    t.throws(() => Pointer.view(ptr, -1), /non-negative/, 'negative length rejected');
    t.throws(() => Pointer.view(ptr, 8, { onRelease: 42 as never }), /function/, 'non-function onRelease rejected');
  });
  it('works with Pointer and struct helpers', (t) => {
    const ptr = libc.symbols.malloc(8);
    const view = Pointer.view(ptr, 8);
    const Point = structType([['x', 'i32'], ['y', 'i32']]);
    Point.set(view, 'x', 12);
    Point.set(view, 'y', -3);
    t.equal(Pointer.readI32(ptr, 0), 12, 'struct write lands in native memory');
    t.equal(Point.get(view, 'y'), -3, 'struct read from native memory');
    libc.symbols.free(ptr);
  });
  it('fires onRelease exactly once on the JS thread after detach', async (t) => {
    const { detachArrayBuffer } = await import('internal:serializer');
    const ptr = libc.symbols.malloc(8);
    let releases = 0;
    const view = Pointer.view(ptr, 8, { onRelease: () => {
      releases += 1;
      libc.symbols.free(ptr);
    } });
    t.equal(releases, 0, 'not released while the buffer is alive');
    detachArrayBuffer(view);
    for (let i = 0; i < 100 && releases === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    t.equal(releases, 1, 'onRelease fired exactly once after detach');
  });
});
describe('StructType', () => {
  it('computes C layout and reads/writes scalar fields', (t) => {
    const Inner = structType([['flag', 'u8'], ['value', 'i32']]);
    const Outer = structType([
      ['id', 'u16'],
      {
        name: '_pad0',
        type: 'bytes',
        size: 2
      },
      {
        name: 'inner',
        type: Inner
      },
      ['tail', 'f64']
    ]);
    t.equal(Inner.offsetOf('flag'), 0);
    t.equal(Inner.offsetOf('value'), 4);
    t.equal(Inner.size, 8);
    t.equal(Outer.offsetOf('inner'), 4);
    t.equal(Outer.offsetOf('tail'), 16);
    const inner = Inner.alloc();
    Inner.set(inner, 'flag', true);
    Inner.set(inner, 'value', -42);
    const outer = Outer.alloc();
    Outer.set(outer, 'id', 7);
    Outer.set(outer, 'inner', inner);
    Outer.set(outer, 'tail', 1.5);
    const innerCopy = Outer.get(outer, 'inner') as ArrayBuffer;
    t.equal(Outer.get(outer, 'id'), 7);
    t.equal(Inner.get(innerCopy, 'flag'), 1);
    t.equal(Inner.get(innerCopy, 'value'), -42);
    t.equal(Outer.get(outer, 'tail'), 1.5);
  });
  it('passes libc div_t returns by value', (t) => {
    const Div = structType([['quot', 'i32'], ['rem', 'i32']]);
    const lib = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', { div: {
      parameters: ['i32', 'i32'],
      result: Div
    } });
    const result = lib.symbols.div(17, 5) as ArrayBuffer;
    t.equal(result.byteLength, Div.size);
    t.equal(Div.get(result, 'quot'), 3);
    t.equal(Div.get(result, 'rem'), 2);
  });
  it('passes async struct returns as copied ArrayBuffers', async (t) => {
    const Div = structType([['quot', 'i32'], ['rem', 'i32']]);
    const lib = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', { div: {
      parameters: ['i32', 'i32'],
      result: Div,
      async: true
    } });
    const result = await lib.symbols.div(22, 7) as ArrayBuffer;
    t.equal(Div.get(result, 'quot'), 3);
    t.equal(Div.get(result, 'rem'), 1);
  });
  it('rejects too-small struct buffers and invalid descriptors', (t) => {
    const Point = structType([['x', 'i32'], ['y', 'i32']]);
    t.throws(() => Point.set(new ArrayBuffer(4), 'y', 1), /too small/i);
    t.throws(() => structType([{
      name: 'pad',
      type: 'bytes'
    }]), /requires size/i);
  });
  it('keeps buffer parameters as pointers, not by-value structs', (t) => {
    const lib = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', { memcmp: {
      parameters: [
        'buffer',
        'buffer',
        'usize'
      ],
      result: 'i32'
    } });
    const a = new Uint8Array([
      1,
      2,
      3
    ]);
    const b = new Uint8Array([
      1,
      2,
      4
    ]);
    t.ok(Number(lib.symbols.memcmp(a, b, 3)) < 0);
  });
});
describe('usizeBig / isizeBig return types', () => {
  const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  const libNum = dlopen(LIBC, { strlen: {
    parameters: ['buffer'],
    result: 'usize'
  } });
  const libUBig = dlopen(LIBC, { strlen: {
    parameters: ['buffer'],
    result: 'usizeBig'
  } });
  const libIBig = dlopen(LIBC, { strlen: {
    parameters: ['buffer'],
    result: 'isizeBig'
  } });
  const cstr = new TextEncoder().encode('hello\0');
  it('usize returns a JS number', (t) => {
    const n = libNum.symbols.strlen(cstr);
    t.equal(typeof n, 'number', 'usize -> number');
    t.equal(n, 5, 'strlen("hello") === 5');
  });
  it('usizeBig returns a JS bigint', (t) => {
    const n = libUBig.symbols.strlen(cstr);
    t.equal(typeof n, 'bigint', 'usizeBig -> bigint');
    t.equal(n, 5n, 'strlen("hello") === 5n');
  });
  it('isizeBig returns a JS bigint', (t) => {
    const n = libIBig.symbols.strlen(cstr);
    t.equal(typeof n, 'bigint', 'isizeBig -> bigint');
    t.equal(n, 5n, 'strlen("hello") === 5n');
  });
});
