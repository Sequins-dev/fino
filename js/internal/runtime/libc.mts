/**
 * boats:libc — low-level C library bindings used by the Boats standard library.
 *
 * This module opens the platform's C library via `boats:ffi` and exposes the
 * small set of primitives that the rest of the Boats standard library builds
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
 * Boats's design principle is "thin Rust, everything else in JS". That means
 * even basic output (e.g. `console.log`) is implemented in JS. But JS running
 * on Boa has no built-in way to write to a file descriptor. This module
 * bridges that gap by opening libc and exposing `write(2)` directly.
 *
 * By centralising this here, other modules (`boats:console`, etc.) don't each
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
 * `dlopen`. If all fail, it throws — Boats cannot run without a C library.
 *
 *
 * ## printf vs write
 *
 * Both `printfRaw` and `writeLine` ultimately write to stdout, but via
 * different C functions. `writeLine` uses `write(2)` which is the raw POSIX
 * syscall wrapper — it writes exactly the bytes given, no formatting. This is
 * what `boats:console` uses because it formats strings in JS first.
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
 */

import { dlopen } from 'boats:ffi';
import { encodeUtf8 } from 'internal:globals/encoding';

// ---------------------------------------------------------------------------
// Platform library path
// ---------------------------------------------------------------------------

function openLibc(): object {
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

  throw new Error('boats:libc — could not open the platform C library');
}

const _lib = openLibc();

// ---------------------------------------------------------------------------
// Exported primitives
// ---------------------------------------------------------------------------

/**
 * Write UTF-8 bytes to a file descriptor.
 *
 * @param {number} fd  - 1 for stdout, 2 for stderr
 * @param {Uint8Array} bytes
 * @returns {number} bytes written (or negative on error)
 */
export function writeBytes(fd: number, bytes: Uint8Array): number {
  return Number(_lib.symbols.write(fd, bytes, bytes.length));
}

/**
 * Write a string to a file descriptor, appending a newline.
 *
 * @param {number} fd
 * @param {string} str
 */
export function writeLine(fd: number, str: string): void {
  writeBytes(fd, encodeUtf8(str + '\n'));
}

/**
 * Write a pre-formatted string via printf.
 * The string must not contain unescaped % characters.
 *
 * @param {string} str
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
 */
export function getpid(): number {
  return _lib.symbols.getpid();
}

// Close the native library handle when this module is done.
// In practice the library stays open for the lifetime of the process,
// but this is the correct thing to expose.
export function close() {
  _lib.close();
}
