/**
 * fino:process — process information and child process spawning.
 *
 * This module combines two concerns: static process metadata (pid, cwd, argv,
 * env, etc.) and the `Process` class for spawning child processes with piped
 * stdio. The static metadata comes from `internal:process`, which is a Rust
 * synthetic module injected at compile time with values that would be awkward
 * to retrieve from JS (e.g. `execPath` needs the Rust binary's own path, and
 * `env` needs to snapshot the environ at startup).
 *
 * **Why fork+execve instead of posix_spawn?**
 * `fork(2)` + `execve(2)` is the classic UNIX child-process primitive. We use
 * it here rather than `posix_spawn` because it gives us full control over the
 * child's environment between fork and exec: we can call `dup2` to wire up
 * pipes, `chdir` to set the working directory, and close file descriptors —
 * all without the `posix_spawn` attribute machinery. The child side of the
 * fork runs between the `childPid === 0` branch and the `execve` call; any
 * failure in that branch causes `_exit(127)` (the shell convention for
 * "command not found").
 *
 *
 * ## Pipe lifecycle
 *
 * Three `pipe(2)` calls create six file descriptors before the fork:
 *
 *   stdin:  [stdinR  → child stdin,  stdinW  → parent Writer]
 *   stdout: [stdoutR → parent Reader, stdoutW → child stdout]
 *   stderr: [stderrR → parent Reader, stderrW → child stderr]
 *
 * After the fork, each process immediately closes the ends it doesn't own.
 * The parent-side fds are set to O_NONBLOCK so they can be used with the
 * event loop. The child-side fds are left blocking — they run inside
 * `execve`'d code that doesn't know about fino's event loop.
 *
 *
 * ## buildCStringArray and GC lifetime
 *
 * `execve(2)` takes a `char**` argv and a `char**` envp. We build these from
 * JS strings by encoding each string to a null-terminated UTF-8 buffer and
 * placing pointers to those buffers into a pointer array. The tricky part is
 * GC lifetime: if the individual string buffers (`bufs`) are collected before
 * `execve` runs, the pointer array will contain dangling pointers. To prevent
 * this, `buildCStringArray` returns both the pointer array and the `bufs`
 * array; callers keep `bufs` as a local variable so it remains in scope (and
 * therefore kept alive by the GC) through the `execve` call.
 *
 *
 * ## Waiting for the child process
 *
 * `Process.wait()` uses kernel-native mechanisms to avoid polling:
 *
 * - **macOS**: `loop.proc(lp, pid)` registers an EVFILT_PROC kevent. kqueue
 *   delivers a NOTE_EXIT event the instant the child changes state, with zero
 *   CPU overhead between fork and exit.
 *
 * - **Linux**: `pidfd_open(2)` (syscall 434) returns a file descriptor that
 *   becomes readable when the child exits. We poll it with `loop.readable()`
 *   just like any other fd, then close the pidfd. This is the modern
 *   alternative to `waitpid(WNOHANG)` polling loops.
 *
 * In both cases, after the kernel signals exit, a single `waitpid(pid, 0)` is
 * called to reap the zombie and retrieve the exit status. The status integer
 * is decoded using the POSIX WIFEXITED / WIFSIGNALED macros inlined as bit
 * operations.
 *
 *
 * ## Exit status decoding
 *
 * `waitpid` fills an `int` status word with the following encoding:
 *   - bits [6:0] = 0x00 → exited normally; exit code is bits [15:8]
 *   - bits [6:0] ≠ 0x00 and ≠ 0x7f → killed by signal; signal is bits [6:0]
 *   - bits [6:0] = 0x7f → stopped (WIFSTOPPED) — we ignore this case
 *
 *
 * @example
 * import { pid, cwd, argv } from './process.mts';
 * console.log(`PID ${pid}, CWD ${cwd()}, args: ${argv.join(' ')}`);
 *
 * @example
 * import { Process } from './process.mts';
 * import { decodeUtf8 } from '../internal/globals/encoding.mts';
 *
 * const proc = new Process('/bin/echo', ['hello world']);
 * for await (const chunk of proc.stdout) {
 *   console.log(decodeUtf8(chunk));
 * }
 * const { code } = await proc.wait();
 */

