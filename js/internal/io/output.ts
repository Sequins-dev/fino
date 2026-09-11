/** Direct diagnostic output and process queries for the Realm provider. @internal */
import { dlopen, type DynamicLibrary } from 'fino:ffi';
function openLibc(): DynamicLibrary<{
  write: {
    parameters: ['i32', 'buffer', 'usize'];
    result: 'isize';
  };
  printf: {
    parameters: ['buffer'];
    result: 'i32';
  };
  getpid: {
    parameters: [];
    result: 'i32';
  };
  sysconf: {
    parameters: ['i32'];
    result: 'isize';
  };
}> {
  const candidates = ['/usr/lib/libSystem.B.dylib', 'libc.so.6', 'libc.so'];
  for (const path of candidates) {
    try {
      return dlopen(path, {
        write: {
          parameters: ['i32', 'buffer', 'usize'],
          result: 'isize',
        },
        printf: {
          parameters: ['buffer'],
          result: 'i32',
        },
        getpid: {
          parameters: [],
          result: 'i32',
        },
        sysconf: {
          parameters: ['i32'],
          result: 'isize',
        },
      });
    } catch (_) {}
  }
  throw new Error('fino:libc — could not open the platform C library');
}
export const output = openLibc();
