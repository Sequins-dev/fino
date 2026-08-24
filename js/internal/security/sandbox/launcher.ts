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
 * The single argument is a file descriptor for a socket the parent opened before
 * spawning this process. The parent writes one {@link LaunchRequest} frame (the
 * target command plus the {@link SandboxPolicy}); the launcher applies the policy
 * and writes back one `report` frame listing every mechanism it installed, then
 * `execve`s the target. On any failure it writes an `error` frame instead and
 * exits non-zero, so the parent always learns why a launch never reached the
 * target. This module is dispatched from `internal:main` and is not meant to be
 * imported by application code.
 *
 * ```ts no_run
 * import { runLauncher } from 'internal:security/sandbox/launcher';
 *
 * // `fino --sandbox-launcher <fd>` dispatches here before any CLI parsing.
 * // argv[1] is the flag, argv[2] is the inherited socket descriptor.
 * const fd = Number(argv[2]);
 * runLauncher(fd); // installs OS policy on this process, then execve — never returns
 * ```
 *
 * @internal
 */
import { finalizeSandboxExec, os } from 'internal:process';
import { libc, errno, cstr, buildCStringArray, setCloexec } from './ffi.ts';
import { encodeFrame, readFrame, writeFrame } from './frame.ts';
import { prepareSeccomp } from './seccomp.ts';
import { installLandlock } from './landlock.ts';
import { resolveDelegatedRoot, createAndJoinCgroup } from './cgroup.ts';
import { generateSeatbeltProfile } from './seatbelt.ts';
import { planSeccomp } from './plan.ts';
import type { SandboxPolicy } from './plan.ts';
import type { InstalledMechanism } from './report.ts';
const isLinux = os === 'linux';
/**
 * The single frame the parent writes to the launcher socket describing what to
 * run and how to confine it.
 *
 * `command` is the absolute path to the target binary and `args` are its
 * arguments *excluding* argv[0] — the launcher synthesizes argv[0] from
 * `command` itself. `cwd`, when set, is applied with `chdir` before any policy
 * is installed. `env` fully replaces the environment passed to `execve`; an
 * absent or empty `env` means the target starts with no inherited variables.
 * `sandbox` is the policy applied to this process before exec; when omitted the
 * launcher defaults to `{ mode: 'strict' }`.
 */
interface LaunchRequest {
  /** Absolute path to the target binary to `execve`. */
  command: string;
  /** Target arguments, excluding argv[0]; the launcher derives argv[0] from `command`. */
  args: string[];
  /** Optional working directory applied with `chdir` before any policy is installed. */
  cwd?: string;
  /** Environment for the target; fully replaces the inherited environment, empty when absent. */
  env?: Record<string, string>;
  /** Policy installed on this process before exec; defaults to `{ mode: 'strict' }` when absent. */
  sandbox: SandboxPolicy;
}
/**
 * Report a fatal launcher failure to the parent and hard-exit; never returns.
 *
 * Writes a single `error` frame naming the `stage` that failed (for example
 * `'chdir'`, `'apply-policy'`, or `'execve'`), a human-readable `message`, and
 * the captured `errno` when the failure came from a syscall, then calls `_exit(1)`.
 * The frame write is best-effort: if the parent has already gone away the error
 * is swallowed and the process still exits non-zero. The `never` return lets
 * callers use `fail(...)` as the last statement of a branch without the compiler
 * demanding a fallthrough value.
 */
function fail(fd: number, stage: string, message: string, errnoValue?: number): never {
  try {
    writeFrame(fd, { type: 'error', stage, message, errno: errnoValue ?? 0 });
  } catch (_) {
    // The parent may already be gone; there is nothing else we can do.
  }
  libc.symbols._exit(1);
  throw new Error('unreachable');
}
/**
 * Derive the report records for the seccomp filter a policy will produce.
 *
 * Called while building the installed-mechanism list so the parent's report can
 * credit seccomp for syscall filtering, `fork` denial, and coarse socket denial.
 * This only records what the plan *will* enforce — the filter itself is compiled
 * and installed separately as the very last step before `execve`, so that an
 * allowlist has to permit only `execve` and the target's startup, never the
 * launcher's own bookkeeping syscalls.
 */
