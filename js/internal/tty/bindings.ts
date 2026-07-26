/**
 * internal:tty/bindings — small POSIX terminal primitives for TUI hosts.
 *
 * This internal module centralizes the terminal control sequences and POSIX
 * terminal state used by `fino:tty/tui`. It is intentionally narrow: it exposes
 * alternate-screen/cursor/auto-wrap/mouse escape sequences, terminal-size
 * discovery, and the raw-mode lifecycle — nothing more. There is no rendering,
 * input decoding, or event loop here; those live in the TUI host that consumes
 * these primitives.
 *
 * Two capabilities reach into the operating system through libc (`fino:ffi`):
 * {@link queryTerminalSize} calls `ioctl(TIOCGWINSZ)`, and {@link enterRawMode}
 * calls `tcgetattr`/`cfmakeraw`/`tcsetattr`. Both degrade gracefully — the libc
 * handle is opened lazily and, if `dlopen` fails, size queries fall back to the
 * `COLUMNS`/`LINES` environment and an 80x24 default while raw mode throws a
 * {@link TtyCapabilityError}. The escape-sequence helpers are pure string
 * builders with no I/O, so they are always safe to call.
 *
 * Every helper returns a sequence rather than writing it; the caller is
 * responsible for emitting the bytes to the terminal (for example via
 * `writeStdout` from `fino:tty`). This keeps the module free of any assumption
 * about how output is buffered or batched.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import {
 *   enterAlternateScreen, hideCursor, showCursor, exitAlternateScreen,
 * } from 'internal:tty/bindings';
 *
 * await writeStdout(enterAlternateScreen() + hideCursor());
 * // ... paint the interface ...
 * await writeStdout(showCursor() + exitAlternateScreen());
 * ```
 *
 * @internal
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
      ioctl: {
        parameters: ['i32', 'u64', 'buffer'],
        result: 'i32',
      },
    });
  } catch (_) {
    return null;
  }
})();
/**
 * A terminal's usable area measured in character cells.
 *
 * Both fields count whole cells, never pixels: `width` is the number of columns
 * and `height` the number of rows. Values are always positive — the discovery
 * path in {@link queryTerminalSize} substitutes sensible defaults rather than
 * ever reporting zero or a fractional size.
 *
 * ```ts no_run
 * import { queryTerminalSize, type TerminalSize } from 'internal:tty/bindings';
 *
 * const size: TerminalSize = queryTerminalSize();
 * console.log(`painting ${size.width} columns x ${size.height} rows`);
 * ```
 */
export interface TerminalSize {
  /** Number of columns (character cells wide). */
  width: number;
  /** Number of rows (character cells tall). */
  height: number;
}
/**
 * Error raised when a requested terminal primitive is not available.
 *
 * This is thrown by {@link enterRawMode} when the platform is not POSIX, when
 * the libc bindings could not be loaded in this build, or when an underlying
 * `tcgetattr`/`tcsetattr` call fails. Catching it lets a host fall back to a
 * line-oriented mode instead of a fullscreen TUI. Instances carry the fixed
 * `name` `'TtyCapabilityError'` so they can be distinguished from other errors.
 *
 * ```ts no_run
 * import { enterRawMode, TtyCapabilityError } from 'internal:tty/bindings';
 *
 * try {
 *   const restore = enterRawMode(0);
 *   restore();
 * } catch (err) {
 *   if (err instanceof TtyCapabilityError) {
 *     console.error('interactive mode unavailable:', err.message);
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export class TtyCapabilityError extends Error {
  /** Build a capability error with an explanatory `message`. */
  constructor(message: string) {
    super(message);
    this.name = 'TtyCapabilityError';
  }
}
function posixSupported(): boolean {
  return os === 'darwin' || os === 'linux';
}
/**
 * Return the ANSI sequence that switches to the alternate screen buffer.
 *
 * The alternate buffer is a blank secondary screen that does not scroll the
 * user's scrollback. Fullscreen apps enter it on startup so that, on exit,
 * {@link exitAlternateScreen} restores the shell's previous contents intact.
 * The sequence also homes the cursor to the top-left so painting starts from a
 * known position. Emit this once at startup, not per frame.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { enterAlternateScreen } from 'internal:tty/bindings';
 *
 * await writeStdout(enterAlternateScreen());
 * ```
 */
