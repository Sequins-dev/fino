/**
* internal:security/sandbox/cgroup — per-spawn cgroup v2 resource limits and
* reliable descendant cleanup.
*
* Linux only. When a delegated cgroup v2 subtree with the needed controllers is
* available, the launcher creates a leaf cgroup, writes `memory.max` /
* `pids.max` / `cpu.max`, and joins the launcher process into it before exec so
* the target and every descendant it spawns are accounted and bounded. The
* parent later writes `cgroup.kill` to reap the whole tree — cleanup a plain
* `kill(pid)` cannot guarantee, since forked-away or reparented descendants can
* outlive the direct child.
*
* "Delegated" means a subtree fino may write to whose `cgroup.subtree_control`
* enables the controllers a policy needs: `FINO_SANDBOX_CGROUP_ROOT`, or the
* process's own cgroup when that is the (writable) root cgroup. Where a
* controller is not delegated, `memory`/`pids` fall back to rlimits and `cpu` is
* rejected before spawn — there is no rlimit equivalent for a fractional CPU
* quota. The split lets a policy degrade gracefully on hosts with partial
* delegation while still failing closed in strict mode when nothing can enforce
* a hard limit like `cpu`.
*
* The launcher drives the pieces here in sequence: resolve a root, create and
* join a leaf, fall back to rlimits for whatever the cgroup could not handle,
* then hand the leaf path back to the parent for teardown.
*
* ```ts no_run
* import {
*   resolveDelegatedRoot,
*   createAndJoinCgroup,
*   killAndRemoveCgroup,
* } from 'internal:security/sandbox/cgroup';
*
* const root = resolveDelegatedRoot();
* if (root !== null) {
*   const cg = createAndJoinCgroup(root, { memoryBytes: 256 * 1024 * 1024, cpu: 0.5 });
*   // ... execve the sandboxed target; it inherits the cgroup ...
*   // Later, in the parent's wait()/kill() path:
*   killAndRemoveCgroup(cg.path);
* }
* ```
*
* Reference: https://docs.kernel.org/admin-guide/cgroup-v2.html
*
* @internal
*/
import { libc, errno, cstr, readFileSync, writeFileSync } from './ffi.ts';
import { env } from 'internal:process';
import type { ResourcePolicy } from './plan.ts';
const CGROUP_MOUNT = '/sys/fs/cgroup';
const CPU_PERIOD = 100000;
const WANTED = ['cpu', 'memory', 'pids'];
/**
* Resolve a cgroup v2 subtree fino may create leaf cgroups under, or `null` when
* none is usable.
*
* Two sources are tried in order: the `FINO_SANDBOX_CGROUP_ROOT` environment
* variable, then the process's own cgroup — but only if that own cgroup is the
* root cgroup (`0::/` in `/proc/self/cgroup`). A non-root leaf that already holds
* processes cannot also delegate controllers to children (the cgroup v2 "no
* internal processes" rule), so only the root case is safe to auto-detect;
* every other layout must be delegated explicitly via the environment variable.
*
* Returns `null` when neither source resolves — including when
* `FINO_SANDBOX_CGROUP_ROOT` points at a path that has no `cgroup.controllers`
* file (not a cgroup v2 mount) and when running unprivileged in a leaf cgroup.
* A non-null result is a directory path under which leaf cgroups can be created,
* not a guarantee that any particular controller is delegated — check
* `usableControllers()` for that.
*
* ```ts no_run
* import { resolveDelegatedRoot } from 'internal:security/sandbox/cgroup';
*
* const root = resolveDelegatedRoot();
* if (root === null) {
*   // No delegated subtree: fall back to rlimits for memory/pids, reject cpu.
* } else {
*   // e.g. '/sys/fs/cgroup' or whatever FINO_SANDBOX_CGROUP_ROOT names.
* }
* ```
*/
export function resolveDelegatedRoot(): string | null {
  const explicit = env.FINO_SANDBOX_CGROUP_ROOT;
  if (explicit !== undefined && explicit.length > 0) {
    return readFileSync(`${explicit}/cgroup.controllers`) !== null ? explicit : null;
  }
  const self = readFileSync('/proc/self/cgroup');
  if (self === null) return null;
  // cgroup v2 line: "0::/<path>". The root cgroup is "0::/".
  const line = self.split('\n').find((l) => l.startsWith('0::'));
  if (line === undefined) return null;
  const path = line.slice('0::'.length).trim();
  if (path !== '/') return null;
  return readFileSync(`${CGROUP_MOUNT}/cgroup.controllers`) !== null ? CGROUP_MOUNT : null;
}
function parseControllers(text: string | null): Set<string> {
  return new Set((text ?? '').trim().split(/\s+/).filter((c) => c.length > 0));
}
/**
* Report the controllers a leaf created under the delegated root can actually
* use, as a set of names drawn from `cpu`, `memory`, and `pids`.
*
* Before reporting, it makes a best-effort attempt to enable any of the wanted
* controllers that are available in the root but not yet in its
* `cgroup.subtree_control` — fino owns the root in the root-cgroup case, so this
* write typically succeeds and widens what a leaf can enforce. The returned set
* is then read back from `cgroup.subtree_control`, so it reflects what is truly
* delegated after the enable attempt, not merely what was requested.
*
* Returns an empty set when there is no delegated root, or when the root exposes
* none of the wanted controllers to its subtree. The enable write is silently
* ignored on failure (e.g. an unwritable root), so a controller that could not
* be enabled simply does not appear in the result.
*
* ```ts no_run
* import { usableControllers } from 'internal:security/sandbox/cgroup';
*
* const controllers = usableControllers();
* if (controllers.has('memory')) {
*   // memory.max can be written on the per-spawn leaf.
* }
* ```
*/
export function usableControllers(): Set<string> {
  const root = resolveDelegatedRoot();
  if (root === null) return new Set();
  const available = parseControllers(readFileSync(`${root}/cgroup.controllers`));
  const current = parseControllers(readFileSync(`${root}/cgroup.subtree_control`));
  const toEnable = WANTED.filter((c) => available.has(c) && !current.has(c));
  if (toEnable.length > 0) {
    writeFileSync(`${root}/cgroup.subtree_control`, toEnable.map((c) => `+${c}`).join(' '));
  }
  return parseControllers(readFileSync(`${root}/cgroup.subtree_control`));
}
/**
* Whether the `cpu` controller can be enforced through a delegated cgroup.
*
* This gates the cpu resource policy. Because there is no rlimit equivalent for
* a fractional CPU quota, the parent calls this before spawn: a policy that
* requests `cpu` on a host where this returns `false` is rejected in strict mode
* rather than silently ignored. It is a thin `usableControllers().has('cpu')`,
* so it triggers the same best-effort subtree-control enable as that function.
*
* ```ts no_run
* import { cgroupCpuAvailable } from 'internal:security/sandbox/cgroup';
*
* if (policy.cpu !== undefined && !cgroupCpuAvailable()) {
*   throw new Error('cpu limit requested but no delegated cgroup cpu controller');
* }
* ```
*/
export function cgroupCpuAvailable(): boolean {
  return usableControllers().has('cpu');
}
/**
* Result of creating and joining a per-spawn cgroup.
*
* Returned by `createAndJoinCgroup`. The launcher records `installed` limits in
* its report, applies rlimit fallbacks for whatever is in `unhandled`, and hands
* `path` to the parent so teardown can `killAndRemoveCgroup` the whole tree.
*
* ```ts no_run
* import { createAndJoinCgroup } from 'internal:security/sandbox/cgroup';
*
* const cg = createAndJoinCgroup(root, { memoryBytes: 128 * 1024 * 1024, pids: 64 });
* for (const limit of cg.installed) reportInstalled('cgroup', limit);
* for (const limit of cg.unhandled) applyRlimitFor(limit);
* ```
*/
export interface CgroupResult {
  /** Absolute path of the created leaf cgroup, e.g. `<root>/fino-sandbox-<pid>`; pass this to `killAndRemoveCgroup`. */
  path: string;
  /** Limits actually enforced on the cgroup, one entry per resource written. */
  installed: Array<'memoryBytes' | 'pids' | 'cpu'>;
  /** Resource categories the cgroup could not enforce because their controller was not delegated; the caller must fall back to rlimits. */
  unhandled: Array<'memoryBytes' | 'pids'>;
}
/**
* Create a per-spawn leaf cgroup under `root`, apply the resource limits whose
* controllers are delegated, and move the current process into it so the exec'd
* target inherits membership.
*
* The leaf is named `fino-sandbox-<pid>` under `root`. Each policy field is
* applied only if its controller is delegated: `memoryBytes` writes
* `memory.max`, `pids` writes `pids.max`, and `cpu` writes `cpu.max` as a quota
* over a fixed 100ms period (`cpu` of `0.5` becomes `50000 100000`, rounded and
* clamped to at least 1µs). Applied limits land in `installed`. `memoryBytes`
* and `pids` whose controller is missing are returned in `unhandled` for the
* caller to satisfy with rlimits instead; a missing `cpu` controller is dropped
* here (the parent is expected to have already rejected such a policy via
* `cgroupCpuAvailable`). The current process is moved into the leaf last, by
* writing its pid to `cgroup.procs`, because the target inherits this membership
* across `execve`.
*
* Throws only on structural failures: if `mkdir` of the leaf fails for any
* reason other than it already existing (`EEXIST`), or if any control-file write
* — including the final `cgroup.procs` join — fails. Errors carry the offending
* path or file and the raw errno. Failing loudly here lets strict mode fail
* closed when the cgroup itself is unusable rather than exec into an unbounded
* target. Call `usableControllers` / `resolveDelegatedRoot` first; a `null` root
* must not be passed.
*
* ```ts no_run
* import { resolveDelegatedRoot, createAndJoinCgroup } from 'internal:security/sandbox/cgroup';
*
* const root = resolveDelegatedRoot();
* if (root !== null) {
*   const cg = createAndJoinCgroup(root, {
*     memoryBytes: 256 * 1024 * 1024,
*     pids: 128,
*     cpu: 0.5,
*   });
*   // cg.installed lists what the cgroup enforces; cg.unhandled needs rlimits.
* }
* ```
*/
export function createAndJoinCgroup(root: string, policy: ResourcePolicy): CgroupResult {
  const controllers = usableControllers();
  const path = `${root}/fino-sandbox-${Number(libc.symbols.getpid())}`;
  if (libc.symbols.mkdir(cstr(path), 0o755) !== 0) {
    const e = errno();
    if (e !== 17 /* EEXIST */) throw new Error(`cgroup: mkdir('${path}') failed: errno ${e}`);
  }
  const installed: CgroupResult['installed'] = [];
  const unhandled: CgroupResult['unhandled'] = [];
  const write = (file: string, value: string): void => {
    const e = writeFileSync(`${path}/${file}`, value);
    if (e !== 0) throw new Error(`cgroup: write ${file}=${value} failed: errno ${e}`);
  };
  if (policy.memoryBytes !== undefined) {
    if (controllers.has('memory')) { write('memory.max', String(policy.memoryBytes)); installed.push('memoryBytes'); }
    else unhandled.push('memoryBytes');
  }
  if (policy.pids !== undefined) {
    if (controllers.has('pids')) { write('pids.max', String(policy.pids)); installed.push('pids'); }
    else unhandled.push('pids');
  }
  if (policy.cpu !== undefined && controllers.has('cpu')) {
    write('cpu.max', `${Math.max(1, Math.round(policy.cpu * CPU_PERIOD))} ${CPU_PERIOD}`);
    installed.push('cpu');
  }
  // Move ourselves in last; the target inherits this cgroup across execve.
  write('cgroup.procs', String(Number(libc.symbols.getpid())));
  return { path, installed, unhandled };
}
/**
* Kill every process in the spawn's cgroup and remove the leaf directory.
*
* Writes `1` to `cgroup.kill`, which the kernel delivers as an unstoppable kill
* to every process in the tree — including descendants that forked away or were
* reparented, which a plain `kill(pid)` on the direct child would miss. It then
* retries `rmdir` up to a bounded number of times, because the kernel needs a
* moment to drain the dying tree before the now-empty cgroup can be removed;
* while draining, `rmdir` fails with `EBUSY` and is retried, and any other errno
* (or success) stops the loop. The retries never sleep, so this does not block
* the event loop.
*
* Called by the parent during `wait()` / `kill()` teardown. It is idempotent and
* safe to call repeatedly and after the tree has already exited — a
* `cgroup.kill` write or `rmdir` against an already-gone path simply no-ops.
* Never throws.
*
* ```ts no_run
* import { killAndRemoveCgroup } from 'internal:security/sandbox/cgroup';
*
* // In the parent, once the sandboxed child has been waited on:
* killAndRemoveCgroup(cg.path);
* ```
*/
export function killAndRemoveCgroup(path: string): void {
  writeFileSync(`${path}/cgroup.kill`, '1');
  // The kernel needs a moment to drain the tree before rmdir will succeed;
  // retry a bounded number of times without sleeping on the event loop.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (libc.symbols.rmdir(cstr(path)) === 0) return;
    if (errno() !== 16 /* EBUSY */) return;
  }
}
