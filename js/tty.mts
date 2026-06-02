/**
 * fino:tty — small terminal helpers for TTY detection and line-oriented I/O.
 *
 * This module is intentionally low-level. It exposes the process standard
 * streams as text helpers while leaving richer prompt behavior to
 * `fino:tty/prompt`.
 */

import { dlopen } from 'fino:ffi';
import { encodeUtf8, decodeUtf8 } from './internal/globals/encoding.mts';
import { os } from 'internal:process';
import { stdout as processStdout, stderr as processStderr } from './process.mts';
import type { BytesWriter } from './internal/stream.mts';

const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

const lib = dlopen(LIBC, {
  isatty: { parameters: ['i32'], result: 'i32' },
  read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
});

/** Return whether a numeric file descriptor is attached to a terminal. */
export function isatty(fd: number): boolean {
  return Number(lib.symbols.isatty(fd)) === 1;
}

/** Whether standard input is attached to a terminal. */
export const stdinIsTTY = isatty(0);
/** Whether standard output is attached to a terminal. */
export const stdoutIsTTY = isatty(1);
/** Whether standard error is attached to a terminal. */
export const stderrIsTTY = isatty(2);

async function writeTo(writer: BytesWriter, text: string): Promise<void> {
  await writer.write(encodeUtf8(text));
}

/**
 * Read one line from standard input, optionally writing a prompt first.
 *
 * Returns `null` when input closes before any bytes are read.
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
    if (byte === 0x0a) break;
    if (byte === 0x0d) continue;
    chunks.push(byte);
  }
  return decodeUtf8(Uint8Array.from(chunks));
}

/** Write UTF-8 text to standard output. */
export async function writeStdout(text: string): Promise<void> {
  await writeTo(processStdout(), text);
}

/** Write UTF-8 text to standard error. */
export async function writeStderr(text: string): Promise<void> {
  await writeTo(processStderr(), text);
}