export function enterAlternateScreen(): string {
  return '\x1B[?1049h\x1B[H';
}
/**
 * Return the ANSI sequence that leaves the alternate screen buffer.
 *
 * Restores the primary screen and the scrollback that was visible before
 * {@link enterAlternateScreen} was emitted. Always pair the two so the terminal
 * is left in the state the user started with, even on error paths.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { exitAlternateScreen } from 'internal:tty/bindings';
 *
 * await writeStdout(exitAlternateScreen());
 * ```
 */
export function exitAlternateScreen(): string {
  return '\x1B[?1049l';
}
/**
 * Return the ANSI sequence that hides the text cursor.
 *
 * Fullscreen renderers hide the cursor while painting so it does not flicker
 * across the screen between writes. Restore it with {@link showCursor} before
 * exiting or before prompting for line input.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { hideCursor } from 'internal:tty/bindings';
 *
 * await writeStdout(hideCursor());
 * ```
 */
export function hideCursor(): string {
  return '\x1B[?25l';
}
/**
 * Return the ANSI sequence that shows the text cursor.
 *
 * Undoes {@link hideCursor}. Emit this on teardown so the cursor is visible
 * again once the app releases the terminal.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { showCursor } from 'internal:tty/bindings';
 *
 * await writeStdout(showCursor());
 * ```
 */
export function showCursor(): string {
  return '\x1B[?25h';
}
/**
 * Return the ANSI sequence that disables terminal auto-wrap.
 *
 * Fullscreen renderers use this while painting exact-width rows so writing the
 * last cell of a row does not cause the terminal to wrap the cursor to the next
 * line before the renderer positions it. Re-enable with {@link enableAutoWrap}
 * on teardown so ordinary shell output wraps normally again.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { disableAutoWrap } from 'internal:tty/bindings';
 *
 * await writeStdout(disableAutoWrap());
 * ```
 */
export function disableAutoWrap(): string {
  return '\x1B[?7l';
}
/**
 * Return the ANSI sequence that re-enables terminal auto-wrap.
 *
 * Undoes {@link disableAutoWrap}, restoring the terminal's default behavior of
 * wrapping to the next line when text reaches the right margin.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { enableAutoWrap } from 'internal:tty/bindings';
 *
 * await writeStdout(enableAutoWrap());
 * ```
 */
export function enableAutoWrap(): string {
  return '\x1B[?7h';
}
/**
 * Return the ANSI sequences that enable SGR mouse reporting.
 *
 * Enables three private modes at once: `1000` (button press/release events),
 * `1002` (drag/motion events while a button is held), and `1006` (SGR
 * coordinate encoding, `CSI < ... M/m`). The SGR encoding is what lets a
 * decoder read positions beyond the legacy 223-cell limit of the original
 * X10 encoding. After emitting this, mouse activity arrives on stdin as escape
 * sequences for the host's input decoder to parse. Pair with
 * {@link exitMouseMode} on teardown.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { enterMouseMode } from 'internal:tty/bindings';
 *
 * await writeStdout(enterMouseMode());
 * ```
 */
export function enterMouseMode(): string {
  return '\x1B[?1000h\x1B[?1002h\x1B[?1006h';
}
/**
 * Return the ANSI sequences that disable mouse reporting.
 *
 * Reverses the three modes enabled by {@link enterMouseMode}, in the opposite
 * order, so the terminal stops emitting mouse escape sequences on stdin. Always
 * emit this before releasing the terminal — leaving mouse reporting on would
 * make the user's shell print garbage on every click.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { exitMouseMode } from 'internal:tty/bindings';
 *
 * await writeStdout(exitMouseMode());
 * ```
 */
