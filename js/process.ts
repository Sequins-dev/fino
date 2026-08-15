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
import { spawnStrictSandboxed } from './internal/security/sandbox/spawn.ts';
import { killAndRemoveCgroup, cgroupCpuAvailable } from './internal/security/sandbox/cgroup.ts';
import { landlockAvailable } from './internal/security/sandbox/landlock.ts';
import { seccompAvailable } from './internal/security/sandbox/seccomp.ts';
import { seatbeltAvailable } from './internal/security/sandbox/seatbelt.ts';
import type { SandboxPolicy } from './internal/security/sandbox/plan.ts';
import { encodeUtf8, decodeUtf8 } from 'internal:encoding';
import { FdReader, FdWriter } from './internal/stream.ts';
import * as loop from './internal/runtime/loop.ts';
import { topic, Topic } from './context/topic.ts';
import { lazy } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
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
  cwd?: string;
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
  env?: Record<string, string>;
  /**
   * Optional sandbox request for this child process.
   *
   * The sandbox API is capability-reported. `strict` mode requests an
   * OS-enforced security boundary installed before the child runs and fails
   * closed when the platform cannot enforce every requested category.
   * `bestEffort` mode may spawn the child without enforcing requested policy
   * categories, but the returned `Process.sandboxReport` records exactly what
   * happened.
   *
   * ```ts no_run
   * import { Process, type ProcessOptions } from 'fino:process';
   *
   * const opts: ProcessOptions = {
   *   sandbox: {
   *     mode: 'bestEffort',
   *     resources: { memoryBytes: 64 * 1024 * 1024 }
   *   }
   * };
   * const proc = new Process('/bin/echo', ['hello'], opts);
   * console.log(proc.sandboxReport.enforced.length);
   * ```
   */
  sandbox?: ProcessSandboxOptions;
}
/**
 * Sandbox options for a child process.
 *
 * This type describes the requested policy. It is not the same thing as the
 * enforced policy. Always inspect `Process.sandboxReport` after construction to
 * see which categories were actually enforced by the selected backend.
 */
export interface ProcessSandboxOptions {
  /**
   * Requested sandbox mode.
   *
   * `strict` is a security-boundary request and fails closed unless a strict
   * backend can enforce the policy before child code runs. `bestEffort` is not a
   * security boundary; it only reports the platform/backend subsets that were
   * enforced.
   */
  mode: 'strict' | 'bestEffort';
  /**
   * Resource limits requested for the child and descendants.
   */
  resources?: ProcessSandboxResources;
  /**
   * Filesystem access policy requested for the child.
   */
  filesystem?: ProcessSandboxFilesystem;
  /**
   * Network access policy requested for the child.
   */
  network?: ProcessSandboxNetwork;
  /**
   * Process creation and execution policy requested for the child.
   */
  process?: ProcessSandboxProcessPolicy;
  /**
   * Syscall policy requested for the child.
   */
  syscalls?: ProcessSandboxSyscalls;
}
/**
 * Resource limits requested for a sandboxed process.
 */
export interface ProcessSandboxResources {
  /**
   * Maximum resident or cgroup memory in bytes when the backend supports an
   * enforcing memory limit.
   */
  memoryBytes?: number;
  /**
   * Maximum process count when the backend supports PID-count limits.
   */
  pids?: number;
  /**
   * CPU quota as a fraction where `1` means one full CPU.
   */
  cpu?: number;
}
/**
 * Filesystem policy requested for a sandboxed process.
 */
export interface ProcessSandboxFilesystem {
  /**
   * Writable absolute paths requested inside the sandbox view.
   */
  writable?: string[];
  /**
   * Readonly absolute paths requested inside the sandbox view.
   */
  readonly?: string[];
}
/**
 * Network policy requested for a sandboxed process.
 */
export interface ProcessSandboxNetwork {
  /**
   * Outbound connect rules.
   */
  outbound?: ProcessSandboxNetworkRule[];
  /**
   * Inbound bind/listen rules.
   */
  inbound?: ProcessSandboxNetworkRule[];
}
/**
 * A single network policy rule.
 */
export interface ProcessSandboxNetworkRule {
  /**
   * Whether matching traffic should be allowed or denied.
   */
  action: 'allow' | 'deny';
  /**
   * Destination host, IP, CIDR, or `*`, depending on backend support.
   */
  destination?: string;
  /**
   * TCP or UDP port.
   */
  port?: number;
  /**
   * Network protocol covered by the rule.
   */
  protocol?: 'tcp' | 'udp';
}
/**
 * Process creation policy requested for a sandboxed process.
 */
export interface ProcessSandboxProcessPolicy {
  /**
   * Whether the child may fork or clone additional processes.
   */
  allowFork?: boolean;
  /**
   * Whether the child may exec a different binary after startup.
   */
  allowExec?: boolean;
  /**
   * Executable basenames or paths allowed by an enforcing backend.
   */
  allowedBinaries?: string[];
}
/**
 * Syscall policy requested for a sandboxed process.
 */
export interface ProcessSandboxSyscalls {
  /**
   * Syscall policy mode.
   */
  mode: 'allowlist' | 'denylist';
  /**
   * Syscall names in the selected policy mode.
   */
  names: string[];
}
/**
 * Effective sandbox report attached to each `Process`.
 *
 * A report is intentionally separate from the requested `sandbox` options so
 * callers can distinguish intent from enforcement. Best-effort mode is never a
 * security boundary.
 */
