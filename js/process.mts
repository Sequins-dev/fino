/**
 * fino:process - process information and child process spawning.
 *
 * This module combines two concerns: static process metadata (pid, cwd, argv,
 * env, etc.) and the `Process` class for spawning child processes with piped
 * stdio. The static metadata comes from `internal:process`, which is a Rust
 * synthetic module injected at compile time with values that would be awkward
 * to retrieve from JS (e.g. `execPath` needs the Rust binary's own path, and
 * `env` needs to snapshot the environ at startup).
 *
 * The child-process APIs are POSIX-oriented. They use `posix_spawnp(3)`,
 * `pipe(2)`, `kill(2)`, and `waitpid(2)` semantics, with macOS and Linux
 * event-loop integrations for process-exit notification.
 * This is not Node's global `process` object or `child_process` API: stdio is
 * always three parent-managed pipes, `env` replaces rather than merges, and
 * there is no shell option, detached child mode, IPC channel, uid/gid switching,
 * Node event-emitter process lifecycle, or Windows behavior contract.
 *
 * **Why posix_spawn?**
 * `execve(2)` replaces the current process image, so spawning a different
 * program while keeping Fino alive requires a primitive that creates a child
 * process and then execs it. `posix_spawnp(3)` provides that operation while
 * keeping the child-side fd setup inside libc file actions.
 *
 *
 * ## Pipe lifecycle
 *
 * Three `pipe(2)` calls create six file descriptors before spawning:
 *
 *   stdin:  [stdinR  -> child stdin,  stdinW  -> parent Writer]
 *   stdout: [stdoutR -> parent Reader, stdoutW -> child stdout]
 *   stderr: [stderrR -> parent Reader, stderrW -> child stderr]
 *
 * `posix_spawn_file_actions_*` wires the child-side fds before exec. The
 * parent-side fds are set to O_NONBLOCK so they can be used with the event
 * loop.
 *
 *
 * ## buildCStringArray and GC lifetime
 *
 * `posix_spawnp(3)` takes a `char**` argv and a `char**` envp. We build these from
 * JS strings by encoding each string to a null-terminated UTF-8 buffer and
 * placing pointers to those buffers into a pointer array. The tricky part is
 * GC lifetime: if the individual string buffers (`bufs`) are collected before
 * `posix_spawnp` copies them, the pointer array will contain dangling pointers. To prevent
 * this, `buildCStringArray` returns both the pointer array and the `bufs`
 * array; callers keep `bufs` as a local variable so it remains in scope (and
 * therefore kept alive by the GC) through the spawn call.
 *
 *
 * ## Waiting for the child process
 *
 * `Process.wait()` uses kernel-native mechanisms to avoid polling:
 *
 * - **macOS**: `loop.proc(lp, pid)` registers an EVFILT_PROC kevent. kqueue
 *   delivers a NOTE_EXIT event the instant the child changes state, with zero
 *   CPU overhead while the parent waits for exit.
 *
 * - **Linux**: `pidfd_open(2)` (syscall 434) returns a file descriptor that
 *   becomes readable when the child exits. We poll it with `loop.readable()`
 *   just like any other fd, then close the pidfd. This is the modern
 *   alternative to `waitpid(2)` polling loops.
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
 *   - bits [6:0] = 0x00 -> exited normally; exit code is bits [15:8]
 *   - bits [6:0] != 0x00 and != 0x7f -> killed by signal; signal is bits [6:0]
 *   - bits [6:0] = 0x7f -> stopped (WIFSTOPPED) - we ignore this case
 *
 *
 * ```ts no_run
 * import { pid, cwd, argv } from 'fino:process';
 * console.log(`PID ${pid}, CWD ${cwd()}, args: ${argv.join(' ')}`);
 * ```
 *
 * ```ts no_run
 * import { Process } from 'fino:process';
 *
 * const proc = new Process('/bin/echo', ['hello world']);
 * for await (const chunk of proc.stdout) {
 *   console.log(new TextDecoder().decode(chunk));
 * }
 * const { code } = await proc.wait();
 * ```
 */

import { os, arch, args, env, execPath } from 'internal:process';
import { dlopen, Pointer } from 'fino:ffi';
import { encodeUtf8, decodeUtf8 } from './globals/encoding.mts';
import { FdReader, FdWriter } from './internal/stream.mts';
import * as loop from './internal/runtime/loop.mts';
import { topic, Topic } from './context/topic.mts';

