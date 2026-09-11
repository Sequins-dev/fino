/** Direct stream operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const errnoFn = isDarwin ? '__error' : '__errno_location';
export const stream = dlopen(LIBC, {
  fstat: { parameters: ['i32', 'buffer'], result: 'i32' },
  read: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  write: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  writev: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  fcntl: {
    parameters: ['i32', 'i32', 'i32'],
    result: 'i32',
  },
  [errnoFn]: {
    parameters: [],
    result: 'pointer',
  },
});
