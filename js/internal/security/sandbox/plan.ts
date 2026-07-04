/**
* internal:security/sandbox/plan — translate a requested sandbox policy into
* concrete, mechanism-shaped plans.
*
* Pure logic, no FFI: it turns the JSON policy into a seccomp plan, a Landlock
* path set, rlimit values, and a coarse network decision. The launcher consumes
* these plans; the parent uses the same functions for pre-spawn rejection so
* both sides agree on what a policy means.
*
* @internal
*/
import { arch } from 'internal:process';
/** Requested resource limits. */
export interface ResourcePolicy {
  memoryBytes?: number;
  pids?: number;
  cpu?: number;
}
/** Requested filesystem policy. */
export interface FilesystemPolicy {
  readonly?: string[];
  writable?: string[];
}
/** A single directional network rule. */
export interface NetworkRule {
  action: 'allow' | 'deny';
  destination?: string;
  port?: number;
  protocol?: 'tcp' | 'udp';
}
/** Requested network policy. */
export interface NetworkPolicy {
  outbound?: NetworkRule[];
  inbound?: NetworkRule[];
}
/** Requested process-creation policy. */
export interface ProcessPolicy {
  allowedBinaries?: string[];
  allowFork?: boolean;
  allowExec?: boolean;
}
/** Requested syscall policy. */
export interface SyscallPolicy {
  mode: 'allowlist' | 'denylist';
  names: string[];
}
/** The full requested policy passed to the launcher. */
export interface SandboxPolicy {
  mode: 'strict' | 'bestEffort';
  resources?: ResourcePolicy;
  filesystem?: FilesystemPolicy;
  network?: NetworkPolicy;
  process?: ProcessPolicy;
  syscalls?: SyscallPolicy;
}
/** A single seccomp match: apply `action` when the running syscall is `syscall`. */
export interface SeccompRule {
  syscall: string;
  action: 'allow' | 'errno';
}
/** A compiled seccomp plan: a default action plus per-syscall overrides. */
export interface SeccompPlan {
  defaultAction: 'allow' | 'kill' | 'none';
  rules: SeccompRule[];
}
const X86_64_SYSCALLS: Record<string, number> = {
  kill: 62, getpid: 39, ptrace: 101, bpf: 321, clone: 56, clone3: 435,
  fork: 57, vfork: 58, socket: 41, connect: 42, accept: 43, sendto: 44,
  recvfrom: 45, socketpair: 53, bind: 49, listen: 50, accept4: 288, exit_group: 231
};
const AARCH64_SYSCALLS: Record<string, number> = {
  kill: 129, getpid: 172, ptrace: 117, bpf: 280, clone: 220, clone3: 435,
  socket: 198, socketpair: 199, bind: 200, listen: 201, accept: 202,
  connect: 203, sendto: 206, recvfrom: 207, accept4: 242, exit_group: 94
};
const SYSCALL_TABLE = arch === 'arm64' || arch === 'aarch64' ? AARCH64_SYSCALLS : X86_64_SYSCALLS;
/** Resolve a Linux syscall number for the current architecture, or `undefined`. */
export function syscallNumber(name: string): number | undefined {
  return SYSCALL_TABLE[name];
}
function forkSyscallNames(): string[] {
  return arch === 'arm64' || arch === 'aarch64' ? ['clone', 'clone3'] : ['clone', 'clone3', 'fork', 'vfork'];
}
function networkSyscallNames(): string[] {
  return ['socket', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'accept4', 'sendto', 'recvfrom'];
}
/** True when the network policy leaves at least one directional allow rule. */
export function networkAllowsNetwork(policy: NetworkPolicy | undefined): boolean {
  if (policy === undefined) return false;
  const anyAllow = (rules: NetworkRule[] | undefined): boolean => (rules ?? []).some((rule) => rule.action === 'allow');
  return anyAllow(policy.outbound) || anyAllow(policy.inbound);
}
function pushUnique(rules: SeccompRule[], syscall: string, action: 'allow' | 'errno'): void {
  if (!rules.some((rule) => rule.syscall === syscall && rule.action === action)) {
    rules.push({ syscall, action });
  }
}
/**
* Build the seccomp plan for a policy, mirroring the previous native
* `plan_seccomp`: allowlist mode kills on anything unlisted, denylist mode
* EPERMs listed syscalls, and fork/coarse-network denial layer onto the
* default-allow base.
*/
export function planSeccomp(policy: SandboxPolicy): SeccompPlan {
  const syscalls = policy.syscalls;
  const noFork = policy.process?.allowFork === false;
  let plan: SeccompPlan;
  if (syscalls?.mode === 'allowlist') {
    let rules: SeccompRule[] = syscalls.names.map((syscall) => ({ syscall, action: 'allow' as const }));
    if (noFork) {
      const fork = new Set(forkSyscallNames());
      rules = rules.filter((rule) => !fork.has(rule.syscall));
    }
    plan = { defaultAction: 'kill', rules };
  } else if (syscalls?.mode === 'denylist') {
    plan = { defaultAction: 'allow', rules: syscalls.names.map((syscall) => ({ syscall, action: 'errno' as const })) };
  } else {
    plan = { defaultAction: 'allow', rules: [] };
  }
  if (noFork && plan.defaultAction === 'allow') {
    for (const syscall of forkSyscallNames()) pushUnique(plan.rules, syscall, 'errno');
  }
  if (!networkAllowsNetwork(policy.network) && policy.network !== undefined && plan.defaultAction === 'allow') {
    for (const syscall of networkSyscallNames()) pushUnique(plan.rules, syscall, 'errno');
  }
  return plan;
}
/** True when `command` matches `allowed` exactly or by basename. */
export function commandMatchesAllowed(command: string, allowed: string): boolean {
  if (command === allowed) return true;
  const base = command.slice(command.lastIndexOf('/') + 1);
  return base === allowed;
}
/**
* Pre-spawn allowlist check for the initial binary. Returns an error message
* when the command is not permitted, or `null` when it is (or no allowlist was
* requested).
*/
export function checkInitialCommand(policy: ProcessPolicy | undefined, command: string): string | null {
  const allowed = policy?.allowedBinaries;
  if (allowed === undefined || allowed.length === 0) return null;
  if (allowed.some((entry) => commandMatchesAllowed(command, entry))) return null;
  return `command '${command}' is not listed in process.allowedBinaries`;
}
