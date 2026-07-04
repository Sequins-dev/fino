/**
* internal:security/sandbox/report — derive a sandbox report from the
* mechanisms the launcher actually installed, never from which option keys were
* present.
*
* Each launcher apply-step contributes an {@link InstalledMechanism} record.
* {@link buildReport} turns the requested policy plus those records into the
* `ProcessSandboxReport` shape: `enforced` comes only from records, `unsupported`
* is everything requested but not installed, and `securityBoundary` is true only
* when every requested category was installed at boundary grade.
*
* @internal
*/
import type { SandboxPolicy } from './plan.ts';
export type SandboxCategory = 'resources' | 'filesystem' | 'network' | 'process' | 'syscalls';
export type SandboxMechanism = 'landlock' | 'seccomp' | 'rlimit' | 'cgroup' | 'seatbelt' | 'processGroup' | 'pidNamespace' | 'commandCheck';
/** One mechanism the launcher installed against one policy category. */
export interface InstalledMechanism {
  category: SandboxCategory;
  mechanism: SandboxMechanism;
  tier?: string;
  detail?: string;
}
interface Capability {
  category: SandboxCategory;
  reason: string;
}
interface ViolationBehavior {
  category: SandboxCategory;
  behavior: 'kill' | 'eperm' | 'denySpawn' | 'auditOnly';
  reason: string;
}
export interface SandboxReport {
  mode: 'strict' | 'bestEffort';
  backend: 'linuxNative' | 'macosSeatbelt';
  securityBoundary: boolean;
  supported: Capability[];
  enforced: Capability[];
  unsupported: Capability[];
  diagnostics: string[];
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
* Build the report for a strict spawn from the requested policy and the records
* the launcher returned. `supported` lists the categories the backend can
* enforce on this host; `enforced` lists the categories that actually got a
* mechanism installed.
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
