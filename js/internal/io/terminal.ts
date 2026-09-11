/** Direct terminal operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
export const terminal = dlopen(LIBC, {
  isatty: {
    parameters: ['i32'],
    result: 'i32',
  },
  read: {
    parameters: ['i32', 'buffer', 'usize'],
    result: 'isize',
  },
});