export interface ProcessSandboxReport {
  /**
   * Requested mode, or `none` when no sandbox was requested.
   */
  mode: 'none' | 'strict' | 'bestEffort';
  /**
   * Backend selected for the spawn.
   */
  backend: 'none' | 'linuxNative' | 'macosSeatbelt';
  /**
   * Whether the process is protected by a security boundary.
   */
  securityBoundary: boolean;
  /**
   * Policy categories supported by the selected backend.
   */
  supported: ProcessSandboxCapability[];
  /**
   * Policy categories that were enforced.
   */
  enforced: ProcessSandboxCapability[];
  /**
   * Requested categories that were not enforced.
   */
  unsupported: ProcessSandboxCapability[];
  /**
   * Backend and platform diagnostics that explain capability decisions.
   */
  diagnostics: string[];
  /**
   * Claimed behavior for denied operations.
   */
  violationBehavior: ProcessSandboxViolationBehavior[];
}
/**
 * Per-category sandbox capability status.
 */
export interface ProcessSandboxCapability {
  /**
   * Policy category covered by this report entry.
   */
  category: 'resources' | 'filesystem' | 'network' | 'process' | 'syscalls';
  /**
   * Human-readable explanation suitable for diagnostics.
   */
  reason: string;
}
/**
 * Denial behavior reported for an enforced sandbox category.
 */
export interface ProcessSandboxViolationBehavior {
  /**
   * Policy category covered by this behavior.
   */
  category: ProcessSandboxCapability['category'];
  /**
   * Observable behavior when the backend denies an operation.
   */
  behavior: 'kill' | 'eperm' | 'denySpawn' | 'auditOnly';
  /**
   * Human-readable explanation suitable for diagnostics.
   */
  reason: string;
}
/**
 * Sandbox capability summary for the current runtime process.
 */
export interface ProcessSandboxCapabilities {
  /**
   * Platform identifier used by the current runtime.
   */
  platform: string;
  /**
   * Whether `ProcessOptions.sandbox.mode = 'strict'` can currently enforce a
   * security boundary.
   */
  strictAvailable: boolean;
  /**
   * Whether reporting-only best-effort sandbox metadata can be attached to a
   * spawned process.
   */
  bestEffortAvailable: boolean;
  /**
   * Backends known to this runtime and their current availability.
   */
  backends: ProcessSandboxBackendCapability[];
  /**
   * Native platform features probed by the host runtime before JS startup.
   */
  features: ProcessSandboxNativeFeature[];
}
/**
 * Native sandbox-related host capability.
 */
export interface ProcessSandboxNativeFeature {
  /**
   * Stable feature name.
   */
  name: string;
  /**
   * Whether the feature appeared available at startup.
   */
  available: boolean;
  /**
   * Human-readable explanation for the feature state.
   */
  reason: string;
}
/**
 * Availability details for a sandbox backend.
 */
