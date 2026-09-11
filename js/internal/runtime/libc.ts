/**
 * internal:runtime/libc — low-level C library bindings for raw stdio and the process ID.
 *
 * Console output and process observations are mediated by internal:io. The
 * production provider binds libc directly on the current reactor; simulations
 * can record, replace, or reject these operations without opening native libc.
 * This formatting layer adds no cross-thread transport or byte ownership change.
 *
 * The output family provides write(2), printf(3), getpid(2), and sysconf(3).
 * Callers needing bulk asynchronous I/O should use the stream endpoints.
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
import { output } from 'internal:io';
import { os } from 'internal:process';
import { encodeUtf8 } from '../encoding.ts';
// ---------------------------------------------------------------------------
// Platform library path
// ---------------------------------------------------------------------------
const _lib = output;
// `_SC_NPROCESSORS_ONLN` is not a standardised value: Darwin and glibc assign
// it different numbers, so it has to be selected per platform.
const _SC_NPROCESSORS_ONLN = os === 'darwin' ? 58 : 84;
// ---------------------------------------------------------------------------
// Exported primitives
// ---------------------------------------------------------------------------
/**
 * Number of processors currently online, or `1` when the platform will not say.
 *
 * Backs `navigator.hardwareConcurrency` and sizes the reactor thread pool.
 *
 * ```typescript no_run
 * import { onlineProcessors } from 'internal:runtime/libc';
 *
 * const threads = onlineProcessors();
 * ```
 *
 * @internal
 */
export function onlineProcessors(): number {
  const count = _lib.symbols.sysconf(_SC_NPROCESSORS_ONLN) as number;
  return Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1;
}
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
