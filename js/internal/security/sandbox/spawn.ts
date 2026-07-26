/**
 * internal:security/sandbox/spawn — parent side of the self-sandboxing launcher.
 *
 * When a `Process` is created with a strict sandbox policy, fino does not apply
 * the sandbox itself. Instead it re-executes its own binary as a launcher
 * (`fino --sandbox-launcher <fd>`), hands that child the requested policy over a
 * private socket, and lets the child install every mechanism against itself
 * before it finally `execve`s the target command. This module is the parent half
 * of that handshake: it creates the policy socketpair, asks the caller to spawn
 * the launcher (through the ordinary pipe/posix_spawn path so stdio, `pid`,
 * `kill()`, and `wait()` keep working on the returned handle), exchanges frames,
 * and turns the launcher's installed-mechanism records into a report.
 *
 * The launcher is spawned indirectly through a caller-supplied {@link
 * SpawnLauncher} callback rather than directly, so the same pipe/stdio plumbing
 * that backs an ordinary `Process` also backs a sandboxed one. The parent keeps
 * the launcher's socket end marked close-on-exec and its own end open for the
 * duration of the handshake, closing both once the report is read.
 *
 * Error propagation uses the classic CLOEXEC-signaling pattern: after writing
 * its report the launcher marks the socket close-on-exec and `execve`s. A clean
 * EOF on the next read means exec succeeded; an error frame on the still-open
 * socket means a mechanism failed to install or the exec itself failed, and the
 * parent throws a spawn-time error after tearing down the half-started child.
 * Because the report is derived from what the launcher actually installed (not
 * from which option keys were requested), `report.securityBoundary` is a
 * trustworthy statement of whether the policy is fully enforced on this host.
 *
 * ```ts no_run
 * import { spawnStrictSandboxed } from 'internal:security/sandbox/spawn';
 *
 * // `spawnFino` runs `fino <args>` through the parent's normal spawn path,
 * // keeping `inheritFds` open in the child; it returns the pid and stdio fds.
 * const result = spawnStrictSandboxed(
 *   '/usr/bin/python3',
 *   ['-c', 'print("hello from the sandbox")'],
 *   { cwd: '/tmp' },
 *   { mode: 'strict', filesystem: { readonly: ['/usr'] }, network: {} },
 *   defaultEnv,
 *   (launcherArgs, inheritFds) => spawnFino(launcherArgs, inheritFds),
 *   false
 * );
 *
 * if (!result.report.securityBoundary) {
 *   console.warn('sandbox degraded:', result.report.unsupported);
 * }
 * // result.pid / result.stdinFd / ... drive the running child as usual.
 * ```
 *
 * @internal
 */
import { os } from 'internal:process';
import { libc, errno, setCloexec, AF_UNIX, SOCK_STREAM } from './ffi.ts';
import { readFrame, writeFrame } from './frame.ts';
import { checkInitialCommand } from './plan.ts';
import { buildReport } from './report.ts';
import type { SandboxPolicy, SandboxCategory } from './plan.ts';
import type { InstalledMechanism, SandboxReport } from './report.ts';
const isLinux = os === 'linux';
/**
 * The pid and stdio file descriptors of a launcher process the caller spawned on
 * the parent's behalf.
 *
 * This is the raw result a {@link SpawnLauncher} callback returns. The three fds
 * are the parent-side ends of the pipes wired to the launcher's standard
 * streams; after the sandbox handshake completes they become the child's own
 * stdio, so the caller keeps them to drive the running command. The struct
 * carries no ownership semantics of its own — whoever receives it is responsible
 * for eventually closing the fds and reaping `pid`.
 *
 * ```ts no_run
 * const launched: LaunchedProcess = spawnFino(['--sandbox-launcher', '7'], [7]);
 * console.log('launcher pid', launched.pid);
 * ```
 */
