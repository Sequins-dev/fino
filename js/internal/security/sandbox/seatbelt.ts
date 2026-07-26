/**
 * internal:security/sandbox/seatbelt — generate a macOS Seatbelt profile from a
 * sandbox policy for `sandbox-exec -f`.
 *
 * The profile is deny-default. `(import "system.sb")` supplies the baseline the
 * dynamic loader needs (dyld shared cache, system frameworks) so a sandboxed
 * binary can start; everything else is denied unless the policy allows it:
 * readonly/writable path subtrees, the exec-scoped binaries, and coarse
 * directional network. Paths are canonicalized with realpath because Seatbelt
 * matches rules against the resolved path (e.g. `/tmp` → `/private/tmp`).
 *
 * This is the macOS half of the sandbox launcher, mirroring the Linux
 * seccomp/Landlock/rlimit path. The launcher checks `seatbeltAvailable()` to
 * decide whether it can enforce a policy, then writes the string from
 * `generateSeatbeltProfile` to a temporary file and passes it to
 * `sandbox-exec -f`. The two functions are kept side-effect-free and file-based
 * so the same profile can be logged, diffed, or asserted on in tests.
 *
 * ```ts no_run
 *   import {
 *     seatbeltAvailable,
 *     generateSeatbeltProfile,
 *   } from 'internal:security/sandbox/seatbelt';
 *
 *   if (seatbeltAvailable()) {
 *     const profile = generateSeatbeltProfile(
 *       { readonly: ['/usr/lib'], writable: ['/tmp/work'] },
 *       { outbound: [{ action: 'allow' }] },
 *       ['/bin/sh'],
 *     );
 *     // profile is the text for `sandbox-exec -f <file> /bin/sh ...`
 *   }
 * ```
 *
 * Seatbelt profile language (SBPL) is undocumented by Apple; the sample profiles
 * under `/System/Library/Sandbox/Profiles` are the practical reference.
 *
 * @internal
 */
import { os } from 'internal:process';
import { libc, cstr, realpathSync, O_RDONLY } from './ffi.ts';
import type { FilesystemPolicy, NetworkPolicy } from './plan.ts';
let _seatbeltAvailable: boolean | undefined;
/**
 * True when macOS Seatbelt can be applied — i.e. `/usr/bin/sandbox-exec` is
 * present. Seatbelt is a core macOS facility, so the presence of the tool is a
 * sufficient availability signal; an actually-invalid profile still fails closed
 * at spawn time. Cached; always false off macOS.
 */
export function seatbeltAvailable(): boolean {
  if (os !== 'darwin') return false;
  if (_seatbeltAvailable !== undefined) return _seatbeltAvailable;
  const fd = Number(libc.symbols.open(cstr('/usr/bin/sandbox-exec'), O_RDONLY, 0));
  _seatbeltAvailable = fd >= 0;
  if (fd >= 0) libc.symbols.close(fd);
  return _seatbeltAvailable;
}
function quotePath(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/**
 * Build a deny-default Seatbelt profile string for the given policy, ready to
 * write to a file and pass to `sandbox-exec -f`.
 *
 * The `filesystem` argument governs path confinement. Each `readonly` entry
 * becomes an allowed `file-read*` subtree and each `writable` entry an allowed
 * `file-read* file-write*` subtree; entries are canonicalized with realpath
 * because Seatbelt matches against the resolved path. When `filesystem` is
 * absent, or lists neither readonly nor writable paths, all reads are allowed —
 * parity with an unconfined strict spawn — and only writes, exec, and network
 * remain governed.
 *
 * The `network` argument is coarse and directional: outbound network is allowed
 * only if some outbound rule has `action: 'allow'`, and likewise for inbound.
 * Per-destination, per-port, and per-protocol rules are not expressible in this
 * profile and are ignored here.
 *
 * The `execPaths` argument scopes `process-exec`. When it is an array, only
 * those exact binaries (typically the initial command plus the allowlist) may be
 * exec'd, deduplicated and canonicalized with realpath. When it is `null`, any
 * binary may be exec'd (`process-exec*`). `process-fork` is always allowed —
 * fork limiting is a Linux-only seccomp feature with no Seatbelt equivalent.
 *
 * The returned string always begins with `(version 1)`, `(import "system.sb")`,
 * and `(deny default)`, and ends with a trailing newline.
 *
 * Throws if any path in `filesystem` or `execPaths` cannot be resolved by
 * realpath (for example, a path that does not exist).
 *
 * ```ts no_run
 *   import { generateSeatbeltProfile } from 'internal:security/sandbox/seatbelt';
 *
 *   // Confine to a work dir, deny all network, allow only /bin/sh to exec.
 *   const profile = generateSeatbeltProfile(
 *     { readonly: ['/usr/lib', '/System'], writable: ['/tmp/job-42'] },
 *     { outbound: [{ action: 'deny' }] },
 *     ['/bin/sh'],
 *   );
 * ```
 */
export function generateSeatbeltProfile(
  filesystem: FilesystemPolicy | undefined,
  network: NetworkPolicy | undefined,
  execPaths: string[] | null,
): string {
  const lines = ['(version 1)', '(import "system.sb")', '(deny default)'];
  // Process creation: fork is always permitted (fork limiting is a Linux-only
  // seccomp feature); exec is scoped to the allowlist when one is requested.
  lines.push('(allow process-fork)');
  if (execPaths === null) {
    lines.push('(allow process-exec*)');
  } else {
    const resolved = [...new Set(execPaths.map(realpathSync))];
    lines.push(
      `(allow process-exec ${resolved.map((p) => `(literal ${quotePath(p)})`).join(' ')})`,
    );
  }
  const readonly = filesystem?.readonly ?? [];
  const writable = filesystem?.writable ?? [];
  if (readonly.length === 0 && writable.length === 0) {
    lines.push('(allow file-read*)');
  } else {
    for (const path of readonly) {
      lines.push(`(allow file-read* (subpath ${quotePath(realpathSync(path))}))`);
    }
    for (const path of writable) {
      lines.push(`(allow file-read* file-write* (subpath ${quotePath(realpathSync(path))}))`);
    }
  }
  const outbound = network?.outbound ?? [];
  const inbound = network?.inbound ?? [];
  if (outbound.some((rule) => rule.action === 'allow')) lines.push('(allow network-outbound)');
  if (inbound.some((rule) => rule.action === 'allow')) lines.push('(allow network-inbound)');
  return lines.join('\n') + '\n';
}
