/**
 * Process-wide stdout/stderr capture for runtime coordination.
 *
 * Scheduled Realms share the host file-descriptor table, and process Realms
 * inherit descriptors when spawned. Redirecting descriptors 1 and 2 is
 * therefore the only boundary that also catches raw writes and child-process
 * diagnostics which bypass JavaScript console hooks. The original descriptors
 * remain available to the coordinator for protocol output while capture is
 * active.
 *
 * Only one capture may be active in a process at a time. Call `finish()` after
 * every producer has exited so restoring the descriptors closes the final pipe
 * writers and lets the drain promises reach EOF.
 *
 * @internal
 */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
import { FdReader } from '../stream.ts';
import { writeLine } from './libc.ts';

const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const F_GETFL = 3;
const F_SETFL = 4;
const F_SETFD = 2;
const FD_CLOEXEC = 1;
const O_NONBLOCK = os === 'darwin' ? 4 : 2048;

const lib = dlopen(LIBC, {
  pipe: { parameters: ['buffer'], result: 'i32' },
  dup: { parameters: ['i32'], result: 'i32' },
  dup2: { parameters: ['i32', 'i32'], result: 'i32' },
  close: { parameters: ['i32'], result: 'i32' },
  fcntl: { parameters: ['i32', 'i32', 'i32'], result: 'i32' },
});

interface RedirectedDescriptor {
  target: 1 | 2;
  saved: number;
  reader: FdReader;
  output: Promise<CapturedOutputStream>;
}

/** Bounded captured bytes decoded as UTF-8. @internal */
export interface CapturedOutputStream {
  text: string;
  truncated: boolean;
}

/** Captured stdout and stderr returned after descriptor restoration. @internal */
export interface CapturedProcessOutput {
  stdout: CapturedOutputStream;
  stderr: CapturedOutputStream;
}

/** Active process output redirection owned by one coordinator. @internal */
export interface ProcessOutputCapture {
  /** Write a protocol line to the original stdout, bypassing capture. */
  writeStdoutLine(line?: string): void;
  /** Restore stdout/stderr and return the bounded captured streams. */
  finish(): Promise<CapturedProcessOutput>;
}

function closeFd(fd: number): void {
  if (fd >= 0) lib.symbols.close(fd);
}

function setNonblocking(fd: number): void {
  const flags = Number(lib.symbols.fcntl(fd, F_GETFL, 0));
  if (flags < 0 || Number(lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK)) < 0) {
    throw new Error(`could not make capture fd ${fd} non-blocking`);
  }
}

async function drain(reader: FdReader, maxBytes: number): Promise<CapturedOutputStream> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let retained = 0;
  let truncated = false;
  for await (const chunk of reader) {
    if (retained >= maxBytes) {
      truncated = true;
      continue;
    }
    const keep = chunk.subarray(0, maxBytes - retained);
    retained += keep.byteLength;
    if (keep.byteLength < chunk.byteLength) truncated = true;
    parts.push(decoder.decode(keep, { stream: true }));
  }
  parts.push(decoder.decode());
  return { text: parts.join(''), truncated };
}

function redirect(target: 1 | 2, maxBytes: number): RedirectedDescriptor {
  const saved = Number(lib.symbols.dup(target));
  if (saved < 0) throw new Error(`could not duplicate fd ${target}`);
  const pipeBuffer = new ArrayBuffer(8);
  if (Number(lib.symbols.pipe(pipeBuffer)) < 0) {
    closeFd(saved);
    throw new Error(`could not create capture pipe for fd ${target}`);
  }
  const view = new DataView(pipeBuffer);
  const readFd = view.getInt32(0, true);
  const writeFd = view.getInt32(4, true);
  try {
    lib.symbols.fcntl(saved, F_SETFD, FD_CLOEXEC);
    setNonblocking(readFd);
    if (Number(lib.symbols.dup2(writeFd, target)) < 0) {
      throw new Error(`could not redirect fd ${target}`);
    }
  } catch (error) {
    closeFd(readFd);
    closeFd(writeFd);
    closeFd(saved);
    throw error;
  }
  closeFd(writeFd);
  const reader = new FdReader(readFd, () => closeFd(readFd));
  return {
    target,
    saved,
    reader,
    output: drain(reader, maxBytes),
  };
}

/**
 * Redirect process stdout/stderr while retaining an uncaptured protocol sink.
 *
 * Captured data is bounded independently per descriptor. Excess bytes are
 * drained and discarded so noisy children cannot block or grow memory without
 * limit.
 *
 * @internal
 */
export function captureProcessOutput(maxBytes: number = 1024 * 1024): ProcessOutputCapture {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('process output capture limit must be a non-negative integer');
  }
  const stdout = redirect(1, maxBytes);
  let stderr: RedirectedDescriptor;
  try {
    stderr = redirect(2, maxBytes);
  } catch (error) {
    lib.symbols.dup2(stdout.saved, stdout.target);
    closeFd(stdout.saved);
    void stdout.reader.close();
    throw error;
  }
  let active = true;
  let finishPromise: Promise<CapturedProcessOutput> | undefined;
  return {
    writeStdoutLine(line: string = ''): void {
      writeLine(active ? stdout.saved : 1, line);
    },
    finish(): Promise<CapturedProcessOutput> {
      if (finishPromise !== undefined) return finishPromise;
      active = false;
      lib.symbols.dup2(stdout.saved, stdout.target);
      lib.symbols.dup2(stderr.saved, stderr.target);
      closeFd(stdout.saved);
      closeFd(stderr.saved);
      finishPromise = Promise.all([stdout.output, stderr.output]).then(([out, err]) => ({
        stdout: out,
        stderr: err,
      }));
      return finishPromise;
    },
  };
}
