/** Native ownership roots release resources on close and Realm teardown. */
import { describe, it } from 'fino:test/test';
import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'fino:process';
describe('FFI native resource ownership', () => {
  it('owns native allocations with idempotent disposal', async (t) => {
    const { FfiResource } = await import('fino:ffi');
    const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
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
});
