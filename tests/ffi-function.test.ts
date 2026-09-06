/**
 * Tests for ffiFunction — bind a code pointer obtained at runtime.
 */
import { describe, it } from 'fino:test/test';
import { dlopen, ffiFunction, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'fino:process';
const libcPath = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
// The library handle must stay alive: ffiFunction keeps nothing alive itself.
const libc = dlopen(libcPath, {
  strlen: { parameters: ['buffer'], result: 'usize' },
  abs: { parameters: ['i32'], result: 'i32' },
  malloc: { parameters: ['usize'], result: 'pointer' },
  free: { parameters: ['pointer'], result: 'void' },
});
describe('ffiFunction binding', () => {
  it('binds a pointer from DynamicLibrary.pointers', (t) => {
    const strlen = ffiFunction(libc.pointers.strlen, {
      parameters: ['buffer'],
      result: 'usize',
    });
    const input = new TextEncoder().encode('hello\0');
    t.equal(strlen(input), 5, 'strlen through a bound pointer');
  });
  it('rebinds the same pointer with a different signature', (t) => {
    const strlenBig = ffiFunction(libc.pointers.strlen, {
      parameters: ['buffer'],
      result: 'usizeBig',
    });
    const input = new TextEncoder().encode('hello world\0');
    t.equal(strlenBig(input), 11n, 'usizeBig result is a BigInt');
  });
  it('accepts a BigInt address', (t) => {
    // The pointer buffer holds the address; Pointer.addr would return where
    // those 8 bytes live instead.
    const addr = new DataView(libc.pointers.abs).getBigUint64(0, true);
    const abs = ffiFunction(addr, { parameters: ['i32'], result: 'i32' });
    t.equal(abs(-7), 7, 'abs bound from a BigInt address');
  });
  it('accepts an ArrayBufferView over a pointer buffer', (t) => {
    const view = new Uint8Array(libc.pointers.abs);
    const abs = ffiFunction(view, { parameters: ['i32'], result: 'i32' });
    t.equal(abs(-3), 3, 'abs bound from a view');
  });
  it('takes the fast-call path for scalar signatures', (t) => {
    const abs = ffiFunction(libc.pointers.abs, {
      parameters: ['i32'],
      result: 'i32',
    });
    let total = 0;
    for (let i = 0; i < 1000; i++) total += abs(-i);
    t.equal(total, 499500, 'repeated calls stay correct under fast-call');
  });
});
describe('ffiFunction async and pointer results', () => {
  it('supports async: true', async (t) => {
    const malloc = ffiFunction(libc.pointers.malloc, {
      parameters: ['usize'],
      result: 'pointer',
      async: true,
    });
    const ptr = (await malloc(32)) as ArrayBuffer;
    t.ok(ptr instanceof ArrayBuffer, 'async pointer result is an ArrayBuffer');
    Pointer.writeU8(ptr, 0, 9);
    t.equal(Pointer.readU8(ptr, 0), 9, 'memory is usable');
    libc.symbols.free(ptr);
  });
});
describe('ffiFunction with FfiCallback pointers', () => {
  it('calls back into JS through a bound callback pointer', (t) => {
    let seen = 0;
    const cb = new FfiCallback({ parameters: ['i32'], result: 'i32' }, (v: number) => {
      seen = v;
      return v * 2;
    });
    // This is the shape a C struct's function-pointer field needs: an address
    // with no name to dlopen. See js/data/arrow/cdata.ts for the release hook.
    const invoke = ffiFunction(cb.pointer, { parameters: ['i32'], result: 'i32' });
    t.equal(invoke(21), 42, 'callback return value round-trips');
    t.equal(seen, 21, 'callback received the argument');
    cb.close();
  });
});
describe('ffiFunction validation', () => {
  it('rejects a null pointer', (t) => {
    t.throws(
      () => ffiFunction(null, { parameters: [], result: 'void' }),
      /must not be null/,
      'null pointer throws',
    );
  });
  it('rejects a non-object definition', (t) => {
    t.throws(
      () => (ffiFunction as (p: unknown, d: unknown) => unknown)(libc.pointers.abs, 'nope'),
      /expected object/,
      'string definition throws',
    );
  });
  it('rejects void as a parameter type', (t) => {
    t.throws(
      () => ffiFunction(libc.pointers.abs, { parameters: ['void'], result: 'i32' }),
      /'void' cannot be used as a parameter type/,
      'void parameter throws',
    );
  });
  it('rejects an unknown type name', (t) => {
    t.throws(
      () => ffiFunction(libc.pointers.abs, { parameters: ['i33'], result: 'i32' }),
      /ffiFunction\.parameters/,
      'error is attributed to ffiFunction.parameters',
    );
  });
});