/**
 * Options for spawning a child process.
 *
 * Only `cwd` and `env` are supported. Node-style options such as `stdio`,
 * `shell`, `detached`, `ipc`, `uid`, and `gid` are not part of this API.
 *
 * ```ts no_run
 * import { Process, type ProcessOptions } from 'fino:process';
 *
 * const opts: ProcessOptions = { cwd: '/tmp', env: { PATH: '/usr/bin' } };
 * const proc = new Process('/usr/bin/env', [], opts);
 * ```
 */
export interface ProcessOptions {
  /**
   * Working directory for the child process.
   *
   * When omitted, the child inherits the parent's current working directory.
   * If the directory cannot be entered during spawn setup, construction throws
   * before a child process is returned.
   *
   * ```ts no_run
   * import type { ProcessOptions } from 'fino:process';
   *
   * const opts: ProcessOptions = { cwd: '/srv/app' };
   * ```
   */
  cwd?:  string;
  /**
   * Environment passed to the spawned process.
   *
   * When omitted, the runtime startup environment snapshot is used. Supplying
   * this object replaces, rather than merges with, the inherited environment.
   *
   * ```ts no_run
   * import type { ProcessOptions } from 'fino:process';
   *
   * const opts: ProcessOptions = { env: { PATH: '/usr/bin', NODE_ENV: 'test' } };
   * ```
   */
  env?:  Record<string, string>;
}

/**
 * Exit status returned by `Process.wait`.
 *
 * Exactly one of `code` or `signal` is usually non-null. Both can be `null` for
 * status states the decoder does not currently expose, such as stopped
 * children.
 *
 * ```ts no_run
 * import type { WaitResult } from 'fino:process';
 *
 * const result: WaitResult = { code: 0, signal: null };
 * ```
 */
export interface WaitResult {
  /**
   * Numeric exit code for a normally exited child.
   *
   * The value is `null` when the child was killed by a signal or when the
   * status could not be decoded as a normal exit.
   *
   * ```ts no_run
   * import { Process } from 'fino:process';
   *
   * const result = await new Process('/bin/true', []).wait();
   * console.log(result.code);
   * ```
   */
  code:   number | null;
  /**
   * Signal number that terminated the child.
   *
   * The value is `null` for normal exits. Use exported signal constants such as
   * `SIGTERM` when comparing known signals.
   *
   * ```ts no_run
   * import { Process, SIGTERM } from 'fino:process';
   *
   * const result = await new Process('/bin/sleep', ['1']).wait();
   * console.log(result.signal === SIGTERM);
   * ```
   */
  signal: number | null;
}

// ---------------------------------------------------------------------------
// Re-exports from internal:process
// ---------------------------------------------------------------------------

/**
 * Runtime process metadata re-exported from `internal:process`.
 *
 * `os` and `arch` identify the platform, `env` is the startup environment
 * snapshot, and `execPath` is the fino executable path.
 *
 * ```ts no_run
 * import { arch, env, execPath, os } from 'fino:process';
 *
 * console.log(os, arch, execPath, env.PATH);
 * ```
 */
export { os, arch, env, execPath };

/**
 * Command-line arguments.
 *
 * `argv[0]` is the fino binary and `argv[1]` is the script path when a script
 * was launched. The array is a startup snapshot from the runtime.
 *
 * ```ts no_run
 * import { argv } from 'fino:process';
 *
 * console.log(argv.slice(2));
 * ```
 */
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

// Linux syscall number for pidfd_open(2) - same on x86_64 and arm64.
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
  close:   { parameters: ['i32'],                         result: 'i32'    },
  fcntl:   { parameters: ['i32', 'i32', 'i32'],           result: 'i32'    },
  waitpid: { parameters: ['i32', 'buffer', 'i32'],        result: 'i32'    },
  syscall: { parameters: ['i64', 'i64', 'i64'],           result: 'i64'    },
  posix_spawnp: { parameters: ['buffer', 'buffer', 'buffer', 'pointer', 'buffer', 'buffer'], result: 'i32' },
  posix_spawn_file_actions_init:     { parameters: ['buffer'], result: 'i32' },
  posix_spawn_file_actions_destroy:  { parameters: ['buffer'], result: 'i32' },
  posix_spawn_file_actions_adddup2:  { parameters: ['buffer', 'i32', 'i32'], result: 'i32' },
  posix_spawn_file_actions_addclose: { parameters: ['buffer', 'i32'], result: 'i32' },
});

