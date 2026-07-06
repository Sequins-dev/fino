/**
* fino:tty — small terminal helpers for TTY detection and line-oriented I/O.
*
* This module is intentionally low-level. It exposes the process standard
* streams as text helpers while leaving richer prompt behavior to
* `fino:tty/prompt`. The release contract is POSIX-oriented and line based:
* there is no raw mode API, terminal size query, color capability detection,
* cursor control, or signal-aware input abstraction yet.
*
* @example
* ```ts no_run
* import { stdinIsTTY, readLine, writeStdout } from 'fino:tty';
*
* if (stdinIsTTY) {
*   const name = await readLine('Name: ');
*   await writeStdout(`Hello ${name ?? 'anonymous'}\n`);
* }
* ```
*/
import { dlopen } from 'fino:ffi';
import { encodeUtf8, decodeUtf8 } from 'internal:encoding';
import { os } from 'internal:process';
import { stdout as processStdout, stderr as processStderr } from './process.ts';
import type { BytesWriter } from './internal/stream.ts';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const lib = dlopen(LIBC, {
  isatty: {
    parameters: ['i32'],
    result: 'i32'
  },
  read: {
    parameters: [
      'i32',
      'buffer',
      'usize'
    ],
    result: 'isize'
  }
});
/**
* Return whether a numeric file descriptor is attached to a terminal.
*
* The descriptor is passed directly to the platform `isatty(3)` call. Use this
* before enabling interactive behavior or ANSI-only output.
*
* ```ts no_run
* import { isatty } from 'fino:tty';
*
* if (isatty(1)) {
*   // stdout is an interactive terminal.
* }
* ```
*/
export function isatty(fd: number): boolean {
  return Number(lib.symbols.isatty(fd)) === 1;
}
/**
* Whether standard input is attached to a terminal.
*
* This value is computed once at module load. Prefer it for prompt policy; use
* `isatty(0)` when code needs to re-check a replaced descriptor.
*
* ```ts no_run
* import { stdinIsTTY } from 'fino:tty';
*
* if (!stdinIsTTY) {
*   // Read from redirected input or use defaults.
* }
* ```
*/
export const stdinIsTTY = isatty(0);
/**
* Whether standard output is attached to a terminal.
*
* This value is useful when deciding whether to render progress indicators or
* plain machine-readable output.
*
* ```ts no_run
* import { stdoutIsTTY } from 'fino:tty';
*
* const spinnerEnabled = stdoutIsTTY;
* ```
*/
export const stdoutIsTTY = isatty(1);
/**
* Whether standard error is attached to a terminal.
*
* Diagnostics and progress output often go to stderr, so this can differ from
* `stdoutIsTTY` when stdout is redirected.
*
* ```ts no_run
* import { stderrIsTTY } from 'fino:tty';
*
* if (stderrIsTTY) {
*   // Colored diagnostics are reasonable.
* }
* ```
*/
export const stderrIsTTY = isatty(2);
async function writeTo(writer: BytesWriter, text: string): Promise<void> {
  await writer.write(encodeUtf8(text));
  await writer.flush();
}
/**
* Read one line from standard input, optionally writing a prompt first.
*
* Returns `null` when input closes before any bytes are read.
* A trailing newline is not included, and carriage returns are ignored so CRLF
* input returns the same value as LF input. This low-level helper can block on
* interactive stdin; higher-level code should prefer `PromptSession` for
* non-interactive defaults.
*
* ```ts no_run
* import { readLine } from 'fino:tty';
*
* const name = await readLine('Name: ');
* if (name !== null) {
*   // Use the entered line without the newline.
* }
* ```
*/
export async function readLine(prompt: string = ''): Promise<string | null> {
  if (prompt.length > 0) await writeTo(processStdout(), prompt);
  const chunks: number[] = [];
  while (true) {
    const buf = new Uint8Array(1);
    const n = Number(lib.symbols.read(0, buf, 1));
    if (n <= 0) {
      if (chunks.length === 0) return null;
      break;
    }
    const byte = buf[0];
    if (byte === undefined) continue;
    if (byte === 10) break;
    if (byte === 13) continue;
    chunks.push(byte);
  }
  return decodeUtf8(Uint8Array.from(chunks));
}
/**
* Write UTF-8 text to standard output.
*
* The text is encoded as UTF-8 and written to fd 1 without adding a newline.
* Await the promise to preserve ordering with other async stream writes.
*
* ```ts no_run
* import { writeStdout } from 'fino:tty';
*
* await writeStdout('ready\n');
* ```
*/
export async function writeStdout(text: string): Promise<void> {
  await writeTo(processStdout(), text);
}
/**
* Write UTF-8 text to standard error.
*
* The text is encoded as UTF-8 and written to fd 2 without adding a newline.
* Use this for diagnostics that should not mix with stdout data.
*
* ```ts no_run
* import { writeStderr } from 'fino:tty';
*
* await writeStderr('warning: config file missing\n');
* ```
*/
export async function writeStderr(text: string): Promise<void> {
  await writeTo(processStderr(), text);
}
