/**
* internal:security/sandbox/landlock — build and apply a Landlock ruleset that
* confines the launcher (and thus the exec'd target) to a set of readonly and
* writable path subtrees, and scopes which binaries may be executed.
*
* Landlock is a Linux LSM (kernel 5.13+) that lets an unprivileged process add
* filesystem access rules to itself. The rules are inherited across `execve`, so
* the launcher installs a ruleset and then execs the sandboxed target into it.
* This module is the Landlock arm of the child-process sandbox: it is invoked
* inside the launcher, just before the final `execve`, once seccomp and rlimits
* are already staged.
*
* Filesystem confinement: readonly paths get read access, writable paths get
* read+write, everything else is unreachable. Only access types the policy
* actually restricts are placed in `handled_access_fs` — unmentioned access
* categories stay unrestricted, so a policy that lists no paths and no exec rule
* installs nothing at all. Execute scoping: when the policy expresses an exec
* rule (`process.allowExec === false` or `process.allowedBinaries`),
* `LANDLOCK_ACCESS_FS_EXECUTE` is *handled* and granted ONLY on the initial
* binary and the allowlisted binaries — so a sandboxed process can no longer
* `exec` an arbitrary binary that merely happens to be readable. Shared
* libraries load via `mmap` (read access), not Landlock-execute, so dynamically
* linked targets still run; the target's own ELF interpreter is granted execute
* explicitly because the kernel checks it as part of `execve`.
*
* Newer access bits are gated on the kernel's ABI version: write rights exist
* since ABI v1, `FS_REFER` arrived in v2 and `FS_TRUNCATE` in v3. Passing a bit
* the running kernel does not recognise makes `create_ruleset` fail with EINVAL,
* so {@link landlockAbi} is probed first and {@link writeRightsFor} masks the
* rights down to what is supported.
*
* Probe availability with {@link landlockAvailable} before relying on this
* mechanism, and apply a policy with {@link installLandlock}. Callers outside the
* launcher (for example capability reporting) generally only need the probe.
*
* ```ts no_run
* import { landlockAvailable, installLandlock } from 'internal:security/sandbox/landlock';
*
* if (landlockAvailable()) {
*   const result = installLandlock(
*     { readonly: ['/usr', '/lib'], writable: ['/tmp/work'] },
*     { allowExec: false },
*     '/tmp/work/target',
*   );
*   // result.fsConfined === true, result.execScoped === true
* }
* ```
*
* Landlock reference: https://docs.kernel.org/userspace-api/landlock.html
*
* @internal
*/
import { Pointer } from 'fino:ffi';
import {
  libc, errno, cstr, readFileBytesSync, O_PATH, O_CLOEXEC, PR_SET_NO_NEW_PRIVS,
  SYS_LANDLOCK_CREATE_RULESET, SYS_LANDLOCK_ADD_RULE, SYS_LANDLOCK_RESTRICT_SELF
} from './ffi.ts';
import type { FilesystemPolicy, ProcessPolicy } from './plan.ts';
const LANDLOCK_RULE_PATH_BENEATH = 1n;
const FS_EXECUTE = 1n << 0n;
const FS_WRITE_FILE = 1n << 1n;
const FS_READ_FILE = 1n << 2n;
const FS_READ_DIR = 1n << 3n;
const FS_REMOVE_DIR = 1n << 4n;
const FS_REMOVE_FILE = 1n << 5n;
const FS_MAKE_CHAR = 1n << 6n;
const FS_MAKE_DIR = 1n << 7n;
const FS_MAKE_REG = 1n << 8n;
const FS_MAKE_SOCK = 1n << 9n;
const FS_MAKE_FIFO = 1n << 10n;
const FS_MAKE_BLOCK = 1n << 11n;
const FS_MAKE_SYM = 1n << 12n;
const FS_REFER = 1n << 13n;
const FS_TRUNCATE = 1n << 14n;
const READ_RIGHTS = FS_READ_FILE | FS_READ_DIR;
// Write rights present since Landlock ABI v1; FS_REFER (v2) and FS_TRUNCATE (v3)
// are added at runtime only when the kernel's ABI supports them — passing a
// newer bit to an older kernel makes create_ruleset return EINVAL.
const WRITE_RIGHTS_V1 = FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_CHAR
  | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM;