export function exitMouseMode(): string {
  return '\x1B[?1006l\x1B[?1002l\x1B[?1000l';
}
/**
 * Query the current terminal size from the attached TTY.
 *
 * The primary path calls `ioctl(TIOCGWINSZ)` against stdout (fd 1) and then
 * stdin (fd 0), returning the first non-zero result. This works even when
 * output is redirected as long as one of the two descriptors is still a
 * terminal. When neither is a TTY — or when the libc bindings failed to load —
 * it falls back to the `COLUMNS` and `LINES` environment variables, and finally
 * to a fixed 80x24. The result is therefore always a valid, positive
 * {@link TerminalSize}; this function never throws.
 *
 * Call it once per paint (or on resize) rather than caching, since the terminal
 * can be resized at any time.
 *
 * ```ts no_run
 * import { queryTerminalSize } from 'internal:tty/bindings';
 *
 * const { width, height } = queryTerminalSize();
 * const blank = ' '.repeat(width);
 * for (let row = 0; row < height; row++) {
 *   // paint `blank` at each row
 * }
 * ```
 */
export function queryTerminalSize(): TerminalSize {
  if (lib !== null) {
    for (const fd of [1, 0]) {
      const winsize = new ArrayBuffer(8);
      if (Number(lib.symbols.ioctl(fd, BigInt(TIOCGWINSZ), winsize)) === 0) {
        const view = new DataView(winsize);
        const rows = view.getUint16(0, true);
        const cols = view.getUint16(2, true);
        if (rows > 0 && cols > 0)
          return {
            width: cols,
            height: rows,
          };
      }
    }
  }
  const width = Number(env.COLUMNS);
  const height = Number(env.LINES);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.floor(width) : 80,
    height: Number.isFinite(height) && height > 0 ? Math.floor(height) : 24,
  };
}
/**
 * Enter raw terminal mode and return a disposer that restores the previous mode.
 *
 * Raw mode turns off canonical line buffering, echo, and signal generation so
 * the host receives each keystroke immediately as bytes on stdin — the mode an
 * interactive TUI needs. It snapshots the current terminal attributes with
 * `tcgetattr`, derives a raw variant with `cfmakeraw`, and installs it with
 * `tcsetattr`. The returned function restores the original attributes and is
 * idempotent: calling it more than once is harmless. `_fd` selects the terminal
 * descriptor and defaults to stdin (fd 0).
 *
 * Throws a {@link TtyCapabilityError} when the platform is not POSIX
 * (macOS/Linux), when the libc bindings are unavailable in this build, or when
 * the underlying `tcgetattr`/`tcsetattr` call fails (for example when `_fd` is
 * not a terminal).
 *
 * ```ts no_run
 * import { enterRawMode } from 'internal:tty/bindings';
 *
 * const restore = enterRawMode(0);
 * try {
 *   // read raw keystrokes from stdin
 * } finally {
 *   restore();
 * }
 * ```
 */
export function enterRawMode(_fd: number = 0): () => void {
  if (!posixSupported())
    throw new TtyCapabilityError(`raw terminal mode is not supported on ${os}`);
  if (lib === null)
    throw new TtyCapabilityError('raw terminal mode bindings are not available in this build');
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
 * Subscribe to terminal resize notifications.
 *
 * Invokes `callback` once synchronously with the current {@link TerminalSize}
 * and returns a disposer to unsubscribe. This is a forward-compatible stub:
 * the runtime does not yet deliver `SIGWINCH` to JS, so no further callbacks
 * fire and the returned disposer is a no-op. Hosts that need to track live
 * resizes should still poll {@link queryTerminalSize} on each paint. The API
 * shape is stable, so once signal delivery lands, callers gain live updates
 * without changing their code.
 *
 * ```ts no_run
 * import { onResize } from 'internal:tty/bindings';
 *
 * const stop = onResize((size) => {
 *   console.log(`terminal is ${size.width}x${size.height}`);
 * });
 * stop();
 * ```
 */
export function onResize(callback: (size: TerminalSize) => void): () => void {
  callback(queryTerminalSize());
  return () => {};
}
