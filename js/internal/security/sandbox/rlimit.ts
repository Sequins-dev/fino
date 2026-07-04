/**
* internal:security/sandbox/rlimit — apply POSIX resource limits.
*
* Used both as the primary resource mechanism on macOS and as the honest
* fallback tier on Linux when no delegated cgroup is available.
*
* @internal
*/
import { libc, errno, RLIMIT_AS, RLIMIT_NPROC } from './ffi.ts';
import type { ResourcePolicy } from './plan.ts';
function setLimit(resource: number, value: number, label: string): void {
  // struct rlimit { rlim_t rlim_cur; rlim_t rlim_max; } — rlim_t is u64.
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(value), true);
  view.setBigUint64(8, BigInt(value), true);
  if (libc.symbols.setrlimit(resource, buf) !== 0) {
    throw new Error(`setrlimit(${label}) failed: errno ${errno()}`);
  }
}
/**
* Apply `memoryBytes` (RLIMIT_AS) and `pids` (RLIMIT_NPROC) from the policy.
* Returns the list of limits actually installed for the report.
*/
export function installRlimits(policy: ResourcePolicy): string[] {
  const installed: string[] = [];
  if (policy.memoryBytes !== undefined) {
    setLimit(RLIMIT_AS, policy.memoryBytes, 'RLIMIT_AS');
    installed.push('memoryBytes');
  }
  if (policy.pids !== undefined) {
    setLimit(RLIMIT_NPROC, policy.pids, 'RLIMIT_NPROC');
    installed.push('pids');
  }
  return installed;
}
