/**
* Linux-only strict sandbox enforcement: Landlock execute scoping and cgroup v2
* resource limits + descendant cleanup.
*
* Test discipline: every case either asserts real enforcement when the kernel
* provides the mechanism, or asserts a loud pre-spawn rejection when it does not
* — never a silent skip and never a concealed sandboxing failure. `capabilities`
* reflects what this kernel actually offers (Landlock LSM, seccomp, cgroup
* controllers), so the tests adapt to the host they run on.
*/
import { describe, it } from 'fino:test/test';
import { os, Process, processSandboxCapabilities, kill } from 'fino:process';
function joinChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(merged);
}
async function runToExit(proc: Process): Promise<{ code: number | null; signal: number | null; stdout: string }> {
  proc.stdin.close();
  const chunks: Uint8Array[] = [];
  for await (const c of proc.stdout) chunks.push(c);
  for await (const _ of proc.stderr) {}
  const status = await proc.wait();
  return { ...status, stdout: joinChunks(chunks) };
}
function landlockOn(): boolean {
  return processSandboxCapabilities().backends.some((b) => b.name === 'linuxNative' && b.supported.includes('filesystem'));
}
describe('Landlock execute scoping', () => {
  it('denies exec of a non-initial binary under allowExec: false, or fails closed', async (t) => {
    if (os !== 'linux') return;
    const make = (): Process => new Process('/bin/sh', ['-c', 'exec /bin/ls /'], {
      sandbox: { mode: 'strict', process: { allowExec: false, allowedBinaries: ['/bin/sh'] } }
    });
    if (!landlockOn()) {
      t.throws(make, /Landlock/, 'without Landlock, exec scoping is rejected before spawn');
      return;
    }
    const { code } = await runToExit(make());
    t.notEqual(code, 0, 'exec of /bin/ls is denied by Landlock, so the shell exits non-zero');
  });
  it('permits an allowlisted binary and blocks an unlisted one under Landlock', async (t) => {
    if (os !== 'linux') return;
    if (!landlockOn()) {
      t.throws(() => new Process('/bin/sh', ['-c', 'true'], {
        sandbox: { mode: 'strict', process: { allowedBinaries: ['/bin/sh'] } }
      }), /Landlock/, 'without Landlock, allowedBinaries scoping is rejected before spawn');
      return;
    }
    const allowed = new Process('/bin/sh', ['-c', 'exec /bin/echo permitted'], {
      sandbox: { mode: 'strict', process: { allowedBinaries: ['/bin/sh', '/bin/echo'] } }
    });
    const allowedResult = await runToExit(allowed);
    t.equal(allowedResult.code, 0, 'allowlisted /bin/echo runs');
    t.equal(allowedResult.stdout.trim(), 'permitted', 'allowlisted exec produces output');
    const blocked = new Process('/bin/sh', ['-c', 'exec /bin/echo denied'], {
      sandbox: { mode: 'strict', process: { allowedBinaries: ['/bin/sh'] } }
    });
    const blockedResult = await runToExit(blocked);
    t.notEqual(blockedResult.code, 0, 'exec of a non-allowlisted /bin/echo is denied');
  });
});
describe('cgroup v2 resource limits and cleanup', () => {
  function cpuGroupAvailable(): boolean {
    // cpu strict spawn succeeds only where a delegated cgroup cpu controller
    // exists; otherwise it must be rejected pre-spawn (no allowlist involved).
    try {
      const p = new Process('/bin/echo', ['probe'], { sandbox: { mode: 'strict', resources: { cpu: 0.5 } } });
      p.stdin.close();
      p.kill();
      return true;
    } catch (_) {
      return false;
    }
  }
  it('enforces cpu quota through a delegated cgroup, or rejects it pre-spawn', async (t) => {
    if (os !== 'linux') return;
    if (!cpuGroupAvailable()) {
      t.throws(() => new Process('/bin/echo', ['cpu'], { sandbox: { mode: 'strict', resources: { cpu: 0.5 } } }),
        /delegated cgroup/, 'cpu is loudly rejected when no cgroup cpu controller is delegated');
      return;
    }
    const proc = new Process('/bin/echo', ['cpu'], { sandbox: { mode: 'strict', resources: { cpu: 0.5 } } });
    t.ok(
      proc.sandboxReport.enforced.some((e) => e.category === 'resources' && /cgroup/i.test(e.reason)),
      'resources are reported enforced by cgroup'
    );
    const { code } = await runToExit(proc);
    t.equal(code, 0, 'cpu-limited child runs to completion');
  });
  it('reaps orphaned descendants on teardown (cgroup.kill or process group)', async (t) => {
    if (os !== 'linux') return;
    // The shell backgrounds a long sleep and prints its pid, then exits. The
    // sleep is orphaned; wait()'s descendant cleanup — cgroup.kill where a
    // cgroup exists, otherwise kill(-pgid) — must reap it either way.
    const proc = new Process('/bin/sh', ['-c', 'sleep 60 & echo $!'], { sandbox: { mode: 'strict' } });
    const { stdout } = await runToExit(proc);
    const grandchild = Number(stdout.trim());
    t.ok(Number.isInteger(grandchild) && grandchild > 0, 'captured the orphaned sleep pid');
    t.throws(() => kill(grandchild, 0), /No such process|ESRCH|failed/, 'orphaned descendant was reaped on teardown');
  });
});
