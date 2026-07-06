/**
* internal:runtime/libc — low-level C library bindings for raw stdio and the process ID.
*
* This module opens the platform's C library via `fino:ffi` at load time and
* exposes the small set of primitives that the rest of the Fino standard
* library builds on. It is intentionally minimal: only functions needed by
* multiple other modules, and awkward to reopen in each of them, live here.
* The bound signatures are exactly `write(2)`, `printf(3)`, and `getpid(2)` —
* nothing more.
*
* The exports fall into three groups: raw output (`writeBytes`, `writeLine`,
* `printfRaw`), process identity (`getpid`), and a no-op lifecycle hook
* (`close`).
*
*
* ## Why this exists as a separate module
*
* Fino's design principle is "thin Rust, everything else in JS". That means
* even basic output (e.g. `console.log`) is implemented in JS. This module
* bridges the gap between JS and the OS by opening libc and exposing
* `write(2)` directly, so console-style output does not depend on any Rust
* host function.
*
* By centralising this here, other modules (the console global, the logger)
* don't each need to open libc themselves for simple output needs. Modules
* that need more libc functions (sockets, files, etc.) open libc themselves
* with their own specific function signatures rather than growing this one.
*
*
* ## Platform detection
*
* The C library path differs by OS, so `openLibc` tries a fixed list of
* candidates and keeps the first that `dlopen` accepts:
*   - macOS:         `/usr/lib/libSystem.B.dylib`
*   - Linux (glibc): `libc.so.6`
*   - Linux (musl):  `libc.so`
*
* If every candidate fails the module throws while loading — Fino cannot run
* without a C library, so this surfaces immediately rather than on first use.
*
*
* ## printf vs write
*
* Both `printfRaw` and `writeLine` ultimately reach stdout, but via different
* C functions. `writeLine` and `writeBytes` use `write(2)`, the raw POSIX
* syscall wrapper — they write exactly the bytes given, with no formatting and
* no C stdio buffering. This is what the console global uses, because it
* formats strings in JS first and wants the bytes out immediately and in
* order.
*
* `printfRaw` uses `printf(3)` and is provided for cases where C-level stdio
* buffering is acceptable. Because the signature is declared as
* `(const char *) → int` with no variadic arguments, the string is treated as
* a format string: it must not contain unescaped `%` characters, so only ever
* pass pre-formatted text and never untrusted user input.
*
*
* ## Blocking behavior
*
* `writeBytes` and `writeLine` are synchronous — they call `write(2)` directly
* without going through the event loop. This is intentional for console
* output, where deterministic, in-order writes matter more than never
* blocking. Do not route bulk or network I/O through this module; use the
* async loop primitives for that.
*
* ```ts no_run
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
import { encodeUtf8 } from '../encoding.ts';
// ---------------------------------------------------------------------------
// Platform library path
// ---------------------------------------------------------------------------
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
}> {
  const candidates = [
    '/usr/lib/libSystem.B.dylib',
    'libc.so.6',
    'libc.so'
  ];
  for (const path of candidates) {
    try {
      return dlopen(path, {
        write: {
          parameters: [
            'i32',
            'buffer',
            'usize'
          ],
          result: 'isize'
        },
        printf: {
          parameters: ['buffer'],
          result: 'i32'
        },
        getpid: {
          parameters: [],
          result: 'i32'
        }
      });
    } catch (_) {}
  }
  throw new Error('fino:libc — could not open the platform C library');
}
const _lib = openLibc();
// ---------------------------------------------------------------------------
// Exported primitives
// ---------------------------------------------------------------------------
/**
* Write raw bytes to a file descriptor with a single synchronous `write(2)`.
*
* Pass 1 for stdout and 2 for stderr, or any other open descriptor. The bytes
* are written verbatim — no encoding, framing, or trailing newline is added.
*
* The kernel's return value is passed straight through as a `number`. A
* negative result means the syscall failed (the value corresponds to a
* negated errno), and a positive result smaller than `bytes.length` is a
* short write: `write(2)` is not guaranteed to consume the whole buffer, so
* callers that need every byte delivered must loop on the returned count. This
* function does not retry and does not throw on OS errors; inspect the return
* value instead.
*
* ```ts no_run
* import { writeBytes } from 'internal:runtime/libc';
*
* const bytes = new TextEncoder().encode('hello\n');
* let off = 0;
* while (off < bytes.length) {
*   const n = writeBytes(1, bytes.subarray(off));
*   if (n < 0) throw new Error('write failed');
*   off += n;
* }
* ```
*/
export function writeBytes(fd: number, bytes: Uint8Array): number {
  return Number(_lib.symbols.write(fd, bytes, bytes.length));
}
/**
* Encode a string to UTF-8, append a newline, and write it to a descriptor.
*
* This is the convenience wrapper the console global and logger use for
* line-oriented output. The string is UTF-8 encoded, a single `\n` is
* appended, and the result is handed to `writeBytes`.
*
* Because it delegates to `writeBytes`/`write(2)`, it inherits the same
* caveats: the write is synchronous, C stdio buffers are not flushed, and a
* short write is silently possible for very large strings (the extra bytes are
* dropped rather than retried). It is intended for modest, human-readable
* lines, not bulk output.
*
* ```ts no_run
* import { writeLine } from 'internal:runtime/libc';
*
* writeLine(1, 'server listening on :8080'); // stdout
* writeLine(2, 'diagnostic: cache miss');    // stderr
* ```
*/
export function writeLine(fd: number, str: string): void {
  writeBytes(fd, encodeUtf8(str + '\n'));
}
/**
* Write a pre-formatted string to stdout via `printf(3)`.
*
* The string is UTF-8 encoded, null-terminated, and passed as the sole
* argument to `printf`, which treats it as a format string. Since no variadic
* arguments are supplied, any unescaped `%` in the input is undefined behavior
* at the C level — never pass untrusted text. Callers must pre-format their
* string (and pre-escape any literal `%` as `%%`) before calling.
*
* Unlike `writeLine`, this goes through C stdio and is subject to `printf`'s
* buffering, so output may not appear until the buffer flushes. Prefer
* `writeLine` for ordinary output; `printfRaw` exists for the rare case where
* routing through `printf` specifically is desired.
*
* ```ts no_run
* import { printfRaw } from 'internal:runtime/libc';
*
* printfRaw('ready\n');
* printfRaw('progress: 50%%\n'); // literal percent must be doubled
* ```
*/
export function printfRaw(str: string): void {
  // Null-terminate so C reads the whole string.
  const bytes = encodeUtf8(str + '\0');
  _lib.symbols.printf(bytes);
}
/**
* Return the current process ID via `getpid(2)`.
*
* The result is the OS process identifier of the running Fino process as a
* `number`. It is stable for the lifetime of the process and useful for log
* prefixes, temp-file naming, and correlating output across workers.
*
* ```ts no_run
* import { getpid, writeLine } from 'internal:runtime/libc';
*
* writeLine(1, `[pid ${getpid()}] booted`);
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
