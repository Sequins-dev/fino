/**
* internal:security/sandbox/seccomp — build and install a seccomp-BPF filter
* from a compiled `SeccompPlan`.
*
* This is the Linux syscall-filtering stage of the child-process sandbox. It
* takes the plan produced by `internal:security/sandbox/plan` (`planSeccomp`)
* and lowers it into a classic BPF program that the kernel evaluates on every
* syscall the confined process makes.
*
* The BPF program loads the syscall number from `seccomp_data` offset 0 and
* branches per rule. The plan's default action decides the shape of the
* program:
*
* - `allow` (denylist) — each `errno` rule matches its syscall and returns
*   `SECCOMP_RET_ERRNO` with `EPERM`; anything unmatched falls through to a
*   trailing `SECCOMP_RET_ALLOW`. This is used to poke individual holes (deny
*   `fork`, deny raw networking) in an otherwise permissive policy.
* - `kill` (allowlist) — each `allow` rule matches its syscall and returns
*   `SECCOMP_RET_ALLOW`; anything unmatched falls through to a trailing
*   `SECCOMP_RET_KILL_PROCESS`, so any syscall not explicitly permitted takes
*   the whole process down.
* - `none` — emits a bare allow-everything program (used only as an inert
*   placeholder; `installSeccomp` never installs it).
*
* Installation is a one-way ratchet enforced by the kernel: it first sets
* `PR_SET_NO_NEW_PRIVS` (required before an unprivileged process may load a
* filter) and then `PR_SET_SECCOMP` in filter mode. Once installed the filter
* cannot be removed or loosened for the life of the process, so call it late in
* child bootstrap, after all needed file descriptors and libraries are open.
*
* This module is Linux-only; on other platforms the `prctl` calls simply fail
* and `seccompAvailable` returns `false`. The macOS counterpart is
* `internal:security/sandbox/seatbelt`.
*
* ```ts no_run
*   import { seccompAvailable, installSeccomp } from 'internal:security/sandbox/seccomp';
*   import { planSeccomp } from 'internal:security/sandbox/plan';
*
*   if (seccompAvailable()) {
*     const plan = planSeccomp({ process: { allowFork: false } });
*     const installed = installSeccomp(plan);
*     // `installed` is false when the plan enforces nothing (e.g. empty denylist).
*   }
* ```
*
* seccomp uapi: https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html
*
* @internal
*/
import { Pointer } from 'fino:ffi';
import { libc, errno, PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, SECCOMP_MODE_FILTER } from './ffi.ts';
import type { SeccompPlan } from './plan.ts';
import { syscallNumber } from './plan.ts';
const PR_GET_SECCOMP = 21;
/**
* Reports whether the running kernel supports seccomp filtering.
*
* Probes with `prctl(PR_GET_SECCOMP)`, which returns the current seccomp mode
* (0 when the process is unconfined) if `CONFIG_SECCOMP` is compiled into the
* kernel, and fails with `EINVAL` when it is not. A non-negative return means
* the facility is present. On non-Linux platforms the `prctl` shim fails and
* this returns `false`.
*
* Use this to gate `installSeccomp` so a policy degrades gracefully rather than
* throwing on a kernel that cannot enforce it.
*
* ```ts no_run
*   import { seccompAvailable } from 'internal:security/sandbox/seccomp';
*
*   if (!seccompAvailable()) {
*     // Fall back to other confinement layers, or refuse to run untrusted code.
*   }
* ```
*/
export function seccompAvailable(): boolean {
  return libc.symbols.prctl(PR_GET_SECCOMP, 0n, 0n, 0n, 0n) >= 0;
}
// BPF instruction classes / operations (Linux uapi/linux/bpf_common.h).
const BPF_LD_W_ABS = 0x00 | 0x00 | 0x20;
const BPF_JMP_JEQ_K = 0x05 | 0x10 | 0x00;
const BPF_RET_K = 0x06 | 0x00;
// seccomp return actions (Linux uapi/linux/seccomp.h).
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050000 | 1;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
interface Instruction {
  code: number;
  jt: number;
  jf: number;
  k: number;
}
function build(plan: SeccompPlan): Instruction[] {
  const filters: Instruction[] = [{ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 0 }];
  if (plan.defaultAction === 'allow') {
    for (const rule of plan.rules) {
      if (rule.action !== 'errno') continue;
      const nr = syscallNumber(rule.syscall);
      if (nr === undefined) throw new Error(`unsupported syscall in seccomp plan: ${rule.syscall}`);
      filters.push({ code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: nr });
      filters.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO_EPERM });
    }
    filters.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW });
  } else if (plan.defaultAction === 'kill') {
    for (const rule of plan.rules) {
      if (rule.action !== 'allow') continue;
      const nr = syscallNumber(rule.syscall);
      if (nr === undefined) throw new Error(`unsupported syscall in seccomp plan: ${rule.syscall}`);
      filters.push({ code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: nr });
      filters.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW });
    }
    filters.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS });
  } else {
    filters.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW });
  }
  return filters;
}
/**
* Compiles `plan` into a BPF program and installs it as the process seccomp
* filter, returning whether a filter was actually loaded.
*
* The plan is lowered per its `defaultAction` (see the module overview) and
* written into a `struct sock_filter[]` / `struct sock_fprog` pair, then handed
* to the kernel via `PR_SET_NO_NEW_PRIVS` followed by `PR_SET_SECCOMP` in
* filter mode. Both prctls are load-bearing: the no-new-privs bit is what lets
* an unprivileged process install a filter at all.
*
* Returns `false` without touching the kernel when the plan enforces nothing —
* a default-allow tail with no effective rules compiles to just a load plus a
* blanket allow, so installing it would only add per-syscall overhead for zero
* protection. A default-`kill` (allowlist) plan is always installed, even with
* no allow rules, because that denies everything and is a meaningful policy.
*
* Once installed the filter is irrevocable for the life of the process, so run
* this as the final confinement step in child bootstrap. Throws if a rule names
* a syscall unknown on the current architecture, or if either prctl fails (for
* example `EACCES` when no-new-privs cannot be set); the error message carries
* the failing prctl and its `errno`.
*
* ```ts no_run
*   import { installSeccomp } from 'internal:security/sandbox/seccomp';
*   import { planSeccomp } from 'internal:security/sandbox/plan';
*
*   // Allowlist: only the named syscalls survive; anything else kills the process.
*   const plan = planSeccomp({
*     syscalls: { mode: 'allowlist', names: ['read', 'write', 'exit_group'] },
*   });
*   installSeccomp(plan); // true — an allowlist is always enforced
* ```
*/
export function installSeccomp(plan: SeccompPlan): boolean {
  const filters = build(plan);
  // A lone load + default-allow return enforces nothing; don't install it.
  if (filters.length <= 2 && plan.defaultAction !== 'kill') return false;
  const filterBuf = new ArrayBuffer(filters.length * 8);
  const view = new DataView(filterBuf);
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    view.setUint16(i * 8, f.code & 0xffff, true);
    view.setUint8(i * 8 + 2, f.jt & 0xff);
    view.setUint8(i * 8 + 3, f.jf & 0xff);
    view.setUint32(i * 8 + 4, f.k >>> 0, true);
  }
  // struct sock_fprog { unsigned short len; struct sock_filter *filter; }
  // On 64-bit the pointer is 8-aligned, so it lands at offset 8.
  const prog = new ArrayBuffer(16);
  const progView = new DataView(prog);
  progView.setUint16(0, filters.length, true);
  progView.setBigUint64(8, Pointer.addr(filterBuf) as bigint, true);
  if (libc.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) {
    throw new Error(`prctl(PR_SET_NO_NEW_PRIVS) failed: errno ${errno()}`);
  }
  if (libc.symbols.prctl(PR_SET_SECCOMP, BigInt(SECCOMP_MODE_FILTER), Pointer.addr(prog) as bigint, 0n, 0n) !== 0) {
    throw new Error(`prctl(PR_SET_SECCOMP) failed: errno ${errno()}`);
  }
  // Keep buffers reachable until the syscall has copied the program.
  void filterBuf;
  void prog;
  return true;
}
