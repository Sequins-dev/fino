/**
 * internal:security/sandbox/seccomp — build and install a seccomp-BPF filter
 * from a compiled `SeccompPlan`.
 *
 * This is the Linux syscall-filtering stage shared by child-process and
 * dedicated-thread Realm sandboxes. It takes the plan produced by
 * `internal:security/sandbox/plan` (`planSeccomp`) and lowers it into a classic
 * BPF program that the kernel evaluates on every syscall the confined calling
 * thread makes.
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
 * - `errno` (Realm allowlist) — each `allow` rule matches its syscall and
 *   returns `SECCOMP_RET_ALLOW`; anything unmatched returns `EPERM` so an
 *   in-process Realm cannot take down sibling threads.
 * - `none` — emits a bare allow-everything program (used only as an inert
 *   placeholder; `installSeccomp` never installs it).
 *
 * Installation is a one-way ratchet enforced by the kernel: it first sets
 * `PR_SET_NO_NEW_PRIVS` (required before an unprivileged process may load a
 * filter) and then `PR_SET_SECCOMP` in filter mode. Once installed the filter
 * cannot be removed or loosened for the life of the calling thread, and
 * descendants inherit it, so call it late in child bootstrap after all needed
 * file descriptors and libraries are open.
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
import { libc, errno, PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP } from './ffi.ts';
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
/**
 * Prebuilt seccomp BPF buffers ready for installation without further program
 * allocation.
 *
 * The launcher prepares this before applying `RLIMIT_AS`, then passes it to
 * {@link installPreparedSeccomp}. A `null` preparation means the plan was an
 * inert default-allow filter and requires no kernel installation.
 *
 * @internal
 */
export interface PreparedSeccomp {
  /** Backing `struct sock_filter[]`; retained until the kernel copies it. */
  filterBuf: ArrayBuffer;
  /** Backing `struct sock_fprog` pointing at `filterBuf`. */
  prog: ArrayBuffer;
  /** Address of `prog`, captured before an address-space rlimit is installed. */
  progAddr: bigint;
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
  } else if (plan.defaultAction === 'kill' || plan.defaultAction === 'errno') {
    for (const rule of plan.rules) {
      if (rule.action !== 'allow') continue;
      const nr = syscallNumber(rule.syscall);
      if (nr === undefined) throw new Error(`unsupported syscall in seccomp plan: ${rule.syscall}`);
      filters.push({ code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: nr });
      filters.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW });
    }
    filters.push({
      code: BPF_RET_K,
      jt: 0,
      jf: 0,
      k: plan.defaultAction === 'kill' ? SECCOMP_RET_KILL_PROCESS : SECCOMP_RET_ERRNO_EPERM,
    });
  } else {
    filters.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW });
  }
  return filters;
}
/**
 * Compile `plan` into allocation-complete BPF buffers.
 *
 * Returns `null` for a default-allow plan with no effective rules. Compilation
 * validates syscall names and throws before installing any irreversible policy.
 * Keep the returned buffers reachable until {@link installPreparedSeccomp}
 * finishes.
 *
 * @internal
 */
export function prepareSeccomp(plan: SeccompPlan): PreparedSeccomp | null {
  const filters = build(plan);
  // A lone load + default-allow return enforces nothing; don't install it.
  if (filters.length <= 2 && plan.defaultAction !== 'kill' && plan.defaultAction !== 'errno')
    return null;
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
  return { filterBuf, prog, progAddr: Pointer.addr(prog) as bigint };
}
/**
 * Install a program returned by {@link prepareSeccomp}.
 *
 * `null` is a no-op returning `false`. A prepared program requires only the two
 * `prctl` calls and no BPF construction, so the launcher can safely invoke it
 * after applying an address-space rlimit. Installation is irreversible and
 * throws with the current errno if either syscall fails.
 *
 * @internal
 */
export function installPreparedSeccomp(prepared: PreparedSeccomp | null): boolean {
  if (prepared === null) return false;
  if (libc.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) {
    throw new Error(`prctl(PR_SET_NO_NEW_PRIVS) failed: errno ${errno()}`);
  }
  if (libc.symbols.prctl(PR_SET_SECCOMP, 2n, prepared.progAddr, 0n, 0n) !== 0) {
    throw new Error(`prctl(PR_SET_SECCOMP) failed: errno ${errno()}`);
  }
  // Keep buffers reachable until the syscall has copied the program.
  void prepared.filterBuf;
  void prepared.prog;
  return true;
}
/**
 * Compile and install `plan` as the process's irreversible seccomp filter.
 *
 * Returns `false` for an inert default-allow plan. Unknown syscall names and
 * failed `prctl` calls throw. Launchers that need an allocation-free gap between
 * compilation and installation should use {@link prepareSeccomp} followed by
 * {@link installPreparedSeccomp}.
 *
 * ```ts no_run
 * import { installSeccomp } from 'internal:security/sandbox/seccomp';
 * import { planSeccomp } from 'internal:security/sandbox/plan';
 *
 * installSeccomp(planSeccomp({
 *   syscalls: { mode: 'allowlist', names: ['read', 'write', 'exit_group'] },
 * }));
 * ```
 *
 * @internal
 */
export function installSeccomp(plan: SeccompPlan): boolean {
  return installPreparedSeccomp(prepareSeccomp(plan));
}