// Record the seccomp categories a plan will enforce, for the report. The plan
// is installed separately, as the very last step before execve.
function seccompInstalledRecords(sandbox: SandboxPolicy): InstalledMechanism[] {
  const records: InstalledMechanism[] = [];
  if (sandbox.syscalls !== undefined) records.push({ category: 'syscalls', mechanism: 'seccomp' });
  if (sandbox.process?.allowFork === false)
    records.push({ category: 'process', mechanism: 'seccomp', detail: 'fork denied' });
  if (sandbox.network !== undefined)
    records.push({ category: 'network', mechanism: 'seccomp', detail: 'coarse socket denial' });
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
 * the launcher's bookkeeping. On Linux the sequence is resources (cgroup, with
 * an rlimit fallback for undelegated controllers) then Landlock then seccomp; on
 * macOS it is rlimits then a generated Seatbelt profile handed to
 * `/usr/bin/sandbox-exec`, which becomes the exec target in place of the binary.
 *
 * The `fd` is the launcher socket the parent inherited to this process. The
 * first thing this does is read one {@link LaunchRequest} frame from it; a
 * missing or malformed frame is a `read-request` failure. Just before `execve`
 * the socket is marked close-on-exec so it never leaks into the target. This
 * function never returns on success — the process image is replaced — and calls
 * {@link fail} (which hard-exits non-zero) on every error path, so callers must
 * treat control returning past it as impossible.
 *
 * ```ts no_run
 * import { runLauncher } from 'internal:security/sandbox/launcher';
 *
 * // Dispatched by internal:main when started as `fino --sandbox-launcher <fd>`.
 * // The parent has already written the LaunchRequest frame to this descriptor.
 * if (argv[1] === '--sandbox-launcher') {
 *   runLauncher(Number(argv[2]));
 * }
 * // Unreachable on success: the target has replaced this process image.
 * ```
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
  const hasProcessPolicy =
    sandbox.process?.allowExec === false || (sandbox.process?.allowedBinaries?.length ?? 0) > 0;
  let execCommand: string;
  let execArgv: string[];
  let preparedSeccomp: ReturnType<typeof prepareSeccomp> = null;
  let deferredRlimits: SandboxPolicy['resources'];
  let cgroupPath: string | undefined;
  const deferRlimits = (resources: NonNullable<SandboxPolicy['resources']>): void => {
    deferredRlimits = resources;
    if (resources.memoryBytes !== undefined) {
      installed.push({
        category: 'resources',
        mechanism: 'rlimit',
        tier: 'rlimit',
        detail: 'memoryBytes',
      });
    }
    if (resources.pids !== undefined) {
      installed.push({
        category: 'resources',
        mechanism: 'rlimit',
        tier: 'rlimit',
        detail: 'pids',
      });
    }
  };
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
            installed.push({
              category: 'resources',
              mechanism: 'cgroup',
              tier: 'cgroup',
              detail: limit,
            });
          }
          // memory/pids whose controller was not delegated fall back to rlimits.
          const fallbackResources: NonNullable<SandboxPolicy['resources']> = {};
          const memoryBytes = sandbox.resources.memoryBytes;
          const pids = sandbox.resources.pids;
          if (cg.unhandled.includes('memoryBytes') && memoryBytes !== undefined) {
            fallbackResources.memoryBytes = memoryBytes;
          }
          if (cg.unhandled.includes('pids') && pids !== undefined) fallbackResources.pids = pids;
          deferRlimits(fallbackResources);
        } else {
          // cpu was rejected pre-spawn (no rlimit equivalent); memory/pids fall
          // back to rlimits, reported honestly as the weaker tier.
          deferRlimits(sandbox.resources);
        }
      }
      const landlock = installLandlock(sandbox.filesystem, sandbox.process, request.command);
      if (landlock.fsConfined) installed.push({ category: 'filesystem', mechanism: 'landlock' });
      if (landlock.execScoped) {
        installed.push({
          category: 'process',
          mechanism: 'landlock',
          detail: 'execute scoped to the initial binary and allowedBinaries',
        });
      }
      preparedSeccomp = prepareSeccomp(planSeccomp(sandbox));
      installed.push(...seccompInstalledRecords(sandbox));
      execCommand = request.command;
      execArgv = [request.command, ...request.args];
    } else {
      if (sandbox.resources !== undefined) {
        deferRlimits(sandbox.resources);
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
      if (sandbox.filesystem !== undefined)
        installed.push({ category: 'filesystem', mechanism: 'seatbelt' });
      if (sandbox.network !== undefined)
        installed.push({
          category: 'network',
          mechanism: 'seatbelt',
          detail: 'coarse/directional',
        });
      if (hasProcessPolicy)
        installed.push({
          category: 'process',
          mechanism: 'seatbelt',
          detail: 'execute scoped to the initial binary and allowedBinaries',
        });
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
  // Prepare every allocation needed by the final launch sequence before
  // applying RLIMIT_AS. On x86-64 V8 reserves a large virtual-address cage; a
  // lower payload limit is valid after execve but can make any later launcher
  // allocation fail.
  let reportFrame: Uint8Array;
  let argvBuf: ArrayBuffer;
  let argvBufs: Uint8Array[];
  let envpBuf: ArrayBuffer;
  let envpBufs: Uint8Array[];
  let commandBuf: Uint8Array;
  try {
    reportFrame = encodeFrame({ type: 'report', installed, cgroupPath, descendantCleanup });
    setCloexec(fd, true);
    const envMap = request.env ?? {};
    const envStrings = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);
    ({ ptrBuf: argvBuf, bufs: argvBufs } = buildCStringArray(execArgv));
    ({ ptrBuf: envpBuf, bufs: envpBufs } = buildCStringArray(envStrings));
    commandBuf = cstr(execCommand);
  } catch (err) {
    fail(fd, 'prepare-exec', err instanceof Error ? err.message : String(err));
  }
  finalizeSandboxExec(
    fd,
    reportFrame,
    commandBuf,
    argvBuf,
    envpBuf,
    deferredRlimits?.memoryBytes ?? 0,
    deferredRlimits?.pids ?? 0,
    preparedSeccomp?.prog,
    preparedSeccomp?.filterBuf,
    argvBufs,
    envpBufs,
  );
  fail(fd, 'finalize-exec', `native exec of '${execCommand}' returned unexpectedly`, errno());
}