const spawnChdirLib = (() => {
  try {
    return dlopen(LIBC, {
      posix_spawn_file_actions_addchdir_np: { parameters: ['buffer', 'buffer'], result: 'i32' },
    });
  } catch (_) {
    return null;
  }
})();

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
 * Build a null-terminated array of C string pointers (char**) for posix_spawnp.
 * Returns { ptrBuf: ArrayBuffer, bufs: Uint8Array[] }.
 * Callers must keep `bufs` alive (in scope) through the spawn call so the
 * GC does not reclaim the backing memory before the syscall completes.
 */
function buildCStringArray(strings: string[]): { ptrBuf: ArrayBuffer; bufs: Uint8Array[] } {
  const bufs = strings.map(cstr);
  const ptrBuf = new ArrayBuffer((bufs.length + 1) * 8); // +1 for null terminator
  const view = new DataView(ptrBuf);
  for (let i = 0; i < bufs.length; i++) {
    view.setBigUint64(i * 8, Pointer.addr(bufs[i]), true);
  }
  // Last 8 bytes remain zero - null pointer terminator.
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
  if (flags < 0) throw new Error(`fcntl(F_GETFL) failed on fd ${fd}`);
  const rc = lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  if (rc < 0) throw new Error(`fcntl(F_SETFL) failed on fd ${fd}`);
}

// Opaque libc storage for posix_spawn_file_actions_t. The exact struct differs
// by platform; this is intentionally larger than current Linux/macOS layouts.
const POSIX_SPAWN_FILE_ACTIONS_BYTES = 512;

function addSpawnAction(rc: number, action: string): void {
  if (rc !== 0) throw new Error(`${action} failed: errno ${rc}`);
}

function addCloseIfNeeded(actions: ArrayBuffer, fd: number, targetFd: number): void {
  if (fd === targetFd) return;
  addSpawnAction(
    Number(lib.symbols.posix_spawn_file_actions_addclose(actions, fd)),
    `posix_spawn_file_actions_addclose(${fd})`,
  );
}

// ---------------------------------------------------------------------------
// Process-level APIs
// ---------------------------------------------------------------------------

/**
 * Current process ID.
 *
 * This value is read once from `getpid()` during module evaluation and is
 * stable for the lifetime of the process.
 *
 * ```ts no_run
 * import { pid } from 'fino:process';
 *
 * console.log(`running as ${pid}`);
 * ```
 */
export const pid = lib.symbols.getpid();

/**
 * Parent process ID.
 *
 * This value is read from `getppid()` during module evaluation. It may not
 * reflect later parent changes caused by reparenting after startup.
 *
 * ```ts no_run
 * import { ppid } from 'fino:process';
 *
 * console.log(`parent ${ppid}`);
 * ```
 */
export const ppid = lib.symbols.getppid();

/**
 * Terminate the current process immediately.
 * Flushes buffered stdout/stderr before exiting so pending console output is
 * not lost. Uses `_exit` (not `exit(3)`) after the flush to avoid running C
 * atexit handlers.
 *
 * This function never returns. Errors during stream flushing are swallowed so
 * the process still exits.
 *
 * ```ts no_run
 * import { exit } from 'fino:process';
 *
 * exit(0);
 * ```
 *
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
 *
 * Throws if `getcwd(2)` fails. The returned string is decoded as UTF-8 from a
 * fixed-size buffer.
 *
 * ```ts no_run
 * import { cwd } from 'fino:process';
 *
 * console.log(cwd());
 * ```
 *
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
 *
 * The change affects the whole current process and therefore all realms in the
 * process that consult process cwd. Use absolute paths for predictable results.
 *
 * ```ts no_run
 * import { chdir, cwd } from 'fino:process';
 *
 * chdir('/tmp');
 * console.log(cwd());
 * ```
 *
 * @param {string} path
 */
export function chdir(path: string): void {
  const ret = Number(lib.symbols.chdir(cstr(path)));
  if (ret !== 0) throw new Error(`chdir('${path}') failed`);
}

