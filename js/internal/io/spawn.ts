/** Direct spawn operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const isLinux = os === 'linux';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
export const spawn = dlopen(LIBC, {
  close: { parameters: ['i32'], result: 'i32' },
  fcntl: { parameters: ['i32', 'i32', 'i32'], result: 'i32', variadic: 2 },
  kill: { parameters: ['i32', 'i32'], result: 'i32' },
  waitpid: { parameters: ['i32', 'buffer', 'i32'], result: 'i32' },
  syscall: { parameters: ['i64', 'i64', 'i64'], result: 'i64' },
  posix_spawnp: {
    parameters: ['buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'],
    result: 'i32',
  },
  posix_spawn_file_actions_init: { parameters: ['buffer'], result: 'i32' },
  posix_spawn_file_actions_destroy: { parameters: ['buffer'], result: 'i32' },
  posix_spawn_file_actions_addopen: {
    parameters: ['buffer', 'i32', 'buffer', 'i32', 'i32'],
    result: 'i32',
  },
  posix_spawn_file_actions_adddup2: {
    parameters: ['buffer', 'i32', 'i32'],
    result: 'i32',
  },
  posix_spawn_file_actions_addclose: {
    parameters: ['buffer', 'i32'],
    result: 'i32',
  },
  posix_spawnattr_init: { parameters: ['buffer'], result: 'i32' },
  posix_spawnattr_destroy: { parameters: ['buffer'], result: 'i32' },
  posix_spawnattr_setflags: { parameters: ['buffer', 'u16'], result: 'i32' },
  posix_spawnattr_setsigdefault: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  posix_spawnattr_setsigmask: { parameters: ['buffer', 'buffer'], result: 'i32' },
});

export const spawnChdirLib = (() => {
  try {
    return dlopen(LIBC, {
      posix_spawn_file_actions_addchdir_np: {
        parameters: ['buffer', 'buffer'],
        result: 'i32',
      },
    });
  } catch (_) {
    return null;
  }
})();

export const spawnInheritLib =
  os === 'darwin'
    ? dlopen(LIBC, {
        posix_spawn_file_actions_addinherit_np: {
          parameters: ['buffer', 'i32'],
          result: 'i32',
        },
      })
    : null;

export const spawnCloseFromLib = isLinux
  ? (() => {
      try {
        return dlopen(LIBC, {
          posix_spawn_file_actions_addclosefrom_np: {
            parameters: ['buffer', 'i32'],
            result: 'i32',
          },
        });
      } catch (_) {
        return null;
      }
    })()
  : null;