import { os, arch, args, env, execPath } from 'internal:process';
import { dlopen, Pointer } from 'fino:ffi';
import { encodeUtf8, decodeUtf8 } from '../internal/globals/encoding.mts';
import { FdReader, FdWriter } from '../internal/stream.mts';
import * as loop from './loop.mts';
import { topic, Topic } from '../util/topic.mts';

export interface ProcessOptions {
  cwd?:  string;
  env?:  Record<string, string>;
}

export interface WaitResult {
  code:   number | null;
  signal: number | null;
}

// ---------------------------------------------------------------------------
// Re-exports from internal:process
// ---------------------------------------------------------------------------

export { os, arch, env, execPath };

/** Command-line arguments. argv[0] is the fino binary, argv[1] is the script. */
export { args as argv };

// ---------------------------------------------------------------------------
// Platform constants
// ---------------------------------------------------------------------------

const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const isLinux = os === 'linux';

// fcntl(2) constants
const F_GETFL    = isLinux ? 3 : 3;
const F_SETFL    = 4;
const O_NONBLOCK = isLinux ? 0x0800 : 0x0004;

// waitpid(2) flags
const WNOHANG = 1;

// Linux syscall number for pidfd_open(2) — same on x86_64 and arm64.
const SYS_PIDFD_OPEN = 434n;

// Default signal for kill (also exported in signal constants below)
const _SIGTERM = 15;

// ---------------------------------------------------------------------------
// libc FFI
// ---------------------------------------------------------------------------

