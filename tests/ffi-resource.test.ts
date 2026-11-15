/** Native ownership roots release resources on close and Realm teardown. */
import { describe, it } from 'fino:test/test';
import { dlopen, FfiResource, Pointer } from 'fino:ffi';
import { os } from 'fino:process';
import { Realm } from 'fino:realm';

const macOSOnly = { skip: os === 'darwin' ? false : 'requires macOS' };

describe('FFI native resource ownership', () => {
  it('owns native allocations with idempotent disposal', (t) => {
    const libc = dlopen(null, {
      malloc: { parameters: ['usize'], result: 'pointer' },
      free: { parameters: ['pointer'], result: 'void' },
    });
    const pointer = libc.symbols.malloc(8);
    const resource = new FfiResource(pointer, libc.pointers.free);
    Pointer.writeU8(resource.pointer, 0, 17);
    t.equal(Pointer.readU8(resource.pointer, 0), 17);
    resource.close();
    resource.close();
    t.throws(() => new FfiResource(null, libc.pointers.free), /null/);
  });
  it('releases unclosed resources before Realm completion', macOSOnly, async (t) => {
    const { bindMessage, getClass, selector, withAutoreleasePool } = await import('internal:objc');
    const foundation = dlopen('/System/Library/Frameworks/Foundation.framework/Foundation', {});
    const objc = dlopen('/usr/lib/libobjc.A.dylib', {
      objc_initWeak: { parameters: ['buffer', 'pointer'], result: 'pointer' },
      objc_destroyWeak: { parameters: ['buffer'], result: 'void' },
      objc_release: { parameters: ['pointer'], result: 'void' },
    });
    const send = bindMessage({ parameters: [], result: 'pointer' });
    const object = withAutoreleasePool(() => send(getClass('NSObject'), selector('new')));
    const weak = new BigUint64Array(1);
    objc.symbols.objc_initWeak(weak, object);
    const realm = Realm.fromSource<(pointer: ArrayBuffer, release: ArrayBuffer) => void>(`
        import { FfiResource } from 'fino:ffi';
        export default function own(pointer: ArrayBuffer, release: ArrayBuffer) {
          new FfiResource(pointer, release);
        }
      `);
    try {
      await realm.call(object, objc.pointers.objc_release);
      await realm.run();
      t.equal(weak[0], 0n, 'Realm completion waits for its native resource destructors');
    } finally {
      if (weak[0] !== 0n) objc.symbols.objc_release(object);
      objc.symbols.objc_destroyWeak(weak);
    }
    t.ok(foundation);
  });
});
