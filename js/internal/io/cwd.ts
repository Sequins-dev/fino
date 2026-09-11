/** Direct cwd operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
export const cwd = dlopen(LIBC, {
  getcwd: {
    parameters: ['buffer', 'usize'],
    result: 'pointer',
  },
  realpath: {
    parameters: ['buffer', 'buffer'],
    result: 'pointer',
  },
  opendir: {
    parameters: ['buffer'],
    result: 'pointer',
  },
  closedir: {
    parameters: ['pointer'],
    result: 'i32',
  },
});
