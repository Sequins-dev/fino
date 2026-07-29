/**
 * internal:security/sandbox/realm — install a strict Linux policy on a
 * dedicated sandbox Realm thread.
 *
 * The parent creates a fresh V8 isolate on a fixed OS thread. Bootstrap calls
 * this module before importing user code. Preparation is reversible and runs
 * first; enforcement then follows the required order: join a cgroup v2
 * threaded leaf, apply Landlock to the calling thread, and install seccomp
 * last. Landlock and seccomp are inherited by descendants, while ordinary
 * Realm workloads on other threads remain unaffected.
 *
 * A sandbox Realm still shares process memory and inherited descriptors with
 * its parent. This mechanism governs cooperative in-process workloads; it is
 * not a hostile-code security boundary.
 *
 * References:
 *
 * - https://docs.kernel.org/admin-guide/cgroup-v2.html#threads
 * - https://docs.kernel.org/userspace-api/landlock.html
 * - https://docs.kernel.org/userspace-api/seccomp_filter.html
 *
 * @internal
 */
import { setSandboxCgroupPath } from 'internal:realm-bridge';
import {
  createAndJoinThreadedCgroup,
  resolveThreadedCgroupRoot,
  usableThreadedControllers,
} from './cgroup.ts';
import { installLandlock, landlockAvailable } from './landlock.ts';
import {
  planSeccomp,
  syscallNumber,
  type ResourcePolicy,
  type SandboxPolicy,
  type SeccompPlan,
} from './plan.ts';
import { installPreparedSeccomp, prepareSeccomp, seccompAvailable } from './seccomp.ts';

type RealmSandboxPolicy = Omit<SandboxPolicy, 'resources'> & {
  resources?: ResourcePolicy & {
    cpus?: string;
  };
};

function validatePositive(value: number | undefined, name: string, integer = false): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? 'integer' : 'finite number'}`);
  }
}

function validatePolicy(policy: RealmSandboxPolicy): void {
  if (policy.mode !== 'strict') throw new Error('sandbox Realm policy must use strict mode');
  validatePositive(policy.resources?.cpu, 'sandbox.resources.cpu');
  validatePositive(policy.resources?.pids, 'sandbox.resources.pids', true);
  if (
    policy.resources?.cpus !== undefined &&
    (typeof policy.resources.cpus !== 'string' ||
      !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(policy.resources.cpus))
  ) {
    throw new Error('sandbox.resources.cpus must use the Linux CPU list format, for example 0-3,6');
  }
  if (policy.resources?.memoryBytes !== undefined) {
    throw new Error('sandbox.resources.memoryBytes cannot be scoped to a Realm thread');
  }
  for (const [name, paths] of [
    ['writable', policy.filesystem?.writable],
    ['readonly', policy.filesystem?.readonly],
  ] as const) {
    for (const path of paths ?? []) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
        throw new Error(`sandbox.filesystem.${name} entries must be absolute paths`);
      }
    }
  }
  for (const name of policy.syscalls?.names ?? []) {
    if (syscallNumber(name) === undefined) {
      throw new Error(`unsupported syscall in sandbox Realm policy: ${name}`);
    }
  }
  if (policy.filesystem !== undefined && !landlockAvailable()) {
    throw new Error('sandbox Realm filesystem policy requires the Landlock LSM');
  }
  if (!seccompAvailable()) {
    throw new Error('sandbox Realms require Linux seccomp support');
  }
  if (policy.resources !== undefined) {
    const root = resolveThreadedCgroupRoot();
    if (root === null) {
      throw new Error(
        "sandbox Realm resources require the host process's current cgroup v2 domain to be writable and delegated",
      );
    }
    const controllers = usableThreadedControllers();
    if (policy.resources.cpu !== undefined && !controllers.has('cpu')) {
      throw new Error('sandbox Realm resources.cpu requires a delegated threaded cpu controller');
    }
    if (policy.resources.pids !== undefined && !controllers.has('pids')) {
      throw new Error('sandbox Realm resources.pids requires a delegated threaded pids controller');
    }
    if (policy.resources.cpus !== undefined && !controllers.has('cpuset')) {
      throw new Error(
        'sandbox Realm resources.cpus requires a delegated threaded cpuset controller',
      );
    }
  }
}

function realmSeccompPlan(policy: RealmSandboxPolicy): SeccompPlan {
  const base = planSeccomp({
    ...policy,
    process: {
      ...policy.process,
      allowFork: false,
      allowExec: false,
      allowedBinaries: [],
    },
  });
  const forbidden = new Set(['clone', 'clone3', 'fork', 'vfork', 'execve', 'execveat']);
  if (base.defaultAction === 'kill') {
    return {
      defaultAction: 'errno',
      rules: base.rules.filter((rule) => rule.action === 'allow' && !forbidden.has(rule.syscall)),
    };
  }
  const rules = base.rules.filter((rule) => !forbidden.has(rule.syscall));
  for (const syscall of forbidden) {
    if (syscallNumber(syscall) !== undefined) rules.push({ syscall, action: 'errno' });
  }
  return { defaultAction: base.defaultAction, rules };
}

/**
 * Install `policy` on the calling sandbox Realm thread.
 */
export function installSandboxRealmPolicy(policy: RealmSandboxPolicy): void {
  validatePolicy(policy);
  const preparedSeccomp = prepareSeccomp(realmSeccompPlan(policy));
  if (policy.resources !== undefined) {
    const root = resolveThreadedCgroupRoot();
    if (root === null) throw new Error('sandbox Realm cgroup delegation disappeared');
    const cgroup = createAndJoinThreadedCgroup(root, policy.resources);
    (setSandboxCgroupPath as (path: string) => void)(cgroup.path);
  }
  installLandlock(policy.filesystem, undefined, '');
  installPreparedSeccomp(preparedSeccomp);
}