/**
 * Send a signal to a process. Throws if the syscall fails.
 *
 * The target may be the current process, a child, or any process permitted by
 * the operating system. Passing an invalid PID or signal causes an error.
 *
 * ```ts no_run
 * import { kill, pid, SIGTERM } from 'fino:process';
 *
 * kill(pid, SIGTERM);
 * ```
 *
 * @param {number} targetPid
 * @param {number} signal
 */
export function kill(targetPid: number, signal: number): void {
  const ret = Number(lib.symbols.kill(targetPid, signal));
  if (ret !== 0) throw new Error(`kill(${targetPid}, ${signal}) failed`);
}

// ---------------------------------------------------------------------------
// process.stdin / stdout / stderr - lazy FdReader/FdWriter singletons
// ---------------------------------------------------------------------------

let _stdin:  FdReader | null = null;
let _stdout: FdWriter | null = null;
let _stderr: FdWriter | null = null;

const _noop = () => {};

/**
 * Returns a Reader for the current process's stdin (fd 0).
 * Sets the fd to non-blocking mode on first call.
 *
 * The same `FdReader` instance is returned on subsequent calls. The call can
 * throw if changing fd 0 to non-blocking mode fails.
 *
 * ```ts no_run
 * import { stdin } from 'fino:process';
 *
 * for await (const chunk of stdin()) console.log(chunk.byteLength);
 * ```
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
 *
 * The same `FdWriter` instance is returned on subsequent calls. Use
 * `flushSync()` before abrupt exits when output ordering matters.
 *
 * ```ts no_run
 * import { stdout } from 'fino:process';
 *
 * await stdout().write(new TextEncoder().encode('hello\n'));
 * ```
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
 *
 * The same `FdWriter` instance is returned on subsequent calls. The call can
 * throw if changing fd 2 to non-blocking mode fails.
 *
 * ```ts no_run
 * import { stderr } from 'fino:process';
 *
 * await stderr().write(new TextEncoder().encode('error\n'));
 * ```
 */
export function stderr(): FdWriter {
  if (_stderr === null) {
    setNonblocking(2);
    _stderr = new FdWriter(2, _noop);
  }
  return _stderr;
}

// ---------------------------------------------------------------------------
// Signal handling - Topic-based API
// ---------------------------------------------------------------------------

/**
 * Hangup signal number.
 *
 * ```ts no_run
 * import { SIGHUP, signal } from 'fino:process';
 *
 * signal('SIGHUP').subscribe(({ signo }) => console.log(signo === SIGHUP));
 * ```
 */
export const SIGHUP  = 1;
/**
 * Interrupt signal number.
 *
 * ```ts no_run
 * import { SIGINT, signal } from 'fino:process';
 *
 * signal('SIGINT').subscribe(({ signo }) => console.log(signo === SIGINT));
 * ```
 */
export const SIGINT  = 2;
/**
 * Quit signal number.
 *
 * ```ts no_run
 * import { SIGQUIT } from 'fino:process';
 *
 * console.log(SIGQUIT);
 * ```
 */
export const SIGQUIT = 3;
/**
 * Kill signal number.
 *
 * `SIGKILL` cannot be caught or handled by `signal()`, but it can be sent with
 * `kill()` where the operating system permits it.
 *
 * ```ts no_run
 * import { kill, pid, SIGKILL } from 'fino:process';
 *
 * kill(pid, SIGKILL);
 * ```
 */
export const SIGKILL = 9;
/**
 * User-defined signal 1 number.
 *
 * The numeric value is platform-aware: Linux and Darwin use different values.
 *
 * ```ts no_run
 * import { SIGUSR1, signal } from 'fino:process';
 *
 * signal('SIGUSR1').subscribe(({ signo }) => console.log(signo === SIGUSR1));
 * ```
 */
export const SIGUSR1 = isLinux ? 10 : 30;
/**
 * User-defined signal 2 number.
 *
 * The numeric value is platform-aware: Linux and Darwin use different values.
 *
 * ```ts no_run
 * import { SIGUSR2, signal } from 'fino:process';
 *
 * signal('SIGUSR2').subscribe(({ signo }) => console.log(signo === SIGUSR2));
 * ```
 */
