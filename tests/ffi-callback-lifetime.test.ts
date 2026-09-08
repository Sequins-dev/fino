/** Explicit callback leases keep native entry points alive after revocation. */
import { describe, it } from 'fino:test/test';
import { FfiCallback, ffiFunction } from 'fino:ffi';
describe('FFI callback lifetime', () => {
  it('keeps leased code callable after closing its JavaScript registration', (t) => {
    let calls = 0;
    const callback = new FfiCallback({ parameters: [], result: 'i32' }, () => ++calls);
    using first = callback.lease();
    using second = callback.lease();
    const invoke = ffiFunction(first.pointer, { parameters: [], result: 'i32', fast: false });
    t.equal(invoke(), 1);
    callback.close();
    callback.close();
    t.equal(invoke(), 0, 'revoked callback returns a zero result without running JavaScript');
    t.equal(calls, 1);
    t.throws(() => callback.lease(), /closed/);
    first.close();
    first.close();
    const other = ffiFunction(second.pointer, { parameters: [], result: 'i32', fast: false });
    t.equal(other(), 0, 'independent lease still owns the code');
  });
  it('can revoke itself while a leased native invocation is active', async (t) => {
    const callback = new FfiCallback({ parameters: [], result: 'i32' }, () => {
      callback.close();
      return 42;
    });
    using lease = callback.lease();
    const invoke = ffiFunction(lease.pointer, { parameters: [], result: 'i32', async: true });
    t.equal(await invoke(), 42);
    t.equal(await invoke(), 0);
  });
});

describe('Objective-C callback block ownership', () => {
  it('makes foreign block copies safe after the owner Realm shuts down', async (t) => {
    const { os } = await import('fino:process');
    if (os !== 'darwin') return;
    const { Realm } = await import('fino:realm');
    const { dlopen, Pointer } = await import('fino:ffi');
    const realm = Realm.fromSource(`
      import { dlopen, FfiCallback } from 'fino:ffi';
      const native = dlopen('/usr/lib/libSystem.B.dylib', {
        _Block_copy: { parameters: ['pointer'], result: 'pointer' },
      });
      export default function () {
        const callback = new FfiCallback({ parameters: [], result: 'i32' }, () => 73);
        const block = callback.block();
        return native.symbols._Block_copy(block.pointer);
      }
    `);
    const copied = await realm.call();
    await realm.run();
    const native = dlopen('/usr/lib/libSystem.B.dylib', {
      _Block_release: { parameters: ['pointer'], result: 'void' },
    });
    try {
      const code = Pointer.copyFrom(copied, 24).slice(16, 24).buffer;
      const invoke = ffiFunction(code, { parameters: ['pointer'], result: 'i32', fast: false });
      t.equal(invoke(copied), 0, 'late call never enters the retired Realm or the caller Realm');
    } finally {
      native.symbols._Block_release(copied);
    }
  });
  it('keeps native state alive when a resource getter closes the callback', async (t) => {
    const { os } = await import('fino:process');
    if (os !== 'darwin') return;
    const { dlopen, Pointer } = await import('fino:ffi');
    const native = dlopen('/usr/lib/libSystem.B.dylib', {
      free: { parameters: ['pointer'], result: 'void' },
    });
    using callback = new FfiCallback({ parameters: [], result: 'i32' }, () => 73);
    using block = callback.block([
      {
        get pointer() {
          callback.close();
          return new ArrayBuffer(8);
        },
        release: native.pointers.free,
      },
    ]);
    const code = Pointer.copyFrom(block.pointer, 24).slice(16, 24).buffer;
    const invoke = ffiFunction(code, { parameters: ['pointer'], result: 'i32', fast: false });
    t.equal(invoke(block.pointer), 0);
  });
  it('retains copied blocks and their resources until native disposal', async (t) => {
    const { os } = await import('fino:process');
    if (os !== 'darwin') {
      using callback = new FfiCallback({ parameters: [], result: 'void' }, () => {});
      t.throws(() => callback.block(), /macOS/);
      return;
    }
    const { dlopen, Pointer } = await import('fino:ffi');
    const { bindMessage, getClass, selector, withAutoreleasePool } = await import('internal:objc');
    const foundation = dlopen('/System/Library/Frameworks/Foundation.framework/Foundation', {});
    const native = dlopen('/usr/lib/libSystem.B.dylib', {
      _Block_copy: { parameters: ['pointer'], result: 'pointer' },
      _Block_release: { parameters: ['pointer'], result: 'void' },
    });
    const objc = dlopen('/usr/lib/libobjc.A.dylib', {
      objc_initWeak: { parameters: ['buffer', 'pointer'], result: 'pointer' },
      objc_destroyWeak: { parameters: ['buffer'], result: 'void' },
      objc_release: { parameters: ['pointer'], result: 'void' },
    });
    const send = bindMessage({ parameters: [], result: 'pointer' });
    const object = withAutoreleasePool(() => send(getClass('NSObject'), selector('new')));
    const weak = new BigUint64Array(1);
    objc.symbols.objc_initWeak(weak, object);
    let value = 0;
    using callback = new FfiCallback({ parameters: ['i32'], result: 'void' }, (n) => {
      value = n;
    });
    const block = callback.block([{ pointer: object, release: objc.pointers.objc_release }]);
    const copied = native.symbols._Block_copy(block.pointer);
    const code = Pointer.copyFrom(copied, 24).slice(16, 24).buffer;
    const invoke = ffiFunction(code, {
      parameters: ['pointer', 'i32'],
      result: 'void',
      fast: false,
    });
    try {
      block.close();
      block.close();
      t.ok(weak[0] !== 0n);
      invoke(copied, 17);
      t.equal(value, 17);
      callback.close();
      invoke(copied, 31);
      t.equal(value, 17, 'revoked copied block does not invoke JavaScript');
    } finally {
      native.symbols._Block_release(copied);
      t.equal(weak[0], 0n, 'native last release frees the owned object');
      objc.symbols.objc_destroyWeak(weak);
    }
    t.ok(foundation);
  });
});