export interface ProcessSandboxBackendCapability {
  /**
   * Backend name used by `ProcessSandboxReport.backend`.
   */
  name: ProcessSandboxReport['backend'];
  /**
   * Whether the backend can currently be selected.
   */
  available: boolean;
  /**
   * Human-readable reason for the current availability state.
   */
  reason: string;
  /**
   * Policy categories this backend can enforce when available.
   */
  supported: ProcessSandboxCapability['category'][];
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
  code: number | null;
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
/**
 * Best-effort runtime statistics for the current process.
 */
export interface ProcessStats {
  pid: number;
  rssBytes: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
  externalBytes?: number;
  eventLoopLagMs: number;
  timestamp: number;
}
// ---------------------------------------------------------------------------
// Platform constants
// ---------------------------------------------------------------------------
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const isLinux = os === 'linux';
// fcntl(2) constants
const F_GETFL = isLinux ? 3 : 3;
const F_SETFL = 4;
const O_NONBLOCK = isLinux ? 2048 : 4;
// Linux syscall number for pidfd_open(2) - same on x86_64 and arm64.
const SYS_PIDFD_OPEN = 434n;
// Default signal for kill (also exported in signal constants below)
const _SIGTERM = 15;
// ---------------------------------------------------------------------------
// libc FFI
// ---------------------------------------------------------------------------
const lib = dlopen(LIBC, {
  getpid: {
    parameters: [],
    result: 'i32',
  },
  getppid: {
    parameters: [],
    result: 'i32',
  },
  _exit: {
    parameters: ['i32'],
    result: 'void',
  },
  getcwd: {
    parameters: ['buffer', 'usize'],
    result: 'pointer',
  },
  chdir: {
    parameters: ['buffer'],
    result: 'i32',
  },
  kill: {
    parameters: ['i32', 'i32'],
    result: 'i32',
  },
  pipe: {
    parameters: ['buffer'],
    result: 'i32',
  },
  close: {
    parameters: ['i32'],
    result: 'i32',
  },
  fcntl: {
    parameters: ['i32', 'i32', 'i32'],
    result: 'i32',
  },
  waitpid: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  syscall: {
    parameters: ['i64', 'i64', 'i64'],
    result: 'i64',
  },
  posix_spawnp: {
    parameters: ['buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'],
    result: 'i32',
  },
  posix_spawn_file_actions_init: {
    parameters: ['buffer'],
    result: 'i32',
  },
  posix_spawn_file_actions_destroy: {
    parameters: ['buffer'],
    result: 'i32',
  },
  posix_spawnattr_init: {
    parameters: ['buffer'],
    result: 'i32',
  },
  posix_spawnattr_destroy: {
    parameters: ['buffer'],
    result: 'i32',
  },
  posix_spawnattr_setsigdefault: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  posix_spawnattr_setsigmask: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  posix_spawnattr_setflags: {
    parameters: ['buffer', 'u16'],
    result: 'i32',
  },
  posix_spawn_file_actions_adddup2: {
    parameters: ['buffer', 'i32', 'i32'],
    result: 'i32',
  },
  posix_spawn_file_actions_addclose: {
    parameters: ['buffer', 'i32'],
    result: 'i32',
  },
  getrusage: {
    parameters: ['i32', 'buffer'],
    result: 'i32',
  },
});
const spawnChdirLib = (() => {
  try {
    return dlopen(LIBC, {
      posix_spawn_file_actions_addchdir_np: {
        parameters: ['buffer', 'buffer'],
        result: 'i32',
      },
    });
  } catch (_) {
    return null;
  }
})();
const RUSAGE_SELF = 0;
let lastEventLoopLagMs = 0;
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
function buildCStringArray(strings: string[]): {
  ptrBuf: ArrayBuffer;
  bufs: Uint8Array[];
} {
  const bufs = strings.map(cstr);
  const ptrBuf = new ArrayBuffer((bufs.length + 1) * 8);
  const view = new DataView(ptrBuf);
  for (let i = 0; i < bufs.length; i++) {
    view.setBigUint64(i * 8, Pointer.addr(bufs[i]), true);
  }
  // Last 8 bytes remain zero - null pointer terminator.
  return {
    ptrBuf,
    bufs,
  };
}
/** Read the two int32 fds from a pipe() output buffer. */
function readPipeFds(
  buf:
    | ArrayBuffer
    | {
        buffer: ArrayBuffer;
      },
): [number, number] {
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
// Opaque storage for posix_spawnattr_t. Darwin stores a pointer here while
// glibc stores an inline struct, so keep this generously sized.
const POSIX_SPAWN_ATTR_BYTES = 512;
const SIGSET_BYTES = 128;
const POSIX_SPAWN_SETSIGDEF = 0x0004;
const POSIX_SPAWN_SETSIGMASK = 0x0008;
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
function addSignalToSet(set: ArrayBuffer, signo: number): void {
  if (signo <= 0) return;
  const bit = signo - 1;
  const byteOffset = bit >> 3;
  if (byteOffset >= set.byteLength) return;
  const bytes = new Uint8Array(set);
  bytes[byteOffset] |= 1 << (bit & 7);
}
function currentRssBytes(): number {
  const buf = new ArrayBuffer(256);
  const rc = Number(lib.symbols.getrusage(RUSAGE_SELF, buf));
  if (rc !== 0) return 1;
  const maxrss = Number(new DataView(buf).getBigInt64(16, true));
  if (!Number.isFinite(maxrss) || maxrss <= 0) return 1;
  return isLinux ? maxrss * 1024 : maxrss;
}
// ---------------------------------------------------------------------------
// Process-level APIs
// ---------------------------------------------------------------------------
/**
 * Return best-effort current process statistics.
 *
 * RSS is read from `getrusage(RUSAGE_SELF)`. Heap fields are present only when
 * the runtime has a heap-stat source for the active platform.
 */
export function processStats(): ProcessStats {
  return {
    pid,
    rssBytes: currentRssBytes(),
    eventLoopLagMs: lastEventLoopLagMs,
    timestamp: Date.now(),
  };
}
/**
 * Cold signal of process statistics sampled on an interval.
 */
export function processStatsSignal(intervalMs = 1000): ReadonlySignal<ProcessStats> {
  return lazy(processStats(), (set) => {
    let expected = Date.now() + intervalMs;
    const sample = () => {
      const now = Date.now();
      lastEventLoopLagMs = Math.max(0, now - expected);
      expected = now + intervalMs;
      set(processStats());
    };
    const timer = setInterval(sample, intervalMs);
    sample();
    return () => clearInterval(timer);
  });
}
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
  try {
    _stdout?.flushSync();
  } catch (_) {}
  try {
    _stderr?.flushSync();
  } catch (_) {}
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
let _stdin: FdReader | null = null;
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
export const SIGHUP = 1;
/**
 * Interrupt signal number.
 *
 * ```ts no_run
 * import { SIGINT, signal } from 'fino:process';
 *
 * signal('SIGINT').subscribe(({ signo }) => console.log(signo === SIGINT));
 * ```
 */
export const SIGINT = 2;
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
/**
 * Signal number for `SIGWINCH` (terminal window size changed).
 *
 * ```ts no_run
 * import { SIGWINCH, signal } from 'fino:process';
 *
 * signal('SIGWINCH').subscribe(() => console.log('resized'));
 * ```
 */
export const SIGWINCH = 28;
const _signalNumbers: Record<string, number> = {
  SIGHUP,
  SIGINT,
  SIGQUIT,
  SIGKILL,
  SIGUSR1,
  SIGUSR2,
  SIGPIPE,
  SIGALRM,
  SIGTERM,
  SIGCHLD,
  SIGWINCH,
};
const _childDefaultSignals = Object.values(_signalNumbers).filter((signo) => signo !== SIGKILL);
/** Set of signal names already registered with the event loop. */
const _registeredSignals = new Set<string>();
/** Arming promise per registered signal name, awaited by `signalArmed()`. */
const _signalArmed = new Map<string, Promise<void>>();
const _emptySandboxReport: ProcessSandboxReport = {
  mode: 'none',
  backend: 'none',
  securityBoundary: false,
  supported: [],
  enforced: [],
  unsupported: [],
  diagnostics: [],
  violationBehavior: [],
};
// Sandbox mechanism availability is probed directly through the enforcement
// modules — no native daemon probe. Each feature reflects a real syscall/tool
// check on the current host.
function probeSandboxFeatures(): ProcessSandboxNativeFeature[] {
  if (isLinux) {
    return [
      {
        name: 'landlock',
        available: landlockAvailable(),
        reason: landlockAvailable()
          ? 'Landlock LSM is enabled'
          : 'Landlock LSM is not enabled on this kernel',
      },
      {
        name: 'seccomp',
        available: seccompAvailable(),
        reason: seccompAvailable()
          ? 'seccomp filtering is available'
          : 'seccomp is not available on this kernel',
      },
      {
        name: 'cgroup-cpu',
        available: cgroupCpuAvailable(),
        reason: cgroupCpuAvailable()
          ? 'a delegated cgroup v2 cpu controller is available'
          : 'no delegated cgroup v2 cpu controller',
      },
    ];
  }
  const seatbelt = seatbeltAvailable();
  return [
    {
      name: 'macos-seatbelt',
      available: seatbelt,
      reason: seatbelt ? 'sandbox-exec can apply Seatbelt profiles' : 'sandbox-exec is unavailable',
    },
  ];
}
// Probing touches syscalls and TextEncoder, which are not available at module
// evaluation, so features and capabilities are computed lazily on first use and
// cached.
let _sandboxFeaturesCache: ProcessSandboxNativeFeature[] | undefined;
function sandboxFeatures(): ProcessSandboxNativeFeature[] {
  if (_sandboxFeaturesCache === undefined) _sandboxFeaturesCache = probeSandboxFeatures();
  return _sandboxFeaturesCache;
}
function nativeSandboxFeatureAvailable(name: string): boolean {
  return sandboxFeatures().some((feature) => feature.name === name && feature.available);
}
function linuxStrictSupportedCategories(): ProcessSandboxCapability['category'][] {
  return [
    'resources',
    ...(isLinux && landlockAvailable() ? ['filesystem' as const] : []),
    'network',
    'process',
    'syscalls',
  ];
}
function macosStrictSupportedCategories(): ProcessSandboxCapability['category'][] {
  return nativeSandboxFeatureAvailable('macos-seatbelt')
    ? ['resources', 'filesystem', 'network', 'process']
    : [];
}
function buildSandboxCapabilities(): ProcessSandboxCapabilities {
  const macos = macosStrictSupportedCategories();
  return {
    platform: os,
    strictAvailable: isLinux || macos.length > 0,
    bestEffortAvailable: true,
    backends: [
      {
        name: 'none',
        available: true,
        reason: 'reporting-only backend; no sandbox policy is enforced',
        supported: [],
      },
      {
        name: 'linuxNative',
        available: isLinux,
        reason: isLinux
          ? 'in-process Linux strict sandbox spawn path is available for probed Linux enforcement features'
          : 'linuxNative requires Linux',
        supported: linuxStrictSupportedCategories(),
      },
      {
        name: 'macosSeatbelt',
        available: macos.length > 0,
        reason:
          os === 'darwin'
            ? nativeSandboxFeatureAvailable('macos-seatbelt')
              ? 'sandbox-exec can apply Seatbelt profiles'
              : 'macOS Seatbelt probe failed; strict sandbox fails closed'
            : 'macosSeatbelt requires macOS',
        supported: macos,
      },
    ],
    features: sandboxFeatures(),
  };
}
/**
 * Report sandbox backend capabilities for the current runtime.
 *
 * This function does not spawn a process and does not imply enforcement. It is
 * intended for feature detection and diagnostics before choosing
 * `ProcessOptions.sandbox`. `strictAvailable` reflects whether an enforcing
 * backend can be selected on this host; `bestEffort` is always available as
 * reporting metadata only.
 *
 * ```ts no_run
 * import { processSandboxCapabilities } from 'fino:process';
 *
 * const caps = processSandboxCapabilities();
 * if (!caps.strictAvailable) console.log(caps.backends);
 * ```
 */
export function processSandboxCapabilities(): ProcessSandboxCapabilities {
  return buildSandboxCapabilities();
}
function requestedSandboxCategories(sandbox: ProcessSandboxOptions): ProcessSandboxCapability[] {
  const unsupported: ProcessSandboxCapability[] = [];
  if (sandbox.resources !== undefined) {
    unsupported.push({
      category: 'resources',
      reason: 'resource limits require a sandbox backend; this spawn used posix_spawnp',
    });
  }
  if (sandbox.filesystem !== undefined) {
    unsupported.push({
      category: 'filesystem',
      reason: 'filesystem policy requires an enforcing sandbox backend',
    });
  }
  if (sandbox.network !== undefined) {
    unsupported.push({
      category: 'network',
      reason: 'network policy requires an enforcing sandbox backend',
    });
  }
  if (sandbox.process !== undefined) {
    unsupported.push({
      category: 'process',
      reason: 'process policy requires an enforcing sandbox backend',
    });
  }
  if (sandbox.syscalls !== undefined) {
    unsupported.push({
      category: 'syscalls',
      reason: 'syscall policy requires an enforcing sandbox backend',
    });
  }
  return unsupported;
}
function assertSandboxNumber(value: unknown, path: string, integer = false): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(`${path} must be a positive ${integer ? 'integer' : 'finite number'}`);
  }
}
function assertSandboxString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (value.includes('\0') || value.includes('\n')) {
    throw new Error(`${path} must not contain null bytes or newlines`);
  }
}
function assertSandboxAbsolutePath(value: unknown, path: string): void {
  assertSandboxString(value, path);
  if (!(value as string).startsWith('/')) {
    throw new Error(`${path} must be an absolute path`);
  }
}
function assertSandboxStringArray(
  value: unknown,
  path: string,
  validate: (entry: unknown, entryPath: string) => void,
): void {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  for (let i = 0; i < value.length; i++) validate(value[i], `${path}[${i}]`);
}
function validateSandboxNetworkRules(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  for (let i = 0; i < value.length; i++) {
    const rulePath = `${path}[${i}]`;
    const rule = value[i] as ProcessSandboxNetworkRule;
    if (rule == null || typeof rule !== 'object') throw new Error(`${rulePath} must be an object`);
    if (rule.action !== 'allow' && rule.action !== 'deny')
      throw new Error(`${rulePath}.action must be 'allow' or 'deny'`);
    if (rule.destination !== undefined)
      assertSandboxString(rule.destination, `${rulePath}.destination`);
    if (rule.port !== undefined) {
      if (
        typeof rule.port !== 'number' ||
        !Number.isInteger(rule.port) ||
        rule.port < 1 ||
        rule.port > 65535
      ) {
        throw new Error(`${rulePath}.port must be an integer from 1 to 65535`);
      }
    }
    if (rule.protocol !== undefined && rule.protocol !== 'tcp' && rule.protocol !== 'udp') {
      throw new Error(`${rulePath}.protocol must be 'tcp' or 'udp'`);
    }
  }
}
function assertCoarseNetworkRules(
  rules: ProcessSandboxNetworkRule[] | undefined,
  path: string,
): void {
  if (rules === undefined) return;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const rulePath = `${path}[${i}]`;
    if (rule.destination !== undefined && rule.destination !== '*') {
      throw new Error(
        `${rulePath}.destination '${rule.destination}' requires filtered egress, which is not yet supported; strict mode only enforces coarse allow/deny of all network access`,
      );
    }
    if (rule.port !== undefined) {
      throw new Error(
        `${rulePath}.port requires filtered egress, which is not yet supported; strict mode only enforces coarse allow/deny of all network access`,
      );
    }
    if (rule.protocol !== undefined) {
      throw new Error(
        `${rulePath}.protocol requires filtered egress, which is not yet supported; strict mode only enforces coarse allow/deny of all network access`,
      );
    }
  }
}
function validateSandboxOptions(sandbox: ProcessSandboxOptions): void {
  if (sandbox.resources !== undefined) {
    const resources = sandbox.resources;
    if (resources.memoryBytes !== undefined)
      assertSandboxNumber(resources.memoryBytes, 'sandbox.resources.memoryBytes', true);
    if (resources.pids !== undefined)
      assertSandboxNumber(resources.pids, 'sandbox.resources.pids', true);
    if (resources.cpu !== undefined) assertSandboxNumber(resources.cpu, 'sandbox.resources.cpu');
  }
  if (sandbox.filesystem !== undefined) {
    const filesystem = sandbox.filesystem;
    if (filesystem.writable !== undefined)
      assertSandboxStringArray(
        filesystem.writable,
        'sandbox.filesystem.writable',
        assertSandboxAbsolutePath,
      );
    if (filesystem.readonly !== undefined)
      assertSandboxStringArray(
        filesystem.readonly,
        'sandbox.filesystem.readonly',
        assertSandboxAbsolutePath,
      );
  }
  if (sandbox.network !== undefined) {
    validateSandboxNetworkRules(sandbox.network.outbound, 'sandbox.network.outbound');
    validateSandboxNetworkRules(sandbox.network.inbound, 'sandbox.network.inbound');
  }
  if (sandbox.process !== undefined) {
    const process = sandbox.process;
    if (process.allowFork !== undefined && typeof process.allowFork !== 'boolean')
      throw new Error('sandbox.process.allowFork must be a boolean');
    if (process.allowExec !== undefined && typeof process.allowExec !== 'boolean')
      throw new Error('sandbox.process.allowExec must be a boolean');
    if (process.allowedBinaries !== undefined)
      assertSandboxStringArray(
        process.allowedBinaries,
        'sandbox.process.allowedBinaries',
        assertSandboxString,
      );
  }
  if (sandbox.syscalls !== undefined) {
    const syscalls = sandbox.syscalls;
    if (syscalls.mode !== 'allowlist' && syscalls.mode !== 'denylist')
      throw new Error("sandbox.syscalls.mode must be 'allowlist' or 'denylist'");
    assertSandboxStringArray(syscalls.names, 'sandbox.syscalls.names', assertSandboxString);
  }
}
function resolveSandboxReport(sandbox: ProcessSandboxOptions | undefined): ProcessSandboxReport {
  if (sandbox === undefined) return _emptySandboxReport;
  if (sandbox.mode !== 'strict' && sandbox.mode !== 'bestEffort') {
    throw new Error(`Unsupported sandbox mode: ${String(sandbox.mode)}`);
  }
  validateSandboxOptions(sandbox);
  if (sandbox.mode === 'strict') {
    validateStrictSandboxSupported(sandbox);
    throw new Error('strict sandbox mode must use native sandbox spawn');
  }
  return {
    mode: 'bestEffort',
    backend: 'none',
    securityBoundary: false,
    supported: [],
    enforced: [],
    unsupported: requestedSandboxCategories(sandbox),
    diagnostics: [
      'No sandbox backend is active; child spawned through posix_spawnp with reporting-only best-effort sandbox metadata',
    ],
    violationBehavior: [],
  };
}
function validateStrictSandboxSupported(sandbox: ProcessSandboxOptions): void {
  // Strict mode is fail-closed: if a requested category has no enforcement
  // mechanism on this host, reject before spawn rather than run a child that
  // believes it is sandboxed when it is not.
  assertCoarseNetworkRules(sandbox.network?.outbound, 'sandbox.network.outbound');
  assertCoarseNetworkRules(sandbox.network?.inbound, 'sandbox.network.inbound');
  const wantsExecScope =
    sandbox.process?.allowExec === false || (sandbox.process?.allowedBinaries?.length ?? 0) > 0;
  const wantsSeccomp =
    sandbox.syscalls !== undefined ||
    sandbox.process?.allowFork === false ||
    sandbox.network !== undefined;
  if (!isLinux) {
    if (os !== 'darwin' || !nativeSandboxFeatureAvailable('macos-seatbelt')) {
      throw new Error('strict sandbox mode is not available on this platform');
    }
    // macOS enforces filesystem, process-exec scoping, and coarse network via
    // Seatbelt. Syscall filtering and fork denial have no Seatbelt equivalent
    // mapped to this API, so they remain Linux-only and fail closed here.
    if (sandbox.syscalls !== undefined) {
      throw new Error('strict sandbox syscalls policy requires Linux seccomp support');
    }
    if (sandbox.process?.allowFork === false) {
      throw new Error('strict sandbox process.allowFork policy requires Linux seccomp support');
    }
    return;
  }
  // Linux: probe each mechanism the policy needs and fail loudly if absent.
  if ((sandbox.filesystem !== undefined || wantsExecScope) && !landlockAvailable()) {
    throw new Error(
      'strict sandbox filesystem/process-exec policy requires the Landlock LSM, which is not enabled on this kernel',
    );
  }
  if (wantsSeccomp && !seccompAvailable()) {
    throw new Error(
      'strict sandbox syscalls/process/network policy requires seccomp, which is not enabled on this kernel',
    );
  }
  if (sandbox.resources?.cpu !== undefined && !cgroupCpuAvailable()) {
    throw new Error(
      'strict sandbox resources.cpu requires a delegated cgroup v2 cpu controller (set FINO_SANDBOX_CGROUP_ROOT to a subtree with cpu enabled in cgroup.subtree_control); there is no rlimit equivalent for a fractional CPU quota',
    );
  }
}
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
 * import { signal } from './process.ts';
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
 *
 * The signal's default action is suppressed immediately, but the watch itself
 * is armed asynchronously by the realm that owns the process event loop. Await
 * `signalArmed()` before raising the signal yourself; delivery from outside the
 * process needs no such care.
 */
