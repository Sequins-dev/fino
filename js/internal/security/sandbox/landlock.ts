/**
* internal:security/sandbox/landlock — build and apply a Landlock ruleset that
* confines the launcher (and thus the exec'd target) to a set of readonly and
* writable path subtrees, and scopes which binaries may be executed.
*
* Filesystem confinement: readonly paths get read access, writable paths get
* read+write, everything else is unreachable. Execute scoping: when the policy
* expresses an exec rule (`process.allowExec === false` or
* `process.allowedBinaries`), `LANDLOCK_ACCESS_FS_EXECUTE` is *handled* and
* granted ONLY on the initial binary and the allowlisted binaries — so a
* sandboxed process can no longer `exec` an arbitrary binary that merely happens
* to be readable. Shared libraries load via `mmap` (read access), not
* Landlock-execute, so dynamically linked targets still run.
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
* The kernel's Landlock ABI version, or 0 when Landlock is unavailable
* (compiled out or not in the active LSM list). Asking `create_ruleset` for its
* version does not create a ruleset.
*/
export function landlockAbi(): number {
  const rc = libc.symbols.syscall(SYS_LANDLOCK_CREATE_RULESET, 0n, 0n, LANDLOCK_CREATE_RULESET_VERSION, 0n);
  return rc > 0n ? Number(rc) : 0;
}
/** True when the running kernel has the Landlock LSM enabled. */
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
/** What a Landlock install actually confined, for the report. */
export interface LandlockResult {
  installed: boolean;
  fsConfined: boolean;
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
* Apply the filesystem and execute policy as a Landlock ruleset.
*
* @param filesystem readonly/writable path confinement (optional).
* @param process exec policy; execute scoping engages when `allowExec === false`
*   or `allowedBinaries` is non-empty.
* @param initialBinary the target's own path — always granted execute so the
*   launcher's post-`restrict_self` `execve` of it succeeds.
* @returns what was confined, or {@link NOT_INSTALLED} when the policy asks for
*   neither filesystem confinement nor exec scoping.
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
