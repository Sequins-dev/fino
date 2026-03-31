/**
 * Tests for boats:ffi — dlopen/dlsym and Pointer operations.
 */

import { describe, it } from 'boats:test/test';
import { dlopen, Pointer } from 'boats:ffi';
import { os } from 'boats:runtime/process';

describe('Pointer helpers', () => {
  it('Pointer.null() returns null', (t) => {
    t.ok(Pointer.null() === null, 'null pointer is JS null');
  });

  it('Pointer.fromAddress / toAddress round-trip', (t) => {
    const addr = 0x1234n;
    const ptr  = Pointer.fromAddress(addr);
    t.notEqual(ptr, null, 'not null');
    t.equal(Pointer.toAddress(ptr), addr, 'address round-trips');
  });

  it('Pointer.offset moves pointer by byte count', (t) => {
    const base = Pointer.fromAddress(0x1000n);
    const off  = Pointer.offset(base, 16);
    t.equal(Pointer.toAddress(off), 0x1010n, 'offset by 16 bytes');
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
  it('Pointer.of returns pointer into ArrayBuffer', (t) => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf);
    t.notEqual(ptr, null, 'not null');
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

  it('malloc / free via FFI', (t) => {
    const ptr = libc.symbols.malloc(64);
    t.notEqual(ptr, null, 'malloc returns non-null');
    Pointer.writeU8(ptr, 0, 42);
    t.equal(Pointer.readU8(ptr, 0), 42, 'write-read malloc\'d memory');
    libc.symbols.free(ptr);
    t.ok(true, 'free did not throw');
  });
});
