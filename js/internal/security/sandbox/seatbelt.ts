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
* Build a Seatbelt profile string for the policy.
*
* @param filesystem readonly/writable confinement; when absent, all reads are
*   allowed (parity with an unconfined strict spawn) and only writes/exec/network
*   are governed.
* @param network coarse directional network policy.
* @param execPaths when non-null, the exact set of binaries that may be exec'd
*   (initial binary + allowlist); when null, any binary may be exec'd.
*/
export function generateSeatbeltProfile(
  filesystem: FilesystemPolicy | undefined,
  network: NetworkPolicy | undefined,
  execPaths: string[] | null
): string {
  const lines = ['(version 1)', '(import "system.sb")', '(deny default)'];
  // Process creation: fork is always permitted (fork limiting is a Linux-only
  // seccomp feature); exec is scoped to the allowlist when one is requested.
  lines.push('(allow process-fork)');
  if (execPaths === null) {
    lines.push('(allow process-exec*)');
  } else {
    const resolved = [...new Set(execPaths.map(realpathSync))];
    lines.push(`(allow process-exec ${resolved.map((p) => `(literal ${quotePath(p)})`).join(' ')})`);
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
