/**
 * Tests for fino:ffi — dlopen/dlsym and Pointer operations.
 */

import { describe, it } from 'fino:test/test';
import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'fino:runtime/process';

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
    const view = new Uint8Array(buf, 8, 8); // byteOffset=8
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
    const ptr  = Pointer.of(buf);
    const off  = Pointer.offset(ptr, 16);
    const addr0 = new DataView(ptr).getBigUint64(0, true);
    const addr1 = new DataView(off).getBigUint64(0, true);
    t.equal(addr1 - addr0, 16n, 'offset by 16 bytes');
  });
});

const libc = dlopen(
  os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
  {
    malloc: { parameters: ['usize'], result: 'pointer' },
    free:   { parameters: ['pointer'], result: 'void' },
  }
);

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
    Pointer.writeU8(ptr, 0, 0xAB);
    t.equal(Pointer.readU8(ptr, 0), 0xAB, 'u8 round-trip');
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
    Pointer.writeU64(ptr, 0, 0xDEADBEEFn);
    t.equal(Pointer.readU64(ptr, 0), 0xDEADBEEFn, 'u64 round-trip');
  });

  it('read/write at offset', (t) => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf);
    Pointer.writeU16(ptr, 4, 0x1234);
    t.equal(Pointer.readU16(ptr, 4), 0x1234, 'u16 at offset 4');
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
});
