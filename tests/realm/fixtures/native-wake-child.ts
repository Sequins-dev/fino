/** Exercise native completion and C-to-JS callback delivery in one scheduled owner. */
import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import { getRealmData } from 'internal:realm-bridge';
const fd = Number(JSON.parse(getRealmData()));
const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize', async: true },
});
if (Number(await libc.symbols.read(fd, new ArrayBuffer(1), 1)) !== 1)
  throw new Error('read failed');
const sort = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  qsort: { parameters: ['pointer', 'usize', 'usize', 'pointer'], result: 'void', async: true },
});
const compare = new FfiCallback(
  { parameters: ['pointer', 'pointer'], result: 'i32' },
  (a, b) => Pointer.readI32(a) - Pointer.readI32(b),
);
try {
  for (let round = 0; round < 32; round++) {
    const values = new Int32Array([4, 2, 3, 1]);
    await sort.symbols.qsort(Pointer.of(values.buffer), 4n, 4n, compare.pointer);
    if (values.join(',') !== '1,2,3,4') throw new Error('callback resumed in the wrong Realm');
  }
} finally {
  compare.close();
}
