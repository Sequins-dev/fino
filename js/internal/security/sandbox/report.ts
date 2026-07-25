/**
* internal:security/sandbox/report — derive a sandbox report from the
* mechanisms the launcher actually installed, never from which option keys were
* present.
*
* The trust rule this module enforces is that a report describes what the host
* did, not what the caller asked for. A policy can request a filesystem jail,
* but if the running kernel lacks Landlock the launcher installs nothing, and
* the report must say so rather than implying protection that is not there.
* Building the report from installed-mechanism records instead of from the
* policy object is what keeps `securityBoundary` honest.
*
* Each launcher apply-step contributes an {@link InstalledMechanism} record.
* {@link buildReport} turns the requested policy plus those records into the
* {@link SandboxReport} shape (the internal source of the public
* `ProcessSandboxReport` a spawned process exposes): `enforced` comes only from
* records, `unsupported` is everything requested but not installed, `supported`
* lists what the backend could enforce on this host, and `securityBoundary` is
* true only for a strict spawn where every requested category was actually
* installed. A best-effort spawn is never a boundary regardless of what got
* installed.
*
* ```ts no_run
*   import { buildReport } from 'internal:security/sandbox/report';
*   import type { InstalledMechanism } from 'internal:security/sandbox/report';
*
*   const installed: InstalledMechanism[] = [
*     { category: 'filesystem', mechanism: 'landlock', tier: 'abi4' },
*     { category: 'resources', mechanism: 'rlimit' }
*   ];
*
*   const report = buildReport(
*     { mode: 'strict', filesystem: { readonly: ['/etc'] }, resources: { pids: 64 } },
*     installed,
*     'linuxNative',
*     ['filesystem', 'resources', 'network']
*   );
*
*   report.securityBoundary; // true: every requested category was installed
*   report.enforced;         // [{ category: 'filesystem', ... }, { category: 'resources', ... }]
* ```
*
* @internal
*/
import type { SandboxPolicy } from './plan.ts';
/**
* The five policy dimensions a sandbox can constrain.
*
* Each value names one axis of a {@link SandboxPolicy}: `resources` (memory,
* pids, CPU), `filesystem` (path access), `network` (connectivity), `process`
* (spawning and forking), and `syscalls` (the raw kernel surface). A report is
* organized category-by-category, so these are the keys under which enforcement,
* support, and violation behavior are grouped.
*/
export type SandboxCategory = 'resources' | 'filesystem' | 'network' | 'process' | 'syscalls';
/**
* The concrete OS-level mechanisms a launcher can install to enforce a category.
*
* These are the actual kernel or libc facilities, not the abstract categories:
* `landlock` and `seccomp` are Linux LSM/BPF filters, `rlimit` is POSIX resource
* limits, `cgroup` is Linux cgroup v2, `seatbelt` is the macOS sandbox profile,
* `processGroup` and `pidNamespace` bound process lifetime, and `commandCheck` is
* the spawn-time binary allowlist. The mechanism chosen for a category determines
* both its diagnostic reason (see {@link buildReport}) and its
* violation behavior — for example a `seccomp` breach yields `EPERM` while a
* `pidNamespace` breach kills the process.
*/
export type SandboxMechanism = 'landlock' | 'seccomp' | 'rlimit' | 'cgroup' | 'seatbelt' | 'processGroup' | 'pidNamespace' | 'commandCheck';
/**
* One mechanism the launcher actually installed against one policy category.
*
* The launcher emits these records as it applies each step, and they are the
* sole evidence {@link buildReport} trusts: a category with no record is treated
* as unenforced even if the policy requested it. When several mechanisms cover
* the same category only the first record wins, so launchers should emit the
* primary enforcing mechanism first.
*
* ```ts no_run
*   import type { InstalledMechanism } from 'internal:security/sandbox/report';
*
*   const record: InstalledMechanism = {
*     category: 'syscalls',
*     mechanism: 'seccomp',
*     tier: 'strict',
*     detail: 'denylist of 12 syscalls'
*   };
* ```
*/
export interface InstalledMechanism {
  /** The policy dimension this mechanism enforces. */
  category: SandboxCategory;
  /** The concrete OS facility that was installed. */
  mechanism: SandboxMechanism;
  /** Optional grade label (e.g. a Landlock ABI level) surfaced into diagnostics. */
  tier?: string;
  /** Optional human-readable qualifier appended in parentheses to the reason string. */
  detail?: string;
}
/** A category paired with a human-readable explanation, used for the report's support/enforcement lists. */
interface Capability {
  category: SandboxCategory;
  reason: string;
}
/** How a category responds when its boundary is crossed: kill the process, return `EPERM`, deny the spawn, or only audit. */
interface ViolationBehavior {
  category: SandboxCategory;
  behavior: 'kill' | 'eperm' | 'denySpawn' | 'auditOnly';
  reason: string;
}
/**
* The full result of {@link buildReport}: an honest account of what the sandbox
* did to a spawned process.
*
* This is the internal shape that backs the public `ProcessSandboxReport` exposed
* on a spawned process. It separates three distinct facts that are easy to
* conflate: what the backend *could* enforce on this host (`supported`), what it
* *actually* enforced for this spawn (`enforced`), and what was asked for but
* left uncovered (`unsupported`). Reading `securityBoundary` alone is enough to
* know whether the sandbox is trustworthy; the lists explain why.
*
* ```ts no_run
*   import { buildReport } from 'internal:security/sandbox/report';
*   import type { SandboxReport } from 'internal:security/sandbox/report';
*
*   const report: SandboxReport = buildReport(
*     { mode: 'strict', network: { outbound: [{ action: 'deny' }] } },
*     [],
*     'linuxNative',
*     ['filesystem']
*   );
*
*   report.securityBoundary;   // false: network was requested but nothing enforced it
*   report.unsupported[0];     // { category: 'network', reason: '...requested but no mechanism enforced it' }
* ```
*/
export interface SandboxReport {
  /** The requested enforcement mode; `bestEffort` reports are never a security boundary. */
  mode: 'strict' | 'bestEffort';
  /** Which platform backend produced this report. */
  backend: 'linuxNative' | 'macosSeatbelt';
  /** True only for a strict spawn where every requested category was actually installed (or none was requested). */
  securityBoundary: boolean;
  /** Categories the backend is capable of enforcing on this host, independent of what was requested. */
  supported: Capability[];
  /** Categories that actually received an installed mechanism for this spawn. */
  enforced: Capability[];
  /** Categories the policy requested but for which no mechanism was installed. */
  unsupported: Capability[];
  /** One human-readable line per enforced category, including any tier label. */
  diagnostics: string[];
  /** The runtime consequence of crossing each enforced category's boundary. */
  violationBehavior: ViolationBehavior[];
}
function requestedCategories(policy: SandboxPolicy): SandboxCategory[] {
  const categories: SandboxCategory[] = [];
  if (policy.resources !== undefined) categories.push('resources');
  if (policy.filesystem !== undefined) categories.push('filesystem');
  if (policy.network !== undefined) categories.push('network');
  if (policy.process !== undefined) categories.push('process');
  if (policy.syscalls !== undefined) categories.push('syscalls');
  return categories;
}
const MECHANISM_REASON: Record<SandboxMechanism, string> = {
  landlock: 'Linux Landlock path-beneath rules',
  seccomp: 'Linux seccomp-BPF filter',
  rlimit: 'POSIX resource limits',
  cgroup: 'Linux cgroup v2 controllers',
  seatbelt: 'macOS Seatbelt profile',
  processGroup: 'POSIX process group',
  pidNamespace: 'Linux PID namespace',
  commandCheck: 'spawn-time binary allowlist check'
};
const VIOLATION: Record<SandboxMechanism, ViolationBehavior['behavior']> = {
  landlock: 'eperm',
  seccomp: 'eperm',
  rlimit: 'eperm',
  cgroup: 'eperm',
  seatbelt: 'eperm',
  processGroup: 'kill',
  pidNamespace: 'kill',
  commandCheck: 'denySpawn'
};
/**
* Build a {@link SandboxReport} from the requested policy and the records the
* launcher returned.
*
* Enforcement is derived entirely from `installed`: the first record for each
* category wins, becomes an `enforced` entry with a reason drawn from its
* mechanism (plus any `detail`), and contributes a `violationBehavior` and a
* `diagnostics` line. Every requested category with no matching record lands in
* `unsupported`. `supported` is built independently from `supportedCategories`,
* describing host capability rather than this spawn's outcome, so a category can
* be supported yet unsupported-for-this-spawn if the launcher skipped it.
*
* `securityBoundary` is true only when `policy.mode` is `'strict'` and either
* every requested category was enforced, or nothing was requested at all. A
* best-effort policy always yields `false`, as does any strict policy with a
* gap in `unsupported`.
*
* ```ts no_run
*   import { buildReport } from 'internal:security/sandbox/report';
*
*   // Strict, but the launcher could not install the syscall filter:
*   const report = buildReport(
*     { mode: 'strict', syscalls: { mode: 'denylist', names: ['ptrace'] } },
*     [], // no records → nothing enforced
*     'linuxNative',
*     ['syscalls']
*   );
*
*   report.securityBoundary; // false
*   report.unsupported;      // [{ category: 'syscalls', reason: '...' }]
* ```
*/
export function buildReport(
  policy: SandboxPolicy,
  installed: InstalledMechanism[],
  backend: 'linuxNative' | 'macosSeatbelt',
  supportedCategories: SandboxCategory[]
): SandboxReport {
  const enforcedByCategory = new Map<SandboxCategory, InstalledMechanism>();
  for (const record of installed) {
    if (!enforcedByCategory.has(record.category)) enforcedByCategory.set(record.category, record);
  }
  const enforced: Capability[] = [];
  const violationBehavior: ViolationBehavior[] = [];
  const diagnostics: string[] = [];
  for (const [category, record] of enforcedByCategory) {
    const base = MECHANISM_REASON[record.mechanism];
    const reason = record.detail ? `${base} (${record.detail})` : base;
    enforced.push({ category, reason });
    violationBehavior.push({ category, behavior: VIOLATION[record.mechanism], reason });
    diagnostics.push(`${category}: enforced by ${base}${record.tier ? ` [tier: ${record.tier}]` : ''}`);
  }
  const requested = requestedCategories(policy);
  const unsupported: Capability[] = requested
    .filter((category) => !enforcedByCategory.has(category))
    .map((category) => ({ category, reason: `${category} policy was requested but no mechanism enforced it` }));
  const supported: Capability[] = supportedCategories.map((category) => ({
    category,
    reason: `${backend} can enforce ${category} policy on this host`
  }));
  const securityBoundary = policy.mode === 'strict' && unsupported.length === 0 && requested.length > 0
    ? true
    : policy.mode === 'strict' && requested.length === 0;
  return { mode: policy.mode, backend, securityBoundary, supported, enforced, unsupported, diagnostics, violationBehavior };
}