export function signal(name: string): Topic {
  const t = topic('process:' + name);
  if (!_registeredSignals.has(name)) {
    const signo = _signalNumbers[name];
    if (signo == null) throw new Error('Unknown signal: ' + name);
    _registeredSignals.add(name);
    _signalArmed.set(
      name,
      loop.signal(signo, function fireSignal() {
        t.publish({
          signal: name,
          signo,
        });
      }),
    );
  }
  return t;
}
/**
 * Resolve once `name`'s watch is armed on the process event loop.
 *
 * `signal()` registers the watch without waiting for it, so a signal raised in
 * the same turn can be missed. Await this first when the process signals
 * itself, as tests and self-restart flows do.
 *
 * ```ts no_run
 * import { signal, signalArmed, kill, pid, SIGUSR1 } from 'fino:process';
 *
 * const events = signal('SIGUSR1');
 * await signalArmed('SIGUSR1');
 * kill(pid, SIGUSR1);
 * ```
 *
 * @param name Signal name previously passed to `signal()`.
 */
export function signalArmed(name: string): Promise<void> {
  return _signalArmed.get(name) ?? Promise.resolve();
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
   * Effective sandbox report for this process.
   *
   * @internal
   */
  #sandboxReport: ProcessSandboxReport;
  /**
   * Per-spawn cgroup path to tear down once the child is reaped, if the strict
   * sandbox created one. Undefined for non-cgroup spawns.
   *
   * @internal
   */
  #cgroupPath: string | undefined;
  /**
   * How to reap descendants of a strict-sandboxed child on teardown: via the
   * spawn cgroup's `cgroup.kill`, or by killing the child's process group.
   * Undefined for non-strict spawns.
   *
   * @internal
   */
  #descendantCleanup: 'cgroup' | 'processGroup' | undefined;
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
    if (opts.sandbox?.mode === 'strict') {
      validateSandboxOptions(opts.sandbox);
      validateStrictSandboxSupported(opts.sandbox);
      const spawned = spawnStrictSandboxed(
        command,
        cmdArgs,
        { cwd: opts.cwd, env: opts.env },
        opts.sandbox as unknown as SandboxPolicy,
        env as Record<string, string>,
        (launcherArgs, inheritFds) =>
          this.#spawnWithPipes(execPath, [execPath, ...launcherArgs], {}, inheritFds),
        isLinux && landlockAvailable(),
      );
      this.#pid = spawned.pid;
      this.#stdin = new FdWriter(spawned.stdinFd, function closeStdin() {
        lib.symbols.close(spawned.stdinFd);
      });
      this.#stdout = new FdReader(spawned.stdoutFd, function closeStdout() {
        lib.symbols.close(spawned.stdoutFd);
      });
      this.#stderr = new FdReader(spawned.stderrFd, function closeStderr() {
        lib.symbols.close(spawned.stderrFd);
      });
      this.#sandboxReport = spawned.report as unknown as ProcessSandboxReport;
      this.#cgroupPath = spawned.cgroupPath;
      this.#descendantCleanup = spawned.descendantCleanup;
      this.#waitStarted = false;
      return;
    }
    const sandboxReport = resolveSandboxReport(opts.sandbox);
    const spawned = this.#spawnWithPipes(command, [command, ...cmdArgs], opts);
    this.#pid = spawned.pid;
    this.#stdin = new FdWriter(spawned.stdinFd, function closeStdin() {
      lib.symbols.close(spawned.stdinFd);
    });
    this.#stdout = new FdReader(spawned.stdoutFd, function closeStdout() {
      lib.symbols.close(spawned.stdoutFd);
    });
    this.#stderr = new FdReader(spawned.stderrFd, function closeStderr() {
      lib.symbols.close(spawned.stderrFd);
    });
    this.#sandboxReport = sandboxReport;
    this.#cgroupPath = undefined;
    this.#descendantCleanup = undefined;
    this.#waitStarted = false;
  }
  #spawnWithPipes(
    command: string,
    execArgv: string[],
    opts: ProcessOptions,
    _inheritFds?: number[],
  ): {
    pid: number;
    stdinFd: number;
    stdoutFd: number;
    stderrFd: number;
  } {
    // Create three pipes: each pipe(buf) fills buf with [readFd, writeFd].
    const stdinBuf = new ArrayBuffer(8);
    const stdoutBuf = new ArrayBuffer(8);
    const stderrBuf = new ArrayBuffer(8);
    if (Number(lib.symbols.pipe(stdinBuf)) < 0) throw new Error('pipe() failed for stdin');
    if (Number(lib.symbols.pipe(stdoutBuf)) < 0) {
      const [stdinR, stdinW] = readPipeFds(stdinBuf);
      lib.symbols.close(stdinR);
      lib.symbols.close(stdinW);
      throw new Error('pipe() failed for stdout');
    }
    if (Number(lib.symbols.pipe(stderrBuf)) < 0) {
      const [stdinR, stdinW] = readPipeFds(stdinBuf);
      const [stdoutR, stdoutW] = readPipeFds(stdoutBuf);
      lib.symbols.close(stdinR);
      lib.symbols.close(stdinW);
      lib.symbols.close(stdoutR);
      lib.symbols.close(stdoutW);
      throw new Error('pipe() failed for stderr');
    }
    const [stdinR, stdinW] = readPipeFds(stdinBuf);
    const [stdoutR, stdoutW] = readPipeFds(stdoutBuf);
    const [stderrR, stderrW] = readPipeFds(stderrBuf);
    // Build posix_spawnp argv / envp while the backing buffers are still local.
    const envVars = opts.env ?? env;
    const envStrings = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
    const { ptrBuf: argvBuf, bufs: argvBufs } = buildCStringArray(execArgv);
    const { ptrBuf: envpBuf, bufs: envpBufs } = buildCStringArray(envStrings);
    const commandBuf = cstr(command);
    const cwdBuf = opts.cwd != null ? cstr(opts.cwd) : null;
    const actions = new ArrayBuffer(POSIX_SPAWN_FILE_ACTIONS_BYTES);
    const attrs = new ArrayBuffer(POSIX_SPAWN_ATTR_BYTES);
    const childDefaultSignals = new ArrayBuffer(SIGSET_BYTES);
    const childSignalMask = new ArrayBuffer(SIGSET_BYTES);
    for (const signo of _childDefaultSignals) addSignalToSet(childDefaultSignals, signo);
    let actionsInitialized = false;
    let attrsInitialized = false;
    let childPid = -1;
    try {
      addSpawnAction(
        Number(lib.symbols.posix_spawn_file_actions_init(actions)),
        'posix_spawn_file_actions_init',
      );
      actionsInitialized = true;
      addSpawnAction(Number(lib.symbols.posix_spawnattr_init(attrs)), 'posix_spawnattr_init');
      attrsInitialized = true;
      addSpawnAction(
        Number(lib.symbols.posix_spawnattr_setsigdefault(attrs, childDefaultSignals)),
        'posix_spawnattr_setsigdefault',
      );
      addSpawnAction(
        Number(lib.symbols.posix_spawnattr_setsigmask(attrs, childSignalMask)),
        'posix_spawnattr_setsigmask',
      );
      addSpawnAction(
        Number(
          lib.symbols.posix_spawnattr_setflags(
            attrs,
            POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK,
          ),
        ),
        'posix_spawnattr_setflags',
      );
      addSpawnAction(
        Number(lib.symbols.posix_spawn_file_actions_adddup2(actions, stdinR, 0)),
        'posix_spawn_file_actions_adddup2(stdin)',
      );
      addSpawnAction(
        Number(lib.symbols.posix_spawn_file_actions_adddup2(actions, stdoutW, 1)),
        'posix_spawn_file_actions_adddup2(stdout)',
      );
      addSpawnAction(
        Number(lib.symbols.posix_spawn_file_actions_adddup2(actions, stderrW, 2)),
        'posix_spawn_file_actions_adddup2(stderr)',
      );
      addCloseIfNeeded(actions, stdinR, 0);
      addCloseIfNeeded(actions, stdoutW, 1);
      addCloseIfNeeded(actions, stderrW, 2);
      addSpawnAction(
        Number(lib.symbols.posix_spawn_file_actions_addclose(actions, stdinW)),
        'posix_spawn_file_actions_addclose(parent stdin)',
      );
      addSpawnAction(
        Number(lib.symbols.posix_spawn_file_actions_addclose(actions, stdoutR)),
        'posix_spawn_file_actions_addclose(parent stdout)',
      );
      addSpawnAction(
        Number(lib.symbols.posix_spawn_file_actions_addclose(actions, stderrR)),
        'posix_spawn_file_actions_addclose(parent stderr)',
      );
      if (cwdBuf !== null) {
        if (spawnChdirLib === null) {
          throw new Error(
            'cwd option requires posix_spawn_file_actions_addchdir_np, which is unavailable on this platform',
          );
        }
        addSpawnAction(
          Number(spawnChdirLib.symbols.posix_spawn_file_actions_addchdir_np(actions, cwdBuf)),
          'posix_spawn_file_actions_addchdir_np',
        );
      }
      const pidBuf = new ArrayBuffer(4);
      const spawnRc = Number(
        lib.symbols.posix_spawnp(pidBuf, commandBuf, actions, attrs, argvBuf, envpBuf),
      );
      if (spawnRc !== 0) throw new Error(`posix_spawnp('${command}') failed: errno ${spawnRc}`);
      childPid = new DataView(pidBuf).getInt32(0, true);
    } catch (err) {
      lib.symbols.close(stdinR);
      lib.symbols.close(stdinW);
      lib.symbols.close(stdoutR);
      lib.symbols.close(stdoutW);
      lib.symbols.close(stderrR);
      lib.symbols.close(stderrW);
      throw err;
    } finally {
      if (actionsInitialized) {
        lib.symbols.posix_spawn_file_actions_destroy(actions);
      }
      if (attrsInitialized) {
        lib.symbols.posix_spawnattr_destroy(attrs);
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
    // Keep CString buffers definitely live until after posix_spawnp returns.
    void argvBufs;
    void envpBufs;
    void _inheritFds;
    return { pid: childPid, stdinFd: stdinW, stdoutFd: stdoutR, stderrFd: stderrR };
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
  get stdin() {
    return this.#stdin;
  }
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
  get stdout() {
    return this.#stdout;
  }
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
  get stderr() {
    return this.#stderr;
  }
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
  get pid() {
    return this.#pid;
  }
  /**
   * Effective sandbox report for this child process.
   *
   * The report describes what was actually enforced, not just what was
   * requested in `ProcessOptions.sandbox`. When no sandbox was requested the
   * report uses `mode: 'none'`. `bestEffort` reports are diagnostic only and do
   * not indicate a security boundary.
   *
   * ```ts no_run
   * import { Process } from 'fino:process';
   *
   * const proc = new Process('/bin/echo', ['hello'], {
   *   sandbox: { mode: 'bestEffort' }
   * });
   * console.log(proc.sandboxReport.securityBoundary);
   * ```
   */
  get sandboxReport(): ProcessSandboxReport {
    return this.#sandboxReport;
  }
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
    const statusBuf = new ArrayBuffer(4);
    const statusView = new DataView(statusBuf);
    lib.symbols.waitpid(this.#pid, statusBuf, 0);
    // Reap descendants the direct child left behind. A per-spawn cgroup takes
    // down its whole tree via cgroup.kill; otherwise the child was made a
    // process-group leader and kill(-pgid) reaps any orphans in that group.
    if (this.#descendantCleanup === 'cgroup' && this.#cgroupPath !== undefined) {
      killAndRemoveCgroup(this.#cgroupPath);
    } else if (this.#descendantCleanup === 'processGroup') {
      // Negative pid targets the process group; ESRCH (no members) is expected
      // for a child that spawned nothing and is harmless.
      lib.symbols.kill(-this.#pid, SIGKILL);
    }
    this.#cgroupPath = undefined;
    this.#descendantCleanup = undefined;
    const s = statusView.getInt32(0, true);
    // WIFEXITED: low 7 bits are zero
    if ((s & 127) === 0)
      return {
        code: (s >> 8) & 255,
        signal: null,
      };
    // WIFSIGNALED: low 7 bits are non-zero and not 0x7f (stopped)
    if ((s & 127) !== 127)
      return {
        code: null,
        signal: s & 127,
      };
    return {
      code: null,
      signal: null,
    };
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