const lib = dlopen(LIBC, {
  getpid:  { parameters: [],                              result: 'i32'    },
  getppid: { parameters: [],                              result: 'i32'    },
  _exit:   { parameters: ['i32'],                         result: 'void'   },
  getcwd:  { parameters: ['buffer', 'usize'],             result: 'pointer' },
  chdir:   { parameters: ['buffer'],                      result: 'i32'    },
  kill:    { parameters: ['i32', 'i32'],                  result: 'i32'    },
  pipe:    { parameters: ['buffer'],                      result: 'i32'    },
  fork:    { parameters: [],                              result: 'i32'    },
  dup2:    { parameters: ['i32', 'i32'],                  result: 'i32'    },
  execve:  { parameters: ['buffer', 'buffer', 'buffer'],  result: 'i32'    },
  close:   { parameters: ['i32'],                         result: 'i32'    },
  fcntl:   { parameters: ['i32', 'i32', 'i32'],           result: 'i32'    },
  waitpid: { parameters: ['i32', 'buffer', 'i32'],        result: 'i32'    },
  syscall: { parameters: ['i64', 'i64', 'i64'],           result: 'i64'    },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Encode a JS string as a null-terminated UTF-8 buffer. */
function cstr(s: string): Uint8Array {
  const enc = encodeUtf8(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}

/**
 * Build a null-terminated array of C string pointers (char**) for execve.
 * Returns { ptrBuf: ArrayBuffer, bufs: Uint8Array[] }.
 * Callers must keep `bufs` alive (in scope) through the execve call so the
 * GC does not reclaim the backing memory before the syscall completes.
 */
function buildCStringArray(strings: string[]): { ptrBuf: ArrayBuffer; bufs: Uint8Array[] } {
  const bufs = strings.map(cstr);
  const ptrBuf = new ArrayBuffer((bufs.length + 1) * 8); // +1 for null terminator
  const view = new DataView(ptrBuf);
  for (let i = 0; i < bufs.length; i++) {
    view.setBigUint64(i * 8, Pointer.addr(bufs[i]), true);
  }
  // Last 8 bytes remain zero — null pointer terminator.
  return { ptrBuf, bufs };
}

/** Read the two int32 fds from a pipe() output buffer. */
function readPipeFds(buf: ArrayBuffer | { buffer: ArrayBuffer }): [number, number] {
  const view = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer);
  return [view.getInt32(0, true), view.getInt32(4, true)];
}

/** Set a file descriptor to non-blocking mode. */
function setNonblocking(fd: number): void {
  const flags = lib.symbols.fcntl(fd, F_GETFL, 0);
  lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

// ---------------------------------------------------------------------------
// Process-level APIs
// ---------------------------------------------------------------------------

/** Current process ID. */
export const pid = lib.symbols.getpid();

/** Parent process ID. */
export const ppid = lib.symbols.getppid();

/**
 * Terminate the current process immediately.
 * Flushes buffered stdout/stderr before exiting so pending console output is
 * not lost. Uses `_exit` (not `exit(3)`) after the flush to avoid running C
 * atexit handlers.
 * @param {number} [code=0] exit status
 */
export function exit(code: number = 0): never {
  // Flush coalesce buffers so buffered output isn't silently discarded.
  // flushSync() uses write(2) directly; errors are swallowed so _exit always runs.
  try { _stdout?.flushSync(); } catch (_) {}
  try { _stderr?.flushSync(); } catch (_) {}
  lib.symbols._exit(code);
  throw new Error('unreachable');
}

/**
 * Return the current working directory.
 * @returns {string}
 */
export function cwd(): string {
  const buf = new ArrayBuffer(4096);
  const result = lib.symbols.getcwd(buf, 4096);
  if (result === null) throw new Error('getcwd failed');
  const bytes = new Uint8Array(buf);
  const end = bytes.indexOf(0);
  return decodeUtf8(bytes.subarray(0, end === -1 ? bytes.byteLength : end));
}

/**
 * Change the current working directory. Throws on failure.
 * @param {string} path
 */
export function chdir(path: string): void {
  const ret = Number(lib.symbols.chdir(cstr(path)));
  if (ret !== 0) throw new Error(`chdir('${path}') failed`);
}

/**
 * Send a signal to a process. Throws if the syscall fails.
 * @param {number} targetPid
 * @param {number} signal
 */
export function kill(targetPid: number, signal: number): void {
  const ret = Number(lib.symbols.kill(targetPid, signal));
  if (ret !== 0) throw new Error(`kill(${targetPid}, ${signal}) failed`);
}

// ---------------------------------------------------------------------------
// process.stdin / stdout / stderr — lazy FdReader/FdWriter singletons
// ---------------------------------------------------------------------------

let _stdin:  FdReader | null = null;
let _stdout: FdWriter | null = null;
let _stderr: FdWriter | null = null;

const _noop = () => {};

/**
 * Returns a Reader for the current process's stdin (fd 0).
 * Sets the fd to non-blocking mode on first call.
 */
export function stdin(): FdReader {
  if (_stdin === null) {
    setNonblocking(0);
    _stdin = new FdReader(0, _noop);
  }
  return _stdin;
}

/**
 * Returns a Writer for the current process's stdout (fd 1).
 * Sets the fd to non-blocking mode on first call.
 */
export function stdout(): FdWriter {
  if (_stdout === null) {
    setNonblocking(1);
    _stdout = new FdWriter(1, _noop);
  }
  return _stdout;
}

/**
 * Returns a Writer for the current process's stderr (fd 2).
 * Sets the fd to non-blocking mode on first call.
 */
export function stderr(): FdWriter {
  if (_stderr === null) {
    setNonblocking(2);
    _stderr = new FdWriter(2, _noop);
  }
  return _stderr;
}

// ---------------------------------------------------------------------------
// Signal handling — Topic-based API
// ---------------------------------------------------------------------------

/** Signal numbers (POSIX, platform-aware for platform-divergent signals). */
export const SIGHUP  = 1;
export const SIGINT  = 2;
export const SIGQUIT = 3;
export const SIGKILL = 9;
export const SIGUSR1 = isLinux ? 10 : 30;
export const SIGUSR2 = isLinux ? 12 : 31;
export const SIGPIPE = 13;
export const SIGALRM = 14;
export const SIGTERM = 15;
export const SIGCHLD = isLinux ? 17 : 20;

const _signalNumbers: Record<string, number> = {
  SIGHUP, SIGINT, SIGQUIT, SIGKILL, SIGUSR1, SIGUSR2,
  SIGPIPE, SIGALRM, SIGTERM, SIGCHLD,
};

/** Set of signal names already registered with the event loop. */
const _registeredSignals = new Set<string>();

/**
 * Subscribe to a POSIX signal via a Topic.
 *
 * Returns a named Topic (`'process:<NAME>'`) that publishes `{ signal, signo }`
 * each time the signal is delivered. On the first call for a given signal name,
 * the signal is registered with the event loop so that delivery does not kill
 * the process. Subsequent calls return the same topic without re-registering.
 *
 * @param {string} name - Signal name (e.g. `'SIGTERM'`, `'SIGUSR1'`)
 * @returns {Topic} A Topic that publishes `{ signal: string, signo: number }` on delivery
 *
 * @example
 * import { signal } from './process.mts';
 *
 * const handle = signal('SIGTERM').subscribe(({ signal }) => {
 *   console.log(`Received ${signal}, shutting down...`);
 *   process.exit(0);
 * });
 *
 * // Later: handle.dispose() to unsubscribe
 */
export function signal(name: string): Topic {
  const t = topic('process:' + name);
  if (!_registeredSignals.has(name)) {
    const signo = _signalNumbers[name];
    if (signo == null) throw new Error('Unknown signal: ' + name);
    _registeredSignals.add(name);
    loop.signal(signo, function fireSignal() { t.publish({ signal: name, signo }); });
  }
  return t;
}

// ---------------------------------------------------------------------------
// Process class
// ---------------------------------------------------------------------------

/**
 * Spawn a child process with piped stdin, stdout, and stderr.
 *
 * The child is launched via fork()+execve(). The parent receives:
 * - `stdin`  — a Writer to send bytes to the child's stdin
 * - `stdout` — a Reader to receive bytes from the child's stdout
 * - `stderr` — a Reader to receive bytes from the child's stderr
 *
 * @example
 * const proc = new Process('/usr/bin/cat', []);
 * await proc.stdin.write(encodeUtf8('hello\n'));
 * proc.stdin.close();
 * for await (const chunk of proc.stdout) { ... }
 * const { code } = await proc.wait();
 */
export class Process {
  #pid: number;
  #stdin: FdWriter;
  #stdout: FdReader;
  #stderr: FdReader;

  /**
   * @param {string} command - absolute path to the executable
   * @param {string[]} [cmdArgs=[]] - arguments (excluding argv[0])
   * @param {{ cwd?: string, env?: object }} [opts]
   */
  constructor(command: string, cmdArgs: string[], opts?: ProcessOptions) {
    if (opts == null) opts = {};
    if (cmdArgs == null) cmdArgs = [];

    // Create three pipes: each pipe(buf) fills buf with [readFd, writeFd].
    const stdinBuf  = new ArrayBuffer(8);
    const stdoutBuf = new ArrayBuffer(8);
    const stderrBuf = new ArrayBuffer(8);

    if (Number(lib.symbols.pipe(stdinBuf))  < 0) throw new Error('pipe() failed for stdin');
    if (Number(lib.symbols.pipe(stdoutBuf)) < 0) throw new Error('pipe() failed for stdout');
    if (Number(lib.symbols.pipe(stderrBuf)) < 0) throw new Error('pipe() failed for stderr');

    const [stdinR,  stdinW]  = readPipeFds(stdinBuf);
    const [stdoutR, stdoutW] = readPipeFds(stdoutBuf);
    const [stderrR, stderrW] = readPipeFds(stderrBuf);

    // Build execve argv / envp before fork so GC state is consistent.
    const execArgv   = [command, ...cmdArgs];
    const envVars    = opts.env ?? env;
    const envStrings = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

    const { ptrBuf: argvBuf, bufs: argvBufs } = buildCStringArray(execArgv);
    const { ptrBuf: envpBuf, bufs: envpBufs } = buildCStringArray(envStrings);
    const commandBuf = cstr(command);
    const cwdBuf     = opts.cwd != null ? cstr(opts.cwd) : null;

    const childPid = Number(lib.symbols.fork());

    if (childPid < 0) {
      lib.symbols.close(stdinR);  lib.symbols.close(stdinW);
      lib.symbols.close(stdoutR); lib.symbols.close(stdoutW);
      lib.symbols.close(stderrR); lib.symbols.close(stderrW);
      throw new Error('fork() failed');
    }

    if (childPid === 0) {
      // ---- Child process ------------------------------------------------
      // Close the parent-side ends of each pipe.
      lib.symbols.close(stdinW);
      lib.symbols.close(stdoutR);
      lib.symbols.close(stderrR);

      // Wire child's stdio to the pipe ends.
      lib.symbols.dup2(stdinR,  0); lib.symbols.close(stdinR);
      lib.symbols.dup2(stdoutW, 1); lib.symbols.close(stdoutW);
      lib.symbols.dup2(stderrW, 2); lib.symbols.close(stderrW);

      // Optionally change working directory before exec.
      if (cwdBuf !== null) lib.symbols.chdir(cwdBuf);

      // Replace the process image.  argvBufs/envpBufs are kept in scope here
      // so their backing memory remains valid through the syscall.
      lib.symbols.execve(commandBuf, argvBuf, envpBuf);

      // execve only returns on failure — exit with a recognisable code.
      lib.symbols._exit(127);
    }

    // ---- Parent process -------------------------------------------------
    // Close the child-side ends of each pipe.
    lib.symbols.close(stdinR);
    lib.symbols.close(stdoutW);
    lib.symbols.close(stderrW);

    // Make the parent-side fds non-blocking for event-loop use.
    setNonblocking(stdinW);
    setNonblocking(stdoutR);
    setNonblocking(stderrR);

    this.#pid    = childPid;
    this.#stdin  = new FdWriter(stdinW,  function closeStdin()  { lib.symbols.close(stdinW);  });
    this.#stdout = new FdReader(stdoutR, function closeStdout() { lib.symbols.close(stdoutR); });
    this.#stderr = new FdReader(stderrR, function closeStderr() { lib.symbols.close(stderrR); });
    // argvBufs and envpBufs remain alive as local variables through the
    // execve call in the child. No explicit retention needed in the parent.
  }

  /** Write bytes to the child's stdin. */
  get stdin()  { return this.#stdin; }

  /** Read bytes from the child's stdout. */
  get stdout() { return this.#stdout; }

  /** Read bytes from the child's stderr. */
  get stderr() { return this.#stderr; }

  /** The child process ID. */
  get pid() { return this.#pid; }

  /**
   * Wait for the child process to exit using kernel notifications.
   *
   * - macOS: registers EVFILT_PROC via kqueue — zero-latency, zero-CPU wait.
   * - Linux: opens a pidfd via pidfd_open(2) and polls it with loop.readable()
   *          — the pidfd becomes readable the moment the child exits.
   *
   * After the kernel signals exit, a single waitpid(pid, 0) reaps the zombie.
   *
   * @returns {Promise<{ code: number|null, signal: number|null }>}
   */
  async wait(): Promise<WaitResult> {
    if (isLinux) {
      // pidfd_open(pid, flags=0) returns a pollable file descriptor.
      const pidfd = Number(lib.symbols.syscall(SYS_PIDFD_OPEN, BigInt(this.#pid), 0n));
      if (pidfd < 0) throw new Error(`pidfd_open(${this.#pid}) failed: errno ${-pidfd}`);
      await loop.readable(pidfd);
      lib.symbols.close(pidfd);
    } else {
      // macOS: EVFILT_PROC fires immediately when the child exits.
      await loop.proc(this.#pid);
    }

    // Reap the zombie and decode the exit status.
    const statusBuf  = new ArrayBuffer(4);
    const statusView = new DataView(statusBuf);
    lib.symbols.waitpid(this.#pid, statusBuf, 0);
    const s = statusView.getInt32(0, true);
    // WIFEXITED: low 7 bits are zero
    if ((s & 0x7f) === 0) return { code: (s >> 8) & 0xff, signal: null };
    // WIFSIGNALED: low 7 bits are non-zero and not 0x7f (stopped)
    if ((s & 0x7f) !== 0x7f) return { code: null, signal: s & 0x7f };
    return { code: null, signal: null };
  }

  /**
   * Send a signal to the child process.
   * @param {number} [signal=15] SIGTERM by default
   */
  kill(signal: number = _SIGTERM): void {
    lib.symbols.kill(this.#pid, signal);
  }
}