export const SIGUSR2 = isLinux ? 12 : 31;
/**
 * Broken pipe signal number.
 *
 * ```ts no_run
 * import { SIGPIPE } from 'fino:process';
 *
 * console.log(SIGPIPE);
 * ```
 */
export const SIGPIPE = 13;
/**
 * Alarm signal number.
 *
 * ```ts no_run
 * import { SIGALRM, signal } from 'fino:process';
 *
 * signal('SIGALRM').subscribe(({ signal }) => console.log(signal));
 * ```
 */
export const SIGALRM = 14;
/**
 * Termination signal number.
 *
 * This is the default signal used by `Process.kill()`.
 *
 * ```ts no_run
 * import { Process, SIGTERM } from 'fino:process';
 *
 * const proc = new Process('/bin/sleep', ['10']);
 * proc.kill(SIGTERM);
 * ```
 */
export const SIGTERM = 15;
/**
 * Child-status signal number.
 *
 * The numeric value is platform-aware. This signal is delivered when child
 * process status changes.
 *
 * ```ts no_run
 * import { SIGCHLD, signal } from 'fino:process';
 *
 * signal('SIGCHLD').subscribe(({ signo }) => console.log(signo === SIGCHLD));
 * ```
 */
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
 * ```ts no_run
 * import { signal } from './process.mts';
 *
 * const handle = signal('SIGTERM').subscribe(({ signal }) => {
 *   console.log(`Received ${signal}, shutting down...`);
 *   handle.dispose();
 * });
 *
 * // Later: handle.dispose() to unsubscribe
 * ```
 *
 * Unknown signal names throw. The returned topic is shared by signal name, so
 * multiple calls subscribe to the same event source.
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
 * The child is launched via `posix_spawnp()`. The parent receives:
 * - `stdin` - a Writer to send bytes to the child's stdin
 * - `stdout` - a Reader to receive bytes from the child's stdout
 * - `stderr` - a Reader to receive bytes from the child's stderr
 *
 * Construction throws if pipe creation, spawn file-action setup, process spawn,
 * or parent-side non-blocking setup fails.
 *
 * ```ts no_run
 * import { Process } from 'fino:process';
 *
 * const proc = new Process('/usr/bin/cat', []);
 * await proc.stdin.write(new TextEncoder().encode('hello\n'));
 * proc.stdin.close();
 * for await (const chunk of proc.stdout) {
 *   console.log(new TextDecoder().decode(chunk));
 * }
 * const { code } = await proc.wait();
 * ```
 */
export class Process {
  /**
   * Private property `#pid` used by `Process`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #pid = undefined;
   *
   *   readInternalState() {
   *     return this.#pid;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #pid: number;
  /**
   * Private property `#stdin` used by `Process`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #stdin = undefined;
   *
   *   readInternalState() {
   *     return this.#stdin;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #stdin: FdWriter;
  /**
   * Private property `#stdout` used by `Process`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #stdout = undefined;
   *
   *   readInternalState() {
   *     return this.#stdout;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #stdout: FdReader;
  /**
   * Private property `#stderr` used by `Process`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #stderr = undefined;
   *
   *   readInternalState() {
   *     return this.#stderr;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #stderr: FdReader;
  /**
   * True after `wait()` has been called once.
   *
   * @internal
   */
  #waitStarted: boolean;

