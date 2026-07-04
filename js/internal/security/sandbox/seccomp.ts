/**
* internal:security/sandbox/seccomp — build and install a seccomp-BPF filter
* from a compiled {@link SeccompPlan}.
*
* The BPF program loads the syscall number from `seccomp_data` offset 0 and
* branches per rule, exactly like the previous native `seccomp_filters`:
* denylist mode returns EPERM for listed syscalls over a default-allow tail,
* allowlist mode returns ALLOW for listed syscalls over a default
* kill-the-process tail.
*
* @internal
*/
import { Pointer } from 'fino:ffi';
import { libc, errno, PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, SECCOMP_MODE_FILTER } from './ffi.ts';
import type { SeccompPlan } from './plan.ts';
import { syscallNumber } from './plan.ts';
const PR_GET_SECCOMP = 21;
/**
* True when the kernel supports seccomp filtering. `prctl(PR_GET_SECCOMP)`
* returns the current mode (0 when unconfined) if `CONFIG_SECCOMP` is enabled,
* or fails with `EINVAL` if it is compiled out.
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
* Compile and install the seccomp filter for `plan`.
*
* A plan with no effective rules and a default-allow tail is a no-op and is
* skipped so an unrestricted policy does not pay for an empty filter. Throws if
* `PR_SET_NO_NEW_PRIVS` or `PR_SET_SECCOMP` fails.
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
