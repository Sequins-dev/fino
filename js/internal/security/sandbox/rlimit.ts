/**
* internal:security/sandbox/rlimit — apply POSIX resource limits.
*
* This module installs `setrlimit(2)` caps inside the sandboxed process, in the
* window after `fork` but before `execve`, so the limits are inherited by the
* payload it launches. It is the primary resource-control mechanism on macOS
* (which has no cgroups) and the honest fallback tier on Linux when a requested
* controller — memory or pids — was not delegated to the sandbox's cgroup. The
* launcher records rlimit-installed limits under the weaker `rlimit` tier so the
* report never overstates the guarantee: an rlimit is per-process and can be
* raised again by a sufficiently privileged payload, whereas a cgroup cap is
* hierarchical and cannot be escaped from inside.
*
* Only two resources are covered, because they are the two the sandbox policy
* exposes that map cleanly onto POSIX rlimits: `memoryBytes` becomes `RLIMIT_AS`
* (the address-space ceiling) and `pids` becomes `RLIMIT_NPROC` (the per-uid
* process count). The `cpu` field of a resource policy has no rlimit equivalent
* that matches the intended semantics and is rejected pre-spawn by the launcher
* rather than silently downgraded here. Both the soft and hard limit are set to
* the same value, so the cap is firm and cannot be self-raised by the payload.
*
* Each installed limit is a hard failure: if the underlying `setrlimit` call
* returns non-zero, `installRlimits` throws rather than continuing, so a
* strict-mode sandbox fails closed instead of launching a payload with weaker
* limits than were asked for.
*
* setrlimit specification: https://pubs.opengroup.org/onlinepubs/9699919799/functions/setrlimit.html
*
* ```ts no_run
*   import { installRlimits } from 'internal:security/sandbox/rlimit';
*
*   // Cap the process at 512 MiB of address space and 64 processes.
*   const installed = installRlimits({
*     memoryBytes: 512 * 1024 * 1024,
*     pids: 64,
*   });
*   // installed === ['memoryBytes', 'pids']
* ```
*
* @internal
*/
import { libc, errno, RLIMIT_AS, RLIMIT_NPROC } from './ffi.ts';
import type { ResourcePolicy } from './plan.ts';
/**
* Set both the soft and hard bound of a single `setrlimit` resource to `value`.
*
* Packs a `struct rlimit { rlim_t rlim_cur; rlim_t rlim_max; }` — two
* little-endian `u64` fields — with `value` in both slots so the limit is firm
* and cannot be raised again from inside the process. `label` is only used to
* build the error message. Throws if the `setrlimit` call returns non-zero,
* embedding the current `errno` so the failing resource is identifiable.
*/
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
* Install the rlimit-backed caps described by a resource policy.
*
* Applies `memoryBytes` as `RLIMIT_AS` and `pids` as `RLIMIT_NPROC`, setting the
* soft and hard bounds together so neither can be self-raised by the payload.
* Fields that are `undefined` are skipped, and `cpu` is ignored entirely because
* it has no matching rlimit (the launcher rejects it before spawning). The
* returned array names the policy fields that were actually installed — in
* declaration order, `'memoryBytes'` then `'pids'` — which the launcher folds
* into the sandbox report under the `rlimit` tier.
*
* Throws if any underlying `setrlimit` call fails; the error names the offending
* resource and includes `errno`. Because it fails on the first error rather than
* installing a partial set, a strict sandbox aborts the launch instead of
* running under weaker limits than requested.
*
* ```ts no_run
*   import { installRlimits } from 'internal:security/sandbox/rlimit';
*
*   // Only a memory cap requested: pids is left at the inherited default.
*   const installed = installRlimits({ memoryBytes: 256 * 1024 * 1024 });
*   // installed === ['memoryBytes']
*
*   // An empty policy installs nothing and returns [].
*   installRlimits({}); // []
* ```
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
