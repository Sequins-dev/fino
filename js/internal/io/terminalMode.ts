/** Direct terminalMode operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
export const terminalMode = (() => {
  try {
    return dlopen(LIBC, {
      tcgetattr: {
        parameters: ['i32', 'buffer'],
        result: 'i32',
      },
      tcsetattr: {
        parameters: ['i32', 'i32', 'buffer'],
        result: 'i32',
      },
      cfmakeraw: {
        parameters: ['buffer'],
        result: 'void',
      },
      // `ioctl` is variadic. On ABIs such as macOS arm64, the trailing
      // argument is otherwise marshalled in the wrong location and
      // TIOCGWINSZ silently falls back to the default size.
      ioctl: {
        parameters: ['i32', 'u64', 'buffer'],
        result: 'i32',
        variadic: 2,
      },
    });
  } catch (_) {
    return null;
  }
})();
