/**
* internal:tty/bindings — small POSIX terminal primitives for TUI hosts.
*
* This internal module centralizes terminal control sequences and POSIX
* terminal state used by `fino:tty/tui`. It is intentionally narrow: v1 exposes
* alternate-screen/cursor/mouse sequences, terminal-size discovery, and
* raw-mode lifecycle. Unsupported platforms throw capability errors when raw
* mode is requested.
*
* ```ts no_run
* import { enterAlternateScreen, exitAlternateScreen } from 'internal:tty/bindings';
*
* await writeStdout(enterAlternateScreen());
* await writeStdout(exitAlternateScreen());
* ```
*/
import { env, os } from 'internal:process';
import { dlopen } from 'fino:ffi';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const TCSANOW = 0;
const TIOCGWINSZ = os === 'darwin' ? 1074295912 : 21523;
const lib = (() => {
  try {
    return dlopen(LIBC, {
      tcgetattr: {
        parameters: ['i32', 'buffer'],
        result: 'i32'
      },
      tcsetattr: {
        parameters: [
          'i32',
          'i32',
          'buffer'
        ],
        result: 'i32'
      },
      cfmakeraw: {
        parameters: ['buffer'],
        result: 'void'
      },
      ioctl: {
        parameters: [
          'i32',
          'u64',
          'buffer'
        ],
        result: 'i32'
      }
    });
  } catch (_) {
    return null;
  }
})();
/** Current terminal size in character cells. */
export interface TerminalSize {
  width: number;
  height: number;
}
/** Capability error thrown when a terminal primitive is unavailable. */
export class TtyCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtyCapabilityError';
  }
}
function posixSupported(): boolean {
  return os === 'darwin' || os === 'linux';
}
/**
* Return the ANSI sequence that enters the alternate screen buffer.
*/
export function enterAlternateScreen(): string {
  return '\x1B[?1049h\x1B[H';
}
/**
* Return the ANSI sequence that leaves the alternate screen buffer.
*/
export function exitAlternateScreen(): string {
  return '\x1B[?1049l';
}
/**
* Return the ANSI sequence that hides the cursor.
*/
export function hideCursor(): string {
  return '\x1B[?25l';
}
/**
* Return the ANSI sequence that shows the cursor.
*/
export function showCursor(): string {
  return '\x1B[?25h';
}
/**
* Return the ANSI sequence that disables terminal auto-wrap.
*
* Fullscreen renderers use this while painting exact-width rows so writing the
* last cell of a row does not cause the terminal to wrap before the next paint.
*/
export function disableAutoWrap(): string {
  return '\x1B[?7l';
}
/**
* Return the ANSI sequence that re-enables terminal auto-wrap.
*/
export function enableAutoWrap(): string {
  return '\x1B[?7h';
}
/**
* Return ANSI sequences that enable SGR mouse reporting.
*
* This enables basic button events, drag/motion events while pressed, and SGR
* coordinate encoding (`CSI < ... M/m`) so decoders can handle positions
* beyond the legacy 223-cell limit.
*/
export function enterMouseMode(): string {
  return '\x1B[?1000h\x1B[?1002h\x1B[?1006h';
}
/**
* Return ANSI sequences that disable mouse reporting enabled by
* `enterMouseMode()`.
*/
export function exitMouseMode(): string {
  return '\x1B[?1006l\x1B[?1002l\x1B[?1000l';
}
/**
* Query the terminal size from the attached TTY.
*
* The primary path uses `ioctl(TIOCGWINSZ)` on stdout, then stdin. Environment
* `COLUMNS` and `LINES` are fallbacks for non-TTY contexts, followed by 80x24.
*/
export function queryTerminalSize(): TerminalSize {
  if (lib !== null) {
    for (const fd of [1, 0]) {
      const winsize = new ArrayBuffer(8);
      if (Number(lib.symbols.ioctl(fd, BigInt(TIOCGWINSZ), winsize)) === 0) {
        const view = new DataView(winsize);
        const rows = view.getUint16(0, true);
        const cols = view.getUint16(2, true);
        if (rows > 0 && cols > 0) return {
          width: cols,
          height: rows
        };
      }
    }
  }
  const width = Number(env.COLUMNS);
  const height = Number(env.LINES);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.floor(width) : 80,
    height: Number.isFinite(height) && height > 0 ? Math.floor(height) : 24
  };
}
/**
* Enter raw terminal mode.
*
* Raw mode is reserved for the interactive TUI host. The returned disposer
* restores the original terminal attributes and is idempotent.
*/
export function enterRawMode(_fd: number = 0): () => void {
  if (!posixSupported()) throw new TtyCapabilityError(`raw terminal mode is not supported on ${os}`);
  if (lib === null) throw new TtyCapabilityError('raw terminal mode bindings are not available in this build');
  const original = new ArrayBuffer(256);
  const raw = new ArrayBuffer(256);
  if (Number(lib.symbols.tcgetattr(_fd, original)) !== 0) {
    throw new TtyCapabilityError(`tcgetattr failed for fd ${_fd}`);
  }
  new Uint8Array(raw).set(new Uint8Array(original));
  lib.symbols.cfmakeraw(raw);
  if (Number(lib.symbols.tcsetattr(_fd, TCSANOW, raw)) !== 0) {
    throw new TtyCapabilityError(`tcsetattr raw mode failed for fd ${_fd}`);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    lib.symbols.tcsetattr(_fd, TCSANOW, original);
  };
}
/**
* Subscribe to resize notifications.
*
* The current runtime does not expose SIGWINCH delivery to JS, so this returns
* a no-op disposer after reporting the current size once.
*/
export function onResize(callback: (size: TerminalSize) => void): () => void {
  callback(queryTerminalSize());
  return () => {};
}