export interface LaunchedProcess {
  /** Process id of the spawned launcher, later the pid of the exec'd command. */
  pid: number;
  /** Parent-side write end of the child's standard input pipe. */
  stdinFd: number;
  /** Parent-side read end of the child's standard output pipe. */
  stdoutFd: number;
  /** Parent-side read end of the child's standard error pipe. */
  stderrFd: number;
}
/**
 * Callback that spawns `fino <launcherArgs>` through the parent's normal
 * pipe/posix_spawn path, keeping every fd in `inheritFds` open in the child.
 *
 * {@link spawnStrictSandboxed} does not create the launcher process directly; it
 * delegates to this callback so that the exact same stdio plumbing that backs an
 * ordinary `Process` also backs a sandboxed one. The callback must invoke the
 * fino binary with the given arguments (which always begin with
 * `--sandbox-launcher <fd>`), leave `inheritFds` (the launcher's socket end)
 * unclosed across the `exec`, and return the resulting pid and stdio fds. The
 * caller closes the inherited fd on its own side once the child is running.
 *
 * ```ts no_run
 * const spawn: SpawnLauncher = (launcherArgs, inheritFds) =>
 *   spawnWithPipes(execPath, [execPath, ...launcherArgs], {}, inheritFds);
 * ```
 */
export type SpawnLauncher = (launcherArgs: string[], inheritFds: number[]) => LaunchedProcess;
/**
 * A running strictly-sandboxed process plus the report and teardown metadata the
 * parent needs to manage it.
 *
 * Extends {@link LaunchedProcess} with the derived sandbox `report` and the
 * information required to clean the process up correctly: on Linux the launcher
 * may place the child in a fresh cgroup whose path the parent must remove, and
 * the parent must know whether to reap descendants via `cgroup.kill` or by
 * signalling the process group.
 *
 * ```ts no_run
 * const r: StrictSpawnResult = spawnStrictSandboxed(...);
 * try {
 *   // ...use r.pid / r.stdoutFd...
 * } finally {
 *   if (r.descendantCleanup === 'cgroup' && r.cgroupPath) removeCgroup(r.cgroupPath);
 * }
 * ```
 */
export interface StrictSpawnResult extends LaunchedProcess {
  /** The enforcement report derived from the mechanisms the launcher installed. */
  report: SandboxReport;
  /**
   * Filesystem path of the per-spawn cgroup the launcher created, present only
   * when a cgroup was installed. The parent must remove this directory on
   * teardown; absent when no cgroup was used.
   */
  cgroupPath?: string;
  /**
   * How the parent should reap the process and its descendants: `'cgroup'` uses
   * the cgroup's `cgroup.kill`, `'processGroup'` sends the signal to `-pgid`.
   */
  descendantCleanup: 'cgroup' | 'processGroup';
}
/**
 * The sandbox categories the current backend can enforce on this host.
 *
 * Drives the report's `supported` list. On Linux `filesystem` is included only
 * when Landlock was probed available; macOS Seatbelt covers the four
 * non-syscall categories.
 */
function supportedCategories(landlockAvailable: boolean): SandboxCategory[] {
  if (isLinux) {
    const categories: SandboxCategory[] = ['resources'];
    if (landlockAvailable) categories.push('filesystem');
    categories.push('network', 'process', 'syscalls');
    return categories;
  }
  return ['resources', 'filesystem', 'network', 'process'];
}
/**
 * Create a connected `AF_UNIX`/`SOCK_STREAM` socketpair and return its two fds
 * as `[parentEnd, childEnd]`.
 *
 * Throws if the `socketpair(2)` call fails, reporting the raw errno.
 */
