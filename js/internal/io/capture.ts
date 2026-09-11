/** Direct capture operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
export const capture = dlopen(LIBC, {
  pipe: { parameters: ['buffer'], result: 'i32' },
  dup: { parameters: ['i32'], result: 'i32' },
  dup2: { parameters: ['i32', 'i32'], result: 'i32' },
  close: { parameters: ['i32'], result: 'i32' },
  fcntl: { parameters: ['i32', 'i32', 'i32'], result: 'i32' },
});
