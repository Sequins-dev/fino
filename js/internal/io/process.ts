/** Direct process operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const isLinux = os === 'linux';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
export const process = dlopen(LIBC, {
  getpid: {
    parameters: [],
    result: 'i32',
  },
  getppid: {
    parameters: [],
    result: 'i32',
  },
  _exit: {
    parameters: ['i32'],
    result: 'void',
  },
  pipe: {
    parameters: ['buffer'],
    result: 'i32',
  },
  fcntl: {
    parameters: ['i32', 'i32', 'i32'],
    result: 'i32',
  },
  getrusage: {
    parameters: ['i32', 'buffer'],
    result: 'i32',
  },
});
export const pipe2Lib = isLinux
  ? dlopen(LIBC, {
      pipe2: {
        parameters: ['buffer', 'i32'],
        result: 'i32',
      },
    })
  : null;