function readSocketpair(): [number, number] {
  const buf = new ArrayBuffer(8);
  if (libc.symbols.socketpair(AF_UNIX, SOCK_STREAM, 0, buf) !== 0) {
    throw new Error(`socketpair failed: errno ${errno()}`);
  }
  const view = new DataView(buf);
  return [view.getInt32(0, true), view.getInt32(4, true)];
}
/**
 * Spawn `command` under a strict sandbox via the self-sandboxing launcher and
 * return a handle to the running process together with its enforcement report.
 *
 * The call fails fast, before spawning anything, if `command` is not permitted
 * by `sandbox.process`'s binary allowlist. Otherwise it creates the policy
 * socketpair, hands the child end to `spawnLauncher` (which must launch `fino
 * --sandbox-launcher <fd>` and keep that fd open across exec), writes the policy
 * frame, and reads back the launcher's report. `opts.env` overrides the process
 * environment when present, otherwise `defaultEnv` is used. `landlockAvailable`
 * only affects the report's `supported` list — it does not gate enforcement,
 * which is decided entirely by what the launcher manages to install.
 *
 * Throws if the launcher exits before reporting, sends a malformed or error
 * frame, or if the target `execve` fails (surfaced as a trailing error frame on
 * the still-open socket). On any failure the half-started child's stdio is
 * closed and the process is reaped so it does not linger as a zombie; the policy
 * socket is always closed before returning.
 *
 * `spawnLauncher` is the {@link SpawnLauncher} callback that launches the fino
 * binary through the parent's normal spawn path so stdio stays wired up.
 *
 * ```ts no_run
 * import { spawnStrictSandboxed } from 'internal:security/sandbox/spawn';
 *
 * const result = spawnStrictSandboxed(
 *   '/usr/bin/curl',
 *   ['https://example.com'],
 *   { cwd: '/tmp', env: { PATH: '/usr/bin' } },
 *   {
 *     mode: 'strict',
 *     network: { outbound: [{ action: 'allow', destination: 'example.com', port: 443 }] },
 *     resources: { memoryBytes: 128 * 1024 * 1024 }
 *   },
 *   defaultEnv,
 *   (launcherArgs, inheritFds) => spawnFino(launcherArgs, inheritFds),
 *   isLinux && landlockAvailable()
 * );
 *
 * console.log('enforced:', result.report.enforced.map((c) => c.category));
 * ```
 */
export function spawnStrictSandboxed(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
  sandbox: SandboxPolicy,
  defaultEnv: Record<string, string>,
  spawnLauncher: SpawnLauncher,
  landlockAvailable: boolean,
): StrictSpawnResult {
  // Fail fast on a disallowed initial binary before spawning anything.
  const commandError = checkInitialCommand(sandbox.process, command);
  if (commandError !== null) throw new Error(commandError);
  const [parentSock, childSock] = readSocketpair();
  setCloexec(childSock, false);
  setCloexec(parentSock, true);
  let launched: LaunchedProcess;
  try {
    launched = spawnLauncher(['--sandbox-launcher', String(childSock)], [childSock]);
  } finally {
    libc.symbols.close(childSock);
  }
  const closeChildStreams = (): void => {
    libc.symbols.close(launched.stdinFd);
    libc.symbols.close(launched.stdoutFd);
    libc.symbols.close(launched.stderrFd);
    // The launcher _exit(1)'d without exec'ing; reap it so it does not linger
    // as a zombie (the Process object was never constructed, so nobody waits).
    libc.symbols.waitpid(launched.pid, new ArrayBuffer(4), 0);
  };
  try {
    writeFrame(parentSock, {
      command,
      args,
      cwd: opts.cwd,
      env: opts.env ?? defaultEnv,
      sandbox,
    });
    const reportFrame = readFrame(parentSock);
    if (reportFrame === null) throw new Error('sandbox launcher exited before reporting');
    const framed = reportFrame as {
      type?: string;
      installed?: InstalledMechanism[];
      cgroupPath?: string;
      descendantCleanup?: 'cgroup' | 'processGroup';
      stage?: string;
      message?: string;
      errno?: number;
    };
    if (framed.type === 'error') {
      throw new Error(
        `sandbox launcher failed at ${framed.stage}: ${framed.message} (errno ${framed.errno ?? 0})`,
      );
    }
    if (framed.type !== 'report' || !Array.isArray(framed.installed)) {
      throw new Error('sandbox launcher sent an unexpected frame');
    }
    // A second read distinguishes a successful execve (clean EOF via CLOEXEC)
    // from an execve failure (an error frame on the still-open socket).
    const tail = readFrame(parentSock);
    if (tail !== null) {
      const err = tail as { stage?: string; message?: string; errno?: number };
      throw new Error(
        `sandbox launcher failed at ${err.stage ?? 'execve'}: ${err.message ?? 'exec failed'} (errno ${err.errno ?? 0})`,
      );
    }
    const backend = isLinux ? 'linuxNative' : 'macosSeatbelt';
    const report = buildReport(
      sandbox,
      framed.installed,
      backend,
      supportedCategories(landlockAvailable),
    );
    return {
      ...launched,
      report,
      cgroupPath: framed.cgroupPath,
      descendantCleanup: framed.descendantCleanup ?? 'processGroup',
    };
  } catch (err) {
    closeChildStreams();
    throw err;
  } finally {
    libc.symbols.close(parentSock);
  }
}
