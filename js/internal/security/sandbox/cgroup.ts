/**
* internal:security/sandbox/cgroup — per-spawn cgroup v2 resource limits and
* reliable descendant cleanup.
*
* When a delegated cgroup subtree with the needed controllers is available, the
* launcher creates a leaf cgroup, writes `memory.max` / `pids.max` / `cpu.max`,
* and joins it before exec so the target and every descendant are accounted and
* bounded. The parent later writes `cgroup.kill` to reap the whole tree —
* cleanup a plain `kill(pid)` cannot guarantee.
*
* "Delegated" means a subtree fino may write to whose `cgroup.subtree_control`
* enables the controllers a policy needs: `FINO_SANDBOX_CGROUP_ROOT`, or the
* process's own cgroup when that is the (writable) root. Where a controller is
* not delegated, `memory`/`pids` fall back to rlimits and `cpu` is rejected
* before spawn — there is no rlimit equivalent for a fractional CPU quota.
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
* Resolve a cgroup v2 subtree fino may create leaf cgroups under, or `null`.
*
* Order: `FINO_SANDBOX_CGROUP_ROOT`, then the process's own cgroup if it is the
* root cgroup. A non-root leaf holding processes cannot also delegate
* controllers to children (the "no internal processes" rule), so only the root
* case is auto-detected; anything else must be delegated explicitly.
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
* The controllers a leaf under the delegated root can actually use. Attempts a
* best-effort enable of the wanted controllers in the root's
* `cgroup.subtree_control` first (fino owns the root in the root-cgroup case),
* then reports what is delegated. Empty when there is no delegated root.
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
/** True when `cpu` can be enforced via a delegated cgroup — used to gate the cpu policy. */
export function cgroupCpuAvailable(): boolean {
  return usableControllers().has('cpu');
}
/** Result of creating and joining a per-spawn cgroup. */
export interface CgroupResult {
  path: string;
  installed: Array<'memoryBytes' | 'pids' | 'cpu'>;
  /** Resource categories the cgroup could not enforce; the caller must fall back. */
  unhandled: Array<'memoryBytes' | 'pids'>;
}
/**
* Create a per-spawn leaf cgroup under `root`, apply the resource limits whose
* controllers are delegated, and move the current process into it so the exec'd
* target inherits membership. Limits whose controller is missing are returned in
* `unhandled` for rlimit fallback. Throws only on structural failures (mkdir /
* join) so strict mode fails closed when the cgroup itself is unusable.
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
* Kill every process in the spawn's cgroup and remove it. Called by the parent
* during `wait()`/`kill()` teardown. Safe to call repeatedly and after the tree
* has already exited.
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
