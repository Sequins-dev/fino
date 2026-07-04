/**
* internal:security/sandbox/launcher — the self-sandboxing launcher body.
*
* `fino --sandbox-launcher <fd>` runs this. It is a normal, live fino process
* (V8 is up), so it applies OS policy to *itself* over FFI and then `execve`s
* the target. Because `execve` keeps the same pid, the parent's `pid`, `kill()`,
* `wait()`, and inherited stdio pipes all keep working, and the target inherits
* every restriction installed here.
*
* JavaScript cannot run between `fork()` and `execve()`; the launcher sidesteps
* that entirely by being a fully-initialized process that sandboxes itself
* before exec. Its synchronous setup FFI does not run on any live event loop.
*
* @internal
*/
import { os } from 'internal:process';
import { libc, errno, cstr, buildCStringArray, setCloexec } from './ffi.ts';
import { readFrame, writeFrame } from './frame.ts';
import { installSeccomp } from './seccomp.ts';
import { installLandlock } from './landlock.ts';
import { installRlimits } from './rlimit.ts';
import { resolveDelegatedRoot, createAndJoinCgroup } from './cgroup.ts';
import { generateSeatbeltProfile } from './seatbelt.ts';
import { planSeccomp } from './plan.ts';
import type { SandboxPolicy } from './plan.ts';
import type { InstalledMechanism } from './report.ts';
const isLinux = os === 'linux';
interface LaunchRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  sandbox: SandboxPolicy;
}
function fail(fd: number, stage: string, message: string, errnoValue?: number): never {
  try {
    writeFrame(fd, { type: 'error', stage, message, errno: errnoValue ?? 0 });
  } catch (_) {
    // The parent may already be gone; there is nothing else we can do.
  }
  libc.symbols._exit(1);
  throw new Error('unreachable');
}
// Record the seccomp categories a plan will enforce, for the report. The plan
// is installed separately, as the very last step before execve.
function seccompInstalledRecords(sandbox: SandboxPolicy): InstalledMechanism[] {
  const records: InstalledMechanism[] = [];
  if (sandbox.syscalls !== undefined) records.push({ category: 'syscalls', mechanism: 'seccomp' });
  if (sandbox.process?.allowFork === false) records.push({ category: 'process', mechanism: 'seccomp', detail: 'fork denied' });
  if (sandbox.network !== undefined) records.push({ category: 'network', mechanism: 'seccomp', detail: 'coarse socket denial' });
  return records;
}
/**
* Run the launcher: read the policy, apply it to this process, report what was
* installed, then `execve` the target. Never returns on success (the image is
* replaced); writes an error frame and exits non-zero on any failure.
*
* Ordering is load-bearing. Everything that issues a syscall the policy might
* forbid — the report `write`, the CLOEXEC `fcntl`, all buffer allocation — runs
* BEFORE seccomp. seccomp is installed last, immediately before `execve`, so an
* allowlist filter only has to permit `execve` and the target's own startup, not
* the launcher's bookkeeping.
*/
export function runLauncher(fd: number): void {
  let request: LaunchRequest;
  try {
    const frame = readFrame(fd);
    if (frame === null || typeof frame !== 'object') throw new Error('empty launch request');
    request = frame as LaunchRequest;
  } catch (err) {
    fail(fd, 'read-request', err instanceof Error ? err.message : String(err));
  }
  const sandbox = request.sandbox ?? { mode: 'strict' };
  if (request.cwd !== undefined) {
    if (libc.symbols.chdir(cstr(request.cwd)) !== 0) {
      fail(fd, 'chdir', `chdir('${request.cwd}') failed`, errno());
    }
  }
  const installed: InstalledMechanism[] = [];
  const hasProcessPolicy = sandbox.process?.allowExec === false
    || (sandbox.process?.allowedBinaries?.length ?? 0) > 0;
  let execCommand: string;
  let execArgv: string[];
  let seccompPlan: ReturnType<typeof planSeccomp> | null = null;
  let cgroupPath: string | undefined;
  try {
    if (isLinux) {
      // Resources first: cgroup writes and joining must happen before Landlock
      // confines the filesystem view.
      if (sandbox.resources !== undefined) {
        const root = resolveDelegatedRoot();
        if (root !== null) {
          const cg = createAndJoinCgroup(root, sandbox.resources);
          cgroupPath = cg.path;
          for (const limit of cg.installed) {
            installed.push({ category: 'resources', mechanism: 'cgroup', tier: 'cgroup', detail: limit });
          }
          // memory/pids whose controller was not delegated fall back to rlimits.
          for (const limit of installRlimits({
            memoryBytes: cg.unhandled.includes('memoryBytes') ? sandbox.resources.memoryBytes : undefined,
            pids: cg.unhandled.includes('pids') ? sandbox.resources.pids : undefined
          })) {
            installed.push({ category: 'resources', mechanism: 'rlimit', tier: 'rlimit', detail: limit });
          }
        } else {
          // cpu was rejected pre-spawn (no rlimit equivalent); memory/pids fall
          // back to rlimits, reported honestly as the weaker tier.
          for (const limit of installRlimits(sandbox.resources)) {
            installed.push({ category: 'resources', mechanism: 'rlimit', tier: 'rlimit', detail: limit });
          }
        }
      }
      const landlock = installLandlock(sandbox.filesystem, sandbox.process, request.command);
      if (landlock.fsConfined) installed.push({ category: 'filesystem', mechanism: 'landlock' });
      if (landlock.execScoped) {
        installed.push({ category: 'process', mechanism: 'landlock', detail: 'execute scoped to the initial binary and allowedBinaries' });
      }
      seccompPlan = planSeccomp(sandbox);
      installed.push(...seccompInstalledRecords(sandbox));
      execCommand = request.command;
      execArgv = [request.command, ...request.args];
    } else {
      if (sandbox.resources !== undefined) {
        for (const limit of installRlimits(sandbox.resources)) {
          installed.push({ category: 'resources', mechanism: 'rlimit', tier: 'rlimit', detail: limit });
        }
      }
      // Scope exec to the initial binary plus absolute-path allowlist entries
      // when the policy expresses an exec rule; otherwise allow any exec.
      let execPaths: string[] | null = null;
      if (hasProcessPolicy) {
        execPaths = [request.command];
        for (const entry of sandbox.process?.allowedBinaries ?? []) {
          if (entry.startsWith('/')) execPaths.push(entry);
        }
      }
      const profile = generateSeatbeltProfile(sandbox.filesystem, sandbox.network, execPaths);
      if (sandbox.filesystem !== undefined) installed.push({ category: 'filesystem', mechanism: 'seatbelt' });
      if (sandbox.network !== undefined) installed.push({ category: 'network', mechanism: 'seatbelt', detail: 'coarse/directional' });
      if (hasProcessPolicy) installed.push({ category: 'process', mechanism: 'seatbelt', detail: 'execute scoped to the initial binary and allowedBinaries' });
      execCommand = '/usr/bin/sandbox-exec';
      execArgv = ['/usr/bin/sandbox-exec', '-p', profile, request.command, ...request.args];
    }
  } catch (err) {
    fail(fd, 'apply-policy', err instanceof Error ? err.message : String(err), errno());
  }
  // Descendant cleanup: a per-spawn cgroup reaps its whole tree via cgroup.kill.
  // Without one, put the target in its own process group so the parent can
  // kill(-pgid) any orphans on teardown — descendant containment is never left
  // to a bare kill(pid).
  let descendantCleanup: 'cgroup' | 'processGroup' = 'processGroup';
  if (cgroupPath !== undefined) {
    descendantCleanup = 'cgroup';
  } else {
    libc.symbols.setpgid(0, 0);
  }
  // Report and mark the socket close-on-exec before seccomp, so an allowlist
  // filter does not have to permit these bookkeeping syscalls.
  try {
    writeFrame(fd, { type: 'report', installed, cgroupPath, descendantCleanup });
  } catch (err) {
    fail(fd, 'report', err instanceof Error ? err.message : String(err));
  }
  setCloexec(fd, true);
  const envMap = request.env ?? {};
  const envStrings = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);
  const { ptrBuf: argvBuf, bufs: argvBufs } = buildCStringArray(execArgv);
  const { ptrBuf: envpBuf, bufs: envpBufs } = buildCStringArray(envStrings);
  const commandBuf = cstr(execCommand);
  // seccomp is the final policy step; nothing but execve runs after it.
  if (seccompPlan !== null) {
    try {
      installSeccomp(seccompPlan);
    } catch (err) {
      fail(fd, 'seccomp', err instanceof Error ? err.message : String(err), errno());
    }
  }
  libc.symbols.execve(commandBuf, argvBuf, envpBuf);
  // execve only returns on failure; the CLOEXEC fd is therefore still open.
  void argvBufs;
  void envpBufs;
  fail(fd, 'execve', `execve('${execCommand}') failed`, errno());
}
