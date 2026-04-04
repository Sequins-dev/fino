import { dlopen } from 'fino:ffi';
import { encodeUtf8, decodeUtf8 } from './internal/globals/encoding.mts';
import { os } from 'internal:process';
import { stdout as processStdout, stderr as processStderr } from './runtime/process.mts';
import type { BytesWriter } from './internal/stream.mts';

const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

const lib = dlopen(LIBC, {
  isatty: { parameters: ['i32'], result: 'i32' },
  read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
});

export function isatty(fd: number): boolean {
  return Number(lib.symbols.isatty(fd)) === 1;
}

export const stdinIsTTY = isatty(0);
export const stdoutIsTTY = isatty(1);
export const stderrIsTTY = isatty(2);

async function writeTo(writer: BytesWriter, text: string): Promise<void> {
  await writer.write(encodeUtf8(text));
}

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

export async function writeStdout(text: string): Promise<void> {
  await writeTo(processStdout(), text);
}

export async function writeStderr(text: string): Promise<void> {
  await writeTo(processStderr(), text);
}