const LANDLOCK_CREATE_RULESET_VERSION = 1n << 0n;
/**
* Returns the kernel's Landlock ABI version, or 0 when Landlock is unavailable
* (compiled out or not in the active LSM list).
*
* The version is obtained through the `create_ruleset` syscall in its
* version-query mode (the `LANDLOCK_CREATE_RULESET_VERSION` flag with a null
* attribute): this only reports the number and does not create a ruleset, so the
* call is cheap and side-effect free. A positive result is the highest ABI the
* running kernel implements — higher numbers add access bits (v2 adds
* `FS_REFER`, v3 adds `FS_TRUNCATE`) that older kernels reject. A non-positive
* syscall return is normalised to 0.
*
* ```ts no_run
* import { landlockAbi } from 'internal:security/sandbox/landlock';
*
* const abi = landlockAbi();
* if (abi === 0) throw new Error('Landlock LSM not enabled on this kernel');
* if (abi >= 3) {
*   // safe to rely on FS_TRUNCATE being handled
* }
* ```
*/
export function landlockAbi(): number {
  const rc = libc.symbols.syscall(SYS_LANDLOCK_CREATE_RULESET, 0n, 0n, LANDLOCK_CREATE_RULESET_VERSION, 0n);
  return rc > 0n ? Number(rc) : 0;
}
/**
* Returns true when the running kernel has the Landlock LSM enabled and usable.
*
* This is the guard callers should check before requesting filesystem
* confinement or exec scoping: it is a thin `landlockAbi() > 0` convenience,
* since any positive ABI version means a ruleset can be built. The
* capability-reporting path and the launcher both use it to decide whether the
* Landlock mechanism can back a policy or whether the sandbox must degrade (or,
* in strict mode, refuse to spawn).
*
* ```ts no_run
* import { landlockAvailable } from 'internal:security/sandbox/landlock';
*
* if (!landlockAvailable()) {
*   // filesystem confinement cannot be enforced on this host
* }
* ```
*/
export function landlockAvailable(): boolean {
  return landlockAbi() > 0;
}
/** Write rights the given ABI actually supports. */
function writeRightsFor(abi: number): bigint {
  let rights = WRITE_RIGHTS_V1;
  if (abi >= 2) rights |= FS_REFER;
  if (abi >= 3) rights |= FS_TRUNCATE;
  return rights;
}
/**
* Describes what an {@link installLandlock} call actually confined.
*
* The launcher uses this to build the sandbox report honestly: each flag maps to
* a category the caller can surface (filesystem confinement, process/exec
* scoping) so the report reflects what was truly enforced rather than what was
* merely requested. When a policy asks for neither confinement nor scoping, the
* result is all-false and no ruleset is installed.
*
* ```ts no_run
* import { installLandlock } from 'internal:security/sandbox/landlock';
*
* const result = installLandlock(
*   { readonly: ['/usr'] },
*   { allowedBinaries: ['/bin/sh'] },
*   '/bin/task',
* );
* if (result.installed) {
*   if (result.fsConfined) console.log('filesystem restricted');
*   if (result.execScoped) console.log('execute restricted');
* }
* ```
*/
export interface LandlockResult {
  /** True when a ruleset was created and applied to the process via `restrict_self`. */
  installed: boolean;
  /**
   * True when at least one readonly or writable path was supplied, so read (and
   * for writable subtrees, write) access is now confined to those subtrees.
   */
  fsConfined: boolean;
  /**
   * True when execute scoping was engaged, meaning `execve` is restricted to the
   * initial binary, the absolute-path entries of `allowedBinaries`, and their ELF
   * interpreters.
   */
  execScoped: boolean;
}
const NOT_INSTALLED: LandlockResult = { installed: false, fsConfined: false, execScoped: false };
/**
* The ELF interpreter (dynamic loader) a binary needs, or `null` for a static
* binary. Landlock checks execute access on the interpreter too, so an
* exec-scoped dynamic binary is only runnable if its loader is also granted
* execute. Parses the PT_INTERP program header from the ELF file.
*/
function elfInterpreter(path: string): string | null {
  const head = readFileBytesSync(path, 4096);
  if (head === null || head.length < 64) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.length);
  if (dv.getUint32(0, false) !== 0x7f454c46) return null; // \x7fELF
  const is64 = head[4] === 2;
  const le = head[5] === 1;
  if (!is64) return null; // only 64-bit is supported here
  const phoff = Number(dv.getBigUint64(0x20, le));
  const phentsize = dv.getUint16(0x36, le);
  const phnum = dv.getUint16(0x38, le);
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + 56 > head.length) break;
    if (dv.getUint32(off, le) === 3) { // PT_INTERP
      const pOffset = Number(dv.getBigUint64(off + 8, le));
      const pFilesz = Number(dv.getBigUint64(off + 32, le));
      if (pOffset + pFilesz > head.length) return null;
      let end = pOffset + pFilesz;
      while (end > pOffset && head[end - 1] === 0) end--;
      return new TextDecoder().decode(head.subarray(pOffset, end));
    }
  }
  return null;
}
function addPathBeneathRule(rulesetFd: number, path: string, access: bigint): void {
  const fd = libc.symbols.open(cstr(path), O_PATH | O_CLOEXEC, 0);
  if (fd < 0) {
    // A grant path that does not exist confers no access, so skipping it only
    // makes the sandbox more restrictive — fail safe rather than fail closed.
    if (errno() === 2 /* ENOENT */) return;
    throw new Error(`landlock: open('${path}') failed: errno ${errno()}`);
  }
  try {
    // struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; }
    // The kernel reads 12 packed bytes; a 16-byte buffer with the fields at
    // offsets 0 and 8 supplies them (trailing padding is never read).
    const attr = new ArrayBuffer(16);
    const view = new DataView(attr);
    view.setBigUint64(0, access, true);
    view.setInt32(8, fd, true);
    const rc = libc.symbols.syscall(
      SYS_LANDLOCK_ADD_RULE,
      BigInt(rulesetFd),
      LANDLOCK_RULE_PATH_BENEATH,
      Pointer.addr(attr) as bigint,
      0n
    );
    if (rc < 0n) throw new Error(`landlock: add_rule('${path}') failed: errno ${errno()}`);
  } finally {
    libc.symbols.close(fd);
  }
}
/**
* Applies the filesystem and execute policy as a Landlock ruleset on the calling
* process, returning a {@link LandlockResult} describing what was confined.
*
* The `filesystem` argument supplies readonly and writable path subtrees; when
* omitted or empty, no filesystem access is restricted. The `process` argument
* drives execute scoping, which engages when `allowExec === false` or
* `allowedBinaries` is non-empty. The `initialBinary` is the target's own path
* and is always granted execute so the launcher's `execve` of it — performed
* after `restrict_self` — still succeeds.
*
* Only the access categories the policy restricts are placed in
* `handled_access_fs`, so everything else stays unrestricted. Readonly paths
* receive read rights, writable paths receive read plus the write rights the
* kernel's ABI supports, and — when exec scoping is on — execute is granted only
* on the initial binary, the absolute-path entries of `allowedBinaries`, and the
* ELF interpreters those binaries need. Basename-only allowlist entries cannot be
* pinned to a path and are therefore left non-executable, a deliberate
* fail-closed choice. Grant paths that do not exist (ENOENT) are silently
* skipped, which only tightens the sandbox.
*
* When the policy asks for neither filesystem confinement nor exec scoping,
* nothing is installed and the returned result is all-false. Otherwise the
* function performs real syscalls and throws if any of them fail: it throws when
* the Landlock LSM is unavailable, when `create_ruleset` or `add_rule` fails, or
* when `prctl(PR_SET_NO_NEW_PRIVS)` or `restrict_self` fails. Because
* `restrict_self` is irreversible, a successful call permanently narrows the
* current process (and everything it later execs) for its lifetime.
*
* ```ts no_run
* import { installLandlock } from 'internal:security/sandbox/landlock';
*
* // Confine a task to read /usr and /lib, write only under /tmp/job, and forbid
* // exec of anything but the task binary itself.
* const result = installLandlock(
*   { readonly: ['/usr', '/lib', '/lib64'], writable: ['/tmp/job'] },
*   { allowExec: false },
*   '/tmp/job/target',
* );
* // From here on, opening a file outside those subtrees fails with EACCES.
* console.log(result); // { installed: true, fsConfined: true, execScoped: true }
* ```
*/
export function installLandlock(
  filesystem: FilesystemPolicy | undefined,
  process: ProcessPolicy | undefined,
  initialBinary: string
): LandlockResult {
  const readonly = filesystem?.readonly ?? [];
  const writable = filesystem?.writable ?? [];
  const fsConfined = readonly.length > 0 || writable.length > 0;
  const allowedBinaries = process?.allowedBinaries ?? [];
  const execScoped = process?.allowExec === false || allowedBinaries.length > 0;
  if (!fsConfined && !execScoped) return NOT_INSTALLED;
  const abi = landlockAbi();
  if (abi === 0) throw new Error('landlock: LSM not available');
  const writeRights = writeRightsFor(abi);
  // Only the access types we intend to restrict go in handled_access_fs;
  // everything else stays unrestricted. Each rule's granted access must be a
  // subset of handled, so exec paths only carry the read bit when reads are
  // actually confined.
  let handled = 0n;
  if (fsConfined) handled |= READ_RIGHTS | writeRights;
  if (execScoped) handled |= FS_EXECUTE;
  const execGrant = FS_EXECUTE | (fsConfined ? FS_READ_FILE : 0n);
  // struct landlock_ruleset_attr { __u64 handled_access_fs; } (ABI v1)
  const rulesetAttr = new ArrayBuffer(8);
  new DataView(rulesetAttr).setBigUint64(0, handled, true);
  const rulesetFd = Number(libc.symbols.syscall(
    SYS_LANDLOCK_CREATE_RULESET,
    Pointer.addr(rulesetAttr) as bigint,
    8n,
    0n,
    0n
  ));
  if (rulesetFd < 0) throw new Error(`landlock: create_ruleset failed: errno ${errno()}`);
  try {
    for (const path of readonly) addPathBeneathRule(rulesetFd, path, READ_RIGHTS);
    for (const path of writable) addPathBeneathRule(rulesetFd, path, READ_RIGHTS | writeRights);
    if (execScoped) {
      // Execute is granted only on the initial binary and absolute-path
      // allowlist entries. Basename-only allowlist entries cannot be scoped by
      // path and are therefore not executable — a fail-closed choice.
      const execPaths = new Set<string>([initialBinary]);
      for (const entry of allowedBinaries) if (entry.startsWith('/')) execPaths.add(entry);
      // Landlock also checks execute on each dynamic binary's ELF interpreter
      // (its loader), so grant execute there too or the binary won't run.
      for (const path of [...execPaths]) {
        const interp = elfInterpreter(path);
        if (interp !== null && interp.startsWith('/')) execPaths.add(interp);
      }
      for (const path of execPaths) addPathBeneathRule(rulesetFd, path, execGrant);
    }
    if (libc.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) {
      throw new Error(`landlock: prctl(PR_SET_NO_NEW_PRIVS) failed: errno ${errno()}`);
    }
    if (libc.symbols.syscall(SYS_LANDLOCK_RESTRICT_SELF, BigInt(rulesetFd), 0n, 0n, 0n) < 0n) {
      throw new Error(`landlock: restrict_self failed: errno ${errno()}`);
    }
  } finally {
    libc.symbols.close(rulesetFd);
  }
  return { installed: true, fsConfined, execScoped };
}