  /**
   * Spawn a child process.
   *
   * The command should be an executable path accepted by `posix_spawnp(3)`.
   * Arguments exclude `argv[0]`; the constructor prepends `command`. `opts.env`
   * replaces the inherited environment snapshot, and `opts.cwd` is applied by
   * libc spawn file actions when supported by the platform.
   *
   * Standard input, output, and error are always exposed as pipes on the
   * returned object. This constructor does not interpret Node-style `shell`,
   * `stdio`, `detached`, `ipc`, `uid`, or `gid` options.
   *
   * ```ts no_run
   * import { Process } from 'fino:process';
   *
   * const proc = new Process('/bin/echo', ['hello'], { cwd: '/tmp' });
   * const result = await proc.wait();
   * ```
   *
   * @param {string} command Absolute or executable path to run.
   * @param {string[]} [cmdArgs=[]] Arguments excluding `argv[0]`.
   * @param {{ cwd?: string, env?: object }} [opts] Optional cwd and environment.
   */
  constructor(command: string, cmdArgs: string[], opts?: ProcessOptions) {
    if (opts == null) opts = {};
    if (cmdArgs == null) cmdArgs = [];

    // Create three pipes: each pipe(buf) fills buf with [readFd, writeFd].
    const stdinBuf  = new ArrayBuffer(8);
    const stdoutBuf = new ArrayBuffer(8);
    const stderrBuf = new ArrayBuffer(8);

    if (Number(lib.symbols.pipe(stdinBuf)) < 0) throw new Error('pipe() failed for stdin');
    if (Number(lib.symbols.pipe(stdoutBuf)) < 0) {
      const [stdinR, stdinW] = readPipeFds(stdinBuf);
      lib.symbols.close(stdinR); lib.symbols.close(stdinW);
      throw new Error('pipe() failed for stdout');
    }
    if (Number(lib.symbols.pipe(stderrBuf)) < 0) {
      const [stdinR, stdinW] = readPipeFds(stdinBuf);
      const [stdoutR, stdoutW] = readPipeFds(stdoutBuf);
      lib.symbols.close(stdinR);  lib.symbols.close(stdinW);
      lib.symbols.close(stdoutR); lib.symbols.close(stdoutW);
      throw new Error('pipe() failed for stderr');
    }

    const [stdinR,  stdinW]  = readPipeFds(stdinBuf);
    const [stdoutR, stdoutW] = readPipeFds(stdoutBuf);
    const [stderrR, stderrW] = readPipeFds(stderrBuf);

    // Build posix_spawnp argv / envp while the backing buffers are still local.
    const execArgv   = [command, ...cmdArgs];
    const envVars    = opts.env ?? env;
    const envStrings = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

    const { ptrBuf: argvBuf, bufs: argvBufs } = buildCStringArray(execArgv);
    const { ptrBuf: envpBuf, bufs: envpBufs } = buildCStringArray(envStrings);
    const commandBuf = cstr(command);
    const cwdBuf     = opts.cwd != null ? cstr(opts.cwd) : null;

    const actions = new ArrayBuffer(POSIX_SPAWN_FILE_ACTIONS_BYTES);
    let actionsInitialized = false;
    let childPid = -1;

    try {
      addSpawnAction(Number(lib.symbols.posix_spawn_file_actions_init(actions)), 'posix_spawn_file_actions_init');
      actionsInitialized = true;

      addSpawnAction(Number(lib.symbols.posix_spawn_file_actions_adddup2(actions, stdinR, 0)), 'posix_spawn_file_actions_adddup2(stdin)');
      addSpawnAction(Number(lib.symbols.posix_spawn_file_actions_adddup2(actions, stdoutW, 1)), 'posix_spawn_file_actions_adddup2(stdout)');
      addSpawnAction(Number(lib.symbols.posix_spawn_file_actions_adddup2(actions, stderrW, 2)), 'posix_spawn_file_actions_adddup2(stderr)');

      addCloseIfNeeded(actions, stdinR, 0);
      addCloseIfNeeded(actions, stdoutW, 1);
      addCloseIfNeeded(actions, stderrW, 2);
      addSpawnAction(Number(lib.symbols.posix_spawn_file_actions_addclose(actions, stdinW)), 'posix_spawn_file_actions_addclose(parent stdin)');
      addSpawnAction(Number(lib.symbols.posix_spawn_file_actions_addclose(actions, stdoutR)), 'posix_spawn_file_actions_addclose(parent stdout)');
      addSpawnAction(Number(lib.symbols.posix_spawn_file_actions_addclose(actions, stderrR)), 'posix_spawn_file_actions_addclose(parent stderr)');

      if (cwdBuf !== null) {
        if (spawnChdirLib === null) {
          throw new Error('cwd option requires posix_spawn_file_actions_addchdir_np, which is unavailable on this platform');
        }
        addSpawnAction(
          Number(spawnChdirLib.symbols.posix_spawn_file_actions_addchdir_np(actions, cwdBuf)),
          'posix_spawn_file_actions_addchdir_np',
        );
      }

      const pidBuf = new ArrayBuffer(4);
      const spawnRc = Number(lib.symbols.posix_spawnp(pidBuf, commandBuf, actions, Pointer.null(), argvBuf, envpBuf));
      if (spawnRc !== 0) throw new Error(`posix_spawnp('${command}') failed: errno ${spawnRc}`);
      childPid = new DataView(pidBuf).getInt32(0, true);
    } catch (err) {
      lib.symbols.close(stdinR);  lib.symbols.close(stdinW);
      lib.symbols.close(stdoutR); lib.symbols.close(stdoutW);
      lib.symbols.close(stderrR); lib.symbols.close(stderrW);
      throw err;
    } finally {
      if (actionsInitialized) {
        lib.symbols.posix_spawn_file_actions_destroy(actions);
      }
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
    this.#waitStarted = false;
    // Keep CString buffers definitely live until after posix_spawnp returns.
    void argvBufs;
    void envpBufs;
  }

  /**
   * Writer connected to the child's stdin.
   *
   * Close this writer when no more input will be sent so programs waiting for
   * EOF can exit. The writer is backed by a non-blocking pipe fd.
   *
   * ```ts no_run
   * import { Process } from 'fino:process';
   *
   * const proc = new Process('/usr/bin/cat', []);
   * await proc.stdin.write(new TextEncoder().encode('hello\n'));
   * proc.stdin.close();
   * ```
   */
  get stdin()  { return this.#stdin; }

  /**
   * Reader connected to the child's stdout.
   *
   * The reader yields `Uint8Array` chunks until the child closes stdout. It is
   * backed by a non-blocking pipe fd.
   *
   * ```ts no_run
   * import { Process } from 'fino:process';
   *
   * const proc = new Process('/bin/echo', ['hello']);
   * for await (const chunk of proc.stdout) console.log(chunk.byteLength);
   * ```
   */
  get stdout() { return this.#stdout; }

  /**
   * Reader connected to the child's stderr.
   *
   * The reader yields `Uint8Array` chunks until the child closes stderr. Drain
   * it when running commands that may write enough stderr to fill the pipe.
   *
   * ```ts no_run
   * import { Process } from 'fino:process';
   *
   * const proc = new Process('/bin/sh', ['-c', 'echo error >&2']);
   * for await (const chunk of proc.stderr) console.log(chunk.byteLength);
   * ```
   */
  get stderr() { return this.#stderr; }

  /**
   * Child process ID returned by `posix_spawnp()`.
   *
   * The PID is available immediately after construction and remains the same
   * after the child exits.
   *
   * ```ts no_run
   * import { Process } from 'fino:process';
   *
   * const proc = new Process('/bin/sleep', ['1']);
   * console.log(proc.pid);
   * ```
   */
  get pid() { return this.#pid; }

  /**
   * Wait for the child process to exit using kernel notifications.
   *
   * - macOS: registers EVFILT_PROC via kqueue - zero-latency, zero-CPU wait.
   * - Linux: opens a pidfd via pidfd_open(2) and polls it with loop.readable()
   *          - the pidfd becomes readable the moment the child exits.
   *
   * After the kernel signals exit, a single waitpid(pid, 0) reaps the zombie.
   *
   * Calling `wait()` more than once is not supported because the first call
   * reaps the process. The promise rejects if the platform wait primitive
   * cannot be created.
   *
   * ```ts no_run
   * import { Process } from 'fino:process';
   *
   * const proc = new Process('/bin/true', []);
   * const result = await proc.wait();
   * console.log(result.code);
   * ```
   *
   * @returns {Promise<{ code: number|null, signal: number|null }>}
   */
  async wait(): Promise<WaitResult> {
    if (this.#waitStarted) throw new Error(`Process ${this.#pid} has already been waited`);
    this.#waitStarted = true;

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
   *
   * Defaults to `SIGTERM`. This method does not wait for the child to exit and
   * throws when the underlying `kill(2)` call fails, for example after the
   * child has already been reaped.
   *
   * ```ts no_run
   * import { Process, SIGTERM } from 'fino:process';
   *
   * const proc = new Process('/bin/sleep', ['10']);
   * proc.kill(SIGTERM);
   * ```
   *
   * @param {number} [signal=15] SIGTERM by default
   * @throws {Error} If `kill(2)` fails.
   */
  kill(signal: number = _SIGTERM): void {
    const ret = Number(lib.symbols.kill(this.#pid, signal));
    if (ret !== 0) throw new Error(`kill(${this.#pid}, ${signal}) failed`);
  }
}
