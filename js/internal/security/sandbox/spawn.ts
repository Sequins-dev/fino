/**
* internal:security/sandbox/spawn — parent side of the self-sandboxing launcher.
*
* Creates the policy socketpair, asks the caller to spawn the launcher (through
* the ordinary pipe/posix_spawn path so stdio, `pid`, `kill()`, and `wait()`
* keep working), exchanges frames, and turns the launcher's installed-mechanism
* records into a `ProcessSandboxReport`.
*
* Error propagation uses the classic CLOEXEC-signaling pattern: after writing
* its report the launcher marks the socket close-on-exec and `execve`s. A clean
* EOF on the next read means exec succeeded; an error frame means a mechanism or
* the exec itself failed, and the parent throws a spawn-time error.
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
/** Result of spawning the launcher process through the parent's spawn path. */
export interface LaunchedProcess {
  pid: number;
  stdinFd: number;
  stdoutFd: number;
  stderrFd: number;
}
/** Callback that spawns `fino <launcherArgs>` with `inheritFds` kept open in the child. */
export type SpawnLauncher = (launcherArgs: string[], inheritFds: number[]) => LaunchedProcess;
export interface StrictSpawnResult extends LaunchedProcess {
  report: SandboxReport;
  /** Per-spawn cgroup path the parent must clean up on teardown, if any. */
  cgroupPath?: string;
  /** How the parent should reap descendants: cgroup.kill or kill(-pgid). */
  descendantCleanup: 'cgroup' | 'processGroup';
}
function supportedCategories(landlockAvailable: boolean): SandboxCategory[] {
  if (isLinux) {
    const categories: SandboxCategory[] = ['resources'];
    if (landlockAvailable) categories.push('filesystem');
    categories.push('network', 'process', 'syscalls');
    return categories;
  }
  return ['resources', 'filesystem', 'network', 'process'];
}
function readSocketpair(): [number, number] {
  const buf = new ArrayBuffer(8);
  if (libc.symbols.socketpair(AF_UNIX, SOCK_STREAM, 0, buf) !== 0) {
    throw new Error(`socketpair failed: errno ${errno()}`);
  }
  const view = new DataView(buf);
  return [view.getInt32(0, true), view.getInt32(4, true)];
}
/**
* Spawn `command` under a strict sandbox via the self-sandboxing launcher.
*
* @param spawnLauncher launches `fino --sandbox-launcher <fd>` through the
*   parent's normal pipe/posix_spawn path, keeping the launcher's socket fd open.
* @param landlockAvailable whether Landlock was probed available (for the report's
*   `supported` list).
*/
export function spawnStrictSandboxed(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
  sandbox: SandboxPolicy,
  defaultEnv: Record<string, string>,
  spawnLauncher: SpawnLauncher,
  landlockAvailable: boolean
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
      sandbox
    });
    const reportFrame = readFrame(parentSock);
    if (reportFrame === null) throw new Error('sandbox launcher exited before reporting');
    const framed = reportFrame as { type?: string; installed?: InstalledMechanism[]; cgroupPath?: string; descendantCleanup?: 'cgroup' | 'processGroup'; stage?: string; message?: string; errno?: number };
    if (framed.type === 'error') {
      throw new Error(`sandbox launcher failed at ${framed.stage}: ${framed.message} (errno ${framed.errno ?? 0})`);
    }
    if (framed.type !== 'report' || !Array.isArray(framed.installed)) {
      throw new Error('sandbox launcher sent an unexpected frame');
    }
    // A second read distinguishes a successful execve (clean EOF via CLOEXEC)
    // from an execve failure (an error frame on the still-open socket).
    const tail = readFrame(parentSock);
    if (tail !== null) {
      const err = tail as { stage?: string; message?: string; errno?: number };
      throw new Error(`sandbox launcher failed at ${err.stage ?? 'execve'}: ${err.message ?? 'exec failed'} (errno ${err.errno ?? 0})`);
    }
    const backend = isLinux ? 'linuxNative' : 'macosSeatbelt';
    const report = buildReport(sandbox, framed.installed, backend, supportedCategories(landlockAvailable));
    return { ...launched, report, cgroupPath: framed.cgroupPath, descendantCleanup: framed.descendantCleanup ?? 'processGroup' };
  } catch (err) {
    closeChildStreams();
    throw err;
  } finally {
    libc.symbols.close(parentSock);
  }
}
