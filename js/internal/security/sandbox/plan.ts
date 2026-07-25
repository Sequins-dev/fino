/**
* internal:security/sandbox/plan — translate a requested sandbox policy into
* concrete, mechanism-shaped plans.
*
* Pure logic, no FFI: it turns the JSON policy into a seccomp plan, an
* architecture-resolved syscall number, and a coarse network decision. The
* launcher consumes these plans inside the sandboxed child; the parent uses the
* same functions for pre-spawn rejection so both sides agree on what a policy
* means. Because everything here is a deterministic function of the policy
* object, both processes reach identical conclusions without sharing state.
*
* The module is deliberately mechanism-agnostic at its edges: it emits the
* `SeccompPlan` that `internal:security/sandbox/seccomp` compiles into a BPF
* filter, resolves the per-architecture syscall numbers that same compiler
* needs, and answers the yes/no allowlist question that `spawn` asks before it
* ever forks. Keeping this translation in one place means a policy is
* interpreted exactly once, consistently, on every code path.
*
* This is an internal module, importable only by other built-ins. The public
* entry point is the `sandbox` option on the process-spawning API in
* `js/process.ts`, which is where the `SandboxPolicy` shape originates.
*
* ```ts no_run
*   import { planSeccomp, checkInitialCommand } from 'internal:security/sandbox/plan';
*
*   const policy = {
*     mode: 'strict' as const,
*     process: { allowFork: false, allowedBinaries: ['node'] },
*     network: { outbound: [] },
*   };
*
*   // Reject a disallowed binary before spawning anything.
*   const err = checkInitialCommand(policy.process, '/usr/bin/curl');
*   if (err !== null) throw new Error(err);
*
*   // Compile the seccomp plan the launcher will install in the child.
*   const plan = planSeccomp(policy);
*   // plan.defaultAction === 'allow'; fork and network syscalls are EPERM'd.
* ```
*
* @internal
*/
import { arch } from 'internal:process';
/**
* Requested resource ceilings for the sandboxed process.
*
* Every field is optional; an omitted field means "do not constrain this
* dimension". These are the caller's wishes, not enforced values — the launcher
* maps them onto cgroup limits and rlimits on Linux, and does the best it can
* elsewhere. This module carries the shape but does not itself apply the limits.
*
* ```ts no_run
*   import type { ResourcePolicy } from 'internal:security/sandbox/plan';
*
*   const limits: ResourcePolicy = {
*     memoryBytes: 512 * 1024 * 1024, // 512 MiB cap
*     pids: 64,                       // at most 64 tasks
*     cpu: 2,                         // 2 CPU-seconds of quota
*   };
* ```
*/
export interface ResourcePolicy {
  /** Maximum resident/committed memory in bytes; omit for no memory cap. */
  memoryBytes?: number;
  /** Maximum number of processes/threads (tasks) the sandbox may spawn. */
  pids?: number;
  /** CPU quota, expressed in CPU-seconds; omit for no CPU limit. */
  cpu?: number;
}
/**
* Requested filesystem visibility for the sandboxed process.
*
* Paths listed under `readonly` are mountable/openable for reading only; paths
* under `writable` also permit writes. On Linux the launcher realizes this as a
* Landlock ruleset; anything not covered by either list is inaccessible under a
* strict policy. Omitting both fields grants no filesystem access beyond what
* the sandbox mechanism allows by default.
*
* ```ts no_run
*   import type { FilesystemPolicy } from 'internal:security/sandbox/plan';
*
*   const fs: FilesystemPolicy = {
*     readonly: ['/usr', '/lib'],
*     writable: ['/tmp/work'],
*   };
* ```
*/
export interface FilesystemPolicy {
  /** Directory subtrees the sandbox may read from but not modify. */
  readonly?: string[];
  /** Directory subtrees the sandbox may both read and write. */
  writable?: string[];
}
/**
* A single directional network rule.
*
* A rule either allows or denies traffic, optionally narrowed to a
* destination, port, and protocol. Rules are grouped by direction in
* `NetworkPolicy`. Note that the seccomp layer produced by this module is
* coarse — it only distinguishes "some traffic is allowed" from "no traffic is
* allowed" (see `networkAllowsNetwork`); the `destination`/`port`/`protocol`
* fields are honored by finer-grained enforcement, not by the syscall filter.
*
* ```ts no_run
*   import type { NetworkRule } from 'internal:security/sandbox/plan';
*
*   const allowHttps: NetworkRule = {
*     action: 'allow',
*     destination: 'api.example.com',
*     port: 443,
*     protocol: 'tcp',
*   };
* ```
*/
export interface NetworkRule {
  /** Whether traffic matching this rule is permitted or blocked. */
  action: 'allow' | 'deny';
  /** Optional host or address the rule applies to; omit to match any destination. */
  destination?: string;
  /** Optional port the rule applies to; omit to match any port. */
  port?: number;
  /** Optional transport the rule applies to; omit to match any protocol. */
  protocol?: 'tcp' | 'udp';
}
/**
* Requested network policy, split by traffic direction.
*
* A present-but-empty direction array (for example `outbound: []`) is
* meaningful: it signals that network was considered and left with no allow
* rules, which causes `planSeccomp` to EPERM the socket syscalls. Leaving the
* whole `NetworkPolicy` undefined instead means "network was not constrained"
* and no network syscalls are filtered.
*
* ```ts no_run
*   import type { NetworkPolicy } from 'internal:security/sandbox/plan';
*
*   // Deny all network by declaring the policy with no allow rules.
*   const noNetwork: NetworkPolicy = { outbound: [], inbound: [] };
* ```
*/
export interface NetworkPolicy {
  /** Rules governing connections initiated by the sandbox. */
  outbound?: NetworkRule[];
  /** Rules governing connections accepted by the sandbox. */
  inbound?: NetworkRule[];
}
/**
* Requested process-creation policy.
*
* Controls whether the sandbox may fork/clone new tasks, exec new images, and
* which binaries it is allowed to launch. `allowFork: false` drives
* `planSeccomp` to EPERM the fork family of syscalls; `allowedBinaries` drives
* the pre-spawn `checkInitialCommand` check.
*
* ```ts no_run
*   import type { ProcessPolicy } from 'internal:security/sandbox/plan';
*
*   const proc: ProcessPolicy = {
*     allowedBinaries: ['node', 'python3'],
*     allowFork: false,
*     allowExec: true,
*   };
* ```
*/
export interface ProcessPolicy {
  /** Binaries the initial command may be, matched by full path or basename; omit or empty to allow any. */
  allowedBinaries?: string[];
  /** When `false`, the fork/clone syscall family is denied; omit to leave forking unconstrained. */
  allowFork?: boolean;
  /** When `false`, exec of a new program image is denied; omit to leave exec unconstrained. */
  allowExec?: boolean;
}
/**
* Requested syscall policy: an allowlist or denylist of syscall names.
*
* In `allowlist` mode only the named syscalls are permitted and everything else
* kills the process. In `denylist` mode the named syscalls return EPERM over an
* otherwise permissive default. `names` are the same architecture-independent
* names accepted by `syscallNumber`.
*
* ```ts no_run
*   import type { SyscallPolicy } from 'internal:security/sandbox/plan';
*
*   const deny: SyscallPolicy = { mode: 'denylist', names: ['ptrace', 'bpf'] };
* ```
*/
export interface SyscallPolicy {
  /** Whether `names` enumerates the only-allowed syscalls or the blocked ones. */
  mode: 'allowlist' | 'denylist';
  /** Syscall names the mode applies to (see `syscallNumber` for resolvable names). */
  names: string[];
}
/**
* The full requested sandbox policy passed to the launcher.
*
* This is the top-level object produced from the public `sandbox` spawn option
* and consumed by every function in this module. `mode` selects the overall
* posture: `strict` treats an unenforceable request as a hard failure, while
* `bestEffort` degrades gracefully on platforms lacking a mechanism. All the
* dimension-specific sub-policies are optional and independently interpreted.
*
* ```ts no_run
*   import type { SandboxPolicy } from 'internal:security/sandbox/plan';
*
*   const policy: SandboxPolicy = {
*     mode: 'strict',
*     resources: { memoryBytes: 256 * 1024 * 1024, pids: 32 },
*     filesystem: { readonly: ['/usr'], writable: ['/tmp/job'] },
*     network: { outbound: [] },
*     process: { allowedBinaries: ['node'], allowFork: false },
*     syscalls: { mode: 'denylist', names: ['ptrace'] },
*   };
* ```
*/
export interface SandboxPolicy {
  /** Enforcement posture: fail hard (`strict`) or degrade gracefully (`bestEffort`). */
  mode: 'strict' | 'bestEffort';
  /** Optional resource ceilings (memory, task count, CPU). */
  resources?: ResourcePolicy;
  /** Optional filesystem visibility rules. */
  filesystem?: FilesystemPolicy;
  /** Optional network rules; present-but-empty means "deny all network". */
  network?: NetworkPolicy;
  /** Optional process-creation and binary-allowlist rules. */
  process?: ProcessPolicy;
  /** Optional explicit syscall allowlist/denylist. */
  syscalls?: SyscallPolicy;
}
/**
* A single seccomp match: apply `action` when the running syscall is `syscall`.
*
* `allow` lets the syscall proceed; `errno` makes it fail with EPERM instead of
* running. Rules override the plan's `defaultAction` for the named syscall. The
* `syscall` name is resolved to a per-architecture number by the seccomp
* compiler via `syscallNumber`; a name with no number on the current arch is
* silently skipped when the BPF filter is built.
*
* ```ts no_run
*   import type { SeccompRule } from 'internal:security/sandbox/plan';
*
*   const blockPtrace: SeccompRule = { syscall: 'ptrace', action: 'errno' };
* ```
*/
export interface SeccompRule {
  /** Architecture-independent syscall name this rule matches. */
  syscall: string;
  /** Outcome when the syscall is invoked: proceed (`allow`) or fail with EPERM (`errno`). */
  action: 'allow' | 'errno';
}
/**
* A compiled seccomp plan: a default action plus per-syscall overrides.
*
* This is the mechanism-shaped output of `planSeccomp` and the input to the
* BPF compiler in `internal:security/sandbox/seccomp`. `defaultAction` governs
* any syscall not named in `rules`: `allow` permits it, `kill` terminates the
* process, and `none` installs no filter at all. In practice `planSeccomp`
* emits `allow` (denylist/unconstrained) or `kill` (allowlist); `none` exists
* for callers that want to represent "no filtering".
*
* ```ts no_run
*   import { planSeccomp } from 'internal:security/sandbox/plan';
*   import type { SeccompPlan } from 'internal:security/sandbox/plan';
*
*   const plan: SeccompPlan = planSeccomp({
*     mode: 'strict',
*     syscalls: { mode: 'allowlist', names: ['read', 'write', 'exit_group'] },
*   });
*   // plan.defaultAction === 'kill'; anything unlisted terminates the process.
* ```
*/
export interface SeccompPlan {
  /** Action for syscalls not matched by any rule: permit, kill the process, or install no filter. */
  defaultAction: 'allow' | 'kill' | 'none';
  /** Per-syscall overrides layered on top of `defaultAction`. */
  rules: SeccompRule[];
}
const X86_64_SYSCALLS: Record<string, number> = {
  kill: 62,
  getpid: 39,
  ptrace: 101,
  bpf: 321,
  clone: 56,
  clone3: 435,
  fork: 57,
  vfork: 58,
  socket: 41,
  connect: 42,
  accept: 43,
  sendto: 44,
  recvfrom: 45,
  socketpair: 53,
  bind: 49,
  listen: 50,
  accept4: 288,
  exit_group: 231
};
const AARCH64_SYSCALLS: Record<string, number> = {
  kill: 129,
  getpid: 172,
  ptrace: 117,
  bpf: 280,
  clone: 220,
  clone3: 435,
  socket: 198,
  socketpair: 199,
  bind: 200,
  listen: 201,
  accept: 202,
  connect: 203,
  sendto: 206,
  recvfrom: 207,
  accept4: 242,
  exit_group: 94
};
const SYSCALL_TABLE = arch === 'arm64' || arch === 'aarch64' ? AARCH64_SYSCALLS : X86_64_SYSCALLS;
/**
* Resolve a Linux syscall number for the current architecture, or `undefined`.
*
* The module carries a small table of the syscalls the sandbox actually filters
* (the kill/trace, fork, and network families plus `exit_group`), keyed by the
* architecture-independent name. The correct table is chosen once at load time
* from `arch`: aarch64/arm64 numbers differ from x86_64, and some names (for
* example `fork`/`vfork`) do not exist on aarch64 at all and therefore resolve
* to `undefined`. Returns `undefined` for any name not in the current table so
* the seccomp compiler can skip syscalls that have no number on this arch.
*
* ```ts no_run
*   import { syscallNumber } from 'internal:security/sandbox/plan';
*
*   syscallNumber('ptrace');  // number on both x86_64 and aarch64
*   syscallNumber('fork');    // number on x86_64, undefined on aarch64
*   syscallNumber('nonesuch'); // undefined
* ```
*/
export function syscallNumber(name: string): number | undefined {
  return SYSCALL_TABLE[name];
}
function forkSyscallNames(): string[] {
  return arch === 'arm64' || arch === 'aarch64' ? ['clone', 'clone3'] : [
    'clone',
    'clone3',
    'fork',
    'vfork'
  ];
}
function networkSyscallNames(): string[] {
  return [
    'socket',
    'socketpair',
    'connect',
    'bind',
    'listen',
    'accept',
    'accept4',
    'sendto',
    'recvfrom'
  ];
}
/**
* True when the network policy leaves at least one directional allow rule.
*
* This is the coarse yes/no decision the seccomp layer is built on: if any
* inbound or outbound rule has `action: 'allow'`, the socket syscalls stay
* open; otherwise `planSeccomp` EPERMs them. An `undefined` policy returns
* `false` here, but note `planSeccomp` only filters network syscalls when the
* policy is *present* and denies everything — an undefined policy means network
* was never constrained, so no network filtering is applied.
*
* ```ts no_run
*   import { networkAllowsNetwork } from 'internal:security/sandbox/plan';
*
*   networkAllowsNetwork(undefined);                           // false
*   networkAllowsNetwork({ outbound: [] });                    // false
*   networkAllowsNetwork({ outbound: [{ action: 'allow' }] });  // true
*   networkAllowsNetwork({ outbound: [{ action: 'deny' }] });   // false
* ```
*/
export function networkAllowsNetwork(policy: NetworkPolicy | undefined): boolean {
  if (policy === undefined) return false;
  const anyAllow = (rules: NetworkRule[] | undefined): boolean => (rules ?? []).some((rule) => rule.action === 'allow');
  return anyAllow(policy.outbound) || anyAllow(policy.inbound);
}
function pushUnique(rules: SeccompRule[], syscall: string, action: 'allow' | 'errno'): void {
  if (!rules.some((rule) => rule.syscall === syscall && rule.action === action)) {
    rules.push({
      syscall,
      action
    });
  }
}
/**
* Build the seccomp plan for a policy, mirroring the previous native
* `plan_seccomp`.
*
* The syscall policy sets the base: `allowlist` mode kills on anything unlisted
* (default action `kill`, listed names allowed), `denylist` mode EPERMs the
* listed names over a default-allow tail, and no syscall policy yields a bare
* default-allow plan. Two coarse denials then layer on, but only when the base
* is default-allow (allowlist mode already kills everything unlisted, so it
* needs no extra rules): if `process.allowFork === false`, the fork family
* (`clone`/`clone3`, plus `fork`/`vfork` on x86_64) is EPERM'd — and in
* allowlist mode those names are instead stripped from the allow set so they
* fall through to the kill default. If a network policy is present but allows
* nothing (`networkAllowsNetwork` is false), the socket syscall family is
* EPERM'd. Overrides are de-duplicated, so overlapping requests never produce
* redundant rules.
*
* ```ts no_run
*   import { planSeccomp } from 'internal:security/sandbox/plan';
*
*   // Default-allow base with fork and network locked down.
*   const plan = planSeccomp({
*     mode: 'strict',
*     process: { allowFork: false },
*     network: { outbound: [] },
*   });
*   // plan.defaultAction === 'allow'
*   // plan.rules includes { syscall: 'clone', action: 'errno' } and
*   // { syscall: 'connect', action: 'errno' }, among others.
* ```
*/
export function planSeccomp(policy: SandboxPolicy): SeccompPlan {
  const syscalls = policy.syscalls;
  const noFork = policy.process?.allowFork === false;
  let plan: SeccompPlan;
  if (syscalls?.mode === 'allowlist') {
    let rules: SeccompRule[] = syscalls.names.map((syscall) => ({
      syscall,
      action: 'allow' as const
    }));
    if (noFork) {
      const fork = new Set(forkSyscallNames());
      rules = rules.filter((rule) => !fork.has(rule.syscall));
    }
    plan = {
      defaultAction: 'kill',
      rules
    };
  } else if (syscalls?.mode === 'denylist') {
    plan = {
      defaultAction: 'allow',
      rules: syscalls.names.map((syscall) => ({
        syscall,
        action: 'errno' as const
      }))
    };
  } else {
    plan = {
      defaultAction: 'allow',
      rules: []
    };
  }
  if (noFork && plan.defaultAction === 'allow') {
    for (const syscall of forkSyscallNames()) pushUnique(plan.rules, syscall, 'errno');
  }
  if (!networkAllowsNetwork(policy.network) && policy.network !== undefined && plan.defaultAction === 'allow') {
    for (const syscall of networkSyscallNames()) pushUnique(plan.rules, syscall, 'errno');
  }
  return plan;
}
/**
* True when `command` matches `allowed` exactly or by basename.
*
* A match succeeds if the full command string equals the allowlist entry, or if
* the final path component of `command` (everything after the last `/`) equals
* the entry. This lets an allowlist entry of `node` accept `/usr/bin/node`
* while an entry of `/usr/bin/node` matches only that exact path. Matching is
* case-sensitive and does not resolve symlinks or normalize `.`/`..`.
*
* ```ts no_run
*   import { commandMatchesAllowed } from 'internal:security/sandbox/plan';
*
*   commandMatchesAllowed('/usr/bin/node', 'node');          // true (basename)
*   commandMatchesAllowed('/usr/bin/node', '/usr/bin/node'); // true (exact)
*   commandMatchesAllowed('/opt/node', '/usr/bin/node');     // false
* ```
*/
export function commandMatchesAllowed(command: string, allowed: string): boolean {
  if (command === allowed) return true;
  const base = command.slice(command.lastIndexOf('/') + 1);
  return base === allowed;
}
/**
* Pre-spawn allowlist check for the initial binary.
*
* Returns `null` when the command is permitted and a human-readable error
* message when it is not. The check passes trivially — returning `null` — when
* there is no process policy, no `allowedBinaries` list, or an empty one; an
* allowlist only takes effect once it has at least one entry. Otherwise the
* command must match some entry via `commandMatchesAllowed` (exact path or
* basename). The caller (`spawn`) turns a non-null return into a spawn failure
* before the child is ever created, so a disallowed binary never runs.
*
* ```ts no_run
*   import { checkInitialCommand } from 'internal:security/sandbox/plan';
*
*   const proc = { allowedBinaries: ['node'] };
*   checkInitialCommand(proc, '/usr/bin/node'); // null (allowed)
*   checkInitialCommand(proc, '/usr/bin/curl');
*   // "command '/usr/bin/curl' is not listed in process.allowedBinaries"
*   checkInitialCommand(undefined, '/bin/sh');  // null (no allowlist)
* ```
*/
export function checkInitialCommand(policy: ProcessPolicy | undefined, command: string): string | null {
  const allowed = policy?.allowedBinaries;
  if (allowed === undefined || allowed.length === 0) return null;
  if (allowed.some((entry) => commandMatchesAllowed(command, entry))) return null;
  return `command '${command}' is not listed in process.allowedBinaries`;
}
