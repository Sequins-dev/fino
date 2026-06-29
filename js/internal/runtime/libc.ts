/**
 * fino:libc — low-level C library bindings used by the Fino standard library.
 *
 * This module opens the platform's C library via `fino:ffi` and exposes the
 * small set of primitives that the rest of the Fino standard library builds
 * on. It is intentionally minimal: only functions that are needed by multiple
 * other modules and that are awkward to reopen in each module live here.
 *
 * Currently exported:
 *   - `writeBytes(fd, bytes)` — write raw bytes to a file descriptor
 *   - `writeLine(fd, str)`    — encode a string to UTF-8 and write with newline
 *   - `printfRaw(str)`        — write a pre-formatted C string via `printf(3)`
 *   - `getpid()`              — return the current process ID
 *   - `close()`               — close the libc handle (no-op in practice)
 *
 *
 * ## Why this exists as a separate module
 *
 * Fino's design principle is "thin Rust, everything else in JS". That means
 * even basic output (e.g. `console.log`) is implemented in JS. This module
 * bridges the gap between JS and the OS by opening libc and exposing
 * `write(2)` directly.
 *
 * By centralising this here, other modules (the console global, etc.) don't each
 * need to open libc themselves for simple output needs. Modules that need more
 * libc functions (sockets, files, etc.) open libc themselves with their
 * specific function signatures.
 *
 *
 * ## Platform detection
 *
 * The C library path differs by OS:
 *   - macOS:        `/usr/lib/libSystem.B.dylib`
 *   - Linux (glibc): `libc.so.6`
 *   - Linux (musl):  `libc.so`
 *
 * `openLibc()` tries each candidate in order and returns the first successful
 * `dlopen`. If all fail, it throws — Fino cannot run without a C library.
 *
 *
 * ## printf vs write
 *
 * Both `printfRaw` and `writeLine` ultimately write to stdout, but via
 * different C functions. `writeLine` uses `write(2)` which is the raw POSIX
 * syscall wrapper — it writes exactly the bytes given, no formatting. This is
 * what the console global uses because it formats strings in JS first.
 *
 * `printfRaw` uses `printf(3)` and is provided as an alternative for cases
 * where the C-level buffering of printf is acceptable. The string must not
 * contain unescaped `%` characters (pass a pre-formatted string only, never
 * user input) because we only declare the signature as `(const char *) → int`.
 *
 *
 * ## Contributing
 *
 * - Keep this module small. If you need a libc function that's only used in
 *   one place, open libc in that module directly.
 * - `writeBytes` and `writeLine` are synchronous — they call `write(2)`
 *   directly without going through the event loop. This is intentional for
 *   console output, where you want deterministic, in-order output.
 *
 * ## Example
 *
 * ```typescript no_run
 * import { writeLine, getpid } from 'internal:runtime/libc';
 *
 * writeLine(1, `worker pid: ${getpid()}`);
 * writeLine(2, 'diagnostic message');
 * ```
 *
 * @internal
 */

import { dlopen } from 'fino:ffi';
import type { DynamicLibrary } from 'fino:ffi';
import { encodeUtf8 } from '../../globals/encoding.ts';

// ---------------------------------------------------------------------------
// Platform library path
// ---------------------------------------------------------------------------

function openLibc(): DynamicLibrary<{
  write: { parameters: ['i32', 'buffer', 'usize']; result: 'isize' };
  printf: { parameters: ['buffer']; result: 'i32' };
  getpid: { parameters: []; result: 'i32' };
}> {
  const candidates = [
    '/usr/lib/libSystem.B.dylib', // macOS
    'libc.so.6',                   // Linux (glibc)
    'libc.so',                     // Linux (musl / older)
  ];

  for (const path of candidates) {
    try {
      return dlopen(path, {
        // POSIX write(2): ssize_t write(int fd, const void *buf, size_t count)
        write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },

        // POSIX printf(3): we call it with a pre-formatted string so there
        // are no variadic arguments to worry about. The format string IS the
        // complete message — never contains user-supplied % characters.
        // Declared as (const char *fmt) → int.
        printf: { parameters: ['buffer'], result: 'i32' },

        // getpid() — useful for debugging / process identity
        getpid: { parameters: [], result: 'i32' },
      });
    } catch (_) {
      // Try the next candidate
    }
  }

  throw new Error('fino:libc — could not open the platform C library');
}

const _lib = openLibc();

// ---------------------------------------------------------------------------
// Exported primitives
// ---------------------------------------------------------------------------

/**
 * Write UTF-8 bytes to a file descriptor.
 *
 * This is a synchronous `write(2)` call. It returns the OS result directly, so
 * negative values indicate an error and short writes are possible.
 *
 * @param {number} fd  - 1 for stdout, 2 for stderr
 * @param {Uint8Array} bytes
 * @returns {number} bytes written (or negative on error)
 *
 * ```typescript no_run
 * import { writeBytes } from 'internal:runtime/libc';
 * writeBytes(1, new TextEncoder().encode('hello\n'));
 * ```
 */
export function writeBytes(fd: number, bytes: Uint8Array): number {
  return Number(_lib.symbols.write(fd, bytes, bytes.length));
}

/**
 * Write a string to a file descriptor, appending a newline.
 *
 * The string is encoded as UTF-8 before writing. This helper does not retry on
 * short writes and does not flush C stdio buffers because it uses `write(2)`.
 *
 * @param {number} fd
 * @param {string} str
 *
 * ```typescript no_run
 * import { writeLine } from 'internal:runtime/libc';
 * writeLine(2, 'diagnostic');
 * ```
 */
export function writeLine(fd: number, str: string): void {
  writeBytes(fd, encodeUtf8(str + '\n'));
}

/**
 * Write a pre-formatted string via printf.
 * The string must not contain unescaped % characters.
 *
 * The input is passed as the format string and no variadic arguments are
 * supplied, so never pass untrusted text containing `%`.
 *
 * @param {string} str
 *
 * ```typescript no_run
 * import { printfRaw } from 'internal:runtime/libc';
 * printfRaw('ready\n');
 * ```
 */
export function printfRaw(str: string): void {
  // Null-terminate so C reads the whole string.
  const bytes = encodeUtf8(str + '\0');
  _lib.symbols.printf(bytes);
}

/**
 * Return the current process ID.
 *
 * @returns {number}
 *
 * ```typescript no_run
 * import { getpid } from 'internal:runtime/libc';
 * const pid = getpid();
 * ```
 */
export function getpid(): number {
  return _lib.symbols.getpid();
}

/**
 * Close the native library handle abstraction.
 *
 * Currently a no-op because `dlopen` handles stay process-global for the
 * runtime lifetime. It exists so callers can use a uniform cleanup shape.
 *
 * ```typescript no_run
 * import * as libc from 'internal:runtime/libc';
 * libc.close();
 * ```
 *
 * @internal
 */
export function close() {
  // dlopen() handles stay process-global for the runtime lifetime.
}
